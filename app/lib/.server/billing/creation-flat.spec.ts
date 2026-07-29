/**
 * Flat-priced creation turns (§4.6, `creationFlatCredits`) — a money path in both directions.
 *
 * A wrong answer here throws nothing: charging the flat price on a BYOK or zero-usage generation is a
 * silent mis-bill; falling back to cost-derived when the flat price should apply silently restores the
 * 12x cold/warm variance the feature exists to remove; and a gate that lets a 10-credit balance start
 * a 500-credit creation is a knowable deep negative. Every branch of `decideCredits` and the gate's
 * `minimumCredits` wall is pinned by intent, plus the settlement integration against the real
 * `FsLedger` (flat debit lands, note names the pricing model, `rawCostUsd` stays the TRUE cost).
 *
 * Sibling to `billing.spec.ts` (that file is ~1,900 lines); same FsLedger/store setup, same env-scrub
 * posture — the `oauth.spec.ts` trap means the WHOLE precedence chain is scrubbed first, or a
 * developer with `CREATION_FLAT_CREDITS` in `.env.local` fails money assertions locally with CI green.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditsForUsage, DEFAULT_CREATION_FLAT_CREDITS, getBillingConfig, rawCostUsd, type TokenUsage } from './rates';
import { checkCreditGate, decideCredits, settleGeneration } from './gate';
import { FsLedger, setLedger } from './ledger';
import { setGenerationStore, type GenerationStore } from './generations';
import { invalidateMarketPricesCache } from './market-price-store';

let tmp: string;
let ledger: FsLedger;

/**
 * ⚠️ The `oauth.spec.ts` trap: `env()` falls back to `process.env` and vitest loads `.env.local`, so
 * an "empty" context is the developer's real configuration. Scrub the whole chain that feeds
 * `getBillingConfig` + `decideCredits`, not just the variable under test (`billing.spec.ts` carries
 * the twice-fired history of exactly this list going stale).
 */
const SCRUBBED_ENV = [
  'CREATION_FLAT_CREDITS',
  'BILLING_ENFORCED',
  'CREDIT_UNIT_COST_USD',
  'CREDIT_MARGIN',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',
] as const;

/** A real (non-trivial) usage vector — the normal case where a creation consumed tokens. */
const usage: TokenUsage = {
  promptTokens: 1000,
  completionTokens: 2000,
  cacheReadTokens: 5000,
  cacheCreationTokens: 0,
};

/** A generation that consumed NOTHING — the instant-failure shape that must always be free. */
const nothing: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

beforeEach(async () => {
  for (const key of SCRUBBED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  invalidateMarketPricesCache();

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-flat-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);

  /*
   * Same seam as billing.spec.ts: without this stub, settleGeneration deposits real rows into the
   * developer's `.data/generations/` — fixtures that then pollute the §4.10 admin usage report.
   */
  setGenerationStore({ upsert: async () => undefined, list: async () => [] } as unknown as GenerationStore);
});

afterEach(async () => {
  setLedger(undefined);
  setGenerationStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  invalidateMarketPricesCache();
});

describe('creationFlatCredits config (CREATION_FLAT_CREDITS)', () => {
  it('defaults to 500', () => {
    expect(DEFAULT_CREATION_FLAT_CREDITS).toBe(500);
    expect(getBillingConfig().creationFlatCredits).toBe(500);
  });

  /* `0` is a REAL value — the operator escape hatch back to cost-proportional pricing. */
  it('accepts 0 as "flat pricing disabled"', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '0');
    expect(getBillingConfig().creationFlatCredits).toBe(0);
  });

  it('honors a positive override', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '250');
    expect(getBillingConfig().creationFlatCredits).toBe(250);
  });

  /* Obeying a negative would CREDIT the user for creating a project — ignore, never obey. */
  it('ignores a negative override in favor of the default', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '-5');
    expect(getBillingConfig().creationFlatCredits).toBe(DEFAULT_CREATION_FLAT_CREDITS);
  });

  it('ignores a non-numeric override in favor of the default', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', 'abc');
    expect(getBillingConfig().creationFlatCredits).toBe(DEFAULT_CREATION_FLAT_CREDITS);
  });

  it('floors a fractional override — credits are integers', () => {
    vi.stubEnv('CREATION_FLAT_CREDITS', '250.9');
    expect(getBillingConfig().creationFlatCredits).toBe(250);
  });
});

describe('decideCredits', () => {
  const base = { model: 'claude-sonnet-5', provider: 'Anthropic' } as const;

  it('charges BYOK zero even when a flat price is set — their key already paid', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage, byok: true, flatCredits: 500 }, config)).toBe(0);
  });

  /*
   * Flat pricing charges for a CREATION, not for an instant failure. The auto-refund would usually
   * mask a wrong answer here — "usually" is not a money guarantee.
   */
  it('charges a zero-consumption generation zero even with a flat price set', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage: nothing, flatCredits: 500 }, config)).toBe(0);
  });

  it('charges exactly the flat price (floored) when set and tokens were consumed', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage, flatCredits: 500 }, config)).toBe(500);
    expect(decideCredits({ ...base, usage, flatCredits: 250.7 }, config)).toBe(250);
  });

  it('falls back to the cost-derived formula when no flat price is set (or it is 0)', () => {
    const config = getBillingConfig();
    const derived = creditsForUsage(usage, base.model, base.provider, config);

    expect(decideCredits({ ...base, usage }, config)).toBe(derived);
    expect(decideCredits({ ...base, usage, flatCredits: 0 }, config)).toBe(derived);
  });

  /* The STOP shape (§4.12): bill what was consumed, bounded by the advertised ceiling. */
  it('caps a cost-derived charge at maxCredits when maxCredits is set and binding', () => {
    const config = getBillingConfig();
    const big: TokenUsage = {
      promptTokens: 100_000,
      completionTokens: 50_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const derived = creditsForUsage(big, base.model, base.provider, config);

    expect(derived).toBeGreaterThan(5);
    expect(decideCredits({ ...base, usage: big, maxCredits: 5 }, config)).toBe(5);
  });

  it('leaves a cost-derived charge alone when maxCredits is not binding (or unset/0)', () => {
    const config = getBillingConfig();
    const derived = creditsForUsage(usage, base.model, base.provider, config);

    expect(decideCredits({ ...base, usage, maxCredits: derived + 1_000 }, config)).toBe(derived);
    expect(decideCredits({ ...base, usage, maxCredits: 0 }, config)).toBe(derived);
  });

  /* Mutually exclusive at the call site by construction; if both arrive, the flat price WINS. */
  it('lets the flat price win when both flatCredits and maxCredits are set', () => {
    const config = getBillingConfig();

    expect(decideCredits({ ...base, usage, flatCredits: 500, maxCredits: 5 }, config)).toBe(500);
  });
});

describe('credit gate with minimumCredits (the flat-creation wall)', () => {
  it('refuses when enforced and the balance is below the minimum, naming both numbers', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });

    const result = await checkCreditGate({ userId: 'u1', minimumCredits: 500 });

    expect(result.allowed).toBe(false);

    if (!result.allowed) {
      expect(result.message).toContain('500');
      expect(result.message).toContain('100');
    }
  });

  it('allows a balance exactly at the minimum', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 500, reason: 'grant' });

    expect((await checkCreditGate({ userId: 'u1', minimumCredits: 500 })).allowed).toBe(true);
  });

  it('allows a balance above the minimum', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 501, reason: 'grant' });

    expect((await checkCreditGate({ userId: 'u1', minimumCredits: 500 })).allowed).toBe(true);
  });

  it('ignores an unset or zero minimum — any positive balance passes (the ordinary-turn contract)', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 1, reason: 'grant' });

    expect((await checkCreditGate({ userId: 'u1' })).allowed).toBe(true);
    expect((await checkCreditGate({ userId: 'u1', minimumCredits: 0 })).allowed).toBe(true);
  });

  /*
   * The zero-balance refusal comes FIRST and keeps its own (generic) message — a user with nothing
   * gets "out of credits", not creation-specific arithmetic about a turn they cannot start anyway.
   */
  it('keeps the zero-balance refusal ahead of the minimum check', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const result = await checkCreditGate({ userId: 'broke', minimumCredits: 500 });

    expect(result.allowed).toBe(false);

    if (!result.allowed) {
      expect(result.message).toContain('out of credits');
      expect(result.message).not.toContain('500');
    }
  });

  it('never blocks when billing is not enforced, regardless of the minimum', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'false');

    const result = await checkCreditGate({ userId: 'broke', minimumCredits: 500 });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('unmetered');
  });

  it('lets BYOK through regardless of balance and minimum — their key pays', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const result = await checkCreditGate({ userId: 'pro', byok: true, minimumCredits: 500 });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('byok');
  });
});

describe('settlement with a flat creation price', () => {
  it('debits exactly the flat price, records the TRUE raw cost, and names the pricing model in the note', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-flat',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage,
      flatCredits: 500,
    });

    expect(settlement!.creditsCharged).toBe(500);
    expect(settlement!.balanceAfter).toBe(9_500);
    expect(await ledger.balance('u1')).toBe(9_500);

    // rawCostUsd stays the token-derived truth — the Admin report watches realized margin with it.
    expect(settlement!.rawCostUsd).toBeCloseTo(rawCostUsd(usage, 'claude-sonnet-5', 'Anthropic'), 10);

    const debit = (await ledger.list('u1')).find((r) => r.reason === 'generation');

    expect(debit!.delta).toBe(-500);
    expect(debit!.note).toContain('flat creation price');
  });

  it('does NOT mark an ordinary cost-derived debit as flat-priced', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    await settleGeneration({
      userId: 'u1',
      generationId: 'g-ordinary',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage,
    });

    const debit = (await ledger.list('u1')).find((r) => r.reason === 'generation');

    expect(debit!.note).not.toContain('flat creation price');
  });

  /* The stopped-creation shape: min(consumed, advertised flat ceiling). */
  it('caps a cost-derived charge at maxCredits', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const big: TokenUsage = {
      promptTokens: 100_000,
      completionTokens: 50_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-capped',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage: big,
      maxCredits: 5,
    });

    expect(settlement!.creditsCharged).toBe(5);
    expect(await ledger.balance('u1')).toBe(9_995);
  });

  it('charges nothing for a zero-usage generation even with the flat price set', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-nothing',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage: nothing,
      flatCredits: 500,
    });

    expect(settlement!.creditsCharged).toBe(0);
    expect(await ledger.balance('u1')).toBe(10_000);

    // No debit row at all — a free generation leaves only the grant in the ledger.
    expect((await ledger.list('u1')).filter((r) => r.reason === 'generation')).toHaveLength(0);
  });
});
