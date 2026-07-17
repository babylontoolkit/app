/**
 * Platform configuration for the agent proxy (SPEC §3, §4.1, §4.2a, §4.6.1).
 *
 * ALL platform secrets are server-only and read here, never in a client bundle. Absent credentials
 * are a first-class, describable state — never a crash and never a silent fallback to some other
 * provider (§1.3 principle 0).
 */
import { DEFAULT_MODEL } from '~/utils/constants';
import { env, envFlag, NotConfiguredError } from '~/lib/.server/env';

/** Re-exported: this was the original home of the error, and several routes import it from here. */
export { NotConfiguredError };

/**
 * The providers the PLATFORM can pay for. Both serve the same Claude models over the same
 * Anthropic-native Messages API — KIE (`providers/kie.ts`) is a discounted passthrough, not a
 * different model — so switching is a cost decision, never a capability or quality one.
 *
 * ⚠️ Adding a name here is not enough. A provider the platform BILLS for must also have a row in
 * `PROVIDER_RATES` (`billing/rates.ts`), or every generation on it prices at Anthropic list — which
 * over-bills the user and throws nothing. `billing.spec.ts` asserts the two lists agree.
 */
export const PLATFORM_PROVIDERS = ['Anthropic', 'KIE'] as const;
export type PlatformProviderName = (typeof PLATFORM_PROVIDERS)[number];

/**
 * KIE — the shipping default, with NO env file required (SPEC §4.2a).
 *
 * ⚠️ **Changing this is a money decision, not a preference.** Credits are cost-proportional, so the
 * provider's rates set what a credit BUYS — which means this value and `SIGNUP_GRANT_CREDITS` are one
 * decision in two files. `grantHeadroom()` + `billing.spec.ts` assert they agree; flip both or neither:
 *
 *   KIE       -> SIGNUP_GRANT_CREDITS 500   (a cold creation is ~192–248 credits; ~2.0–2.6x headroom)
 *   Anthropic -> SIGNUP_GRANT_CREDITS 1000  (a cold creation is ~481–579; 500 would go NEGATIVE)
 *
 * MEASURED on two live creations (2026-07-17): 248 credits / $0.7412 and 211 / $0.6292 on KIE, against
 * ~579 / ~$1.7314 and ~485 / ~$1.4515 for the same tokens on Anthropic — **~2.3x cheaper**. Verified
 * against KIE's OWN billing: their response carries `credits_consumed`, and at their published rate
 * (1 credit = $0.005) a real call billed 4.36 credits = $0.021800 while `rawCostUsd` computed
 * $0.021800 exactly. The ledger is provably correct against their charges, not merely self-consistent.
 *
 * 🔴 **The accepted cost: `claude-opus-4-8` returns NO thinking text on KIE** (their adapter does not
 * cover the one model they do not document — see `kie-wire.ts`). We pay full output rate for reasoning
 * we cannot show: measured ~27% of output and ~55s of the 205s on a platformer creation. Chosen
 * knowingly on 2026-07-17 as a `for now`.
 */
export const DEFAULT_PLATFORM_PROVIDER: PlatformProviderName = 'KIE';

export interface PlatformConfig {
  /** Who the platform buys tokens from. Never a user choice (§4.2a) — an operator config. */
  provider: PlatformProviderName;

  /** The platform Anthropic key. Server-only, always. */
  anthropicApiKey?: string;

  /** The platform KIE key. Server-only, always. Used only when `provider === 'KIE'`. */
  kieApiKey?: string;

  /**
   * The ONE switch that reveals Pro/BYOK UI — provider picker, model selector, key entry (§4.6.1).
   * Default false: the shipping product is credits-only, and none of that machinery renders for
   * anyone. Pro gates EXACTLY ONE thing: BYOK + model selection. Nothing else, ever.
   */
  proFeaturesEnabled: boolean;

  /** Optional — lifts GitHub's unauthenticated rate limit during doc/skill syncs. Never required. */
  githubToken?: string;

  /** Guards the admin refresh/activate endpoints. When unset, admin routes refuse to run. */
  adminToken?: string;
}

/**
 * The platform model. A config CONSTANT, never a user choice and never an env var (§4.2a): the value
 * must always match a `staticModels` entry, and a typo'd env value would 404 at the first generation.
 */
export const PLATFORM_MODEL = DEFAULT_MODEL;

/**
 * Which provider the platform buys tokens from — `LLM_PROVIDER`, validated.
 *
 * Unlike `PLATFORM_MODEL` this one IS an env var, because it is a pure cost decision an operator must
 * be able to make (or reverse, fast) without a deploy. That is only safe because it is validated here:
 * a typo'd `LLM_PROVIDER=Kei` throws a describable error at config time rather than 404ing at the first
 * generation, and — the point — it never silently falls back to a DIFFERENT provider than the one the
 * operator asked for. Falling back would mean spending on a key the operator did not choose and
 * billing users at rates for a provider we are not using (§1.3 principle 0).
 */
export function getPlatformProvider(context?: unknown): PlatformProviderName {
  const raw = env(context, 'LLM_PROVIDER')?.trim();

  if (!raw) {
    return DEFAULT_PLATFORM_PROVIDER;
  }

  const match = PLATFORM_PROVIDERS.find((name) => name.toLowerCase() === raw.toLowerCase());

  if (!match) {
    throw new NotConfiguredError(
      `LLM_PROVIDER="${raw}"`,
      `Not a platform provider. Supported: ${PLATFORM_PROVIDERS.join(', ')}.`,
    );
  }

  return match;
}

export function getPlatformConfig(context?: unknown): PlatformConfig {
  return {
    provider: getPlatformProvider(context),
    anthropicApiKey: env(context, 'ANTHROPIC_API_KEY'),
    kieApiKey: env(context, 'KIE_API_KEY'),
    proFeaturesEnabled: envFlag(context, 'PRO_FEATURES_ENABLED'),
    githubToken: env(context, 'GITHUB_API_KEY') || env(context, 'VITE_GITHUB_ACCESS_TOKEN'),
    adminToken: env(context, 'ADMIN_TOKEN'),
  };
}

/**
 * The platform key FOR THE CONFIGURED PROVIDER, or a descriptive 503. Credits mode NEVER falls back to
 * a provider picker when the key is missing — it reports a clear "not configured" state (§4.1).
 *
 * It also never falls back to the OTHER provider's key. `LLM_PROVIDER=KIE` with no `KIE_API_KEY` is a
 * misconfiguration to report, not a reason to quietly spend on the Anthropic key at 2.5x the price the
 * operator thought they were paying.
 */
export function requirePlatformKey(config: PlatformConfig): string {
  const key = platformKeyFor(config);

  if (!key) {
    throw new NotConfiguredError(
      `The platform LLM key for ${config.provider}`,
      `Set ${PLATFORM_KEY_ENV[config.provider]} in the server environment (.env.local for local development).`,
    );
  }

  return key;
}

/** Which env var holds each provider's platform key. The single source for "which key do I need". */
const PLATFORM_KEY_ENV: Record<PlatformProviderName, string> = {
  Anthropic: 'ANTHROPIC_API_KEY',
  KIE: 'KIE_API_KEY',
};

/** The configured provider's key, or undefined. Server-only — callers ACT on it, never emit it (§5). */
function platformKeyFor(config: PlatformConfig): string | undefined {
  return config.provider === 'KIE' ? config.kieApiKey : config.anthropicApiKey;
}

/**
 * Is the configured provider's key present? The BOOLEAN form of `requirePlatformKey` — "is a key
 * configured?" is a boolean, never the value (§5).
 *
 * It exists so the health report cannot keep its own copy of the which-key-does-this-provider-need
 * rule. It had one, hardcoded to Anthropic, and it reported a KIE deploy with no KIE key as healthy
 * AND ready — which is precisely the check §9a relies on to catch a missing credential.
 */
export function hasPlatformKey(config: PlatformConfig): boolean {
  return Boolean(platformKeyFor(config));
}
