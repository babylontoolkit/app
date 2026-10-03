/**
 * WHO SERVES RENDERS, AND WHOSE KEY PAYS FOR THEM (`config.ts` — `getMediaProvider` /
 * `getMediaConfig` / `requireMediaKey` / `mediaKeyEnvFor`, SPEC §4.16, §5, T7).
 *
 * ## Why media has its own switch at all
 *
 * A generation and a render are different money paths: a render's price is EXACT and debited BEFORE
 * any spend, from a per-gateway price list, with its own refund machinery. Tying media to
 * `LLM_PROVIDER` would mean a text cutover silently moves every render to a gateway whose media
 * surface nobody has driven — so `MEDIA_PROVIDER` exists, defaults to the LLM provider when that is a
 * media gateway, and otherwise to KIE (Anthropic sells no renders; Comet stopped being a media gateway
 * on 2026-10-01 and is refused by name).
 *
 * ## The two failures these tests are for, both silent
 *
 * **(a) A degraded capability must report OFF, never ON.** A gateway with no key is `null` from
 * `getMediaConfig` — never another gateway's key, which would spend on a provider the operator never
 * chose and price the render from a list they never promoted.
 *
 * **(b) `requireMediaKey` takes the provider as an ARGUMENT.** Its most important caller is the POLL
 * path, which must ask about the gateway the task was CREATED on. A version that read the configured
 * provider instead would fail every in-flight KIE render the moment an operator flipped the switch —
 * and it would fail by asking Comet for a key, which on a dual-key box succeeds with the wrong
 * credential.
 *
 * ⚠️ **Every case scrubs the whole precedence chain.** `env()` falls back to `process.env`, Vitest
 * loads `.env.local`, and this machine's really does hold `COMET_API_KEY` — so an unstubbed "this
 * provider has no key" assertion grades against the operator's live credential, passes on CI, and
 * fails only for the person who configured it (the `oauth.spec.ts` trap, fourth occurrence in this
 * repo).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_EXAMPLE_FILENAME, envExampleAssignments } from '~/lib/.server/billing/env-example';
import {
  MEDIA_ONLY_PROVIDERS,
  MEDIA_PROVIDERS,
  NotConfiguredError,
  PLATFORM_PROVIDERS,
  getMediaConfig,
  getMediaProvider,
  mediaKeyEnvFor,
  mediaKeyFor,
  requireMediaKey,
  type MediaProviderName,
} from './config';

/**
 * Which env var holds each gateway's media key — **LITERALS on purpose.**
 *
 * The module keeps the same fact in `MEDIA_KEY_ENV`; asserting `mediaKeyEnvFor(p)` against an import
 * of that table would move both sides of the comparison together and pass for any value (this repo's
 * `PROGRESS_CAP` vacuity trap). These strings are what an operator types into SSM — a published
 * interface, and changing one is a breaking config change that should read as one here.
 *
 * They are deliberately the SAME variables the LLM side uses: one key per vendor, one bill.
 */
const EXPECTED_KEY_ENV: Record<MediaProviderName, string> = {
  KIE: 'KIE_API_KEY',
  FAL: 'FAL_API_KEY',
};

/** Distinct per gateway, so "it returned *a* key" and "it returned *the right* key" cannot be confused. */
const SENTINEL: Record<MediaProviderName, string> = {
  KIE: 'sentinel-KIE-media-key',
  FAL: 'sentinel-FAL-media-key',
};

/** Everything that can decide which gateway is configured, or whether a key is present. */
/*
 * `FAL_API_KEY` too: `.env.local` on this machine holds a REAL one, so an unscrubbed "FAL has no key"
 * assertion would grade against the live credential (the `oauth.spec.ts` trap).
 */
const MEDIA_ENV = [
  'MEDIA_PROVIDER',
  'LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'KIE_API_KEY',
  'COMET_API_KEY',
  'FAL_API_KEY',
  'COMET_BASE_URL',
] as const;

beforeEach(() => {
  for (const key of MEDIA_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubAllKeys() {
  for (const provider of MEDIA_PROVIDERS) {
    vi.stubEnv(EXPECTED_KEY_ENV[provider], SENTINEL[provider]);
  }
}

describe('the union these tests are generated from', () => {
  /*
   * CONTROL. Every parameterised block below derives its cases from `MEDIA_PROVIDERS`, and a suite
   * over an empty list runs zero tests and reports green.
   */
  it('MEDIA_PROVIDERS is exactly KIE and FAL', () => {
    /*
     * Comet was removed as a media gateway on 2026-10-01 (a security issue) and as a platform provider on
     * 2026-10-03 (`_specs/anthropic-only_plan.md`): KIE and fal are the only media paths, Anthropic the only LLM.
     */
    expect([...MEDIA_PROVIDERS]).toEqual(['KIE', 'FAL']);
    expect(MEDIA_PROVIDERS).not.toContain('Comet' as never);
    expect([...PLATFORM_PROVIDERS]).toEqual(['Anthropic']);
  });

  it('is non-empty and excludes Anthropic', () => {
    expect(MEDIA_PROVIDERS.length).toBeGreaterThanOrEqual(2);

    // Anthropic is a platform provider that sells no renders — the reason `null` is a real answer.
    expect(PLATFORM_PROVIDERS).toContain('Anthropic');
    expect(MEDIA_PROVIDERS).not.toContain('Anthropic' as never);
  });

  it('every declared gateway has a sentinel and an expected env var in this file', () => {
    for (const provider of MEDIA_PROVIDERS) {
      expect(SENTINEL[provider], `no sentinel for ${provider}`).toBeTruthy();
      expect(EXPECTED_KEY_ENV[provider], `no expected env var for ${provider}`).toBeTruthy();
    }
  });
});

describe('fal.ai is a media-only gateway (media-gateways T3)', () => {
  it('every media provider is a platform provider or media-only', () => {
    for (const provider of MEDIA_PROVIDERS) {
      const platform = (PLATFORM_PROVIDERS as readonly string[]).includes(provider);
      const mediaOnly = (MEDIA_ONLY_PROVIDERS as readonly string[]).includes(provider);

      expect(platform || mediaOnly, `${provider} is neither`).toBe(true);
      expect(platform && mediaOnly, `${provider} is both`).toBe(false);
    }

    // CONTROL: fal is a media provider, and it is NOT offered to the LLM ladder.
    expect(MEDIA_PROVIDERS).toContain('FAL');
    expect(PLATFORM_PROVIDERS).not.toContain('FAL' as never);
  });

  it('MEDIA_PROVIDER=fal selects FAL and reads FAL_API_KEY', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('MEDIA_PROVIDER', 'fal');
    stubAllKeys();

    expect(getMediaProvider()).toBe('FAL');
    expect(mediaKeyEnvFor('FAL')).toBe('FAL_API_KEY');

    // fal's OWN key — never the KIE key the LLM side is using — and no base-URL override.
    expect(getMediaConfig()).toEqual({ provider: 'FAL', apiKey: SENTINEL.FAL, baseUrl: undefined });
  });

  it('is never reached by the LLM-provider fallback — only MEDIA_PROVIDER selects it', () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('FAL_API_KEY', SENTINEL.FAL);

    // A fal key alone does not make fal the media gateway; the fallback is KIE, which has no key here.
    expect(getMediaProvider()).toBe('KIE');
    expect(getMediaConfig()).toBeNull();
  });
});

describe('getMediaProvider — MEDIA_PROVIDER wins, LLM_PROVIDER is the default', () => {
  it('follows the LLM provider when nothing overrides it and it is a media gateway', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(getMediaProvider()).toBe('KIE');
  });

  it('LLM_PROVIDER=Comet with no MEDIA_PROVIDER falls back to KIE, never Comet', () => {
    /*
     * 🔴 Comet is still a platform (LLM) provider, so a Comet text deploy is a real configuration — and
     * its renders must NOT follow it. Both keys are present: the answer must be KIE with KIE's key, so
     * a version that resolved Comet (or handed back Comet's credential) fails here.
     */
    vi.stubEnv('LLM_PROVIDER', 'Comet');
    vi.stubEnv('COMET_API_KEY', 'sentinel-COMET-llm-key');
    stubAllKeys();

    expect(getMediaProvider()).toBe('KIE');
    expect(getMediaConfig()).toEqual({ provider: 'KIE', apiKey: SENTINEL.KIE });
  });

  it('MEDIA_PROVIDER=Comet is refused, naming KIE and FAL', () => {
    /*
     * A describable refusal, never a quiet fall-through to KIE: an operator who typed Comet believes
     * renders are going there, and the honest answer is that they cannot. Case-insensitive, like every
     * other value of this variable.
     */
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    stubAllKeys();

    for (const spelling of ['Comet', 'comet', 'COMET', ' Comet ']) {
      vi.stubEnv('MEDIA_PROVIDER', spelling);

      expect(() => getMediaProvider(), spelling).toThrow(NotConfiguredError);
      expect(() => getMediaProvider(), spelling).toThrow(/no longer a media gateway/);
      expect(() => getMediaProvider(), spelling).toThrow(/KIE/);
      expect(() => getMediaProvider(), spelling).toThrow(/FAL/);
      expect(() => getMediaConfig(), spelling).toThrow(NotConfiguredError);
    }
  });

  it('falls back to the platform default (KIE) when neither var is set', () => {
    expect(getMediaProvider()).toBe('KIE');
  });

  for (const provider of MEDIA_PROVIDERS) {
    it(`MEDIA_PROVIDER=${provider} OUTRANKS a different LLM_PROVIDER`, () => {
      /*
       * 🔴 The whole point of the separate switch: media and text can be cut over independently. An
       * implementation that read `LLM_PROVIDER` first would move every render with the text cutover,
       * onto a gateway whose media surface has not been driven — and it would do so silently.
       */
      const other = MEDIA_PROVIDERS.find((name) => name !== provider)!;
      vi.stubEnv('LLM_PROVIDER', other);
      vi.stubEnv('MEDIA_PROVIDER', provider);

      expect(getMediaProvider()).toBe(provider);
    });
  }

  it('falls back to KIE on Anthropic, which sells no renders — and is OFF without a KIE key', () => {
    /*
     * The fallback names KIE, the incumbent media gateway, and it spends only KIE's OWN key: with no
     * `KIE_API_KEY` the box reports "not configured" (`null`), which is what the Media panel, the
     * agent tool gate and the route's 503 all read — never another gateway's credential.
     */
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('FAL_API_KEY', SENTINEL.FAL);

    expect(getMediaProvider()).toBe('KIE');
    expect(getMediaConfig(), 'an Anthropic deploy borrowed another gateway').toBeNull();

    vi.stubEnv('KIE_API_KEY', SENTINEL.KIE);
    expect(getMediaConfig()).toEqual({ provider: 'KIE', apiKey: SENTINEL.KIE });
  });

  it('lets MEDIA_PROVIDER rescue an Anthropic deploy', () => {
    // Text on Anthropic, renders on KIE — the reason the override exists rather than a hardcoded rule.
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('MEDIA_PROVIDER', 'KIE');

    expect(getMediaProvider()).toBe('KIE');
  });

  it('THROWS on an unrecognised MEDIA_PROVIDER instead of falling through', () => {
    /*
     * A typo must be a describable error at config time — never a quiet fall-through to whatever the
     * LLM side happens to be, which would spend on a gateway nobody chose while the operator believes
     * the switch took effect.
     */
    vi.stubEnv('MEDIA_PROVIDER', 'Kei');

    expect(() => getMediaProvider()).toThrow(NotConfiguredError);
    expect(() => getMediaProvider()).toThrow(/MEDIA_PROVIDER="Kei"/);

    // The message names what IS supported, so the operator has a fix and not just a complaint.
    expect(() => getMediaProvider()).toThrow(new RegExp(MEDIA_PROVIDERS.join(', ')));
  });

  it('refuses a PLATFORM provider that is not a media gateway, by name', () => {
    /*
     * `MEDIA_PROVIDER=Anthropic` is the plausible mistake — a real provider name, wrong list. Falling
     * through to "no media" would look identical to a correct Anthropic deploy and leave the operator
     * with a switch that appears to do nothing.
     */
    vi.stubEnv('MEDIA_PROVIDER', 'Anthropic');

    expect(() => getMediaProvider()).toThrow(NotConfiguredError);
    expect(() => getMediaProvider()).toThrow(/Not a media provider/);
  });

  for (const provider of MEDIA_PROVIDERS) {
    it(`accepts ${provider} case-insensitively, like LLM_PROVIDER`, () => {
      vi.stubEnv('MEDIA_PROVIDER', provider.toLowerCase());
      expect(getMediaProvider()).toBe(provider);
    });
  }

  it('treats whitespace and empty strings as unset, not as a typo', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('MEDIA_PROVIDER', '   ');

    expect(getMediaProvider()).toBe('KIE');
  });
});

describe('requireMediaKey — the key for the gateway you ASK about, not the configured one', () => {
  for (const provider of MEDIA_PROVIDERS) {
    it(`${provider} resolves ${EXPECTED_KEY_ENV[provider]} and no other, whatever MEDIA_PROVIDER says`, () => {
      /*
       * 🔴 THE POLL RULE. A KIE render started before a cutover is still polled and downloaded on KIE
       * — so a Comet-configured box must still hand back the KIE key when asked for it. A version
       * that read the configured provider would return a real, working, WRONG credential on a
       * dual-key box: the request succeeds against the wrong vendor and nothing throws.
       */
      const other = MEDIA_PROVIDERS.find((name) => name !== provider)!;
      vi.stubEnv('MEDIA_PROVIDER', other);
      stubAllKeys();

      const key = requireMediaKey(provider);

      expect(key).toBe(SENTINEL[provider]);
      expect(key, `${provider} resolved ${other}'s key`).not.toBe(SENTINEL[other]);
      expect(mediaKeyFor(provider)).toBe(SENTINEL[provider]);
    });

    it(`${provider} reports NOT configured when only the other gateway's key is set`, () => {
      const other = MEDIA_PROVIDERS.find((name) => name !== provider)!;
      vi.stubEnv(EXPECTED_KEY_ENV[other], SENTINEL[other]);

      expect(mediaKeyFor(provider)).toBeUndefined();
      expect(() => requireMediaKey(provider)).toThrow(NotConfiguredError);
    });

    it(`${provider}'s error names ${EXPECTED_KEY_ENV[provider]} and no other gateway's variable`, () => {
      let message = '';

      try {
        requireMediaKey(provider);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain(provider);
      expect(message).toContain(EXPECTED_KEY_ENV[provider]);

      /*
       * ⚠️ An error naming the WRONG variable is worse than no error: it sends someone to set a key
       * that changes nothing and the symptom does not move. Nothing tests the text of a failure path
       * unless someone writes it down — which is how `getTierModel` shipped a message instructing
       * operators to set RETIRED variables.
       */
      for (const other of MEDIA_PROVIDERS) {
        if (other !== provider) {
          expect(message, `${provider}'s error names ${EXPECTED_KEY_ENV[other]}`).not.toContain(
            EXPECTED_KEY_ENV[other],
          );
        }
      }
    });
  }

  it('advertises the same variable it actually spends', () => {
    /*
     * 🔴 THE DRIFT GUARD. There are two answers to "which key does this gateway need": the NAME
     * (quoted in the 503 and in operator guidance) and the VALUE. The LLM side shipped those as two
     * separate expressions and they disagreed — the product told operators to set `COMET_API_KEY` and
     * then spent `ANTHROPIC_API_KEY`. Both would have to be wrong in the same direction to pass this:
     * only the variable `mediaKeyEnvFor` names is stubbed, and the value must come back out.
     */
    for (const provider of MEDIA_PROVIDERS) {
      vi.unstubAllEnvs();

      for (const key of MEDIA_ENV) {
        vi.stubEnv(key, undefined as unknown as string);
      }

      expect(mediaKeyEnvFor(provider)).toBe(EXPECTED_KEY_ENV[provider]);
      vi.stubEnv(mediaKeyEnvFor(provider), SENTINEL[provider]);

      expect(requireMediaKey(provider)).toBe(SENTINEL[provider]);
    }
  });

  it('gives every gateway a DISTINCT variable', () => {
    // Two gateways sharing one variable would make the record decorative and the drift guard vacuous.
    const vars = MEDIA_PROVIDERS.map((provider) => mediaKeyEnvFor(provider));

    expect(new Set(vars).size).toBe(MEDIA_PROVIDERS.length);
  });
});

describe('getMediaConfig — "can this box render?" is ONE fact', () => {
  for (const provider of MEDIA_PROVIDERS) {
    it(`returns ${provider} with its own key when both are present`, () => {
      vi.stubEnv('MEDIA_PROVIDER', provider);
      stubAllKeys();

      expect(getMediaConfig()).toEqual({ provider, apiKey: SENTINEL[provider] });
    });

    it(`returns null for ${provider} when its key is missing, even with the other gateway's key set`, () => {
      /*
       * ⚠️ "No media provider" and "no key for it" are ONE fact to every caller — the tool gate, the
       * panel, the route's 503. Splitting them would invite a caller to treat a keyless gateway as
       * usable, and returning the OTHER gateway's key here is the wrong-vendor spend one line up.
       */
      const other = MEDIA_PROVIDERS.find((name) => name !== provider)!;
      vi.stubEnv('MEDIA_PROVIDER', provider);
      vi.stubEnv(EXPECTED_KEY_ENV[other], SENTINEL[other]);

      expect(getMediaConfig()).toBeNull();
    });
  }

  it('propagates a typo rather than reporting "no media"', () => {
    /*
     * A `null` here would tell the operator their box serves no media, which is true-looking and
     * wrong: the box is misconfigured, and that is a different sentence with a different fix.
     */
    vi.stubEnv('MEDIA_PROVIDER', 'Kei');
    stubAllKeys();

    expect(() => getMediaConfig()).toThrow(NotConfiguredError);
  });

  it('treats an empty-string key as absent', () => {
    vi.stubEnv('MEDIA_PROVIDER', 'KIE');
    vi.stubEnv('KIE_API_KEY', '');

    expect(getMediaConfig()).toBeNull();
    expect(() => requireMediaKey('KIE')).toThrow(NotConfiguredError);
  });
});

describe('.env.example documents MEDIA_PROVIDER without assigning it twice', () => {
  const example = readFileSync(join(process.cwd(), ENV_EXAMPLE_FILENAME), 'utf8');

  /*
   * 🔴 THE LADDER'S DUPLICATE-KEY PIN IS KEY-SCOPED, SO IT DOES NOT COVER THIS ONE.
   *
   * `model-tiers.spec.ts` counts assignments for a fixed `LADDER_KEYS` list. That list caught the
   * first draft of the `MEDIA_PROVIDER` block — but only because the block accidentally opened a
   * comment line with `LLM_PROVIDER=`, i.e. it fired on a DIFFERENT key. Nothing pinned
   * `MEDIA_PROVIDER` itself, while the block's own prose claimed the pin covered it: a comment
   * asserting a protection that does not reach its own case, which is how the two-writers trap has
   * already been let through this file twice.
   *
   * ⚠️ It cannot join `LADDER_KEYS`, which asserts EXACTLY ONE. `MEDIA_PROVIDER` is deliberately
   * UNASSIGNED — documented in prose so an operator can add it, left unwritten so that when they do,
   * theirs is the only line. So the rule here is AT MOST one, plus a control that the variable is
   * genuinely documented (a pin that only counts assignments is satisfied by deleting the block).
   */
  it('is documented in prose', () => {
    expect(example).toContain('MEDIA_PROVIDER');
  });

  it('is assigned at most once, commented lines included', () => {
    const assignments = envExampleAssignments(example, 'MEDIA_PROVIDER');

    expect(
      assignments,
      `assigned ${assignments.length}x: ${JSON.stringify(assignments)} — a second line silently WINS ` +
        'in a real .env, so a commented example beside a real value is a live misconfiguration',
    ).toHaveLength(0);
  });

  it('counts a commented assignment of THIS key (control)', () => {
    /*
     * Without this, the assertion above is green for a counter that never matches `MEDIA_PROVIDER` at
     * all — the vacuous-scan shape this repo keeps finding.
     */
    const synthetic = ['MEDIA_PROVIDER=KIE', '# prose', '# MEDIA_PROVIDER=FAL'].join('\n');

    expect(envExampleAssignments(synthetic, 'MEDIA_PROVIDER')).toHaveLength(2);
  });
});
