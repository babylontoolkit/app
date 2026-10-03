/**
 * The prompt enhancer cannot hang on its own usage (`_specs/no-unbilled-usage_plan.md` D8, G8).
 *
 * ai@4.3.16: when the provider call fails BEFORE the first step finishes (a 401, a 5xx, a refused body), the
 * stream yields one `error` part and ends — and `result.steps` / `result.usage` NEVER settle (reproduced in
 * `enhancer-settlement.spec.ts` against the real `streamText`). The enhancer used to `await result.steps`
 * after draining the stream, so a broken enhancement parked its settlement forever: no terminal row, no
 * refund, no alert, the in-flight mark held until it expired.
 *
 * So the read is a RACE: by the time it runs the stream has already ended, which is when the SDK resolves
 * the steps if it ever will — the bounded wait only covers the gap between the two. Losing the race is not an
 * error; it means "no step was reported", and the wire recorder (`wire-usage.ts`) supplies what the provider
 * billed instead.
 */

/** How long, after the stream ended, settlement waits for the SDK's step report before billing from the wire. */
export const ENHANCER_STEPS_WAIT_MS = 2000;

let waitOverrideMs: number | undefined;

/** Tests only: shorten the wait so a hang case does not cost the suite two seconds. */
export function setEnhancerStepsWaitForTests(ms: number | undefined): void {
  waitOverrideMs = ms;
}

/** The value of `pending`, or `undefined` when it has not settled within the wait. A rejection reads as `undefined` too. */
export async function settledWithin<T>(
  pending: PromiseLike<T> | undefined,
  timeoutMs?: number,
): Promise<T | undefined> {
  if (!pending) {
    return undefined;
  }

  const wait = Math.max(0, timeoutMs ?? waitOverrideMs ?? ENHANCER_STEPS_WAIT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve(pending).then(
        (value) => value,
        () => undefined,
      ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), wait);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
