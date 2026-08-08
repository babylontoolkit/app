/**
 * 🔴 RENDERS GO OUT ONE AT A TIME, SPACED, WITH PER-IMAGE RETRY (2026-08-08, owner decision).
 *
 * The owner asked for this repeatedly and was argued out of it; the batching that shipped instead is
 * what produced `MAX_MEDIA_ROUNDS` and the refusals that lost three images on a live design turn.
 * This module is the half of "one at a time, spaced out" that is about the RENDERS rather than the
 * model's calls (the other half is `media-note.ts` asking for one image per call).
 *
 * ## What it fixes
 *
 * `startMediaTask` called `provider.create` the instant the tool ran, with **no queue, no spacing and
 * no retry**. So N parallel calls meant N simultaneous POSTs to KIE, and a `create` that threw —
 * a blip, a rate limit, a transient 5xx — refunded and killed that image **permanently**, with no
 * second attempt. Partial success was silent and unrecoverable.
 *
 * ## Where it sits, and what it must not touch
 *
 * It wraps **only** `provider.create`. Everything else in `startMediaTask` keeps its order and its
 * guarantees, each of which is pinned by a test in `media.spec.ts`:
 *
 *  - the quote and the DEBIT happen BEFORE this runs, so the credits are already committed
 *  - a retry here therefore **never re-debits** — one task, one debit, up to `MAX_ATTEMPTS` attempts
 *    at getting it accepted
 *  - a final failure still refunds exactly once, via the caller's existing catch
 *  - the cut-out second stage is chained on the POLL path and is unaffected
 *
 * ## Never regress
 *
 *  - **Serialised across ALL tasks, not per task.** The existing `serialised(taskId, work)` in
 *    `service.ts` keys on the task id, so it prevents a double-refund on one task and does nothing
 *    about cross-task concurrency. That is the primitive this generalises; do not mistake one for the
 *    other.
 *  - **Spacing is measured between DISPATCHES, not added after each.** A trailing sleep makes the last
 *    render pay for spacing nobody needs; and if a create takes longer than the gap, the next one owes
 *    nothing. `nextEarliestMs` is a deadline, not a delay.
 *  - **The clock and the sleep are injected.** A queue tested against a real timer either takes real
 *    seconds or is tested with the spacing disabled — and a spacing test that does not advance a clock
 *    passes with the spacing removed, which is the vacuous-test trap this repo keeps re-learning.
 *  - **A failure must not poison the chain**, and there are TWO independent guards below: the
 *    `.then(run, run)` shape (which invokes `run` even when the previous link rejected) and storing
 *    the CAUGHT promise as the next link. Either alone is sufficient; both are kept because the
 *    failure they prevent is `execution-queue.ts`'s measured bug — one throw turning the queue itself
 *    into a rejected promise, after which every later render in the process is never dispatched at
 *    all, silently and permanently.
 *
 *    ⚠️ **Mutation-verified, and the first reading of that result was wrong.** Removing either guard
 *    ALONE leaves the spec green, which looks like a vacuous test; removing BOTH fails two tests. So
 *    the spec does hold the behaviour — it just cannot see redundancy, which no behavioural test can.
 *    An earlier version of this comment named `.then(run, run)` as *the* protection. It is not, and a
 *    false claim in a comment is how this class of defect survives review (see `shell-strip.ts`).
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('media-dispatch');

/** One render in flight at a time. The whole point — never widen this to "parallel but throttled". */
export const MEDIA_CONCURRENCY = 1;

/** Minimum gap between two dispatches reaching the provider. */
export const MEDIA_SPACING_MS = 1500;

/** Attempts per IMAGE, not per batch. A failed create earns its own retries; the debit is unchanged. */
export const MEDIA_MAX_ATTEMPTS = 3;

/** Backoff before attempt 2 and 3. Bounded and short — this is a create call, not a render. */
export const MEDIA_RETRY_DELAYS_MS = [1_000, 4_000];

/**
 * Is this a refusal that will repeat identically? Message-sniffed, because `provider.create` throws a
 * plain `Error` with the wire body in its message (`kie-client.ts:87`) rather than a typed status.
 *
 * ⚠️ DEFAULT IS RETRYABLE. Getting this wrong in the "deterministic" direction loses an image the user
 * asked for; getting it wrong the other way costs a few seconds. The asymmetry decides the default.
 */
export function isDeterministicRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /\b(4[0-9]{2})\b/.test(message) || /invalid|unsupported|not found|unauthor|forbidden|malformed/i.test(message);
}

export interface DispatchDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realDeps: DispatchDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The queue's state. Module-level and per-process, deliberately: it exists to be kind to KIE and to
 * our own egress, and both are per-process concerns. It holds no user data and no credits.
 */
interface QueueState {
  chain: Promise<unknown>;
  nextEarliestMs: number;
}

const queue: QueueState = { chain: Promise.resolve(), nextEarliestMs: 0 };

/** Exported for tests only — a shared module-level queue would otherwise leak between test cases. */
export function createDispatchQueue(deps: DispatchDeps = realDeps) {
  const state: QueueState = { chain: Promise.resolve(), nextEarliestMs: 0 };
  return makeDispatcher(state, deps);
}

function makeDispatcher(state: QueueState, deps: DispatchDeps) {
  return async function dispatch<T>(label: string, create: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      /*
       * Spacing, measured against a DEADLINE rather than as a trailing sleep: if the previous create
       * took longer than the gap, this one waits nothing.
       */
      const waitMs = state.nextEarliestMs - deps.now();

      if (waitMs > 0) {
        await deps.sleep(waitMs);
      }

      let lastError: unknown;

      for (let attempt = 1; attempt <= MEDIA_MAX_ATTEMPTS; attempt++) {
        /*
         * Stamped BEFORE the attempt, so the gap is measured from when this dispatch reached the
         * provider — including a retry, which is itself a request KIE has to serve.
         */
        state.nextEarliestMs = deps.now() + MEDIA_SPACING_MS;

        try {
          return await create();
        } catch (error) {
          lastError = error;

          /*
           * A DETERMINISTIC refusal is not worth retrying — an unknown model, a malformed payload or a
           * rejected prompt will be refused identically three times, and all the retry buys is ~5s of
           * extra latency before the user's refund. Retries exist for transient faults: a 5xx, a rate
           * limit, a dropped connection. Anything we cannot classify is treated as transient, because
           * the cost of a needless retry is seconds and the cost of a missed one is a lost image.
           */
          if (isDeterministicRefusal(error)) {
            logger.warn(`media dispatch ${label}: provider refused deterministically, not retrying`);
            break;
          }

          if (attempt < MEDIA_MAX_ATTEMPTS) {
            const backoff = MEDIA_RETRY_DELAYS_MS[attempt - 1] ?? MEDIA_SPACING_MS;
            logger.warn(
              `media dispatch ${label}: attempt ${attempt}/${MEDIA_MAX_ATTEMPTS} failed, retrying in ${backoff}ms`,
            );
            await deps.sleep(backoff);
          }
        }
      }

      logger.warn(`media dispatch ${label}: all ${MEDIA_MAX_ATTEMPTS} attempts failed`);

      throw lastError;
    };

    /*
     * `.then(run, run)` — the rejection-tolerant chain. A bare `.then(run)` forwards a rejection and
     * turns the queue itself into a rejected promise, after which EVERY later dispatch in this process
     * is never invoked at all. That is `execution-queue.ts`'s measured bug, and it is one character
     * away from here.
     */
    const result = state.chain.then(run, run) as Promise<T>;

    state.chain = result.catch(() => undefined);

    return result;
  };
}

const productionDispatcher = makeDispatcher(queue, realDeps);

let _dispatcher: <T>(label: string, create: () => Promise<T>) => Promise<T> = productionDispatcher;

/**
 * Test seam, following `setLedger` / `setGenerationStore`.
 *
 * ⚠️ It exists because the production queue sleeps on a REAL timer, and `startMediaTask` reaches it
 * through two layers with no injection point. Without this, any spec that drives a failing provider
 * pays `MEDIA_MAX_ATTEMPTS` real backoffs — which is exactly how this was found (a 6-call spec timed
 * out at 5s). A queue whose only honest test is a slow one gets tested with the spacing disabled,
 * and then the spacing is never tested at all.
 */
export function setMediaDispatcher(dispatcher?: <T>(label: string, create: () => Promise<T>) => Promise<T>) {
  _dispatcher = dispatcher ?? productionDispatcher;
}

/** The process-wide dispatcher used in production. */
export function dispatchMediaCreate<T>(label: string, create: () => Promise<T>): Promise<T> {
  return _dispatcher(label, create);
}
