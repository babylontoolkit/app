/**
 * `ENABLE_PREMIUM_MODEL=false` — the deploy that serves ONE model (SPEC §4.6.1a) — and the retirement
 * of the names it used to go by.
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
 * testing their machine (the `oauth.spec.ts` trap, and the `KIE_ENV` repeat of it). The RETIRED keys
 * are scrubbed too — they now make `getModelTier` throw, so one left in a developer's env would fail
 * every case here for a reason unrelated to the flag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENABLE_PREMIUM_MODEL_ENV_KEY, premiumModelEnabled, refuseRetiredModelTierEnv } from './premium-model-flag';
import { getModelTiers } from './rates';
import { decideModelTier, modelTiersSessionHint } from './premium';
import { getTierModel } from '~/lib/.server/agent/config';
import { hasModelChoice } from '~/lib/stores/model-tier';
import { envExampleAssignments, ENV_EXAMPLE_FILENAME } from './env-example';
import { readFileSync } from 'node:fs';

/** The variables that decide the ladder. Any one of them left real makes these assertions lie. */
const LADDER_ENV = [
  ENABLE_PREMIUM_MODEL_ENV_KEY,
  'PREMIUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'LLM_MODEL',
  'LLM_PROVIDER',
  'KIE_DEFAULT_MODEL',

  // The retired trio — scrubbed here, and asserted to be refused in their own describe below.
  'ENABLE_EXTENDED_MODELS',
  'SUPERMAX_MODEL',
  'SUPERMAX_MINIMUM_CREDITS',
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

describe('premiumModelEnabled — a switch that decides whether the expensive model can run', () => {
  it('is named ENABLE_PREMIUM_MODEL', () => {
    expect(ENABLE_PREMIUM_MODEL_ENV_KEY).toBe('ENABLE_PREMIUM_MODEL');
  });

  it('defaults ON, so an operator who has never heard of it sees no change', () => {
    scrub();
    expect(premiumModelEnabled({})).toBe(true);
  });

  it('is on for exactly "true" and nothing else — the safe direction for a spend switch', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'true' });
    expect(premiumModelEnabled({})).toBe(true);

    for (const value of ['false', '1', 'yes', 'TRUE', 'True', 'off', 'no']) {
      vi.unstubAllEnvs();
      scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: value });
      expect(premiumModelEnabled({})).toBe(false);
    }
  });

  /**
   * ⚠️ MEASURED, and it surprised me: `ENABLE_PREMIUM_MODEL=` (assigned but EMPTY) is the DEFAULT,
   * not "off". `env()` returns `process.env[key] || undefined`, so an empty string is indistinguishable
   * from unset for every variable in the platform — this switch does not get to have its own rule.
   *
   * Pinned rather than fixed: an operator who wants one model types `false`, and special-casing empty
   * here would mean this one variable read differently from every other flag, which is how the next
   * person gets it wrong. Asserting it makes the behaviour a decision instead of an accident.
   */
  it('treats an EMPTY assignment as unset — i.e. as the default, not as off', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: '' });
    expect(premiumModelEnabled({})).toBe(true);
  });

  /*
   * 🔴 THE OLD NAME DOES NOT SILENTLY BECOME THE DEFAULT.
   *
   * This is the entire reason the rename ships with a refusal. The flag defaults ON, so a deploy
   * carrying `ENABLE_EXTENDED_MODELS=false` in SSM would — the moment nothing reads that key — fall
   * through to ON and start serving the expensive rung to everyone. The costly direction, nothing
   * thrown, nothing logged, and the only visible sign is a bigger bill.
   */
  it('🔴 does not read the retired name — an old "false" must not read as the default ON', () => {
    scrub({ ENABLE_EXTENDED_MODELS: 'false' });
    expect(premiumModelEnabled({})).toBe(true);
  });
});

/**
 * The RETIRED ladder variables (2026-08-08) — refused by NAME, never ignored.
 *
 * Two retirements in one change: this flag's old name, and the `SUPERMAX_*` pair that configured a
 * third rung which no longer exists. Both are the `CREATION_FLAT_CREDITS` shape — a variable an
 * operator believes is configuring something and which nothing reads — and the refusal names the
 * replacement rather than merely saying "remove this", because an operator who is told to delete a
 * setting without being told what took its place deletes the capability too.
 */
describe('the retired ladder variables are refused, and the refusal is useful', () => {
  it('passes silently when none of them is set (control — the check can be satisfied)', () => {
    scrub();
    expect(() => refuseRetiredModelTierEnv({})).not.toThrow();
  });

  it.each([
    ['ENABLE_EXTENDED_MODELS', ENABLE_PREMIUM_MODEL_ENV_KEY],
    ['SUPERMAX_MODEL', 'PREMIUM_MODEL'],
    ['SUPERMAX_MINIMUM_CREDITS', 'PREMIUM_MINIMUM_CREDITS'],
  ])('refuses %s and names %s as the way forward', (retired, replacement) => {
    scrub({ [retired]: 'anything' });

    let thrown: unknown;

    try {
      refuseRetiredModelTierEnv({});
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error | undefined)?.name, `${retired} was not refused`).toBe('NotConfiguredError');
    expect((thrown as Error).message).toContain(retired);
    expect((thrown as Error).message).toContain(replacement);
  });

  /* An operator cleaning up an old deploy usually has more than one left over; name them all at once. */
  it('names every retired key that is set, not just the first', () => {
    scrub({ ENABLE_EXTENDED_MODELS: 'false', SUPERMAX_MODEL: 'claude-fable-5' });

    let message = '';

    try {
      refuseRetiredModelTierEnv({});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('ENABLE_EXTENDED_MODELS');
    expect(message).toContain('SUPERMAX_MODEL');
  });

  /*
   * 🔴 IT REACHES THE MONEY PATH. `refuseRetiredModelTierEnv` being correct is worth nothing if the
   * generation path never calls it — the `cache-warmer` lesson, where a module was present, tested,
   * green and inert for months. `getTierModel` is what the proxy calls before billing a paid rung.
   */
  it('🔴 is wired into model resolution — a retired var stops a paid rung from resolving at all', () => {
    scrub({ SUPERMAX_MODEL: 'claude-fable-5', PREMIUM_MODEL: 'claude-opus-5' });

    expect(() => getTierModel('premium', {})).toThrow(/SUPERMAX_MODEL/);
  });

  /*
   * ...and the READ path degrades instead of throwing. `/api/me` renders the picker; a throw there is
   * an app-wide outage over a stale variable name (the 2026-07-25 `premiumSessionHint` lesson). The
   * operator still learns what is wrong — it rides in `reason`, which `proxy.ts` warn-logs.
   */
  it('🔴 degrades the ladder rather than taking /api/me down', () => {
    scrub({ ENABLE_EXTENDED_MODELS: 'false' });

    const tiers = getModelTiers('claude-sonnet-5', {});

    expect(tiers[0].serveable, 'the free rung is unaffected').toBe(true);

    const premium = tiers.find((tier) => tier.id === 'premium')!;
    expect(premium.serveable).toBe(false);
    expect(premium.reason).toContain('ENABLE_EXTENDED_MODELS');
  });
});

describe('WALL 1 — the ladder itself', () => {
  it('offers Standard alone when the switch is off', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'false' });

    const tiers = getModelTiers('claude-opus-5', {});

    expect(tiers.map((tier) => tier.id)).toEqual(['standard']);
    expect(tiers[0].model).toBe('claude-opus-5');
    expect(tiers[0].serveable).toBe(true);
  });

  it('CONTROL: the paid rungs are there when it is on', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'true' });

    expect(getModelTiers('claude-sonnet-5', {}).map((tier) => tier.id)).toEqual(['standard', 'premium']);
  });

  it('🔴 resolves a request for a paid rung DOWN to standard, never up', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'false' });

    const tiers = getModelTiers('claude-opus-5', {}).map((tier) => ({
      id: tier.id,
      label: tier.label,
      model: tier.model,
      minimumCredits: tier.minimumCredits,
      firstBuildLocked: tier.firstBuildLocked,
      serveable: tier.serveable,
    }));

    // A hand-edited body, an unbounded balance: it still lands on standard.
    expect(decideModelTier({ requested: 'premium', balance: 10_000_000, tiers })).toEqual({
      tier: 'standard',
      reason: 'unavailable',
    });
  });

  /*
   * 🔴 THE RETIRED RUNG ID RESOLVES DOWN, AND ITS REASON IS DELIBERATELY THE *OTHER* ONE.
   *
   * `'supermax'` still arrives in real request bodies — a tab open across the deploy, a `localStorage`
   * value written last week. Both outcomes below matter and they are different facts:
   *
   *  - the TIER is `standard`, because a tier id is never clamped upward and an id the ladder does not
   *    know is exactly the case that rule exists for;
   *  - the REASON is `standard_requested`, NOT `unavailable`. `unavailable` is documented as the one
   *    operator-fault reason — "this rung exists and its selector is broken, go and fix it" — and it
   *    also drives a decline notice. A rung that has been deleted is neither: nothing is misconfigured,
   *    and telling the user their SuperMax request was declined names a class the product no longer
   *    has. Silently landing on Standard is the honest answer, and the client agrees by construction
   *    (`isModelTierId` no longer accepts the stored value either).
   */
  it('🔴 resolves the RETIRED supermax id down to standard, as a plain unknown id', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'true' });

    const tiers = getModelTiers('claude-sonnet-5', {});

    expect(decideModelTier({ requested: 'supermax', balance: 10_000_000, tiers })).toEqual({
      tier: 'standard',
      reason: 'standard_requested',
    });

    // CONTROL: the ladder under test is a real, healthy one — premium IS grantable at this balance.
    expect(decideModelTier({ requested: 'premium', balance: 10_000_000, tiers })).toEqual({
      tier: 'premium',
      reason: 'sufficient_credits',
    });
  });
});

describe('WALL 2 — model resolution refuses independently', () => {
  it('refuses to resolve a paid rung, and names the flag rather than the selector', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'false', PREMIUM_MODEL: 'claude-opus-5' });

    /*
     * Unreachable through the ladder today — which is why it is a WALL. A caller that assembled its own
     * tier list, or resolved a model before the decision, would otherwise bill the expensive model.
     */
    expect(() => getTierModel('premium', {})).toThrow(ENABLE_PREMIUM_MODEL_ENV_KEY);
  });
});

describe('what the client is told, and what it does with it', () => {
  it('/api/me reports one rung, and it is the model actually running', () => {
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'false' });

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
    scrub({ [ENABLE_PREMIUM_MODEL_ENV_KEY]: 'false' });

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

    expect(envExampleAssignments(source, ENABLE_PREMIUM_MODEL_ENV_KEY)).toHaveLength(1);

    // CONTROL: the counter still matches something, so "no duplicates" is a finding and not a silence.
    expect(envExampleAssignments(source, 'PREMIUM_MODEL').length).toBeGreaterThan(0);
  });
});
