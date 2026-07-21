/**
 * Unity Project License price ladder (SPEC §4.18, §4.6.1).
 *
 * The flat per-tier credit charge is CONFIG: the default ladder (500 / 1000 / 2000), overridable per
 * deploy by env. A mis-set override must NEVER silently become a free or negative charge — a bad value
 * falls back to the default. This is a money rule, so it is pinned like every other price.
 *
 * ⚠️ The oauth.spec trap: `env()` falls back to `process.env` and vitest loads `.env.local`, so every
 * override var is stubbed to `undefined` first — otherwise a developer with one set would flip these.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unityLicensePriceCredits, UNITY_LICENSE_TIER_DEFAULT_CREDITS } from './unity-license-pricing';

const ENV_VARS = [
  'UNITY_LICENSE_CREDITS_INDIE',
  'UNITY_LICENSE_CREDITS_SMALLBUSINESS',
  'UNITY_LICENSE_CREDITS_PREMIUMCONTENT',
] as const;

beforeEach(() => {
  for (const key of ENV_VARS) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unityLicensePriceCredits — default ladder', () => {
  it('prices Indie / SmallBusiness / PremiumContent at 500 / 1000 / 2000', () => {
    expect(unityLicensePriceCredits('Indie')).toBe(500);
    expect(unityLicensePriceCredits('SmallBusiness')).toBe(1000);
    expect(unityLicensePriceCredits('PremiumContent')).toBe(2000);
  });

  it('matches the exported default table', () => {
    expect(UNITY_LICENSE_TIER_DEFAULT_CREDITS).toEqual({ Indie: 500, SmallBusiness: 1000, PremiumContent: 2000 });

    for (const tier of Object.keys(UNITY_LICENSE_TIER_DEFAULT_CREDITS) as Array<
      keyof typeof UNITY_LICENSE_TIER_DEFAULT_CREDITS
    >) {
      expect(unityLicensePriceCredits(tier)).toBe(UNITY_LICENSE_TIER_DEFAULT_CREDITS[tier]);
    }
  });
});

describe('unityLicensePriceCredits — env overrides', () => {
  it('honors a valid override per tier', () => {
    vi.stubEnv('UNITY_LICENSE_CREDITS_INDIE', '750');
    vi.stubEnv('UNITY_LICENSE_CREDITS_SMALLBUSINESS', '1500');
    vi.stubEnv('UNITY_LICENSE_CREDITS_PREMIUMCONTENT', '3000');

    expect(unityLicensePriceCredits('Indie')).toBe(750);
    expect(unityLicensePriceCredits('SmallBusiness')).toBe(1500);
    expect(unityLicensePriceCredits('PremiumContent')).toBe(3000);
  });

  it('rounds a fractional override to the nearest whole credit', () => {
    vi.stubEnv('UNITY_LICENSE_CREDITS_INDIE', '649.6');
    expect(unityLicensePriceCredits('Indie')).toBe(650);
  });

  it('accepts zero (a deliberately free tier)', () => {
    vi.stubEnv('UNITY_LICENSE_CREDITS_INDIE', '0');
    expect(unityLicensePriceCredits('Indie')).toBe(0);
  });

  it('IGNORES a negative override — a mis-set price must never become a negative charge', () => {
    vi.stubEnv('UNITY_LICENSE_CREDITS_SMALLBUSINESS', '-100');
    expect(unityLicensePriceCredits('SmallBusiness')).toBe(1000);
  });

  it('IGNORES a non-numeric override — falls back to the default', () => {
    vi.stubEnv('UNITY_LICENSE_CREDITS_PREMIUMCONTENT', 'free');
    expect(unityLicensePriceCredits('PremiumContent')).toBe(2000);
  });

  it('leaves the OTHER tiers on their defaults when only one is overridden', () => {
    vi.stubEnv('UNITY_LICENSE_CREDITS_INDIE', '999');

    expect(unityLicensePriceCredits('Indie')).toBe(999);
    expect(unityLicensePriceCredits('SmallBusiness')).toBe(1000);
    expect(unityLicensePriceCredits('PremiumContent')).toBe(2000);
  });
});
