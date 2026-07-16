/**
 * Money-path tests (SPEC §4.6, §4.6.1).
 *
 * These sit alongside `opaque-files.spec.ts` in the same category: a regression here throws nothing,
 * fails no build, and breaks no feature. It just quietly bills the wrong amount, or hands out free
 * credits, forever. Every test below is a rule someone could plausibly "simplify" away.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditsForUsage, getBillingConfig, MODEL_RATES, rawCostUsd, ratesFor, type TokenUsage } from './rates';
import {
  DuplicateGrantError,
  DuplicatePaymentError,
  ensureSignupGrant,
  FsLedger,
  getLedger,
  setLedger,
} from './ledger';
import { checkCreditGate, refundGeneration, settleGeneration } from './gate';
import { CREDIT_PACKS, MIN_PACK_MARGIN, packMargin } from './stripe';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from './generations';

let tmp: string;
let ledger: FsLedger;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);
});

afterEach(async () => {
  setLedger(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const config = getBillingConfig();

describe('rate table', () => {
  /*
   * THE 2x RULE. `proxy.ts` writes every cache entry with `ttl: '1h'`, and the 1-hour tier costs 2x
   * base input to write — not the 1.25x of the 5-minute default. If someone "corrects" this to 1.25x
   * to match the docs' headline number, every generation silently under-charges and the margin quietly
   * erodes. Nothing else in the system would notice.
   */
  it('bills cache WRITES at 2x input — the 1h tier, not the 1.25x default', () => {
    for (const [model, rates] of Object.entries(MODEL_RATES)) {
      expect(rates.cacheWritePerMTok, model).toBeCloseTo(rates.inputPerMTok * 2, 5);
    }
  });

  it('bills cache READS at 0.1x input — the margin lever', () => {
    for (const [model, rates] of Object.entries(MODEL_RATES)) {
      expect(rates.cacheReadPerMTok, model).toBeCloseTo(rates.inputPerMTok * 0.1, 5);
    }
  });

  /*
   * Sonnet 5 is on introductory pricing ($2/$10) until 2026-08-31. We deliberately bill the STANDARD
   * $3/$15: seeding the intro rate would compress our margin below target the day it lapses, and
   * nothing would fail — the invoices would just get bigger.
   */
  it('uses standard Sonnet pricing, not the expiring introductory rate', () => {
    expect(MODEL_RATES['claude-sonnet-5'].inputPerMTok).toBe(3.0);
    expect(MODEL_RATES['claude-sonnet-5'].outputPerMTok).toBe(15.0);
  });

  /* An unknown model must never bill as FREE — that is a revenue leak with a friendly face. */
  it('never zero-rates an unknown model', () => {
    const rates = ratesFor('some-model-we-have-never-heard-of');

    expect(rates.inputPerMTok).toBeGreaterThan(0);
    expect(rates.outputPerMTok).toBeGreaterThan(0);
  });
});

describe('charge formula', () => {
  /** The measured post-fix creation from §4.2.8: 695 uncached in, 110,964 cache write, ~30k out. */
  const realCreation: TokenUsage = {
    promptTokens: 695,
    completionTokens: 30_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 110_964,
  };

  it('prices a real creation in the range we measured (~$1.12–1.60)', () => {
    const cost = rawCostUsd(realCreation, 'claude-sonnet-5');

    expect(cost).toBeGreaterThan(1.1);
    expect(cost).toBeLessThan(1.6);
  });

  it('charges margin over raw cost', () => {
    const credits = creditsForUsage(realCreation, 'claude-sonnet-5', config);
    const cost = rawCostUsd(realCreation, 'claude-sonnet-5');

    // credits * unit cost should recover the raw cost with the margin applied.
    expect(credits * config.creditUnitCostUsd).toBeGreaterThan(cost * 2);
  });

  /*
   * A generation that produced tokens ALWAYS costs at least one credit. Rounding a real generation
   * down to zero would let someone with an empty balance keep generating forever, one cheap turn at
   * a time — the balance would never drop, so the gate would never fire.
   */
  it('never charges zero for a generation that consumed tokens', () => {
    const tiny: TokenUsage = { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };

    expect(creditsForUsage(tiny, 'claude-sonnet-5', config)).toBeGreaterThanOrEqual(1);
  });

  it('charges nothing for a generation that produced nothing', () => {
    const nothing: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

    expect(creditsForUsage(nothing, 'claude-sonnet-5', config)).toBe(0);
  });

  /* Cached input must be dramatically cheaper than uncached, or the whole §4.2.8 effort bought nothing. */
  it('prices cached input ~10x cheaper than uncached', () => {
    const uncached = rawCostUsd(
      { promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      'claude-sonnet-5',
    );
    const cached = rawCostUsd(
      { promptTokens: 0, completionTokens: 0, cacheReadTokens: 100_000, cacheCreationTokens: 0 },
      'claude-sonnet-5',
    );

    expect(cached).toBeCloseTo(uncached / 10, 5);
  });
});

describe('ledger', () => {
  it('derives balance from the latest row, never a counter', async () => {
    await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });
    await ledger.append({ userId: 'u1', delta: -30, reason: 'generation' });
    await ledger.append({ userId: 'u1', delta: 50, reason: 'purchase', paymentRef: 'pi_1' });

    expect(await ledger.balance('u1')).toBe(120);
  });

  it('starts a new user at zero', async () => {
    expect(await ledger.balance('nobody')).toBe(0);
  });

  it('keeps users isolated', async () => {
    await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });

    expect(await ledger.balance('u2')).toBe(0);
  });

  /*
   * GRANT INTEGRITY (§4.5.4). Re-verification, an OAuth re-link, or two tabs racing all try to grant.
   * Exactly one may land — ever. This is the test that stands in for the partial unique index.
   */
  it('refuses a second grant to the same user', async () => {
    await ledger.append({ userId: 'u1', delta: 1000, reason: 'grant' });

    await expect(ledger.append({ userId: 'u1', delta: 1000, reason: 'grant' })).rejects.toThrow(DuplicateGrantError);
    expect(await ledger.balance('u1')).toBe(1000);
  });

  it('survives concurrent grant attempts with exactly one grant', async () => {
    const attempts = Array.from({ length: 5 }, () => ensureSignupGrant('u1', 1000));
    await Promise.all(attempts);

    const rows = await ledger.list('u1');

    expect(rows.filter((r) => r.reason === 'grant')).toHaveLength(1);
    expect(await ledger.balance('u1')).toBe(1000);
  });

  it('reports a duplicate grant as a no-op, not an error, to the caller', async () => {
    expect(await ensureSignupGrant('u1', 1000)).not.toBeNull();
    expect(await ensureSignupGrant('u1', 1000)).toBeNull();
  });

  /*
   * PAYMENT IDEMPOTENCY (§4.6). Stripe RETRIES deliveries — that is a feature. A handler that credits
   * on every delivery hands free credits to anyone who can make us return a 500.
   */
  it('refuses to credit the same payment twice', async () => {
    await ledger.append({ userId: 'u1', delta: 5000, reason: 'purchase', paymentRef: 'cs_test_123' });

    await expect(
      ledger.append({ userId: 'u1', delta: 5000, reason: 'purchase', paymentRef: 'cs_test_123' }),
    ).rejects.toThrow(DuplicatePaymentError);

    expect(await ledger.balance('u1')).toBe(5000);
  });

  /*
   * A generation MAY overdraw: we settle after the tokens are spent, and §4.2.1 forbids killing an
   * in-flight generation for balance. Refusing the row would mean we ate the cost AND lost the audit
   * trail. The gate on the NEXT generation is what stops the bleeding.
   */
  it('allows a generation debit to overdraw the balance', async () => {
    await ledger.append({ userId: 'u1', delta: 10, reason: 'grant' });

    const row = await ledger.append({ userId: 'u1', delta: -500, reason: 'generation', generationId: 'g1' });

    expect(row.balanceAfter).toBe(-490);
  });

  /* But nothing else may. A purchase or refund that computes negative is a BUG, not a business case. */
  it('refuses a non-generation entry that would go negative', async () => {
    await expect(ledger.append({ userId: 'u1', delta: -5, reason: 'refund' })).rejects.toThrow(/negative/i);
  });

  it('is append-only — a refund is a new row, not an edit', async () => {
    await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });
    await ledger.append({ userId: 'u1', delta: -40, reason: 'generation', generationId: 'g1' });
    await ledger.append({ userId: 'u1', delta: 40, reason: 'refund', generationId: 'g1' });

    const rows = await ledger.list('u1');

    expect(rows).toHaveLength(3);
    expect(await ledger.balance('u1')).toBe(100);
  });

  /* Serialized appends: two concurrent settlements must not both read the same stale balance. */
  it('does not lose an update under concurrent appends', async () => {
    await ledger.append({ userId: 'u1', delta: 1000, reason: 'grant' });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ledger.append({ userId: 'u1', delta: -10, reason: 'generation', generationId: `g${i}` }),
      ),
    );

    expect(await ledger.balance('u1')).toBe(900);
  });
});

describe('credit gate', () => {
  it('blocks a zero balance when billing is enforced', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const result = await checkCreditGate({ userId: 'broke' });

    expect(result.allowed).toBe(false);
  });

  /*
   * BILLING_ENFORCED=false is the shipping default: beta mode. Usage is still fully recorded — but a
   * zero balance blocks nobody. Getting this backwards would wall off every user on day one.
   */
  it('allows a zero balance when billing is NOT enforced, and still records', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'false');

    const result = await checkCreditGate({ userId: 'broke' });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('unmetered');
  });

  it('allows a positive balance when enforced', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');
    await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });

    const result = await checkCreditGate({ userId: 'u1' });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('credits');
  });

  /* BYOK bypasses the balance entirely — their key pays, so our balance is irrelevant (§4.6.1). */
  it('lets a BYOK user through with a zero balance', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'true');

    const result = await checkCreditGate({ userId: 'pro', byok: true });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('byok');
  });
});

describe('settlement', () => {
  const usage: TokenUsage = {
    promptTokens: 1000,
    completionTokens: 2000,
    cacheReadTokens: 5000,
    cacheCreationTokens: 0,
  };

  it('debits the ledger for a completed generation', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({ userId: 'u1', generationId: 'g1', model: 'claude-sonnet-5', usage });

    expect(settlement!.creditsCharged).toBeGreaterThan(0);
    expect(await ledger.balance('u1')).toBe(10_000 - settlement!.creditsCharged);
  });

  /*
   * BYOK generations are RECORDED but charged ZERO (§4.5.4 point 6). Their key already paid the
   * provider; charging credits as well is double-billing a paying subscriber.
   */
  it('charges a BYOK generation nothing, but still records it', async () => {
    await ledger.append({ userId: 'pro', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'pro',
      generationId: 'g1',
      model: 'claude-sonnet-5',
      usage,
      byok: true,
    });

    expect(settlement!.creditsCharged).toBe(0);
    expect(await ledger.balance('pro')).toBe(10_000);
  });

  /*
   * STOP (§4.12): billed for what was actually consumed to the abort point, never the full estimate.
   * A stopped generation reaches settlement with whatever totals it accumulated — so a small usage
   * produces a small charge, and that is the whole contract.
   */
  it('charges a stopped generation only for the tokens it actually consumed', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const aborted: TokenUsage = { promptTokens: 50, completionTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const full = await settleGeneration({
      userId: 'u2',
      generationId: 'g-full',
      model: 'claude-sonnet-5',
      usage: { promptTokens: 50, completionTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    const stopped = await settleGeneration({
      userId: 'u1',
      generationId: 'g-stop',
      model: 'claude-sonnet-5',
      usage: aborted,
    });

    expect(stopped!.creditsCharged).toBeLessThan(full!.creditsCharged);
  });
});

/**
 * AUTO-REFUND on a hard failure (§4.6).
 *
 * The provider still bills US for the tokens a failed generation burned — we do not get those back.
 * But the user asked for a game and got an error, and charging them for our failure is indefensible.
 * We eat the cost.
 */
describe('auto-refund on failure', () => {
  const usage: TokenUsage = {
    promptTokens: 1000,
    completionTokens: 2000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  it('returns the user to their prior balance after a failed generation', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-fail',
      model: 'claude-sonnet-5',
      usage,
    });

    expect(await ledger.balance('u1')).toBeLessThan(10_000);

    await refundGeneration('u1', 'g-fail', settlement!.creditsCharged, 'Automatic refund — the generation failed');

    expect(await ledger.balance('u1')).toBe(10_000);
  });

  /*
   * The debit is NOT deleted. Append-only means the history stays honest — the charge happened, the
   * refund happened, and both are visible. A ledger that erased its mistakes could not be audited.
   */
  it('records the refund as a compensating row, never by erasing the debit', async () => {
    await ledger.append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-fail',
      model: 'claude-sonnet-5',
      usage,
    });
    await refundGeneration('u1', 'g-fail', settlement!.creditsCharged, 'Automatic refund');

    const rows = await ledger.list('u1');

    expect(rows.map((r) => r.reason).sort()).toEqual(['generation', 'grant', 'refund']);

    // Both rows point at the same generation, so the pairing is auditable.
    const paired = rows.filter((r) => r.generationId === 'g-fail');
    expect(paired).toHaveLength(2);
  });
});

/**
 * THE FOREIGN KEY (§4.5.4, `generations.ts`).
 *
 * `credit_ledger.generation_id` REFERENCES `generations(id)`. Postgres rejects a debit whose
 * generation row does not exist (`23503`), and `settleGeneration` may never throw — so a missing row
 * is caught, logged, and swallowed, and the generation bills ZERO. No crash, no failing build, no
 * broken feature: just the entire platform running free on our own API key.
 *
 * `FsLedger` has no foreign key, which is exactly why this class exists. Without a ledger that
 * enforces what Postgres enforces, the production failure is invisible to every test we have.
 */
class ForeignKeyLedger extends FsLedger {
  constructor(
    dir: string,
    private readonly _generations: GenerationStore & { has(id: string): boolean },
  ) {
    super(dir);
  }

  override async append(entry: Parameters<FsLedger['append']>[0]) {
    if (entry.generationId && !this._generations.has(entry.generationId)) {
      throw new Error(
        `insert or update on table "credit_ledger" violates foreign key constraint ` +
          `"credit_ledger_generation_id_fkey"`,
      );
    }

    return super.append(entry);
  }
}

describe('the generation row a debit points at', () => {
  const usage: TokenUsage = {
    promptTokens: 1000,
    completionTokens: 2000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  let rows: Map<string, GenerationUpsert>;

  beforeEach(() => {
    rows = new Map();

    const store = {
      has: (id: string) => rows.has(id),
      async upsert(row: GenerationUpsert) {
        rows.set(row.id, { ...rows.get(row.id), ...row });
      },
      async list() {
        return [];
      },
    };

    setGenerationStore(store);
    setLedger(new ForeignKeyLedger(tmp, store));
  });

  afterEach(() => {
    setGenerationStore(undefined);
  });

  /*
   * The bug this test exists for: settlement appended the debit while the generation row was still
   * only ever written to the local filesystem, so in Postgres the FK rejected every single debit and
   * `settleGeneration` swallowed it. Every generation billed zero.
   */
  it('is written BEFORE the debit, so the ledger can actually charge for it', async () => {
    await getLedger().append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-fk',
      model: 'claude-sonnet-5',
      usage,
    });

    expect(settlement).not.toBeNull();
    expect(settlement!.creditsCharged).toBeGreaterThan(0);
    expect(await getLedger().balance('u1')).toBeLessThan(10_000);
    expect(rows.has('g-fk')).toBe(true);
  });

  /* The anchor carries the usage, so the row is honest even if the proxy never gets to enrich it. */
  it('anchors the row with the user, model and tokens the debit was computed from', async () => {
    await getLedger().append({ userId: 'u1', delta: 10_000, reason: 'grant' });
    await settleGeneration({ userId: 'u1', generationId: 'g-fk', model: 'claude-sonnet-5', usage });

    expect(rows.get('g-fk')).toMatchObject({
      id: 'g-fk',
      userId: 'u1',
      model: 'claude-sonnet-5',
      promptTokens: 1000,
      completionTokens: 2000,
    });
  });

  /* BYOK charges nothing — but the row still has to exist, because the generation still happened. */
  it('writes the row even for a BYOK generation that is charged zero', async () => {
    await settleGeneration({
      userId: 'pro',
      generationId: 'g-byok',
      model: 'claude-sonnet-5',
      usage,
      byok: true,
    });

    expect(rows.has('g-byok')).toBe(true);
  });

  /*
   * A refund names the same generation. If the anchor were the debit's private business, the refund
   * would hit the same FK — and a failed generation would stay charged.
   */
  it('lets the refund for a failed generation reference the same row', async () => {
    await getLedger().append({ userId: 'u1', delta: 10_000, reason: 'grant' });

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g-fail',
      model: 'claude-sonnet-5',
      usage,
    });
    await refundGeneration('u1', 'g-fail', settlement!.creditsCharged, 'Automatic refund');

    expect(await getLedger().balance('u1')).toBe(10_000);
  });
});

/**
 * Pack pricing vs. the credit-charging formula — the two halves of the margin (SPEC §4.6).
 *
 * `credits_charged = ceil(raw / CREDIT_UNIT_COST_USD * CREDIT_MARGIN)` only earns `CREDIT_MARGIN` if a
 * credit RETAILS at `CREDIT_UNIT_COST_USD`. Nothing in the code connected those two facts, and they
 * drifted: packs shipped at $0.003/credit against a 3.34x setting, so the real margin was 1.01x on the
 * smallest pack and **0.84x on the largest** — losing ~19% on every generation, worst on the best
 * customers, silently, because each file was internally sensible.
 *
 * This is the money path with no error state: a wrong margin does not throw, fail a test, or alert. It
 * just quietly sells below cost until someone does the division by hand.
 */
describe('credit pack margins', () => {
  const config = { creditUnitCostUsd: 0.01, margin: 3.34 };

  it.each(CREDIT_PACKS.filter((p) => p.isActive).map((p) => [p.id, p] as const))(
    '%s earns at least the floor',
    (_id, pack) => {
      expect(packMargin(pack, config)).toBeGreaterThanOrEqual(MIN_PACK_MARGIN);
    },
  );

  it('never sells a credit below what the formula assumes one is worth', () => {
    // The direct statement of the bug: price per credit < CREDIT_UNIT_COST_USD shrinks CREDIT_MARGIN.
    for (const pack of CREDIT_PACKS.filter((p) => p.isActive)) {
      const pricePerCredit = pack.priceCents / 100 / pack.credits;
      expect(pricePerCredit).toBeGreaterThan(config.creditUnitCostUsd * 0.6);
    }
  });

  it('lets bigger packs discount, but never inverts into losing more on better customers', () => {
    const sorted = [...CREDIT_PACKS.filter((p) => p.isActive)].sort((a, b) => a.credits - b.credits);
    const margins = sorted.map((p) => packMargin(p, config));

    // A volume discount is fine (margins may fall); dropping under the floor is not.
    expect(Math.min(...margins)).toBeGreaterThanOrEqual(MIN_PACK_MARGIN);
  });

  it('reproduces the shipped defect, so the arithmetic is pinned and not merely asserted', () => {
    const shipped = { id: 'studio', name: 'Studio', credits: 40_000, priceCents: 10_000, isActive: true };

    // $100 / 40,000 credits = $0.0025 each -> 3.34 x (0.0025/0.01) = 0.835x. Below 1: a loss per sale.
    expect(packMargin(shipped, config)).toBeCloseTo(0.835, 3);
    expect(packMargin(shipped, config)).toBeLessThan(1);
  });

  /*
   * The whole point, end to end, on the REAL measured creation rather than a magic number: the
   * optimized "make me a kart racer" (spec/context-budget.md) is 12,862 output tokens against a
   * 111,659-token cold prefix. Whatever we charge for that must exceed what it costs us — on EVERY
   * pack, including the biggest, which is exactly where it did not.
   */
  it('covers a real cold creation on every pack, largest included', () => {
    const coldCreation: TokenUsage = {
      promptTokens: 0,
      completionTokens: 12_862,
      cacheReadTokens: 0,
      cacheCreationTokens: 111_659,
    };

    const raw = rawCostUsd(coldCreation, 'claude-opus-4-8');
    expect(raw).toBeCloseTo(1.44, 2);

    const credits = creditsForUsage(coldCreation, 'claude-opus-4-8', { ...config } as never);

    for (const pack of CREDIT_PACKS.filter((p) => p.isActive)) {
      const revenue = credits * (pack.priceCents / 100 / pack.credits);
      expect(revenue).toBeGreaterThan(raw);
    }
  });
});
