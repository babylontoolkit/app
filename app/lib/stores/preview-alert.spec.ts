/**
 * A stale preview alert is a FALSE ALARM THAT BILLS: the banner carries an "Ask codewrx.ai" button,
 * so leaving it up beside a healed preview invites the user to spend credits debugging working code
 * (observed live 2026-07-25, after a GitHub sync). But the opposite mistake is worse — clearing a
 * LIVE error shows the user nothing at all — so both directions are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { PREVIEW_RECOVERY_SETTLE_MS, shouldClearStalePreviewAlert } from './preview-alert';
import type { ActionAlert } from '~/types/actions';

const alert = (overrides: Partial<ActionAlert> = {}): ActionAlert => ({
  type: 'preview',
  title: 'Uncaught Exception',
  description: "Uncaught SyntaxError: Unexpected token '<'",
  content: 'stack…',
  source: 'preview',
  raisedAt: 1_000,
  ...overrides,
});

describe('shouldClearStalePreviewAlert', () => {
  it('clears an alert the preview has since loaded past — the reported bug', () => {
    expect(shouldClearStalePreviewAlert(alert({ raisedAt: 1_000 }), 2_000)).toBe(true);
  });

  /*
   * 🔴 The dangerous direction. An error thrown DURING the new document's load fires before that
   * document's `load` event, so its `raisedAt` is later than the previous load completion. If this
   * ever returns true, a genuinely broken preview shows the user nothing.
   */
  it('KEEPS an alert raised after the load completed — a live error, not a stale one', () => {
    expect(shouldClearStalePreviewAlert(alert({ raisedAt: 2_500 }), 2_000)).toBe(false);
  });

  it('keeps an alert raised at exactly the load completion instant', () => {
    expect(shouldClearStalePreviewAlert(alert({ raisedAt: 2_000 }), 2_000)).toBe(false);
  });

  it('never clears a TERMINAL error — a page load is no evidence npm install was fixed', () => {
    expect(shouldClearStalePreviewAlert(alert({ source: 'terminal', raisedAt: 1_000 }), 2_000)).toBe(false);
  });

  it('never clears an alert with no source', () => {
    expect(shouldClearStalePreviewAlert(alert({ source: undefined, raisedAt: 1_000 }), 2_000)).toBe(false);
  });

  /* "We cannot tell whether it is stale" must never resolve to "clear the warning". */
  it('keeps an UNSTAMPED alert rather than guessing it is stale', () => {
    expect(shouldClearStalePreviewAlert(alert({ raisedAt: undefined }), 2_000)).toBe(false);
  });

  it('no alert is not something to clear', () => {
    expect(shouldClearStalePreviewAlert(undefined, 2_000)).toBe(false);
  });

  /*
   * The settle window is a grace period for the ERROR, not the recovery: too long only delays
   * clearing a stale banner, too short would clear a real one. It must comfortably exceed the gap
   * between a document's `load` event and a synchronous module/parse error in that document.
   */
  it('allows a real error time to arrive before a load counts as recovery', () => {
    expect(PREVIEW_RECOVERY_SETTLE_MS).toBeGreaterThanOrEqual(1_000);
  });
});
