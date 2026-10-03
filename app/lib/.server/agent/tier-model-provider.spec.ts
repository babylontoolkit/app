/**
 * 🔴 WHICH PRICE TABLE `getTierModel` VALIDATES A PAID RUNG AGAINST — driven.
 *
 * Since 2026-10-03 (`_specs/anthropic-only_plan.md`) Anthropic is the ONLY LLM gateway:
 * `getPlatformProvider` returns Anthropic whatever `LLM_PROVIDER` says (a stale value warns, never
 * throws), and the override `proxy.ts` passes can only be `'Anthropic'`. The multi-gateway cases this
 * file used to drive (KIE/Comet overrides) went with the gateways. What still has to hold: the rung is
 * checked against ANTHROPIC'S table, a stale `LLM_PROVIDER` cannot re-route that check to another key,
 * and the refusal names the provider and the rung's OWN selector.
 *
 * ## Why this file stubs one collaborator
 *
 * With the real rate tables an enabled rung's model is gap-filled into Anthropic's table
 * (`rates.ts` `withTiers`), so the refusal path is unreachable for any real configuration. Observing
 * WHICH key the function indexes means stubbing exactly one collaborator: `providerRates`. Everything
 * else here is real, `getModelTier` included, so the rung is resolved by the same code the platform runs
 * and only the table it is checked against is under this file's control.
 *
 * ⚠️ That makes this a test of a real code path with a stubbed dependency, NOT a test of the stub. It
 * carries CONTROLS proving the stub is actually in force and that every refusal is the table's doing,
 * because a mock that silently stopped applying would leave every case passing against the real
 * gap-filled tables — green, and blind.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local`, which on this owner's machine
 * sets `AUTO_MODEL_SELECT`, `LLM_PROVIDER`, `LLM_MODEL`, `PREMIUM_MODEL` and the platform keys. Every
 * case scrubs the whole chain (the `oauth.spec.ts` trap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotConfiguredError, getTierModel } from './config';
import { DEFAULT_PLATINUM_MODEL, DEFAULT_PREMIUM_MODEL } from '~/lib/.server/billing/model-tiers';
import type { ModelRates } from '~/lib/.server/billing/rates';

const RATE: ModelRates = { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 4 };

/**
 * The stub, and the reason it SPREADS the original rather than replacing the module.
 *
 * `config.ts` also imports `getModelTier` and `nativeProviderRates` from here. A plain factory would
 * delete them — `getTierModel` would then fail for a reason that has nothing to do with the price
 * table, and the suite would be green on an assertion that never reached the line it names. Only
 * `providerRates` is replaced.
 */
const stub = vi.hoisted(() => ({ providerRates: vi.fn() }));

vi.mock('~/lib/.server/billing/rates', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  providerRates: stub.providerRates,
}));

/** The premium rung's default selector — resolved by the REAL `getModelTier` from the baked list. */
const PREMIUM = 'claude-opus-5-5';

/**
 * Anthropic does NOT price the rung; a stale `KIE` key in the table does. With the real tables this
 * state is unreachable (`providerRates` returns Anthropic only since 2026-10-03), which is the point:
 * it is the one fixture where validating against the wrong key would RESOLVE instead of refusing.
 */
const ANTHROPIC_UNPRICED = {
  Anthropic: { 'claude-sonnet-5': RATE },
  KIE: { 'claude-sonnet-5': RATE, [PREMIUM]: RATE },
};

const ANTHROPIC_PRICED = {
  Anthropic: { [PREMIUM]: RATE },
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
  stub.providerRates.mockReturnValue(ANTHROPIC_UNPRICED);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('the rung is validated against ANTHROPIC’S price table — the only LLM gateway', () => {
  /*
   * 🔴 Since 2026-10-03 (`_specs/anthropic-only_plan.md`) `getPlatformProvider` ignores a non-Anthropic
   * `LLM_PROVIDER` with a warning. The defect this guards is a stale `LLM_PROVIDER=KIE` re-routing the
   * validation to a table keyed `KIE` — which in this fixture prices the rung — so a rung Anthropic
   * cannot bill would resolve and then settle through `ratesFor`'s most-expensive fallback.
   */
  it('a stale LLM_PROVIDER cannot route validation to another gateway’s table', () => {
    for (const stale of ['KIE', 'Comet']) {
      stubEnv({ LLM_PROVIDER: stale });

      expect(() => getTierModel('premium', {}), `LLM_PROVIDER=${stale} must be ignored`).toThrow(NotConfiguredError);
    }
  });

  it('refuses through the explicit override when Anthropic cannot price the rung', () => {
    stubEnv();

    expect(() => getTierModel('premium', {}, 'Anthropic')).toThrow(NotConfiguredError);
  });

  it('names Anthropic in the refusal, so the operator fixes the right price list', () => {
    stubEnv({ LLM_PROVIDER: 'KIE' });

    try {
      getTierModel('premium', {}, 'Anthropic');
      expect.unreachable('an unpriced rung must not resolve');
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain('Anthropic');
      expect(message).toContain(PREMIUM);
      expect(message, 'the rung’s OWN selector, never a hardcoded one').toContain('PREMIUM_MODEL');
      expect(message, 'it must not blame the gateway named by a stale setting').not.toContain('KIE');
    }
  });

  /**
   * 🔴 THE RUNG NAMES ITS OWN ENV VAR — restored 2026-08-11, and the assertion above CANNOT prove it.
   *
   * `getTierModel` builds its refusal from `definition.modelEnvKey`, and the case above checks the
   * message contains `PREMIUM_MODEL`. That passes identically for a hardcoded `'PREMIUM_MODEL'` string,
   * because the rung under test IS premium.
   *
   * A PLATINUM refusal is the discriminator: it must say `PLATINUM_MODEL` and must NOT say
   * `PREMIUM_MODEL`. The absence is the load-bearing half — naming the wrong variable sends an operator
   * to fix a setting that was never broken, on a money path, while the rung they actually configured
   * stays dark.
   */
  it('a PLATINUM refusal names PLATINUM_MODEL and never the sibling rung’s selector', () => {
    stubEnv();

    try {
      getTierModel('platinum', {}, 'Anthropic');
      expect.unreachable('an unpriced rung must not resolve');
    } catch (error) {
      const message = (error as Error).message;

      expect(message, 'its OWN selector').toContain('PLATINUM_MODEL');
      expect(message, '🔴 a hardcoded PREMIUM_MODEL sends the operator to the wrong variable').not.toContain(
        'PREMIUM_MODEL',
      );
      expect(message, 'and its own model, not the sibling’s').toContain(DEFAULT_PLATINUM_MODEL);
      expect(message).toContain('Platinum');
    }
  });

  /**
   * CONTROL for the case above.
   *
   * `not.toContain('PREMIUM_MODEL')` is trivially satisfied by a refusal that throws before it ever
   * builds a message — a disabled rung, a missing definition, a typo in the tier id. This proves the
   * platinum rung genuinely RESOLVES when Anthropic's table prices it, so the refusal above is the price
   * table's doing and the message really was constructed.
   */
  it('CONTROL — platinum resolves when its model is priced, so the refusal is the table’s doing', () => {
    stub.providerRates.mockReturnValue({ Anthropic: { [DEFAULT_PLATINUM_MODEL]: RATE } });
    stubEnv();

    expect(getTierModel('platinum', {}, 'Anthropic')).toBe(DEFAULT_PLATINUM_MODEL);
  });

  /* Omitting the argument behaves exactly as passing the only gateway there is. */
  it('the explicit Anthropic override and the fallback agree', () => {
    stub.providerRates.mockReturnValue(ANTHROPIC_PRICED);
    stubEnv({ LLM_PROVIDER: 'KIE' });

    expect(getTierModel('premium', {})).toBe(getTierModel('premium', {}, 'Anthropic'));
    expect(getTierModel('premium', {})).toBe(PREMIUM);
  });
});

/**
 * CONTROLS. The assertions above are mostly refusals, and a refusal passes for all sorts of wrong
 * reasons — a deleted export, a mock that stopped applying, a rung that was never enabled.
 */
describe('CONTROLS — the stub is in force and the refusals are about the PRICE TABLE', () => {
  it('the stubbed providerRates is what getTierModel reads', () => {
    stubEnv();

    expect(() => getTierModel('premium', {})).toThrow();
    expect(
      stub.providerRates,
      'the mock never applied — every case below it is testing the real tables',
    ).toHaveBeenCalled();
  });

  /*
   * 🔴 THE CONTROL THAT MATTERS. Every refusal above must come from the TABLE, not from the rung being
   * unresolvable in the first place: with the same environments and a table where Anthropic prices the
   * rung, every case resolves. Without this, a getTierModel that always threw would satisfy the
   * refusal cases.
   */
  it('with Anthropic’s table priced, the same environments resolve — so the refusals are the table’s doing', () => {
    stub.providerRates.mockReturnValue(ANTHROPIC_PRICED);

    for (const vars of [{}, { LLM_PROVIDER: 'KIE' }, { LLM_PROVIDER: 'Comet' }]) {
      stubEnv(vars);

      expect(getTierModel('premium', {}, 'Anthropic')).toBe(PREMIUM);
      expect(getTierModel('premium', {})).toBe(PREMIUM);
    }
  });

  /* And the fixture really prices the rung on a key OTHER than Anthropic, or the first case proves nothing. */
  it('the fixture prices the rung on the stale KIE key alone', () => {
    expect(ANTHROPIC_UNPRICED.KIE).toHaveProperty(PREMIUM);
    expect(ANTHROPIC_UNPRICED.Anthropic).not.toHaveProperty(PREMIUM);
  });

  /*
   * The rung's default selector is read from code, not typed here twice. If the premium default moves,
   * this fails loudly instead of leaving the fixtures silently pricing a model nothing resolves to.
   */
  it('PRECONDITION — the premium rung still defaults to the model these fixtures price', () => {
    expect(DEFAULT_PREMIUM_MODEL).toBe(PREMIUM);
  });
});
