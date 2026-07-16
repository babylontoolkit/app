/**
 * Bounded, retrying concurrency for provider calls (SPEC §4.5.4b).
 *
 * ## Why this exists
 *
 * The push path this replaces did `Promise.all(blobs.map(createBlob))` — one concurrent HTTP POST per
 * file, unbounded. A 500-file Toolkit project (which is a NORMAL project: the starter alone is
 * hundreds of files) fired 500 simultaneous requests, which is precisely the shape GitHub's secondary
 * rate limiter exists to stop. Two failure modes followed, and under §4.13's "sync is optional" framing
 * both were survivable annoyances:
 *
 *   1. `Promise.all` rejects on the FIRST rejection, so one 403 aborted the push — with blobs already
 *      uploaded and no ref written. Orphaned objects, no resume, nothing retried.
 *   2. The user saw a toast, shrugged, and clicked sync again later.
 *
 * Under §4.5.4b that same code path is **Save**. A dropped push is not a failed sync, it is the user's
 * only copy of their game not existing anywhere permanent. So: bounded concurrency to stay under the
 * limiter, per-item retry with backoff that HONOURS the provider's `retry-after`, and — the part
 * `Promise.all` cannot do — every item is attempted even when an earlier one fails, so the error the
 * caller sees is the real one rather than whichever lost the race.
 *
 * `sleep` is injected so the retry/backoff behaviour is testable without real time passing. Tests that
 * assert on backoff must never depend on a wall clock.
 */
import { GitProviderError } from './provider';

export interface BoundedRunOptions {
  /**
   * Max in-flight calls. Kept well under provider secondary limits — the cost of being conservative is
   * a slower save; the cost of being aggressive is a 403 storm mid-save.
   */
  concurrency?: number;

  /** Attempts per item, including the first. */
  maxAttempts?: number;

  /** Base backoff, doubled per attempt, unless the provider sends `retryAfterMs`. */
  baseDelayMs?: number;

  /** Injected for tests — never call the real timer in a unit test. */
  sleep?: (ms: number) => Promise<void>;

  /**
   * Which failures may be retried. Defaults to `error.retryable` (rate limits + 5xx/transport).
   *
   * Overridden for NON-IDEMPOTENT calls — see `withRetry`. The default is right for content-addressed
   * writes (a blob upload) and wrong for a commit.
   */
  retryOn?: (error: GitProviderError) => boolean;

  /** Progress hook for the visible retry/push status (§4.5.4b: a failed save is LOUD). */
  onProgress?: (done: number, total: number) => void;
  onRetry?: (attempt: number, error: GitProviderError) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `worker` over every item with bounded concurrency and per-item retry, preserving input order in
 * the results.
 *
 * Retries only what `GitProviderError.retryable` allows — a rate limit or a 5xx. An auth failure is
 * never retried: the token is revoked and hammering it just turns one loud, actionable error into a
 * slow one (§4.5.4b: a lapsed token must produce a re-connect prompt, not a silent drop).
 *
 * Throws the first non-retryable error, or the last retryable one after exhausting attempts. It throws
 * only AFTER every item has settled, so an in-flight call is never abandoned mid-write.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: BoundedRunOptions = {},
): Promise<R[]> {
  const {
    concurrency = 8,
    maxAttempts = 4,
    baseDelayMs = 500,
    sleep = defaultSleep,
    retryOn = (error: GitProviderError) => error.retryable,
    onProgress,
    onRetry,
  } = options;

  const results = new Array<R>(items.length);
  let cursor = 0;
  let done = 0;
  let firstError: unknown;

  const runOne = async (item: T, index: number): Promise<void> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        results[index] = await worker(item, index);
        return;
      } catch (error) {
        const providerError = error instanceof GitProviderError ? error : null;
        const isLastAttempt = attempt === maxAttempts;

        if (!providerError || !retryOn(providerError) || isLastAttempt) {
          throw error;
        }

        onRetry?.(attempt, providerError);

        /*
         * Honour the provider's own hint when it sends one — a rate limiter that says "wait 60s" means
         * it, and our exponential guess would just burn attempts against a closed door.
         */
        await sleep(providerError.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1));
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;

      try {
        await runOne(items[index], index);
      } catch (error) {
        /*
         * Record and keep draining. `Promise.all` would reject here and leave the remaining in-flight
         * calls unobserved — the exact behaviour that orphaned blobs mid-push.
         */
        firstError ??= error;
      } finally {
        onProgress?.(++done, items.length);
      }
    }
  });

  await Promise.all(workers);

  if (firstError) {
    throw firstError;
  }

  return results;
}

/**
 * Retry a single call — for the terminal writes of a save (create commit, move ref).
 *
 * ## Why this is not just `runBounded` with one item
 *
 * Because the retry rule has to be different, and getting it wrong costs the user real work.
 *
 * Blob uploads are content-addressed: re-uploading identical bytes yields the same sha, so retrying
 * one is free and `error.retryable` (rate limit OR 5xx/transport) is the right rule.
 *
 * **A commit is not idempotent.** If a POST that creates a commit fails with a 5xx — or the socket
 * drops — the write may well have LANDED and only the response was lost. Retrying then appends a
 * second, duplicate commit. So this defaults to retrying **rate limits only**: a 429 (or GitHub's
 * 403-with-`x-ratelimit-remaining:0`) is the provider stating it did not execute the request, which is
 * the one class of failure where a retry is provably safe.
 *
 * The consequence is deliberate: a 5xx mid-commit surfaces as a failed save the user is told about and
 * can retry themselves (§4.5.4b — a failed save is LOUD), rather than the platform silently maybe-
 * double-committing on their behalf. A visible failure beats an invisible duplicate.
 */
export async function withRetry<R>(fn: () => Promise<R>, options: BoundedRunOptions = {}): Promise<R> {
  const [result] = await runBounded([null], () => fn(), {
    concurrency: 1,
    retryOn: (error) => error.kind === 'rate-limit',
    ...options,
  });

  return result;
}
