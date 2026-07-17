/**
 * Rate-limit handling (SPEC §4.2a, §5A).
 *
 * The platform runs every user's generations through ONE key, so a 429 is not an edge case — it is the
 * shape a busy day takes. Every rule here fails quietly: retrying a body that cannot be re-sent sends an
 * EMPTY request, and a 429 nobody counts is a limit discovered from user complaints.
 */
import { describe, expect, it } from 'vitest';
import { parseRetryAfter, rateLimitFetch, type ThrottleEvent } from './rate-limit';

/** Queue of responses; each call shifts one. Never sleeps for real. */
function fakeNetwork(responses: Array<{ status: number; retryAfter?: string }>) {
  const calls: Array<{ body?: string }> = [];

  const base: typeof fetch = async (_input, init) => {
    calls.push({ body: typeof init?.body === 'string' ? init.body : undefined });

    const next = responses.shift() ?? { status: 200 };
    const headers = new Headers();

    if (next.retryAfter) {
      headers.set('retry-after', next.retryAfter);
    }

    return new Response(next.status === 200 ? '{"ok":true}' : '{"error":"rate_limit"}', {
      status: next.status,
      headers,
    });
  };

  return { base, calls };
}

const slept: number[] = [];
const sleep = async (ms: number) => {
  slept.push(ms);
};

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('0.5')).toBe(500);
  });

  it('reads an HTTP-date', () => {
    const now = Date.parse('2026-07-17T08:00:00Z');
    expect(parseRetryAfter('Fri, 17 Jul 2026 08:00:05 GMT', now)).toBe(5000);
  });

  /* A date already past means "retry now", never a negative wait that would sort/compare wrong. */
  it('never returns a negative wait for a past date', () => {
    const now = Date.parse('2026-07-17T08:00:10Z');
    expect(parseRetryAfter('Fri, 17 Jul 2026 08:00:00 GMT', now)).toBe(0);
  });

  /*
   * Garbage must fall back to backoff — NOT be read as "wait 0", which would hammer a service that
   * just asked us to stop, and not throw, which would kill a generation over a malformed header.
   */
  it('returns null for junk rather than 0', () => {
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});

describe('rateLimitFetch', () => {
  it('passes a 200 straight through without waiting', async () => {
    slept.length = 0;

    const { base, calls } = fakeNetwork([{ status: 200 }]);
    const res = await rateLimitFetch({ provider: 'KIE', sleep }, base)('https://x.test', { body: '{}' });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  /*
   * 🔴 The header is the whole point. `ai@4` already retries a 429 — on a FIXED 2s/4s schedule that
   * ignores `retry-after`. Anthropic tells us when the window resets; retrying early burns the attempt
   * and 429s again. If this ever reverts to backoff, retries silently stop working under real load.
   */
  it('honours retry-after instead of its own backoff', async () => {
    slept.length = 0;

    const { base } = fakeNetwork([{ status: 429, retryAfter: '7' }, { status: 200 }]);
    const res = await rateLimitFetch({ provider: 'Anthropic', sleep }, base)('https://x.test', { body: '{}' });

    expect(res.status).toBe(200);
    expect(slept).toEqual([7000]); // not the SDK's 2000
  });

  it('falls back to exponential backoff when the vendor sends no header', async () => {
    slept.length = 0;

    const { base } = fakeNetwork([{ status: 429 }, { status: 429 }, { status: 200 }]);
    await rateLimitFetch({ provider: 'KIE', maxAttempts: 3, sleep }, base)('https://x.test', { body: '{}' });

    expect(slept).toEqual([2000, 4000]);
  });

  /*
   * §5A: a limit nobody counts is one you learn about from user complaints. This is the ONLY signal
   * that distinguishes "we are being throttled" from "generations are failing".
   */
  it('reports every absorbed 429, and says whether the vendor told us the wait', async () => {
    slept.length = 0;

    const events: ThrottleEvent[] = [];
    const { base } = fakeNetwork([{ status: 429, retryAfter: '1' }, { status: 429 }, { status: 200 }]);

    await rateLimitFetch({ provider: 'KIE', maxAttempts: 3, sleep, onThrottled: (e) => events.push(e) }, base)(
      'https://x.test',
      { body: '{}' },
    );

    expect(events).toEqual([
      // attempt 1: the vendor said 1s, so we use it rather than our 2s backoff.
      { provider: 'KIE', attempt: 1, waitMs: 1000, fromRetryAfter: true },

      // attempt 2: no header, so backoff — which is 2000 * 2^(2-1) = 4000, NOT a repeat of 2000.
      { provider: 'KIE', attempt: 2, waitMs: 4000, fromRetryAfter: false },
    ]);
  });

  /*
   * 🔴 A body that cannot be re-sent must NEVER be retried.
   *
   * A ReadableStream body is drained by the first attempt, so attempt two would send an EMPTY request —
   * which the vendor answers perfectly happily, with an answer to nothing. Silent, and it looks like the
   * model went mad rather than like a bug in our retry.
   */
  it('never retries a body it cannot re-send', async () => {
    slept.length = 0;

    const { base, calls } = fakeNetwork([{ status: 429, retryAfter: '1' }, { status: 200 }]);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{}'));
        c.close();
      },
    });

    const res = await rateLimitFetch({ provider: 'KIE', sleep }, base)('https://x.test', {
      method: 'POST',
      body: stream as any,
      duplex: 'half',
    } as any);

    expect(res.status).toBe(429); // handed up, not retried
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  /*
   * A user is watching this. A vendor saying "come back in an hour" must surface as a failure the §4.6
   * refund path can handle, never as a generation that hangs for an hour.
   */
  it('refuses a wait longer than its budget rather than hanging the generation', async () => {
    slept.length = 0;

    const { base, calls } = fakeNetwork([{ status: 429, retryAfter: '3600' }, { status: 200 }]);
    const res = await rateLimitFetch({ provider: 'Anthropic', maxTotalWaitMs: 30_000, sleep }, base)('https://x.test', {
      body: '{}',
    });

    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('gives up after maxAttempts and hands the 429 up to the SDK', async () => {
    slept.length = 0;

    const { base, calls } = fakeNetwork([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200 }]);
    const res = await rateLimitFetch({ provider: 'KIE', maxAttempts: 3, sleep }, base)('https://x.test', {
      body: '{}',
    });

    expect(res.status).toBe(429);
    expect(calls).toHaveLength(3);
  });

  /*
   * ONLY 429. A 500 mid-stream may already have emitted bytes, and a 400 will fail identically forever —
   * retrying either wastes the user's wall clock. The SDK's own retry still covers 5xx above us.
   */
  it.each([500, 503, 400, 401])('does not retry a %d', async (status) => {
    slept.length = 0;

    const { base, calls } = fakeNetwork([{ status }, { status: 200 }]);
    const res = await rateLimitFetch({ provider: 'KIE', sleep }, base)('https://x.test', { body: '{}' });

    expect(res.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  /* The retried request must be the SAME request — a rewrite here would drop thinkingFlag/thinking. */
  it('re-sends the identical body', async () => {
    slept.length = 0;

    const { base, calls } = fakeNetwork([{ status: 429, retryAfter: '1' }, { status: 200 }]);
    const body = JSON.stringify({ model: 'claude-opus-4-8', thinkingFlag: true });

    await rateLimitFetch({ provider: 'KIE', sleep }, base)('https://x.test', { body });

    expect(calls.map((c) => c.body)).toEqual([body, body]);
  });
});

describe('the provider chain', () => {
  /*
   * CONTROL + composition. `rateLimitFetch` sits UNDER the body rewriters, so a retried request must
   * still carry what they wrote. If the ordering is ever flipped, the retry would re-send the ORIGINAL
   * body — no thinkingFlag, no thinking — and KIE would silently stop returning reasoning on exactly
   * the requests that were throttled. Nothing else would say so.
   */
  it('retries the body AFTER the rewriters have written it', async () => {
    slept.length = 0;

    const { base, calls } = fakeNetwork([{ status: 429, retryAfter: '1' }, { status: 200 }]);
    const { kieFetch } = await import('./providers/kie-wire');

    const chained = kieFetch(rateLimitFetch({ provider: 'KIE', sleep }, base));
    await chained('https://x.test', { body: JSON.stringify({ model: 'm' }) });

    expect(calls).toHaveLength(2);

    for (const call of calls) {
      expect(JSON.parse(call.body!).thinkingFlag, 'a retried request lost thinkingFlag').toBe(true);
    }
  });
});
