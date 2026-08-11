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
import { FAMILY_POLICY, MODEL_FAMILIES } from '~/lib/modules/llm/model-families';

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

  /**
   * The `chat` family (Comet, 2026-08-10) speaks the OpenAI chat-completions dialect, so its
   * counters arrive under the SAME `openai` namespace as codex — but its cache is not priced
   * (`cacheProfile: 'none'`), which is a different fact and is asserted separately below. Reading the
   * key is still worth pinning: an adapter that starts reporting `cachedPromptTokens` must be picked
   * up automatically, expected zeros rather than assumed zeros.
   */
  it('reads the openai namespace for chat', () => {
    expect(extractStepCacheTokens({ openai: { cachedPromptTokens: 8_192 } }, 'chat')).toEqual({
      cacheReadTokens: 8_192,
      cacheCreationTokens: 0,
      sawNamespace: true,
    });
  });

  /** Same namespace as codex, and it must stay that way — they are one dialect. */
  it('routes chat and codex to the same namespace', () => {
    const meta = { openai: { cachedPromptTokens: 5 }, anthropic: { cacheReadInputTokens: 999 } };

    expect(extractStepCacheTokens(meta, 'chat')).toEqual(extractStepCacheTokens(meta, 'codex'));
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

  /**
   * `chat` takes gemini's exemption for gemini's reason — `cacheProfile: 'none'`, so the namespace is
   * EXPECTED to be absent and its absence costs nothing. ⚠️ It would be easy to derive the exemption
   * from the namespace instead (`openai` warns, so chat warns) — that reading is wrong and would emit
   * a warning on every step of every chat generation, which is how an operator learns to ignore the
   * one warning that means real money is being mis-measured.
   */
  it('does NOT warn for chat — same exemption as gemini, same reason', () => {
    expect(shouldWarnMissingUsageNamespace('chat')).toBe(false);
  });

  /**
   * Asserted over the DECLARED UNION, not a hand-written list: a family added to `MODEL_FAMILIES`
   * must be a deliberate answer to "is this cache priced?", never an omission. The rule is exactly
   * `cacheProfile !== 'none'`, so it is stated once and checked against every family that exists.
   */
  it.each(MODEL_FAMILIES)('warns for %s exactly when its cache is priced', (family) => {
    expect(shouldWarnMissingUsageNamespace(family)).toBe(FAMILY_POLICY[family].cacheProfile !== 'none');
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
    expect(usageNamespaceFor('chat')).toBe('openai');
    expect(usageNamespaceFor(undefined)).toBe('anthropic');
  });

  /* Every declared family names a namespace — the warning text quotes it, so a gap reads as a bug. */
  it.each(MODEL_FAMILIES)('names a namespace for %s', (family) => {
    expect(usageNamespaceFor(family)).toBe(FAMILY_POLICY[family].usageNamespace);
  });
});
