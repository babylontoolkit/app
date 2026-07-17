/**
 * Rate-limit handling for platform LLM calls (SPEC §4.2a, §5A).
 *
 * ## What already exists, and what does not
 *
 * `ai@4`'s `streamText` ALREADY retries a 429 — `APICallError.isRetryable` is true for 408/409/429/5xx
 * and `maxRetries` defaults to 2. So this is not "adding retries to a system with none". It closes the
 * three gaps that layer leaves, each of which matters more as the platform goes multi-user on ONE key:
 *
 *   1. **`retry-after` is ignored.** The SDK backs off on a fixed 2s -> 4s schedule. Anthropic TELLS us
 *      when the window resets; retrying before then burns an attempt and 429s again. Honouring the
 *      header turns two wasted retries into one that works.
 *   2. **Throttling is INVISIBLE.** Nothing logs or counts a 429, so the platform cannot tell "we are
 *      being rate limited" from "generations are failing". §5A exists to make exactly this kind of
 *      thing visible, and a limit you cannot see is the one you discover from user complaints.
 *   3. **A retried-away 429 still costs the user nothing but costs us the wall clock** — worth knowing
 *      about before it becomes an outage.
 *
 * This sits UNDER the SDK's retry (it is a `fetch` wrapper), so the two compose: we absorb short,
 * well-signposted waits here, and the SDK's own retry remains the backstop for everything else.
 *
 * ## 🔴 Why retrying here is safe, and exactly when it stops being safe
 *
 * A 429 is an HTTP STATUS — it arrives before a single byte of the model's output has streamed. So
 * re-sending is not "replaying half an answer", it is sending a request that was never served. That is
 * the entire safety argument, and it has a hard boundary: **we retry ONLY on 429, and ONLY when the
 * request body is a re-sendable string.** A streamed/consumed body cannot be sent twice — a
 * `ReadableStream` body is already drained by the first attempt, so retrying it would silently send an
 * EMPTY request. Never widen this to 5xx-after-stream-start or to non-string bodies.
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('llm-rate-limit');

export interface ThrottleEvent {
  provider: string;
  attempt: number;
  waitMs: number;

  /** True when the vendor told us how long to wait; false when we fell back to backoff. */
  fromRetryAfter: boolean;
}

export interface RateLimitOptions {
  /** For logs and monitoring — never a key, only a name (§5). */
  provider: string;

  /** Total attempts INCLUDING the first. 3 => the original plus 2 retries. */
  maxAttempts?: number;

  /**
   * Hard ceiling on time spent waiting, across all attempts.
   *
   * A generation the user is watching must never hang because a vendor said "come back in an hour".
   * Past this we return the 429 and let the SDK's own retry — and then the §4.6 refund path — take it.
   */
  maxTotalWaitMs?: number;

  /**
   * Fired on every absorbed 429.
   *
   * ⚠️ This module CANNOT import `~/lib/.server/monitoring` itself — the client bundle imports the
   * provider registry, which is exactly why `capabilities.ts` lives outside `.server` too. Pulling
   * server code in here would drag it into the browser. So this is a SEAM: server callers may pass a
   * monitor; today nothing does, and `logger.warn` is the real visibility. Do not "fix" that with an
   * import — thread the callback down from a server caller instead.
   */
  onThrottled?: (event: ThrottleEvent) => void;

  /** Test seam. Real sleeps would make the spec take minutes. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TOTAL_WAIT_MS = 30_000;

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110). Both are real; Anthropic sends
 * seconds, but a proxy in between may rewrite it, so parse both rather than assume.
 *
 * Returns null for anything unparseable — a malformed header must fall back to backoff, never throw and
 * never be read as "wait 0" (which would hammer a service that just asked us to stop).
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) {
    return null;
  }

  const seconds = Number(header.trim());

  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : null;
  }

  const date = Date.parse(header);

  if (Number.isNaN(date)) {
    return null;
  }

  // A date in the past means "you may retry now", not a negative wait.
  return Math.max(0, date - now);
}

/** The SDK's schedule, mirrored: 2s, 4s, 8s. Only used when the vendor gives us nothing better. */
function backoffMs(attempt: number): number {
  return 2_000 * 2 ** (attempt - 1);
}

/**
 * A `fetch` that absorbs short, well-signposted 429s and reports every one of them.
 *
 * Composes with `thinkingFetch`/`kieFetch` — those rewrite the body, this decides whether to send it
 * again — so it belongs at the BOTTOM of the chain, closest to the network.
 */
export function rateLimitFetch(options: RateLimitOptions, baseFetch: typeof fetch = fetch): typeof fetch {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxTotalWaitMs = options.maxTotalWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return async (input, init) => {
    /*
     * A body we cannot re-send makes retrying unsafe (a drained stream sends EMPTY on attempt two), so
     * such requests pass through untouched. `@ai-sdk/anthropic` serializes JSON to a string, so in
     * practice this is always retryable — but the guard is what keeps that an observation rather than
     * an assumption.
     */
    const resendable = init?.body === undefined || init?.body === null || typeof init.body === 'string';

    let waitedMs = 0;

    for (let attempt = 1; ; attempt++) {
      const response = await baseFetch(input, init);

      if (response.status !== 429 || !resendable || attempt >= maxAttempts) {
        if (response.status === 429) {
          // Out of attempts (or unable to retry): hand it up. The SDK retries, then §4.6 refunds.
          logger.warn(`${options.provider} rate limited (429) and not retried further after ${attempt} attempt(s)`);
        }

        return response;
      }

      const fromHeader = parseRetryAfter(response.headers.get('retry-after'));
      const waitMs = fromHeader ?? backoffMs(attempt);

      if (waitedMs + waitMs > maxTotalWaitMs) {
        logger.warn(
          `${options.provider} rate limited (429); asked for ${waitMs}ms which exceeds the ${maxTotalWaitMs}ms budget — giving up`,
        );

        return response;
      }

      /*
       * Release the 429's body before re-sending. An unconsumed body leaks a connection in undici, and
       * a leak per throttled request is worst exactly when we are already under load.
       */
      await response.arrayBuffer().catch(() => undefined);

      options.onThrottled?.({ provider: options.provider, attempt, waitMs, fromRetryAfter: fromHeader != null });
      logger.warn(
        `${options.provider} rate limited (429) — waiting ${waitMs}ms ` +
          `(${fromHeader != null ? 'retry-after' : 'backoff'}), attempt ${attempt}/${maxAttempts}`,
      );

      await sleep(waitMs);
      waitedMs += waitMs;
    }
  };
}
