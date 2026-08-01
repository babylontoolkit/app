/**
 * "The preview is still loading" — the decision behind the overlay drawn over the preview pane.
 *
 * 🔴 **Scoped to the PREVIEW PANE, deliberately, and this is the interesting part.** The workspace
 * splash (`WorkspaceSplash`) covers the content window while files are being written, and its rule is
 * "whenever the workspace is actually loading files" (`coversWorkspace`). This is a different moment
 * with a different honest answer: creation ends when the dev server binds a port, and a fresh Nodepod
 * pod then spends **~13–15 s on one-time initialization** before it can serve the first module
 * (MEASURED per segment in `spec/sandbox-nodepod.md` §8; ~300 ms for every load after it). During that
 * window the file tree, the editor, the terminal and the chat are all READY AND USABLE, and only the
 * preview is working. Extending the full-page splash over it would be a lie about three panes in
 * order to explain one, and it would take away the workspace at the exact moment the user could start
 * reading their code.
 *
 * So: cover the pane that is actually busy, leave everything else alone.
 *
 * Pure, because all three of the rules below are timing rules and every one of them fails silently in
 * a different direction — a delay too short flashes on every navigation, a ceiling too long hides a
 * dead preview behind a spinner forever, and getting the "first run" branch wrong tells the user the
 * wrong thing about their own project.
 */

/**
 * How long a load may take before it is worth mentioning.
 *
 * 🔴 Not zero, and the number is measured rather than chosen: a WARM first paint is **0.5 s**, so an
 * overlay with no delay would flash on every ordinary load and on every in-preview navigation —
 * exactly the strobing that made the import tail unusable as a boot phase. Past this, the wait is
 * long enough that silence is the worse option.
 */
export const PREVIEW_BUSY_DELAY_MS = 800;

/**
 * When a slow load earns an EXPLANATION rather than just a spinner.
 *
 * A spinner says "wait" and nothing else, which is fine for a second or two and unsettling at ten.
 * Past this, the wait is long enough that the user deserves to know what is being waited ON — a
 * workspace being prepared, rather than a page that might be stuck.
 */
export const PREVIEW_BUSY_EXPLAIN_MS = 4_000;

/**
 * Stop covering, whatever happens.
 *
 * 🔴 An overlay whose only exit is a `load` event that may never fire is a permanent cover over a
 * broken preview — the same failure `coversWorkspace` avoids by refusing to cover the `failed` phase.
 * A preview that has not loaded in two minutes has a problem the user needs to SEE (the error
 * overlay, the blank page, the dev-server output), not a spinner sitting on top of it.
 */
export const PREVIEW_BUSY_CEILING_MS = 120_000;

/**
 * What the pane should be showing.
 *
 * - `hidden` — no load in flight, too early to mention, or past the ceiling.
 * - `loading` — a load is taking a noticeable amount of time.
 * - `first-run` — …and it is the first of this session, i.e. the one paying the pod's one-time setup.
 */
export type PreviewBusyState = 'hidden' | 'loading' | 'first-run';

export interface PreviewBusyInput {
  /** Is a document load in flight at all? */
  loading: boolean;

  /** How long it has been in flight. */
  elapsedMs: number;

  /** Has any preview document finished loading in this session yet? */
  everLoaded: boolean;
}

export function previewBusyState({ loading, elapsedMs, everLoaded }: PreviewBusyInput): PreviewBusyState {
  if (!loading || elapsedMs < PREVIEW_BUSY_DELAY_MS || elapsedMs >= PREVIEW_BUSY_CEILING_MS) {
    return 'hidden';
  }

  /*
   * The explanation is gated on BOTH "slow" and "first". A later navigation that happens to be slow is
   * not paying the pod's one-time setup — something else is wrong — so calling it "preparing your
   * workspace" would be a confident wrong answer at the one moment the user is reading the screen.
   */
  return !everLoaded && elapsedMs >= PREVIEW_BUSY_EXPLAIN_MS ? 'first-run' : 'loading';
}

/**
 * Seconds added to the displayed count so it never reads BEHIND the wait the user is living through.
 *
 * `elapsedMs` is measured from the moment the iframe load starts, which is not the moment the user
 * started waiting — the pane was already mounted and the pod already booting before that. The clock is
 * therefore structurally a slight under-report, and rounding compounds it at the low end: the overlay
 * appears at `PREVIEW_BUSY_DELAY_MS` (800 ms) and would otherwise open on `1s` having in truth been
 * waiting a touch longer.
 *
 * ⚠️ Erring HIGH is the safe direction here and erring low is not, which is why this is a constant
 * rather than a wash. A clock that reads low makes the finish look like a jump ("it said 14s and then
 * it was just done"), and it quietly teaches the wrong number to a user who is timing the product with
 * their own patience. One second over-report costs nothing and keeps the count on the honest side of
 * the wait.
 */
export const PREVIEW_BUSY_CLOCK_PADDING_SECONDS = 1;

/**
 * Counts that are never shown — the clock steps straight past them to the next second.
 *
 * Owner's call, and a superstition rather than a measurement, which is exactly why it is a named
 * constant with this comment attached: someone will find `13` in a timing module and reasonably
 * assume it encodes a threshold. It does not. A cold pod lands in the 13–15 s band often enough that
 * the count would sometimes come to rest on thirteen, and a number that is never DISPLAYED can never
 * be the number it finishes on.
 *
 * Safe because skipping only ever moves the count UP, so both properties the clock actually owes the
 * user survive: it stays monotonic, and it still never reads behind the true elapsed time. The one
 * visible consequence is that the second after a skipped value sits on screen for two seconds instead
 * of one — a barely-perceptible dwell, and the honest price of the rule.
 */
export const PREVIEW_BUSY_SKIPPED_SECONDS: readonly number[] = [13];

/**
 * Seconds to show beside the detail line, or `undefined` when nothing is on screen to show it
 * beside.
 *
 * 🔴 **The clock runs on EVERY visible state, with no threshold of its own — it belongs to the
 * OVERLAY, not to a state.** `elapsedMs` is measured from the start of the load, and `loading` →
 * `first-run` is a change of WORDS about one continuous wait, not a new wait. Gating the clock on
 * `first-run` therefore did not delay the clock, it delayed the *first sight* of it: the panel sat
 * silent for four seconds and then opened at `· 4s`, which reads as a skip — the one thing a counter
 * must never do, since a number that jumps is evidence something was missed rather than reassurance
 * that progress is being made.
 *
 * So it starts at `· 1s` when the overlay appears and counts unbroken through the handover. The
 * threshold that already exists (`PREVIEW_BUSY_DELAY_MS`) is the only gate needed: below it there is
 * no panel to hang a number on, and above it the count is exactly as old as the thing it is counting.
 *
 * `Math.round`, matching `BootScreen.tsx` — the two clocks must not disagree about what "11s" means
 * when a user sees one after the other during a single project open.
 */
export function previewBusyElapsedSeconds(state: PreviewBusyState, elapsedMs: number): number | undefined {
  if (state === 'hidden') {
    return undefined;
  }

  let seconds = Math.round(elapsedMs / 1000) + PREVIEW_BUSY_CLOCK_PADDING_SECONDS;

  // A `while`, not an `if`: two skipped values in a row must not leave one of them on screen.
  while (PREVIEW_BUSY_SKIPPED_SECONDS.includes(seconds)) {
    seconds += 1;
  }

  return seconds;
}

/**
 * The words for a state. Kept beside the rule so the component stays a dumb renderer, exactly as
 * `bootPhaseCopy` is.
 *
 * ⚠️ **NO detail ends in a full stop, and that is deliberate, not an oversight.** The elapsed clock is
 * appended to the end of whichever line is showing (`· 11s`), so a trailing period renders as
 * "sandbox. · 11s". Both visible states get the clock, so both drop the stop. Pinned by
 * `preview-busy.spec.ts`, since "fix the missing full stop" is a one-character change that reads as
 * tidying and would silently deface the one state nobody re-checked.
 */
export function previewBusyCopy(state: PreviewBusyState): { title: string; detail: string } | undefined {
  switch (state) {
    case 'loading':
      return { title: 'Loading your project…', detail: 'The dev server is starting your project' };

    case 'first-run':
      return {
        /*
         * 🔴 Says what the wait BUYS, not that we are sorry about it — and every word is literally
         * true (`spec/sandbox-nodepod.md` §9).
         *
         * The ~13–15 s here is Nodepod standing up a real Node.js runtime in the browser, and it was
         * profiled to its mechanism and then accepted on the merits: a local sandbox costs $0 per
         * project and meters nothing, against StackBlitz's ~$10k per 8k WebContainer boots. That is the
         * single best thing about how this product runs, and this overlay is the one moment a user is
         * looking straight at it. "Your project runs entirely on your machine" is the reason the wait
         * exists, so it is the honest thing to put here — it explains rather than excuses.
         *
         * ⚠️ Two things it must keep NOT doing, both learned the expensive way:
         *  - **no speed promise about later loads.** They are ~300 ms and arrive with no overlay at
         *    all, so the user gets the evidence unprompted; a number in copy ages the moment it moves.
         *  - **no mechanism claim we have not measured.** This previously read "the dev server is
         *    optimizing dependencies", which §8 measured as FALSE (dep optimization is ~2.6 s of it).
         *    It survived review because it was plausible. Plausible is not measured.
         */
        title: 'Preparing your workspace…',
        detail: 'Initializing your local project sandbox',
      };

    default:
      return undefined;
  }
}
