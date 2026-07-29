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
import {
  COLD_CREATION_USAGE,
  creditsForUsage,
  getBillingConfig,
  grantHeadroom,
  kieDefaultModel,
  kieRates,
  KIE_MODEL_RATES,
  MIN_GRANT_HEADROOM,
  MODEL_RATES,
  providerRates,
  rawCostUsd,
  ratesFor,
  ratesFromBase,
  type TokenUsage,
} from './rates';
import { invalidateMarketPricesCache, promoteMarketPrices } from './market-price-store';
import type { ObjectStore } from '~/lib/.server/storage';
import { BAKED_MARKET_PRICES } from './baked-market-prices';
import {
  DEFAULT_PLATFORM_PROVIDER,
  getPlatformModel,
  getPlatformProvider,
  PLATFORM_MODEL,
  PLATFORM_MODEL_BY_PROVIDER,
  PLATFORM_PROVIDERS,
} from '~/lib/.server/agent/config';
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
import { DEFAULT_SANDBOX_VM_TIER, SANDBOX_VM_TIERS, sandboxVmTier } from '~/lib/.server/sandbox/config';
import {
  DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
  DEFAULT_SANDBOX_VM_USD_PER_HOUR,
  effectivePackMargin,
  getVmCostConfig,
  MEASURED_VM_TIER_USD_PER_HOUR,
  packsUnderVmAdjustedFloor,
  tierCoverage,
  vmOverheadUsdPerCredit,
  vmUsdPerHourForTier,
} from './vm-cost';
import { setGenerationStore, type GenerationStore, type GenerationUpsert } from './generations';

let tmp: string;
let ledger: FsLedger;

/**
 * ⚠️ THE `oauth.spec.ts` TRAP, and it is armed for every test in this file.
 *
 * `env()` falls back to `process.env`, and vitest loads `.env.local` — so an "empty" context is NOT
 * empty, it is the developer's real configuration. Once `KIE_DEFAULT_MODEL`/`KIE_*_DOLLARS` became
 * config, every rate assertion below silently read whatever the operator happened to be running: the
 * derivation invariants would fail on the machine of the one person who had configured a custom rate,
 * and CI (which has no `.env.local`) would stay green and call them wrong. Scrub first, stub per-test.
 */
const KIE_ENV = [
  /*
   * 🔴 `LLM_MODEL` BELONGS HERE BECAUSE IT OUTRANKS `KIE_DEFAULT_MODEL`, and its absence was this trap
   * firing a second time in the same file.
   *
   * The list was written when `kieEnvModel` read only `KIE_DEFAULT_MODEL`. The 2026-07-20 fix gave it the
   * same `LLM_MODEL` > `KIE_DEFAULT_MODEL` precedence as `getPlatformModel` — and nothing re-checked the
   * scrub list, so the higher-precedence half of the pair stayed unscrubbed. The moment an operator set
   * `LLM_MODEL` in `.env.local` (which is now the DOCUMENTED way to choose the platform model), it won the
   * precedence inside the test, `KIE_DEFAULT_MODEL` was never consulted, and "reaches the provider model
   * list" failed — on that developer's machine only, with CI green, blaming code they had not touched.
   *
   * Scrub the whole precedence chain, not the variable that happens to be under test.
   */
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
] as const;

/**
 * The SAME trap, for the sandbox VM cost inputs (T11, `vm-cost.ts`).
 *
 * `getVmCostConfig` reads through `envNumber` → `env()` → `process.env`, so an operator with
 * `SANDBOX_VM_USD_PER_HOUR` in their `.env.local` (which `.env.example` tells them to set) would have
 * the margin-floor assertions below silently graded against THEIR rate instead of the measured Pico
 * one. Scrubbed here, stubbed per-test where a specific value is the point.
 *
 * Kept as its own list rather than appended to `KIE_ENV`: these are not KIE variables, and a scrub
 * list that stops describing its own contents is how `LLM_MODEL` went missing from the one above.
 */
const SANDBOX_VM_ENV = [
  'SANDBOX_VM_USD_PER_HOUR',
  'SANDBOX_EST_VM_HOURS_PER_KCREDIT',

  /*
   * 🔴 `CODESANDBOX_VM_TIER` BELONGS HERE BECAUSE THE PRICE NOW DERIVES FROM IT — the third time this
   * trap has fired in this repo, and the second time in this file (see `LLM_MODEL` above).
   *
   * The list was written when `SANDBOX_VM_USD_PER_HOUR` defaulted to a flat constant, so the tier was
   * not in its precedence chain. The 2026-07-28 fix made `getVmCostConfig` default to
   * `vmUsdPerHourForTier(sandboxVmTier(context))` — and the owner's `.env.local` sets
   * `CODESANDBOX_VM_TIER=Nano`, which `env()` resolves through `process.env`. Every "defaults when
   * unset" assertion below then graded Nano's $0.149 against Pico's $0.074, ON THAT DEVELOPER'S
   * MACHINE ONLY, with CI green.
   *
   * When you add a variable to a precedence chain, add it to every scrub list that already names its
   * siblings.
   */
  'CODESANDBOX_VM_TIER',
] as const;

/**
 * The SAME trap, for the flat creation price (§4.6, `creationFlatCredits`).
 *
 * `getBillingConfig` reads `CREATION_FLAT_CREDITS` through `envNumber` → `env()` → `process.env`, so
 * an operator with the var in their `.env.local` (the documented way to reprice creations without a
 * deploy) would have every `getBillingConfig()`-derived assertion in this file — and the flat-pricing
 * suite in `creation-flat.spec.ts` — silently graded against THEIR price, on that machine only, with
 * CI green. Own list for the same reason `SANDBOX_VM_ENV` is: it is not a KIE variable, and a scrub
 * list that stops describing its contents is how `LLM_MODEL` went missing above.
 */
const CREATION_ENV = ['CREATION_FLAT_CREDITS'] as const;

beforeEach(async () => {
  for (const key of [...KIE_ENV, ...SANDBOX_VM_ENV, ...CREATION_ENV]) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  /*
   * The marketplace price cache is MODULE state — a list promoted by one test would silently price
   * every later assertion in the file. Same species of bleed as a leftover env stub.
   */
  invalidateMarketPricesCache();

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  ledger = new FsLedger(tmp);
  setLedger(ledger);

  /*
   * 🔴 THE SAME TRAP AGAIN, ONE SEAM TO THE LEFT — and this one wrote to the operator's REAL data.
   *
   * `settleGeneration` anchors a `generations` row before its debit, and `getGenerationStore` falls
   * back to an `FsGenerationStore` at `platformDataDir()`. Only the foreign-key `describe` below
   * stubbed it, so every other test in this file — `settleGeneration` is called in a dozen of them —
   * deposited its fixtures into the developer's `.data/generations/`: `g1`, `g-full`, `g-stop`, and a
   * row literally named `g-fail` recorded as a COMPLETED generation charging 14 credits.
   *
   * That is not untidiness. `buildUsageReport` lists that directory, so fake rows land in the §4.10
   * admin dashboard's failure rate, credits charged, and (as of Stage C) the rescue-marker counts —
   * the exact numbers an operator reads to decide whether the platform is healthy. Found by driving
   * the real app in Stage D and noticing the fixtures had this test run's timestamp.
   *
   * Same species as `oauth.spec.ts`'s `env()` fallback and `chat-index.spec.ts` depositing ~200 real
   * rows: A SEAM THAT LOOKS EMPTY IN A TEST IS SILENTLY RESOLVING TO THE REAL THING.
   *
   * The FK `describe` sets its own store in a nested `beforeEach`, which runs after this one and wins.
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

/** A Map-backed ObjectStore: promotions in these tests never touch disk or S3. */
function memoryStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();

  return {
    backend: 'filesystem',
    put: async (key, bytes) => void objects.set(key, bytes),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
    list: async (prefix) =>
      [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, size: v.length })),
  };
}

/** Promote the baked list plus extra/overridden LLM rows — the admin-panel path, in one line. */
async function promoteLlmRows(rows: Record<string, { inputPerMTok: number; outputPerMTok: number }>) {
  const result = await promoteMarketPrices(memoryStore(), {
    ...BAKED_MARKET_PRICES,
    llm: { ...BAKED_MARKET_PRICES.llm, ...rows },
  });

  if (!result.ok) {
    throw new Error(`test list refused: ${result.errors.join('; ')}`);
  }
}

const config = getBillingConfig();

describe('rate table', () => {
  /*
   * THE 2x RULE. `proxy.ts` writes every cache entry with `ttl: '1h'`, and the 1-hour tier costs 2x
   * base input to write — not the 1.25x of the 5-minute default. If someone "corrects" this to 1.25x
   * to match the docs' headline number, every generation silently under-charges and the margin quietly
   * erodes. Nothing else in the system would notice.
   *
   * Both loops walk EVERY provider, not just Anthropic. A provider-specific table using the 1.25x
   * five-minute rate is exactly the bug this pair exists to catch — and it would have walked straight
   * past a table these loops did not visit.
   */
  it('bills cache WRITES at 2x input on every provider — the 1h tier, not the 1.25x default', () => {
    for (const [provider, table] of Object.entries(providerRates())) {
      for (const [model, rates] of Object.entries(table)) {
        expect(rates.cacheWritePerMTok, `${provider}/${model}`).toBeCloseTo(rates.inputPerMTok * 2, 5);
      }
    }
  });

  it('bills cache READS at 0.1x input on every provider — the margin lever', () => {
    for (const [provider, table] of Object.entries(providerRates())) {
      for (const [model, rates] of Object.entries(table)) {
        expect(rates.cacheReadPerMTok, `${provider}/${model}`).toBeCloseTo(rates.inputPerMTok * 0.1, 5);
      }
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
    const rates = ratesFor('some-model-we-have-never-heard-of', 'Anthropic');

    expect(rates.inputPerMTok).toBeGreaterThan(0);
    expect(rates.outputPerMTok).toBeGreaterThan(0);
  });

  /* Same rule, second axis. An unknown PROVIDER is just as capable of billing zero as an unknown model. */
  it('never zero-rates an unknown provider', () => {
    const rates = ratesFor(PLATFORM_MODEL, 'SomeResellerWeHaveNeverHeardOf');

    expect(rates.inputPerMTok).toBeGreaterThan(0);
    expect(rates.outputPerMTok).toBeGreaterThan(0);
  });

  /*
   * ⚠️ THE TABLE AND THE SWITCH ARE ONE DECISION IN TWO FILES — the `packMargin` shape of bug.
   *
   * `LLM_PROVIDER` accepts any name in `PLATFORM_PROVIDERS`. If one of those has no rate table, every
   * generation on it falls back to Anthropic list prices: the platform spends at one price and bills
   * the user at another. Nothing throws; the invoices are just wrong, in whichever direction the
   * vendor happens to be cheaper. Adding a provider MUST mean adding its rates.
   */
  it('has a rate table for every provider the platform can be switched to', () => {
    for (const provider of PLATFORM_PROVIDERS) {
      expect(providerRates()[provider], `${provider} can be selected but has no rates`).toBeDefined();

      /*
       * ⚠️ Each provider's OWN default, not one global `PLATFORM_MODEL`.
       *
       * This asserted `providerRates()[provider][PLATFORM_MODEL]` while the platform model was one
       * constant shared by both. That coupling is wrong in principle even when the two happen to agree
       * (as they do today — both default to `claude-opus-5`): a provider's default is a fact about
       * THAT provider's catalogue and pricing, and KIE lists rows Anthropic has never heard of
       * (`claude-opus-4-7`, `claude-fable-5` — see `NO_ANTHROPIC_ROW` below). Demanding every provider
       * price the OTHER provider's model is a question with no useful answer; what must hold is that
       * whatever a provider will actually be asked to run, it can price.
       */
      const model = PLATFORM_MODEL_BY_PROVIDER[provider];
      expect(providerRates()[provider][model], `${provider} cannot price its own default ${model}`).toBeDefined();
    }
  });

  /*
   * ⚠️ THE INVARIANT THAT LETS `KIE_INPUT_DOLLARS` BE SAFE ON ITS OWN.
   *
   * `ratesFromBase` derives the two cache classes from input, and an operator repricing a model states
   * only input+output. That is only honest if derivation reproduces every hand-written row we have —
   * otherwise the derived numbers are a second, quietly different opinion about a price we already
   * know. If a vendor ever quotes cache off-multiple, this test is where that fact must be recorded
   * (by passing explicit values), rather than discovered later in an invoice.
   */
  it('derives every baked row exactly, so the derivation is not a second opinion on a known price', () => {
    for (const [provider, table] of Object.entries(providerRates())) {
      for (const [model, rates] of Object.entries(table)) {
        const derived = ratesFromBase(rates.inputPerMTok, rates.outputPerMTok);

        /*
         * `toBeCloseTo`, not `toEqual`: 3 * 0.1 is 0.30000000000000004 in binary float, so a derived
         * Sonnet row is not BIT-identical to its hand-written one. That is an artifact of the
         * representation and not a disagreement about the price — the claim under test is that the
         * numbers are the same money, and at 1e-9 of a dollar per million tokens they are.
         */
        expect(derived.cacheReadPerMTok, `${provider}/${model} cache read`).toBeCloseTo(rates.cacheReadPerMTok, 9);
        expect(derived.cacheWritePerMTok, `${provider}/${model} cache write`).toBeCloseTo(rates.cacheWritePerMTok, 9);
      }
    }
  });
});

describe('KIE rates', () => {
  /*
   * ABSOLUTE prices, pinned row by row — this REPLACED a "uniform 0.4x of Anthropic list" invariant
   * (2026-07-18). The ratio rule was already called out as a coincidence in rates.ts ("EVERY ROW IS
   * LOOKED UP, NEVER DERIVED FROM A RATIO"): the feed's own rows disprove it (sonnet-5 is ~0.283x,
   * haiku ~0.275x, fable-5 is 2x Opus list), so pinning 0.4x was pinning one row's accident as a law.
   * What actually protects billing is that each number matches what KIE charges — verified against
   * KIE's public pricing feed AND (for 4-8/4-7/fable-5) against KIE's own `credits_consumed`.
   *
   * These pin the BAKED table. The runtime table (`kieRates`) starts identical and diverges only by
   * admin promotion — covered in the selector describe below.
   */
  it.each([
    /*
     * The platform default since 2026-07-27 — KIE serves Opus 5 at 4-8's exact rates
     * (owner-confirmed; cache accounting probe-verified the same day, see baked-market-prices.ts).
     */
    ['claude-opus-5', 2.0, 10.0],
    ['claude-opus-4-8', 2.0, 10.0],
    ['claude-opus-4-7', 1.425, 7.15],
    ['claude-opus-4-6', 1.425, 7.15],
    ['claude-fable-5', 4.0, 20.0],
    ['claude-sonnet-5', 0.85, 4.275],
    ['claude-haiku-4-5', 0.275, 1.425],
  ])('prices %s at $%s / $%s — the feed-confirmed numbers', (model, input, output) => {
    expect(KIE_MODEL_RATES[model].inputPerMTok).toBe(input);
    expect(KIE_MODEL_RATES[model].outputPerMTok).toBe(output);
  });

  /* No row beyond the pinned seven can slip in unpinned — the "matches nothing" control. */
  it('pins EVERY baked KIE row (a new row must come with its own pin)', () => {
    expect(Object.keys(KIE_MODEL_RATES).sort()).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
  });

  /* The baked table IS the baked market price list — one source, no second copy to drift. */
  it('derives the baked table from BAKED_MARKET_PRICES.llm exactly', () => {
    for (const [model, row] of Object.entries(BAKED_MARKET_PRICES.llm)) {
      expect(KIE_MODEL_RATES[model]).toEqual(ratesFromBase(row.inputPerMTok, row.outputPerMTok));
    }

    expect(Object.keys(KIE_MODEL_RATES).sort()).toEqual(Object.keys(BAKED_MARKET_PRICES.llm).sort());
  });

  /*
   * The operator's decision, made explicit: pass the discount through rather than bank it. Credits are
   * cost-proportional, so cheaper rates mean FEWER credits per generation — the same $50 buys ~2.5x
   * more work and the margin per pack is untouched. If someone later wants the discount as profit, the
   * lever is `CREDIT_MARGIN`, not this table — and this test is where they will find that out.
   */
  /*
   * Compares `claude-opus-4-8` — the one model BOTH providers price — rather than the platform model,
   * which is now per-provider. Comparing a model Anthropic cannot price would silently exercise
   * `ratesFor`'s most-expensive fallback and measure nothing.
   */
  it('makes the same generation cost ~2.5x fewer credits than Anthropic', () => {
    const onAnthropic = creditsForUsage(COLD_CREATION_USAGE, 'claude-opus-4-8', 'Anthropic', config);
    const onKie = creditsForUsage(COLD_CREATION_USAGE, 'claude-opus-4-8', 'KIE', config);

    expect(onAnthropic / onKie).toBeCloseTo(2.5, 1);
  });
});

/**
 * `KIE_DEFAULT_MODEL` + the marketplace price list (2026-07-18; supersedes the env-var price group).
 *
 * The model SELECTOR stays in env; the PRICE side moved to the admin-promoted marketplace price list
 * (`market-price-store.ts`). Every test here guards a way of getting that wrong that would bill real
 * money and throw nothing.
 */
describe('the KIE model selector + the marketplace price list', () => {
  /* The baseline: nothing set, nothing promoted — the runtime table IS the baked table. */
  it('serves the baked table when nothing is promoted', () => {
    expect(kieDefaultModel()).toBeUndefined();
    expect(kieRates()).toEqual(KIE_MODEL_RATES);
  });

  /*
   * 🔴 THE RULE THIS WHOLE FEATURE RESTS ON.
   *
   * `ratesFor` falls back to the provider's MOST EXPENSIVE row for a model it does not know — so
   * naming a model without pricing it does not fail, it bills every generation at the priciest row,
   * forever, silently. "Is this model configured?" and "do we know what it costs?" are the same
   * question; the answer now lives in the price list, so an unpriced selector is refused with
   * directions to the Admin panel.
   */
  it('refuses a KIE_DEFAULT_MODEL the active price list does not price', () => {
    vi.stubEnv('KIE_DEFAULT_MODEL', 'gpt-5-6-sol');
    expect(() => kieDefaultModel()).toThrow(/Marketplace price list/);
  });

  /* The admin-panel path: promote a list with the row, and the selector is accepted at THAT price. */
  it('accepts the selector once a promoted list prices it, with cache derived from ITS base', async () => {
    await promoteLlmRows({ 'gpt-5-6-sol': { inputPerMTok: 1.4, outputPerMTok: 8.4 } });
    vi.stubEnv('KIE_DEFAULT_MODEL', 'gpt-5-6-sol');

    expect(kieDefaultModel()).toBe('gpt-5-6-sol');

    const rates = ratesFor('gpt-5-6-sol', 'KIE');
    expect(rates.inputPerMTok).toBe(1.4);
    expect(rates.outputPerMTok).toBe(8.4);
    expect(rates.cacheReadPerMTok, 'derived 0.1x').toBeCloseTo(0.14, 9);
    expect(rates.cacheWritePerMTok, 'derived 2x — the 1h tier').toBeCloseTo(2.8, 9);
  });

  /*
   * 🔴 A promoted reprice must move the CACHE prices with it — the `packMargin` shape of bug. The
   * list carries input/output only (validation REFUSES cache keys), so a half-repriced row cannot
   * even be expressed.
   */
  it('re-derives cache from the NEW input rate when a promotion reprices a baked model', async () => {
    await promoteLlmRows({ 'claude-opus-4-8': { inputPerMTok: 1, outputPerMTok: 10 } });

    const rates = ratesFor('claude-opus-4-8', 'KIE');
    expect(rates.inputPerMTok).toBe(1);
    expect(rates.cacheReadPerMTok, 'NOT the baked 0.2').toBeCloseTo(0.1, 5);
    expect(rates.cacheWritePerMTok, 'NOT the baked 4.0').toBeCloseTo(2.0, 5);
  });

  /*
   * 🔴 THE RETIRED ENV PRICE VARS MUST STOP THE SHOW, NEVER BE SILENTLY IGNORED. A deploy still
   * carrying one believes it is stating a price that nothing reads — the exact "rates set but
   * ignored" trap the old kieModelOverride refused, one level up.
   */
  it.each([
    ['KIE_INPUT_DOLLARS'],
    ['KIE_OUTPUT_DOLLARS'],
    ['KIE_CACHED_INPUT'],
    ['KIE_CACHED_WRITES'],
    ['PREMIUM_INPUT_DOLLARS'],
    ['PREMIUM_OUTPUT_DOLLARS'],
  ])('refuses the retired %s rather than ignoring it', (key) => {
    vi.stubEnv(key, '2');
    expect(() => kieRates()).toThrow(/retired/);
    expect(() => kieRates()).toThrow(/Marketplace price list/);
  });

  /* The configured model becomes KIE's default — that is what "default" in the name means. */
  it('becomes the platform model on KIE, priced by its own row', async () => {
    await promoteLlmRows({ 'gpt-5-6-sol': { inputPerMTok: 1.57, outputPerMTok: 8.4 } });
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('LLM_MODEL', undefined as unknown as string);
    vi.stubEnv('KIE_DEFAULT_MODEL', 'gpt-5-6-sol');

    expect(getPlatformModel({})).toBe('gpt-5-6-sol');
    expect(
      rawCostUsd(
        { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        'gpt-5-6-sol',
        'KIE',
      ),
    ).toBeCloseTo(1.57, 5);
  });

  /*
   * 🔴 THE TWO VARS MUST NOT MEAN "the model" AND "the price of a DIFFERENT model".
   *
   * `LLM_MODEL` outranks `KIE_DEFAULT_MODEL`. That is only safe because whatever wins must be priced
   * in its own right — otherwise `LLM_MODEL=x` with `KIE_DEFAULT_MODEL=y` would run `x` and bill it at
   * `y`'s rates, which is the precise failure this precedence chain could otherwise introduce.
   */
  it('never prices LLM_MODEL at KIE_DEFAULT_MODEL rates', async () => {
    await promoteLlmRows({ 'gpt-5-6-sol': { inputPerMTok: 1.57, outputPerMTok: 8.4 } });
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('KIE_DEFAULT_MODEL', 'gpt-5-6-sol');

    // Priced in its own right: allowed, at ITS price, not gpt's.
    vi.stubEnv('LLM_MODEL', 'claude-opus-4-8');
    expect(getPlatformModel({})).toBe('claude-opus-4-8');
    expect(ratesFor('claude-opus-4-8', 'KIE').inputPerMTok).toBe(2.0);

    // Unpriced: refused, rather than borrowing the selector's rates.
    vi.stubEnv('LLM_MODEL', 'some-third-model');
    expect(() => getPlatformModel({})).toThrow(/some-third-model/);
  });

  /*
   * 🔴 A MODEL THAT IS PRICED BUT NOT LISTED IS BILLED AS ITSELF AND RUN AS SOMETHING ELSE.
   *
   * `stream-text.ts` (the enhancer's path) falls back to `modelsList[0]` for a model it cannot find,
   * behind a `logger.warn` — so a priced-but-unlisted model would run Opus 4.8 while settlement charged
   * the configured model's rates. The proxy hands `model` straight to `getModelInstance` and never had
   * the problem, which is exactly why this would have hidden. The provider must OFFER what we price.
   */
  it('reaches the provider model list, so both money paths run what we bill', async () => {
    const kieModule = await import('~/lib/modules/llm/providers/kie');
    const provider = new kieModule.default();

    expect(await provider.getDynamicModels(undefined, undefined, {})).toEqual([]);

    const listed = await provider.getDynamicModels(undefined, undefined, { KIE_DEFAULT_MODEL: 'gpt-5-6-sol' });
    expect(listed.map((m) => m.name)).toEqual(['gpt-5-6-sol']);

    expect(
      await provider.getDynamicModels(undefined, undefined, { KIE_DEFAULT_MODEL: 'claude-opus-4-8' }),
      'already a static row — listing it twice is not a fix',
    ).toEqual([]);
  });
});

describe('the signup grant buys the hook', () => {
  /*
   * ⚠️ THE GRANT SIZE AND THE PLATFORM PROVIDER ARE ONE NUMBER IN TWO FILES.
   *
   * A grant is denominated in credits; credits are cost-proportional; cost depends on the provider. So
   * `SIGNUP_GRANT_CREDITS` has no fixed meaning on its own — 500 is ~2.6x a cold creation on KIE and
   * ~1.0x on Anthropic, where the user's FIRST free prompt would exhaust the grant and land them
   * negative (the gate runs once, before the model, and settlement can never refuse — §4.2.1).
   *
   * That failure lands on the single moment the whole funnel rests on: a new user's first prototype.
   * It is also completely silent — the creation succeeds, and the product just quietly has no second
   * step. This test is the tripwire on tuning either number without the other.
   */
  /*
   * ⚠️ Reads the ACTUALLY CONFIGURED provider, not `DEFAULT_PLATFORM_PROVIDER`.
   *
   * `env()` falls back to `process.env` and vitest loads `.env.local`, so `getBillingConfig()` already
   * sees the developer's real `SIGNUP_GRANT_CREDITS`. Pinning the provider to the code default while
   * the grant comes from the environment compares two halves of DIFFERENT configurations — which is
   * how this test failed at 1.04x on a machine that had correctly set `LLM_PROVIDER=KIE` and 500
   * together. Both halves must come from the same place, or the guard reports on a config nobody runs.
   *
   * Reading both from the environment is what makes it honest in every world: CI has no `.env.local`
   * (Anthropic + 1000 -> 2.1x), a KIE machine reads KIE + 500 -> 2.4x, and the one combination that
   * must never ship — Anthropic + 500 -> 1.04x — is the one that fails.
   */
  it('covers a cold creation with room to iterate, on the configured provider', () => {
    const headroom = grantHeadroom(config, PLATFORM_MODEL, getPlatformProvider());

    expect(headroom).toBeGreaterThanOrEqual(MIN_GRANT_HEADROOM);
  });

  /* The number the grant is being sized toward. Documents WHY 500 is not yet the default. */
  it('shows 500 credits is right on KIE and not yet right on Anthropic', () => {
    const target = { ...config, signupGrantCredits: 500 };

    expect(grantHeadroom(target, PLATFORM_MODEL, 'KIE')).toBeGreaterThanOrEqual(MIN_GRANT_HEADROOM);
    expect(grantHeadroom(target, PLATFORM_MODEL, 'Anthropic')).toBeLessThan(MIN_GRANT_HEADROOM);
  });
});

describe('the platform provider switch', () => {
  /*
   * `env()` falls back to `process.env`, and vitest loads `.env.local` — so an "empty" context is not
   * empty (the trap `oauth.spec.ts` documents). Every case here stubs the var explicitly.
   */
  it('defaults to Anthropic when unset', () => {
    vi.stubEnv('LLM_PROVIDER', '');
    expect(getPlatformProvider({})).toBe(DEFAULT_PLATFORM_PROVIDER);
  });

  it('accepts a supported provider, case-insensitively', () => {
    vi.stubEnv('LLM_PROVIDER', 'kie');
    expect(getPlatformProvider({})).toBe('KIE');
  });

  /*
   * A typo must be LOUD. The dangerous alternative is not a crash — it is silently falling back to
   * Anthropic, which spends the operator's Anthropic key at 2.5x the price they believed they had
   * configured, and reports nothing (§1.3 principle 0: never a silent fallback to another provider).
   */
  it('refuses a provider it does not know rather than falling back', () => {
    vi.stubEnv('LLM_PROVIDER', 'Kei');
    expect(() => getPlatformProvider({})).toThrow(/Kei/);
  });
});

describe('the platform model switch', () => {
  /*
   * The owner's question: "what if I ever want to update to Fable 5 — would I have to rebuild the whole
   * app with adjusted billing numbers?" The answer this encodes: NO for the model (env), YES for its
   * price (one table row) — because a price cannot be guessed, only looked up.
   */
  it('defaults per provider when LLM_MODEL is unset', () => {
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(getPlatformModel({})).toBe(PLATFORM_MODEL_BY_PROVIDER.KIE);

    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    expect(getPlatformModel({})).toBe(PLATFORM_MODEL_BY_PROVIDER.Anthropic);
  });

  it('honours LLM_MODEL for a model the provider is priced for', () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
    expect(getPlatformModel({})).toBe('claude-sonnet-5');
  });

  /*
   * 🔴 THE RULE THAT MAKES THE KNOB SAFE.
   *
   * `ratesFor` falls back to the provider's most expensive row for a model it does not know, so an
   * UNPRICED `LLM_MODEL` would not fail — it would bill every generation at some other model's price,
   * silently and forever. "Is this model configured?" and "do we know what it costs?" are therefore the
   * same question. This is why the old "never an env var" rule was wrong: the answer to "a typo would
   * break it" is to validate, not to forbid the knob.
   */
  it('refuses a model it cannot bill rather than mis-pricing every generation', () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');

    /*
     * A plausible model id we have no rates for. NOT `claude-fable-5` any more: the PREMIUM tier
     * (§4.6.1) injects a fable-5 row into every provider's table (`providerRates`), so fable-5 IS now
     * priceable on Anthropic. This assertion is about a model that is genuinely unknown to the billing
     * tables, which is the property that keeps the `LLM_MODEL` knob safe.
     */
    vi.stubEnv('LLM_MODEL', 'claude-opus-4-9');
    expect(() => getPlatformModel({})).toThrow(/opus-4-9/i);
  });

  /*
   * A model priced on one provider but not the other is refused on the one that cannot bill it.
   * (Was sonnet-5-on-KIE until 2026-07-18 — the marketplace list now prices sonnet-5 on KIE, so the
   * asymmetric model is opus-4-7: a KIE feed row with deliberately NO Anthropic MODEL_RATES entry.)
   */
  it('validates against the CONFIGURED provider, not against models in general', () => {
    vi.stubEnv('LLM_MODEL', 'claude-opus-4-7');

    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(getPlatformModel({})).toBe('claude-opus-4-7'); // priced in the marketplace list

    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    expect(() => getPlatformModel({})).toThrow(/opus-4-7/i); // no Anthropic row
  });

  /* A typo is a describable config error, never a 404 at the first generation. */
  it('refuses a typo loudly', () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('LLM_MODEL', 'claude-opus-4-8-latest');
    expect(() => getPlatformModel({})).toThrow(/claude-opus-4-8-latest/);
  });

  /* Every per-provider default must itself be priced, or the no-env-file path mis-bills on boot. */
  it('has a priced default for every provider', () => {
    for (const provider of PLATFORM_PROVIDERS) {
      const model = PLATFORM_MODEL_BY_PROVIDER[provider];
      expect(providerRates()[provider]?.[model], `${provider}'s default model ${model} has no rates`).toBeDefined();
    }
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
    const cost = rawCostUsd(realCreation, 'claude-sonnet-5', 'Anthropic');

    expect(cost).toBeGreaterThan(1.1);
    expect(cost).toBeLessThan(1.6);
  });

  it('charges margin over raw cost', () => {
    const credits = creditsForUsage(realCreation, 'claude-sonnet-5', 'Anthropic', config);
    const cost = rawCostUsd(realCreation, 'claude-sonnet-5', 'Anthropic');

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

    expect(creditsForUsage(tiny, 'claude-sonnet-5', 'Anthropic', config)).toBeGreaterThanOrEqual(1);
  });

  it('charges nothing for a generation that produced nothing', () => {
    const nothing: TokenUsage = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

    expect(creditsForUsage(nothing, 'claude-sonnet-5', 'Anthropic', config)).toBe(0);
  });

  /* Cached input must be dramatically cheaper than uncached, or the whole §4.2.8 effort bought nothing. */
  it('prices cached input ~10x cheaper than uncached', () => {
    const uncached = rawCostUsd(
      { promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      'claude-sonnet-5',
      'Anthropic',
    );
    const cached = rawCostUsd(
      { promptTokens: 0, completionTokens: 0, cacheReadTokens: 100_000, cacheCreationTokens: 0 },
      'claude-sonnet-5',
      'Anthropic',
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

  /*
   * The §4.10 refund audit reads refunds ACROSS users (`spec/fail-loud.md` — "am I refunding people?"
   * is an operator question about the platform, not about one account). Display-scoped and read-only:
   * balances still come only from the per-user chain.
   */
  describe('listByReason (the admin refund audit)', () => {
    it('lists refunds across EVERY user, newest first', async () => {
      await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });
      await ledger.append({ userId: 'u2', delta: 100, reason: 'grant' });
      await ledger.append({ userId: 'u1', delta: -30, reason: 'generation', generationId: 'gen_a' });
      await ledger.append({ userId: 'u1', delta: 30, reason: 'refund', generationId: 'gen_a' });
      await ledger.append({ userId: 'u2', delta: 24, reason: 'refund', generationId: 'med_b' });

      const refunds = await ledger.listByReason('refund');

      expect(refunds).toHaveLength(2);
      expect(new Set(refunds.map((r) => r.userId))).toEqual(new Set(['u1', 'u2']));
      expect(refunds.every((r) => r.reason === 'refund')).toBe(true);
    });

    it('an empty ledger answers with an empty list, never a throw', async () => {
      expect(await ledger.listByReason('refund')).toEqual([]);
    });

    it('respects the limit', async () => {
      await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });

      for (let i = 0; i < 5; i++) {
        await ledger.append({ userId: 'u1', delta: 1, reason: 'refund', generationId: `gen_${i}` });
      }

      expect(await ledger.listByReason('refund', 3)).toHaveLength(3);
    });

    /* "See them all": paging must cover every row exactly once — a gap or an overlap both falsify the audit. */
    it('pages the full history with offset — no gaps, no overlaps', async () => {
      await ledger.append({ userId: 'u1', delta: 100, reason: 'grant' });

      for (let i = 0; i < 5; i++) {
        await ledger.append({ userId: 'u1', delta: 1, reason: 'refund', generationId: `gen_${i}` });
      }

      const page1 = await ledger.listByReason('refund', 2, 0);
      const page2 = await ledger.listByReason('refund', 2, 2);
      const page3 = await ledger.listByReason('refund', 2, 4);
      const beyond = await ledger.listByReason('refund', 2, 6);

      const ids = [...page1, ...page2, ...page3].map((r) => r.id);

      expect(page1).toHaveLength(2);
      expect(page3).toHaveLength(1);
      expect(beyond).toEqual([]);
      expect(new Set(ids).size).toBe(5);
    });
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

  /*
   * A `search` debit MAY overdraw too (migration 0010): it is charged mid-generation, AFTER the paid
   * vendor already ran, so refusing it would only lose the audit trail — same rule as `generation`.
   */
  it('allows a search debit to overdraw the balance', async () => {
    await ledger.append({ userId: 'u1', delta: 4, reason: 'grant' });

    const row = await ledger.append({ userId: 'u1', delta: -10, reason: 'search' });

    expect(row.balanceAfter).toBe(-6);
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

    const settlement = await settleGeneration({
      userId: 'u1',
      generationId: 'g1',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage,
    });

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
      provider: 'Anthropic',
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
      provider: 'Anthropic',
      usage: { promptTokens: 50, completionTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    const stopped = await settleGeneration({
      userId: 'u1',
      generationId: 'g-stop',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
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
      provider: 'Anthropic',
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
      provider: 'Anthropic',
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
      provider: 'Anthropic',
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
    await settleGeneration({
      userId: 'u1',
      generationId: 'g-fk',
      model: 'claude-sonnet-5',
      provider: 'Anthropic',
      usage,
    });

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
      provider: 'Anthropic',
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
      provider: 'Anthropic',
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

    const raw = rawCostUsd(coldCreation, 'claude-opus-4-8', 'Anthropic');
    expect(raw).toBeCloseTo(1.44, 2);

    const credits = creditsForUsage(coldCreation, 'claude-opus-4-8', 'Anthropic', { ...config } as never);

    for (const pack of CREDIT_PACKS.filter((p) => p.isActive)) {
      const revenue = credits * (pack.priceCents / 100 / pack.credits);
      expect(revenue).toBeGreaterThan(raw);
    }
  });
});

/**
 * The SAME floor, with sandbox VM time on the cost side (T11, `billing/vm-cost.ts`).
 *
 * 🔴 **"User project compute ≈ $0" is RETIRED.** It was true on WebContainer — the project ran in the
 * user's own browser and the only real cost was a fixed StackBlitz plan fee, which a per-credit margin
 * cannot see and does not need to. A CodeSandbox microVM is billed by WALL CLOCK, and the clock runs
 * while the user THINKS, not only while the model runs. There is no `sandbox` ledger reason yet, so
 * that cost comes straight out of generation margin: **no meter, no row, nothing that throws.**
 *
 * This is the `packMargin()` bug one layer up, and it is worth restating because the shape is
 * identical: every file involved is internally sensible, the arithmetic that connects them lives in
 * nobody's head, and the failure mode is selling below cost quietly. `packMargin` caught packs
 * shipping at 0.84×; these tests are the same discipline applied to the cost input that the provider
 * cutover adds.
 *
 * ⚠️ **Never restore a failing assertion here by lowering a cost input or raising `CREDIT_MARGIN`.**
 * `$0.074/hr` is what CodeSandbox charges for Pico; 8.33 hours per 1,000 credits is what CREDITS.md's
 * ~120-credits-per-active-build-hour placeholder inverts to. If the floor fails, the pack price is
 * wrong or the estimate is — and both of those are answers. A fudged input is not.
 */
describe('credit pack margins with sandbox VM overhead', () => {
  /*
   * `margin: 4.0` MIRRORS the code default (`rates.ts` `creditConfig`), rather than the 3.34 the
   * describe above still uses — that block predates the 2026-07-18 raise and pins historical
   * arithmetic on purpose. The VM floor has to be graded against what we actually charge today.
   *
   * ⚠️ It is a LITERAL, not a read of `creditConfig()` — deliberately, so `.env.local` cannot move
   * it (the `env()`-falls-back-to-`process.env` trap), and by the same convention as the block above.
   * The cost of that choice is real and worth stating: if the code default ever changes, the pinned
   * 3.21/3.04/2.89 here and the same numbers in CREDITS.md and `spec/billing.md` all keep passing
   * while describing a margin the product no longer charges. The mitigation is that all four places
   * name the number explicitly, so a change has to walk past them.
   */
  const money = { creditUnitCostUsd: 0.01, margin: 4.0 };

  /**
   * The DEFAULT TIER's measured rate + the stated hours estimate — i.e. what a deploy with nothing
   * configured actually pays.
   *
   * 🔴 Read from `DEFAULT_SANDBOX_VM_USD_PER_HOUR` rather than a literal, and that constant is itself
   * `MEASURED_VM_TIER_USD_PER_HOUR[DEFAULT_SANDBOX_VM_TIER]` — so the numbers pinned in this describe
   * are the SHIPPING economics, not one tier's arithmetic. Changing the default tier (Pico → Nano,
   * 2026-07-28) is therefore SUPPOSED to fail these three tests: they are the alarm that says CREDITS.md
   * and `spec/billing.md` now describe a margin the product no longer earns. Re-baseline them and the
   * two documents together, never one of them.
   */
  const measured = {
    usdPerHour: DEFAULT_SANDBOX_VM_USD_PER_HOUR,
    estHoursPerKCredit: DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
  };

  const shipping = { ...money, vmOverheadUsdPerCredit: vmOverheadUsdPerCredit(measured) };

  it('prices the DEFAULT tier from the measured table, with no second copy of the number', () => {
    /*
     * The property first: the default price is the default TIER's price. This is what stops the pair
     * drifting — the failure that put a Nano VM on Pico's rate, silently, in the first place.
     */
    expect(DEFAULT_SANDBOX_VM_USD_PER_HOUR).toBe(MEASURED_VM_TIER_USD_PER_HOUR[DEFAULT_SANDBOX_VM_TIER]);
    expect(vmUsdPerHourForTier(DEFAULT_SANDBOX_VM_TIER)).toBe(DEFAULT_SANDBOX_VM_USD_PER_HOUR);

    // And today's answer, named, so a default-tier change has to walk past this line.
    expect(DEFAULT_SANDBOX_VM_TIER).toBe('Nano');
    expect(DEFAULT_SANDBOX_VM_USD_PER_HOUR).toBe(0.149);
  });

  it('prices one credit of sandbox compute at the derivation both documents state', () => {
    // $0.149/hr (Nano, the default tier) x 8.33 h per 1,000 credits = $1.241 per 1,000 = $0.001241/credit.
    expect(vmOverheadUsdPerCredit(measured)).toBeCloseTo(0.001241, 6);

    /*
     * Stated the other way round, which is how CREDITS.md words it: one default-tier hour eats the
     * margin earned by ~20 billed credits ($0.149 / $0.0075 of margin per credit at 4.0). It was ~10 on
     * Pico — doubling the tier doubles the credits an idle hour burns, which is the sentence the
     * document has to keep saying correctly.
     */
    expect(
      DEFAULT_SANDBOX_VM_USD_PER_HOUR / (money.creditUnitCostUsd - money.creditUnitCostUsd / money.margin),
    ).toBeCloseTo(19.87, 2);
  });

  /*
   * The SAME derivation on Pico, stubbed explicitly rather than inherited from the default.
   *
   * Kept because Pico is still a supported tier an operator can select, and because a number that is
   * only true "while the default happens to be X" is the class of claim this whole module exists to
   * end. This one stays true whatever the default becomes.
   */
  it('prices a Pico credit at the Pico derivation, whatever the default tier is', () => {
    const pico = { usdPerHour: MEASURED_VM_TIER_USD_PER_HOUR.Pico, estHoursPerKCredit: 8.33 };

    expect(pico.usdPerHour).toBe(0.074);
    expect(vmOverheadUsdPerCredit(pico)).toBeCloseTo(0.000616, 6);
  });

  // THE HEADLINE. Every pack a user can actually buy, after paying for the VM-hours those credits drag.
  it.each(CREDIT_PACKS.filter((p) => p.isActive).map((p) => [p.id, p] as const))(
    '%s still clears the floor after sandbox compute',
    (_id, pack) => {
      expect(effectivePackMargin(pack, shipping)).toBeGreaterThanOrEqual(MIN_PACK_MARGIN);
    },
  );

  it('leaves no active pack under the floor at the measured rate', () => {
    expect(packsUnderVmAdjustedFloor(shipping)).toEqual([]);
  });

  /*
   * 🔴 AND AT EVERY TIER WE HAVE MEASURED — because the tier is a config change an operator makes
   * without touching this file.
   *
   * The floor above is graded at Pico. The owner moved to Nano (2× the hourly rate) with one env var,
   * and until `vmUsdPerHourForTier` existed the floor kept passing against Pico's number. A floor that
   * only holds for the tier that happens to be the default is the "one floor, two revenue shapes"
   * problem one level down.
   */
  it.each(Object.entries(MEASURED_VM_TIER_USD_PER_HOUR))(
    'leaves no active pack under the floor on the %s tier ($%s/hr)',
    (_tier, usdPerHour) => {
      const atTier = {
        ...money,
        vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({ ...measured, usdPerHour }),
      };

      expect(packsUnderVmAdjustedFloor(atTier)).toEqual([]);
    },
  );

  /*
   * 🔴 AND THE CEILING: MICRO IS THE STEP THAT BREAKS THE BUSINESS, so it is asserted, not assumed.
   *
   * `sandbox/config.ts` justifies Nano as "the last free step up". That sentence is a claim about
   * MONEY made in a sandbox module, and this is the test that makes it one — an operator raising
   * `CODESANDBOX_VM_TIER` to Micro doubles the hourly rate again ($0.298, derived at ~$0.0745/CPU-hr)
   * and puts the two largest packs UNDER the floor while `starter` squeaks over at 2.01x. Nothing in
   * the product refuses that env var, so the only thing standing between it and a silent ~20-point
   * margin loss is this being written down where a change has to walk past it.
   */
  it('CEILING: the next tier up (Micro) puts real packs under the floor', () => {
    const micro = {
      ...money,
      vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({ ...measured, usdPerHour: vmUsdPerHourForTier('Micro') }),
    };

    expect(vmUsdPerHourForTier('Micro')).toBe(0.298);

    const under = packsUnderVmAdjustedFloor(micro);

    expect(under.map(({ pack }) => pack.id).sort()).toEqual(['pro', 'studio']);

    // Not marginally under — a fifth of the margin gone, on the two packs that carry the volume.
    for (const { effectiveMargin } of under) {
      expect(effectiveMargin).toBeLessThan(MIN_PACK_MARGIN);
    }

    expect(effectivePackMargin(CREDIT_PACKS.find((p) => p.id === 'studio')!, micro)).toBeCloseTo(1.81, 2);
  });

  /*
   * Numbers, not adjectives. CREDITS.md claims the fold-in costs "~5–7 GM points" and lands the packs
   * at "~65–69%"; `spec/billing.md` repeats 3.21x / 3.04x / 2.89x. Pinned here so the two documents and
   * the code cannot drift apart in silence — the whole reason this module exists as code rather than a
   * paragraph.
   */
  it('lands where CREDITS.md and spec/billing.md say it lands', () => {
    const byId = Object.fromEntries(
      CREDIT_PACKS.filter((p) => p.isActive).map((p) => [p.id, effectivePackMargin(p, shipping)]),
    );

    // At the Nano default. (Pico's 3.21 / 3.04 / 2.89 is what these read before 2026-07-28.)
    expect(byId.starter).toBeCloseTo(2.67, 2);
    expect(byId.pro).toBeCloseTo(2.53, 2);
    expect(byId.studio).toBeCloseTo(2.41, 2);

    // Gross margin = 1 - 1/multiple. CREDITS.md's "~58-63% effective" band, to the tenth of a point.
    const gm = (m: number) => (1 - 1 / m) * 100;
    expect(gm(byId.starter)).toBeCloseTo(62.6, 1);
    expect(gm(byId.pro)).toBeCloseTo(60.5, 1);
    expect(gm(byId.studio)).toBeCloseTo(58.4, 1);

    // And the "~12-14 points" claim: the drop from the LLM-only figure, per pack.
    for (const pack of CREDIT_PACKS.filter((p) => p.isActive)) {
      const drop = gm(packMargin(pack, money)) - gm(effectivePackMargin(pack, shipping));
      expect(drop).toBeGreaterThan(12);
      expect(drop).toBeLessThan(14);
    }

    /*
     * 🔴 The headroom, stated as a number rather than left as a feeling: the weakest pack clears the
     * floor by ~0.41x at the default tier. That is what makes Nano "the last free step up" — Micro
     * (below) puts two of the three packs underwater, so this margin is not a detail, it is the reason
     * the tier decision stopped where it did.
     */
    expect(Math.min(...Object.values(byId)) - MIN_PACK_MARGIN).toBeCloseTo(0.41, 2);
  });

  /*
   * 🔴 THE ASSERTION HAS TO BIND, AND THAT IS ITS OWN TEST.
   *
   * A floor that passes because the cost it adds rounds to nothing is not a floor — it is a test that
   * reports success on the failure it was written to catch (`wastedOutput`, `tool_rounds`,
   * `charsPerOutputToken`: this repo has found the same shape four times). So: feed the same packs an
   * absurd estimate and require them to FALL. Expressed as an assertion about
   * `packsUnderVmAdjustedFloor`'s output rather than a commented-out mutation, because a comment
   * cannot fail.
   */
  it('BINDS: an absurd hours estimate puts every pack under the floor', () => {
    /*
     * 200 VM-hours per 1,000 credits — i.e. a user idling ~5 credits an hour. $0.0148 per credit,
     * ~6x what a credit even sells for.
     */
    const absurd = {
      ...money,
      vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({ ...measured, estHoursPerKCredit: 200 }),
    };

    const under = packsUnderVmAdjustedFloor(absurd);

    expect(under.map(({ pack }) => pack.id).sort()).toEqual(
      CREDIT_PACKS.filter((p) => p.isActive)
        .map((p) => p.id)
        .sort(),
    );

    /*
     * Not merely "under 2" — under ONE, i.e. every sale loses money. Pinned so the test that proves
     * the floor binds is itself arithmetic rather than a vibe.
     */
    for (const { effectiveMargin } of under) {
      expect(effectiveMargin).toBeLessThan(1);
    }

    expect(under.find(({ pack }) => pack.id === 'studio')!.effectiveMargin).toBeCloseTo(0.28, 2);
  });

  it('BINDS the other input too: an absurd hourly rate fails the same way', () => {
    // The estimate is the guess, but the rate is the one an operator edits when they change VM tier.
    const absurd = { ...money, vmOverheadUsdPerCredit: vmOverheadUsdPerCredit({ ...measured, usdPerHour: 5 }) };

    expect(packsUnderVmAdjustedFloor(absurd)).toHaveLength(CREDIT_PACKS.filter((p) => p.isActive).length);
  });

  /*
   * `effectivePackMargin` is DERIVED from `packMargin`'s arithmetic rather than re-deriving the price
   * formula, so that a change to how a credit is priced cannot move one and not the other. These two
   * assertions are what pins that relationship in SHAPE, independently of today's numbers: adding cost
   * can only ever lower the multiple, and adding NO cost must reproduce `packMargin` exactly.
   */
  it('is strictly below packMargin for any positive overhead, and identical at zero', () => {
    for (const pack of CREDIT_PACKS.filter((p) => p.isActive)) {
      const llmOnly = packMargin(pack, money);

      expect(effectivePackMargin(pack, { ...money, vmOverheadUsdPerCredit: 0 })).toBeCloseTo(llmOnly, 10);

      for (const overhead of [1e-9, 0.000616, 0.005, 1]) {
        expect(effectivePackMargin(pack, { ...money, vmOverheadUsdPerCredit: overhead })).toBeLessThan(llmOnly);
      }
    }
  });

  it('honours an explicit packs argument, so the floor can be re-run on a proposed reprice', () => {
    const proposed = [{ id: 'mega', name: 'Mega', credits: 100_000, priceCents: 50_000, isActive: true }];

    /*
     * $0.005/credit against a $0.00312 total cost = 1.60x: a pack that clears the LLM-only floor
     * (2.0x) and fails once compute is paid for. Exactly the state this task exists to make visible.
     */
    expect(packMargin(proposed[0], money)).toBeCloseTo(2.0, 2);
    expect(packsUnderVmAdjustedFloor(shipping, MIN_PACK_MARGIN, proposed)).toHaveLength(1);
  });
});

/**
 * The config door for the two VM cost inputs.
 *
 * ⚠️ Every test here stubs its own env explicitly. `env()` falls back to `process.env` and vitest
 * loads `.env.local` — and `.env.example` actively tells operators to set both of these — so an
 * "unset" assertion written without a stub would silently grade the developer's own configuration
 * (the `oauth.spec.ts` trap; the file-level `SANDBOX_VM_ENV` scrub is the first line of defence).
 */
describe('sandbox VM cost config', () => {
  /**
   * 🔴 THE OWNER'S REQUIREMENT, AS A TEST: nothing in `.env`, nothing in SSM → **Nano at $0.149/hr.**
   *
   * Every variable in the chain is stubbed to `undefined` rather than left ambient — including
   * `CODESANDBOX_VM_TIER`, which is what a fresh deploy genuinely has and what `.env.local` genuinely
   * does not (the `oauth.spec.ts` trap; the file-level scrub is the first line of defence, this is the
   * second).
   */
  it('defaults to the default TIER rate and the stated estimate when nothing is configured', () => {
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', undefined as unknown as string);
    vi.stubEnv('SANDBOX_EST_VM_HOURS_PER_KCREDIT', undefined as unknown as string);
    vi.stubEnv('CODESANDBOX_VM_TIER', undefined as unknown as string);

    expect(getVmCostConfig({})).toEqual({
      usdPerHour: DEFAULT_SANDBOX_VM_USD_PER_HOUR,
      estHoursPerKCredit: DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT,
    });

    /*
     * Named, so nobody has to resolve two constants to know what an unconfigured deploy pays — and so
     * a default-tier change has to walk past this line and the documents it mirrors.
     */
    expect(getVmCostConfig({}).usdPerHour).toBe(0.149);
    expect(DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT).toBe(8.33);

    // The pairing itself: the default price IS the default tier's price, not a second copy of it.
    expect(DEFAULT_SANDBOX_VM_USD_PER_HOUR).toBe(MEASURED_VM_TIER_USD_PER_HOUR[DEFAULT_SANDBOX_VM_TIER]);
  });

  it('honours a sane override — a negotiated rate is a config change, not a code change', () => {
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Pico');
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', '0.149');
    vi.stubEnv('SANDBOX_EST_VM_HOURS_PER_KCREDIT', '4');

    expect(getVmCostConfig({})).toEqual({ usdPerHour: 0.149, estHoursPerKCredit: 4 });
  });

  /*
   * 🔴 THE POINT OF THE 2026-07-28 CHANGE: RAISING THE TIER IS ENOUGH.
   *
   * The owner set `CODESANDBOX_VM_TIER=Nano` and — exactly as `.env.example` and this module's own
   * comment invited — did not also set `SANDBOX_VM_USD_PER_HOUR`. The margin floor kept passing while
   * asserting against HALF the real compute cost. "Raise it with the tier" was a COMMENT, and a
   * comment cannot fail; this test is the mechanism that replaced it.
   */
  it('DERIVES the hourly rate from the configured tier when no override is set', () => {
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', undefined as unknown as string);

    /*
     * ⚠️ Both tiers here are deliberately NOT the default one. Stubbing the default tier and asserting
     * the default price proves nothing — a regression to a flat constant returns exactly that number
     * and the test passes. The assertion has to be able to tell "followed the tier" apart from
     * "returned the default", which means picking a tier the default does not answer with: one CHEAPER
     * than the default and one DEARER, so neither direction of the bug can hide.
     */
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Pico');
    expect(getVmCostConfig({}).usdPerHour).toBe(0.074);
    expect(getVmCostConfig({}).usdPerHour).toBeLessThan(DEFAULT_SANDBOX_VM_USD_PER_HOUR);

    vi.stubEnv('CODESANDBOX_VM_TIER', 'Micro');
    expect(getVmCostConfig({}).usdPerHour).toBe(0.298);
    expect(getVmCostConfig({}).usdPerHour).toBeGreaterThan(DEFAULT_SANDBOX_VM_USD_PER_HOUR);
  });

  it('still lets an explicit override win over the tier-derived default', () => {
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Nano');
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', '0.11');

    // A negotiated rate, or a vendor price change between releases — the reason the override survives.
    expect(getVmCostConfig({}).usdPerHour).toBe(0.11);
  });

  /*
   * 🔴 A NONSENSICAL OVERRIDE FALLS BACK — IT IS NEVER OBEYED, AND `0` IS THE ONE THAT MATTERS.
   *
   * `0` is the dangerous value precisely because it looks valid: it makes `vmOverheadUsdPerCredit`
   * return nothing, collapses `effectivePackMargin` back onto `packMargin`, and leaves the whole floor
   * above passing while asserting nothing about compute. That is a typo or a leftover restoring the
   * exact "user project compute ≈ $0" belief this module retires — so it falls back, loudly in effect
   * if not in output. (The predicate shipped as `>= 0` and obeyed it; fixed 2026-07-28.)
   */
  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['unparseable', 'free'],
    ['empty-ish word', 'NaN'],
  ])('falls back rather than obeying a %s hourly rate', (_label, raw) => {
    // The tier is stated, so the expected number is Pico's own rate rather than "whatever the default is".
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Pico');
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', raw);
    vi.stubEnv('SANDBOX_EST_VM_HOURS_PER_KCREDIT', undefined as unknown as string);

    expect(getVmCostConfig({}).usdPerHour).toBe(MEASURED_VM_TIER_USD_PER_HOUR.Pico);
    expect(getVmCostConfig({}).usdPerHour).toBe(0.074);
  });

  /*
   * 🔴 AND IT FALLS BACK TO THE **TIER**, NOT TO THE FLAT CONSTANT.
   *
   * The obvious fallback is `DEFAULT_SANDBOX_VM_USD_PER_HOUR`, which answers for ONE tier — so an
   * operator on any other tier who typo'd the override would be silently re-priced at the default's
   * rate. Under-stating VM cost is the invisible direction, hence its own test.
   *
   * ⚠️ Both tiers are non-default ON PURPOSE (see the DERIVES test above): stub the default tier here
   * and the flat-constant regression returns the right number by coincidence and this test goes blind.
   * Pico catches it from below, Micro from above.
   */
  it.each([
    ['Pico', 0.074],
    ['Micro', 0.298],
  ])('falls back to the %s TIER rate, not the flat default, on a bad override', (tier, expected) => {
    for (const raw of ['0', '-1', 'free']) {
      vi.stubEnv('CODESANDBOX_VM_TIER', tier as string);
      vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', raw);

      expect(getVmCostConfig({}).usdPerHour).toBe(expected);
      expect(getVmCostConfig({}).usdPerHour).not.toBe(DEFAULT_SANDBOX_VM_USD_PER_HOUR);
    }
  });

  it.each([
    ['zero', '0'],
    ['negative', '-8'],
    ['unparseable', 'lots'],
  ])('falls back rather than obeying a %s hours estimate', (_label, raw) => {
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Pico');
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', undefined as unknown as string);
    vi.stubEnv('SANDBOX_EST_VM_HOURS_PER_KCREDIT', raw);

    expect(getVmCostConfig({}).estHoursPerKCredit).toBe(DEFAULT_SANDBOX_EST_VM_HOURS_PER_KCREDIT);
  });

  it('never lets a bad override make sandbox compute look free', () => {
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Nano');
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', '0');
    vi.stubEnv('SANDBOX_EST_VM_HOURS_PER_KCREDIT', '0');

    // The property, not the mechanism: whatever the operator typed, the overhead is a real cost.
    expect(vmOverheadUsdPerCredit(getVmCostConfig({}))).toBeGreaterThan(0);
  });

  it('reads the Cloudflare loader context, not only process.env', () => {
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', '0.074');

    expect(getVmCostConfig({ cloudflare: { env: { SANDBOX_VM_USD_PER_HOUR: '0.149' } } }).usdPerHour).toBe(0.149);
  });

  /** The tier reaches the price through the same loader context, not only through `process.env`. */
  it('derives from the tier in the Cloudflare loader context too', () => {
    vi.stubEnv('CODESANDBOX_VM_TIER', 'Pico');
    vi.stubEnv('SANDBOX_VM_USD_PER_HOUR', undefined as unknown as string);

    expect(getVmCostConfig({ cloudflare: { env: { CODESANDBOX_VM_TIER: 'Nano' } } }).usdPerHour).toBe(0.149);
  });
});

/**
 * The tier → price table (`vmUsdPerHourForTier`), which is the mechanism that replaced the comment
 * telling operators to keep two variables in sync.
 */
describe('vmUsdPerHourForTier', () => {
  it('returns the measurement for a tier we have measured', () => {
    expect(vmUsdPerHourForTier('Pico')).toBe(0.074);
    expect(vmUsdPerHourForTier('Nano')).toBe(0.149);

    // The measured table is the source of both numbers — not a coincidence of two literals.
    for (const [tier, usd] of Object.entries(MEASURED_VM_TIER_USD_PER_HOUR)) {
      expect(vmUsdPerHourForTier(tier)).toBe(usd);
    }
  });

  it('derives an unmeasured but known tier from the per-CPU rate the anchors agree on', () => {
    // Micro is 4 CPU; $0.0745/CPU-hour is what $0.074/1 and $0.149/2 both imply.
    expect(vmUsdPerHourForTier('Micro')).toBe(0.298);
    expect(vmUsdPerHourForTier('XLarge')).toBe(4.768);

    // Monotonic in size, which is the only property a derived rate has to keep.
    expect(vmUsdPerHourForTier('Micro')).toBeGreaterThan(vmUsdPerHourForTier('Nano'));
  });

  /*
   * 🔴 THE DIRECTION IS THE ASSERTION, not the number — AND IT MUST NOT BE STATED IN TERMS OF THE
   * DEFAULT.
   *
   * The obvious way to write this ("the fallback is dearer than the default tier") went blind the day
   * the default moved Pico → Nano: with two measured tiers, the most expensive one now IS the default,
   * so `toBeGreaterThan(DEFAULT_SANDBOX_VM_USD_PER_HOUR)` became `0.149 > 0.149` — a false assertion
   * about a correct implementation, i.e. the test breaking for a reason that has nothing to do with the
   * property it guards. That property is: an unrecognised tier is priced at the DEAREST thing we know,
   * never the cheapest, because under-stating VM cost is the invisible failure (a pack looks profitable
   * and is not) where over-stating it merely looks bad and gets corrected. Same asymmetry as `ratesFor`
   * billing an unpriced model at the most expensive row.
   *
   * So it is stated against the MEASURED TABLE and nothing else: equal to its maximum, and at least
   * every entry in it. That survives the next default change, a third measured tier, and a reprice.
   */
  it.each(['Gigantic', '', 'nano', 'Pico ', 'undefined'])(
    'prices an unrecognised tier (%j) at the MOST expensive measured rate, never the cheapest',
    (tier) => {
      const measured = Object.values(MEASURED_VM_TIER_USD_PER_HOUR);
      const fallback = vmUsdPerHourForTier(tier);

      expect(fallback).toBe(Math.max(...measured));

      // Dominates every measured tier — the `Math.min` mutation fails here even at table size 1.
      for (const usd of measured) {
        expect(fallback).toBeGreaterThanOrEqual(usd);
      }

      expect(fallback).toBeGreaterThan(Math.min(...measured));
    },
  );

  /*
   * ⚠️ THE GUARD ABOVE CAN ONLY BIND WHILE THE TABLE HAS TWO DIFFERENT PRICES IN IT.
   *
   * `toBeGreaterThan(Math.min(...))` is vacuously satisfiable if the measured table is ever reduced to
   * one row (max === min), and `toBe(Math.max(...))` alone cannot tell `Math.max` from `Math.min` in
   * that world. This repo has found five metrics that reported success on the failure they were written
   * to catch; this is the same shape, so the precondition is asserted rather than assumed — a table
   * edit that blinds the direction check fails HERE, loudly, instead of silently downgrading it.
   */
  it('keeps the direction check meaningful: the measured table holds at least two distinct prices', () => {
    const distinct = new Set(Object.values(MEASURED_VM_TIER_USD_PER_HOUR));

    expect(distinct.size).toBeGreaterThanOrEqual(2);
    expect(Math.max(...distinct)).toBeGreaterThan(Math.min(...distinct));
  });

  /*
   * 🔴 THE REGRESSION THAT MOTIVATED THE NORMALISATION — A LOWERCASE TIER RAN ONE VM AND PRICED ANOTHER.
   *
   * `service.ts` resolves the tier case-INSENSITIVELY; this module looks it up EXACTLY. So before
   * `sandboxVmTier` normalised, `CODESANDBOX_VM_TIER=micro` ran a Micro ($0.298/hr) and billed the
   * unknown-tier fallback ($0.149) — a 2× UNDER-statement — and `xlarge` under-stated by 32×. The
   * fallback is conservative ONLY while the real tier is cheaper than the dearest measured one; above
   * it the error inverts into the silent direction, which is the whole reason this test exists.
   *
   * Stated as an EQUIVALENCE over the whole tier list rather than as two literals: whatever spelling
   * the operator typed, the price is the price of the tier they will actually get.
   */
  it('prices a lowercase configured tier exactly as its canonical spelling', () => {
    for (const tier of SANDBOX_VM_TIERS) {
      vi.stubEnv('CODESANDBOX_VM_TIER', tier.toLowerCase());
      expect(vmUsdPerHourForTier(sandboxVmTier({}))).toBe(vmUsdPerHourForTier(tier));
      expect(getVmCostConfig({}).usdPerHour).toBe(vmUsdPerHourForTier(tier));
    }
  });

  /*
   * The specific under-statement, named. An equivalence alone would still pass if BOTH sides collapsed
   * onto the fallback, so the two tiers whose real rate exceeds the dearest measured one are asserted
   * against that fallback directly.
   */
  it.each([
    ['micro', 0.298],
    ['xlarge', 4.768],
  ])('does not price a lowercase %j at the unknown-tier fallback', (raw, expected) => {
    vi.stubEnv('CODESANDBOX_VM_TIER', raw);

    const fallback = Math.max(...Object.values(MEASURED_VM_TIER_USD_PER_HOUR));

    expect(getVmCostConfig({}).usdPerHour).toBe(expected);
    expect(getVmCostConfig({}).usdPerHour).not.toBe(fallback);
    expect(getVmCostConfig({}).usdPerHour).toBeGreaterThan(fallback);
  });
});

/**
 * 🔴 EVERY TIER THE PROVIDER ACCEPTS MUST BE PRICEABLE.
 *
 * A tier present in `SANDBOX_VM_TIERS` and missing from this module's tables falls through to the
 * unknown-tier fallback — and that fallback under-states the moment the real tier is dearer than the
 * dearest measured one. Adding a tier to one list and not the other is exactly the "a number that is
 * only correct RELATIVE to another must be derived from it or asserted against it" lesson, so it is
 * asserted rather than left to a comment.
 */
describe('tierCoverage', () => {
  it('can price every tier the provider config accepts', () => {
    const { priced, unpriced } = tierCoverage();

    expect(unpriced).toEqual([]);
    expect(priced).toEqual([...SANDBOX_VM_TIERS]);
  });

  /** The control: coverage is computed FROM the tier list, so it cannot report a clean bill by seeing nothing. */
  it('reports on the whole tier list, not an empty one', () => {
    const { priced, unpriced } = tierCoverage();

    expect(priced.length + unpriced.length).toBe(SANDBOX_VM_TIERS.length);
    expect(SANDBOX_VM_TIERS.length).toBeGreaterThan(2);
  });
});
