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

export interface PlatformConfig {
  /** The platform Anthropic key. Server-only, always. */
  anthropicApiKey?: string;

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
export const PLATFORM_PROVIDER = 'Anthropic';

export function getPlatformConfig(context?: unknown): PlatformConfig {
  return {
    anthropicApiKey: env(context, 'ANTHROPIC_API_KEY'),
    proFeaturesEnabled: envFlag(context, 'PRO_FEATURES_ENABLED'),
    githubToken: env(context, 'GITHUB_API_KEY') || env(context, 'VITE_GITHUB_ACCESS_TOKEN'),
    adminToken: env(context, 'ADMIN_TOKEN'),
  };
}

/**
 * The platform key, or a descriptive 503. Credits mode NEVER falls back to a provider picker when
 * the key is missing — it reports a clear "not configured" state (§4.1).
 */
export function requirePlatformKey(config: PlatformConfig): string {
  if (!config.anthropicApiKey) {
    throw new NotConfiguredError(
      'The platform LLM key',
      'Set ANTHROPIC_API_KEY in the server environment (.env.local for local development).',
    );
  }

  return config.anthropicApiKey;
}
