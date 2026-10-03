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

  /*
   * 🔴 Both unknowns resolve to `streamed`, and for the same reason: `batched` renders a sentence
   * telling the user to expect NOTHING for minutes. Saying that about a surface nobody has probed
   * manufactures the despair this module exists to prevent, and it is unfalsifiable from their side of
   * the screen. Claim the quieter thing when we do not know.
   */
  it('assumes an UNMEASURED provider streams', () => {
    expect(deliveryModeFor('Bedrock' as never, 'claude-opus-5')).toBe('streamed');
  });

  /*
   * The KIE/Comet providers are gone (2026-10-03, `_specs/anthropic-only_plan.md`), so a deploy whose
   * stale config or record still names one must get the safe answer, never a batch claim.
   */
  it('assumes a RETIRED provider (KIE, Comet) streams', () => {
    expect(deliveryModeFor('KIE' as never, 'claude-opus-5')).toBe('streamed');
    expect(deliveryModeFor('Comet' as never, 'claude-opus-5')).toBe('streamed');
  });

  it('assumes an unknown, undefined or empty MODEL streams', () => {
    expect(deliveryModeFor('Anthropic', 'llama-4-maverick')).toBe('streamed');
    expect(deliveryModeFor('Anthropic', undefined)).toBe('streamed');
    expect(deliveryModeFor('Anthropic', '')).toBe('streamed');
  });

  /*
   * The batch sentence (`agent-status.ts` `deliveryNote`, gated on `deliveryMode === 'batched'`) was
   * reachable on exactly one surface (KIE + claude) and, with Anthropic the only provider since
   * 2026-10-03, is reachable on NONE. Iterated over the DECLARED UNIONS rather than a hand-written
   * list: a test written against the same enumeration a bug lives in cannot see what the enumeration
   * missed, and a provider or family added later must not inherit the batch claim by omission — a new
   * batched row has to be measured (`scripts/stream-probe.mjs`) and then named here.
   */
  it('yields batched for no configured (provider, family) pair', () => {
    const batched: string[] = [];

    for (const provider of PLATFORM_PROVIDERS) {
      for (const family of MODEL_FAMILIES) {
        if (deliveryModeFor(provider, MODEL_BY_FAMILY[family]) === 'batched') {
          batched.push(`${provider}/${family}`);
        }
      }
    }

    expect(PLATFORM_PROVIDERS).toEqual(['Anthropic']);
    expect(batched).toEqual([]);
  });
});

describe('providerDeliveryMode (deprecated delegate)', () => {
  it('reports Anthropic as streaming', () => {
    expect(providerDeliveryMode('Anthropic')).toBe('streamed');
  });

  it('assumes an UNMEASURED or RETIRED provider streams', () => {
    expect(providerDeliveryMode('Bedrock' as never)).toBe('streamed');
    expect(providerDeliveryMode('KIE' as never)).toBe('streamed');
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
