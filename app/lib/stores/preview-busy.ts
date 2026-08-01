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
 * The words for a state. Kept beside the rule so the component stays a dumb renderer, exactly as
 * `bootPhaseCopy` is.
 */
export function previewBusyCopy(state: PreviewBusyState): { title: string; detail: string } | undefined {
  switch (state) {
    case 'loading':
      return { title: 'Loading your game…', detail: 'Waiting for the dev server to serve the page.' };

    case 'first-run':
      return {
        /*
         * 🔴 Names the WORK, and deliberately promises nothing about later loads.
         *
         * This used to read "First run: the dev server is optimizing dependencies. Later loads are
         * much faster." Both halves were a problem. The first was simply FALSE — §8 of
         * `spec/sandbox-nodepod.md` measured the wait and dep optimization is ~2.6 s of a ~15 s
         * one-time pod initialization; the sentence survived because it was plausible and nobody had
         * measured the segments. The second was an unnecessary promise: later loads really are ~300 ms,
         * but they arrive with no overlay at all, so the user simply experiences them as instant. A
         * speed claim that the product then has to live up to buys nothing when the evidence shows up
         * on its own a minute later — and it ages badly the moment the number moves.
         */
        title: 'Preparing your workspace…',
        detail: 'Starting the dev server and loading your project for the first time.',
      };

    default:
      return undefined;
  }
}
