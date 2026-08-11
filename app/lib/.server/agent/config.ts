/**
 * Platform configuration for the agent proxy (SPEC §3, §4.1, §4.2a, §4.6.1).
 *
 * ALL platform secrets are server-only and read here, never in a client bundle. Absent credentials
 * are a first-class, describable state — never a crash and never a silent fallback to some other
 * provider (§1.3 principle 0).
 */
import { DEFAULT_MODEL } from '~/utils/constants';
import { env, envFlag, NotConfiguredError } from '~/lib/.server/env';
import { getModelTier, kieDefaultModel, providerRates } from '~/lib/.server/billing/rates';
import {
  ENABLE_EXTENDED_MODELS_ENV_KEY,
  modelTierEnabled,
  extendedModelsEnabled,
} from '~/lib/.server/billing/premium-model-flag';
import { paidModelTierDefinition, type PaidModelTierId } from '~/lib/.server/billing/model-tiers';
import { providerUnhealthyUntil, selectPlatformProvider } from './provider-select';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('platform-config');

/** Re-exported: this was the original home of the error, and several routes import it from here. */
export { NotConfiguredError };

/**
 * The providers the PLATFORM can pay for. All three serve the same Claude models over the same
 * Anthropic-native Messages API — KIE (`providers/kie.ts`) and Comet (`providers/cometapi.ts`) are
 * passthrough gateways, not different models — so switching is a cost/reliability decision, never a
 * capability or quality one.
 *
 * ⚠️ Adding a name here is not enough. A provider the platform BILLS for must also have a row in
 * `PROVIDER_RATES` (`billing/rates.ts`), or every generation on it prices at Anthropic list — which
 * over-bills the user and throws nothing. `billing.spec.ts` asserts the two lists agree.
 *
 * ⚠️ **And it must be added to every `Record<PlatformProviderName, …>` in the codebase, which the
 * compiler will tell you about — but NOT to any `provider === 'X' ? … : …` ternary, which it will
 * not.** Those existed here (key selection, default model, two operator-guidance strings) and every
 * one of them fell to the Anthropic side for an unrecognised provider: a Comet deploy would have
 * asked for the Anthropic key and reported the wrong fix for a misconfigured model. They are records
 * and exhaustive switches now, deliberately, so a fourth provider is a compile error rather than a
 * silent wrong answer.
 */
export const PLATFORM_PROVIDERS = ['Anthropic', 'KIE', 'Comet'] as const;
export type PlatformProviderName = (typeof PLATFORM_PROVIDERS)[number];

/**
 * The providers that serve MEDIA renders (SPEC §4.16) — a strict subset of the platform providers.
 *
 * `Anthropic` is absent because Anthropic sells no image or video generation. That is a FACT about
 * the vendor, not a gap in our wiring, which is why `getMediaProvider` reports "not configured" on an
 * Anthropic deploy rather than silently borrowing another gateway's key: media would then be spent on
 * a provider the operator never chose, and priced from a list they never promoted.
 *
 * ⚠️ Declared here beside `PLATFORM_PROVIDERS` so the subset relation is visible in one place, and
 * asserted against both it and `MARKET_PRICE_PROVIDERS` in the specs — a media provider whose prices
 * nothing can promote is an unbillable render.
 */
export const MEDIA_PROVIDERS = ['KIE', 'Comet'] as const;
export type MediaProviderName = (typeof MEDIA_PROVIDERS)[number];

/**
 * KIE — the shipping default, with NO env file required (SPEC §4.2a).
 *
 * ⚠️ **Changing this is a money decision, not a preference.** Credits are cost-proportional, so the
 * provider's rates set what a credit BUYS — which means this value and `SIGNUP_GRANT_CREDITS` are one
 * decision in two files. `grantHeadroom()` + `billing.spec.ts` assert they agree; flip both or neither:
 *
 * Measured 2026-07-30 on what was THEN the default (`claude-opus-5`, margin 4.0, creation charge 100):
 *
 *   KIE       -> SIGNUP_GRANT_CREDITS 1000  (a cold build turn is ~231 credits; 3.90x headroom)
 *   Anthropic -> SIGNUP_GRANT_CREDITS 1000  (a cold build turn is ~576 credits; 1.56x headroom)
 *
 * The grant cleared the 1.5x floor on BOTH providers at those numbers, which the 800/150 pairing did
 * not: on Anthropic + Opus 5 it measured 1.13x. See `rates.ts` `signupGrantCredits` for the full table.
 *
 * ⚠️ **Those are OPUS 5 figures and the Standard rung moved to `claude-sonnet-5` on 2026-07-31.**
 * Sonnet is ~2.73x cheaper, so real headroom is now comfortably HIGHER than the rows above on both
 * providers — the floor is cleared by a wider margin, not a narrower one, which is why the grant was
 * not re-tuned with the model. `grantHeadroom()` computes it from the LIVE default, so the assertion
 * in `billing.spec.ts` is the authority here and this table is history. Re-run it before changing the
 * grant; do not read these two lines as current.
 *
 * MEASURED on two live creations (2026-07-17): 248 credits / $0.7412 and 211 / $0.6292 on KIE, against
 * ~579 / ~$1.7314 and ~485 / ~$1.4515 for the same tokens on Anthropic — **~2.3x cheaper**. Verified
 * against KIE's OWN billing: their response carries `credits_consumed`, and at their published rate
 * (1 credit = $0.005) a real call billed 4.36 credits = $0.021800 while `rawCostUsd` computed
 * $0.021800 exactly. The ledger is provably correct against their charges, not merely self-consistent.
 *
 * 🔴 **The accepted cost: no KIE Claude model returns thinking text** (adapter-wide since 2026-07-24;
 * re-confirmed for `claude-opus-5` on 2026-07-27 — see `kie-wire.ts`). We pay full
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

  /** The platform Comet key. Server-only, always. Used only when `provider === 'Comet'`. */
  cometApiKey?: string;

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
 * 2026-07-27: both defaults became `claude-opus-5` via `DEFAULT_MODEL` — same KIE price as 4-8
 * ($2/$10), probe-verified honest cache accounting, thinking text still empty (the heartbeat carries
 * the UX).
 *
 * 2026-07-31: both defaults are **`claude-sonnet-5`** — the Standard rung of the three-class ladder
 * (§4.6.1a), 2.73x cheaper on 62 real generations, with Opus 5 moved up to the Premium rung. It
 * carries a known vendor risk (KIE 500'd 77% of Sonnet 5 requests when it was measured on 2026-07-30,
 * which is why an earlier attempt was reverted); the owner shipped it on the strength of the
 * config-only revert `LLM_MODEL=claude-opus-5`. Full measurement in `utils/constants.ts`.
 */
export const PLATFORM_MODEL_BY_PROVIDER: Record<PlatformProviderName, string> = {
  Anthropic: DEFAULT_MODEL,
  KIE: DEFAULT_MODEL,
  Comet: DEFAULT_MODEL,
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
/**
 * How an operator makes an unpriced model billable, per provider.
 *
 * A RECORD, not a ternary. This was `provider === 'KIE' ? <marketplace> : <rates.ts>` in two places,
 * which is correct for exactly two providers and silently wrong for the third: a Comet operator
 * would have been told to edit `MODEL_RATES` in the source — a code change and a redeploy — for a
 * model whose price actually lives in a promotable list they could fix from the Admin panel in a
 * minute. Wrong advice in an error message is worse than none; it sends someone to change the wrong
 * file and the symptom does not move.
 */
const UNPRICED_MODEL_FIX: Record<PlatformProviderName, string> = {
  Anthropic: 'Add it to MODEL_RATES in billing/rates.ts first.',
  KIE: 'Add its row to the KIE Marketplace price list (Settings → Admin → Marketplace prices) and promote.',
  Comet: 'Add its row to the Comet Marketplace price list (Settings → Admin → Marketplace prices) and promote.',
};

export function getPlatformModel(context?: unknown, providerOverride?: PlatformProviderName): string {
  /*
   * ⚠️ `providerOverride` exists because `AUTO_MODEL_SELECT` broke the assumption this function was
   * written under — that "the provider" is a single env-derived fact any caller can re-derive. With
   * the ladder on, the gateway is chosen PER REQUEST, so a caller that already holds `config.provider`
   * must be able to say so; re-deriving here would validate the model against a DIFFERENT provider's
   * price table than the one about to serve and bill it. That is the `kieEnvModel` defect exactly
   * (two readers of one decision disagreeing), and it is why the proxy now passes it explicitly.
   */
  const provider = providerOverride ?? getPlatformProvider(context);
  const model = platformModelFor(provider, context);
  const priced = providerRates(context)[provider] ?? {};

  if (!priced[model]) {
    throw new NotConfiguredError(
      `LLM_MODEL="${model}" on provider ${provider}`,
      `We have no rates for it, so we cannot bill it. ${UNPRICED_MODEL_FIX[provider]} Then point ` +
        `LLM_MODEL at it. Priced models: ${Object.keys(priced).join(', ') || '(none)'}.`,
    );
  }

  return model;
}

/** The env var that picks a cheaper model for prompt enhancement. Named once, read once. */
export const ENHANCER_MODEL_ENV_KEY = 'ENHANCE_PROMPT_MODEL';

/**
 * The model that ENHANCES a prompt — `ENHANCE_PROMPT_MODEL`, validated, else the platform model.
 *
 * ## Why this is a separate knob at all
 *
 * Prompt enhancement is a small, fixed, self-contained utility: rewrite ≤10k characters of English
 * into better English, with no project files, no history, no tools and no cache prefix. It was
 * nonetheless running on whatever model builds the games, because the enhancer had exactly one
 * question to answer — "which model?" — and exactly one answer available. The rates make the size of
 * that mistake precise: on Anthropic, `claude-sonnet-5` is **3x** `claude-haiku-4-5` on BOTH input
 * ($3 vs $1) and output ($15 vs $5), so every enhancement was billing triple for a task that does not
 * use what the difference buys.
 *
 * It is deliberately NOT the same variable as `LLM_MODEL`. Enhancement quality and build quality are
 * different problems with different price sensitivities, and folding them into one setting means an
 * operator who wants a cheaper ✨ button has to make their games worse to get it.
 *
 * ## The rules it inherits, and the one it does not
 *
 * Validated against `providerRates` exactly like `getPlatformModel`, for exactly that reason: an
 * unpriced model falls through `ratesFor` to the provider's MOST EXPENSIVE row, so "is this model
 * configured?" and "do we know what it costs?" stay the same question. A typo here is a describable
 * 503 the first time someone presses ✨ — loud, immediate, free — never a silent mis-bill in the
 * direction the operator was trying to move away from.
 *
 * 🔴 **It is NOT gated by `ENABLE_EXTENDED_MODELS`, and that is deliberate (owner, 2026-08-08).**
 * That flag exists to stop users opting into the EXPENSIVE model class on the platform's credits
 * (§4.6.1a's Premium rung, `getTierModel`). This is the opposite motion in every respect: it
 * is an operator setting, not a user choice; it is not a rung on the ladder; and its whole purpose is
 * to spend LESS. Routing it through the tier machinery would mean a deploy that had switched the paid
 * class off — the cost-conscious deploy — was the one that could not have a cheap enhancer.
 *
 * Unset is the safe default: the platform model, i.e. exactly the behaviour that shipped before this
 * existed.
 */
export function getEnhancerModel(context?: unknown): string {
  const configured = env(context, ENHANCER_MODEL_ENV_KEY)?.trim();

  if (!configured) {
    return getPlatformModel(context);
  }

  const provider = getPlatformProvider(context);
  const priced = providerRates(context)[provider] ?? {};

  if (!priced[configured]) {
    throw new NotConfiguredError(
      `${ENHANCER_MODEL_ENV_KEY}="${configured}" on provider ${provider}`,
      `We have no rates for it, so we cannot bill it. ${UNPRICED_MODEL_FIX[provider]} ` +
        `Priced models: ${Object.keys(priced).join(', ') || '(none)'}. ` +
        `Unset ${ENHANCER_MODEL_ENV_KEY} to enhance with the platform model.`,
    );
  }

  return configured;
}

/**
 * A PAID RUNG's model on the active provider — the higher-cost tiers a user may opt into (§4.6.1a).
 *
 * Validated against `providerRates` exactly like `getPlatformModel`, for the same reason: a model we
 * cannot price is a model we cannot bill. Each rung's row is injected into every provider's table by
 * `providerRates` (from the ACTIVE Marketplace price list), so this validation is normally satisfied by
 * construction — it exists to catch the one real failure it cannot: a rung's selector naming a model the
 * active provider cannot serve.
 *
 * The proxy calls this ONLY after `decideModelTier` has authorized the choice; it is the model half of
 * the decision, kept beside `getPlatformModel` so all model resolution lives in one file.
 */
export function getTierModel(id: PaidModelTierId, context?: unknown, providerOverride?: PlatformProviderName): string {
  /*
   * 🔴 The SECOND wall behind `ENABLE_EXTENDED_MODELS` (§4.5.3's pattern applied to a money path).
   * `getModelTiers` already drops the paid rung from the ladder, so `decideModelTier` cannot authorize
   * it and this is unreachable today — which is exactly why it is here. The first wall is a filter on a
   * list, and a future caller that assembles its own ladder, or resolves a model before the decision,
   * would sail past it and bill an expensive model on a deploy that switched it off.
   *
   * It THROWS rather than degrading to the standard model: nothing should be asking, so an answer would
   * be a wrong answer given quietly. `NotConfiguredError` names the flag, because an operator seeing
   * this has one thing to change and it is not the selector.
   */
  if (!extendedModelsEnabled(context)) {
    throw new NotConfiguredError(
      `the ${id} model tier while ${ENABLE_EXTENDED_MODELS_ENV_KEY} is not "true"`,
      `This deploy serves the standard model only. Set ${ENABLE_EXTENDED_MODELS_ENV_KEY}=true to offer ` +
        'the paid classes again.',
    );
  }

  const definition = paidModelTierDefinition(id);

  /*
   * 🔴 The per-rung flag needs its OWN wall here, not just the master switch above.
   * `modelTierEnabled` is the same conjunction `getModelTiers` filters on, so the two walls cannot
   * disagree about whether a rung is offered — and it names the rung's own key, because an operator
   * who withdrew Platinum and is being told to set `ENABLE_EXTENDED_MODELS` would go and re-enable the
   * wrong thing. The ladder's length has changed three times; a hardcoded flag name is how the walls
   * drift apart.
   */
  if (!modelTierEnabled(definition, context)) {
    throw new NotConfiguredError(
      `the ${id} model tier while ${definition.enabledEnvKey} is not "true"`,
      `This deploy has withdrawn the ${definition.label} class. Set ${definition.enabledEnvKey}=true ` +
        'to offer it again.',
    );
  }

  /*
   * ⚠️ Same reason `getPlatformModel` takes one: under `AUTO_MODEL_SELECT` the gateway is chosen per
   * request, so re-deriving it here would ask a DIFFERENT provider's price table than the one about to
   * serve and bill this rung. Two readers of one decision, on the most expensive rung in the product.
   *
   * ⚠️ **Be honest about how much this actually buys, because it is less than it looks.** For an
   * ENABLED rung the check below cannot fail on any provider: `providerRates` gap-fills every enabled
   * rung's model into every provider's table (`rates.ts` `withTiers`), so the lookup succeeds
   * everywhere by construction — and the rung then settles at the MARKETPLACE rate on a gateway that
   * may not price it natively. That is a pre-existing property of tier injection, flagged in full at
   * `withTiers`, not something the override can fix; gating on native pricing was considered and
   * rejected there because it would drop Anthropic out of the ladder for an ordinary rung selector.
   * What the override does buy is that a DISABLED or genuinely unpriceable rung is judged against the
   * gateway that would run it, and that this call site stops silently disagreeing with `config.provider`
   * — a correctness floor, not a wall.
   */
  const provider = providerOverride ?? getPlatformProvider(context);
  const { model, label } = getModelTier(id, context);
  const { modelEnvKey } = definition;
  const priced = providerRates(context)[provider] ?? {};

  if (!priced[model]) {
    /*
     * ⚠️ This message used to say "Set PREMIUM_INPUT_DOLLARS and PREMIUM_OUTPUT_DOLLARS" — vars that
     * have been RETIRED and are refused at config time since 2026-07-18. An error that instructs the
     * operator to set a variable the platform will reject is worse than no error at all, and it
     * survived because nothing tests the text of a failure path. Prices live in the Admin panel.
     *
     * It names the rung's OWN env key rather than a hardcoded `PREMIUM_MODEL`, because the ladder is a
     * LIST whose length has changed twice, and the wrong variable name sends an operator to fix a
     * setting that was never broken.
     */
    throw new NotConfiguredError(
      `${modelEnvKey}="${model}" (the ${label} tier) on provider ${provider}`,
      'We have no rates for it, so we cannot bill it. Add its row (input + output USD per million tokens) ' +
        `in Settings → Admin → Marketplace prices, then promote. Priced models on ${provider}: ${
          Object.keys(priced).join(', ') || '(none)'
        }.`,
    );
  }

  return model;
}

/** @deprecated Use `getTierModel('premium', …)`. One implementation, so the rungs cannot drift. */
export function getPremiumModel(context?: unknown): string {
  return getTierModel('premium', context);
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
  switch (provider) {
    case 'KIE': {
      const selected = kieDefaultModel(context);

      return selected || PLATFORM_MODEL_BY_PROVIDER.KIE;
    }

    /*
     * ⚠️ **Comet has NO second selector, deliberately — `LLM_MODEL` is its only knob.**
     *
     * `KIE_DEFAULT_MODEL` above exists for historical reasons and costs a precedence rule that two
     * separate readers (`kieEnvModel` and this function) must agree on; they once did not, and a
     * model set via `LLM_MODEL` never reached the provider's model list while settlement charged it
     * anyway. One variable has no precedence to get wrong. `comet-wire.ts`'s `cometEnvModel` reads
     * `LLM_MODEL` and nothing else, which is what keeps these two readers in agreement BY
     * CONSTRUCTION rather than by a rule someone has to remember.
     */
    case 'Anthropic':
    case 'Comet':
      return PLATFORM_MODEL_BY_PROVIDER[provider];

    default: {
      /* An exhaustive switch, so a fourth provider is a compile error rather than a silent default. */
      const exhaustive: never = provider;
      void exhaustive;

      return DEFAULT_MODEL;
    }
  }
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

/**
 * Which model a given provider would run — `LLM_MODEL` if set, else that provider's default.
 *
 * Extracted so `getPlatformModel` (which validates and throws) and the auto-select ladder (which must
 * QUIETLY skip a rung it cannot price) ask the same question. Two spellings of "which model would
 * provider P run" is how a ladder ends up skipping a healthy provider, or worse, keeping one whose
 * model bills through `ratesFor`'s most-expensive fallback.
 */
function platformModelFor(provider: PlatformProviderName, context?: unknown): string {
  return env(context, 'LLM_MODEL')?.trim() || defaultModelFor(provider, context);
}

/** The flag that turns the ladder on. OFF by default — see `provider-select.ts` for why. */
export const AUTO_MODEL_SELECT_ENV_KEY = 'AUTO_MODEL_SELECT';

/** The preference order, best rate first. Comma-separated provider names. */
export const LLM_PROVIDER_CHAIN_ENV_KEY = 'LLM_PROVIDER_CHAIN';

/**
 * The default ladder — cheapest gateway first, full price last (owner decision, 2026-08-10).
 *
 * Credits are cost-proportional, so this order is not a preference about vendors: it is how much a
 * user's pack buys. Anthropic is last because it is the only rung that is never a discount, and it is
 * PRESENT because "every gateway is down" must degrade to an expensive turn, not to no product.
 */
export const DEFAULT_PROVIDER_CHAIN: PlatformProviderName[] = ['KIE', 'Comet', 'Anthropic'];

/**
 * `LLM_PROVIDER_CHAIN`, validated — same posture as `LLM_PROVIDER`.
 *
 * A typo THROWS rather than being skipped. Skipping would silently shorten the ladder, and a ladder is
 * exactly the kind of thing whose absence looks like normal operation: the platform would keep serving
 * turns from the next rung down and the operator would never learn their cheapest gateway was spelled
 * wrong. Empty entries are ignored (a trailing comma is a typo with no consequence); duplicates are
 * collapsed to first-seen, so a chain cannot make one rung eligible twice.
 */
export function getProviderChain(context?: unknown): PlatformProviderName[] {
  const raw = env(context, LLM_PROVIDER_CHAIN_ENV_KEY)?.trim();

  if (!raw) {
    return DEFAULT_PROVIDER_CHAIN;
  }

  const seen: PlatformProviderName[] = [];

  for (const piece of raw.split(',')) {
    const name = piece.trim();

    if (!name) {
      continue;
    }

    const match = PLATFORM_PROVIDERS.find((p) => p.toLowerCase() === name.toLowerCase());

    if (!match) {
      throw new NotConfiguredError(
        `${LLM_PROVIDER_CHAIN_ENV_KEY} contains "${name}"`,
        `Not a platform provider. Supported: ${PLATFORM_PROVIDERS.join(', ')}.`,
      );
    }

    if (!seen.includes(match)) {
      seen.push(match);
    }
  }

  return seen.length > 0 ? seen : DEFAULT_PROVIDER_CHAIN;
}

/**
 * WHICH GATEWAY SERVES THIS REQUEST — the `AUTO_MODEL_SELECT` branch (§4.2a).
 *
 * With the flag off this is `getPlatformProvider` and nothing else, byte for byte: the ladder cannot
 * change a single generation until an operator opts in.
 *
 * With it on, `selectPlatformProvider` picks once, here, from the chain. "Once, here" is the whole
 * safety argument — `getPlatformConfig` is called ONE time per generation in `proxy.ts` and the
 * resulting `config.provider` flows to both the wire AND `settleGeneration`, so the gateway that
 * spent the tokens is by construction the gateway whose rates bill them. A second resolution anywhere
 * later in the request could disagree, and a turn served by A and billed at B's rates is a mis-bill
 * with no honest correction available.
 *
 * ⚠️ The `canPrice` gate asks about the model this PROVIDER would run, not "the platform model" —
 * with `LLM_MODEL` unset the two rungs can legitimately differ, and `ratesFor` bills an unpriced model
 * at the provider's most expensive row. Skipping an unpriceable rung is therefore not fussiness: it is
 * the difference between failing over to a discount and failing over to the biggest bill we can write.
 */
export function resolvePlatformProvider(context?: unknown, nowMs: number = Date.now()): PlatformProviderName {
  const fixed = getPlatformProvider(context);

  if (!envFlag(context, AUTO_MODEL_SELECT_ENV_KEY)) {
    return fixed;
  }

  /*
   * 🔴 THE LADDER MAY NEVER BE A NEW WAY FOR THE APP TO GO DOWN (found 2026-08-10, before shipping).
   *
   * `getPlatformConfig` is called by `/api/me` — the session endpoint on EVERY page load — and by the
   * health check. The two things this branch consults both throw by design: `providerRates` reads the
   * active price lists, which refuse loudly when a retired price variable is still set, and
   * `getProviderChain` refuses a typo'd provider name. Unguarded, either one turned "an operator left
   * a stale env var behind" into a 503 for every user, which is precisely the 2026-07-25
   * `modelTiersSessionHint` lesson arriving through a new door: a misconfigured provider must degrade
   * a capability, never take down the page that reports it. Caught live by
   * `session-payload.spec.ts`, which asserts exactly that — 200 with the rungs locked.
   *
   * Degrading means "behave as if the flag were off": `getPlatformProvider` consults no prices at all,
   * so the fallback is the same code path the platform runs today with `AUTO_MODEL_SELECT` unset. The
   * cost of the failure is therefore a turn that did not get a discount, not a turn that mis-bills.
   *
   * ⚠️ `logger.error`, not `warn` or a swallow. A silently-inert ladder is the `cache-warmer` failure
   * — present, tested, green and doing nothing for months — and the whole point of a typo'd chain
   * throwing inside `getProviderChain` is that somebody finds out.
   */
  try {
    const rates = providerRates(context);

    const selection = selectPlatformProvider({
      chain: getProviderChain(context),
      fixed,
      isConfigured: (provider) => Boolean(env(context, platformKeyEnvFor(provider))?.trim()),
      canPrice: (provider) => Boolean(rates[provider]?.[platformModelFor(provider, context)]),
      unhealthyUntilMs: providerUnhealthyUntil,
      nowMs,
    });

    /*
     * Worded without "this request" on purpose: `getPlatformConfig` is also called by `/api/me` and the
     * health check, neither of which serves a generation, so a line claiming traffic MOVED would have
     * an operator reading a page load as a failover. It reports a CHOICE, which is true wherever it is
     * made.
     */
    if (selection.switched) {
      logger.info(`AUTO_MODEL_SELECT chose ${selection.provider} over LLM_PROVIDER=${fixed} (${selection.reason})`);
    }

    return selection.provider;
  } catch (error) {
    logger.error(
      `AUTO_MODEL_SELECT could not choose a gateway and is INERT for this request — falling back to ` +
        `LLM_PROVIDER=${fixed}. Check ${LLM_PROVIDER_CHAIN_ENV_KEY} and the Marketplace price lists: ` +
        `${(error as Error).message}`,
    );

    return fixed;
  }
}

/**
 * Every gateway whose prices must be LOADED before a provider can be chosen or a turn settled.
 *
 * 🔴 The ladder's `canPrice` gate and settlement's `ratesFor` both read the marketplace lists
 * SYNCHRONOUSLY, and those lists are populated by an async `ensureMarketPrices` at the proxy doorway.
 * That doorway used to ensure prices for `LLM_PROVIDER` alone — correct while the provider was fixed,
 * and silently wrong the moment auto-select could pick a different one: the selected gateway would be
 * gated and BILLED from its BAKED table, with the operator's promoted list ignored and nothing
 * throwing. That is verbatim the failure `marketPriceProvidersFor`'s own doc comment warns about.
 *
 * Ensuring the whole chain is a handful of cached reads at a doorway that already awaits several, and
 * it keeps the ordering honest: prices first, THEN the choice that depends on them.
 *
 * With the flag off this is `[LLM_PROVIDER]` — exactly what the doorway did before.
 */
export function providersToPrice(context?: unknown): PlatformProviderName[] {
  const fixed = getPlatformProvider(context);

  if (!envFlag(context, AUTO_MODEL_SELECT_ENV_KEY)) {
    return [fixed];
  }

  try {
    const chain = getProviderChain(context);

    return chain.includes(fixed) ? chain : [...chain, fixed];
  } catch {
    /* A typo'd chain degrades to the fixed provider here too — `resolvePlatformProvider` logs it. */
    return [fixed];
  }
}

export function getPlatformConfig(context?: unknown): PlatformConfig {
  return {
    provider: resolvePlatformProvider(context),
    anthropicApiKey: env(context, 'ANTHROPIC_API_KEY'),
    kieApiKey: env(context, 'KIE_API_KEY'),
    cometApiKey: env(context, 'COMET_API_KEY'),
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

/**
 * Which env var holds a provider's platform key — the SINGLE source for "which key do I need".
 *
 * Exported as a function rather than the table so callers cannot hold their own copy: `cache-warmer.ts`
 * had one, spelled `provider === 'KIE' ? 'KIE_API_KEY' : 'ANTHROPIC_API_KEY'`, which read the wrong
 * variable for any provider it had not heard of.
 */
export function platformKeyEnvFor(provider: PlatformProviderName): string {
  return PLATFORM_KEY_ENV[provider];
}

/** Which env var holds each provider's platform key. The single source for "which key do I need". */
const PLATFORM_KEY_ENV: Record<PlatformProviderName, string> = {
  Anthropic: 'ANTHROPIC_API_KEY',
  KIE: 'KIE_API_KEY',
  Comet: 'COMET_API_KEY',
};

/**
 * The configured provider's key, or undefined. Server-only — callers ACT on it, never emit it (§5).
 *
 * 🔴 A RECORD, not `provider === 'KIE' ? kie : anthropic`. That ternary was correct for exactly two
 * providers and silently wrong for the third: a Comet deploy would have resolved the ANTHROPIC key
 * — so a box with both keys set would have spent the Anthropic one at ~2.3x the price the operator
 * chose, and a box with only `COMET_API_KEY` would have reported "the platform LLM key for Comet
 * is not configured" while holding it. Neither throws anything a reader could trace back to here.
 *
 * `PLATFORM_KEY_ENV` already had to be exhaustive; this is the same fact and now has the same shape,
 * so the two cannot disagree about which key a provider needs.
 */
function platformKeyFor(config: PlatformConfig): string | undefined {
  const keys: Record<PlatformProviderName, string | undefined> = {
    Anthropic: config.anthropicApiKey,
    KIE: config.kieApiKey,
    Comet: config.cometApiKey,
  };

  return keys[config.provider];
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

/*
 * ------------------------------------------------------------------------------------------------ *
 * Media (SPEC §4.16) — its OWN provider switch
 * ------------------------------------------------------------------------------------------------
 */

/** Which env var holds each media gateway's key. The same key the LLM side uses — one key, one bill. */
const MEDIA_KEY_ENV: Record<MediaProviderName, string> = {
  KIE: 'KIE_API_KEY',
  Comet: 'COMET_API_KEY',
};

/** Which env var a media provider's key comes from — a NAME, never the value (§5). */
export function mediaKeyEnvFor(provider: MediaProviderName): string {
  return MEDIA_KEY_ENV[provider];
}

/**
 * Who serves renders — `MEDIA_PROVIDER`, else the LLM provider.
 *
 * 🔴 **A SEPARATE SWITCH ON PURPOSE.** Media is a different money path from a generation: an exact
 * price debited before any spend, its own refund machinery, its own price rows. Tying it to
 * `LLM_PROVIDER` would mean a text cutover silently moves every render to a gateway whose media
 * surface has not been driven — so the two can be flipped together (the default) or separately (set
 * this), and "should media move in the same cutover?" becomes a config answer instead of a
 * code change.
 *
 * `null` means the platform serves no media: `LLM_PROVIDER=Anthropic` with nothing overriding it,
 * because Anthropic sells no renders. Callers report that as "not configured" (a describable state
 * the Media panel and the agent tool gate on), never as a silent no-op.
 */
export function getMediaProvider(context?: unknown): MediaProviderName | null {
  const raw = env(context, 'MEDIA_PROVIDER')?.trim();

  if (raw) {
    const match = MEDIA_PROVIDERS.find((name) => name.toLowerCase() === raw.toLowerCase());

    if (!match) {
      /*
       * Validated like `LLM_PROVIDER`, and for the same reason: a typo must be a describable error
       * at config time, never a quiet fall-through to a provider the operator did not choose.
       */
      throw new NotConfiguredError(
        `MEDIA_PROVIDER="${raw}"`,
        `Not a media provider. Supported: ${MEDIA_PROVIDERS.join(', ')}.`,
      );
    }

    return match;
  }

  const platform = getPlatformProvider(context);

  return MEDIA_PROVIDERS.find((name) => name === platform) ?? null;
}

/** A media gateway's platform key, whichever gateway is asked for — never only the configured one. */
export function mediaKeyFor(provider: MediaProviderName, context?: unknown): string | undefined {
  return env(context, MEDIA_KEY_ENV[provider]);
}

export interface MediaConfig {
  provider: MediaProviderName;
  apiKey: string;

  /** The gateway's origin override, when the operator set one. Same variable the LLM wire reads. */
  baseUrl?: string;
}

/**
 * The media provider and its key, or `null` when media cannot be served here.
 *
 * ⚠️ Returns `null` for BOTH "no media provider" and "no key for it" — the two are one fact to every
 * caller (the tool gate, the panel, the route's 503), and splitting them would invite a caller to
 * treat a keyless provider as usable.
 */
export function getMediaConfig(context?: unknown): MediaConfig | null {
  const provider = getMediaProvider(context);

  if (!provider) {
    return null;
  }

  const apiKey = mediaKeyFor(provider, context);

  return apiKey ? { provider, apiKey, baseUrl: mediaBaseUrlFor(provider, context) } : null;
}

/**
 * A gateway's origin override for MEDIA, if it has one.
 *
 * **Comet:** `COMET_BASE_URL`, the same variable its LLM wire reads. That file states the rule — the
 * override repoints EVERY family because Comet serves all of them from one origin — so an operator
 * who sets it means renders too. Honouring it for text and ignoring it for media would be the
 * two-readers-of-one-variable drift this repo has been bitten by, failing silently (renders simply go
 * somewhere else).
 *
 * **KIE: `undefined`, deliberately.** `KIE_BASE_URL` is documented as CLAUDE-SCOPED — it moves that
 * one LLM adapter, not the whole account — and `KieMediaProvider` has no base-URL concept at all: its
 * media host is a fixed constant. Returning `KIE_BASE_URL` here would have been a value computed at
 * four call sites and discarded, under a comment claiming both kinds of spend were covered. That is
 * the `PENDING_RENDER_TTL_MS` class, and it is not reintroduced here just to look symmetric.
 */
export function mediaBaseUrlFor(provider: MediaProviderName, context?: unknown): string | undefined {
  return provider === 'Comet' ? env(context, 'COMET_BASE_URL') : undefined;
}

/**
 * The key for a media provider, or a describable 503.
 *
 * 🔴 Takes the provider as an ARGUMENT rather than reading the configured one, because its most
 * important caller is the POLL path, which must ask about the gateway the task was CREATED on. An
 * operator flipping `MEDIA_PROVIDER` mid-render must not strand the renders already in flight.
 */
export function requireMediaKey(provider: MediaProviderName, context?: unknown): string {
  const apiKey = mediaKeyFor(provider, context);

  if (!apiKey) {
    throw new NotConfiguredError(
      `The media key for ${provider}`,
      `Set ${MEDIA_KEY_ENV[provider]} in the server environment — image/video generation uses the ` +
        `platform ${provider} key.`,
    );
  }

  return apiKey;
}
