/**
 * The workspace an IMPORT writes into (SPEC §4.4a, §4.5.5; `spec/sandbox-codesandbox.md`).
 *
 * 🔴 **Importing a repo or a folder starts from the landing page, where no project exists yet** — and
 * on a server-backed sandbox there is nothing to write into until one does. That is the whole reason
 * this module exists.
 *
 * Before per-project sandboxes these two flows appeared to work on that provider only because the
 * per-user registry handed back whichever VM the user happened to have — i.e. they wrote the imported
 * repo straight into another project's filesystem (the cross-project adoption defect T2 removed). So
 * the fix is not to restore that behaviour; it is to give an import the same shape a creation now has:
 * **register the project FIRST, boot the sandbox for it, and only then write bytes.**
 *
 * WebContainer is deliberately untouched. Its runtime is tab-local and anonymous, it boots eagerly at
 * module scope, and an import there has never needed a project record — so on that provider this
 * returns the already-booted sandbox and no project, byte-identical to the flow it replaces. Adding a
 * server round trip to the incumbent's import path would be a behaviour change nobody asked for.
 */
import { bootForProject, bootedProjectId, requireBootedSandbox, SANDBOX_REQUIRES_PROJECT } from '~/lib/sandbox';
import type { SandboxProvider } from '~/lib/sandbox';
import { createProject, deleteProject } from '~/lib/persistence/projects';
import { rollbackRegisteredProject } from './creation-rollback';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ImportProject');

/**
 * Imports have no registry entry — they bring their own files rather than a starter — so they are
 * recorded against the same neutral template the server already defaults to for a bodyless create.
 */
const IMPORT_TEMPLATE_ID = 'blank-canvas';

export interface ImportWorkspace {
  /** The runtime the import may write into. Always usable — a failure throws rather than resolving. */
  sandbox: SandboxProvider;

  /**
   * The project this import belongs to, when one exists.
   *
   * `undefined` on WebContainer, where an import is a browser-local chat and always has been. When
   * set, the caller MUST carry it into the imported chat's metadata — the page reloads into
   * `/chat/<id>` and that pointer is the only thing that will boot this same sandbox again.
   */
  projectId?: string;

  /**
   * Undo the registration if the import itself then fails — the caller MUST call it from its catch.
   *
   * 🔴 The boot is not the last thing that can go wrong. A typo'd repo URL, a rejected credential, a
   * file that will not read: every one of those happens AFTER this function has returned, and without
   * this the failed import leaves a registered empty project on the dashboard **and** a forked VM
   * billing by the second — the exact orphan `creation-rollback.ts` exists to prevent, one flow over.
   *
   * A no-op when this call did not create anything, so a clone started from inside an open project
   * can never delete the project the user is looking at. Never rejects.
   */
  rollback: () => Promise<void>;
}

/** Nothing was registered, so there is nothing to undo. */
export const NO_ROLLBACK = async (): Promise<void> => {
  /* Deliberately empty — see `ImportWorkspace.rollback`. */
};

/**
 * Get a sandbox an import can write into, creating the project it belongs to if that is what the
 * runtime requires.
 *
 * @param name What to call the project — the repo or folder being imported. Truncated server-side.
 */
export async function openImportWorkspace(options: { name: string }): Promise<ImportWorkspace> {
  const alreadyBooted = bootedProjectId();

  /*
   * Nothing to register: either this tab is already bound to a project (an import from inside an open
   * project writes into that project, which is what the user is looking at), or the runtime does not
   * need one at all. `requireBootedSandbox` is the right await in both cases — it refuses with a
   * sentence rather than hanging if the boot is genuinely impossible.
   */
  if (alreadyBooted || !SANDBOX_REQUIRES_PROJECT) {
    return { sandbox: await requireBootedSandbox(), projectId: alreadyBooted, rollback: NO_ROLLBACK };
  }

  const project = await createProject({ name: options.name, templateId: IMPORT_TEMPLATE_ID });

  /*
   * 🔴 One rollback, used twice: here if the boot fails, and by the CALLER if the import that follows
   * fails. A project registered a moment ago that never received files holds nothing, but it lists on
   * the dashboard as an empty card — which reads as data loss — it counts against the per-user create
   * budget on the retry, and on a server runtime it is a VM billing by the second.
   *
   * Never rejects: the import failure is what the user needs to hear, and replacing it with "we could
   * not clean up" would report the wrong problem to the one person who cannot act on it.
   */
  const rollback = async () => {
    await rollbackRegisteredProject({
      projectId: project.id,
      remove: deleteProject,
      onError: (cleanupError) => logger.error(`Could not roll back the empty project ${project.id}`, cleanupError),
    });
  };

  try {
    const sandbox = await bootForProject(project.id);
    logger.info(`Import "${options.name}" registered as project ${project.id}`);

    return { sandbox, projectId: project.id, rollback };
  } catch (error) {
    await rollback();

    throw error;
  }
}
