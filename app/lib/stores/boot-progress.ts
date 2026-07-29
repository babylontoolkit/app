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

  /*
   * The `/remix/:shareId` clone, BEFORE the builder exists. Set by the remix route while `/api/remix`
   * runs and deliberately left standing across its `navigate('/')` — the atom is module-level, so the
   * builder's `BootScreen` picks up mid-phrase and the user sees ONE continuous surface from "Making
   * your copy…" through "Waking your workspace…" instead of a spinner that blinks out and restarts.
   * The mount path's own phases overwrite it; its `finally` still resets to idle on every exit.
   */
  | { step: 'remixing' }

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
  | { step: 'creating-settle' }

  /*
   * ---- and the last two, because a project that is not RUNNING is not created ----
   *
   * The owner's success condition for New Project is *"npm install + npm run dev and showing the starter
   * app template basic home page"*. Creation used to dismiss the splash the moment the files settled and
   * fire the game build over the top, so `npm install` ran in a terminal nobody was looking at. With the
   * build gone, these two steps ARE the end of creation and they get the splash's last two sentences.
   *
   * Both waits are bounded and degrade silently (`starter-ready.ts`): reaching a ceiling dismisses the
   * splash on a project that exists and keeps installing in the background — a slow install must never
   * hang the New Project button (§1.3 principle 0).
   */

  /** Running the starter's `npm install`. The long one on a cold WebContainer; ~2s on a forked VM. */
  | { step: 'creating-install' }

  /** Install is done; waiting for the dev server to bind a port so there is a home page to show. */
  | { step: 'creating-serve' }

  /**
   * The open FAILED and there is nothing to look at.
   *
   * 🔴 A terminal phase, and the only one that must survive the mount path's `finally`. A sandbox that
   * will not start used to end as a `logger.warn` and a `setReady(true)`: the boot screen came down,
   * the workbench rendered empty, and the user was left with a broken page and no sentence explaining
   * it. Worse, on the previous eager-boot design the failure was cached in a module-level promise, so
   * the server's deliberately-retryable 503 was terminal in the client and a full page reload was the
   * only cure. Both halves are fixed together: the boot is retryable (`bootForProject`) and this phase
   * is what offers the retry.
   */
  | { step: 'failed'; message: string; retryable: boolean };

export const bootProgress = atom<BootPhase>({ step: 'idle' });

/**
 * What the failure surface's "Try again" button runs.
 *
 * Held beside the phase rather than inside it so {@link BootPhase} stays plain data (it is compared,
 * logged and rendered), and registered by whoever owns the attempt — the mount path — because only it
 * knows what "again" means. Absent means the failure is real but unretryable from here.
 */
export const bootRetry = atom<(() => void) | undefined>(undefined);

/** Enter the failed phase, with the action that would retry it. */
export function reportBootFailure(failure: { message: string; retryable: boolean }, retry?: () => void): void {
  bootRetry.set(failure.retryable ? retry : undefined);
  bootProgress.set({ step: 'failed', message: failure.message, retryable: failure.retryable });
}

/**
 * Clear the phase unless it is a FAILURE.
 *
 * The mount path resets to `idle` however it ends — a stale phase would narrate work that is not
 * happening on the next open. But a failure is not a leftover, it is the outcome, and resetting it
 * would erase the only explanation the user gets a fraction of a second after it appeared.
 */
export function endBootPhase(): void {
  if (bootProgress.get().step !== 'failed') {
    bootProgress.set({ step: 'idle' });
  }
}

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
    case 'failed':
      return {
        title: 'Your workspace could not be opened',

        /*
         * The server's own words. "Sandbox provider is not configured", "Too many sandboxes started
         * on this account", "Could not reach the sandbox provider" — each names a different action,
         * and a generic "something went wrong" throws all of that away at the one moment it matters.
         */
        detail: phase.message,
      };
    case 'remixing':
      return {
        title: 'Making your copy…',
        detail: 'Cloning this game into your account.',
      };
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
    case 'creating-install':
      return {
        title: 'Installing dependencies…',
        detail: 'Running npm install in your project. The first one takes the longest.',
      };
    case 'creating-serve':
      return {
        /*
         * "Starting", not "Almost ready" — this is the last thing that happens before the user is looking
         * at their own running project, and naming it is what makes the preview appearing feel like the
         * end of a sequence rather than something that eventually showed up.
         */
        title: 'Starting your project…',
        detail: 'Launching the dev server and loading the starter home page.',
      };
    default:
      return { title: 'Opening project…', detail: 'Fetching the conversation and project record.' };
  }
}
