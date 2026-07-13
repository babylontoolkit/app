/**
 * Platform Supabase clients (SPEC §4.5).
 *
 * ⚠️ This is NOT the Supabase the user connects to their game (§4.15 Game Backends). That one is the
 * USER's project, reached through upstream's connector with `VITE_SUPABASE_*` — public values, by
 * design, inlined into the client bundle. THIS one is the platform's own database: accounts, projects,
 * snapshots, and the credit ledger. Its names are unprefixed and it is only ever constructed here,
 * under `.server/`.
 *
 * Two clients, and the difference is a security boundary:
 *
 * - **The request client** carries the caller's JWT, so every query it makes is subject to RLS. This
 *   is what routes use. If it is ever bypassed, the user's own row-level policies stop protecting them.
 * - **The admin client** uses the service-role key and BYPASSES RLS ENTIRELY. It exists for the three
 *   jobs no user JWT can do — writing the signup grant, applying a Stripe webhook, upserting an
 *   entitlement from the license service — and every one of those runs with a server-asserted user id,
 *   never a client-supplied one. Reaching for it anywhere else is almost always a bug.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { env, NotConfiguredError } from '~/lib/.server/env';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

export function getSupabaseConfig(context?: unknown): SupabaseConfig | null {
  const url = env(context, 'SUPABASE_URL');
  const anonKey = env(context, 'SUPABASE_ANON_KEY');

  if (!url || !anonKey) {
    return null;
  }

  return { url, anonKey, serviceRoleKey: env(context, 'SUPABASE_SERVICE_ROLE_KEY') };
}

/**
 * Is the hosted layer live?
 *
 * `false` is a supported, fully-functional mode — not a broken one. The platform falls back to local
 * single-user persistence so that auth-shaped code (ownership checks, the ledger, snapshots) is
 * exercised for real in development rather than stubbed out (§1.3 principle 0).
 */
export function isSupabaseConfigured(context?: unknown): boolean {
  return getSupabaseConfig(context) !== null;
}

/** Parse a Cookie header into the `{name, value}` pairs `@supabase/ssr` expects. */
export function parseCookieHeader(header: string | null): Array<{ name: string; value: string }> {
  const cookies: Array<{ name: string; value: string }> = [];

  for (const item of (header || '').split(';')) {
    const trimmed = item.trim();

    if (!trimmed) {
      continue;
    }

    const eq = trimmed.indexOf('=');

    if (eq <= 0) {
      continue;
    }

    cookies.push({
      name: decodeURIComponent(trimmed.slice(0, eq).trim()),
      value: decodeURIComponent(trimmed.slice(eq + 1).trim()),
    });
  }

  return cookies;
}

export interface RequestClient {
  client: SupabaseClient;

  /**
   * `Set-Cookie` headers Supabase produced while refreshing the session.
   *
   * These MUST be returned on the response or the refreshed token is dropped and the user is silently
   * logged out mid-session. Every route that builds a request client is responsible for merging them.
   */
  headers: Headers;
}

/**
 * A Supabase client bound to the caller's session, with RLS in force.
 *
 * Cookies are `httpOnly` + `secure` + `sameSite=lax`: the session token is never readable from
 * JavaScript, which is what keeps an XSS in a *generated game preview* from becoming account theft.
 */
export async function createRequestClient(request: Request, context?: unknown): Promise<RequestClient> {
  const config = getSupabaseConfig(context);

  if (!config) {
    throw new NotConfiguredError(
      'Supabase',
      'Set SUPABASE_URL and SUPABASE_ANON_KEY in the server environment (.env.local for local development).',
    );
  }

  const { createServerClient } = await import('@supabase/ssr');
  const headers = new Headers();

  const client = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return parseCookieHeader(request.headers.get('Cookie'));
      },
      setAll(cookies) {
        for (const { name, value, options } of cookies) {
          const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];

          if (options?.maxAge !== undefined) {
            parts.push(`Max-Age=${options.maxAge}`);
          }

          if (options?.expires) {
            parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
          }

          parts.push('HttpOnly');

          if (process.env.NODE_ENV === 'production') {
            parts.push('Secure');
          }

          headers.append('Set-Cookie', parts.join('; '));
        }
      },
    },
  });

  return { client, headers };
}

/**
 * The service-role client. **Bypasses RLS.**
 *
 * Only for privileged server jobs whose user id the server itself asserts: the verification grant,
 * Stripe webhooks (there is no user session on a webhook — Stripe is the caller), and entitlement
 * upserts. Never construct one from a user-supplied id without an ownership check first.
 */
export async function createAdminClient(context?: unknown): Promise<SupabaseClient> {
  const config = getSupabaseConfig(context);

  if (!config) {
    throw new NotConfiguredError(
      'Supabase',
      'Set SUPABASE_URL and SUPABASE_ANON_KEY in the server environment (.env.local for local development).',
    );
  }

  if (!config.serviceRoleKey) {
    throw new NotConfiguredError(
      'The Supabase service-role key',
      'Set SUPABASE_SERVICE_ROLE_KEY in the server environment. It is required for grants, webhooks, and entitlements.',
    );
  }

  const { createClient } = await import('@supabase/supabase-js');

  return createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
