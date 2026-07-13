/**
 * Server environment access — the single door to platform configuration (SPEC §3, §5).
 *
 * ALL platform secrets are server-only: the Supabase service-role key, AWS keys, the Stripe secret,
 * the license-service secret. This module is under `.server/`, so importing it from client code is a
 * build error rather than a leak.
 *
 * **Never prefix a platform secret with `VITE_`.** Vite INLINES every `VITE_*` variable into the
 * client bundle. Upstream already uses `VITE_SUPABASE_*` for the Game Backends connector (§4.15) —
 * that is the USER's Supabase project, and those values are public by design (anon key, project URL).
 * Ours is a different Supabase entirely, and its service-role key bypasses RLS: shipping it to a
 * browser would hand every visitor every row in the database. Hence the unprefixed names below.
 *
 * Absent credentials are a first-class, describable state — never a crash, never a silent fallback
 * (§1.3 principle 0). Each subsystem exposes an `isConfigured` predicate and degrades to a local
 * equivalent, so the whole product is buildable and testable before a single vendor account exists.
 */

/**
 * Read one variable. Cloudflare hands env through the Remix loader context; Node reads `process.env`.
 * Supporting both keeps us deployable to either without touching call sites (§8).
 */
export function env(context: unknown, key: string): string | undefined {
  const fromCloudflare = (context as { cloudflare?: { env?: Record<string, string> } })?.cloudflare?.env?.[key];

  return fromCloudflare || process.env[key] || undefined;
}

/** A flag is on ONLY when it is exactly `"true"`. Anything else — unset, `"1"`, `"yes"` — is off. */
export function envFlag(context: unknown, key: string, fallback = false): boolean {
  const raw = env(context, key);

  if (raw === undefined) {
    return fallback;
  }

  return raw === 'true';
}

/** A numeric setting, with the config default when unset or unparseable. */
export function envNumber(context: unknown, key: string, fallback: number): number {
  const raw = env(context, key);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A dependency the operator has not configured yet.
 *
 * This is deliberately NOT an error class that callers catch and paper over. It carries a 503 and a
 * sentence telling the operator exactly which variable to set — the "descriptive server error" half
 * of the degrade-gracefully rule. The other half is the UI's "not configured" state.
 */
export class NotConfiguredError extends Error {
  readonly statusCode = 503;
  readonly isRetryable = false;

  constructor(what: string, how: string) {
    super(`${what} is not configured. ${how}`);
    this.name = 'NotConfiguredError';
  }
}
