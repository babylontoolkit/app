/**
 * Cache-warmer tests (§4.2.8, `cache-warmer.ts`).
 *
 * Two properties matter and both fail SILENTLY:
 *
 * 1. **Byte-identity with the proxy's block 1.** The warmer only buys anything while its request is
 *    byte-identical to what the proxy sends (same text, same `cache_control` tier/TTL, same model,
 *    same Bearer auth on the same KIE base). A drifted warmer warms a prefix nobody sends — false
 *    comfort, cents spent for nothing — so `buildWarmupRequest` is pinned field by field.
 *
 * 2. **The suite can never spend real money.** `runWarmCycle` hits KIE's real wire when it runs;
 *    `ensureCacheWarmer` is VITEST-guarded, and every test here drives the cycle with an injected
 *    fetch. The real-spend guard test asserts the scrubbed-env cycle SKIPS before any network call.
 *
 * ⚠️ The `oauth.spec.ts` trap is armed: `env()` falls back to the developer's `.env.local`, which on
 * this machine really does carry `KIE_API_KEY`/`LLM_MODEL`. The WHOLE precedence chain is scrubbed
 * in `beforeEach`, or these tests grade against the operator's real config with CI green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KIE_DEFAULT_BASE_URL } from '~/lib/modules/llm/providers/kie-wire';
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  buildWarmupRequest,
  cacheWarmerEnabled,
  cacheWarmerFanout,
  cacheWarmerIntervalMinutes,
  DEFAULT_ANTHROPIC_FANOUT,
  DEFAULT_CACHE_WARMER_FANOUT,
  DEFAULT_CACHE_WARMER_INTERVAL_MINUTES,
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
});

afterEach(() => {
  resetCacheWarmerForTests();
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
   * 🔴 The default INVERTED 2026-08-08. The warmer can only warm the SHARED prefix (~31k of ~40k), so
   * one cold start avoided is worth ~$0.18 while a 45-minute cycle costs ~$0.30/day — and which side
   * wins depends on how many cold starts a day the platform has, which nobody has measured. It ships
   * off; `generations.cacheCreationTokens > 0` is a cold start, so counting them for a week turns a
   * guess into a five-minute decision.
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
