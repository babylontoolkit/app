/**
 * Observability — error tracking, operational alerts, and product analytics (SPEC §5A).
 *
 * VENDOR-NEUTRAL BY DESIGN. §5A names Sentry and PostHog only as EXAMPLES ("decide tool in Phase 2"),
 * so this module commits to neither: it is a transport-agnostic interface with a no-op default, in the
 * same shape as the storage layer's S3-or-local-FS seam. A Sentry/PostHog/Datadog adapter plugs in
 * later at the credential pass (§9a) by setting an env URL — no call site changes.
 *
 * Three rules this module must never break:
 *
 *   1. **It never throws.** Observability that can break a request is worse than no observability —
 *      it converts a metrics outage into a user-facing outage. Every method swallows its own errors
 *      (logging them) and returns. Callers do not wrap these in try/catch.
 *   2. **It is config-degraded, not stubbed.** With nothing configured it logs through the scoped
 *      logger — real, inspectable output in local dev — and is wired at every call site for real. Set
 *      a transport URL and the same calls start shipping. There is no "TODO: add monitoring" anywhere.
 *   3. **It is fire-and-forget.** Nothing awaits a capture on the request's critical path. The HTTP
 *      transport is bounded by a short timeout so a slow collector cannot stall a generation.
 */
import { createScopedLogger } from '~/utils/logger';
import { env } from '~/lib/.server/env';
import type { AlertSignal, AlertSeverity, FunnelEvent } from './events';

const logger = createScopedLogger('monitoring');

/** How long we wait on a monitoring collector before giving up. Observability must never stall a turn. */
const TRANSPORT_TIMEOUT_MS = 3000;

export interface ErrorContext {
  /** Where the error happened — a route, a subsystem, a job name. */
  scope?: string;

  /** The affected user, when known. Never PII beyond the opaque id. */
  userId?: string;

  /** Anything that helps triage: project id, generation id, provider, status code. */
  tags?: Record<string, string | number | boolean | undefined>;
}

export interface Monitor {
  /** Report a caught exception (client-forwarded or server-side). Never rethrows. */
  captureException(error: unknown, ctx?: ErrorContext): void;

  /** Report a noteworthy non-exception condition. */
  captureMessage(message: string, ctx?: ErrorContext & { level?: AlertSeverity }): void;

  /** Fire an operational alert (§5A) — the "someone should look at this" channel. */
  alert(signal: AlertSignal, detail: string, ctx?: ErrorContext & { severity?: AlertSeverity }): void;

  /** Record a product-analytics / funnel event (§5A). */
  track(event: FunnelEvent, props?: Record<string, string | number | boolean | undefined>): void;
}

/**
 * Where observability data goes. Resolved once per request-context from env:
 *
 *   MONITORING_WEBHOOK_URL  — errors + alerts (a collector, a Sentry tunnel, a Slack incoming webhook)
 *   ANALYTICS_WEBHOOK_URL   — funnel events (a PostHog capture endpoint, a warehouse ingest URL)
 *
 * Neither set → log-only. The generic JSON envelope below is deliberately collector-shaped so a real
 * sink can be pointed at it without a code change; a vendor whose protocol differs gets a thin adapter
 * here, not a rewrite of every call site.
 */
interface Transport {
  errorsUrl?: string;
  analyticsUrl?: string;
}

function resolveTransport(context: unknown): Transport {
  return {
    errorsUrl: env(context, 'MONITORING_WEBHOOK_URL'),
    analyticsUrl: env(context, 'ANALYTICS_WEBHOOK_URL'),
  };
}

/**
 * POST a JSON envelope, best-effort. Fire-and-forget: the returned promise is intentionally not
 * awaited on the request path, and a transport failure is logged, never surfaced. `fetch` is a global
 * in every runtime we deploy to; when it is somehow absent we degrade to log-only rather than crash.
 */
function ship(url: string, payload: unknown): void {
  if (typeof fetch !== 'function') {
    return;
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS),
  }).catch((error) => {
    // A dead collector must not become a dead request. Note it and move on.
    logger.warn(`monitoring transport failed (${url}): ${(error as Error).message}`);
  });
}

function serializeError(error: unknown): { message: string; stack?: string; name?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack, name: error.name };
  }

  return { message: typeof error === 'string' ? error : JSON.stringify(error) };
}

class DefaultMonitor implements Monitor {
  constructor(private readonly _transport: Transport) {}

  captureException(error: unknown, ctx?: ErrorContext): void {
    const err = serializeError(error);

    try {
      logger.error(`[${ctx?.scope ?? 'unknown'}] ${err.message}${err.stack ? `\n${err.stack}` : ''}`);

      if (this._transport.errorsUrl) {
        ship(this._transport.errorsUrl, {
          kind: 'exception',
          error: err,
          scope: ctx?.scope,
          userId: ctx?.userId,
          tags: ctx?.tags,
          at: new Date().toISOString(),
        });
      }
    } catch (own) {
      // The observability layer failing must never propagate. Last-resort log only.
      logger.warn(`captureException itself failed: ${(own as Error).message}`);
    }
  }

  captureMessage(message: string, ctx?: ErrorContext & { level?: AlertSeverity }): void {
    try {
      const level = ctx?.level ?? 'info';
      logger.info(`[${ctx?.scope ?? 'unknown'}] (${level}) ${message}`);

      if (this._transport.errorsUrl && level !== 'info') {
        ship(this._transport.errorsUrl, {
          kind: 'message',
          message,
          level,
          scope: ctx?.scope,
          userId: ctx?.userId,
          tags: ctx?.tags,
          at: new Date().toISOString(),
        });
      }
    } catch (own) {
      logger.warn(`captureMessage itself failed: ${(own as Error).message}`);
    }
  }

  alert(signal: AlertSignal, detail: string, ctx?: ErrorContext & { severity?: AlertSeverity }): void {
    try {
      const severity = ctx?.severity ?? 'warning';
      logger.warn(`ALERT[${signal}] (${severity}) ${detail}`);

      if (this._transport.errorsUrl) {
        ship(this._transport.errorsUrl, {
          kind: 'alert',
          signal,
          severity,
          detail,
          scope: ctx?.scope,
          userId: ctx?.userId,
          tags: ctx?.tags,
          at: new Date().toISOString(),
        });
      }
    } catch (own) {
      logger.warn(`alert itself failed: ${(own as Error).message}`);
    }
  }

  track(event: FunnelEvent, props?: Record<string, string | number | boolean | undefined>): void {
    try {
      logger.debug(`event ${event} ${props ? JSON.stringify(props) : ''}`);

      if (this._transport.analyticsUrl) {
        ship(this._transport.analyticsUrl, {
          kind: 'event',
          event,
          props: props ?? {},
          at: new Date().toISOString(),
        });
      }
    } catch (own) {
      logger.warn(`track itself failed: ${(own as Error).message}`);
    }
  }
}

/**
 * The monitor for this request-context. Cheap to construct (it only reads env), so it is created per
 * call rather than cached — matching the rest of the `.server` layer, where every accessor takes the
 * Remix context and reads env fresh (no module-level singletons that would pin the FIRST request's
 * env for the life of the process).
 */
export function getMonitor(context?: unknown): Monitor {
  return new DefaultMonitor(resolveTransport(context));
}

/** True when a real collector is wired — surfaced by the health check so ops can confirm the wiring. */
export function isMonitoringConfigured(context?: unknown): { errors: boolean; analytics: boolean } {
  const t = resolveTransport(context);
  return { errors: Boolean(t.errorsUrl), analytics: Boolean(t.analyticsUrl) };
}

export { FUNNEL_EVENTS, ALERT_SIGNALS } from './events';
export type { FunnelEvent, AlertSignal, AlertSeverity } from './events';
