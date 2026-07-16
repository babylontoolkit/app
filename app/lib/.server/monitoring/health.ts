/**
 * Health probe (SPEC §5A "uptime monitoring on app + /play origin").
 *
 * Two audiences, one function:
 *
 *   - An UPTIME MONITOR wants a fast, cheap liveness answer — is the process up? It does not want a
 *     health check that itself calls the database, because then a slow database turns "the app is up"
 *     into a red alert and a retry storm. So liveness is always `200 healthy`.
 *   - An OPERATOR wants to know whether the DEPENDENCIES this deploy needs are actually WIRED — is the
 *     platform key set, is Supabase configured, is billing on, is a monitoring collector attached. That
 *     is reported as `dependencies`, and its individual entries can be `degraded` WITHOUT making the
 *     overall status unhealthy, because "not configured" is a first-class, deliberate state here
 *     (§1.3 principle 0), not a failure.
 *
 * The probe reads only CONFIG PRESENCE — booleans — never a secret value and never a live network
 * call. It is safe to expose unauthenticated: it reveals which subsystems are configured, which is the
 * same thing the credits-vs-pro UI already reflects, and never a credential.
 */
import { getPlatformConfig } from '~/lib/.server/agent/config';
import { isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { isStripeConfigured } from '~/lib/.server/billing/stripe';
import { isMonitoringConfigured } from './index';

export type DependencyState = 'ok' | 'degraded';

export interface HealthReport {
  /** Liveness — always `healthy` if the process can answer at all. Uptime monitors key on this. */
  status: 'healthy';
  timestamp: string;

  /**
   * Per-dependency configuration state. `degraded` means "not configured" — expected in local dev and
   * during the pre-credential-pass build, NOT an outage. Never surfaces a value, only presence.
   */
  dependencies: Record<string, DependencyState>;

  /**
   * True only when EVERY dependency this build needs to serve real users is wired. The uptime monitor
   * ignores this; the credential-pass verification (§9a) keys on it to confirm "all green in prod".
   */
  ready: boolean;
}

export function buildHealthReport(context: unknown): HealthReport {
  const platform = getPlatformConfig(context);

  const dependencies: Record<string, DependencyState> = {
    platformKey: platform.anthropicApiKey ? 'ok' : 'degraded',
    supabase: isSupabaseConfigured(context) ? 'ok' : 'degraded',
    stripe: isStripeConfigured(context) ? 'ok' : 'degraded',

    /*
     * The play origin must be a SEPARATE registrable domain in production so shared game HTML can never
     * touch app cookies (§5). Reported here so the §9a check can confirm it is set — its absence is the
     * one "degraded" that is a genuine security concern in prod, which `share/serve.ts` enforces at the
     * serve path.
     */
    playOrigin: playUrlPresent(context) ? 'ok' : 'degraded',

    monitoringErrors: isMonitoringConfigured(context).errors ? 'ok' : 'degraded',
    monitoringAnalytics: isMonitoringConfigured(context).analytics ? 'ok' : 'degraded',
  };

  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dependencies,
    ready: Object.values(dependencies).every((d) => d === 'ok'),
  };
}

/** `PLAY_URL` is a URL string, not a flag — presence is what matters, so read it directly. */
function playUrlPresent(context: unknown): boolean {
  const value = (context as { cloudflare?: { env?: Record<string, string> } })?.cloudflare?.env?.PLAY_URL;
  return Boolean(value || process.env.PLAY_URL);
}
