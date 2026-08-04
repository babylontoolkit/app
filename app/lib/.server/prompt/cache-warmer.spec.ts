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
  buildWarmupRequest,
  cacheWarmerEnabled,
  cacheWarmerFanout,
  cacheWarmerIntervalMinutes,
  DEFAULT_CACHE_WARMER_FANOUT,
  DEFAULT_CACHE_WARMER_INTERVAL_MINUTES,
  ensureCacheWarmer,
  parseWarmupStreamUsage,
  PROMPT_CACHE_TTL,
  resetCacheWarmerForTests,
  runWarmCycle,
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
  const request = () => buildWarmupRequest({ model: 'claude-opus-5', promptText: 'THE BASE PROMPT', apiKey: 'k-123' });

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

  it('fanout defaults to 6', () => {
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

  it('enabled defaults to true and honors CACHE_WARMER_ENABLED=false', () => {
    expect(cacheWarmerEnabled()).toBe(true);
    vi.stubEnv('CACHE_WARMER_ENABLED', 'false');
    expect(cacheWarmerEnabled()).toBe(false);
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

  it('skips when the platform provider is not KIE', async () => {
    vi.stubEnv('LLM_PROVIDER', 'Anthropic');
    vi.stubEnv('KIE_API_KEY', 'k-123');

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('not KIE');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips when KIE_API_KEY is not configured', async () => {
    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('KIE_API_KEY');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips when there is no active prompt version', async () => {
    vi.stubEnv('KIE_API_KEY', 'k-123');
    getActivePromptMock.mockResolvedValue(null);

    const fetchFn = vi.fn();
    const result = await runWarmCycle(undefined, { fetchFn, sleep: instantSleep });

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('no active prompt');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends fanout requests carrying the active prompt, and counts reads/writes from the usage block', async () => {
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
  it('runWarmCycle with no deps in a scrubbed env skips before touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await runWarmCycle();

    expect(result.sent).toBe(0);
    expect(result.skipped).toContain('KIE_API_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
