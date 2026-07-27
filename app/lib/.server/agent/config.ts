/**
 * Platform configuration for the agent proxy (SPEC §3, §4.1, §4.2a, §4.6.1).
 *
 * ALL platform secrets are server-only and read here, never in a client bundle. Absent credentials
 * are a first-class, describable state — never a crash and never a silent fallback to some other
 * provider (§1.3 principle 0).
 */
import { DEFAULT_MODEL } from '~/utils/constants';
import { env, envFlag, NotConfiguredError } from '~/lib/.server/env';
import { getPremiumTier, kieDefaultModel, providerRates } from '~/lib/.server/billing/rates';

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
 * 🔴 **The accepted cost: no KIE Claude model returns thinking text** (adapter-wide since 2026-07-24;
 * re-confirmed for the current default `claude-opus-5` on 2026-07-27 — see `kie-wire.ts`). We pay full
 * output rate for reasoning we cannot show: measured ~27% of output and ~55s of the 205s on a
 * platformer creation. Chosen knowingly on 2026-07-17 as a `for now`; the §4.2a liveness heartbeat
 * carries the UX until KIE fixes their adapter.
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
 * The platform model. Never a USER choice (§4.2a) — but, since 2026-07-17, an OPERATOR one.
 *
 * ⚠️ This used to be a bare constant, with the comment "never an env var: a typo'd env value would 404
 * at the first generation". That reasoning was wrong, and the owner called it: **the answer to "a typo
 * would break it" is to VALIDATE the value, not to forbid the knob.** It is the same argument that
 * already applies to `LLM_PROVIDER`, which is env-driven and validated three lines down. Left as a
 * constant, moving to a different model — Fable 5, a new Opus — meant a code change and a redeploy for
 * something that is a pure operator decision, which is precisely what "config, never hardcoded" exists
 * to prevent.
 */
export const PLATFORM_MODEL = DEFAULT_MODEL;

/**
 * The model each provider serves by DEFAULT, when `LLM_MODEL` is unset.
 *
 * Per-provider because the right answer differs, and not for reasons of taste — MEASURED 2026-07-17:
 *
 * | KIE model | TTFT (3 trials)         | thinking text | 20k-word prompt |
 * |-----------|-------------------------|---------------|-----------------|
 * | opus-4-6  | 11648, 11294, 7970 ms   | 26ch          | 25213 ms        |
 * | opus-4-7  | 10076, 7665, 12406 ms   | 266ch ✅      | 11576 ms        |
 * | opus-4-8  | 3022, 2458, 2110 ms     | **0ch** ❌    | 3541 ms         |
 *
 * (Anthropic's own opus-4-8: 1022/985/944 ms TTFT — ~1s and rock-steady, with thinking text.)
 *
 * 🔴 **On KIE there is no free option.** Its only fast model is the one whose thinking text their
 * adapter cannot return; the two that CAN return it cost 8–12s of dead air before the first byte, and
 * 4-7 additionally hard-500s on non-streaming requests with large prompts. So KIE defaulted to 4-8:
 * dead air during thinking is at least bounded by how hard the model thought, whereas 4-6/4-7 charge
 * it up front on every single turn including trivial ones. Since 2026-07-24 the missing thinking text
 * is adapter-wide anyway (kie-wire.ts), so the table above is history rather than a live comparison.
 *
 * 2026-07-27: both defaults are `claude-opus-5` via `DEFAULT_MODEL` — same KIE price as 4-8 ($2/$10),
 * probe-verified honest cache accounting, thinking text still empty (the heartbeat carries the UX).
 */
export const PLATFORM_MODEL_BY_PROVIDER: Record<PlatformProviderName, string> = {
  Anthropic: DEFAULT_MODEL,
  KIE: DEFAULT_MODEL,
};

/**
 * The platform model — `LLM_MODEL`, validated, else the configured provider's default.
 *
 * ⚠️ **A model is only usable if we can BILL it.** Validation is against `PROVIDER_RATES`, not against
 * a list of names, because `ratesFor` falls back to the provider's most expensive row for a model it
 * does not know: an unpriced `LLM_MODEL` would bill every generation at some other model's price,
 * silently and forever. So "is this model configured?" and "do we know what it costs?" are the SAME
 * question, and this is the one place that asks it.
 *
 * That is what makes the knob safe, and it is the answer to the old "never an env var" rule: a typo, or
 * a real model we simply have no rates for, is a describable error at config time — not a 404 at the
 * first generation, and not a silent mis-bill.
 *
 * To move to a new model (Fable 5, a newer Opus): add its row to the provider's rate table, then set
 * `LLM_MODEL`. The rate row is a code change because a PRICE cannot be guessed — but it is one table
 * entry, not a rebuild of the billing path, and `SIGNUP_GRANT_CREDITS` should be re-checked against
 * `grantHeadroom()` afterwards since a cheaper model makes the grant go further.
 */
export function getPlatformModel(context?: unknown): string {
  const provider = getPlatformProvider(context);
  const model = env(context, 'LLM_MODEL')?.trim() || defaultModelFor(provider, context);
  const priced = providerRates(context)[provider] ?? {};

  if (!priced[model]) {
    throw new NotConfiguredError(
      `LLM_MODEL="${model}" on provider ${provider}`,
      `We have no rates for it, so we cannot bill it. ${
        provider === 'KIE'
          ? 'Add its row to the Marketplace price list (Settings → Admin → Marketplace prices) and promote, then set KIE_DEFAULT_MODEL or LLM_MODEL to it.'
          : 'Add it to MODEL_RATES in billing/rates.ts first.'
      } Priced models: ${Object.keys(priced).join(', ') || '(none)'}.`,
    );
  }

  return model;
}

/**
 * The PREMIUM model on the active provider — the higher-cost tier a user may opt into (§4.6.1).
 *
 * Validated against `providerRates` exactly like `getPlatformModel`, for the same reason: a model we
 * cannot price is a model we cannot bill. The premium row is injected into every provider's table by
 * `providerRates` (from `PREMIUM_*_DOLLARS`), so this validation is normally satisfied by construction —
 * it exists to catch the one real failure it cannot: a `PREMIUM_MODEL` the active provider cannot serve.
 *
 * The proxy calls this ONLY after `decidePremium` has authorized the choice; it is the model half of the
 * decision, kept beside `getPlatformModel` so all model resolution lives in one file.
 */
export function getPremiumModel(context?: unknown): string {
  const provider = getPlatformProvider(context);
  const { model } = getPremiumTier(context);
  const priced = providerRates(context)[provider] ?? {};

  if (!priced[model]) {
    throw new NotConfiguredError(
      `PREMIUM_MODEL="${model}" on provider ${provider}`,
      `We have no rates for it, so we cannot bill it. Set PREMIUM_INPUT_DOLLARS and PREMIUM_OUTPUT_DOLLARS. Priced models: ${
        Object.keys(priced).join(', ') || '(none)'
      }.`,
    );
  }

  return model;
}

/**
 * The provider's default model when `LLM_MODEL` is unset.
 *
 * ⚠️ **`LLM_MODEL` and `KIE_DEFAULT_MODEL` are not rivals, and the precedence is the point.**
 * `KIE_DEFAULT_MODEL` is a SELECTOR validated against the Marketplace price list (`kieDefaultModel` —
 * since 2026-07-18 the price side lives in the admin-promoted list, not in env vars). `LLM_MODEL`
 * picks a model across whichever provider is configured. So: `LLM_MODEL` > `KIE_DEFAULT_MODEL` >
 * baked default.
 *
 * That ordering is safe ONLY because the check above prices whatever wins. Setting `LLM_MODEL=x` while
 * `KIE_DEFAULT_MODEL=y` does NOT price `x` at `y`'s rates — `x` needs its own row or it is refused,
 * which is exactly what stops the two vars from quietly meaning "the model" and "the price of a
 * different model".
 */
function defaultModelFor(provider: PlatformProviderName, context?: unknown): string {
  if (provider === 'KIE') {
    const selected = kieDefaultModel(context);

    if (selected) {
      return selected;
    }
  }

  return PLATFORM_MODEL_BY_PROVIDER[provider];
}

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
