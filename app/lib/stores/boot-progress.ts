/**
 * What opening a project is currently doing — the store behind the boot screen.
 *
 * `Chat.client.tsx` renders NOTHING until `useChatHistory`'s `ready` flips, and on a server sandbox
 * provider that wait is real: waking a hibernated VM plus re-scanning the project measured ~20s of
 * blank page with only the header visible. These phases give that window a face. Writers are the
 * mount path in `useChatHistory` (which owns the awaits) — this module is a leaf on purpose, so the
 * sandbox seam and the stores can both reach it without a cycle.
 *
 * The phases are coarse by design: they mark the AWAITS the mount serializes behind, not every step
 * inside them. `idle` doubles as "no mount in progress" and is what the store must return to when a
 * mount ends, however it ends — a stale phase on the next open would report progress for work that
 * is not happening.
 */
import { atom } from 'nanostores';

export type BootPhase =
  | { step: 'idle' }

  /** Waiting on the sandbox runtime — VM create/resume + the browser connecting to it. */
  | { step: 'sandbox' }

  /** Reading or restoring the project's files; counts appear once the scan knows its total. */
  | { step: 'files'; done?: number; total?: number }

  /** Post-mount readiness: dependency check / dev-server start. */
  | { step: 'prepare' }

  /*
   * ---- CREATION phases (New Project, `create-project.ts` + `startProject`) ----
   * The same silence, one page earlier: creating a project serializes behind the starter download,
   * the sandbox boot (a VM fork on a server provider), the template mount and the visibility wait,
   * and all the user saw was the three-dot spinner. Writers: `createProjectFromRegistry` sets the
   * first three as it reaches them; the caller (`startProject`) owns `creating-finalize` and the
   * reset to `idle` on EVERY exit — success, fatal, or degraded.
   */

  /** Downloading the starter template from our server. */
  | { step: 'creating-starter' }

  /** Booting the sandbox and clearing anything inherited from a previous session. */
  | { step: 'creating-workspace' }

  /** Writing the starter's files into the sandbox. */
  | { step: 'creating-mount' }

  /** Registering the project and waiting for the mounted files to become visible. */
  | { step: 'creating-finalize' }

  /**
   * The files are written and visible; the watcher's tail is still arriving (`settle.ts`).
   *
   * A distinct phase rather than a longer `creating-finalize` because it is the LAST step of job one —
   * creating the project files — and the splash owns exactly that job. The BUILD that follows is a chat
   * event (the liveness panel, `agent-status.ts`), not a splash phase: it belongs in the workbench with
   * every other generation the user will ever run.
   */
  | { step: 'creating-settle' };

export const bootProgress = atom<BootPhase>({ step: 'idle' });

/**
 * Is this phase part of NEW PROJECT creation? Gates the creation splash overlay — the resume phases
 * must never trigger it (they render full-page via `BootScreen`, before the chat exists at all).
 */
export function isCreationPhase(phase: BootPhase): boolean {
  return phase.step.startsWith('creating-');
}

/** The human copy for a phase. Kept here so the component stays a dumb renderer. */
export function bootPhaseCopy(phase: BootPhase): { title: string; detail: string } {
  switch (phase.step) {
    case 'sandbox':
      return {
        title: 'Waking your workspace…',
        detail: 'Starting the project sandbox. After a long sleep this can take up to a minute.',
      };
    case 'files':
      return {
        title: 'Loading project files…',
        detail:
          phase.done !== undefined && phase.total !== undefined
            ? `${phase.done} of ${phase.total} files`
            : 'Reading the project from the workspace.',
      };
    case 'prepare':
      return {
        title: 'Getting the project ready…',
        detail: 'Checking dependencies and the dev server.',
      };
    case 'creating-starter':
      return {
        title: 'Creating your project…',
        detail: 'Downloading the starter template.',
      };
    case 'creating-workspace':
      return {
        title: 'Preparing your workspace…',
        detail: 'Starting the project sandbox. On a fresh workspace this can take a moment.',
      };
    case 'creating-mount':
      return {
        title: 'Writing project files…',
        detail: 'Copying the starter into your workspace.',
      };
    case 'creating-finalize':
      return {
        title: 'Almost ready…',
        detail: 'Registering the project and waiting for it to appear.',
      };
    case 'creating-settle':
      return {
        /*
         * FILES, not "building" — the splash's whole job is creating the project files, and the BUILD is
         * a chat event that belongs in the workbench with every other generation (`agent-status.ts`).
         * Putting build language here made one long wait out of two distinct jobs, and left the user with
         * no idea which one they were watching.
         */
        title: 'Creating project files',
        detail: 'Finishing the starter files and settling your workspace…',
      };
    default:
      return { title: 'Opening project…', detail: 'Fetching the conversation and project record.' };
  }
}
