/**
 * Client-side error capture (SPEC §5A).
 *
 * A tiny, dependency-free forwarder: React error boundaries call `captureClientError`, and it POSTs the
 * error to `/api/monitoring/client-error`, which hands it to the server's vendor-neutral monitor. No
 * SDK, no DSN in the bundle, no vendor lock-in on the client — the transport decision lives on the
 * server (see `app/routes/api.monitoring.client-error.ts`).
 *
 * Best-effort by construction: it uses `keepalive` so a report survives a navigation away from a
 * crashing page, and it swallows its own failures. Reporting an error must never throw a second one.
 */
export function captureClientError(error: unknown, scope: string): void {
  try {
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown client error');

    const payload = JSON.stringify({
      message: err.message,
      stack: err.stack,
      name: err.name,
      scope,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
    });

    // `fetch` is universal in browsers; guard anyway so SSR/tests never trip on it.
    if (typeof fetch === 'function') {
      void fetch('/api/monitoring/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {
        // A dead sink must not surface to the user mid-crash.
      });
    }
  } catch {
    // Never let the reporter become the failure.
  }
}
