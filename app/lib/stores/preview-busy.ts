/**
 * "The preview is still loading" — the decision behind the overlay drawn over the preview pane.
 *
 * 🔴 **Scoped to the PREVIEW PANE, deliberately, and this is the interesting part.** The workspace
 * splash (`WorkspaceSplash`) covers the content window while files are being written, and its rule is
 * "whenever the workspace is actually loading files" (`coversWorkspace`). This is a different moment
 * with a different honest answer: creation ends when the dev server binds a port, and on a fresh
 * Nodepod pod Vite then spends up to ~17 s optimizing dependencies before it can serve the first
 * module (MEASURED: 17.1 s cold, 0.5 s warm — `spec/sandbox-nodepod.md`). During that window the file
 * tree, the editor, the terminal and the chat are all READY AND USABLE, and only the preview is
 * working. Extending the full-page splash over it would be a lie about three panes in order to
 * explain one, and it would take away the workspace at the exact moment the user could start reading
 * their code.
 *
 * So: cover the pane that is actually busy, leave everything else alone.
 *
 * Pure, because the rules below are timing rules and each fails silently in a different direction — a
 * delay too short flashes on every navigation, and a ceiling too long hides a dead preview behind a
 * spinner forever.
 *
 * 🔴 **The TITLE never changes, and the detail line only ever moves FORWARD.** Both of those are
 * scars. There were once two states with two different titles, chosen from an `everLoaded` flag — and
 * once the cover started outliving the iframe's `load` event (`shouldRevealPreview`), that flag
 * flipped while the overlay was STILL UP, so the user watched the panel go *Loading… → Preparing… →
 * Loading…* mid-wait.
 *
 * The lesson was not "one state"; it was that the thing selecting the state must only be able to move
 * one way. `elapsedMs` can only increase, so a detail keyed off it can advance and can never revert —
 * the failure above is unreachable by construction rather than by careful ordering. A stable heading
 * plus a progressing sub-line then buys back what the second state was for: a panel that sits on one
 * unchanging sentence for 15+ seconds reads as STUCK, and the spinner cannot argue otherwise because a
 * hung spinner looks exactly the same.
 */

/**
 * How long a load may take before it is worth mentioning.
 *
 * 🔴 Not zero, and the number is measured rather than chosen: a WARM first paint is **~0.5 s**, so an
 * overlay with no delay would flash on every ordinary load and on every in-preview navigation —
 * exactly the strobing that made the import tail unusable as a boot phase. Past this, the wait is
 * long enough that silence is the worse option.
 */
export const PREVIEW_BUSY_DELAY_MS = 800;

/**
 * When the detail line moves on to describing the cold workspace.
 *
 * A single unchanging line for 15+ seconds reads as STUCK — the panel gives the user no evidence that
 * anything is still happening, and the spinner alone is not evidence (a hung spinner looks identical).
 * Moving the detail on once says "this is a longer job than a page load", which is exactly what has
 * just become true.
 *
 * ⚠️ Below this, the wait genuinely might be an ordinary page load, so claiming a cold workspace would
 * be a confident wrong answer at the one moment the user is reading the screen.
 */
export const PREVIEW_BUSY_PREPARING_MS = 5_000;

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
 * How long the page must have had nothing left to fetch before we call it settled.
 *
 * The preview is a React SPA: the iframe's `load` event fires when the DOCUMENT is done, which is
 * before React has rendered anything, so at that instant there are legitimately zero images pending —
 * not because the page is finished, but because it has not started. A short quiet period distinguishes
 * "nothing left to load" from "nothing has been asked for yet".
 */
export const PREVIEW_SETTLE_QUIET_MS = 250;

/**
 * Reveal regardless once this long has passed since the document loaded.
 *
 * 🔴 Load-bearing, and the reason this rule is safe at all. A page with a permanently-broken image, a
 * lazy loader that never settles, or an image the pod cannot serve must NEVER be held behind a
 * spinner — the user has to be able to SEE a broken preview. Same principle as
 * `PREVIEW_BUSY_CEILING_MS`, one layer down: every hold needs an exit that does not depend on the
 * thing being waited for.
 */
export const PREVIEW_SETTLE_CEILING_MS = 4_000;

export interface PreviewSettleInput {
  /** How long since the iframe's `load` event. */
  sinceLoadMs: number;

  /** Images in the preview document that have not finished loading. */
  imagesPending: number;

  /** How long `imagesPending` has been zero AND no new image has appeared. */
  quietForMs: number;

  /** False when the preview document cannot be inspected at all (a cross-origin provider). */
  observable: boolean;
}

/**
 * Whether the busy overlay may come down.
 *
 * 🔴 **This holds the cover until the page is COMPLETE, which is not the same as the linger that was
 * built and reverted.** That one held the overlay after the preview was genuinely READY, purely so a
 * digit would look nicer — it delayed the user's own game for cosmetics, which is never worth it. This
 * one covers a page that is still visibly assembling: measured, the document paints its text ~1.8 s
 * before the logo arrives, because a restored pod snapshot is still streaming files in through the
 * sync-RPC bridge while React is already rendering (`spec/sandbox-nodepod.md`). The overlay's whole
 * job is to cover that, and it was coming down too EARLY.
 *
 * ⚠️ Degrades to the old behaviour — reveal at `load` — whenever the document cannot be inspected. A
 * cross-origin provider (CodeSandbox serves the preview off its own origin) gives us no way to ask
 * what is still loading, and guessing with a blind delay would hold every preview on every provider
 * for a wait that may not exist.
 */
export function shouldRevealPreview({
  sinceLoadMs,
  imagesPending,
  quietForMs,
  observable,
}: PreviewSettleInput): boolean {
  if (!observable || sinceLoadMs >= PREVIEW_SETTLE_CEILING_MS) {
    return true;
  }

  return imagesPending === 0 && quietForMs >= PREVIEW_SETTLE_QUIET_MS;
}

/**
 * What the pane should be showing.
 *
 * - `hidden` — no load in flight, too early to mention, or past the ceiling.
 * - `loading` — a load is taking long enough to be worth covering.
 * - `preparing` — …and it has gone on long enough to be a cold workspace rather than a page load.
 *
 * ⚠️ `loading` → `preparing` is a change of DETAIL LINE under an unchanging title, never a change of
 * heading. See the header: a changing heading mid-wait is the defect this shape exists to avoid.
 */
export type PreviewBusyState = 'hidden' | 'loading' | 'preparing';

export interface PreviewBusyInput {
  /** Is a document load in flight at all? */
  loading: boolean;

  /** How long it has been in flight. */
  elapsedMs: number;
}

export function previewBusyState({ loading, elapsedMs }: PreviewBusyInput): PreviewBusyState {
  if (!loading || elapsedMs < PREVIEW_BUSY_DELAY_MS || elapsedMs >= PREVIEW_BUSY_CEILING_MS) {
    return 'hidden';
  }

  /*
   * Keyed on elapsed time ALONE, which is what makes the progression safe: it can only increase, so
   * the panel can move forward and can never fall back. The predecessor keyed this off `everLoaded`,
   * a flag that flips in both directions, and the user watched the words revert mid-wait.
   */
  return elapsedMs >= PREVIEW_BUSY_PREPARING_MS ? 'preparing' : 'loading';
}

/**
 * Whole seconds elapsed, or `undefined` when there is no panel to show them on.
 *
 * 🔴 **The REAL elapsed time — never padded, rounded up, or nudged off a particular value.** Its
 * stated purpose is to let someone watching a cold start tell that about fifteen seconds have gone by
 * (`spec/sandbox-nodepod.md` §8), and a clock that flatters the wait cannot do that job. Earlier
 * versions padded it by a second and then refused to finish on 13; both were reverted, and the reason
 * they were wrong is the same reason this comment exists — **a gauge that lies is not a gauge.**
 *
 * `Math.round`, matching `BootScreen.tsx`, so the two clocks agree about what "11s" means when a user
 * sees one after the other during a single project open.
 */
export function previewBusyElapsedSeconds(state: PreviewBusyState, elapsedMs: number): number | undefined {
  return state === 'hidden' ? undefined : Math.round(elapsedMs / 1000);
}

/**
 * The words. Kept beside the rule so the component stays a dumb renderer, exactly as `bootPhaseCopy`
 * is.
 *
 * ⚠️ **The detail ends in NO full stop, deliberately.** The elapsed clock is appended to it (`· 11s`),
 * so a trailing period renders as "workspace. · 11s". "Fix the missing full stop" is a one-character
 * change that reads as tidying, hence the test.
 */
export function previewBusyCopy(state: PreviewBusyState): { title: string; detail: string } | undefined {
  if (state === 'hidden') {
    return undefined;
  }

  /*
   * 🔴 ONE title, shared by both states and written once so the two cannot drift apart. A heading that
   * changes while the user is reading it is the defect this whole shape exists to avoid, and two
   * string literals a few lines apart is exactly how that comes back — someone improves one of them.
   */
  const title = 'Loading your project…';

  /*
   * Neither line promises anything unmeasured. An earlier version claimed the dev server was
   * "optimizing dependencies", which `spec/sandbox-nodepod.md` §8 measured as FALSE — that is ~2.6 s
   * of a ~15 s one-time pod init — and it survived review precisely because it was plausible.
   */
  return state === 'preparing'
    ? { title, detail: 'Preparing a cold project workspace' }
    : { title, detail: 'Starting the dev server' };
}
