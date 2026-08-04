/**
 * Guards the per-family cache-counter reader (§4.6 — a MONEY PATH).
 *
 * The regression these tests exist to prevent is NOT a crash. `providerMetadata` is `unknown`, every
 * miss coerces to zero, and nothing anywhere throws — so a wrong namespace key bills every generation
 * on that family as if the cache did not exist and the credit total goes DOWN, which reads as a
 * cheaper turn (§4.2.8's silent failure shape).
 *
 * The single most important assertion in this file is the CLAUDE IDENTITY PIN: every Claude
 * generation ever billed read `providerMetadata.anthropic.cacheReadInputTokens` /
 * `cacheCreationInputTokens` from an inline literal. Routing that read through a family table must be
 * byte-identical for `'claude'` and for an omitted family, or a refactor that added two new wires
 * silently repriced the one that carries the traffic.
 */
import { describe, expect, it } from 'vitest';
import { extractStepCacheTokens, shouldWarnMissingUsageNamespace, usageNamespaceFor } from './usage-metadata';

describe('extractStepCacheTokens — claude identity', () => {
  /**
   * 🔴 THE REGRESSION BAR. These are the exact two keys and the exact shape the inline read used, and
   * the numbers must survive the indirection unchanged.
   */
  it('reads the anthropic namespace byte-identically to the old inline read', () => {
    const meta = { anthropic: { cacheReadInputTokens: 133_000, cacheCreationInputTokens: 4_200 } };

    expect(extractStepCacheTokens(meta, 'claude')).toEqual({
      cacheReadTokens: 133_000,
      cacheCreationTokens: 4_200,
      sawNamespace: true,
    });
  });

  /**
   * A step can carry more than one vendor namespace (the SDK merges whatever the adapter emits). The
   * family — never "whichever key happens to be present" — decides which one is billed from.
   */
  it('ignores other vendors namespaces that ride alongside', () => {
    const meta = {
      anthropic: { cacheReadInputTokens: 10_000, cacheCreationInputTokens: 500 },
      openai: { cachedPromptTokens: 999_999 },
      google: { cachedContentTokenCount: 888_888 },
    };

    expect(extractStepCacheTokens(meta, 'claude')).toEqual({
      cacheReadTokens: 10_000,
      cacheCreationTokens: 500,
      sawNamespace: true,
    });
  });

  /**
   * An unknown/absent family reads `anthropic` — the HISTORICAL answer, not zeros. Settlement can
   * never refuse (§4.6), so a caller that cannot name the family must still bill today's numbers.
   */
  it('falls back to the anthropic namespace when the family is undefined', () => {
    const meta = { anthropic: { cacheReadInputTokens: 7_000, cacheCreationInputTokens: 70 } };

    expect(extractStepCacheTokens(meta, undefined)).toEqual({
      cacheReadTokens: 7_000,
      cacheCreationTokens: 70,
      sawNamespace: true,
    });
  });
});

describe('extractStepCacheTokens — per family', () => {
  /**
   * ✅ RE-PINNED FROM A LIVE KIE CAPTURE, 2026-08-04 (T11) — this was a placeholder until then.
   *
   * A real `gpt-5-6-sol` generation returned, verbatim:
   *
   *     "input_tokens_details": { "cache_write_tokens": 0, "cached_tokens": 0 }
   *
   * and `@ai-sdk/openai@1.3.24` maps `input_tokens_details.cached_tokens` →
   * `providerMetadata.openai.cachedPromptTokens` (dist L2482). So the KEY is measured, not assumed.
   *
   * 🔴 The capture also found `cache_write_tokens`, which the SDK does NOT map — there is no
   * `providerMetadata` key for it at any version we pin, so `cacheCreationTokens` is structurally
   * always zero on this family and the quoted Cache Writes price is never applied. That under-charges
   * us (the safe direction) and is recorded on `usage-metadata.ts` rather than worked around.
   */
  it('reads the openai namespace for codex, with no write counter on the Responses wire', () => {
    /* The captured value was 0; a non-zero is used here so the read is not confused with the default. */
    const meta = { openai: { cachedPromptTokens: 24_576 } };

    expect(extractStepCacheTokens(meta, 'codex')).toEqual({
      cacheReadTokens: 24_576,
      cacheCreationTokens: 0,
      sawNamespace: true,
    });
  });

  /**
   * The captured shape EXACTLY as KIE returned it — zeros and all.
   *
   * Kept beside the non-zero test above rather than replacing it, because the two answer different
   * questions: that one proves the key is READ, this one proves the real-world all-zero response is
   * reported as "nothing cached" (`sawNamespace: true`) and never as "the counter is missing".
   * Conflating those two is the distinction this whole module exists to preserve.
   */
  it('reads the captured all-zero codex response as nothing-cached, not as a missing counter', () => {
    const meta = { openai: { responseId: 'resp_09158396fc71f4e4', cachedPromptTokens: 0, reasoningTokens: 75 } };

    expect(extractStepCacheTokens(meta, 'codex')).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      sawNamespace: true,
    });
  });

  /**
   * Gemini reports no cached counter on KIE today (`cacheProfile: 'none'`), but `cachedContentTokenCount`
   * is Google's own name for it and is read so an adapter that starts reporting it is picked up
   * automatically — expected zeros, never assumed zeros.
   */
  it('reads the google namespace for gemini when a cached counter is present', () => {
    const meta = { google: { cachedContentTokenCount: 12_000 } };

    expect(extractStepCacheTokens(meta, 'gemini')).toEqual({
      cacheReadTokens: 12_000,
      cacheCreationTokens: 0,
      sawNamespace: true,
    });
  });

  /**
   * ✅ THE CAPTURED COUNTERS, VERBATIM — `gemini-3-5-flash`, live on KIE, 2026-08-04 (T11 re-pin).
   *
   * ⚠️ The NUMBERS are the real ones; the `google.usageMetadata` WRAPPING is not a shape this function
   * can actually receive — `@ai-sdk/google@1.2.22` puts only `groundingMetadata` and `safetyRatings`
   * under `providerMetadata.google`. It is written this way to keep the captured object recognisable
   * next to the probe output, and the assertion holds for the real shape too (both yield zeros with
   * `sawNamespace: true`, since neither carries a cached counter). Do not read it as the wire shape.
   *
   * `{"thinkingTokenCount":770,"candidatesTokenCount":1226,"totalTokenCount":2105,"promptTokenCount":109}`
   *
   * Four counters and NOT ONE of them is a cached-token counter — which is the measurement behind
   * `FAMILY_POLICY.gemini.cacheProfile === 'none'` and behind the baked row quoting no cache pair.
   * The numbers are the real ones; an invented fixture here would have been a plausible-looking
   * illustration of a claim nobody had checked.
   */
  it('reads zeros — but sawNamespace true — from the captured gemini usageMetadata', () => {
    const meta = {
      google: {
        usageMetadata: {
          thinkingTokenCount: 770,
          candidatesTokenCount: 1_226,
          totalTokenCount: 2_105,
          promptTokenCount: 109,
        },
      },
    };

    expect(extractStepCacheTokens(meta, 'gemini')).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      sawNamespace: true,
    });
  });
});

describe('extractStepCacheTokens — absent vs empty', () => {
  /**
   * "The namespace disappeared" is a DIFFERENT fact from "nothing was cached", and only the first is
   * worth a warning. Collapsing them is how a broken counter renders as an ordinary quiet step.
   */
  it.each([
    ['null metadata', null],
    ['undefined metadata', undefined],
    ['a non-object', 'anthropic'],
    ['a number', 42],
    ['an object with no namespaces', {}],
    ['only another vendors namespace', { openai: { cachedPromptTokens: 5 } }],
    ['a namespace present but not an object', { anthropic: 'cacheReadInputTokens=5' }],
    ['a namespace present but null', { anthropic: null }],
  ])('reports sawNamespace false for %s', (_label, meta) => {
    expect(extractStepCacheTokens(meta, 'claude')).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      sawNamespace: false,
    });
  });

  /** The overwhelmingly common honest case: the namespace is there, this step just cached nothing. */
  it('reports sawNamespace TRUE when the namespace is present but its values are missing', () => {
    expect(extractStepCacheTokens({ anthropic: {} }, 'claude')).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      sawNamespace: true,
    });

    // Distinguishable from the absent case above — that is the whole point of the flag.
    expect(extractStepCacheTokens({}, 'claude').sawNamespace).toBe(false);
  });

  /** Only one of the two counters present is still a present namespace, and the other bills as zero. */
  it('zeroes only the missing counter when one of the pair is reported', () => {
    expect(extractStepCacheTokens({ anthropic: { cacheReadInputTokens: 900 } }, 'claude')).toEqual({
      cacheReadTokens: 900,
      cacheCreationTokens: 0,
      sawNamespace: true,
    });
  });

  /** Never bill NaN, a string, or a negative-looking non-number. `n()` coerces; nothing throws. */
  it('coerces non-numeric and non-finite values to zero', () => {
    const meta = {
      anthropic: {
        cacheReadInputTokens: Number.NaN,
        cacheCreationInputTokens: '5000',
      },
    };

    const result = extractStepCacheTokens(meta, 'claude');

    expect(result).toEqual({ cacheReadTokens: 0, cacheCreationTokens: 0, sawNamespace: true });
    expect(Number.isNaN(result.cacheReadTokens)).toBe(false);

    expect(extractStepCacheTokens({ anthropic: { cacheReadInputTokens: Number.POSITIVE_INFINITY } }, 'claude')).toEqual(
      {
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        sawNamespace: true,
      },
    );

    // A genuinely negative number is a number: pass it through rather than invent a floor here.
    expect(extractStepCacheTokens({ anthropic: { cacheReadInputTokens: -1 } }, 'claude').cacheReadTokens).toBe(-1);
  });
});

describe('shouldWarnMissingUsageNamespace', () => {
  /** Warn only where a missing counter costs real money — i.e. where we PRICE the cache. */
  it('warns for the cache-priced families', () => {
    expect(shouldWarnMissingUsageNamespace('claude')).toBe(true);
    expect(shouldWarnMissingUsageNamespace('codex')).toBe(true);
  });

  /**
   * Gemini's namespace is EXPECTED to be absent (`cacheProfile: 'none'` — cached tokens bill at full
   * input rate). Warning on every Gemini step would train the operator to ignore the warning on the
   * two families where it means the bill is wrong.
   */
  it('does NOT warn for gemini, whose cache is not priced', () => {
    expect(shouldWarnMissingUsageNamespace('gemini')).toBe(false);
  });

  it('does not warn when the family is unknown', () => {
    expect(shouldWarnMissingUsageNamespace(undefined)).toBe(false);
  });
});

describe('usageNamespaceFor', () => {
  it('names the namespace per family, defaulting to anthropic', () => {
    expect(usageNamespaceFor('claude')).toBe('anthropic');
    expect(usageNamespaceFor('codex')).toBe('openai');
    expect(usageNamespaceFor('gemini')).toBe('google');
    expect(usageNamespaceFor(undefined)).toBe('anthropic');
  });
});
