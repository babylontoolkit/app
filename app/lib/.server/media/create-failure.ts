/**
 * What a failed media CREATE means for the money (`_specs/no-unbilled-usage_plan.md` D9, G9).
 *
 * The debit lands BEFORE the create (`startMediaTask`), so the only question a failed create raises is: did
 * the provider ACCEPT the render? Three answers, and each has exactly one money consequence:
 *
 *  - `refused`   — the provider answered and did not accept it (an HTTP 4xx with an error body, a documented
 *                  rejection code). Nothing renders, nothing is billed to us: REFUND. Retried only when the
 *                  refusal is documented as transient (429 rate limit, KIE 455 "service unavailable").
 *  - `not-sent`  — the request never left (a pre-send check, a connection refused before the body was
 *                  written, a DNS failure). Nothing renders: REFUND; retry when the cause is transient.
 *  - `ambiguous` — the request may have been accepted (a timeout, a reset after send, a 5xx with no definite
 *                  refusal, a 2xx we could not read a task id from). The render may be running and billed to
 *                  us: NEVER refunded, NEVER retried blind (a retry is an un-debited duplicate). The task is
 *                  marked `unknown` for an admin to reconcile.
 *
 * ⚠️ The DEFAULT is `ambiguous`. Getting it wrong toward `refused` refunds a render the provider may be
 * charging us for and retries into a duplicate; getting it wrong toward `ambiguous` holds a debit an admin
 * can return. The asymmetry decides the default — the opposite of the old dispatch rule, which retried
 * anything it could not classify.
 *
 * Its own module (not `provider.ts`) so the clients can import a runtime class without a cycle through the
 * provider factory.
 */

export type MediaCreateOutcome = 'refused' | 'not-sent' | 'ambiguous';

export class MediaCreateError extends Error {
  readonly outcome: MediaCreateOutcome;
  readonly retryable: boolean;

  constructor(message: string, outcome: MediaCreateOutcome, retryable = false) {
    super(message);
    this.name = 'MediaCreateError';
    this.outcome = outcome;
    this.retryable = outcome === 'ambiguous' ? false : retryable;
  }
}

export interface CreateFailureClass {
  outcome: MediaCreateOutcome;
  retryable: boolean;
}

/** Network error codes raised BEFORE a request is written — the body never reached the provider. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/** HTTP statuses a provider documents as "not accepted, try again later". */
const RETRYABLE_REFUSALS = new Set([429]);

function causeCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;

  return typeof code === 'string' ? code : undefined;
}

/**
 * ⚠️ PRODUCTION RUNS UNDER workerd, AND ITS FETCH ERRORS CARRY NO PRE-SEND SIGNAL (measured 2026-10-03,
 * workerd 1.20251011.0 via miniflare 4.20251011.0, `compatibility_date = "2025-03-28"` + `nodejs_compat`):
 *
 *   - connection REFUSED                     → `Error: Network connection lost.` `{ remote: true, retryable: true }`, ~1 ms
 *   - server READ the body, then RST          → `Error: Network connection lost.` `{ remote: true, retryable: true }`, ~1 ms
 *   - server READ the body, then closed (FIN) → `Error: Network connection lost.` `{ remote: true, retryable: true }`, ~1 ms
 *   - DNS lookup failed                       → `Error: internal error; reference = <id>` `{ remote: true }` (the
 *                                               cause is only in workerd's stderr; the same message is used for
 *                                               every internal error)
 *   - `AbortSignal.timeout`                   → `DOMException` `TimeoutError`
 *
 * A refused connection and a connection dropped AFTER the body was read are byte-identical and equally fast, so
 * no message, property or elapsed-time rule can prove a workerd failure was pre-send. DECISION (D9, verifier
 * T9 risk): under workerd every transport failure stays AMBIGUOUS — the debit is held for an admin rather
 * than refunding a render the provider may have accepted. The `.code` rule below only ever fires on Node
 * (local dev), where a refused connection is genuinely distinguishable. workerd's own `retryable: true` is
 * deliberately IGNORED: it is set on the after-send drop too.
 */

/**
 * Classify a fetch-level failure (the request threw rather than answered). A timeout or an abort is
 * AMBIGUOUS — the body may have been sent and accepted. A connection that was refused before sending is
 * `not-sent` and safe to retry.
 */
export function classifyTransportFailure(error: unknown): MediaCreateError {
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  const code = causeCode(error);

  if (code && NOT_SENT_CODES.has(code)) {
    return new MediaCreateError(`the request was not sent (${code}): ${message}`, 'not-sent', true);
  }

  if (name === 'TimeoutError' || name === 'AbortError') {
    return new MediaCreateError(`no answer before the timeout — the render may have started: ${message}`, 'ambiguous');
  }

  return new MediaCreateError(`the connection failed — the render may have started: ${message}`, 'ambiguous');
}

/** Classify an HTTP answer that carried no usable task id. */
export function classifyHttpRefusal(status: number, detail: string): MediaCreateError {
  if (status >= 400 && status < 500) {
    return new MediaCreateError(detail, 'refused', RETRYABLE_REFUSALS.has(status));
  }

  return new MediaCreateError(detail, 'ambiguous');
}

/**
 * The money class of any error a create threw. A typed `MediaCreateError` answers for itself; an untyped one
 * (a provider that predates this module, a test double) is read conservatively: an explicit `HTTP 4xx` in
 * its message is a refusal, a transport-shaped error goes through `classifyTransportFailure`, and anything
 * else is AMBIGUOUS.
 */
export function classifyCreateFailure(error: unknown): CreateFailureClass {
  if (error instanceof MediaCreateError) {
    return { outcome: error.outcome, retryable: error.retryable };
  }

  const message = error instanceof Error ? error.message : String(error);
  const http = /\bHTTP (\d{3})\b/.exec(message);

  if (http) {
    const classified = classifyHttpRefusal(Number(http[1]), message);

    return { outcome: classified.outcome, retryable: classified.retryable };
  }

  const transport = classifyTransportFailure(error);

  return { outcome: transport.outcome, retryable: transport.retryable };
}
