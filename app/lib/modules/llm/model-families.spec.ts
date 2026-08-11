/**
 * The model-id -> family derivation and the per-family policy table (T1).
 *
 * Every rule here fails SILENTLY and on the wire: a family guessed instead of refused sends an
 * Anthropic `thinking` block to an OpenAI endpoint (a hard 400 before a token), and a wrong
 * `cacheProfile`/`usageNamespace` mis-bills a generation with nothing thrown. The effort maps are
 * asserted EXHAUSTIVELY over `EFFORT_LEVELS` rather than on a sample, so adding a level cannot
 * silently fall through to a default.
 */
import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS, type EffortLevel } from '~/lib/modules/llm/capabilities';
import {
  codexEffort,
  familyOf,
  geminiThinkingLevel,
  requireFamily,
  FAMILY_POLICY,
  FAMILY_PREFIXES,
  MODEL_FAMILIES,
  type ModelFamily,
} from './model-families';

describe('familyOf', () => {
  it('derives the family from the id prefix', () => {
    expect(familyOf('claude-opus-5')).toBe('claude');
    expect(familyOf('claude-sonnet-5')).toBe('claude');
    expect(familyOf('gpt-5.2-codex')).toBe('codex');
    expect(familyOf('gemini-3-pro')).toBe('gemini');
  });

  /*
   * The `chat` family (Comet, 2026-08-10) — the OpenAI chat-completions dialect as spoken by
   * everything that is not OpenAI itself. Every vendor is listed rather than sampled: a prefix that
   * quietly stopped matching drops its ids into `requireFamily`'s refusal, which is loud, but a prefix
   * that matches the WRONG family is silent — a `chat` id routed to `codex` would be priced on KIE's
   * published cache pair (`explicit-pair`) for a vendor that publishes no cached rate at all.
   */
  it.each([['grok-4.5'], ['kimi-k2-thinking'], ['glm-4.6'], ['minimax-m2'], ['deepseek-v3.2'], ['qwen3-max']])(
    'derives chat for %s',
    (id) => {
      expect(familyOf(id)).toBe('chat');
    },
  );

  /*
   * 🔴 `qwen` and `deepseek` are deliberately NOT dash-terminated where every neighbour is, because
   * the vendors ship BOTH spellings. That reads like a typo, so it is pinned on both sides of the
   * dash: a "tidy-up" adding the dash back would silently drop `qwen3-*`/`deepseek-*`'s siblings into
   * the refusal — and the ids it drops are exactly the ones the feed carries most.
   */
  it.each([
    ['qwen3-coder', 'the dash-less spelling'],
    ['qwen-max', 'the dashed spelling'],
    ['deepseek-v3.2', 'the dashed spelling'],
    ['deepseekv3', 'the dash-less spelling'],
  ])('matches %s (%s) — the prefix is deliberately not dash-terminated', (id) => {
    expect(familyOf(id)).toBe('chat');
  });

  it('strips the Bedrock-style `anthropic.` prefix before matching', () => {
    expect(familyOf('anthropic.claude-opus-5')).toBe('claude');
  });

  it('returns undefined for anything no prefix claims', () => {
    expect(familyOf('llama-3')).toBeUndefined();
    expect(familyOf('')).toBeUndefined();
    expect(familyOf(undefined)).toBeUndefined();
    expect(familyOf(null)).toBeUndefined();
    expect(familyOf(42 as unknown as string)).toBeUndefined();
    expect(familyOf({} as unknown as string)).toBeUndefined();
  });
});

describe('FAMILY_PREFIXES', () => {
  /*
   * 🔴 ORDER IS BEHAVIOUR — `familyOf` returns the FIRST match. The three original prefixes stay at
   * the front so nothing already shipped can be re-routed by a prefix added later, and this pins that
   * as a property rather than as a convention someone remembers.
   */
  it('keeps claude-/gpt-/gemini- first, so no shipped id can be re-routed', () => {
    expect(FAMILY_PREFIXES.slice(0, 3)).toEqual([
      ['claude-', 'claude'],
      ['gpt-', 'codex'],
      ['gemini-', 'gemini'],
    ]);
  });

  /*
   * 🔴 NO PREFIX MAY SHADOW ANOTHER. `familyOf` is first-match, so adding (say) `gpt-oss` -> chat
   * BELOW `gpt-` would make it dead code — every `gpt-oss*` id would resolve to `codex` and be priced
   * on KIE's published cache pair. Nothing throws; the invoices are just wrong for a family whose
   * vendors publish no cached rate. Asserted over the declared list rather than a hand-written set,
   * because a test written against the same enumeration a bug lives in cannot see what it missed.
   */
  it('has no prefix that is a prefix of another (a shadowed entry is unreachable)', () => {
    const shadowed: string[] = [];

    for (const [outer] of FAMILY_PREFIXES) {
      for (const [inner, innerFamily] of FAMILY_PREFIXES) {
        if (inner !== outer && inner.startsWith(outer)) {
          shadowed.push(`${inner} (${innerFamily}) is shadowed by ${outer}`);
        }
      }
    }

    expect(shadowed).toEqual([]);
  });

  /* CONTROL: the scan above passes trivially for an empty table. */
  it('is a real, non-trivial table (control)', () => {
    expect(FAMILY_PREFIXES.length).toBeGreaterThanOrEqual(9);
    expect(new Set(FAMILY_PREFIXES.map(([, family]) => family))).toEqual(new Set(MODEL_FAMILIES));
  });
});

describe('requireFamily', () => {
  it('returns the family for a known id', () => {
    expect(requireFamily('gpt-5.2-codex')).toBe('codex');
  });

  it.each([
    ['grok-4.5', 'chat'],
    ['kimi-k2-thinking', 'chat'],
    ['qwen3-max', 'chat'],
    ['glm-4.6', 'chat'],
    ['deepseek-v3.2', 'chat'],
    ['minimax-m2', 'chat'],
  ] as ReadonlyArray<[string, ModelFamily]>)('returns %s -> %s', (id, family) => {
    expect(requireFamily(id)).toBe(family);
  });

  /*
   * The refusal names the id AND EVERY accepted prefix — derived from `FAMILY_PREFIXES`, never a
   * hand-written list. The message used to enumerate three prefixes in prose, so adding a fourth
   * family left the error telling an operator that an id it just refused was not one of three things
   * when there were nine. An error that under-reports the accepted set sends the reader looking for a
   * misconfiguration in the wrong place.
   */
  it('throws naming the offending id AND every accepted prefix', () => {
    let message = '';

    try {
      requireFamily('llama-3');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('llama-3');

    for (const [prefix, family] of FAMILY_PREFIXES) {
      expect(message, `the refusal must name ${prefix} (${family})`).toContain(prefix);
    }

    // All four families named, so the reader learns what the platform actually serves.
    for (const family of MODEL_FAMILIES) {
      expect(message).toContain(family);
    }
  });

  it('throws for an absent id', () => {
    expect(() => requireFamily(undefined)).toThrow();
    expect(() => requireFamily('')).toThrow();
  });
});

describe('codexEffort', () => {
  const expected: Record<EffortLevel, string> = {
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'xhigh', // clamps DOWN to the wire's ceiling — never up
  };

  it.each(EFFORT_LEVELS)('maps effort %s on an adaptive turn', (effort) => {
    expect(codexEffort('adaptive', effort)).toBe(expected[effort]);
  });

  it.each(EFFORT_LEVELS)('maps effort %s to low when thinking is disabled', (effort) => {
    expect(codexEffort('disabled', effort)).toBe('low');
  });
});

describe('geminiThinkingLevel', () => {
  const expected: Record<EffortLevel, string> = {
    medium: 'low',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };

  it.each(EFFORT_LEVELS)('maps effort %s on an adaptive turn', (effort) => {
    expect(geminiThinkingLevel('adaptive', effort)).toBe(expected[effort]);
  });

  it.each(EFFORT_LEVELS)('maps effort %s to low when thinking is disabled', (effort) => {
    expect(geminiThinkingLevel('disabled', effort)).toBe('low');
  });
});

describe('FAMILY_POLICY', () => {
  it.each(MODEL_FAMILIES)('covers %s', (family) => {
    expect(FAMILY_POLICY[family]).toBeDefined();
  });

  it('has no entry for a family that is not declared', () => {
    expect(Object.keys(FAMILY_POLICY).sort()).toEqual([...MODEL_FAMILIES].sort());
  });

  /*
   * Both fields are MONEY. `cacheProfile` decides what the price list may quote and how cached tokens
   * bill; `usageNamespace` decides where settlement reads the counters from. Either one wrong bills
   * every generation on that family incorrectly with nothing thrown — and `chat` is the one that has
   * never carried live traffic, so it is the one nobody would notice.
   */
  it.each([
    ['claude', 'derived', 'anthropic'],
    ['codex', 'explicit-pair', 'openai'],
    ['gemini', 'none', 'google'],
    ['chat', 'none', 'openai'],
  ] as ReadonlyArray<[ModelFamily, string, string]>)(
    '%s bills cached tokens as %s and reads usage under %s',
    (family, cacheProfile, usageNamespace) => {
      expect(FAMILY_POLICY[family].cacheProfile).toBe(cacheProfile);
      expect(FAMILY_POLICY[family].usageNamespace).toBe(usageNamespace);
    },
  );

  /*
   * 🔴 `promptTokensIncludeCacheRead` IS MONEY, AND IT IS A FACT ABOUT THE VENDOR'S WIRE.
   *
   * `costForRates` bills `promptTokens` at full input and `cacheReadTokens` at the cache rate, ADDING
   * them — correct only where the two do not overlap. Anthropic reports `input_tokens` EXCLUSIVE of the
   * cache classes (siblings), so `claude` is the ONLY `false`. OpenAI (Responses and chat-completions)
   * and Google both report the cached count as a BREAKDOWN of the prompt total, so `codex`, `chat` and
   * `gemini` are `true` and `step-usage.ts` subtracts. A real `gpt-5-6-terra` turn billed **1.86x**
   * before that subtraction existed (T12, 2026-08-11), and nothing threw.
   *
   * The four VALUES are pinned as literals rather than read back off `FAMILY_POLICY` — an assertion
   * sourced from the constant it is asserting moves with any edit and goes green on the regression it
   * is named for (this repo's `PROGRESS_CAP` trap). Getting one wrong is silent in BOTH directions:
   * `false` on an inclusive family double-bills the user, and `true` on Claude would quietly bill the
   * platform's entire Claude history at a fraction of cost.
   */
  it.each([
    ['claude', false],
    ['codex', true],
    ['gemini', true],
    ['chat', true],
  ] as ReadonlyArray<[ModelFamily, boolean]>)(
    '%s reports promptTokens inclusive of cache read: %s',
    (family, inclusive) => {
      expect(FAMILY_POLICY[family].promptTokensIncludeCacheRead).toBe(inclusive);
    },
  );

  /*
   * EXHAUSTIVE, so a family added later cannot ship without an answer. `undefined` is falsy, which is
   * the DOUBLE-BILLING direction — an omitted field would silently charge cached tokens twice on a new
   * inclusive family, so a boolean is required rather than merely truthy-checked.
   */
  it.each(MODEL_FAMILIES)('%s declares promptTokensIncludeCacheRead explicitly', (family) => {
    expect(typeof FAMILY_POLICY[family].promptTokensIncludeCacheRead).toBe('boolean');
  });

  /*
   * CONTROL: claude is the only exclusive wire. Stated as a property over the declared union rather
   * than as a fourth copy of the table above — if a future family is added as `false` by mistake (the
   * under-billing direction), this fails even though the literal pin does not mention it.
   */
  it('has claude as the ONLY family whose wire excludes cached tokens', () => {
    const exclusive = MODEL_FAMILIES.filter((family) => !FAMILY_POLICY[family].promptTokensIncludeCacheRead);

    expect(exclusive).toEqual(['claude']);
  });

  /*
   * ⚠️ `chat` is NOT a widening of `codex`, and the difference is the one thing a family exists to
   * answer: `codex` rows quote KIE's published cache pair, and no vendor quotes a cached rate for the
   * chat vendors. They share a usage NAMESPACE (both speak an OpenAI dialect) and must not share a
   * cache profile — folding them would let a chat row quote a pair we cannot verify.
   */
  it('gives chat the openai namespace but NOT the codex cache profile', () => {
    expect(FAMILY_POLICY.chat.usageNamespace).toBe(FAMILY_POLICY.codex.usageNamespace);
    expect(FAMILY_POLICY.chat.cacheProfile).not.toBe(FAMILY_POLICY.codex.cacheProfile);
  });

  /*
   * The caps are FLOORS, not measurements (`model-families.ts`). What must hold for every family is
   * that they are usable numbers and that a completion cap can never exceed the context window — a
   * completion cap above the window is a request the vendor rejects mid-generation, after the input
   * has been paid for.
   */
  it.each(MODEL_FAMILIES)('gives %s a usable, self-consistent pair of token caps', (family) => {
    const { maxTokenAllowed, maxCompletionTokens } = FAMILY_POLICY[family];

    expect(Number.isInteger(maxTokenAllowed) && maxTokenAllowed > 0).toBe(true);
    expect(Number.isInteger(maxCompletionTokens) && maxCompletionTokens > 0).toBe(true);
    expect(maxCompletionTokens).toBeLessThanOrEqual(maxTokenAllowed);
  });
});
