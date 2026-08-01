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
 * 🔴 **There is exactly ONE visible state, and that is a fix rather than a simplification.** It used to
 * have two — a plain `loading` and a `first-run` that explained the cold wait — chosen from an
 * `everLoaded` flag. Once the cover started outliving the iframe's `load` event (`shouldRevealPreview`)
 * that flag flipped to true while the overlay was STILL UP, so the user watched the panel go
 * *Loading… → Preparing… → Loading…* mid-wait. Two states describing one continuous wait can always
 * disagree about which one they are in; one state cannot. The elapsed clock carries what the second
 * state was for, and carries it better, because it is a live number rather than a threshold guess.
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
 * - `loading` — a load is taking long enough to be worth covering. There is no second visible state;
 *   see the header for why the `first-run` branch was removed rather than fixed.
 */
export type PreviewBusyState = 'hidden' | 'loading';

export interface PreviewBusyInput {
  /** Is a document load in flight at all? */
  loading: boolean;

  /** How long it has been in flight. */
  elapsedMs: number;
}

export function previewBusyState({ loading, elapsedMs }: PreviewBusyInput): PreviewBusyState {
  const worthMentioning = loading && elapsedMs >= PREVIEW_BUSY_DELAY_MS && elapsedMs < PREVIEW_BUSY_CEILING_MS;

  return worthMentioning ? 'loading' : 'hidden';
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

  return {
    title: 'Loading your project…',

    /*
     * Names the actual work without promising anything unmeasured. An earlier version claimed the
     * dev server was "optimizing dependencies", which §8 measured as FALSE — that is ~2.6 s of a ~15 s
     * one-time pod init — and it survived review precisely because it was plausible.
     */
    detail: 'Preparing a cold workspace',
  };
}
