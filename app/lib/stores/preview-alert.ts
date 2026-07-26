/**
 * When a preview error alert has outlived the failure it describes.
 *
 * ## Why this exists
 *
 * `webcontainer/index.ts` raises an `actionAlert` on every uncaught exception forwarded from the
 * preview iframe, and NOTHING ever cleared it except the user pressing Dismiss. So a TRANSIENT error
 * left a permanent banner sitting next to a working preview — with an "Ask codewrx.ai" button on it.
 *
 * Observed live (2026-07-25): a GitHub sync rewrote the project files; while Vite reloaded, a module
 * request got the SPA fallback `index.html` and the browser threw `Uncaught SyntaxError: Unexpected
 * token '<'` on the leading `<`. The preview recovered on its own seconds later and rendered the game
 * perfectly — and the banner stayed, reading like a live failure. The owner read it as a GitHub token
 * error (the word "token" means a *syntax* token here) and was one click from spending ~300 credits
 * asking the agent to debug healthy code.
 *
 * That is the inverse of a silent failure and it is just as expensive: a **false alarm that bills**.
 * `spec/fail-loud.md` requires a paid action to be offered on a signal that is actually true.
 *
 * ## The rule, and why it is timestamp-based rather than a load counter
 *
 * An alert must not outlive the document it happened in. The tempting implementation — bump a counter
 * on each iframe `load` and clear anything older — is WRONG in the dangerous direction: an error
 * thrown *during* the new document's load fires BEFORE that document's `load` event, so the counter
 * would clear a live error and show the user nothing. Silencing a real failure is far worse than
 * showing a stale one.
 *
 * So we compare timestamps and settle: after a load completes, wait `PREVIEW_RECOVERY_SETTLE_MS` and
 * clear the alert only if it was raised STRICTLY BEFORE that load finished. An error from the new
 * document carries a later `raisedAt` and is therefore kept — a genuinely broken preview re-raises on
 * every reload and the banner never goes away, which is exactly what it is for.
 */
import type { ActionAlert } from '~/types/actions';

/**
 * How long to wait after a preview load completes before treating it as a recovery.
 *
 * Long enough for a synchronous module/parse error in the new document to arrive and re-raise (those
 * land within a few hundred ms of load), short enough that a stale banner does not linger. It is a
 * grace period for the ERROR, not for the recovery: erring long only delays clearing a stale alert,
 * while erring short would clear a real one.
 */
export const PREVIEW_RECOVERY_SETTLE_MS = 1_500;

/**
 * Should this alert be cleared because the preview has since loaded successfully?
 *
 * `loadCompletedAt` is when the iframe finished loading a document. Only preview-sourced alerts are
 * ever cleared this way — a TERMINAL error (a failed `npm install`, a crashed dev server) is not
 * about a page load and a page load is no evidence it was fixed.
 */
export function shouldClearStalePreviewAlert(
  alert: ActionAlert | undefined,
  loadCompletedAt: number,
): alert is ActionAlert {
  if (!alert || alert.source !== 'preview') {
    return false;
  }

  /*
   * An un-stamped alert predates this mechanism (or came from a path that does not stamp). Keep it:
   * without a timestamp we cannot know it is stale, and "we are not sure" must never clear a warning.
   */
  if (typeof alert.raisedAt !== 'number') {
    return false;
  }

  return alert.raisedAt < loadCompletedAt;
}
