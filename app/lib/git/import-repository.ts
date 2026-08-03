/**
 * The ONE path a repository takes into a workspace (SPEC §4.13, §4.4a, §4.5.4b).
 *
 * ## Why this is a module and not a handler on a button
 *
 * There are three doors — the "Clone a repo" button, the `/git?url=` route, and `StarterTemplates`
 * (which is a link to `/git?url=` and therefore goes through the second) — and before this they were
 * two independent implementations of the same operation that had already drifted apart in five ways:
 * one honoured the branch the selector had chosen and the other silently dropped it, one carried the
 * project id into the imported chat and the other carried the URL, one reported the server's actual
 * error and the other a fixed "Failed to import repository", one guarded on `&&` where its own effect
 * guarded on `||`, and only one had had its binary-corruption defect fixed. §4.1a's rule, one layer
 * down: **an action more than one surface can trigger is a module, not a button.**
 *
 * ## The shape, and what each step is for
 *
 *   register the project → clone (server-side) → write the bytes → settle → checkpoint → hand off
 *
 * 🔴 **The files land by DIRECT WRITE, not by artifact replay.** Upstream delivered a clone as a
 * `<boltArtifact>` full of `<boltAction type="file">` bodies that the message parser replayed after the
 * page reloaded. That is wrong twice: it is a TEXT protocol, so every binary was decoded and written
 * back corrupted (`spec/binary-files.md`), and every byte of every file was paid for in the model's
 * context on that turn and on every later turn forever (§4.2.8) — for a foreign repository, the
 * highest-variance ingest this platform has. The bytes now go straight to the sandbox as bytes, and the
 * artifact is a DESCRIPTION: what was imported, and the commands to run it.
 *
 * ⚠️ That is also why a local checkpoint is written before the hand-off. `importChat` ends in a full
 * page load, and on a tab-local sandbox the runtime holding those bytes does not survive it. The
 * checkpoint is what the reload mounts from (`selectMountSource` → `local`) — it works offline, it
 * works whether or not the link in T9 succeeded, and it is the same IndexedDB copy every other door
 * relies on. Under the old replay design the artifact was doing this job by accident, badly.
 *
 * ## What it does not do
 *
 * It never holds a credential and never asks for one. The server resolves the caller's token from
 * `git_tokens` and a public repository needs no token at all (`git/clone.ts`), so a user who has
 * connected GitHub is simply not asked again — which was the entire complaint.
 */
import type { Message } from 'ai';
import { toast } from 'react-toastify';
import { generateId } from '~/utils/fileUtils';
import { cloneRepoIntoProject, linkProjectToRepo } from '~/lib/persistence/projects';
import { createLocalSnapshot } from '~/lib/persistence/local-snapshots';
import { db } from '~/lib/persistence/useChatHistory';
import { openImportWorkspace } from '~/lib/registry/import-project';
import { settleAfterCreation, IMPORT_SETTLE_OPTIONS } from '~/lib/registry/settle';
import { bootProgress, endBootPhase, reportBootFailure } from '~/lib/stores/boot-progress';
import { workbenchStore } from '~/lib/stores/workbench';
import { protectForRepoRestore } from '~/lib/persistence/restore-plan';
import { createCommandsMessage, detectProjectCommands } from '~/utils/projectCommands';
import { runtimeSupportsNativeAddons } from '~/lib/sandbox';
import { createScopedLogger } from '~/utils/logger';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { IChatMetadata } from '~/lib/persistence/db';

const logger = createScopedLogger('ImportRepository');

export type ImportChat = (description: string, messages: Message[], metadata?: IChatMetadata) => Promise<void>;

export interface ImportRepositoryResult {
  ok: boolean;

  /** The provider connection is missing or lapsed — the caller offers CONNECT, never a credential box. */
  reconnect?: boolean;

  /**
   * Why it failed, in the server's own words.
   *
   * Never a fixed sentence. Both doors used to report `Failed to import repository`, which is
   * indistinguishable from a button that did nothing — and the real reasons ("that repository stores
   * files in Git-LFS", "over the 256MB import limit", "connect GitHub and try again") are each a
   * different action the user can take. A refusal that names no cause is read as the button being
   * broken (`share/build-failure.ts`, the same lesson one feature over).
   */
  message?: string;
}

/** `https://github.com/octocat/Hello-World.git` → `Hello-World`. What the project gets called. */
export function projectNameFromRepo(repo: string): string {
  const cleaned = repo
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const last = cleaned.split('/').filter(Boolean).pop() ?? '';

  return last || 'Imported project';
}

/**
 * The text files a command detector may read.
 *
 * Deliberately NOT the artifact's payload — nothing here is emitted to the model. `detectProjectCommands`
 * needs to read `package.json` to know whether this repo has an `install` and a `dev`, and that is the
 * only reason any file body is materialised on this path at all.
 */
function textFilesFor(files: SerializedFileMap): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];

  for (const [path, dirent] of Object.entries(files)) {
    if (dirent && dirent.type === 'file' && !dirent.isBinary) {
      out.push({ path, content: dirent.content });
    }
  }

  return out;
}

/**
 * The message that RECORDS the import.
 *
 * No file bodies (§4.2.8) — the bytes are already on disk and correct, and putting them here would buy
 * a corrupted copy of every binary plus a permanent per-turn bill for the privilege. It carries what
 * the model and the user actually need: where the code came from, and how big it is.
 */
function describeImport(input: { repo: string; branch: string; fileCount: number; skippedSecrets: string[] }): Message {
  const secrets =
    input.skippedSecrets.length > 0
      ? `\n\nNot imported (secrets are never carried into a project): ${input.skippedSecrets.join(', ')}.`
      : '';

  return {
    role: 'assistant',
    content:
      `Imported **${input.repo}** (branch \`${input.branch}\`) into this project — ` +
      `${input.fileCount} file(s) are in your workspace and ready to edit.${secrets}`,
    id: generateId(),
    createdAt: new Date(),
  };
}

/**
 * Import a repository into a workspace, narrating the whole operation on the shared boot surface.
 *
 * Returns an outcome and never throws: the caller renders the failure, and a thrown error at a caller
 * that forgot a `catch` is a spinner that stops with no explanation.
 */
export async function importRepositoryIntoWorkspace(input: {
  /** Whatever the user typed or the selector chose — a URL or `owner/repo`. Reduced server-side. */
  repo: string;
  branch?: string;
  provider?: 'github' | 'gitlab';
  importChat: ImportChat;
}): Promise<ImportRepositoryResult> {
  const name = projectNameFromRepo(input.repo);

  /*
   * Phase FIRST, before the project is registered — registration is a server round trip and a credit
   * charge, and it is already part of the wait the user is looking at. Setting the phase afterwards
   * leaves the first seconds of the operation uncovered, which is precisely the class of gap §4.4a's
   * "the splash covers every door" rule was rewritten twice to close.
   */
  bootProgress.set({ step: 'cloning' });

  let workspace: Awaited<ReturnType<typeof openImportWorkspace>> | undefined;

  try {
    workspace = await openImportWorkspace({ name });

    /*
     * The clone is project-scoped — both walls, and the token is resolved from the session against the
     * project's owner. A degraded browser-local import (WebContainer, registration unreachable) has no
     * project to scope it to, so it is refused rather than silently falling back to the retired
     * browser-side clone. This is not a lost capability: the same server that could not register the
     * project cannot serve the clone either.
     */
    if (!workspace.projectId) {
      throw new Error('We could not set up a project for this import. Check your connection and try again.');
    }

    const cloned = await cloneRepoIntoProject(workspace.projectId, {
      repo: input.repo,
      branch: input.branch,
      provider: input.provider,
    });

    if (!cloned.ok || !cloned.files) {
      await workspace.rollback();
      reportBootFailure({
        message: cloned.message ?? 'The repository could not be imported.',
        retryable: cloned.retryable ?? false,
      });

      return { ok: false, reconnect: cloned.reconnect, message: cloned.message };
    }

    /*
     * `protectForRepoRestore` — the repo map is authoritative about everything EXCEPT the secret family,
     * which `isSecretPath` kept out of it. Treating it as the whole truth would delete a `.env` the user
     * had already put in the workspace (§4.5.4b's restore rule; the same call the pull path makes).
     */
    bootProgress.set({ step: 'files', done: 0, total: Object.keys(cloned.files).length });
    await workbenchStore.restoreFiles(cloned.files, {
      protect: protectForRepoRestore,
      onProgress: (done, total) => bootProgress.set({ step: 'files', done, total }),
    });

    /*
     * The write resolving is not the map having finished changing — the watcher's tail is still arriving,
     * an RTT per file on a server sandbox. `IMPORT_SETTLE_OPTIONS`, never a re-derived copy and never a
     * blind `setTimeout`: too short on a cold VM, pure dead time on a warm one.
     */
    bootProgress.set({ step: 'settling' });
    await settleAfterCreation({
      ...IMPORT_SETTLE_OPTIONS,
      readCount: () => Object.keys(workbenchStore.files.get()).length,
    });

    /*
     * The copy that survives the hand-off's full page load — see the module header. Best-effort: a
     * failed checkpoint must not fail an import whose files are already correctly on disk.
     *
     * 🔴 But it is LOUD (`spec/fail-loud.md`), not merely logged. The only ENABLED sandbox provider is
     * session-scoped (`SANDBOX_PROVIDER_TRAITS.nodepod.outlivesSession === false`), so the runtime
     * holding these bytes does not survive the full page load `importChat` ends in — which makes this
     * checkpoint the thing the reload mounts from. A failure here therefore means the import may not
     * come back, and a server-side `logger.error` is read by nobody. Same precedent, same reason, as
     * `GitHubSyncButton`'s `snapshotLocally`: the sync itself survives, the user is told anyway.
     */
    if (db) {
      try {
        await createLocalSnapshot(db, {
          projectId: workspace.projectId,
          files: cloned.files,
          label: `Imported ${cloned.repo ?? name}`,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error('Could not checkpoint the imported project', error);
        toast.warn(
          `Could not save a local checkpoint of ${name}: ${detail}. The files are in your workspace, but they may not ` +
            `survive a reload — commit them to a repository before closing this tab.`,
        );
      }
    }

    /*
     * 🔴 AN IMPORTED PROJECT IS BORN LINKED (§4.5.4b).
     *
     * The documented lifecycle is UNLINKED → SAVE = LINK → LINKED, and an import is a fourth entry
     * point into it: this project's code demonstrably already lives in a repository — we just read it
     * from there — so calling it UNLINKED would be false, and would ask the user to "save" a game that
     * is saved. It also means the reload after the hand-off can mount from the repo
     * (`selectMountSource` → `repo`), on any device.
     *
     * ⚠️ Best-effort, and the ORDER is why: the files are already correct on disk and already
     * checkpointed, so a link failure is a missing pointer, not lost work. It is reported and the
     * project stays honestly unlinked — a half-written link would be refused by the database anyway
     * (`projects_link_complete_check`), which is the point of writing all three fields at once.
     *
     * The provider is sent EXPLICITLY. A GitLab import that let the route's `github` default stand
     * would record a project whose every later push resolves the wrong token against the wrong host.
     */
    if (cloned.repo && cloned.branch && cloned.provider) {
      /*
       * ⚠️ The `try` is not politeness, and it is not redundant with `linkProjectToRepo`'s own
       * never-throws contract. This block sits INSIDE the function's outer `catch`, whose job is to
       * roll the project back — so a link that threw for any reason at all (a future refactor, a
       * `fetch` polyfill that rejects outside the helper's own guard) would DELETE a project whose
       * files are already correct on disk and already checkpointed, over a pointer. Best-effort has
       * to be enforced at the call site, or "best-effort" is only true for the failure shape that was
       * imagined when it was written.
       */
      try {
        const linked = await linkProjectToRepo(workspace.projectId, {
          repo: cloned.repo,
          branch: cloned.branch,
          provider: cloned.provider,
        });

        if (!linked.ok) {
          logger.error(`Imported ${cloned.repo} but could not record the link: ${linked.message}`);
        }
      } catch (error) {
        logger.error(`Imported ${cloned.repo} but could not record the link`, error);
      }
    }

    const commands = await detectProjectCommands(textFilesFor(cloned.files), {
      nativeAddons: await runtimeSupportsNativeAddons(),
    });
    const commandsMessage = createCommandsMessage(commands);

    const messages: Message[] = [
      describeImport({
        repo: cloned.repo ?? input.repo,
        branch: cloned.branch ?? 'default',
        fileCount: Object.keys(cloned.files).length,
        skippedSecrets: cloned.skippedSecrets ?? [],
      }),
    ];

    if (commandsMessage) {
      messages.push(commandsMessage);
    }

    /*
     * BOTH pointers. The clone button used to send only `projectId` and the `/git?url=` route only
     * `gitUrl`, so each imported chat was missing half of what it took to reopen: without the project id
     * the reloaded chat has no sandbox to boot, and without the URL nothing records where the code came
     * from. `importChat` is the single choke point (it arms the import tail before navigating), so this
     * is the one place either can be got right.
     */
    await input.importChat(`Git Project:${name}`, messages, { projectId: workspace.projectId, gitUrl: input.repo });

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Import of ${input.repo} failed`, error);

    // No orphan: a project registered a moment ago that never received files is an empty card and a VM.
    await workspace?.rollback();
    reportBootFailure({ message, retryable: true });

    return { ok: false, message };
  } finally {
    /*
     * `endBootPhase`, never `bootProgress.set({step:'idle'})` — the literal reset would stomp the
     * `failed` phase this function may just have written, taking down the only sentence explaining what
     * went wrong a fraction of a second after it appeared.
     */
    endBootPhase();
  }
}
