/**
 * Why a creation did not happen (SPEC §4.4).
 *
 * Phase 1 is the one part of New Project that is allowed to fail (see `create-project.ts`), so when it
 * does, the user deserves to know WHICH of its two steps broke and what to do about it. The message it
 * replaced — *"Could not fetch the starter template (401)"* — named a template that was never the
 * problem: a 401 there is an expired session, and the fix is to sign in, not to touch the template.
 *
 * The classification is worth stating plainly because the route's name hides it: **`/api/starter-template`
 * does not call GitHub.** Since §4.4 pin-and-cache the starter is a SHA-addressed snapshot in object
 * storage, promoted from the Admin panel, so this request is browser → our own server → storage. Its
 * realistic failures are therefore SESSION and SERVER failures, and only the un-pinned/missing-snapshot
 * fall-through reaches GitHub at all.
 *
 * Two audiences, one string: a first sentence the user can act on, and a parenthetical `detail` that
 * says exactly what broke so the owner can debug from a screenshot without a server log.
 */

/** What the user is told, and what actually broke. */
export interface CreationFailure {
  /** One actionable sentence. No stack traces, no status codes. */
  message: string;

  /** The specific cause, shown in parentheses after the message and logged verbatim. */
  detail: string;

  /**
   * Can the user fix this by trying again?
   *
   * False for a stale session or an unconfigured platform: retrying a 401 in a loop is the most
   * common way a user concludes the product is broken when it is one sign-in away from working.
   */
  isRetryable: boolean;
}

/** Render a failure as the single string the toast and the error panel both show. */
export function formatCreationFailure(failure: CreationFailure): string {
  return `${failure.message} (${failure.detail})`;
}

/**
 * A phase-1 failure that already knows how to explain itself.
 *
 * Carrying the classification on the error is what stops it being re-guessed at the catch site from a
 * flattened message string — the caller has the structured reason, so it can show the sentence, log
 * the detail, and decide whether to offer a retry, all without parsing English.
 */
export class CreationError extends Error {
  readonly failure: CreationFailure;

  constructor(failure: CreationFailure) {
    super(formatCreationFailure(failure));
    this.name = 'CreationError';
    this.failure = failure;
  }
}

/** Recover the classification from an unknown throw, classifying anything unexpected as itself. */
export function asCreationFailure(error: unknown): CreationFailure {
  if (error instanceof CreationError) {
    return error.failure;
  }

  return {
    message: 'The project could not be created from the starter template.',
    detail: error instanceof Error ? error.message : String(error),
    isRetryable: true,
  };
}

/**
 * Classify a NON-OK response from the starter-template route.
 *
 * `body` is whatever the route returned — `{ error, details }` from its own catch, or the
 * `{ message, statusCode }` shape `errorResponse` produces for an auth refusal. Both are optional:
 * a proxy or a mid-deploy server can return HTML or nothing at all, and the classification must still
 * be specific about the STATUS even when the body tells it nothing.
 */
export function describeStarterFetchFailure(options: {
  status: number;
  statusText?: string;
  body?: unknown;
}): CreationFailure {
  const { status, statusText, body } = options;

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const serverDetail = [record.details, record.message, record.error]
    .filter((value): value is string => typeof value === 'string' && value.length > 0 && value !== 'true')
    .at(0);

  const suffix = serverDetail ? `: ${serverDetail}` : statusText ? `: ${statusText}` : '';

  if (status === 401 || status === 403) {
    return {
      message: 'Your session has expired, so the starter template could not be loaded. Sign in and try again.',
      detail: `the server rejected the request as unauthenticated — HTTP ${status}${suffix}`,
      isRetryable: false,
    };
  }

  if (status === 404) {
    return {
      message: 'The starter-template service was not found. The app may be mid-deploy — wait a moment and try again.',
      detail: `HTTP 404 from /api/starter-template${suffix}`,
      isRetryable: true,
    };
  }

  if (status === 429) {
    return {
      message: 'Too many requests in a row. Wait a few seconds and start the project again.',
      detail: `HTTP 429 rate limit${suffix}`,
      isRetryable: true,
    };
  }

  if (status >= 500) {
    /*
     * The server reaches this only after the pin AND the last-known-good snapshot have both come up
     * empty — i.e. it fell through to a live GitHub fetch and that failed too. Worth naming, because
     * the fix is an admin action (promote a template pin), not anything the user can do.
     */
    return {
      message:
        'The server could not produce a starter template. If this persists, the starter may not be pinned yet — an admin can promote one from Settings → Admin → Starter template.',
      detail: `HTTP ${status} from /api/starter-template${suffix}`,
      isRetryable: true,
    };
  }

  return {
    message: 'The starter template could not be loaded, so no project was created.',
    detail: `HTTP ${status}${suffix}`,
    isRetryable: true,
  };
}

/**
 * Classify a `fetch` that never produced a response, or a response that was not a usable file list.
 *
 * A rejected `fetch` is a TypeError with a uselessly generic message ("Failed to fetch" / "Load
 * failed"), and it means the request never reached us — offline, the dev server restarted, a proxy cut
 * it. Saying "the starter template failed" there points the user at the wrong thing entirely.
 */
export function describeStarterTransportFailure(error: unknown): CreationFailure {
  const raw = error instanceof Error ? error.message : String(error);

  return {
    message: 'Could not reach the server to load the starter template, so no project was created.',
    detail: `the request never completed — ${raw || 'no response'}`,
    isRetryable: true,
  };
}

/** A 200 that did not carry a mountable file list. Rare, and completely opaque without saying so. */
export function describeStarterPayloadFailure(received: unknown): CreationFailure {
  const shape = Array.isArray(received) ? 'an empty list' : `a ${typeof received}`;

  return {
    message: 'The starter template came back empty, so there was nothing to create the project from.',
    detail: `the server returned ${shape} instead of template files`,
    isRetryable: true,
  };
}

/**
 * Classify a mount that did not land — the other fatal step (§4.4).
 *
 * `mountTemplate` already throws well-worded, specific errors (it names the file it could not write,
 * or that the sentinel was missing). The job here is only to keep them LOUD and attribute them to the
 * right phase, never to flatten them into a generic message.
 */
export function describeMountFailure(error: unknown): CreationFailure {
  const raw = error instanceof Error ? error.message : String(error);

  return {
    message: 'The starter template was downloaded but could not be written into the project workspace.',
    detail: raw || 'the mount failed without a message',
    isRetryable: true,
  };
}
