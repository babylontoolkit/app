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
import { isSandboxProviderEnabled } from '~/lib/common/sandbox-runtime';
import { getPlatformConfig, hasPlatformKey } from '~/lib/.server/agent/config';
import { isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { isStripeConfigured } from '~/lib/.server/billing/stripe';
import { isSandboxConfigured } from '~/lib/.server/sandbox/config';
import { isMonitoringConfigured } from './index';
import { getActivePrompt } from '~/lib/.server/prompt/active';

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

/**
 * Is there a prompt version to generate against?
 *
 * The ONLY non-config check in this report, and it earns the exception for the reason the
 * `platformKey` comment below gives: without it a deploy reports **healthy and ready while every
 * generation fails**. There is no boot-time doc-sync — a version is built only by an admin pressing
 * Refresh or a `curl` with `ADMIN_TOKEN` — so a brand-new environment (or one whose object store was
 * emptied) has none, and `proxy.ts` throws `NotConfiguredError('The system prompt')` on every request.
 * §9a keys on `ready` to confirm "all green in prod"; that check would have waved this through.
 *
 * ⚠️ It reads OUR OWN store, never GitHub, and `active.ts` memoises for 30s — so a monitor hitting
 * `/healthz` every few seconds costs at most two reads a minute, not one per probe. It is deliberately
 * NOT a reachability probe of anything external, which is this endpoint's stated contract.
 *
 * ⚠️ Never throws. Observability cannot be the thing that takes the health endpoint down, so a store
 * that errors reports `degraded` — the same answer as "no version", and the honest one: we cannot
 * confirm we can serve.
 */
async function systemPromptState(): Promise<DependencyState> {
  try {
    return (await getActivePrompt()) ? 'ok' : 'degraded';
  } catch {
    return 'degraded';
  }
}

export async function buildHealthReport(context: unknown): Promise<HealthReport> {
  const platform = getPlatformConfig(context);

  const dependencies: Record<string, DependencyState> = {
    systemPrompt: await systemPromptState(),

    /*
     * The key for the CONFIGURED provider — never `anthropicApiKey` outright.
     *
     * This asked about Anthropic's key regardless of who the platform actually buys tokens from, so
     * `LLM_PROVIDER=KIE` with no `KIE_API_KEY` reported a healthy, READY deploy that 503s on every
     * generation — and §9a keys on `ready` to confirm "all green in prod", so the one check meant to
     * catch a missing credential would have waved it through. The mirror image is just as wrong: a
     * KIE-only deploy that has correctly dropped its Anthropic key would report degraded forever.
     *
     * `requirePlatformKey` already encodes "which key does this provider need" — the health report
     * must ask IT rather than keep a second, quietly diverging copy of that rule.
     */
    platformKey: hasPlatformKey(platform) ? 'ok' : 'degraded',
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

  /*
   * The sandbox runtime, reported ONLY when this build actually uses CodeSandbox (plan T13).
   *
   * `VITE_SANDBOX_PROVIDER` is a BUILD-time switch, so which sandbox a deploy needs is a fact about
   * the image, not about the environment — and a WebContainer build has correctly dropped
   * `CODESANDBOX_API_KEY`. Reporting `degraded` there would be the exact mirror-image mistake the
   * `platformKey` comment above describes: asking about a credential this deploy does not need, and
   * dragging `ready` to false forever on a perfectly healthy deploy that §9a keys on.
   *
   * 🔴 Config presence ONLY. No reachability probe — that is this endpoint's stated contract, and a
   * live call here would let a CodeSandbox outage flip the uptime monitor and start a retry storm.
   * Reachability lives in the rate windows (`sandbox-rates.ts`), where it belongs.
   */
  if (usesCodeSandbox()) {
    dependencies.codesandbox = isSandboxConfigured(context) ? 'ok' : 'degraded';
  }

  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dependencies,
    ready: Object.values(dependencies).every((d) => d === 'ok'),
  };
}

/**
 * Does THIS BUILD run on CodeSandbox?
 *
 * Read from `import.meta.env` rather than `env(context, …)` because it is a build-time switch — the
 * same source `app/lib/sandbox/index.ts` and `entry.server.tsx` read it from, so the ordinary case
 * agrees with the runtime that is actually loaded.
 *
 * ⚠️ The `|| process.env` arm can DISAGREE with that runtime: a container that sets the variable
 * without a matching build runs WebContainer while this reports a CodeSandbox dependency, and a
 * missing key there makes `ready` false on a deploy that is fine. That direction is chosen
 * deliberately — the mirror error is reporting `ready` on a CodeSandbox deploy with no key, which is
 * an outage §9a exists to catch. Pinned by a test, so it is a decision rather than an accident.
 */
function usesCodeSandbox(): boolean {
  /*
   * 🔴 The enabled-list check comes FIRST, because since 2026-07-31 a build cannot select CodeSandbox
   * at all (`ENABLED_SANDBOX_PROVIDERS`). Without it the `|| process.env` arm below stops being a
   * chosen risk and becomes a guaranteed lie: a stale deploy variable would make every health check
   * demand a credential for a runtime this image physically cannot load, dragging `ready` to false
   * forever on a healthy deploy — the exact §9a outage the comment above is careful to avoid.
   */
  if (!isSandboxProviderEnabled('codesandbox')) {
    return false;
  }

  return (
    import.meta.env?.VITE_SANDBOX_PROVIDER === 'codesandbox' || process.env.VITE_SANDBOX_PROVIDER === 'codesandbox'
  );
}

/** `PLAY_URL` is a URL string, not a flag — presence is what matters, so read it directly. */
function playUrlPresent(context: unknown): boolean {
  const value = (context as { cloudflare?: { env?: Record<string, string> } })?.cloudflare?.env?.PLAY_URL;
  return Boolean(value || process.env.PLAY_URL);
}
