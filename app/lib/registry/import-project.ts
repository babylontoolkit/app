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
 * 🔴 **EVERY IMPORT REGISTERS A PROJECT, ON BOTH RUNTIMES — because every import provisions a
 * workspace, and the platform pays for that either way (owner, 2026-07-31, §4.4a/§4.6).**
 *
 * This module used to skip registration entirely when `!SANDBOX_REQUIRES_PROJECT`, and its header said
 * so deliberately: *"WebContainer is deliberately untouched… adding a server round trip to the
 * incumbent's import path would be a behaviour change nobody asked for."* That reasoning was about
 * RUNTIME NEED — a tab-local WebContainer boots without a project id, so it does not require the row —
 * and it silently answered a different question with the same expression: **whether the user is
 * charged.** `PROJECT_CREATE_CREDITS` is taken at registration (`POST /api/projects`), so a door that
 * does not register is a door that provisions a workspace for free. New Project always registered on
 * both providers; import did not, so the identical work was billed on CodeSandbox and free on
 * WebContainer — the DEFAULT provider — with nothing anywhere reporting the difference.
 *
 * `SANDBOX_REQUIRES_PROJECT` now decides only what it is named for: whether a boot NEEDS the id, and
 * therefore whether a failed registration is fatal (server sandbox: nowhere to put the files) or
 * degrades to a local-only project (WebContainer: §1.3 principle 0 — an unreachable server must not
 * stop someone building). It no longer decides whether money is taken.
 *
 * The one exemption is `alreadyBooted`: an import INTO a project the user already has open writes to a
 * workspace that has already been paid for, and charging again would bill twice for one VM.
 *
 * ⚠️ A 402 is not an outage. It is the platform deliberately declining, so it refuses the import on
 * EVERY runtime — degrading past it would hand a user with no credits a working project for free and
 * tell them the server was unreachable, which is false. Both halves wrong, neither throws. Same rule,
 * same reason, as the creation path in `Chat.client.tsx`.
 */
import { bootForProject, bootedProjectId, requireBootedSandbox, SANDBOX_REQUIRES_PROJECT } from '~/lib/sandbox';
import type { SandboxProvider } from '~/lib/sandbox';
import { ApiError, createProject, deleteProject } from '~/lib/persistence/projects';
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
 * Register the project this import belongs to — the call that also takes `PROJECT_CREATE_CREDITS`.
 *
 * Returns `null` only when registration failed on a runtime that can proceed without it. Three
 * outcomes, and the middle one is the one that costs money if it is got wrong:
 *
 *   - **success** — the project exists and the charge has been taken.
 *   - **402** — the platform declining, not an outage. Rethrown on EVERY runtime, so a user with no
 *     credits cannot import a project for free on WebContainer while being told the server was
 *     unreachable. This is the whole reason the failure is inspected rather than blanket-degraded.
 *   - **anything else** (500, dropped connection, local-mode hiccup) — fatal on a runtime that needs
 *     the id to boot at all, degraded to a browser-local import where the runtime does not (§1.3
 *     principle 0: an unreachable server must not stop someone building).
 */
async function registerImportProject(name: string) {
  try {
    return await createProject({ name, templateId: IMPORT_TEMPLATE_ID });
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 402) {
      throw error;
    }

    if (SANDBOX_REQUIRES_PROJECT) {
      throw error;
    }

    logger.warn(
      `Could not register the imported project "${name}" — continuing as a browser-local import: ${
        (error as Error).message
      }`,
    );

    return null;
  }
}

/**
 * Get a sandbox an import can write into, registering the project it belongs to.
 *
 * @param name What to call the project — the repo or folder being imported. Truncated server-side.
 */
export async function openImportWorkspace(options: { name: string }): Promise<ImportWorkspace> {
  const alreadyBooted = bootedProjectId();

  /*
   * The ONE exemption: this tab is already bound to a project, so the import writes into the project
   * the user is looking at — a workspace that already exists and has already been charged for.
   * Registering again would put a duplicate card on the dashboard AND bill twice for one VM.
   * `requireBootedSandbox` refuses with a sentence rather than hanging if the boot is impossible.
   */
  if (alreadyBooted) {
    return { sandbox: await requireBootedSandbox(), projectId: alreadyBooted, rollback: NO_ROLLBACK };
  }

  const project = await registerImportProject(options.name);

  /*
   * Registration was refused or unreachable on a runtime that can carry on without it (WebContainer).
   * The import proceeds as a browser-local chat, exactly as it always did on that provider.
   */
  if (!project) {
    return { sandbox: await requireBootedSandbox(), projectId: undefined, rollback: NO_ROLLBACK };
  }

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
