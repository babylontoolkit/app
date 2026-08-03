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
   * your copy" through "Waking your workspace" instead of a spinner that blinks out and restarts.
   * The mount path's own phases overwrite it; its `finally` still resets to idle on every exit.
   */
  | { step: 'remixing' }

  /** Waiting on the sandbox runtime — VM create/resume + the browser connecting to it. */
  | { step: 'sandbox' }

  /** Reading or restoring the project's files; counts appear once the scan knows its total. */
  | { step: 'files'; done?: number; total?: number }

  /** Post-mount readiness: dependency check / dev-server start. */
  | { step: 'prepare' }

  /**
   * The mount's own file work is done and the WATCHER's tail is still arriving (`settle.ts`).
   *
   * The resume-path twin of `creating-settle`, and it exists for the same measured reason one door
   * over: a mount that resolves is not a workspace that has finished filling. Several branches never
   * write the map at all (no local checkpoint, no working copy, no seed), so the watcher is its only
   * writer — and the boot surface used to come down the moment the mount promise settled, leaving the
   * user watching the file tree assemble itself a file at a time. Everything the splash exists to hide.
   */
  | { step: 'settling' }

  /**
   * A folder or repository IMPORT landing in the workspace.
   *
   * 🔴 An overlay phase, not a full-page one, and the only non-`creating-` member of that family — so
   * {@link coversWorkspace} is an explicit membership test rather than the name-prefix test it used to
   * be. Import is the one door where the files cannot arrive before the chat renders: they come in as
   * `<boltAction type="file">` entries replayed by the message parser, which only runs once the chat is
   * mounted. Holding `ready` would deadlock it (no chat → no replay → no files), so the wait is drawn
   * OVER the workbench instead of in front of it.
   */
  | { step: 'importing' }

  /**
   * Reading a repository from GitHub/GitLab, server-side (§4.13, `git/clone.ts`).
   *
   * The network half of an import, and the reason it needs a phase of its own rather than borrowing
   * `importing`: it is the part where nothing is happening in the workspace yet. The server is
   * resolving the coordinate, resolving the caller's token, asking for the default branch and pulling
   * the tree — seconds of real waiting with no file to show for it — and the step that follows
   * (`files`, driven by `restoreFiles`' `onProgress`) narrates the writing. Collapsing the two into one
   * opaque step is exactly what `creating-starter` → `creating-mount` exists not to do.
   *
   * 🔴 An OVERLAY phase, like `importing`, and for a different reason from `importing`'s: a clone is
   * started from the landing page by a user who already has a workspace on screen, so `ready` is
   * already true and there is no full-page `BootScreen` to render into. The cover comes from
   * `WorkspaceSplash`, which {@link coversWorkspace} grants to every phase that is not `idle` or
   * `failed` — so this phase needs no gate of its own, which is the whole point of that rewrite.
   *
   * ⚠️ The name must NOT begin with `creating-`: that prefix is the `isCreationPhase` family test, and
   * an import is emphatically not a New Project (no §4.4b scaffolding, no creation handoff card).
   */
  | { step: 'cloning' }

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
 * "An import's files are still landing" — a SEPARATE atom, not a phase, and that is the whole point.
 *
 * 🔴 Found live (2026-07-31): the import tail was written as a phase, and it flickered. `bootProgress`
 * is a single slot owned by whatever is currently narrating, and an import outlives the mounts running
 * beside it — several components call `useChatHistory`, so several mounts run per page load, each one
 * setting its own phases and then clearing to `idle`. The tail and the mounts overwrote each other
 * every few hundred milliseconds and the overlay strobed. Re-asserting the phase on a timer made it
 * strobe more slowly, which is not a fix; it is the same race with a longer period.
 *
 * A flag beside the phase removes the contention instead of arbitrating it. Nothing else writes it,
 * the mount narrates its own steps unmolested, and {@link effectiveBootPhase} composes the two into
 * the one thing the surface should show.
 */
export const importTailActive = atom<boolean>(false);

/**
 * What to DRAW, given the current phase and whether an import is still landing.
 *
 * Precedence, most specific first: a real phase always wins (a mount running underneath an import has
 * more to say than "importing" does — including a FAILURE, which outranks everything), and `importing`
 * fills the silence when the phase has gone back to `idle` while the import's files are still arriving.
 * Pure, so the rule is testable without a store, a timer or a render.
 */
export function effectiveBootPhase(phase: BootPhase, importActive: boolean): BootPhase {
  return importActive && phase.step === 'idle' ? { step: 'importing' } : phase;
}

/**
 * Is this phase part of NEW PROJECT creation?
 *
 * Kept as its own question (it names a family, and the family rule is readable off the phase names),
 * but it is NO LONGER the gate on the overlay — see {@link coversWorkspace}.
 */
export function isCreationPhase(phase: BootPhase): boolean {
  return phase.step.startsWith('creating-');
}

/**
 * Does this phase mean "files are going into the workspace right now"?
 *
 * 🔴 EVERY working phase, not a chosen subset — the owner's rule, verbatim: *"whenever the workspace is
 * actually loading files into the project workspace should be the splash screen."* It began as a
 * `creating-` name prefix (right while creation was the only door), then an explicit membership list
 * (right while creation and import were the only two), and each version was a list of the doors somebody
 * had thought of. The third door found it out: a mount that runs AFTER the chat has rendered — the mount
 * effect fires more than once per load, and a duplicate re-scan repopulates the file map behind a
 * workbench the user is already looking at. Measured live 2026-07-31: the tree filled to "35 of 86 files"
 * in full view, narrated by a phase this predicate answered FALSE for, because `files` had been filed as
 * a resume phase and resume phases were assumed to happen before anything was on screen.
 *
 * There is no subset to get right. If a phase is running, files are moving, and the answer is yes.
 *
 * The two EXCEPTIONS are the two states where nothing is arriving: `idle` (nothing is happening) and
 * `failed` (nothing more will) — and a failure must uncover, because a spinner over a dead workspace
 * hides the one sentence the user needs.
 *
 * This does not double-render with the full-page `BootScreen`: they live in mutually exclusive branches
 * of `Chat` (`ready ? … : …`), so exactly one of them exists for any given phase.
 */
export function coversWorkspace(phase: BootPhase): boolean {
  return phase.step !== 'idle' && phase.step !== 'failed';
}

/**
 * The actual gate on `WorkspaceSplash`, phase AND import flag together.
 *
 * 🔴 An active import keeps the workspace covered WHATEVER the phase says — including `idle`, which is
 * the whole reason the flag exists: the import's files are replayed by the message parser, long after
 * every mount has finished and reset the phase, so there is no phase to read at exactly the moment the
 * files are landing.
 *
 * A FAILURE is the one thing that takes the cover down, because at that point there is nothing left
 * arriving and the user needs the failure surface rather than a spinner over a dead workspace.
 */
export function shouldCoverWorkspace(phase: BootPhase, importActive: boolean): boolean {
  if (phase.step === 'failed') {
    return false;
  }

  return importActive || coversWorkspace(phase);
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
        title: 'Making your copy',
        detail: 'Cloning this game into your account.',
      };
    case 'sandbox':
      return {
        title: 'Waking your workspace',
        detail: 'Starting project sandbox. This can take a moment.',
      };
    case 'files':
      return {
        title: 'Loading project files',
        detail:
          phase.done !== undefined && phase.total !== undefined
            ? `${phase.done} of ${phase.total} files`
            : 'Reading the project from the workspace.',
      };
    case 'prepare':
      return {
        title: 'Getting the project ready',
        detail: 'Checking dependencies and the dev server.',
      };
    case 'settling':
      return {
        /*
         * Phrased as the TAIL of the step the user was already watching, not as a new one. Nothing new
         * is beginning here — the last of the same files is arriving — so "Finishing" rather than a
         * heading that reads like another job starting.
         */
        title: 'Reading project workspace files',
        detail: 'Reading files as they arrive in your workspace.',
      };
    case 'importing':
      return {
        title: 'Importing your project workspace',
        detail: 'Writing the imported files into your workspace.',
      };
    case 'cloning':
      return {
        /*
         * The REPOSITORY is the subject, because that is what the user just named and what they are
         * waiting on. "Importing your project" would be true of the next two phases as well, and a
         * heading that is true of three consecutive steps tells the user nothing about which one they
         * are watching — the failure `creating-settle`'s copy was written to avoid.
         */
        title: 'Reading your repository',
        detail: 'Fetching the files from your repository. This can take a moment.',
      };
    case 'creating-starter':
      return {
        title: 'Creating your project workspace',
        detail: 'Downloading the starter game template.',
      };
    case 'creating-workspace':
      return {
        title: 'Preparing your project workspace',
        detail: 'Starting project sandbox. This can take a moment.',
      };
    case 'creating-mount':
      return {
        title: 'Writing project workspace files',
        detail: 'Copying the starter into your workspace.',
      };
    case 'creating-finalize':
      return {
        title: 'Your workspace is almost ready',
        detail: 'Registering project and waiting for it to appear.',
      };
    case 'creating-settle':
      return {
        /*
         * FILES, not "building" — the splash's whole job is creating the project files, and the BUILD is
         * a chat event that belongs in the workbench with every other generation (`agent-status.ts`).
         * Putting build language here made one long wait out of two distinct jobs, and left the user with
         * no idea which one they were watching.
         */
        title: 'Creating project workspace files',
        detail: 'Finishing starter files and settling your workspace',
      };
    case 'creating-install':
      return {
        title: 'Installing project dependencies',
        detail: 'Running install on your project. This can take a moment.',
      };
    case 'creating-serve':
      return {
        /*
         * "Starting", not "Almost ready" — this is the last thing that happens before the user is looking
         * at their own running project, and naming it is what makes the preview appearing feel like the
         * end of a sequence rather than something that eventually showed up.
         */
        title: 'Starting your project workspace',
        detail: 'Launching the dev server and loading the starter home page.',
      };
    default:
      return { title: 'Opening project', detail: 'Fetching the conversation and project record.' };
  }
}
