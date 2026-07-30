import type { SandboxProvider } from '~/lib/sandbox';
import { path as nodePath } from '~/utils/path';
import { atom, map, type MapStore } from 'nanostores';
import type { ActionAlert, BoltAction, DeployAlert, FileHistory, SupabaseAction, SupabaseAlert } from '~/types/actions';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { ActionCallbackData } from './message-parser';
import type { BoltShell } from '~/utils/shell';
import { isAllowedShellCommand } from './shell-allowlist';
import { buildSpawnArgs } from './build-command';
import { EditBlockError, applyEditBlocks, parseEditBlocks } from './edit-blocks';
import { isBinaryPath } from '~/lib/binary/binary-files';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';

const logger = createScopedLogger('ActionRunner');

/**
 * The path an action names, in the form the sandbox FS accepts.
 *
 * 🔴 **NOT `nodePath.relative(workdir, action.filePath)`, which is what this was.** A model emits
 * `filePath="SPEC.md"` — project-relative, always, that is the artifact format — and `path.relative`
 * RESOLVES both arguments against the process cwd first. In the browser that cwd is `/`, so
 * `relative('/project/workspace', 'SPEC.md')` is **`../../SPEC.md`**: a traversal out of the project,
 * which `resolveInWorkdir` correctly refuses. Measured live on a real generation.
 *
 * `type="file"` survived it by accident — `workbenchStore._runAction` joins the workdir itself and
 * routes the real write through `FilesStore.saveFile`, so the runner's own broken write threw into a
 * `catch` that only logged. `type="edit"` has no such second path, so **every edit action has always
 * failed**, on every provider (`/home/project` traverses exactly the same way).
 *
 * `toProjectRelativePath` is idempotent and root-aware: it strips a sandbox root when there is one and
 * leaves an already-relative path alone, so it is correct for both forms and for a map key written
 * under the OTHER provider's root. One rule, one place — the rule `sandbox-paths.ts` exists to hold.
 */
function sandboxRelativePath(filePath: string): string {
  return toProjectRelativePath(filePath);
}

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export type BaseActionState = BoltAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;

  /**
   * For `file` actions only: does this write CREATE a new file, or OVERWRITE an existing one?
   * Captured once, before the first write, so the artifact list can label it "Create" vs "Edit"
   * honestly — a full-file rewrite of an existing file (`type="file"`) is an edit, not a creation.
   * `undefined` = not yet decided (or a historical/replayed action we never ran).
   */
  isNew?: boolean;
};

export type FailedActionState = BoltAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = BaseActionState | FailedActionState;

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed' | 'isNew'>>;

export type ActionStateUpdate =
  | BaseActionUpdate
  | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string });

type ActionsMap = MapStore<Record<string, ActionState>>;

class ActionCommandError extends Error {
  readonly _output: string;
  readonly _header: string;

  constructor(message: string, output: string) {
    // Create a formatted message that includes both the error message and output
    const formattedMessage = `Failed To Execute Shell Command: ${message}\n\nOutput:\n${output}`;
    super(formattedMessage);

    // Set the output separately so it can be accessed programmatically
    this._header = message;
    this._output = output;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, ActionCommandError.prototype);

    // Set the name of the error for better debugging
    this.name = 'ActionCommandError';
  }

  // Optional: Add a method to get just the terminal output
  get output() {
    return this._output;
  }
  get header() {
    return this._header;
  }
}

export class ActionRunner {
  #sandbox: Promise<SandboxProvider>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  #shellTerminal: () => BoltShell;
  runnerId = atom<string>(`${Date.now()}`);
  actions: ActionsMap = map({});
  onAlert?: (alert: ActionAlert) => void;
  onSupabaseAlert?: (alert: SupabaseAlert) => void;
  onDeployAlert?: (alert: DeployAlert) => void;

  /**
   * Fired after a file/edit action's bytes land on the sandbox FS, with the final content.
   *
   * 🔴 The listener (FilesStore.recordAgentWrite) is what keeps the client file map fresh on a
   * provider whose watcher is a network round trip — without it, a serialization racing the watcher
   * captures a stale prefix of the generation and a later mount restores it over the real files.
   */
  #onFileWritten?: (absoluteFilePath: string, content: string) => void;
  buildOutput?: { path: string; exitCode: number; output: string };

  constructor(
    sandboxPromise: Promise<SandboxProvider>,
    getShellTerminal: () => BoltShell,
    onAlert?: (alert: ActionAlert) => void,
    onSupabaseAlert?: (alert: SupabaseAlert) => void,
    onDeployAlert?: (alert: DeployAlert) => void,
    onFileWritten?: (absoluteFilePath: string, content: string) => void,
  ) {
    this.#sandbox = sandboxPromise;
    this.#shellTerminal = getShellTerminal;
    this.onAlert = onAlert;
    this.onSupabaseAlert = onSupabaseAlert;
    this.onDeployAlert = onDeployAlert;
    this.#onFileWritten = onFileWritten;
  }

  /**
   * Register an action.
   *
   * `asCompleted` records an action that ALREADY HAPPENED, without running it or ever intending to
   * (SPEC §4.5.4b). It exists for the transcript of a project mounted from the user's own repository:
   * the conversation is replayed into the UI so they can read what was built, but the files are
   * already correct — they came from the repo — and re-running a months-old `<boltAction type="file">`
   * would write its stale body over them.
   *
   * Without it the only two options are both wrong: run the action (corrupt the repo's files) or add
   * it pending (a chat full of spinners for work that finished long ago).
   */
  addAction(data: ActionCallbackData, options?: { asCompleted?: boolean }) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      // action already added
      return;
    }

    const abortController = new AbortController();

    this.actions.setKey(actionId, {
      ...data.action,
      status: options?.asCompleted ? 'complete' : 'pending',
      executed: Boolean(options?.asCompleted),
      abort: () => {
        abortController.abort();
        this.#updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    if (options?.asCompleted) {
      // Historical. Nothing is queued for it, so nothing must ever move it out of `complete`.
      return;
    }

    this.#currentExecutionPromise.then(() => {
      this.#updateAction(actionId, { status: 'running' });
    });
  }

  async runAction(data: ActionCallbackData, isStreaming: boolean = false) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return; // No return value here
    }

    if (isStreaming && action.type !== 'file') {
      return; // No return value here
    }

    this.#updateAction(actionId, { ...action, ...data.action, executed: !isStreaming });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId, isStreaming);
      })
      .catch((error) => {
        logger.error('Action execution promise failed:', error);
      });

    await this.#currentExecutionPromise;

    return;
  }

  async #executeAction(actionId: string, isStreaming: boolean = false) {
    const action = this.actions.get()[actionId];

    this.#updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'shell': {
          await this.#runShellAction(action);
          break;
        }
        case 'file': {
          await this.#recordFileNovelty(actionId, action);
          await this.#runFileAction(action);
          break;
        }
        case 'edit': {
          await this.#runEditAction(action);
          break;
        }
        case 'supabase': {
          try {
            await this.handleSupabaseAction(action as SupabaseAction);
          } catch (error: any) {
            // Update action status
            this.#updateAction(actionId, {
              status: 'failed',
              error: error instanceof Error ? error.message : 'Supabase action failed',
            });

            // Return early without re-throwing
            return;
          }
          break;
        }
        case 'build': {
          const buildOutput = await this.#runBuildAction(action);

          // Store build output for deployment
          this.buildOutput = buildOutput;
          break;
        }
        case 'start': {
          // making the start app non blocking

          this.#runStartAction(action)
            .then(() => this.#updateAction(actionId, { status: 'complete' }))
            .catch((err: Error) => {
              if (action.abortSignal.aborted) {
                return;
              }

              this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });
              logger.error(`[${action.type}]:Action failed\n\n`, err);

              if (!(err instanceof ActionCommandError)) {
                return;
              }

              this.onAlert?.({
                type: 'error',
                title: 'Dev Server Failed',
                description: err.header,
                content: err.output,
              });
            });

          /*
           * adding a delay to avoid any race condition between 2 start actions
           * i am up for a better approach
           */
          await new Promise((resolve) => setTimeout(resolve, 2000));

          return;
        }
      }

      this.#updateAction(actionId, {
        status: isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      if (action.abortSignal.aborted) {
        return;
      }

      /*
       * An edit that will not apply is a REPORTABLE failure, not a silent one. The file is untouched
       * (`applyEditBlocks` is all-or-nothing), so the user asked for a change and got nothing — they
       * must be told, and the model must be given the error verbatim, because it says exactly which
       * SEARCH block missed and what to do about it.
       */
      if (error instanceof EditBlockError) {
        this.#updateAction(actionId, { status: 'failed', error: error.message });
        logger.error(`[edit]:Could not apply edit\n\n`, error);

        /*
         * 🔴 The description is the error's OWN first line, not a fixed sentence. It was hardcoded to
         * "A search/replace block did not match the file" — true for the common case and false for
         * every other `EditBlockError` (a malformed block, a binary target, an unreadable path). Live,
         * a PATH failure was presented to the owner as a failed text match, sending the investigation
         * at the model's search blocks when the model had done nothing wrong. A fixed description on a
         * variable failure is a false claim with a UI around it.
         */
        this.onAlert?.({
          type: 'error',
          title: 'Edit could not be applied',
          description: `${error.message.split('\n')[0]} Nothing was changed.`,
          content: error.message,
        });

        return;
      }

      this.#updateAction(actionId, { status: 'failed', error: 'Action failed' });
      logger.error(`[${action.type}]:Action failed\n\n`, error);

      if (!(error instanceof ActionCommandError)) {
        return;
      }

      this.onAlert?.({
        type: 'error',
        title: 'Dev Server Failed',
        description: error.header,
        content: error.output,
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runShellAction(action: ActionState) {
    if (action.type !== 'shell') {
      unreachable('Expected shell action');
    }

    /*
     * Allow-list gate (SPEC §4.2.5, §5). The WebContainer shell is where a command actually runs, so
     * this is the enforcement point — the system prompt's instruction to stay inside the allow-list
     * is guidance, and guidance is not a control. Refused commands surface as a normal action error,
     * which the model sees and can correct.
     */
    const allowed = isAllowedShellCommand(action.content);

    if (!allowed.allowed) {
      logger.warn(`Blocked shell command: ${action.content} — ${allowed.reason}`);
      throw new ActionCommandError(
        'Shell command not permitted',
        `${allowed.reason}\n\nOnly \`npm install <package>\` and \`npm run <script>\` may be run.`,
      );
    }

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    // Pre-validate command for common issues
    const validationResult = await this.#validateShellCommand(action.content);

    if (validationResult.shouldModify && validationResult.modifiedCommand) {
      logger.debug(`Modified command: ${action.content} -> ${validationResult.modifiedCommand}`);
      action.content = validationResult.modifiedCommand;
    }

    const resp = await shell.executeCommand(this.runnerId.get(), action.content, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    if (resp?.exitCode != 0) {
      const enhancedError = this.#createEnhancedShellError(action.content, resp?.exitCode, resp?.output);
      throw new ActionCommandError(enhancedError.title, enhancedError.details);
    }
  }

  async #runStartAction(action: ActionState) {
    if (action.type !== 'start') {
      unreachable('Expected shell action');
    }

    if (!this.#shellTerminal) {
      unreachable('Shell terminal not found');
    }

    /*
     * A `start` action is a shell command by another name — it runs on the same shell, with the same
     * reach. Gating only `type="shell"` would leave the allow-list (SPEC §4.2.5, §5) trivially
     * bypassable by relabelling the action, so the same gate applies here.
     */
    const allowed = isAllowedShellCommand(action.content);

    if (!allowed.allowed) {
      logger.warn(`Blocked start command: ${action.content} — ${allowed.reason}`);
      throw new ActionCommandError(
        'Start command not permitted',
        `${allowed.reason}\n\nOnly \`npm install <package>\` and \`npm run <script>\` may be run.`,
      );
    }

    const shell = this.#shellTerminal();
    await shell.ready();

    if (!shell || !shell.terminal || !shell.process) {
      unreachable('Shell terminal not found');
    }

    const resp = await shell.executeCommand(this.runnerId.get(), action.content, () => {
      logger.debug(`[${action.type}]:Aborting Action\n\n`, action);
      action.abort();
    });
    logger.debug(`${action.type} Shell Response: [exit code:${resp?.exitCode}]`);

    if (resp?.exitCode != 0) {
      throw new ActionCommandError('Failed To Start Application', resp?.output || 'No Output Available');
    }

    return resp;
  }

  /**
   * Record, on first touch, whether a `file` action creates a new file or overwrites an existing one,
   * so the artifact list labels it "Create" vs "Edit" honestly instead of calling every full-file write
   * a "Create" (which reads as wrong the moment the model rewrites a file that already exists).
   *
   * MUST run before the first write. A streaming `file` action re-enters `#executeAction` once per delta,
   * and after the first write the file exists — so the verdict is captured exactly once (guarded on
   * `isNew !== undefined`) and never flipped. The WebContainer FS is the source of truth: `type="file"`
   * carries no create-vs-overwrite signal of its own, and the FS also reflects a repo mount or a manual
   * edit the model's copy of the file does not know about.
   */
  async #recordFileNovelty(actionId: string, action: ActionState) {
    if (action.type !== 'file') {
      return;
    }

    if (this.actions.get()[actionId]?.isNew !== undefined) {
      return; // decided on the first delta; every later delta sees the file we just started writing
    }

    const sandbox = await this.#sandbox;
    const relativePath = sandboxRelativePath(action.filePath);
    const folder = nodePath.dirname(relativePath);

    let existed = false;

    try {
      const entries = await sandbox.fs.readdir(folder === '' || folder === '.' ? '.' : folder);
      existed = entries.includes(nodePath.basename(relativePath));
    } catch {
      // The parent directory does not exist yet → this is unambiguously a new file.
      existed = false;
    }

    this.#updateAction(actionId, { isNew: !existed });
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    const sandbox = await this.#sandbox;
    const relativePath = sandboxRelativePath(action.filePath);

    let folder = nodePath.dirname(relativePath);

    // remove trailing slashes
    folder = folder.replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await sandbox.fs.mkdir(folder, { recursive: true });
        logger.debug('Created folder', folder);
      } catch (error) {
        logger.error('Failed to create folder\n\n', error);
      }
    }

    /*
     * 🔴 A FAILED WRITE IS A FAILED ACTION. This used to `catch (error) { logger.error(...) }` and fall
     * through, so the action reported `complete` having written nothing — and that is precisely what
     * hid the path bug above for the whole life of `type="edit"`: the runner's own write threw
     * `SandboxPathError` on EVERY file action, silently, while `workbenchStore._runAction`'s separate
     * `saveFile(fullPath)` call quietly did the real write with a correctly-joined path. The feature
     * looked fine because a second code path was carrying it.
     *
     * Rethrowing hands it to `#executeAction`'s handler, which marks the action failed and surfaces it
     * (`spec/fail-loud.md`): a write the user paid for that did not land must never read as success.
     */
    await sandbox.fs.writeFile(relativePath, action.content);

    // Write-through to the file map — see #onFileWritten. Only after a write that SUCCEEDED.
    this.#onFileWritten?.(action.filePath, action.content);
    logger.debug(`File written ${relativePath}`);
  }

  /**
   * Apply a search/replace patch to an existing file (SPEC §4.2.8).
   *
   * Unlike a file action, this one never runs mid-stream — `runAction` only executes `file` actions
   * while `isStreaming`, so an edit is applied exactly once, when its closing tag arrives. That is not
   * incidental: half a SEARCH block matches nothing, and a patch is not a thing you can apply in
   * pieces the way you can progressively write a file.
   *
   * The read is from the WebContainer FS rather than the file map, because the FS is the source of
   * truth — it also carries any edit the user just made by hand in the editor, which the model's copy
   * of the file does not.
   */
  async #runEditAction(action: ActionState) {
    if (action.type !== 'edit') {
      unreachable('Expected edit action');
    }

    /*
     * Binaries are shown to the model as empty `<boltFile binary>` markers, so it has no bytes to
     * write a SEARCH block against. If it tries anyway, refuse: reading one as UTF-8 and writing the
     * result back would silently destroy the file (`spec/binary-files.md`).
     */
    if (isBinaryPath(action.filePath)) {
      throw new EditBlockError(
        `${action.filePath} is a binary file and cannot be edited as text. Binary assets are replaced through the Assets tab, never through an artifact.`,
      );
    }

    const sandbox = await this.#sandbox;
    const relativePath = sandboxRelativePath(action.filePath);

    let source: string;

    try {
      source = await sandbox.fs.readFile(relativePath, 'utf-8');
    } catch (error) {
      /*
       * 🔴 A BARE `catch` HERE TOLD THE USER — AND THE MODEL — A LIE. Every read failure was reported
       * as "the file does not exist", so when the path itself was malformed (see `sandboxRelativePath`)
       * the message named the wrong cause AND prescribed the wrong fix: "create it with `type=file`",
       * i.e. overwrite a file that is sitting right there. The model would have done it.
       *
       * Only a genuine miss earns that message; anything else is reported verbatim, because an error we
       * cannot classify is exactly the one whose text we must not replace with a guess.
       */
      const message = error instanceof Error ? error.message : String(error);

      if (/\bENOENT\b|not found|no such file|does not exist/i.test(message)) {
        throw new EditBlockError(
          `${action.filePath} does not exist, so there is nothing to edit. Create it with \`type="file"\` instead.`,
        );
      }

      throw new EditBlockError(`Could not read ${action.filePath} to edit it: ${message}`);
    }

    // Both of these throw rather than return partial work, so a failed patch never reaches disk.
    const blocks = parseEditBlocks(action.content);
    const patched = applyEditBlocks(source, blocks, action.filePath);

    await sandbox.fs.writeFile(relativePath, patched);

    // Same write-through as #runFileAction — the map must carry the PATCHED content immediately.
    this.#onFileWritten?.(action.filePath, patched);
    logger.debug(`Applied ${blocks.length} edit block(s) to ${relativePath}`);
  }

  #updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }

  async getFileHistory(filePath: string): Promise<FileHistory | null> {
    try {
      const sandbox = await this.#sandbox;
      const historyPath = this.#getHistoryPath(filePath);
      const content = await sandbox.fs.readFile(historyPath, 'utf-8');

      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to get file history:', error);
      return null;
    }
  }

  async saveFileHistory(filePath: string, history: FileHistory) {
    // const sandbox = await this.#sandbox;
    const historyPath = this.#getHistoryPath(filePath);

    await this.#runFileAction({
      type: 'file',
      filePath: historyPath,
      content: JSON.stringify(history),
      changeSource: 'auto-save',
    } as any);
  }

  #getHistoryPath(filePath: string) {
    return nodePath.join('.history', filePath);
  }

  async #runBuildAction(action: ActionState) {
    if (action.type !== 'build') {
      unreachable('Expected build action');
    }

    // Trigger build started alert
    this.onDeployAlert?.({
      type: 'info',
      title: 'Building Application',
      description: 'Building your application...',
      stage: 'building',
      buildStatus: 'running',
      deployStatus: 'pending',
      source: 'netlify',
    });

    const sandbox = await this.#sandbox;

    /*
     * Argv comes from `buildSpawnArgs` — an exact-match selector between the two known-safe build
     * commands (T17b). The action's `content` can originate from the model's output channel, so it is
     * never parsed into argv; unknown content degrades to the plain `npm run build`.
     */
    const buildProcess = await sandbox.spawn('npm', buildSpawnArgs(action.content));

    let output = '';
    const outputPromise = buildProcess.output.pipeTo(
      new WritableStream({
        write(data) {
          output += data;
        },
      }),
    );

    const exitCode = await buildProcess.exit;
    await outputPromise.catch(() => {
      // Ignore output piping errors; we still have whatever was captured
    });

    let buildDir = '';

    if (exitCode !== 0) {
      const buildResult = {
        path: buildDir,
        exitCode,
        output,
      };

      this.buildOutput = buildResult;

      // Trigger build failed alert
      this.onDeployAlert?.({
        type: 'error',
        title: 'Build Failed',
        description: 'Your application build failed',
        content: output || 'No build output available',
        stage: 'building',
        buildStatus: 'failed',
        deployStatus: 'pending',
        source: 'netlify',
      });

      throw new ActionCommandError('Build Failed', output || 'No Output Available');
    }

    // Trigger build success alert
    this.onDeployAlert?.({
      type: 'success',
      title: 'Build Completed',
      description: 'Your application was built successfully',
      stage: 'deploying',
      buildStatus: 'complete',
      deployStatus: 'running',
      source: 'netlify',
    });

    // Check for common build directories
    const commonBuildDirs = ['dist', 'build', 'out', 'output', '.next', 'public'];

    // Try to find the first existing build directory
    for (const dir of commonBuildDirs) {
      const dirPath = nodePath.join(sandbox.workdir, dir);

      try {
        await sandbox.fs.readdir(dirPath);
        buildDir = dirPath;
        break;
      } catch {
        continue;
      }
    }

    // If no build directory was found, use the default (dist)
    if (!buildDir) {
      buildDir = nodePath.join(sandbox.workdir, 'dist');
    }

    const buildResult = {
      path: buildDir,
      exitCode,
      output,
    };

    this.buildOutput = buildResult;

    return buildResult;
  }
  async handleSupabaseAction(action: SupabaseAction) {
    const { operation, content, filePath } = action;
    logger.debug('[Supabase Action]:', { operation, filePath, content });

    switch (operation) {
      case 'migration':
        if (!filePath) {
          throw new Error('Migration requires a filePath');
        }

        // Show alert for migration action
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Migration',
          description: `Create migration file: ${filePath}`,
          content,
          source: 'supabase',
        });

        // Only create the migration file
        await this.#runFileAction({
          type: 'file',
          filePath,
          content,
          changeSource: 'supabase',
        } as any);
        return { success: true };

      case 'query': {
        // Always show the alert and let the SupabaseAlert component handle connection state
        this.onSupabaseAlert?.({
          type: 'info',
          title: 'Supabase Query',
          description: 'Execute database query',
          content,
          source: 'supabase',
        });

        // The actual execution will be triggered from SupabaseChatAlert
        return { pending: true };
      }

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  // Add this method declaration to the class
  handleDeployAction(
    stage: 'building' | 'deploying' | 'complete',
    status: ActionStatus,
    details?: {
      url?: string;
      error?: string;
      source?: 'netlify' | 'vercel' | 'github' | 'gitlab';
    },
  ): void {
    if (!this.onDeployAlert) {
      logger.debug('No deploy alert handler registered');
      return;
    }

    const alertType = status === 'failed' ? 'error' : status === 'complete' ? 'success' : 'info';

    const title =
      stage === 'building'
        ? 'Building Application'
        : stage === 'deploying'
          ? 'Deploying Application'
          : 'Deployment Complete';

    const description =
      status === 'failed'
        ? `${stage === 'building' ? 'Build' : 'Deployment'} failed`
        : status === 'running'
          ? `${stage === 'building' ? 'Building' : 'Deploying'} your application...`
          : status === 'complete'
            ? `${stage === 'building' ? 'Build' : 'Deployment'} completed successfully`
            : `Preparing to ${stage === 'building' ? 'build' : 'deploy'} your application`;

    const buildStatus =
      stage === 'building' ? status : stage === 'deploying' || stage === 'complete' ? 'complete' : 'pending';

    const deployStatus = stage === 'building' ? 'pending' : status;

    this.onDeployAlert({
      type: alertType,
      title,
      description,
      content: details?.error || '',
      url: details?.url,
      stage,
      buildStatus: buildStatus as any,
      deployStatus: deployStatus as any,
      source: details?.source || 'netlify',
    });
  }

  async #validateShellCommand(command: string): Promise<{
    shouldModify: boolean;
    modifiedCommand?: string;
    warning?: string;
  }> {
    const trimmedCommand = command.trim();

    // Handle rm commands that might fail due to missing files
    if (trimmedCommand.startsWith('rm ') && !trimmedCommand.includes(' -f')) {
      const rmMatch = trimmedCommand.match(/^rm\s+(.+)$/);

      if (rmMatch) {
        const filePaths = rmMatch[1].split(/\s+/);

        // Check if any of the files exist using WebContainer
        try {
          const sandbox = await this.#sandbox;
          const existingFiles = [];

          for (const filePath of filePaths) {
            if (filePath.startsWith('-')) {
              continue;
            } // Skip flags

            try {
              await sandbox.fs.readFile(filePath);
              existingFiles.push(filePath);
            } catch {
              // File doesn't exist, skip it
            }
          }

          if (existingFiles.length === 0) {
            // No files exist, modify command to use -f flag to avoid error
            return {
              shouldModify: true,
              modifiedCommand: `rm -f ${filePaths.join(' ')}`,
              warning: 'Added -f flag to rm command as target files do not exist',
            };
          } else if (existingFiles.length < filePaths.length) {
            // Some files don't exist, modify to only remove existing ones with -f for safety
            return {
              shouldModify: true,
              modifiedCommand: `rm -f ${filePaths.join(' ')}`,
              warning: 'Added -f flag to rm command as some target files do not exist',
            };
          }
        } catch (error) {
          logger.debug('Could not validate rm command files:', error);
        }
      }
    }

    // Handle cd commands to non-existent directories
    if (trimmedCommand.startsWith('cd ')) {
      const cdMatch = trimmedCommand.match(/^cd\s+(.+)$/);

      if (cdMatch) {
        const targetDir = cdMatch[1].trim();

        try {
          const sandbox = await this.#sandbox;
          await sandbox.fs.readdir(targetDir);
        } catch {
          return {
            shouldModify: true,
            modifiedCommand: `mkdir -p ${targetDir} && cd ${targetDir}`,
            warning: 'Directory does not exist, created it first',
          };
        }
      }
    }

    // Handle cp/mv commands with missing source files
    if (trimmedCommand.match(/^(cp|mv)\s+/)) {
      const parts = trimmedCommand.split(/\s+/);

      if (parts.length >= 3) {
        const sourceFile = parts[1];

        try {
          const sandbox = await this.#sandbox;
          await sandbox.fs.readFile(sourceFile);
        } catch {
          return {
            shouldModify: false,
            warning: `Source file '${sourceFile}' does not exist`,
          };
        }
      }
    }

    return { shouldModify: false };
  }

  #createEnhancedShellError(
    command: string,
    exitCode: number | undefined,
    output: string | undefined,
  ): {
    title: string;
    details: string;
  } {
    const trimmedCommand = command.trim();
    const firstWord = trimmedCommand.split(/\s+/)[0];

    // Common error patterns and their explanations
    const errorPatterns = [
      {
        pattern: /cannot remove.*No such file or directory/,
        title: 'File Not Found',
        getMessage: () => {
          const fileMatch = output?.match(/'([^']+)'/);
          const fileName = fileMatch ? fileMatch[1] : 'file';

          return `The file '${fileName}' does not exist and cannot be removed.\n\nSuggestion: Use 'ls' to check what files exist, or use 'rm -f' to ignore missing files.`;
        },
      },
      {
        pattern: /No such file or directory/,
        title: 'File or Directory Not Found',
        getMessage: () => {
          if (trimmedCommand.startsWith('cd ')) {
            const dirMatch = trimmedCommand.match(/cd\s+(.+)/);
            const dirName = dirMatch ? dirMatch[1] : 'directory';

            return `The directory '${dirName}' does not exist.\n\nSuggestion: Use 'mkdir -p ${dirName}' to create it first, or check available directories with 'ls'.`;
          }

          return `The specified file or directory does not exist.\n\nSuggestion: Check the path and use 'ls' to see available files.`;
        },
      },
      {
        pattern: /Permission denied/,
        title: 'Permission Denied',
        getMessage: () =>
          `Permission denied for '${firstWord}'.\n\nSuggestion: The file may not be executable. Try 'chmod +x filename' first.`,
      },
      {
        pattern: /command not found/,
        title: 'Command Not Found',
        getMessage: () =>
          `The command '${firstWord}' is not available in the project sandbox.\n\nSuggestion: Check available commands or use a package manager to install it.`,
      },
      {
        pattern: /Is a directory/,
        title: 'Target is a Directory',
        getMessage: () =>
          `Cannot perform this operation - target is a directory.\n\nSuggestion: Use 'ls' to list directory contents or add appropriate flags.`,
      },
      {
        pattern: /File exists/,
        title: 'File Already Exists',
        getMessage: () => `File already exists.\n\nSuggestion: Use a different name or add '-f' flag to overwrite.`,
      },
    ];

    // Try to match known error patterns
    for (const errorPattern of errorPatterns) {
      if (output && errorPattern.pattern.test(output)) {
        return {
          title: errorPattern.title,
          details: errorPattern.getMessage(),
        };
      }
    }

    // Generic error with suggestions based on command type
    let suggestion = '';

    if (trimmedCommand.startsWith('npm ')) {
      suggestion = '\n\nSuggestion: Try running "npm install" first or check package.json.';
    } else if (trimmedCommand.startsWith('git ')) {
      suggestion = "\n\nSuggestion: Check if you're in a git repository or if remote is configured.";
    } else if (trimmedCommand.match(/^(ls|cat|rm|cp|mv)/)) {
      suggestion = '\n\nSuggestion: Check file paths and use "ls" to see available files.';
    }

    return {
      title: `Command Failed (exit code: ${exitCode})`,
      details: `Command: ${trimmedCommand}\n\nOutput: ${output || 'No output available'}${suggestion}`,
    };
  }
}
