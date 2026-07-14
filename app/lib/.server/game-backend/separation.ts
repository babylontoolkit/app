/**
 * Game Backend hard separation (SPEC §4.15, §5).
 *
 * A "Game Backend" is the user's OWN Supabase project — their account, their keys, their data. The
 * platform Supabase (accounts, credits, projects) is a DIFFERENT Supabase entirely, and **user game
 * code must never be able to reach it.** The two are already separated structurally: the platform uses
 * unprefixed server-only env (`SUPABASE_URL`, service-role key), while the game backend uses the
 * upstream connector's `VITE_SUPABASE_*` public values that live in the user's browser.
 *
 * This module is the belt to that architectural braces: it refuses to treat a backend as connected if
 * its project ref resolves to OUR platform. A misconfiguration (or a malicious client posting our
 * project ref as its "game backend") must not cause the agent to scaffold game code — code that ships
 * a public anon key — against the platform database. If the two ever coincide, the safe action is to
 * behave as if NO backend is connected, and log loudly.
 */
import { env } from '~/lib/.server/env';
import { createScopedLogger } from '~/utils/logger';
import type { GameBackendState } from '~/lib/.server/agent/project-notes';

const logger = createScopedLogger('game-backend');

/** The platform's own Supabase project ref, derived from its URL (`https://<ref>.supabase.co`). */
export function platformProjectRef(context?: unknown): string | null {
  const url = env(context, 'SUPABASE_URL');

  if (!url) {
    return null;
  }

  const match = url.match(/^https?:\/\/([a-z0-9-]+)\.supabase\./i);

  return match ? match[1].toLowerCase() : null;
}

/**
 * True when a claimed game-backend ref is actually the platform's own project.
 *
 * Compares against the platform ref AND the raw URL host, because a client could send either the ref
 * or the full URL as `projectRef`. Case-insensitive; whitespace-trimmed.
 */
export function isPlatformBackend(projectRef: string | undefined, context?: unknown): boolean {
  if (!projectRef) {
    return false;
  }

  const claimed = projectRef.trim().toLowerCase();
  const platform = platformProjectRef(context);

  if (platform && (claimed === platform || claimed.includes(`${platform}.supabase.`))) {
    return true;
  }

  // Also refuse if the claimed ref is literally the platform URL.
  const platformUrl = env(context, 'SUPABASE_URL')?.trim().toLowerCase();

  return Boolean(platformUrl && claimed === platformUrl);
}

/**
 * Normalise an incoming game-backend claim into what the agent may be told.
 *
 * Returns `undefined` (i.e. "no backend") when the claim points at the platform — the safe failure.
 * This is applied at the route boundary, before the connection ever reaches the generation, so a bad
 * claim cannot become an RLS-first note against our own database.
 */
export function sanitizeGameBackend(
  backend: GameBackendState | undefined,
  context?: unknown,
): GameBackendState | undefined {
  if (!backend?.connected) {
    return undefined;
  }

  if (isPlatformBackend(backend.projectRef, context)) {
    logger.error(
      `Refused a Game Backend claim pointing at the PLATFORM Supabase (ref=${backend.projectRef}). ` +
        `Treating as no backend — game code must never target platform infrastructure (§4.15).`,
    );

    return undefined;
  }

  return backend;
}
