/**
 * What the user is told to expect of a turn (`delivery.ts`).
 *
 * The facts here drive a sentence that tells someone to sit and watch nothing happen for minutes. It
 * is the right sentence on a provider measured to buffer, and a destructive one anywhere else — so
 * the defaults, not just the happy path, are what these pin.
 */
import { describe, expect, it } from 'vitest';
import { deliveryModeFor, providerDeliveryMode, typicalDurationMs } from './delivery';
import type { AgentStatusKind } from './heartbeat';
import { PLATFORM_PROVIDERS } from './config';
import { MODEL_FAMILIES, familyOf, type ModelFamily } from '~/lib/modules/llm/model-families';

/**
 * One real model id per family — the ids the tier ladder actually points at (§4.6.1a), asserted to be
 * the family they claim so a renamed prefix cannot quietly make this table test nothing.
 */
const MODEL_BY_FAMILY: Record<ModelFamily, string> = {
  claude: 'claude-opus-5',
  codex: 'gpt-5-6-sol',
  gemini: 'gemini-3-5-flash',
  chat: 'grok-4.5',
};

describe('deliveryModeFor', () => {
  it('every sample id really is the family it stands for', () => {
    for (const family of MODEL_FAMILIES) {
      expect(familyOf(MODEL_BY_FAMILY[family])).toBe(family);
    }
  });

  it('reports Anthropic as streaming for EVERY family — the control in KIE_BUG_REPORT.md', () => {
    for (const family of MODEL_FAMILIES) {
      expect(deliveryModeFor('Anthropic', MODEL_BY_FAMILY[family])).toBe('streamed');
    }
  });

  it('reports KIE + claude as batched — measured 3/3 request shapes, 2026-08-03', () => {
    /*
     * `scripts/stream-probe.mjs`: 26,539 chars delivered 100% in the final second after 130s of
     * silence, and identically with thinking disabled and with no thinking fields at all. Thinking is
     * not the lever — the buffering is in KIE's Claude ADAPTER, which is why the key is (provider, family).
     */
    expect(deliveryModeFor('KIE', 'claude-opus-5')).toBe('batched');
  });

  it('reports KIE + codex as streaming — measured 2026-08-04, first delta at 3.7s', () => {
    expect(deliveryModeFor('KIE', 'gpt-5-6-sol')).toBe('streamed');
  });

  it('reports KIE + gemini as streaming (provisional — big-answer probe owed, T11)', () => {
    expect(deliveryModeFor('KIE', 'gemini-3-5-flash')).toBe('streamed');
  });

  /*
   * ⚠️ NOT A SUPPORTED PATH. `kie.ts` refuses the `chat` family at model resolution — KIE fronts no
   * Grok/Kimi/Qwen/GLM/DeepSeek/MiniMax id — so nothing in production can read this entry; it exists
   * only so the exhaustive `Record<ModelFamily, DeliveryMode>` compiles. This is pinned as `streamed`
   * because that is the standing default for an unmeasured surface (the note below), NOT because
   * anyone measured KIE serving a chat model. If KIE ever does front one, MEASURE it with
   * `scripts/stream-probe.mjs` before believing this value.
   */
  it('reports KIE + chat as streaming — the unmeasured default on an UNREACHABLE pair', () => {
    expect(deliveryModeFor('KIE', 'grok-4.5')).toBe('streamed');
  });

  /*
   * 🔴 Both unknowns resolve to `streamed`, and for the same reason: `batched` renders a sentence
   * telling the user to expect NOTHING for minutes. Saying that about a surface nobody has probed
   * manufactures the despair this module exists to prevent, and it is unfalsifiable from their side of
   * the screen. Claim the quieter thing when we do not know.
   */
  it('assumes an UNMEASURED provider streams', () => {
    expect(deliveryModeFor('Bedrock' as never, 'claude-opus-5')).toBe('streamed');
  });

  it('assumes an unknown, undefined or empty MODEL streams', () => {
    expect(deliveryModeFor('KIE', 'llama-4-maverick')).toBe('streamed');
    expect(deliveryModeFor('KIE', undefined)).toBe('streamed');
    expect(deliveryModeFor('KIE', '')).toBe('streamed');
  });

  /*
   * The batch sentence (`agent-status.ts` `deliveryNote`, gated on `deliveryMode === 'batched'`) is
   * reachable on EXACTLY ONE surface. Iterated over the DECLARED UNIONS rather than a hand-written
   * list: a test written against the same enumeration a bug lives in cannot see what the enumeration
   * missed, and a family added to `MODEL_FAMILIES` must not inherit the batch claim by omission.
   */
  it('yields batched for KIE + claude and for no other (provider, family) pair', () => {
    const batched: string[] = [];

    for (const provider of PLATFORM_PROVIDERS) {
      for (const family of MODEL_FAMILIES) {
        if (deliveryModeFor(provider, MODEL_BY_FAMILY[family]) === 'batched') {
          batched.push(`${provider}/${family}`);
        }
      }
    }

    expect(batched).toEqual(['KIE/claude']);
  });
});

describe('providerDeliveryMode (deprecated delegate)', () => {
  it('never claims batched for a provider whose families differ', () => {
    /*
     * KIE fronts three adapters and only one of them buffers, so the provider-wide answer must be the
     * safe one — a stray caller can never be told to expect silence on a surface that streams.
     */
    expect(providerDeliveryMode('KIE')).toBe('streamed');
  });

  it('reports Anthropic as streaming', () => {
    expect(providerDeliveryMode('Anthropic')).toBe('streamed');
  });

  it('assumes an UNMEASURED provider streams', () => {
    expect(providerDeliveryMode('Bedrock' as never)).toBe('streamed');
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
