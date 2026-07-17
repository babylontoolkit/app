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
  kieModelOverride,
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
  'KIE_DEFAULT_MODEL',
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
] as const;

beforeEach(async () => {
  for (const key of KIE_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

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
       * constant shared by both. It no longer is: `DEFAULT_MODEL` is `claude-opus-4-7` because KIE
       * cannot return 4.8's thinking text, which is a fact about KIE's adapter and says nothing about
       * Anthropic — where we have no 4.7 rates at all. Demanding every provider price the OTHER
       * provider's model is a question with no useful answer; what must hold is that whatever a
       * provider will actually be asked to run, it can price.
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
   * The uniform 0.4x is what makes the switch analysable: no mix effects, so a creation, an edit and a
   * repair all scale by the same factor. If a future KIE reprice breaks that uniformity, every credit
   * projection built on it (grant sizing, pack sizing) silently stops being true — so it is pinned.
   */
  /*
   * ⚠️ Models with NO Anthropic row cannot be cross-checked, so they are named here rather than
   * skipped. A bare `if (!direct) continue` would let a future KIE model silently escape the ratio
   * check — the "scan that matches nothing reports a clean bill of health forever" failure that
   * `no-server-storage.spec.ts` needed a control to catch. Naming them makes the exemption a decision.
   *
   * `claude-fable-5`: we bill it on KIE at a MEASURED $4/$20, but we have no Anthropic rates for it, so
   * there is nothing to take a ratio against. Note the 0.4x rule would IMPLY an Anthropic list of
   * $10/$50 — that is a prediction, not a price, and a price cannot be guessed. If Anthropic's fable-5
   * rates ever get added, delete this exemption and let the ratio test judge it.
   */
  const NO_ANTHROPIC_ROW = new Set(['claude-fable-5', 'claude-opus-4-7']);

  it('is a uniform 0.4x of Anthropic list across all four token classes', () => {
    for (const [model, kie] of Object.entries(KIE_MODEL_RATES)) {
      const direct = MODEL_RATES[model];

      if (NO_ANTHROPIC_ROW.has(model)) {
        expect(direct, `${model} is exempt from the ratio check but now HAS an Anthropic row`).toBeUndefined();
        continue;
      }

      expect(direct, `KIE prices ${model} but Anthropic has no row to compare against`).toBeDefined();

      expect(kie.inputPerMTok / direct.inputPerMTok, `${model} input`).toBeCloseTo(0.4, 5);
      expect(kie.outputPerMTok / direct.outputPerMTok, `${model} output`).toBeCloseTo(0.4, 5);
      expect(kie.cacheReadPerMTok / direct.cacheReadPerMTok, `${model} cache read`).toBeCloseTo(0.4, 5);
      expect(kie.cacheWritePerMTok / direct.cacheWritePerMTok, `${model} cache write`).toBeCloseTo(0.4, 5);
    }
  });

  /*
   * The published numbers, asserted literally. The ratio test above would still pass if BOTH tables
   * drifted together; this one is what catches a typo in the absolute price.
   */
  it('prices Opus 4.8 at the published $2 / $10', () => {
    expect(KIE_MODEL_RATES['claude-opus-4-8'].inputPerMTok).toBe(2.0);
    expect(KIE_MODEL_RATES['claude-opus-4-8'].outputPerMTok).toBe(10.0);
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
 * `KIE_DEFAULT_MODEL` + its rates (2026-07-17).
 *
 * KIE resells many vendors' models at prices only the operator can see, so — unlike Anthropic, whose
 * list we can look up and bake — "which model" and "what it costs" are ONE fact held outside this
 * repo. Every test here guards a way of getting that wrong that would bill real money and throw
 * nothing.
 */
describe('the KIE model + rate override', () => {
  const setKie = (vars: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(vars)) {
      vi.stubEnv(key, value as string);
    }
  };

  /* The baseline: nothing set, nothing changes. */
  it('leaves the baked table alone when unset', () => {
    expect(kieModelOverride()).toBeUndefined();
    expect(kieRates()).toEqual(KIE_MODEL_RATES);
  });

  /*
   * 🔴 THE RULE THIS WHOLE FEATURE RESTS ON.
   *
   * `ratesFor` falls back to the provider's MOST EXPENSIVE row for a model it does not know — so
   * naming a model without pricing it does not fail, it bills every generation at Opus 4.8's price,
   * forever, silently, at whatever margin that happens to imply. "Is this model configured?" and "do
   * we know what it costs?" are the same question, and this is the answer.
   */
  it('refuses a model it has no baked rates for unless BOTH prices are given', () => {
    setKie({ KIE_DEFAULT_MODEL: 'gpt-5-6-sol' });
    expect(() => kieModelOverride()).toThrow(/KIE_INPUT_DOLLARS and KIE_OUTPUT_DOLLARS/);

    setKie({ KIE_INPUT_DOLLARS: '1.57' });
    expect(() => kieModelOverride(), 'input alone is still unpriced output').toThrow(/KIE_OUTPUT_DOLLARS/);

    setKie({ KIE_OUTPUT_DOLLARS: '8.4' });

    const override = kieModelOverride();
    expect(override?.model).toBe('gpt-5-6-sol');
    expect(override?.rates.inputPerMTok).toBe(1.57);
    expect(override?.rates.outputPerMTok).toBe(8.4);
    expect(override?.rates.cacheReadPerMTok, 'derived 0.1x').toBeCloseTo(0.157, 5);
    expect(override?.rates.cacheWritePerMTok, 'derived 2x — the 1h tier').toBeCloseTo(3.14, 5);
  });

  /*
   * The operator's own example. Explicit cache quotes override the derivation — a vendor whose cache
   * multipliers differ from Anthropic's is the entire reason these two vars exist separately.
   */
  it('takes explicit cache prices over the derived ones', () => {
    setKie({
      KIE_DEFAULT_MODEL: 'gpt-5-6-sol',
      KIE_INPUT_DOLLARS: '1.57',
      KIE_OUTPUT_DOLLARS: '8.4',
      KIE_CACHED_WRITES: '1.74',
      KIE_CACHED_INPUT: '0.14',
    });

    expect(ratesFor('gpt-5-6-sol', 'KIE')).toEqual({
      inputPerMTok: 1.57,
      outputPerMTok: 8.4,
      cacheReadPerMTok: 0.14,
      cacheWritePerMTok: 1.74,
    });
  });

  /*
   * 🔴 A ROW MUST NOT BE HALF-BAKED AND HALF-CONFIGURED — the `packMargin` shape of bug.
   *
   * Overriding input while cache stays quoted against the OLD input rate is two numbers, each locally
   * sensible, disagreeing about what one thing costs. Halving input must halve the cache prices with
   * it, or the user is billed cache at a rate the operator never agreed to.
   */
  it('re-derives cache from the NEW input rate when a baked model is repriced', () => {
    setKie({ KIE_DEFAULT_MODEL: 'claude-opus-4-8', KIE_INPUT_DOLLARS: '1' });

    const rates = ratesFor('claude-opus-4-8', 'KIE');
    expect(rates.inputPerMTok).toBe(1);
    expect(rates.outputPerMTok, 'output is not overridden, so the baked price stands').toBe(10);
    expect(rates.cacheReadPerMTok, 'NOT the baked 0.2').toBeCloseTo(0.1, 5);
    expect(rates.cacheWritePerMTok, 'NOT the baked 4.0').toBeCloseTo(2.0, 5);
  });

  /*
   * The derivation is not a second opinion about a known price: naming the baked model and changing
   * nothing must reproduce the baked row exactly. If this ever fails, the multipliers and the table
   * have drifted and one of them is lying.
   */
  it('reproduces the baked row byte-for-byte when only the model is named', () => {
    setKie({ KIE_DEFAULT_MODEL: 'claude-opus-4-8' });
    expect(kieRates()['claude-opus-4-8']).toEqual(KIE_MODEL_RATES['claude-opus-4-8']);
  });

  /* Prices that name no model price NOTHING — they are a typo that reads as configured. */
  it('refuses rates with no model rather than ignoring them', () => {
    setKie({ KIE_INPUT_DOLLARS: '1.57', KIE_OUTPUT_DOLLARS: '8.4' });
    expect(() => kieRates()).toThrow(/KIE_DEFAULT_MODEL/);
  });

  /*
   * ⚠️ NOT `envNumber`. That returns its fallback for an unparseable value, which is right for a turn
   * cap and catastrophic for a price: `$2` would silently bill at some other model's rate. A price the
   * operator tried and failed to state is an error. `0` too — a free model does not exist, and it
   * would zero-rate every generation on it.
   */
  it.each([['$2'], ['two'], ['0'], ['-1']])('refuses a price it cannot trust: %s', (bad) => {
    setKie({ KIE_DEFAULT_MODEL: 'gpt-5-6-sol', KIE_INPUT_DOLLARS: bad, KIE_OUTPUT_DOLLARS: '8.4' });
    expect(() => kieModelOverride()).toThrow(/KIE_INPUT_DOLLARS/);
  });

  /* The configured model becomes KIE's default — that is what "default" in the name means. */
  it('becomes the platform model on KIE, priced by its own row', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('LLM_MODEL', undefined as unknown as string);
    setKie({ KIE_DEFAULT_MODEL: 'gpt-5-6-sol', KIE_INPUT_DOLLARS: '1.57', KIE_OUTPUT_DOLLARS: '8.4' });

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
  it('never prices LLM_MODEL at KIE_DEFAULT_MODEL rates', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    setKie({ KIE_DEFAULT_MODEL: 'gpt-5-6-sol', KIE_INPUT_DOLLARS: '1.57', KIE_OUTPUT_DOLLARS: '8.4' });

    // Priced in its own right: allowed, at ITS price, not gpt's.
    vi.stubEnv('LLM_MODEL', 'claude-opus-4-8');
    expect(getPlatformModel({})).toBe('claude-opus-4-8');
    expect(ratesFor('claude-opus-4-8', 'KIE').inputPerMTok).toBe(2.0);

    // Unpriced: refused, rather than borrowing the override's rates.
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
    vi.stubEnv('LLM_MODEL', 'claude-fable-5'); // a REAL model — we just have no rates for it
    expect(() => getPlatformModel({})).toThrow(/fable/i);
  });

  /* A model priced on one provider but not the other is refused on the one that cannot bill it. */
  it('validates against the CONFIGURED provider, not against models in general', () => {
    vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');

    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    expect(getPlatformModel({})).toBe('claude-sonnet-5'); // priced in MODEL_RATES

    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(() => getPlatformModel({})).toThrow(/sonnet/i); // not in KIE_MODEL_RATES
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
