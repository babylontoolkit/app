/**
 * 🔴 `getTierModel`'s PROVIDER OVERRIDE, DRIVEN — the one instrument that can see it work.
 *
 * With `AUTO_MODEL_SELECT` the gateway is chosen PER REQUEST, so `proxy.ts` hands `config.provider`
 * to `getTierModel`. Dropping that argument returns the most expensive rung in the product to
 * validating itself against `LLM_PROVIDER`'s price table while a DIFFERENT gateway serves and bills
 * it — the `kieEnvModel` two-readers defect, on the money path, failing silently.
 *
 * ## Why this file exists, and why it stubs one collaborator
 *
 * `model-tier-config.spec.ts` establishes — and PINS — that with the real rate tables the argument
 * cannot change the answer for any input: `providerRates` gap-fills every resolvable rung's model into
 * every provider's table (`rates.ts` `withTiers`), so an enabled rung prices everywhere by
 * construction, and a disabled or unpriceable one throws before the provider is read at all. The
 * implementation's own comment states this honestly and calls the override "a correctness floor, not a
 * wall".
 *
 * A floor still has to hold. What can be observed is the seam itself — WHICH provider's table the
 * function reaches for — and observing it means stubbing exactly one collaborator: `providerRates`.
 * Everything else here is real, `getModelTier` included, so the rung is resolved by the same code the
 * platform runs and only the table it is checked against is under this file's control.
 *
 * ⚠️ That makes this a test of a real code path with a stubbed dependency, NOT a test of the stub: the
 * assertions are about which key `getTierModel` uses to index the table it was handed, which is the
 * behaviour the argument exists for. It carries a CONTROL proving the stub is actually in force,
 * because a mock that silently stopped applying would leave every case below passing against the real
 * gap-filled tables — green, and blind.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local`, which on this owner's machine
 * sets `AUTO_MODEL_SELECT`, `LLM_PROVIDER`, `LLM_MODEL`, `PREMIUM_MODEL` and all three platform keys.
 * Every case scrubs the whole chain (the `oauth.spec.ts` trap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotConfiguredError, getTierModel } from './config';
import { DEFAULT_PREMIUM_MODEL } from '~/lib/.server/billing/model-tiers';
import type { ModelRates } from '~/lib/.server/billing/rates';

const RATE: ModelRates = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 4 };

/**
 * The stub, and the reason it SPREADS the original rather than replacing the module.
 *
 * `config.ts` also imports `getModelTier` and `kieDefaultModel` from here. A plain factory would delete
 * both — `getTierModel` would then fail for a reason that has nothing to do with the provider, and the
 * suite would be green on an assertion that never reached the line it names. Only `providerRates` is
 * replaced.
 */
const stub = vi.hoisted(() => ({ providerRates: vi.fn() }));

vi.mock('~/lib/.server/billing/rates', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  providerRates: stub.providerRates,
}));

/** The premium rung's default selector — resolved by the REAL `getModelTier` from the baked list. */
const PREMIUM = 'claude-opus-5';

/** Only KIE prices the rung. With the real tables this state is unreachable; that is the point. */
const KIE_ONLY = {
  Anthropic: { 'claude-sonnet-5': RATE },
  KIE: { 'claude-sonnet-5': RATE, [PREMIUM]: RATE },
  Comet: { 'claude-sonnet-5': RATE },
};

const EVERYWHERE = {
  Anthropic: { [PREMIUM]: RATE },
  KIE: { [PREMIUM]: RATE },
  Comet: { [PREMIUM]: RATE },
};

/** The whole "which gateway / which model / which rung" precedence chain, plus every platform key. */
const ENV = [
  'AUTO_MODEL_SELECT',
  'LLM_PROVIDER_CHAIN',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',
  'ANTHROPIC_API_KEY',
  'KIE_API_KEY',
  'COMET_API_KEY',
  'ENABLE_EXTENDED_MODELS',
  'ENABLE_PREMIUM_MODEL',
  'ENABLE_PLATINUM_MODEL',
  'PREMIUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'PLATINUM_MODEL',
  'PLATINUM_MINIMUM_CREDITS',

  // Retired and REFUSED if set — a leftover on an upgrading machine fails every case here.
  'SUPERMAX_MODEL',
  'SUPERMAX_MINIMUM_CREDITS',
  'KIE_INPUT_DOLLARS',
  'KIE_OUTPUT_DOLLARS',
  'KIE_CACHED_INPUT',
  'KIE_CACHED_WRITES',
  'PREMIUM_INPUT_DOLLARS',
  'PREMIUM_OUTPUT_DOLLARS',
] as const;

function stubEnv(vars: Partial<Record<string, string>> = {}) {
  for (const key of ENV) {
    vi.stubEnv(key, (vars[key] ?? undefined) as unknown as string);
  }
}

beforeEach(() => {
  stub.providerRates.mockReturnValue(KIE_ONLY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('the override selects which price table validates the rung', () => {
  it('validates against the OVERRIDE, not LLM_PROVIDER', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic' });

    expect(getTierModel('premium', {}, 'KIE')).toBe(PREMIUM);
    expect(() => getTierModel('premium', {}), 'without the override it validates against Anthropic').toThrow(
      NotConfiguredError,
    );
  });

  /*
   * The mirror image, and the one that costs real money: `LLM_PROVIDER` CAN price the rung, the gateway
   * about to serve it cannot. Re-deriving here would return the model happily and hand it to a gateway
   * whose table has no row for it — where `ratesFor` bills it at that table's most expensive row.
   */
  it('refuses when the override cannot price the rung, even though LLM_PROVIDER could', () => {
    stubEnv({ LLM_PROVIDER: 'KIE' });

    expect(getTierModel('premium', {})).toBe(PREMIUM);
    expect(() => getTierModel('premium', {}, 'Comet')).toThrow(NotConfiguredError);
  });

  it('names the OVERRIDE provider in the refusal, so the operator fixes the right price list', () => {
    stubEnv({ LLM_PROVIDER: 'KIE' });

    try {
      getTierModel('premium', {}, 'Comet');
      expect.unreachable('an unpriced rung must not resolve');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain('Comet');
      expect(message).toContain(PREMIUM);
      expect(message, 'the rung’s OWN selector, never a hardcoded one').toContain('PREMIUM_MODEL');
      expect(message, 'it must not blame the gateway that was never asked').not.toContain('KIE');
    }
  });

  /* Omitting the argument behaves exactly as it did before the parameter existed. */
  it('falls back to LLM_PROVIDER when no override is given', () => {
    stubEnv({ LLM_PROVIDER: 'KIE' });

    expect(getTierModel('premium', {})).toBe(getTierModel('premium', {}, 'KIE'));
  });

  it('and to the default provider when LLM_PROVIDER is unset', () => {
    stubEnv();

    expect(() => getTierModel('premium', {})).not.toThrow();
  });
});

/**
 * CONTROLS. Two of the assertions above are refusals, and a refusal passes for all sorts of wrong
 * reasons — a deleted export, a mock that stopped applying, a rung that was never enabled.
 */
describe('CONTROLS — the stub is in force and the refusals are about the PROVIDER', () => {
  it('the stubbed providerRates is what getTierModel reads', () => {
    stubEnv({ LLM_PROVIDER: 'Anthropic' });

    expect(() => getTierModel('premium', {})).toThrow();
    expect(
      stub.providerRates,
      'the mock never applied — every case below it is testing the real tables',
    ).toHaveBeenCalled();
  });

  /*
   * 🔴 THE CONTROL THAT MATTERS. Every refusal above must come from the TABLE, not from the rung being
   * unresolvable in the first place: with the same environment and a table that prices the rung
   * everywhere, every provider resolves. Without this, deleting the override entirely and always
   * throwing would satisfy the two refusal cases.
   */
  it('with every table priced, every provider resolves — so the refusals are the table’s doing', () => {
    stub.providerRates.mockReturnValue(EVERYWHERE);
    stubEnv({ LLM_PROVIDER: 'Anthropic' });

    for (const provider of ['Anthropic', 'KIE', 'Comet'] as const) {
      expect(getTierModel('premium', {}, provider)).toBe(PREMIUM);
    }

    expect(getTierModel('premium', {})).toBe(PREMIUM);
  });

  /* And the fixture really does isolate one provider, or the first two cases prove nothing. */
  it('the fixture prices the rung on KIE alone', () => {
    expect(KIE_ONLY.KIE).toHaveProperty(PREMIUM);
    expect(KIE_ONLY.Anthropic).not.toHaveProperty(PREMIUM);
    expect(KIE_ONLY.Comet).not.toHaveProperty(PREMIUM);
  });

  /*
   * The rung's default selector is read from code, not typed here twice. If the premium default moves,
   * this fails loudly instead of leaving the fixtures silently pricing a model nothing resolves to.
   */
  it('PRECONDITION — the premium rung still defaults to the model these fixtures price', () => {
    expect(DEFAULT_PREMIUM_MODEL).toBe(PREMIUM);
  });
});
