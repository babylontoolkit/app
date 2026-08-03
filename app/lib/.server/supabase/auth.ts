/**
 * Authentication + the two-wall authorization rule (SPEC §4.5.1, §4.5.3).
 *
 * **"Logged in" is not authorization.** Every server route that touches a project must validate the
 * session AND that this user owns THAT project. RLS is the backstop; this middleware is the front
 * door. Both walls exist because either one alone has failed in the wild: a missing RLS policy turns
 * one forgotten `.eq('user_id', …)` into a full-table leak, and RLS alone cannot be relied on by code
 * paths that legitimately use the service-role key (grants, webhooks) — which bypass it by design.
 *
 * ## Local mode (Supabase unconfigured)
 *
 * The platform resolves to a single verified local user. This is a REAL mode, not a stub: ownership
 * is still checked, the ledger is still written, snapshots still round-trip. It exists so the whole
 * of Stage 3 is buildable and testable before a Supabase project exists (§1.3 principle 0) — and it
 * is exactly the single-user posture bolt.diy shipped with, so local dev behaves as it always did.
 *
 * It is load-bearing that local mode can never appear in production by accident: it engages ONLY when
 * `SUPABASE_URL`/`SUPABASE_ANON_KEY` are absent. A deployment with Supabase configured always
 * enforces real sessions, and `assertNotLocalInProduction` refuses to boot into the anonymous
 * fallback when `NODE_ENV=production`.
 */
import { createScopedLogger } from '~/utils/logger';
import { env } from '~/lib/.server/env';
import { createRequestClient, isSupabaseConfigured } from './client';

const logger = createScopedLogger('auth');

export interface AuthUser {
  id: string;
  email: string;

  /** Gates the free grant and Share/publish (§4.5.1). Unverified users may look around, not generate. */
  emailVerified: boolean;

  displayName: string;

  /** `profiles.avatar_url` — set from OAuth on first sign-in, absent for most password accounts. */
  avatarUrl?: string;

  isAdmin: boolean;

  /** True when this is the synthetic local user (Supabase unconfigured). */
  isLocal: boolean;
}

/**
 * The single local user. Verified and admin, because in local mode there is no one to protect the
 * operator from but themselves — and gating the grant on a verification email that no one will ever
 * send would make credits untestable.
 */
export const LOCAL_USER: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'local@localhost',
  emailVerified: true,
  displayName: 'Local Developer',
  isAdmin: true,
  isLocal: true,
};

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  readonly isRetryable = false;

  constructor(message = 'You must be signed in to do that.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  readonly isRetryable = false;

  constructor(message = 'You do not have access to that.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Refuse to serve anonymous local-mode traffic in production.
 *
 * Local mode is a development convenience that treats every caller as a verified admin. If a
 * production deploy ever lost its Supabase env — a typo'd SSM path, a dropped container var — the
 * fallback would silently hand ADMIN over the public internet. Failing to boot is the correct
 * response; a quiet downgrade is not.
 */
export function assertNotLocalInProduction(context?: unknown): void {
  const isProduction = (env(context, 'NODE_ENV') ?? process.env.NODE_ENV) === 'production';

  if (isProduction && !isSupabaseConfigured(context)) {
    throw new Error(
      'Supabase is not configured, but NODE_ENV=production. Refusing to fall back to the anonymous ' +
        'local user, which would expose admin access publicly. Set SUPABASE_URL and SUPABASE_ANON_KEY.',
    );
  }
}

/**
 * The current user, or null when signed out.
 *
 * Uses `getUser()`, NOT `getSession()`. `getSession()` returns whatever the cookie says without
 * verifying it against the auth server — fine for rendering a nav bar, useless as a security check,
 * because the cookie is attacker-supplied. Anything that gates data must verify the JWT.
 */
export async function getUser(request: Request, context?: unknown): Promise<AuthUser | null> {
  if (!isSupabaseConfigured(context)) {
    assertNotLocalInProduction(context);
    return LOCAL_USER;
  }

  const { client } = await createRequestClient(request, context);
  const { data, error } = await client.auth.getUser();

  if (error || !data.user) {
    return null;
  }

  const user = data.user;

  /*
   * `is_admin` is read from `profiles`, never from `user_metadata`. User metadata is writable by the
   * user via the Supabase client — trusting it for an admin claim would let anyone grant themselves
   * the admin panel (§4.5.3: admin is gated entirely separately from user auth).
   */
  const { data: profile } = await client
    .from('profiles')
    .select('display_name, avatar_url, is_admin')
    .eq('id', user.id)
    .maybeSingle();

  return {
    id: user.id,
    email: user.email ?? '',
    emailVerified: Boolean(user.email_confirmed_at),
    displayName: profile?.display_name || user.email?.split('@')[0] || 'Builder',
    ...(profile?.avatar_url ? { avatarUrl: String(profile.avatar_url) } : {}),
    isAdmin: Boolean(profile?.is_admin),
    isLocal: false,
  };
}

/** The current user, or 401. */
export async function requireUser(request: Request, context?: unknown): Promise<AuthUser> {
  const user = await getUser(request, context);

  if (!user) {
    throw new UnauthorizedError();
  }

  return user;
}

/**
 * A user who may spend credits (§4.5.1, §4.5.4).
 *
 * Verification gates GENERATION, not browsing: an unverified account can open the builder and look
 * around, which is what keeps signup friction low. It cannot burn our money.
 */
export async function requireVerifiedUser(request: Request, context?: unknown): Promise<AuthUser> {
  const user = await requireUser(request, context);

  if (!user.emailVerified) {
    throw new ForbiddenError('Please verify your email address to start building. Check your inbox for the link.');
  }

  return user;
}

/** Admin routes are gated on the profile flag, separately from ordinary auth (§4.5.3). */
export async function requireAdmin(request: Request, context?: unknown): Promise<AuthUser> {
  const user = await requireUser(request, context);

  if (!user.isAdmin) {
    logger.warn(`Non-admin ${user.id} attempted an admin route`);
    throw new ForbiddenError('Admin access required.');
  }

  return user;
}
