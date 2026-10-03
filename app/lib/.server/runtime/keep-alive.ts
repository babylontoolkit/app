/**
 * Keep server work alive past a client disconnect (`_specs/no-unbilled-usage_plan.md` D1).
 *
 * MEASURED 2026-10-02 under the production shape (`wrangler pages dev` → workerd): when the client
 * disconnects, the request's context is torn down and EVERY pending promise of that request stops —
 * a `finally` after the stream loop, a fire-and-forget promise, a `setTimeout`. Nothing throws and
 * nothing logs; the work simply never resumes. Only work registered with the runtime's `waitUntil`
 * (and anything the request still has pending while a `waitUntil` promise is outstanding) survives.
 * So every settlement, refund and tail goes through here: on workerd the promise is registered with
 * `context.cloudflare.ctx.waitUntil`; under Vite dev / Node there is no such teardown and the promise
 * simply runs (the dev proxy's `waitUntil` is a no-op stub, which is harmless).
 *
 * Never throws: the runtime gets a copy with a logging `catch` attached, so a rejection can never
 * become an unhandled rejection or fail the request. The ORIGINAL promise is returned, so a caller that
 * awaits it still sees its result — or its rejection — exactly as before.
 */
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('keep-alive');

type WaitUntil = (promise: Promise<unknown>) => void;

/** The runtime's `waitUntil`, bound, when the load context carries one (Cloudflare Pages / workerd). */
export function waitUntilOf(context: unknown): WaitUntil | undefined {
  try {
    const ctx = (context as { cloudflare?: { ctx?: { waitUntil?: unknown } } } | null | undefined)?.cloudflare?.ctx;
    const waitUntil = ctx?.waitUntil;

    return typeof waitUntil === 'function' ? (promise) => (waitUntil as WaitUntil).call(ctx, promise) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register `promise` with the runtime so a client disconnect cannot cancel it, and return it unchanged.
 * `label` names the work in the log line if it rejects.
 */
export function keepAlive<T>(context: unknown, promise: Promise<T>, label = 'background work'): Promise<T> {
  const guarded = promise.catch((error: unknown) => {
    logger.error(`${label} failed: ${(error as Error)?.message ?? String(error)}`);
  });

  const waitUntil = waitUntilOf(context);

  if (waitUntil) {
    try {
      waitUntil(guarded);
    } catch (error) {
      // Called outside a live request (the context already ended) — the promise still runs where it can.
      logger.warn(`Could not register ${label} with waitUntil: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  return promise;
}
