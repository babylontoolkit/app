/**
 * Cache-warmer tests (§4.2.8, `cache-warmer.ts`).
 *
 * Two properties matter and both fail SILENTLY:
 *
 * 1. **Byte-identity with the proxy's block 1.** The warmer only buys anything while its request is
 *    byte-identical to what the proxy sends (same text, same `cache_control` tier/TTL, same model,
 *    same auth on the same provider's base). A drifted warmer warms a prefix nobody sends — false
 *    comfort, cents spent for nothing — so `buildWarmupRequest` is pinned field by field.
 *
 * 1b. **And the right provider's key goes to the right provider's host.** The wire used to be
 *    `anthropicDirect ? {anthropic} : {KIE}` — a binary meaning "Anthropic, or ELSE KIE" — so with a
 *    third provider declared, a Comet deploy POSTed a live Comet credential to `api.kie.ai` on a
 *    timer. This file contained ZERO occurrences of "Comet" until T3, which is why reverting that
 *    record broke none of 719 tests. The per-provider cases below are therefore backed by assertions
 *    derived from the DECLARED `PLATFORM_PROVIDERS` union, since a per-provider test only exists for a
 *    provider somebody remembered.
 *
 * 2. **The suite can never spend real money.** `runWarmCycle` hits KIE's real wire when it runs;
 *    `ensureCacheWarmer` is VITEST-guarded, and every test here drives the cycle with an injected
 *    fetch. The real-spend guard test asserts the scrubbed-env cycle SKIPS before any network call.
 *
 * ⚠️ The `oauth.spec.ts` trap is armed: `env()` falls back to the developer's `.env.local`, which on
 * this machine really does carry `KIE_API_KEY`/`LLM_MODEL`. The WHOLE precedence chain is scrubbed
 * in `beforeEach`, or these tests grade against the operator's real config with CI green.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KIE_DEFAULT_BASE_URL } from '~/lib/modules/llm/providers/kie-wire';
import { COMET_DEFAULT_BASE_URL } from '~/lib/modules/llm/providers/comet-wire';
import {
  AUTO_MODEL_SELECT_ENV_KEY,
  LLM_PROVIDER_CHAIN_ENV_KEY,
  PLATFORM_PROVIDERS,
  type PlatformProviderName,
} from '~/lib/.server/agent/config';
import { recordProviderFailure, resetProviderHealth } from '~/lib/.server/agent/provider-select';
import { invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  buildWarmupRequest,
  cacheWarmerEnabled,
  cacheWarmerFanout,
  cacheWarmerIntervalMinutes,
  DEFAULT_ANTHROPIC_FANOUT,
  DEFAULT_CACHE_WARMER_FANOUT,
  DEFAULT_CACHE_WARMER_INTERVAL_MINUTES,
  DEFAULT_COMET_FANOUT,
  ensureCacheWarmer,
  lastCacheReadAt,
  parseWarmupStreamUsage,
  PROMPT_CACHE_TTL,
  recordCacheRead,
  resetCacheWarmerForTests,
  runWarmCycle,
  shouldSkipWarmCycle,
} from './cache-warmer';

/*
 * `getActivePrompt` reads the real prompt store (`.data/prompt` locally) — mock it so no test depends
 * on what happens to be synced on this machine, and so the "no active prompt" state is drivable.
 */
const { getActivePromptMock } = vi.hoisted(() => ({ getActivePromptMock: vi.fn() }));

vi.mock('./active', () => ({
  getActivePrompt: getActivePromptMock,
  invalidateActivePrompt: vi.fn(),
}));

/** Scrub the WHOLE chain the warmer reads — enabled flag, provider, model precedence, key, tuning. */
const WARMER_ENV = [
  /*
   * 🔴 `AUTO_MODEL_SELECT` and `LLM_PROVIDER_CHAIN` OUTRANK `LLM_PROVIDER` since 2026-08-10, and the
   * warmer resolves through the ladder — so they are the newest members of the very precedence chain
   * this list exists to scrub. This developer's `.env.local` really does set `AUTO_MODEL_SELECT=true`,
   * which means omitting it does not make the old cases fail: it makes every one of them silently
   * become a test of the LADDER while claiming to test `LLM_PROVIDER`, passing or failing on which
   * gateway keys happen to be in the environment. Exactly the `oauth.spec.ts` trap the header warns
   * about, and exactly how it fired on `platform-key.spec.ts` when this flag shipped.
   */
  AUTO_MODEL_SELECT_ENV_KEY,
  LLM_PROVIDER_CHAIN_ENV_KEY,
  'LLM_PROVIDER',
  'LLM_MODEL',
  'KIE_DEFAULT_MODEL',
  'KIE_API_KEY',

  /*
   * ⚠️ `ANTHROPIC_API_KEY` is on this list for the reason CLAUDE.md records TWICE (`oauth.spec.ts`,
   * `billing.spec.ts` `KIE_ENV`): `env()` falls back to `process.env`, vitest loads `.env.local`, and
   * the developer running these tests has a REAL Anthropic key sitting there. Omit it and the
   * "no key configured" assertions pass on CI and fail only on the machine of the person who
   * configured the provider — blaming code they did not touch.
   */
  'ANTHROPIC_API_KEY',

  /*
   * ⚠️ `COMET_API_KEY` is the third instance of that same trap, and on THIS machine it is not
   * hypothetical: `.env.local` carries a live Comet key alongside `LLM_PROVIDER=Comet` and a
   * `gpt-*` `LLM_MODEL`. Omit any of them and the "Comet has no key" / "the model is not Claude"
   * cases grade against the operator's real config — green on CI, red only for the person who set the
   * provider up.
   */
  'COMET_API_KEY',

  /*
   * These reach the ladder's `canPrice` gate through `providerRates`' per-rung gap-fill injection, so a
   * leftover changes which gateway the warmer chooses rather than failing loudly. `ENABLE_PREMIUM_MODEL`
   * is a RETIRED key that `refuseRetiredModelTierEnv` throws on — scrubbed, never stubbed with a value.
   */
  'ENABLE_EXTENDED_MODELS',
  'ENABLE_PREMIUM_MODEL',
  'ENABLE_PLATINUM_MODEL',
  'PREMIUM_MODEL',
  'PLATINUM_MODEL',
  'PREMIUM_MINIMUM_CREDITS',
  'PLATINUM_MINIMUM_CREDITS',

  /*
   * The base URLs are CONSTANTS today (`COMET_DEFAULT_BASE_URL`, `KIE_DEFAULT_BASE_URL`), so nothing
   * here reads these. They are scrubbed so that the day one of them becomes overridable, the
   * distinct-origin assertion below is measuring the code and not this developer's `.env.local`.
   */
  'COMET_BASE_URL',
  'KIE_BASE_URL',
  'CACHE_WARMER_ENABLED',
  'CACHE_WARMER_FANOUT',
  'CACHE_WARMER_INTERVAL_MINUTES',
] as const;

/** An immediate sleep so a fanout of N does not take 2N seconds of wall clock. */
const instantSleep = vi.fn(() => Promise.resolve());

/**
 * A KIE-shaped OK response: an SSE stream whose `message_start` carries the usage (the warmer sends
 * `stream: true` — KIE 500s non-streaming requests, see `buildWarmupRequest`).
 */
function okResponse(usage: Record<string, unknown>): Response {
  const sse =
    `event: message_start\n` +
    `data: ${JSON.stringify({ type: 'message_start', message: { usage } })}\n\n` +
    `event: content_block_delta\n` +
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n` +
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

  return {
    ok: true,
    text: async () => sse,
  } as unknown as Response;
}

beforeEach(() => {
  for (const key of WARMER_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }

  getActivePromptMock.mockReset();
  getActivePromptMock.mockResolvedValue({ id: 'pv_test', content: 'THE BASE PROMPT' });
  instantSleep.mockClear();
  resetCacheWarmerForTests();

  /*
   * Module state the ladder reads: a cooldown left standing by one case decides which gateway the next
   * one warms, and the price cache would otherwise carry a promoted list between files.
   */
  resetProviderHealth();
  invalidateMarketPricesCache();
});

afterEach(() => {
  resetCacheWarmerForTests();
  resetProviderHealth();
  invalidateMarketPricesCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('buildWarmupRequest — byte-identity with the proxy block 1', () => {
  const request = () =>
    buildWarmupRequest({ model: 'claude-opus-5', promptText: 'THE BASE PROMPT', apiKey: 'k-123', provider: 'KIE' });

  it('targets /messages on the KIE base URL', () => {
    expect(request().url).toBe(`${KIE_DEFAULT_BASE_URL}/messages`);
    expect(request().url.endsWith('/messages')).toBe(true);
  });

  /* KIE's quirk: Bearer auth, NOT Anthropic's `x-api-key`. Drifting here 401s every warm request. */
  it('authenticates with a Bearer header, never x-api-key', () => {
    const { headers } = request();

    expect(headers.authorization).toBe('Bearer k-123');
    expect(Object.keys(headers).some((h) => h.toLowerCase() === 'x-api-key')).toBe(false);
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('spends the minimum: max_tokens 1', () => {
    expect(request().body.max_tokens).toBe(1);
  });

  /*
   * 🔴 The shape KIE actually serves (2026-08-04, measured live): their Claude endpoint 500s every
   * NON-streaming request while serving `stream: true` normally, so a warmer without this flag fails
   * 6/6 on every cycle while user generations run fine — false alarm on the monitor, and no prefix
   * warmed. Also the mode the traffic it warms for actually uses.
   */
  it('streams — the request mode KIE serves and the one generations use', () => {
    expect(request().body.stream).toBe(true);
  });

  it('carries exactly one system block: the prompt text under the 1h ephemeral cache_control', () => {
    const system = request().body.system as Array<{ text: string; cache_control: unknown }>;

    expect(system).toHaveLength(1);
    expect(system[0].text).toBe('THE BASE PROMPT');
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('passes the model through — the cache is per-model', () => {
    expect(request().body.model).toBe('claude-opus-5');
  });

  /* The proxy imports this constant for its own CACHE_CONTROL, so the TTL cannot fork. Pin it. */
  it('PROMPT_CACHE_TTL is the 1h tier', () => {
    expect(PROMPT_CACHE_TTL).toBe('1h');
  });
});

describe('config: interval, fanout, enabled', () => {
  it('interval defaults to 45 minutes', () => {
    expect(DEFAULT_CACHE_WARMER_INTERVAL_MINUTES).toBe(45);
    expect(cacheWarmerIntervalMinutes()).toBe(45);
  });

  /* Over the 55-minute ceiling (≥ the 1h TTL) every cycle would be a fresh 2x write — ignored. */
  it('interval over 55 falls back to the default', () => {
    vi.stubEnv('CACHE_WARMER_INTERVAL_MINUTES', '90');
    expect(cacheWarmerIntervalMinutes()).toBe(45);
  });

  /* Zero would be a spend loop — ignored, never obeyed. */
  it('interval of 0 falls back to the default', () => {
    vi.stubEnv('CACHE_WARMER_INTERVAL_MINUTES', '0');
    expect(cacheWarmerIntervalMinutes()).toBe(45);
  });

  it('interval honors a sane override', () => {
    vi.stubEnv('CACHE_WARMER_INTERVAL_MINUTES', '30');
    expect(cacheWarmerIntervalMinutes()).toBe(30);
  });

  it('fanout defaults to 6 on KIE — its balancer needs covering', () => {
    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(DEFAULT_CACHE_WARMER_FANOUT).toBe(6);
    expect(cacheWarmerFanout()).toBe(6);
  });

  it('fanout of 0 falls back to the default', () => {
    vi.stubEnv('CACHE_WARMER_FANOUT', '0');
    expect(cacheWarmerFanout()).toBe(6);
  });

  it('fanout over 16 falls back to the default', () => {
    vi.stubEnv('CACHE_WARMER_FANOUT', '20');
    expect(cacheWarmerFanout()).toBe(6);
  });

  it('fanout honors a sane override', () => {
    vi.stubEnv('CACHE_WARMER_FANOUT', '3');
    expect(cacheWarmerFanout()).toBe(3);
  });

  /*
   * 🔴 The default INVERTED 2026-08-08. The warmer can only warm the SHARED prefix (~31k of ~40k), and
   * which side wins depends on how many cold starts a day the platform has — a number nobody has
   * measured. It ships off; `generations.cacheCreationTokens > 0` is a cold start, so counting them for
   * a week turns a guess into a five-minute decision.
   *
   * ⚠️ The dollar figures that used to sit here were silently ANTHROPIC-ONLY, and the break-even is
   * `~3.4 x fanout` cold starts a day — the input rate cancels, so only the FANOUT moves it. On Comet
   * (fanout 5) that is ~8.4/day against Anthropic's ~1.7. The arithmetic lives in ONE place,
   * `cacheWarmerEnabled`'s doc comment, rather than being restated here where it would drift.
   */
  it('🔴 enabled defaults to FALSE — the warmer ships off until cold starts are counted', () => {
    expect(cacheWarmerEnabled()).toBe(false);
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    expect(cacheWarmerEnabled()).toBe(true);
  });
});

describe('shouldSkipWarmCycle — do not pay to warm what traffic already warmed', () => {
  const MIN = 60_000;

  it('skips when organic traffic read the cache inside the interval', () => {
    expect(shouldSkipWarmCycle({ nowMs: 100 * MIN, lastReadAtMs: 80 * MIN, intervalMinutes: 45 })).toBe(true);
  });

  it('runs when the last read is older than the interval', () => {
    expect(shouldSkipWarmCycle({ nowMs: 100 * MIN, lastReadAtMs: 50 * MIN, intervalMinutes: 45 })).toBe(false);
  });

  /*
   * 🔴 "Never seen a read" must mean RUN, not skip. A fresh process has warmed nothing, and treating
   * unknown as warm is how a warmer silently never fires — the failure this whole module spent months
   * in, reached through a different door.
   *
   * ⚠️ `nowMs` is deliberately SMALLER than the interval, and the first draft of this test got that
   * wrong. With `nowMs: 100 * MIN` the arithmetic fallthrough (`now - 0 < interval`) happens to return
   * false anyway, so the test passed with the `lastReadAtMs <= 0` guard DELETED — mutation testing
   * caught it. A test whose input cannot reach the branch it names is not a weak test, it is no test.
   *
   * The small clock is also the honest scenario: with a real `Date.now()` the fallthrough is never
   * reached, so this guard only bites under an injected or monotonic clock — which is exactly what the
   * cycle test below uses, and what any future caller passing uptime instead of epoch would use.
   */
  it('RUNS when nothing has been recorded yet — unknown is not warm', () => {
    expect(shouldSkipWarmCycle({ nowMs: 10 * MIN, lastReadAtMs: 0, intervalMinutes: 45 })).toBe(false);
  });

  it('runs exactly at the boundary rather than skipping it', () => {
    expect(shouldSkipWarmCycle({ nowMs: 100 * MIN, lastReadAtMs: 55 * MIN, intervalMinutes: 45 })).toBe(false);
  });

  it('recordCacheRead only ever moves forward — an out-of-order stamp cannot rewind it', () => {
    recordCacheRead(5_000);
    expect(lastCacheReadAt()).toBe(5_000);

    recordCacheRead(1_000);
    expect(lastCacheReadAt()).toBe(5_000);

    recordCacheRead(9_000);
    expect(lastCacheReadAt()).toBe(9_000);
  });

  it('the cycle honours it — a recent read means zero fetches', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');

    recordCacheRead(1_000_000);

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep, now: () => 1_060_000 });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('organic traffic');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('CONTROL — the same cycle RUNS once that read is old enough', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');

    recordCacheRead(1_000_000);

    const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 5420 }));

    // 46 minutes later — past the 45-minute interval.
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep, now: () => 1_000_000 + 46 * MIN });

    expect(result.sent).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('buildWarmupRequest — the Anthropic wire', () => {
  const request = () =>
    buildWarmupRequest({
      model: 'claude-sonnet-5',
      promptText: 'THE BASE PROMPT',
      apiKey: 'sk-ant-123',
      provider: 'Anthropic',
    });

  it('targets Anthropic /messages with x-api-key, never a Bearer', () => {
    const { url, headers } = request();

    expect(url).toBe(`${ANTHROPIC_DEFAULT_BASE_URL}/messages`);
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers.authorization).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  /*
   * 🔴 The BODY must not fork between providers. The warmer is worth nothing unless its bytes are
   * identical to the proxy's block 1, and the proxy sends the same body on either provider — only the
   * transport differs. A body that varied by provider would warm a prefix nobody sends, silently.
   */
  it('sends a body byte-identical to the KIE one — only the transport differs', () => {
    const anthropic = request().body;
    const kie = buildWarmupRequest({
      model: 'claude-sonnet-5',
      promptText: 'THE BASE PROMPT',
      apiKey: 'k-123',
      provider: 'KIE',
    }).body;

    expect(JSON.stringify(anthropic)).toBe(JSON.stringify(kie));
  });

  it('fanout defaults to ONE on Anthropic — there is no balancer to cover', () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    expect(DEFAULT_ANTHROPIC_FANOUT).toBe(1);
    expect(cacheWarmerFanout()).toBe(1);
  });

  it('an explicit CACHE_WARMER_FANOUT still wins on Anthropic', () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('CACHE_WARMER_FANOUT', '3');
    expect(cacheWarmerFanout()).toBe(3);
  });
});

/**
 * 🔴 THE COMETAPI WIRE — the entry whose absence sent a real credential to the wrong vendor.
 *
 * `buildWarmupRequest` was `anthropicDirect ? {anthropic url + x-api-key} : {KIE url + bearer}`, i.e.
 * "Anthropic, or ELSE KIE". Correct for exactly two providers. The moment `PLATFORM_PROVIDERS` grew a
 * third, a Comet deploy POSTed the **Comet API key to `api.kie.ai`** — not a no-op and not merely
 * a wasted request: a live credential handed to a vendor who was never asked for it, on a 45-minute
 * timer, warming a prefix nobody sends. That is exactly the false comfort this module's own header
 * warns about, and it is the same ternary shape that resolved the wrong KEY one file over
 * (`platformKeyFor`, pinned in `agent/platform-key.spec.ts`).
 *
 * ⚠️ This whole section existed as a hole rather than a failure: before T3 the word "Comet" appeared
 * ZERO times in this file, so reverting the record to that ternary broke nothing across 719 tests.
 */
describe('buildWarmupRequest — the Comet wire', () => {
  const request = () =>
    buildWarmupRequest({
      model: 'claude-sonnet-5',
      promptText: 'THE BASE PROMPT',
      apiKey: 'sk-comet-123',
      provider: 'Comet',
    });

  it('targets Comet /messages — never KIE, never Anthropic', () => {
    const { url } = request();

    expect(url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
    expect(url).toContain('api.cometapi.com');
    expect(url).not.toContain('api.kie.ai');
    expect(url).not.toContain('api.anthropic.com');
  });

  /*
   * Comet accepts either header, but the platform speaks Bearer to it (see the `wire` record). The
   * assertion that matters is the NEGATIVE one: `x-api-key` here is the fingerprint of the reverted
   * ternary, which pasted Anthropic's auth shape onto a gateway token.
   */
  it('authenticates with a Bearer header, never x-api-key', () => {
    const { headers } = request();

    expect(headers.authorization).toBe('Bearer sk-comet-123');
    expect(Object.keys(headers).some((h) => h.toLowerCase() === 'x-api-key')).toBe(false);
  });

  /* The body must not fork by provider, or the warmer warms a prefix the proxy never sends. */
  it('sends a body byte-identical to the Anthropic and KIE ones — only the transport differs', () => {
    const comet = JSON.stringify(request().body);

    for (const provider of ['Anthropic', 'KIE'] as const) {
      const other = buildWarmupRequest({
        model: 'claude-sonnet-5',
        promptText: 'THE BASE PROMPT',
        apiKey: 'other-key',
        provider,
      }).body;

      expect(comet, `the ${provider} body differs from the Comet one`).toBe(JSON.stringify(other));
    }
  });

  /*
   * ⚠️ **MEASURED at 5 on 2026-08-11** (T11 / spec AC6), replacing the placeholder `1` this test used
   * to pin. Comet warms PER BACKEND like KIE, not first-request like Anthropic direct, and the evidence
   * is a clustered warmup rather than a rate — three cold probes wrote at requests {1,2,4}, {1,2,3,4}
   * and {1,3,5} and then hit for the rest, with a warm re-probe at 12/12. **5 is the deepest index at
   * which any sample still wrote.**
   *
   * Do NOT read the "27/30" and "16/20" totals from those probes as hit RATES — they are 0% inside the
   * warmup and 100% after it. That misreading is the one that cost a day on KIE. And do not inflate the
   * number "to be safe": a fanout touch on a cold prefix is a **2x cache WRITE** billed every cycle
   * forever, while guessing low costs one avoidable cold read that the next cycle fixes by itself.
   *
   * 🔴 Asserted as a LITERAL `5`, never against `DEFAULT_COMET_FANOUT`. An assertion that imports its
   * own expected value moves with it and passes for ANY value — this repo's `PROGRESS_CAP` vacuity
   * trap, which went green on the exact regression it was named for.
   */
  it('fanout defaults to FIVE on Comet — the measured per-backend warmup depth', () => {
    vi.stubEnv('LLM_PROVIDER', 'Comet');
    expect(cacheWarmerFanout()).toBe(5);
  });

  it('an explicit CACHE_WARMER_FANOUT still wins on Comet', () => {
    vi.stubEnv('LLM_PROVIDER', 'Comet');
    vi.stubEnv('CACHE_WARMER_FANOUT', '4');
    expect(cacheWarmerFanout()).toBe(4);
  });

  /*
   * 🔴 The clamp's fallback is the SELECTED provider's default — and on Comet that is now **5, not 1**.
   * This is the exact path by which a typo'd override silently reintroduces the retired placeholder:
   * `CACHE_WARMER_FANOUT=0` in a deploy would leave Comet warming ONE backend of ~4-5 while the log
   * reports a healthy cycle, i.e. the module's own documented failure mode (a prefix nobody hits) with
   * nothing on screen disagreeing.
   */
  it('🔴 an out-of-range override clamps to Comet’s FIVE, never back to the retired placeholder', () => {
    vi.stubEnv('LLM_PROVIDER', 'Comet');

    vi.stubEnv('CACHE_WARMER_FANOUT', '0');
    expect(cacheWarmerFanout()).toBe(5);

    vi.stubEnv('CACHE_WARMER_FANOUT', '99');
    expect(cacheWarmerFanout()).toBe(5);

    vi.stubEnv('CACHE_WARMER_FANOUT', 'not-a-number');
    expect(cacheWarmerFanout()).toBe(5);
  });
});

/**
 * 🔴 THE ASSERTION THAT WOULD HAVE CAUGHT IT — driven from the DECLARED UNION, not a list.
 *
 * Every test above names one provider, and a per-provider test only exists for a provider somebody
 * remembered to write one for. That is how the Comet entry shipped unguarded in the first place,
 * and it is the `coversWorkspace` lesson: a check written as an enumeration of the cases someone
 * thought of cannot see the case they missed. These derive their cases from `PLATFORM_PROVIDERS`, so
 * a fourth provider arrives as a red test rather than as an untested wire entry.
 */
describe('every provider gets its OWN wire — asserted over PLATFORM_PROVIDERS', () => {
  const requestFor = (provider: PlatformProviderName) =>
    buildWarmupRequest({
      model: 'claude-sonnet-5',
      promptText: 'THE BASE PROMPT',
      apiKey: `key-${provider}`,
      provider,
    });

  /* CONTROL: a parameterised suite over an empty union runs zero tests and reports green. */
  it('the union is real — three shipping providers, Comet among them', () => {
    expect(PLATFORM_PROVIDERS.length).toBeGreaterThanOrEqual(3);
    expect([...PLATFORM_PROVIDERS]).toEqual(expect.arrayContaining(['Anthropic', 'KIE', 'Comet']));
  });

  /*
   * 🔴 No two providers may share an origin. This is the single assertion that fails on the reverted
   * ternary — and on any future edit that copies one provider's row onto another's, which is the
   * shape the mistake actually takes (a `Record` written by pasting the line above it). A shared
   * origin means one provider's key is being POSTed to another vendor's host.
   */
  it('no two providers share a host — a shared origin is a key sent to the wrong vendor', () => {
    const origins = PLATFORM_PROVIDERS.map((provider) => new URL(requestFor(provider).url).origin);

    expect(new Set(origins).size, `duplicate wire host among ${origins.join(', ')}`).toBe(PLATFORM_PROVIDERS.length);
  });

  for (const provider of PLATFORM_PROVIDERS) {
    /*
     * Byte-identity with the proxy's block 1 is the warmer's ONLY reason to exist, and it is not a
     * property of one provider's branch — a wire entry missing `anthropic-version` is refused, and one
     * missing the `cache_control` ttl writes an entry under a DIFFERENT tier than the proxy reads,
     * i.e. pays full price to warm something nobody will ever hit. Both fail silently, so both are
     * asserted for every provider rather than for the one that happened to get a test.
     */
    it(`${provider}: carries anthropic-version, an auth header, and the 1h cache_control ttl`, () => {
      const { url, headers, body } = requestFor(provider);

      expect(url.endsWith('/messages'), `${provider} does not target /messages`).toBe(true);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['content-type']).toBe('application/json');

      // Exactly one auth header, carrying THIS provider's key — never unauthenticated, never both.
      const auth = headers.authorization ?? headers['x-api-key'];
      expect(auth, `${provider} sends no auth header`).toBeTruthy();
      expect(auth).toContain(`key-${provider}`);

      const system = body.system as Array<{ text: string; cache_control: unknown }>;
      expect(system).toHaveLength(1);
      expect(system[0].text).toBe('THE BASE PROMPT');
      expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: PROMPT_CACHE_TTL });
      expect(body.max_tokens).toBe(1);
      expect(body.stream).toBe(true);
    });
  }

  /*
   * 🔴 The fanout defaults, as LITERALS, in one place. Three numbers with three different reasons:
   * Anthropic has no balancer to cover (probe-measured first-request warm); KIE warms per backend
   * behind ~4-5 of them; Comet warms per backend too, measured at a warmup depth of 5 (2026-08-11).
   * Reading them from `FANOUT_BY_PROVIDER` would assert only that the function returns whatever the
   * record says, which is true of every possible record.
   *
   * ⚠️ Until 2026-08-11 Comet's entry here was `1` — the same number as Anthropic's — so this table
   * could not distinguish "resolved Comet" from "resolved Anthropic" anywhere it was used. Three
   * distinct numbers is what makes the ladder cases below readable at all.
   */
  const EXPECTED_DEFAULT_FANOUT: Record<PlatformProviderName, number> = {
    Anthropic: 1,
    KIE: 6,
    Comet: 5,
  };

  for (const provider of PLATFORM_PROVIDERS) {
    it(`${provider}: default fanout is ${EXPECTED_DEFAULT_FANOUT[provider]}`, () => {
      vi.stubEnv('LLM_PROVIDER', provider);
      expect(cacheWarmerFanout()).toBe(EXPECTED_DEFAULT_FANOUT[provider]);
    });
  }
});

describe('parseWarmupStreamUsage — the SSE usage reader', () => {
  /*
   * The REAL wire shape captured from KIE 2026-08-04 (a live `stream: true` probe): usage rides in
   * `message_start`'s `message.usage`, and cache WRITES arrive as the TIERED `cache_creation` object,
   * not the classic `cache_creation_input_tokens` — a parser reading only the classic field reports
   * every warm write as zero, silently.
   */
  it('reads the tiered cache_creation object KIE actually sends', () => {
    const sse =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"id":"chatcompl_x","type":"message","role":"assistant",` +
      `"model":"claude-opus-5","content":[],"usage":{"input_tokens":10,"output_tokens":0,` +
      `"cache_read_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":101794,` +
      `"ephemeral_5m_input_tokens":0},"service_tier":"standard"}}}\n\n`;

    expect(parseWarmupStreamUsage(sse)).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 101_794 });
  });

  it('reads the classic cache_creation_input_tokens field too', () => {
    const sse = `data: {"type":"message_start","message":{"usage":{"cache_creation_input_tokens":5000}}}\n`;

    expect(parseWarmupStreamUsage(sse)).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 5_000 });
  });

  it('reads cache reads, and takes the MAX across events when a later delta updates usage', () => {
    const sse =
      `data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":0}}}\n\n` +
      `data: {"type":"message_delta","usage":{"cache_read_input_tokens":101794}}\n\n`;

    expect(parseWarmupStreamUsage(sse)).toEqual({ cacheReadTokens: 101_794, cacheWriteTokens: 0 });
  });

  it('survives [DONE], split frames and non-JSON data without aborting the scan', () => {
    const sse =
      `data: [DONE]\n` +
      `data: {"broken json\n` +
      `data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":7}}}\n`;

    expect(parseWarmupStreamUsage(sse)).toEqual({ cacheReadTokens: 7, cacheWriteTokens: 0 });
  });

  it('returns zeros for an empty or usage-less stream', () => {
    expect(parseWarmupStreamUsage('')).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(parseWarmupStreamUsage('data: {"type":"message_stop"}\n')).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('runWarmCycle', () => {
  it('skips with zero fetches when disabled', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'false');
    vi.stubEnv('KIE_API_KEY', 'k-123');

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('disabled');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /*
   * 🔴 This test used to assert the OPPOSITE — `skipped).toContain('not KIE')` — and it was green for
   * the entire time the platform ran on Anthropic, faithfully pinning a module that did nothing. A
   * test can only ever assert the behaviour someone wrote down; it cannot notice that the behaviour
   * stopped being the one you wanted.
   */
  it('🔴 RUNS on the Anthropic provider — it used to bail there, which is why nothing was ever warm', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');

    const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 5420 }));
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.skipped).toBeUndefined();
    expect(result.sent).toBe(1);
    expect(result.reads).toBe(1);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ANTHROPIC_DEFAULT_BASE_URL}/messages`);

    // Anthropic authenticates with x-api-key; a Bearer here is a 401 on every cycle.
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers.authorization).toBeUndefined();
  });

  /* One touch, not six: the fanout exists to cover KIE's balancer and Anthropic direct has none. */
  it('sends ONE touch on Anthropic and six on KIE', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');

    const anthropic = vi.fn(async () => okResponse({ cache_read_input_tokens: 1 }));
    expect((await runWarmCycle(undefined, { fetchFn: anthropic, sleep: instantSleep })).sent).toBe(1);

    vi.stubEnv('LLM_PROVIDER', 'KIE');
    vi.stubEnv('KIE_API_KEY', 'k-123');

    const kie = vi.fn(async () => okResponse({ cache_read_input_tokens: 1 }));
    expect((await runWarmCycle(undefined, { fetchFn: kie, sleep: instantSleep })).sent).toBe(6);
  });

  it('skips when the configured provider has no key', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('ANTHROPIC_API_KEY');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips when KIE_API_KEY is not configured', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'KIE');

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('KIE_API_KEY');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /*
   * 🔴 The Comet cycle end to end — the key env var, the host it is POSTed to, and the header it
   * rides in, driven through the real `runWarmCycle` rather than the pure builder.
   *
   * The builder tests above pin the wire entry; this pins that the CYCLE reaches it — that
   * `platformKeyEnvFor` hands the cycle `COMET_API_KEY` (it used to be a local
   * `provider === 'KIE' ? 'KIE_API_KEY' : 'ANTHROPIC_API_KEY'` ternary, which would have read the
   * ANTHROPIC key here and skipped as unconfigured while the Comet key sat in the environment).
   */
  it('🔴 runs on Comet: reads COMET_API_KEY and POSTs it to api.cometapi.com as a Bearer', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'Comet');
    vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
    vi.stubEnv('COMET_API_KEY', 'sk-comet-123');

    const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 5420 }));
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.skipped).toBeUndefined();

    // FIVE touches — Comet's measured per-backend warmup depth, not Anthropic's single first-request warm.
    expect(result.sent).toBe(5);
    expect(result.reads).toBe(5);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
    expect(url).not.toContain('api.kie.ai');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-comet-123');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('skips when COMET_API_KEY is not configured', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('LLM_PROVIDER', 'Comet');

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('COMET_API_KEY');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips when there is no active prompt version', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('KIE_API_KEY', 'k-123');
    getActivePromptMock.mockResolvedValue(null);

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('no active prompt');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /*
   * 🔴 CLAUDE ONLY. Breakpoint warming is an Anthropic mechanism end to end — `buildWarmupRequest`
   * speaks the Messages wire, so against a `gpt-*` or `gemini-*` platform model the request warms
   * NOTHING (wrong endpoint for a model that is not running there) while spending real money. The
   * other two families have nothing to warm anyway: OpenAI-style prefix caching is automatic and
   * unwarmable, and KIE prices no Gemini caching at all (`cacheProfile: 'none'`).
   *
   * The guard is asserted HERE, on `runWarmCycle`, because that is the ONE choke point every door
   * passes through — the interval, the kickoff AND `warmAfterPromptChange` (fired on every prompt
   * promotion, and VITEST-guarded so it cannot be driven directly). Guarding only `ensureCacheWarmer`
   * would leave the promotion path paying for a request that warms nothing, silently.
   */
  for (const model of ['gpt-5-6-sol', 'gemini-3-5-flash']) {
    it(`skips with zero fetches when the platform model is ${model}`, async () => {
      vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
      vi.stubEnv('KIE_API_KEY', 'k-123');
      vi.stubEnv('LLM_MODEL', model);

      const fetchFn = vi.fn();
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      expect(result.sent).toBe(0);
      expect(result.skipped).toContain(model);
      expect(result.skipped).toContain('not a Claude model');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  it('sends fanout requests carrying the active prompt, and counts reads/writes from the usage block', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('KIE_API_KEY', 'k-123');
    vi.stubEnv('CACHE_WARMER_FANOUT', '3');

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ cache_read_input_tokens: 5_000 }))
      .mockResolvedValueOnce(okResponse({ cache_creation_input_tokens: 5_000 }))
      .mockResolvedValueOnce(okResponse({}));

    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result).toEqual({ sent: 3, reads: 1, writes: 1, failures: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // The wire request IS buildWarmupRequest's — same URL, same prompt bytes, same cache_control.
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(url).toBe(`${KIE_DEFAULT_BASE_URL}/messages`);
    expect(body.system[0].text).toBe('THE BASE PROMPT');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: PROMPT_CACHE_TTL });
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(true);

    // Spaced between touches (concurrent probes land on the same backend) — but only BETWEEN them.
    expect(instantSleep).toHaveBeenCalledTimes(2);
  });

  /* NEVER throws: a warmer that can take down the doorway that started it inverts its purpose. */
  it('counts a throwing fetch as a failure and never throws itself', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('KIE_API_KEY', 'k-123');
    vi.stubEnv('CACHE_WARMER_FANOUT', '2');

    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.reads).toBe(0);
    expect(result.writes).toBe(0);
  });

  it('counts a non-ok response as a failure and keeps going', async () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('KIE_API_KEY', 'k-123');
    vi.stubEnv('CACHE_WARMER_FANOUT', '2');

    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
      .mockResolvedValueOnce(okResponse({ cache_read_input_tokens: 5_000 }));

    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result).toEqual({ sent: 2, reads: 1, writes: 0, failures: 1 });
  });
});

/**
 * 🔴 THE WARMER WARMS THE GATEWAY THAT WOULD ACTUALLY SERVE (2026-08-10, `resolvePlatformProvider`).
 *
 * `cacheWarmerFanout` and `runWarmCycle` both read `getPlatformProvider` — i.e. `LLM_PROVIDER` — which
 * was exactly right while the provider was fixed, because fixed WAS serving, by construction.
 * `AUTO_MODEL_SELECT` broke that identity: the gateway is chosen per request from a ladder, and the
 * cached prefix is **per gateway**. So during precisely the outage the ladder exists to survive, the
 * warmer would have been sending a prefix nobody uses, at a fanout tuned for a gateway nobody is on —
 * this module's own documented failure mode ("a warmer warming a prefix nobody sends is false comfort,
 * silently") reached through a door that did not exist when the guard was written.
 *
 * Every property below fails SILENTLY and two of them fail in the expensive direction: a warmer that
 * resolves Anthropic's rung and then sends KIE's fanout of six bills five extra 2x cache WRITES per
 * cycle, forever, against a prefix it is not even warming.
 */
describe('🔴 the warmer follows the AUTO_MODEL_SELECT ladder, not LLM_PROVIDER', () => {
  /**
   * The scrub list IS the test's premise. `AUTO_MODEL_SELECT` outranks `LLM_PROVIDER` and this
   * developer's `.env.local` sets it, so an omission does not fail — it silently converts every
   * `LLM_PROVIDER` case in this file into a ladder case.
   */
  it('scrubs the two keys that now outrank LLM_PROVIDER', () => {
    expect(AUTO_MODEL_SELECT_ENV_KEY).toBe('AUTO_MODEL_SELECT');
    expect(LLM_PROVIDER_CHAIN_ENV_KEY).toBe('LLM_PROVIDER_CHAIN');

    for (const key of [AUTO_MODEL_SELECT_ENV_KEY, LLM_PROVIDER_CHAIN_ENV_KEY]) {
      expect(WARMER_ENV as readonly string[], `${key} unscrubbed — .env.local would decide this suite`).toContain(key);
    }
  });

  /**
   * PROPERTY 1 — with the flag off, this is `getPlatformProvider` and nothing else.
   *
   * `resolvePlatformProvider` returns before it consults a chain, a key or a price when
   * `AUTO_MODEL_SELECT` is unset, so every deploy that has not opted in must behave exactly as it did
   * before the ladder existed — including when the other gateways are configured and sit AHEAD of the
   * fixed one in the default chain, which is the state that would expose an unconditional ladder.
   */
  describe('flag OFF — byte-identical to the fixed-provider behaviour', () => {
    const EXPECTED_DEFAULT_FANOUT: Record<PlatformProviderName, number> = { Anthropic: 1, KIE: 6, Comet: 5 };

    for (const provider of PLATFORM_PROVIDERS) {
      it(`${provider}: fanout is ${EXPECTED_DEFAULT_FANOUT[provider]} even with every other gateway configured`, () => {
        vi.stubEnv('LLM_PROVIDER', provider);
        vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');

        // Every key present and a chain headed by KIE: if the ladder ran, KIE (fanout 6) would win.
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
        vi.stubEnv('KIE_API_KEY', 'k-123');
        vi.stubEnv('COMET_API_KEY', 'sk-comet-123');
        vi.stubEnv('LLM_PROVIDER_CHAIN', 'KIE,Comet,Anthropic');

        expect(cacheWarmerFanout()).toBe(EXPECTED_DEFAULT_FANOUT[provider]);
      });
    }

    it('the cycle POSTs to LLM_PROVIDER’s wire with LLM_PROVIDER’s key', async () => {
      vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
      vi.stubEnv('LLM_PROVIDER', 'Anthropic');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
      vi.stubEnv('KIE_API_KEY', 'k-123');
      vi.stubEnv('COMET_API_KEY', 'sk-comet-123');

      const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 1 }));
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      expect(result.sent).toBe(1);

      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${ANTHROPIC_DEFAULT_BASE_URL}/messages`);
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-123');
    });
  });

  /**
   * PROPERTY 2 — with the flag on, the fanout and the wire follow the LADDER's answer.
   *
   * Both directions are asserted, because they are wrong in opposite ways. Resolving KIE's six on a
   * gateway that has none pays five extra 2x cache writes a cycle; resolving Anthropic's one on KIE
   * leaves ~4-5 of KIE's balancer backends cold, which is the whole reason the fanout exists.
   */
  describe('flag ON — the ladder’s answer decides the fanout and the wire', () => {
    it('a keyless KIE at the head of the chain: the fanout is the SELECTED rung’s, never KIE’s six', () => {
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'KIE');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('COMET_API_KEY', 'sk-comet-123');

      /*
       * KIE_API_KEY stays scrubbed — the head of the chain is not serveable, so the ladder walks past
       * it to Comet. Five, Comet's own measured default: while Comet's placeholder was `1` this
       * assertion also passed for a cycle that had laddered all the way to Anthropic, so it named the
       * selected rung without being able to tell which rung that was.
       */
      expect(cacheWarmerFanout()).toBe(5);
    });

    it('🔴 LLM_PROVIDER=Anthropic with a healthy KIE: the fanout is SIX, the ladder’s answer', () => {
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'Anthropic');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
      vi.stubEnv('KIE_API_KEY', 'k-123');

      expect(cacheWarmerFanout()).toBe(6);
    });

    /*
     * PROPERTY 6 — the request targets the resolved gateway's WIRE, carrying that gateway's KEY. A
     * cycle that laddered to Comet and then POSTed KIE's host would warm nothing and hand a live
     * credential to a vendor nobody chose (the reverted-ternary failure, one layer up).
     */
    it('🔴 the cycle POSTs to the SELECTED gateway with the SELECTED gateway’s key', async () => {
      vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'KIE');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('COMET_API_KEY', 'sk-comet-123');

      const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 5420 }));
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      expect(result.skipped, 'the ladder should have found Comet serveable').toBeUndefined();
      expect(result.sent).toBe(5);

      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
      expect(url).not.toContain('api.kie.ai');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-comet-123');
    });

    /*
     * 🔴 The MODEL is the third thing that must come from the selection, and it is the easiest to get
     * wrong invisibly — the cache is per MODEL as well as per gateway, so a cycle that warms Comet's
     * host with KIE's model writes an entry no generation will ever read, at full price, forever.
     *
     * `LLM_MODEL` is deliberately UNSET here: it is the one setting that would mask the defect by
     * making both providers answer the same. With only `KIE_DEFAULT_MODEL` set, KIE would run
     * `claude-opus-5` and the selected Comet rung runs the baked default — so the body's `model` field
     * says out loud which provider the model was resolved against.
     */
    it('🔴 warms the SELECTED gateway’s model, not the model LLM_PROVIDER would have run', async () => {
      vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'KIE');
      vi.stubEnv('KIE_DEFAULT_MODEL', 'claude-opus-5');
      vi.stubEnv('COMET_API_KEY', 'sk-comet-123');

      const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 5420 }));

      expect((await runWarmCycle(undefined, { fetchFn, sleep: instantSleep })).sent).toBe(5);

      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);

      expect(url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
      expect(body.model, 'the model was resolved against LLM_PROVIDER, not the selected gateway').toBe(
        'claude-sonnet-5',
      );
      expect(body.model).not.toBe('claude-opus-5');
    });

    it('skips when the SELECTED gateway has no key — never falls back to LLM_PROVIDER’s', async () => {
      vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'Anthropic');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');

      const fetchFn = vi.fn();
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      expect(result.sent).toBe(0);
      expect(result.skipped).toContain('API_KEY');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  /**
   * PROPERTY 3 — ONE gateway per cycle: the key, the model and the fanout all come from ONE resolution.
   *
   * The ladder is deterministic given the environment, so a second call inside the same cycle normally
   * returns the same answer and a re-resolution would be invisible. It is not always deterministic: the
   * cooldown map is module state that ORGANIC TRAFFIC mutates (`recordProviderFailure` in the proxy),
   * and `runWarmCycle` awaits `getActivePrompt()` between resolving the provider and reading the
   * fanout. Driving that exact interleaving is the only way to observe the property through public
   * behaviour, and it is precisely the scenario the implementation's comment cites.
   */
  describe('one gateway per cycle — the key, the model and the fanout share ONE resolution', () => {
    const ladderEnv = () => {
      vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'Anthropic');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
      vi.stubEnv('KIE_API_KEY', 'k-123');
      vi.stubEnv('COMET_API_KEY', 'sk-comet-123');
    };

    /*
     * CONTROL. Without this the headline test below is unreadable: "six touches on KIE" is also what a
     * cycle that never noticed the cooldown at all would do, so the suite has to prove first that
     * recording a KIE failure really does move the ladder to Comet — and that Comet's fanout is a
     * different number. A control that cannot distinguish the two outcomes is not a control.
     */
    it('CONTROL — a cooldown recorded BEFORE the cycle moves it to Comet, with a fanout of five', async () => {
      ladderEnv();
      recordProviderFailure('KIE', Date.now());

      const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 1 }));
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      // Five, not KIE's six — the two numbers are adjacent but distinct, which is what makes this a control.
      expect(result.sent).toBe(5);

      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-comet-123');
    });

    it('🔴 a cooldown landing MID-CYCLE cannot re-point the fanout: six touches, all on KIE', async () => {
      ladderEnv();

      /*
       * The mutation happens inside the awaited `getActivePrompt()` — i.e. AFTER the cycle resolved its
       * provider and BEFORE it reads its fanout. This is a real interleaving, not a contrivance: a
       * generation failing over on another request is exactly what writes this map.
       */
      getActivePromptMock.mockImplementation(async () => {
        recordProviderFailure('KIE', Date.now());
        return { id: 'pv_test', content: 'THE BASE PROMPT' };
      });

      const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 1 }));
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      /*
       * Six — KIE's, the provider this cycle resolved — not the one a re-ladder would now return. A
       * cycle that re-resolved would send a single touch, i.e. leave KIE's balancer four-fifths cold
       * while reporting a healthy cycle.
       */
      expect(result.sent, 'the fanout was re-resolved mid-cycle against a now-cooling ladder').toBe(6);

      for (const call of fetchFn.mock.calls as unknown as Array<[string, RequestInit]>) {
        expect(call[0]).toBe(`${KIE_DEFAULT_BASE_URL}/messages`);
        expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer k-123');
      }
    });
  });

  /**
   * PROPERTY 4 + 5 — the explicit override still wins, and an explicit argument beats the ladder.
   *
   * The ladder only chooses the DEFAULT. An operator who has typed a number has already answered the
   * question, and the clamp's fallback must be the SELECTED provider's default too — falling back to
   * `LLM_PROVIDER`'s would make a typo'd override silently reintroduce the whole defect.
   */
  describe('the explicit override, and the providerOverride argument', () => {
    it('CACHE_WARMER_FANOUT wins over the ladder’s default', () => {
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'Anthropic');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
      vi.stubEnv('KIE_API_KEY', 'k-123');
      vi.stubEnv('CACHE_WARMER_FANOUT', '2');

      expect(cacheWarmerFanout()).toBe(2);
    });

    it('an out-of-range override falls back to the SELECTED provider’s default, not LLM_PROVIDER’s', () => {
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'KIE');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('COMET_API_KEY', 'sk-comet-123');

      /*
       * KIE is keyless, so the ladder selects Comet: the clamp must land on Comet's own measured 5 —
       * never KIE's 6 (the `LLM_PROVIDER` answer), and never the retired placeholder 1, which a typo'd
       * override would otherwise reintroduce silently on the very deploy that is running on Comet.
       */
      vi.stubEnv('CACHE_WARMER_FANOUT', '99');
      expect(cacheWarmerFanout()).toBe(5);

      vi.stubEnv('CACHE_WARMER_FANOUT', '0');
      expect(cacheWarmerFanout()).toBe(5);
    });

    /*
     * PROPERTY 5 — the override argument is how `runWarmCycle` threads its ONE resolution in, so it has
     * to outrank the ladder outright. If the ladder could still win here, the parameter would be
     * decoration and the one-gateway-per-cycle property would rest on nothing.
     */
    it('🔴 providerOverride beats the ladder in both directions', () => {
      vi.stubEnv(AUTO_MODEL_SELECT_ENV_KEY, 'true');
      vi.stubEnv('LLM_PROVIDER', 'Anthropic');
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
      vi.stubEnv('KIE_API_KEY', 'k-123');

      /*
       * The ladder would say KIE (6) — the argument says otherwise, and the argument wins. All three
       * answers are DISTINCT literals, which they were not while Comet shared Anthropic's placeholder
       * 1: a test whose two expected values collide cannot tell the two branches apart.
       */
      expect(cacheWarmerFanout(undefined, 'Anthropic')).toBe(1);
      expect(cacheWarmerFanout(undefined, 'Comet')).toBe(5);
      expect(cacheWarmerFanout(undefined, 'KIE')).toBe(6);
    });
  });
});

/**
 * 🔴 T11 ACCEPTANCE — the three fanout defaults, as LITERALS, and the warmer still off.
 *
 * `DEFAULT_COMET_FANOUT` moved from a placeholder `1` to a measured `5` (2026-08-11). The whole value
 * of pinning it is that the pin does not move with it: an assertion written as
 * `expect(cacheWarmerFanout()).toBe(DEFAULT_COMET_FANOUT)` is true of every possible value of that
 * constant, including the placeholder it just replaced and including a typo. That is this repo's
 * `PROGRESS_CAP` trap — a test that went green on the exact regression its name described — so every
 * number below is typed out.
 *
 * The three numbers have three different measured reasons, and getting one wrong fails silently in a
 * direction the log cannot show you: too low leaves backends cold (a warmer warming a prefix nobody
 * hits), too high bills every surplus touch as a **2x cache WRITE** on every cycle, forever.
 */
describe('🔴 T11 — the measured fanout defaults, as literals', () => {
  it('the exported constants ARE the measured numbers — 1 Anthropic, 6 KIE, 5 Comet', () => {
    expect(DEFAULT_ANTHROPIC_FANOUT).toBe(1);
    expect(DEFAULT_CACHE_WARMER_FANOUT).toBe(6);
    expect(DEFAULT_COMET_FANOUT).toBe(5);
  });

  /*
   * The resolver's answer, not just the constants — a re-pointed record (`Comet: DEFAULT_ANTHROPIC_FANOUT`)
   * leaves all three constants correct and every warm cycle on Comet wrong. Both halves are needed:
   * the constants catch a value edit, this catches a wiring edit.
   */
  it('cacheWarmerFanout returns those literals for each provider', () => {
    vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');

    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    expect(cacheWarmerFanout()).toBe(1);

    vi.stubEnv('LLM_PROVIDER', 'KIE');
    expect(cacheWarmerFanout()).toBe(6);

    vi.stubEnv('LLM_PROVIDER', 'Comet');
    expect(cacheWarmerFanout()).toBe(5);
  });

  /*
   * ⚠️ The default is UNCHANGED by this measurement and must stay so: T11 moved a number, not the
   * decision to run. The warmer ships OFF until `generations.cacheCreationTokens > 0` has been counted
   * for a week — a measured fanout makes the warmer correct when enabled, it does not make enabling it
   * worth ~$0.30/day against an unmeasured cold-start rate.
   */
  it('the warmer still ships OFF — a measured fanout is not a reason to enable it', () => {
    expect(cacheWarmerEnabled()).toBe(false);
  });
});

/**
 * 🔴 CLAUDE ONLY — and the guard's PLACEMENT is the property, not merely its existence.
 *
 * Breakpoint warming is an Anthropic mechanism end to end, so against a `gpt-*` or `gemini-*` platform
 * model the warm request is a POST to the wrong endpoint for a model that is not running there: it
 * spends real money and warms nothing. The behavioural cases in `runWarmCycle` above pin the skip for
 * two such models; these pin the two things those cases cannot see.
 *
 * 1. It holds on EVERY gateway, derived from `PLATFORM_PROVIDERS` — the existing cases run on whichever
 *    provider the scrubbed env defaults to, so a guard that had become provider-conditional would keep
 *    them green (the `coversWorkspace` lesson: an enumeration cannot see the case it omits).
 * 2. It holds on the `warmAfterPromptChange` door. That is the reason the implementation puts the guard
 *    in `runWarmCycle` rather than in `ensureCacheWarmer`, and it is **not drivable behaviourally** —
 *    `warmAfterPromptChange` is VITEST-guarded precisely so a spec cannot fire a real prompt-promotion
 *    warm cycle at a paid API. So it is asserted at SOURCE level, with controls, which is the honest
 *    coverage rather than no coverage.
 */
describe('🔴 the Claude-only guard sits at the one choke point every door passes through', () => {
  /** Every key present, so nothing below can be stopped by a missing credential. */
  const allKeys = () => {
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
    vi.stubEnv('KIE_API_KEY', 'k-123');
    vi.stubEnv('COMET_API_KEY', 'sk-comet-123');
  };

  /*
   * THE SAFETY PROPERTY, over the declared union: whatever the reason, a non-Claude platform model
   * never puts a warm request on the wire. Derived from `PLATFORM_PROVIDERS` so a fourth gateway
   * arrives as a red test rather than as an unasserted spend path.
   */
  for (const provider of PLATFORM_PROVIDERS) {
    it(`${provider}: a non-Claude platform model warms NOTHING — zero fetches`, async () => {
      allKeys();
      vi.stubEnv('LLM_PROVIDER', provider);
      vi.stubEnv('LLM_MODEL', 'gpt-5-6-sol');

      const fetchFn = vi.fn();
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      expect(result.sent, `${provider} sent a warm request for a non-Claude model`).toBe(0);
      expect(result.skipped, `${provider} ran the cycle without saying why it should not`).toBeTruthy();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  /*
   * ⚠️ THE FAMILY GUARD SPECIFICALLY — and it is only REACHABLE where the gateway prices a non-Claude
   * model. Found while writing the loop above: on Anthropic `gpt-5-6-sol` is unpriced, so
   * `getPlatformModel` throws first and the cycle skips with `error: ... is not configured`. Same
   * outcome (zero fetches), different mechanism — so asserting the guard's WORDING over the whole union
   * would have been asserting the pricing table on two of the three rows.
   *
   * These two rows do reach it: KIE prices `gpt-5-6-sol` and Comet prices `grok-4.5`/`qwen3-coder`, so
   * the model resolves cleanly and the family check is the only thing standing between the platform and
   * a paid POST that warms nothing.
   */
  const REACHES_THE_FAMILY_GUARD: ReadonlyArray<[PlatformProviderName, string]> = [
    ['KIE', 'gpt-5-6-sol'],
    ['Comet', 'grok-4.5'],
    ['Comet', 'qwen3-coder'],
  ];

  for (const [provider, model] of REACHES_THE_FAMILY_GUARD) {
    it(`${provider}: a priced ${model} is refused BY THE FAMILY GUARD, naming the model`, async () => {
      allKeys();
      vi.stubEnv('LLM_PROVIDER', provider);
      vi.stubEnv('LLM_MODEL', model);

      const fetchFn = vi.fn();
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      expect(result.sent).toBe(0);
      expect(result.skipped).toContain(model);
      expect(result.skipped).toContain('not a Claude model');

      // Not the pricing throw wearing the same outcome — that is a different mechanism, not this guard.
      expect(result.skipped).not.toContain('error:');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  /*
   * CONTROL for the loop above. Without it every case passes for a cycle that skipped for some OTHER
   * reason entirely — an unconfigured key, a missing prompt — i.e. for a warmer that never runs at all.
   */
  it('CONTROL — the same env with a claude-* model DOES warm on every provider', async () => {
    for (const provider of PLATFORM_PROVIDERS) {
      vi.stubEnv('CACHE_WARMER_ENABLED', 'true');
      vi.stubEnv('LLM_PROVIDER', provider);
      vi.stubEnv('LLM_MODEL', 'claude-sonnet-5');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-123');
      vi.stubEnv('KIE_API_KEY', 'k-123');
      vi.stubEnv('COMET_API_KEY', 'sk-comet-123');

      const fetchFn = vi.fn(async () => okResponse({ cache_read_input_tokens: 1 }));
      const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

      expect(result.skipped, `${provider} refused a Claude model`).toBeUndefined();
      expect(result.sent).toBeGreaterThan(0);
    }
  });

  describe('the guard’s placement, at source level', () => {
    /** Comment-stripped module source — a claim in a doc comment is not a guard. */
    const code = () =>
      readFileSync(fileURLToPath(new URL('./cache-warmer.ts', import.meta.url)), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    /** Slice one top-level function body by brace matching, so "is X inside Y" is answerable. */
    function bodyOf(source: string, name: string): string {
      const signature = source.indexOf(`function ${name}(`);
      expect(signature, `${name} not found in cache-warmer.ts`).toBeGreaterThan(-1);

      const open = source.indexOf('{', signature);
      let depth = 0;

      for (let i = open; i < source.length; i++) {
        if (source[i] === '{') {
          depth++;
        } else if (source[i] === '}' && --depth === 0) {
          return source.slice(open + 1, i);
        }
      }

      throw new Error(`unbalanced braces slicing ${name}`);
    }

    /*
     * CONTROL: the scanner reads real code and the slicer really isolates ONE function. A scan that
     * silently matched nothing — or that returned the whole file for every name — would report a clean
     * bill of health forever, which is the failure this repo has recorded on three separate scanners.
     */
    it('CONTROL — the scanner reads stripped source and the slicer isolates one function', () => {
      const source = code();

      expect(source).toContain('export async function runWarmCycle');
      expect(source).not.toContain('/*');

      // Each body carries its own distinctive statement, and NOT its neighbour's.
      expect(bodyOf(source, 'ensureCacheWarmer')).toContain('setInterval');
      expect(bodyOf(source, 'warmAfterPromptChange')).not.toContain('setInterval');
      expect(bodyOf(source, 'warmAfterPromptChange').length).toBeGreaterThan(0);
    });

    it('🔴 the family guard is INSIDE runWarmCycle, not in the starter', () => {
      const source = code();

      const cycle = bodyOf(source, 'runWarmCycle');
      expect(cycle).toContain('familyOf(');
      expect(cycle).toContain("!== 'claude'");
      expect(cycle).toContain('not a Claude model');

      /*
       * `ensureCacheWarmer` must NOT be where the family is checked. Guarding only the starter would
       * leave the prompt-promotion door spending real money on a request that warms nothing — the exact
       * false comfort the module's header warns about, reached through the door nobody drives.
       */
      expect(
        bodyOf(source, 'ensureCacheWarmer'),
        'the family guard moved to the starter, leaving the promotion door open',
      ).not.toContain('familyOf');
    });

    it('🔴 warmAfterPromptChange inherits the guard by delegating to runWarmCycle', () => {
      const promotion = bodyOf(code(), 'warmAfterPromptChange');

      // It calls the choke point...
      expect(promotion).toContain('runWarmCycle(');

      // ...and does NOT re-derive the decision itself, which is how the two would start disagreeing.
      expect(promotion).not.toContain('familyOf');
      expect(promotion).not.toContain('cacheWarmerFanout');
      expect(promotion).not.toContain('buildWarmupRequest');

      // The VITEST bail is why this is a source assertion and not a behavioural one — pin it too.
      expect(promotion).toContain('VITEST');
    });
  });
});

describe('the suite can never spend real money', () => {
  /*
   * `ensureCacheWarmer` is VITEST-guarded — the documented `env()` trap means an unguarded warmer
   * would fire real KIE spend from ANY spec that touches the proxy, on the developer's real key.
   */
  it('ensureCacheWarmer starts nothing under vitest — no timers, no fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    vi.useFakeTimers();

    try {
      expect(() => ensureCacheWarmer()).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /*
   * 🔴 Real-spend guard: a cycle run with NO injected deps in a scrubbed env must SKIP before any
   * network call — the default fetch is the REAL fetch, and this is the state every spec that
   * accidentally triggers a cycle would run in.
   */
  /*
   * TWO gates, asserted separately on purpose. Since 2026-08-08 the warmer defaults OFF, so the first
   * assertion alone would pass for a build whose key handling was broken — and it would keep passing
   * right up until someone flipped the default back, at which point this test would start spending the
   * developer's real Anthropic credit from a unit run. The second assertion is the one that survives
   * that change.
   */
  it('runWarmCycle with no deps in a scrubbed env skips before touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const offByDefault = await runWarmCycle();

    expect(offByDefault.sent).toBe(0);
    expect(offByDefault.skipped).toContain('disabled');

    // ...and again with the flag ON, where only the missing key stands between the suite and real spend.
    vi.stubEnv('CACHE_WARMER_ENABLED', 'true');

    const enabledButKeyless = await runWarmCycle();

    expect(enabledButKeyless.sent).toBe(0);
    expect(enabledButKeyless.skipped).toContain('API_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
