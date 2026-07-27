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
  | { step: 'prepare' };

export const bootProgress = atom<BootPhase>({ step: 'idle' });

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
    default:
      return { title: 'Opening project…', detail: 'Fetching the conversation and project record.' };
  }
}
