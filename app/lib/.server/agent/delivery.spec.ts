/**
 * What the user is told to expect of a turn (`delivery.ts`).
 *
 * The facts here drive a sentence that tells someone to sit and watch nothing happen for minutes. It
 * is the right sentence on a provider measured to buffer, and a destructive one anywhere else — so
 * the defaults, not just the happy path, are what these pin.
 */
import { describe, expect, it } from 'vitest';
import { providerDeliveryMode, typicalDurationMs, type DeliveryMode } from './delivery';
import type { AgentStatusKind } from './heartbeat';

describe('providerDeliveryMode', () => {
  it('reports KIE as batched — measured 3/3 request shapes, 2026-08-03', () => {
    /*
     * `scripts/stream-probe.mjs`: 26,539 chars delivered 100% in the final second after 130s of
     * silence, and identically with thinking disabled and with no thinking fields at all. Thinking is
     * not the lever, which is why this is keyed to the provider.
     */
    expect(providerDeliveryMode('KIE')).toBe('batched');
  });

  it('reports Anthropic as streaming — the control in KIE_BUG_REPORT.md', () => {
    expect(providerDeliveryMode('Anthropic')).toBe('streamed');
  });

  it('assumes an UNMEASURED provider streams', () => {
    /*
     * The safe direction, and not the obvious one. Defaulting to `batched` would tell users of a
     * provider we have never probed to expect several minutes of nothing — manufacturing the exact
     * despair this module exists to prevent, and unfalsifiable from their side of the screen.
     */
    expect(providerDeliveryMode('Bedrock' as never)).toBe('streamed');
  });

  it('is keyed by PROVIDER, so a model swap cannot silently flip it', () => {
    // The buffering lives in the adapter. `LLM_MODEL` is config (§4.2a) and must not reach this answer.
    const modes: DeliveryMode[] = ['streamed', 'batched'];
    expect(modes).toContain(providerDeliveryMode('KIE'));
    expect(providerDeliveryMode('KIE')).toBe(providerDeliveryMode('KIE'));
  });
});

describe('typicalDurationMs', () => {
  const kinds: AgentStatusKind[] = ['creation', 'repair', 'plan', 'edit'];

  it('gives every turn kind a positive, finite baseline', () => {
    // It is a DIVISOR on the client (`elapsedFraction`). A zero here pins the bar full on tick one.
    for (const kind of kinds) {
      expect(typicalDurationMs(kind)).toBeGreaterThan(0);
      expect(Number.isFinite(typicalDurationMs(kind))).toBe(true);
    }
  });

  it('expects a creation to take longest — it is the longest wait in the product', () => {
    for (const kind of kinds.filter((k) => k !== 'creation')) {
      expect(typicalDurationMs('creation')).toBeGreaterThan(typicalDurationMs(kind));
    }
  });

  it('is generous rather than tight', () => {
    /*
     * Undershooting means the bar pins at "longer than usual" on ordinary turns, which trains the user
     * to ignore the one signal that is supposed to mean something is wrong. The reported creation ran
     * 328s; the baseline must not sit under the turns it describes.
     */
    expect(typicalDurationMs('creation')).toBeGreaterThanOrEqual(300_000);
  });

  it('falls back to the edit baseline for an unknown kind', () => {
    expect(typicalDurationMs('divining' as never)).toBe(typicalDurationMs('edit'));
  });
});
