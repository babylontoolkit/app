/**
 * Uniform error responses for server routes (SPEC §4.5.3, §5).
 *
 * Every route that touches a project throws the same small set of errors, and they must all come back
 * to the client with the same shape — so a 404 for "not yours" is indistinguishable from a 404 for
 * "does not exist" (see `requireOwnedProject`: telling them apart would turn the API into an
 * enumeration oracle).
 *
 * The other rule: **never leak an internal error message to the client.** A Postgres error text can
 * carry table names, column names, and constraint names. Log the detail; return a sentence.
 */
import { json } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { requireVerifiedUser } from '~/lib/.server/supabase/auth';

const logger = createScopedLogger('http');

interface CodedError {
  statusCode?: number;
  isRetryable?: boolean;
  message?: string;
  name?: string;
}

/**
 * Errors we RAISE on purpose and whose messages are safe (and useful) to show the user.
 *
 * Exported as a `ReadonlySet` so a spec can pin membership — "this refusal is describable" is a real
 * property of a thrown class, and a message assertion cannot see it (a plain `Error` with perfect
 * wording becomes a generic 500). Readonly because an importer that could `.add()` here would be
 * widening what the server discloses, from a module that never intended to offer that.
 */
export const SAFE_ERRORS: ReadonlySet<string> = new Set([
  'UnauthorizedError',
  'ForbiddenError',
  'NotFoundError',
  'NotConfiguredError',
  'DuplicateGrantError',
  'DuplicatePaymentError',
  'BuildTooLargeError',
  'SeedTooLargeError',

  /*
   * The import refusals (§4.13, `git/clone.ts`). Each names the limitation it hit — an unsupported
   * host, the size cap and its env var, the LFS paths — and a refusal that names no cause is read as
   * the button being broken (`share/build-failure.ts`, the same lesson one door over).
   */
  'RateLimitedError',
  'UnsupportedGitHostError',
  'CloneTooLargeError',
  'LfsPointerError',
  'RootAbsoluteAssetError',
  'UnmountableRouterBasenameError',
  'AccountDeletionError',
]);

export function errorResponse(error: unknown): Response {
  const coded = error as CodedError;
  const status = coded?.statusCode ?? 500;

  if (status >= 500) {
    logger.error(`${coded?.name ?? 'Error'}: ${coded?.message}`);
  }

  const safe = coded?.name && SAFE_ERRORS.has(coded.name);

  return json(
    {
      error: true,
      message: safe ? coded.message : 'Something went wrong on our end. Please try again.',
      statusCode: status,
      isRetryable: coded?.isRetryable ?? status >= 500,
    },
    { status },
  );
}

/** Wrap a route handler so thrown auth/ownership errors become correct responses. */
export async function handle<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Auth gate for inherited routes that reach OUT on the platform's behalf (git/GitHub/GitLab/Netlify/
 * Vercel/Supabase passthroughs and deploys). Returns a 401/403 `Response` when the caller is not a
 * verified user, or `null` to proceed.
 *
 * These routes were anonymous, and several fall back to a PLATFORM provider token when the caller
 * sends none — so an anonymous request used our token, our quota, and our bandwidth with no way to
 * attribute the spend (SPEC §4.5.4, §5). A verified session is the floor for any outbound call. Use:
 *
 *   const denied = await denyUnlessVerified(request, context);
 *   if (denied) return denied;
 */
export async function denyUnlessVerified(request: Request, context: unknown): Promise<Response | null> {
  try {
    await requireVerifiedUser(request, context);
    return null;
  } catch (error) {
    return errorResponse(error);
  }
}
