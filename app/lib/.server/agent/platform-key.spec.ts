/**
 * WHICH KEY DOES THE PLATFORM SPEND? (`config.ts` — `platformKeyFor` / `requirePlatformKey` /
 * `hasPlatformKey`, SPEC §4.2a, §5.)
 *
 * ## Why this file exists at all
 *
 * Until T3 there was NO spec anywhere for these three functions — `grep requirePlatformKey app
 * --include="*.spec.ts"` returned nothing — and `platformKeyFor` was:
 *
 *     config.provider === 'KIE' ? config.kieApiKey : config.anthropicApiKey
 *
 * A ternary is exhaustive for exactly two providers and silently wrong for the third. With Comet
 * added to `PLATFORM_PROVIDERS`, that expression resolved the **ANTHROPIC** key on a Comet deploy,
 * and it failed in two directions at once, neither of which throws anything a reader could trace back
 * to this file:
 *
 *   - a box holding BOTH keys spends the Anthropic credential — the wrong vendor's money, at roughly
 *     **2.3x** the price the operator deliberately chose (`config.ts`'s own measured figure), on a
 *     provider they never selected;
 *   - a box holding ONLY `COMET_API_KEY` reports *"the platform LLM key for Comet is not
 *     configured"* while holding it, which sends the operator to fix a variable that is already set.
 *
 * The compiler cannot help with either: a `Record<PlatformProviderName, …>` breaks the build when a
 * provider is added, a `? :` does not. So the record is the fix and this file is the guard on it.
 *
 * ## How these tests are built, and why that shape
 *
 * 🔴 **Every case is generated from the DECLARED UNION `PLATFORM_PROVIDERS`, never a hand-written
 * list.** This repo's `coversWorkspace` entry records the general lesson: a gate written as an
 * enumeration of the doors someone thought of cannot see the door they missed, and a test written
 * against that same enumeration cannot either. Iterating the union means a fourth provider arrives
 * here as a failing test rather than as an untested branch. `EXPECTED_KEY_ENV` and `SENTINEL` below
 * are typed `Record<PlatformProviderName, …>`, so a new provider is *also* a compile error in this
 * file — it cannot be silently skipped.
 *
 * ⚠️ **A `for…of` loop that generates cases reports a clean bill of health when it generates none.**
 * The `no-server-storage.spec.ts` scanner lesson applies to parameterised tests too, so the union is
 * asserted non-trivial before anything is derived from it.
 *
 * Sentinels are DISTINCT per key, so a wrong answer is unambiguous — an assertion against `'k'` for
 * every provider would pass for a function that returns the first key it finds.
 *
 * ⚠️ `env()` falls back to `process.env` and Vitest loads `.env.local`, which on this machine really
 * does carry a live `COMET_API_KEY` (plus `LLM_PROVIDER`, `LLM_MODEL`, `PREMIUM_MODEL`). The section
 * that drives `getPlatformConfig` scrubs the WHOLE chain — the `oauth.spec.ts` trap, which has already
 * fired twice in this repo for want of one sibling in a scrub list. Without it, "this provider has no
 * key" grades against the operator's real credentials and passes on CI while failing only on the
 * machine of the person who configured the provider.
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
  KIE: 'KIE_API_KEY',
  Comet: 'COMET_API_KEY',
};

/** Distinct per provider, so "it returned *a* key" and "it returned *the right* key" cannot be confused. */
const SENTINEL: Record<PlatformProviderName, string> = {
  Anthropic: 'sentinel-ANTHROPIC-key',
  KIE: 'sentinel-KIE-key',
  Comet: 'sentinel-COMETAPI-key',
};

/** Which `PlatformConfig` field each provider's key arrives in. */
const KEY_FIELD: Record<PlatformProviderName, 'anthropicApiKey' | 'kieApiKey' | 'cometApiKey'> = {
  Anthropic: 'anthropicApiKey',
  KIE: 'kieApiKey',
  Comet: 'cometApiKey',
};

/** A config holding EVERY provider's key. The state where a wrong lookup spends the wrong vendor. */
function configWithAllKeys(provider: PlatformProviderName): PlatformConfig {
  return {
    provider,
    anthropicApiKey: SENTINEL.Anthropic,
    kieApiKey: SENTINEL.KIE,
    cometApiKey: SENTINEL.Comet,
    proFeaturesEnabled: false,
  };
}

/** A config holding every key EXCEPT this provider's — the "reports not configured" half. */
function configWithoutOwnKey(provider: PlatformProviderName): PlatformConfig {
  const config = configWithAllKeys(provider);
  config[KEY_FIELD[provider]] = undefined;

  return config;
}

/**
 * Everything that can decide which provider is configured or which key is present.
 *
 * `LLM_MODEL` / `PREMIUM_MODEL` do not reach these functions today; they are scrubbed anyway because
 * this machine has both set to `gpt-*` values, and a future field on `PlatformConfig` reading one of
 * them would otherwise inherit the developer's environment into every case here, silently.
 *
 * ⚠️ `AUTO_MODEL_SELECT` / `LLM_PROVIDER_CHAIN` were added on 2026-08-10 and are the reason this list
 * is a list rather than just `LLM_PROVIDER`. The ladder OUTRANKS `LLM_PROVIDER` — with the flag on,
 * `getPlatformConfig` may serve a different gateway entirely — so an unscrubbed flag turns every case
 * below into a test of the ladder instead of a test of the key lookup. It is on in this repo's own
 * `.env.local`, which means the failure appears ONLY on the machine of whoever enabled the feature,
 * with CI green: the `oauth.spec.ts` trap, and the fourth time it has fired here.
 */
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

describe('the provider union these tests are generated from', () => {
  /*
   * CONTROL. Every `describe` below derives its cases from `PLATFORM_PROVIDERS`, and a parameterised
   * suite over an empty list runs zero tests and reports green. Pin that the union is real, and that
   * it contains the provider whose absence from the old ternary was the whole defect.
   */
  it('is non-empty and includes all three shipping providers', () => {
    expect(PLATFORM_PROVIDERS.length).toBeGreaterThanOrEqual(3);
    expect([...PLATFORM_PROVIDERS]).toEqual(expect.arrayContaining(['Anthropic', 'KIE', 'Comet']));
  });

  /* A provider added to the union with no row here is a compile error above and a red test here. */
  it('every declared provider has a sentinel and an expected env var in this file', () => {
    for (const provider of PLATFORM_PROVIDERS) {
      expect(SENTINEL[provider], `no sentinel for ${provider}`).toBeTruthy();
      expect(EXPECTED_KEY_ENV[provider], `no expected env var for ${provider}`).toBeTruthy();
    }
  });
});

describe('requirePlatformKey — a provider spends ITS OWN key, never a neighbour’s', () => {
  /*
   * 🔴 THE CASE THE TERNARY GOT WRONG. All three keys present: the only way to be right is to look
   * the provider up. Falling through to Anthropic (what `provider === 'KIE' ? kie : anthropic` did)
   * returns a real, working, WRONG credential — the request succeeds, the operator is billed by a
   * vendor they did not choose, and nothing anywhere throws.
   */
  for (const provider of PLATFORM_PROVIDERS) {
    it(`${provider} resolves the ${EXPECTED_KEY_ENV[provider]} value and no other`, () => {
      const key = requirePlatformKey(configWithAllKeys(provider));

      expect(key).toBe(SENTINEL[provider]);

      for (const other of PLATFORM_PROVIDERS) {
        if (other !== provider) {
          expect(key, `${provider} resolved ${other}'s key`).not.toBe(SENTINEL[other]);
        }
      }
    });

    it(`${provider} reports its key present only when it is actually present`, () => {
      expect(hasPlatformKey(configWithAllKeys(provider))).toBe(true);
      expect(hasPlatformKey(configWithoutOwnKey(provider))).toBe(false);
    });
  }
});

describe('requirePlatformKey — a missing key is a describable 503, naming the right variable', () => {
  /*
   * The other half of the same defect, and the one an operator actually meets: with every OTHER
   * provider's key set, a lookup that falls through reports SUCCESS while holding the wrong
   * credential. Credits mode never falls back to a provider picker and never falls back to another
   * provider's key — a misconfiguration is a state to REPORT (§4.1, §1.3 principle 0).
   */
  for (const provider of PLATFORM_PROVIDERS) {
    const ownVar = EXPECTED_KEY_ENV[provider];

    it(`${provider} with only the OTHER providers' keys throws NotConfiguredError`, () => {
      expect(() => requirePlatformKey(configWithoutOwnKey(provider))).toThrow(NotConfiguredError);
    });

    it(`${provider}'s error names ${provider} and ${ownVar}, and no other provider's variable`, () => {
      let message = '';

      try {
        requirePlatformKey(configWithoutOwnKey(provider));
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(provider);
      expect(message).toContain(ownVar);

      /*
       * ⚠️ The load-bearing half. An error that names the WRONG variable is worse than no error: it
       * sends someone to set a key that changes nothing, and the symptom does not move. This is the
       * same failure `getTierModel`'s message shipped for months while instructing operators to set
       * RETIRED env vars — nothing tests the text of a failure path unless someone writes it down.
       */
      for (const other of PLATFORM_PROVIDERS) {
        if (other !== provider) {
          expect(message, `${provider}'s error names ${EXPECTED_KEY_ENV[other]}`).not.toContain(
            EXPECTED_KEY_ENV[other],
          );
        }
      }
    });
  }

  /* An empty string is not a key. Falsy is falsy on both doors, or one lies to the other. */
  it('an empty-string key is treated as absent by BOTH doors', () => {
    const config: PlatformConfig = {
      provider: 'Comet',
      cometApiKey: '',
      proFeaturesEnabled: false,
    };

    expect(hasPlatformKey(config)).toBe(false);
    expect(() => requirePlatformKey(config)).toThrow(NotConfiguredError);
  });
});

describe('platformKeyEnvFor agrees with the key that actually resolves', () => {
  /*
   * 🔴 THE DRIFT GUARD, and the reason it is driven through `getPlatformConfig` rather than asserted
   * against a table.
   *
   * There are two independent answers to "which key does this provider need": the NAME
   * (`PLATFORM_KEY_ENV`, quoted in the 503 and in the health report) and the VALUE (`platformKeyFor`,
   * which decides what gets spent). They were separate expressions — one exhaustive record, one
   * ternary — so they could disagree, and when they did the product told the operator to set
   * `COMET_API_KEY` and then spent `ANTHROPIC_API_KEY`. Both would have to be wrong in the same
   * direction to pass this: it stubs ONLY the env var `platformKeyEnvFor` names, and requires the key
   * that comes back out of `requirePlatformKey` to be the value that went in.
   *
   * That also pins the third link nothing else covers — that `getPlatformConfig` reads that variable
   * into the field the lookup reads back.
   */
  for (const provider of PLATFORM_PROVIDERS) {
    it(`${provider}: ${EXPECTED_KEY_ENV[provider]} is both the advertised variable and the spent one`, () => {
      expect(platformKeyEnvFor(provider)).toBe(EXPECTED_KEY_ENV[provider]);

      vi.stubEnv('LLM_PROVIDER', provider);
      vi.stubEnv(platformKeyEnvFor(provider), SENTINEL[provider]);

      const config = getPlatformConfig();

      expect(config.provider).toBe(provider);
      expect(hasPlatformKey(config)).toBe(true);
      expect(requirePlatformKey(config)).toBe(SENTINEL[provider]);
    });

    it(`${provider}: with every OTHER variable set and its own unset, it is NOT configured`, () => {
      vi.stubEnv('LLM_PROVIDER', provider);

      for (const other of PLATFORM_PROVIDERS) {
        if (other !== provider) {
          vi.stubEnv(EXPECTED_KEY_ENV[other], SENTINEL[other]);
        }
      }

      const config = getPlatformConfig();

      expect(hasPlatformKey(config)).toBe(false);
      expect(() => requirePlatformKey(config)).toThrow(NotConfiguredError);
    });
  }

  /* Every provider needs a DISTINCT variable — two sharing one would make the record decorative. */
  it('no two providers read the same env var', () => {
    const vars = PLATFORM_PROVIDERS.map((provider) => platformKeyEnvFor(provider));

    expect(new Set(vars).size).toBe(PLATFORM_PROVIDERS.length);
  });
});
