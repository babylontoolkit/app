/**
 * WHICH KEY DOES THE PLATFORM SPEND? (`config.ts` — `platformKeyFor` / `requirePlatformKey` /
 * `hasPlatformKey`, SPEC §4.2a, §5.)
 *
 * ## Why this file exists at all
 *
 * Until T3 there was NO spec anywhere for these three functions, and `platformKeyFor` was a ternary
 * (`provider === 'KIE' ? kieApiKey : anthropicApiKey`) that silently resolved the ANTHROPIC key on a
 * Comet deploy — the wrong vendor's money on a box holding both keys, and a "not configured" error
 * naming the wrong variable on a box holding only the right one. The record that replaced it is what
 * these tests guard.
 *
 * ## Since 2026-10-03 there is ONE LLM provider (`_specs/anthropic-only_plan.md`)
 *
 * Anthropic Managed Agents is the only LLM path; KIE and fal are MEDIA providers only, and Comet is
 * gone. That makes the per-provider matrix this file used to generate collapse to one row — but the
 * property it existed for is still live, and is now sharper: **the LLM key is `ANTHROPIC_API_KEY` and
 * nothing else.** A deploy still carrying `KIE_API_KEY` (which is now the MEDIA key — `MEDIA_KEY_ENV`)
 * or a stale `COMET_API_KEY` must never have either spent on a text turn, and a stale `LLM_PROVIDER=KIE`
 * must not route the key lookup anywhere but Anthropic. Missing key → a describable 503 naming
 * `ANTHROPIC_API_KEY`, never a fallback.
 *
 * 🔴 Cases are still generated from the DECLARED UNION `PLATFORM_PROVIDERS` (with a CONTROL that it is
 * non-empty), and `EXPECTED_KEY_ENV` / `SENTINEL` are `Record<PlatformProviderName, …>`, so a provider
 * re-added later arrives here as a compile error and a failing test, never as an untested branch.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local`, which on a developer machine
 * carries real keys (and possibly `LLM_PROVIDER` / `LLM_MODEL` / `PREMIUM_MODEL`). The WHOLE chain is
 * scrubbed before every case — the `oauth.spec.ts` trap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotConfiguredError,
  PLATFORM_PROVIDERS,
  getPlatformConfig,
  hasPlatformKey,
  platformKeyEnvFor,
  requirePlatformKey,
  type PlatformConfig,
  type PlatformProviderName,
} from './config';

/**
 * Which env var holds each provider's key — **written out as LITERALS here on purpose.**
 *
 * The module keeps the same fact in `PLATFORM_KEY_ENV`; asserting `platformKeyEnvFor(p)` against an
 * import of that table would move both sides of the comparison together and pass for any value (this
 * repo's `PROGRESS_CAP` vacuity trap). These strings are what an operator types into SSM, so they are
 * a published interface: changing one is a breaking config change and should read as one here.
 */
const EXPECTED_KEY_ENV: Record<PlatformProviderName, string> = {
  Anthropic: 'ANTHROPIC_API_KEY',
};

/** Distinct per provider, so "it returned *a* key" and "it returned *the right* key" cannot be confused. */
const SENTINEL: Record<PlatformProviderName, string> = {
  Anthropic: 'sentinel-ANTHROPIC-key',
};

/**
 * The variables of the RETIRED LLM providers. `KIE_API_KEY` is still read — as the MEDIA key — and
 * `COMET_API_KEY` may linger in an old deploy's SSM; neither may ever be spent on an LLM turn.
 */
const RETIRED_LLM_KEY_ENV = ['KIE_API_KEY', 'COMET_API_KEY'] as const;
const RETIRED_SENTINEL: Record<(typeof RETIRED_LLM_KEY_ENV)[number], string> = {
  KIE_API_KEY: 'sentinel-KIE-key',
  COMET_API_KEY: 'sentinel-COMETAPI-key',
};

/** Everything that can decide which provider is configured or which key is present. */
const KEY_ENV = [
  'LLM_PROVIDER',
  'AUTO_MODEL_SELECT',
  'LLM_PROVIDER_CHAIN',
  'LLM_MODEL',
  'PREMIUM_MODEL',
  'ANTHROPIC_API_KEY',
  'KIE_API_KEY',
  'COMET_API_KEY',
] as const;

beforeEach(() => {
  for (const key of KEY_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Set every retired provider's key variable — the state where a fallback would spend the wrong key. */
function stubRetiredKeys(): void {
  for (const key of RETIRED_LLM_KEY_ENV) {
    vi.stubEnv(key, RETIRED_SENTINEL[key]);
  }
}

describe('the provider union these tests are generated from', () => {
  /*
   * CONTROL. Every parameterised `describe` below derives its cases from `PLATFORM_PROVIDERS`, and a
   * suite over an empty list runs zero tests and reports green.
   */
  it('is exactly Anthropic — the only LLM provider since 2026-10-03', () => {
    expect([...PLATFORM_PROVIDERS]).toEqual(['Anthropic']);
  });

  it('every declared provider has a sentinel and an expected env var in this file', () => {
    for (const provider of PLATFORM_PROVIDERS) {
      expect(SENTINEL[provider], `no sentinel for ${provider}`).toBeTruthy();
      expect(EXPECTED_KEY_ENV[provider], `no expected env var for ${provider}`).toBeTruthy();
    }
  });
});

describe('requirePlatformKey — a provider spends ITS OWN key', () => {
  for (const provider of PLATFORM_PROVIDERS) {
    it(`${provider} resolves the ${EXPECTED_KEY_ENV[provider]} value`, () => {
      const config: PlatformConfig = { provider, anthropicApiKey: SENTINEL[provider], proFeaturesEnabled: false };

      expect(requirePlatformKey(config)).toBe(SENTINEL[provider]);
      expect(hasPlatformKey(config)).toBe(true);
    });

    it(`${provider} reports its key absent when it is absent`, () => {
      const config: PlatformConfig = { provider, proFeaturesEnabled: false };

      expect(hasPlatformKey(config)).toBe(false);
      expect(() => requirePlatformKey(config)).toThrow(NotConfiguredError);
    });
  }

  /* An empty string is not a key. Falsy is falsy on both doors, or one lies to the other. */
  it('an empty-string key is treated as absent by BOTH doors', () => {
    const config: PlatformConfig = { provider: 'Anthropic', anthropicApiKey: '', proFeaturesEnabled: false };

    expect(hasPlatformKey(config)).toBe(false);
    expect(() => requirePlatformKey(config)).toThrow(NotConfiguredError);
  });
});

describe('requirePlatformKey — a missing key is a describable 503, naming the right variable', () => {
  for (const provider of PLATFORM_PROVIDERS) {
    const ownVar = EXPECTED_KEY_ENV[provider];

    it(`${provider}'s error names ${provider} and ${ownVar}, and no retired provider's variable`, () => {
      let message = '';

      try {
        requirePlatformKey({ provider, proFeaturesEnabled: false });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(provider);
      expect(message).toContain(ownVar);

      /*
       * ⚠️ The load-bearing half. An error that names the WRONG variable is worse than no error: it
       * sends someone to set a key that changes nothing, and the symptom does not move.
       */
      for (const retired of RETIRED_LLM_KEY_ENV) {
        expect(message, `${provider}'s error names ${retired}`).not.toContain(retired);
      }
    });
  }
});

describe('platformKeyEnvFor agrees with the key that actually resolves', () => {
  /*
   * 🔴 THE DRIFT GUARD, driven through `getPlatformConfig` rather than asserted against a table.
   *
   * Two independent answers to "which key does this provider need": the NAME (`PLATFORM_KEY_ENV`,
   * quoted in the 503 and the health report) and the VALUE (`platformKeyFor`, which decides what gets
   * spent). This stubs ONLY the variable `platformKeyEnvFor` names and requires the key that comes back
   * out of `requirePlatformKey` to be the value that went in — which also pins that `getPlatformConfig`
   * reads that variable into the field the lookup reads back.
   */
  for (const provider of PLATFORM_PROVIDERS) {
    it(`${provider}: ${EXPECTED_KEY_ENV[provider]} is both the advertised variable and the spent one`, () => {
      expect(platformKeyEnvFor(provider)).toBe(EXPECTED_KEY_ENV[provider]);

      vi.stubEnv(platformKeyEnvFor(provider), SENTINEL[provider]);

      const config = getPlatformConfig();

      expect(config.provider).toBe(provider);
      expect(hasPlatformKey(config)).toBe(true);
      expect(requirePlatformKey(config)).toBe(SENTINEL[provider]);
    });
  }

  /*
   * 🔴 NEVER FALL BACK TO ANOTHER PROVIDER'S KEY. `KIE_API_KEY` is still a live variable (it buys media
   * renders), so an Anthropic deploy routinely holds it. Borrowing it for an LLM turn would send an
   * Anthropic request with a KIE credential — or, worse, a future fallback that "helpfully" tried the
   * next key. Missing Anthropic key must stay NOT CONFIGURED whatever else is set.
   */
  it('with every retired provider key set and ANTHROPIC_API_KEY unset, it is NOT configured', () => {
    stubRetiredKeys();

    const config = getPlatformConfig();

    expect(config.provider).toBe('Anthropic');
    expect(hasPlatformKey(config)).toBe(false);
    expect(() => requirePlatformKey(config)).toThrow(NotConfiguredError);
  });

  /*
   * A stale `LLM_PROVIDER` naming a retired gateway is IGNORED (it only warns) — the provider stays
   * Anthropic and the key spent is Anthropic's, never the retired gateway's key sitting beside it.
   */
  for (const stale of ['KIE', 'Comet']) {
    it(`LLM_PROVIDER=${stale} still spends ANTHROPIC_API_KEY, never the ${stale} key`, () => {
      stubRetiredKeys();
      vi.stubEnv('LLM_PROVIDER', stale);
      vi.stubEnv('ANTHROPIC_API_KEY', SENTINEL.Anthropic);

      const config = getPlatformConfig();

      expect(config.provider).toBe('Anthropic');
      expect(requirePlatformKey(config)).toBe(SENTINEL.Anthropic);
    });
  }
});
