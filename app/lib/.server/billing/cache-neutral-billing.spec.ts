/**
 * 🔴 THE CUSTOMER IS NEVER BILLED FOR THE STATE OF OUR CACHE (`billedUsage`, 2026-08-07).
 *
 * A cache WRITE bills at 2x input and a cache READ at 0.1x — a 20x swing on the byte-identical request,
 * decided by whether some other user happened to send the same prefix in the last hour. Measured on the
 * same "mario kart racer" creation: **144 credits warm, 600 cold, 1,489** when a forced continuation
 * wrote the ~212k prefix twice (`gen_msixapaq_i871b6`). The user causes none of that and can observe
 * none of it.
 *
 * So `decideCredits` prices cache-creation tokens at the read rate and the platform eats the
 * difference. The tests below pin the two halves of that, and the second one is the one that actually
 * matters:
 *
 *   1. cold and warm shapes of the SAME generation bill the SAME credits;
 *   2. `raw_cost_usd` still tells the truth — because that is the only surface on which the platform
 *      can see what it absorbed, and a "fix" that routes it through `billedUsage` too would make the
 *      §4.10 margin report read healthier than the bank account, silently, forever.
 *
 * ⚠️ Mutation-verified: reverting `decideCredits` to `input.usage` fails (1) and (3); routing
 * `rawCostUsd` through `billedUsage` fails (2).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { billedUsage, decideCredits, settleGeneration } from './gate';
import { FsLedger, setLedger } from './ledger';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from './generations';
import { invalidateMarketPricesCache } from './market-price-store';
import { getBillingConfig, rawCostUsd, type TokenUsage } from './rates';

/**
 * ⚠️ The `oauth.spec.ts` trap, which this repo has now been bitten by twice: `env()` falls back to
 * `process.env` and vitest loads `.env.local`, so an "empty" context is the developer's real config.
 * Scrub the WHOLE precedence chain — `LLM_MODEL` outranks `KIE_DEFAULT_MODEL`, and a list naming only
 * the sibling fails on the machine of whoever actually configured the platform, with CI green.
 */
const SCRUBBED_ENV = [
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',
] as const;

const MODEL = 'claude-sonnet-5';
const PROVIDER = 'Anthropic';

/** One generation, two cache outcomes. Identical work; only the cache column differs. */
const PREFIX_TOKENS = 111_659;
const OUTPUT_TOKENS = 12_862;

const warm: TokenUsage = {
  promptTokens: 0,
  completionTokens: OUTPUT_TOKENS,
  cacheReadTokens: PREFIX_TOKENS,
  cacheCreationTokens: 0,
};

const cold: TokenUsage = {
  promptTokens: 0,
  completionTokens: OUTPUT_TOKENS,
  cacheReadTokens: 0,
  cacheCreationTokens: PREFIX_TOKENS,
};

let tmp: string;
let rows: GenerationUpsert[];

beforeEach(async () => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  invalidateMarketPricesCache();

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-neutral-'));
  setLedger(new FsLedger(tmp));

  /* Without this, settleGeneration deposits real rows in the developer's `.data/generations`. */
  rows = [];
  setGenerationStore({
    upsert: async (row: GenerationUpsert) => {
      rows.push(row);
    },
    list: async () => [],
  } as unknown as GenerationStore);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setLedger(undefined);
  setGenerationStore(undefined);
  invalidateMarketPricesCache();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('billedUsage', () => {
  it('moves cache-creation tokens onto the read column and leaves everything else alone', () => {
    expect(billedUsage(cold)).toEqual({
      promptTokens: 0,
      completionTokens: OUTPUT_TOKENS,
      cacheReadTokens: PREFIX_TOKENS,
      cacheCreationTokens: 0,
    });
  });

  it('is a no-op on a warm turn — the common case must not be re-priced by accident', () => {
    expect(billedUsage(warm)).toEqual(warm);
  });

  it('preserves total token count, so it can never be mistaken for a discount', () => {
    const total = (u: TokenUsage) => u.promptTokens + u.completionTokens + u.cacheReadTokens + u.cacheCreationTokens;

    expect(total(billedUsage(cold))).toBe(total(cold));
  });
});

describe('decideCredits is cache-neutral', () => {
  it('bills a cold generation exactly what the identical warm one costs', () => {
    const config = getBillingConfig();

    const warmCredits = decideCredits({ usage: warm, model: MODEL, provider: PROVIDER }, config);
    const coldCredits = decideCredits({ usage: cold, model: MODEL, provider: PROVIDER }, config);

    expect(coldCredits).toBe(warmCredits);

    /*
     * A control: the pre-fix behaviour really was different, so this test could actually fail. Without
     * it, `toBe(warmCredits)` would still pass if both sides collapsed to some constant.
     */
    const trueColdCredits = Math.max(
      1,
      Math.ceil((rawCostUsd(cold, MODEL, PROVIDER) / config.creditUnitCostUsd) * config.margin),
    );
    expect(trueColdCredits).toBeGreaterThan(coldCredits);
  });

  it('still charges MORE for more work — the bill tracks the request, it is not flattened', () => {
    const config = getBillingConfig();

    const small = decideCredits({ usage: warm, model: MODEL, provider: PROVIDER }, config);
    const large = decideCredits(
      { usage: { ...warm, completionTokens: OUTPUT_TOKENS * 4 }, model: MODEL, provider: PROVIDER },
      config,
    );

    expect(large).toBeGreaterThan(small);
  });

  it('a generation that consumed nothing is still free', () => {
    const config = getBillingConfig();
    const nothing: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

    expect(decideCredits({ usage: nothing, model: MODEL, provider: PROVIDER }, config)).toBe(0);
  });

  it('BYOK is still zero', () => {
    const config = getBillingConfig();
    expect(decideCredits({ usage: cold, model: MODEL, provider: PROVIDER, byok: true }, config)).toBe(0);
  });
});

describe('raw_cost_usd still tells the truth', () => {
  it('records the REAL cost of a cold generation, not the billed view', async () => {
    const settlement = await settleGeneration({
      userId: 'user-cache-neutral',
      generationId: 'gen_cold',
      model: MODEL,
      provider: PROVIDER,
      usage: cold,
    });

    const trueCost = rawCostUsd(cold, MODEL, PROVIDER);

    expect(settlement?.rawCostUsd).toBeCloseTo(trueCost, 10);
    expect(rows[0]?.rawCostUsd).toBeCloseTo(trueCost, 10);

    /*
     * THE POINT: cost differs cold-vs-warm even though credits do not. This is the platform's only
     * view of what it absorbed — the §4.10 margin report is derived from this column.
     */
    expect(trueCost).toBeGreaterThan(rawCostUsd(warm, MODEL, PROVIDER));
  });

  it('the recorded token columns are the TRUE ones — cache writes are not rewritten in the audit trail', async () => {
    await settleGeneration({
      userId: 'user-cache-neutral',
      generationId: 'gen_cold_cols',
      model: MODEL,
      provider: PROVIDER,
      usage: cold,
    });

    expect(rows[0]?.cacheCreationTokens).toBe(PREFIX_TOKENS);
    expect(rows[0]?.cacheReadTokens).toBe(0);
  });
});
