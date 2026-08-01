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
 * Counts the overlay will not FINISH on. It still passes through them while counting.
 *
 * Owner's call. A cold pod is a ~13–15 s job (`spec/sandbox-nodepod.md` §8) and the preferred story is
 * the round one — *"about fifteen seconds to cold-start a workspace"* — so a run that would have come
 * to rest at 13 or 14 is held the extra beat and finishes on 15. It over-reports by up to two seconds
 * on the runs that land in the range, which is the direction this whole clock already errs in
 * (`PREVIEW_BUSY_CLOCK_PADDING_SECONDS`), and it is the owner's stated preference over the alternative.
 *
 * ⚠️ It is a RANGE, and treating it as one is load-bearing — see the loop in `previewBusyLingerMs`.
 * ⚠️ It is not a threshold, despite being a bare number in a timing module. Nothing branches on it.
 *
 * ⚠️ **The distinction between "never shown" and "never landed on" is the whole design.** The first
 * version of this never DISPLAYED 13, which forces a visible 12 → 14 jump on every single cold load —
 * the clock reads as broken rather than tidy, and that is strictly worse than the thing it avoided.
 * Passing through 13 normally and only refusing to STOP there costs nothing on the loads that do not
 * land on it, which is nearly all of them. Do not "simplify" this back into a skip list.
 */
export const PREVIEW_BUSY_NEVER_END_ON: readonly number[] = [13, 14];

/**
 * Slack added to the linger below so the ticked-over value is actually PAINTED.
 *
 * The clock re-renders on a 250 ms interval, so hiding at the exact boundary would race it and the new
 * number might never reach the screen — leaving the count resting on the value the linger exists to
 * avoid, intermittently, which is the worst of both outcomes.
 */
export const PREVIEW_BUSY_LINGER_MARGIN_MS = 300;

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
  return state === 'hidden' ? undefined : Math.round(elapsedMs / 1000) + PREVIEW_BUSY_CLOCK_PADDING_SECONDS;
}

/**
 * How long to hold the overlay open after the load has actually finished, so the count does not come
 * to REST on a `PREVIEW_BUSY_NEVER_END_ON` value.
 *
 * 🔴 **This is consulted ONLY at the moment the load completes, and it constrains only the ENDING.**
 * While counting, every second is real and shown as-is — 13 and 14 included — and a load that
 * genuinely runs past the range keeps reporting the truth (16, 17, 20…). The single question here is
 * "may the count come to rest on the number currently displayed?", so nothing about the ordinary
 * ticking, the copy, or a long wait is touched by it.
 *
 * Returns `0` — the overwhelmingly common case — unless that number is one we will not end on. Then it
 * returns the time until the display reaches an acceptable value, plus the paint margin: at most a
 * little over the width of the range, and usually a few hundred milliseconds.
 *
 * ⚠️ This deliberately makes the overlay outlive its own load, which is normally a defect — an overlay
 * that lingers is how a "temporary" cover becomes permanent. It is safe only because it is bounded by
 * construction (sub-second, derived from the next tick rather than a chosen constant) and because the
 * caller still owns the ceiling. Never let it grow into a general-purpose delay.
 */
export function previewBusyLingerMs(elapsedMs: number): number {
  const shown = previewBusyElapsedSeconds('loading', elapsedMs);

  if (shown === undefined || !PREVIEW_BUSY_NEVER_END_ON.includes(shown)) {
    return 0;
  }

  /*
   * The display rounds, so it advances as elapsed crosses each `n + 0.5` seconds — NOT on the whole
   * second. Deriving the wait from that boundary rather than assuming a flat 1000 ms is what keeps the
   * extra dwell as short as it can be while still guaranteeing the tick actually happens.
   */
  let landsAt = (Math.round(elapsedMs / 1000) + 0.5) * 1000;

  /*
   * 🔴 The values are a RANGE, so the FIRST boundary is not necessarily far enough: a load finishing
   * on 13 ticks over to 14, which is also a value we will not end on. Stopping there would satisfy the
   * letter of the rule and break it for every load that finishes at the bottom of the range.
   *
   * ⚠️ At the current width a single extra step would do, so `while` vs `if` is not observable today —
   * it is written as a loop because the list is configuration and a third value would silently make an
   * `if` wrong. Terminates: the list is finite and the count only ever goes up.
   */
  while (PREVIEW_BUSY_NEVER_END_ON.includes(previewBusyElapsedSeconds('loading', landsAt)!)) {
    landsAt += 1_000;
  }

  return landsAt - elapsedMs + PREVIEW_BUSY_LINGER_MARGIN_MS;
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
