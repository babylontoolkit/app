/**
 * `ENABLE_EXTENDED_MODELS=false` — the deploy that serves ONE model (SPEC §4.6.1a).
 *
 * The switch exists because the provider is not always dependable on more than one model at a time.
 * Its failure modes are the usual money-path pair, and only one of them is loud:
 *
 * - Too permissive — a paid rung still reachable after the operator switched it off. Silent: it bills
 *   at 2–5× on a deploy that meant to serve one model. Pinned at BOTH walls below.
 * - Too strict — the STANDARD rung disappearing with the paid ones. Loud, but it would take the whole
 *   platform down, so it gets its own control.
 *
 * ⚠️ Every test scrubs the WHOLE precedence chain, not just the flag: `env()` falls back to
 * `process.env` and vitest loads `.env.local`, so a developer with real tier config would otherwise be
 * testing their machine (the `oauth.spec.ts` trap, and the `KIE_ENV` repeat of it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTENDED_MODELS_ENV_KEY, extendedModelsEnabled } from './extended-models';
import { getModelTiers } from './rates';
import { decideModelTier, modelTiersSessionHint } from './premium';
import { getTierModel } from '~/lib/.server/agent/config';
import { hasModelChoice } from '~/lib/stores/model-tier';
import { envExampleAssignments, ENV_EXAMPLE_FILENAME } from './env-example';
import { readFileSync } from 'node:fs';

/** The variables that decide the ladder. Any one of them left real makes these assertions lie. */
const LADDER_ENV = [
  EXTENDED_MODELS_ENV_KEY,
  'PREMIUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'SUPERMAX_MODEL',
  'SUPERMAX_MINIMUM_CREDITS',
  'LLM_MODEL',
  'LLM_PROVIDER',
  'KIE_DEFAULT_MODEL',
];

function scrub(overrides: Record<string, string> = {}) {
  for (const key of LADDER_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('extendedModelsEnabled — a switch that decides whether expensive models can run', () => {
  it('defaults ON, so an operator who has never heard of it sees no change', () => {
    scrub();
    expect(extendedModelsEnabled({})).toBe(true);
  });

  it('is on for exactly "true" and nothing else — the safe direction for a spend switch', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: 'true' });
    expect(extendedModelsEnabled({})).toBe(true);

    for (const value of ['false', '1', 'yes', 'TRUE', 'True', 'off', 'no']) {
      vi.unstubAllEnvs();
      scrub({ [EXTENDED_MODELS_ENV_KEY]: value });
      expect(extendedModelsEnabled({})).toBe(false);
    }
  });

  /**
   * ⚠️ MEASURED, and it surprised me: `ENABLE_EXTENDED_MODELS=` (assigned but EMPTY) is the DEFAULT,
   * not "off". `env()` returns `process.env[key] || undefined`, so an empty string is indistinguishable
   * from unset for every variable in the platform — this switch does not get to have its own rule.
   *
   * Pinned rather than fixed: an operator who wants one model types `false`, and special-casing empty
   * here would mean this one variable read differently from every other flag, which is how the next
   * person gets it wrong. Asserting it makes the behaviour a decision instead of an accident.
   */
  it('treats an EMPTY assignment as unset — i.e. as the default, not as off', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: '' });
    expect(extendedModelsEnabled({})).toBe(true);
  });
});

describe('WALL 1 — the ladder itself', () => {
  it('offers Standard alone when the switch is off', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: 'false' });

    const tiers = getModelTiers('claude-opus-5', {});

    expect(tiers.map((tier) => tier.id)).toEqual(['standard']);
    expect(tiers[0].model).toBe('claude-opus-5');
    expect(tiers[0].serveable).toBe(true);
  });

  it('CONTROL: the paid rungs are there when it is on', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: 'true' });

    expect(getModelTiers('claude-sonnet-5', {}).map((tier) => tier.id)).toEqual(['standard', 'premium', 'supermax']);
  });

  it('🔴 resolves a request for a paid rung DOWN to standard, never up', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: 'false' });

    const tiers = getModelTiers('claude-opus-5', {}).map((tier) => ({
      id: tier.id,
      label: tier.label,
      model: tier.model,
      minimumCredits: tier.minimumCredits,
      firstBuildLocked: tier.firstBuildLocked,
      serveable: tier.serveable,
    }));

    // A hand-edited body, an unbounded balance: it still lands on standard.
    for (const requested of ['premium', 'supermax']) {
      expect(decideModelTier({ requested, balance: 10_000_000, tiers })).toEqual({
        tier: 'standard',
        reason: 'unavailable',
      });
    }
  });
});

describe('WALL 2 — model resolution refuses independently', () => {
  it('refuses to resolve a paid rung, and names the flag rather than the selector', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: 'false', PREMIUM_MODEL: 'claude-opus-5' });

    /*
     * Unreachable through the ladder today — which is why it is a WALL. A caller that assembled its own
     * tier list, or resolved a model before the decision, would otherwise bill the expensive model.
     */
    expect(() => getTierModel('premium', {})).toThrow(EXTENDED_MODELS_ENV_KEY);
    expect(() => getTierModel('supermax', {})).toThrow(EXTENDED_MODELS_ENV_KEY);
  });
});

describe('what the client is told, and what it does with it', () => {
  it('/api/me reports one rung, and it is the model actually running', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: 'false' });

    const hint = modelTiersSessionHint({
      tiers: getModelTiers('claude-opus-5', {}),
      standardModel: 'claude-opus-5',
      fallbackStandardModel: 'claude-sonnet-5',
      balance: 10_000,
    });

    expect(hint.standardModel).toBe('claude-opus-5');
    expect(hint.tiers).toHaveLength(1);
    expect(hint.tiers[0]).toMatchObject({ id: 'standard', available: true, serveable: true });
  });

  it('🔴 the free rung survives — the switch withdraws the PAID rungs, never the platform', () => {
    scrub({ [EXTENDED_MODELS_ENV_KEY]: 'false' });

    const tiers = getModelTiers('claude-opus-5', {});

    expect(tiers).toHaveLength(1);
    expect(tiers[0].id).toBe('standard');
    expect(tiers[0].minimumCredits).toBe(0);
  });

  it('the picker does not open for a one-rung ladder, and does for a real one', () => {
    expect(hasModelChoice([{ serveable: true }])).toBe(false);
    expect(hasModelChoice([{ serveable: true }, { serveable: true }])).toBe(true);

    // A rung the platform will refuse is not an option, so a misconfigured ladder is also "no choice".
    expect(hasModelChoice([{ serveable: true }, { serveable: false }, { serveable: false }])).toBe(false);
    expect(hasModelChoice([])).toBe(false);
  });
});

describe('.env.example documents it exactly once', () => {
  it('assigns the key once — a later duplicate silently wins in a copied .env', () => {
    const source = readFileSync(ENV_EXAMPLE_FILENAME, 'utf8');

    expect(envExampleAssignments(source, EXTENDED_MODELS_ENV_KEY)).toHaveLength(1);

    // CONTROL: the counter still matches something, so "no duplicates" is a finding and not a silence.
    expect(envExampleAssignments(source, 'PREMIUM_MODEL').length).toBeGreaterThan(0);
  });
});
