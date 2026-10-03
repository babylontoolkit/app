/**
 * Platform configuration for the agent proxy (SPEC §3, §4.1, §4.2a, §4.6.1).
 *
 * ALL platform secrets are server-only and read here, never in a client bundle. Absent credentials
 * are a first-class, describable state — never a crash and never a silent fallback to some other
 * provider (§1.3 principle 0).
 */
import { DEFAULT_MODEL } from '~/utils/constants';
import { env, envFlag, NotConfiguredError } from '~/lib/.server/env';
import { getModelTier, nativeProviderRates, providerRates } from '~/lib/.server/billing/rates';
import {
  ENABLE_EXTENDED_MODELS_ENV_KEY,
  modelTierEnabled,
  extendedModelsEnabled,
} from '~/lib/.server/billing/premium-model-flag';
import { PAID_MODEL_TIERS, paidModelTierDefinition, type PaidModelTierId } from '~/lib/.server/billing/model-tiers';
import { providerUnhealthyUntil, selectPlatformProvider } from './provider-select';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('platform-config');

/** Re-exported: this was the original home of the error, and several routes import it from here. */
export { NotConfiguredError };

/**
 * The providers the PLATFORM buys LLM tokens from — 🔴 ANTHROPIC ONLY since 2026-10-03 (owner,
 * `_specs/anthropic-only_plan.md` D3: *"Anthropic Managed Agent SHOULD be the Only LLM_PROVIDER PATH and KIE
 * and FAL should be the only media paths.. period"*). KIE was an LLM gateway until then and is a MEDIA
 * provider only now. Every turn runs on Anthropic Managed Agents.
 *
 * ⚠️ Adding a name here is not enough. A provider the platform BILLS for must also have a row in
 * `PROVIDER_RATES` (`billing/rates.ts`), or every generation on it prices at Anthropic list — which
 * over-bills the user and throws nothing. `billing.spec.ts` asserts the two lists agree.
 *
 * ⚠️ **And it must be added to every `Record<PlatformProviderName, …>` in the codebase, which the
 * compiler will tell you about — but NOT to any `provider === 'X' ? … : …` ternary, which it will
 * not.** Those existed here (key selection, default model, two operator-guidance strings) and every
 * one of them fell to the Anthropic side for an unrecognised provider. They are records and exhaustive
 * switches now, deliberately, so a new provider is a compile error rather than a silent wrong answer.
 */
export const PLATFORM_PROVIDERS = ['Anthropic'] as const;
export type PlatformProviderName = (typeof PLATFORM_PROVIDERS)[number];

/**
 * The providers that serve MEDIA renders (SPEC §4.16).
 *
 * Every one of them is EITHER a platform provider (KIE — one vendor, one key, both kinds of spend)
 * OR listed in `MEDIA_ONLY_PROVIDERS` (KIE and fal.ai since 2026-10-03 — neither serves the LLM). That is the
 * relation the specs assert; it replaced "a strict subset of the platform providers" when fal joined
 * (`_specs/media-gateways_plan.md` T3), because adding fal to `PLATFORM_PROVIDERS` would have offered
 * a gateway with no text model to the LLM ladder.
 *
 * `Anthropic` is absent because Anthropic sells no image or video generation. That is a FACT about
 * the vendor, not a gap in our wiring, which is why `getMediaProvider` reports "not configured" on an
 * Anthropic deploy rather than silently borrowing another gateway's key: media would then be spent on
 * a provider the operator never chose, and priced from a list they never promoted.
 *
 * ⚠️ Declared here beside `PLATFORM_PROVIDERS` so the relation is visible in one place, and asserted
 * against both it and `MARKET_PRICE_PROVIDERS` in the specs — a media provider whose prices nothing
 * can promote is an unbillable render.
 */
export const MEDIA_PROVIDERS = ['KIE', 'FAL'] as const;

/**
 * Gateways that USED to render media. Comet was removed from media on 2026-10-01 (a security issue) and
 * from the platform entirely on 2026-10-03 (`_specs/anthropic-only_plan.md` D5). It survives ONLY here, so
 * `MEDIA_PROVIDER=Comet` is refused by name and a task record it stamped before the removal is failed and
 * REFUNDED on its next poll without contacting anyone (`media/provider.ts`) — dropping it would strand a debit.
 */
export const RETIRED_MEDIA_PROVIDERS = ['Comet'] as const;
export type RetiredMediaProviderName = (typeof RETIRED_MEDIA_PROVIDERS)[number];

/**
 * Media gateways that are NOT platform (LLM) providers. `MEDIA_PROVIDER=FAL` is the only way to select
 * one — `getMediaProvider`'s fallback to the LLM provider can never land on it, by construction.
 */
/* KIE joined 2026-10-03: it is no longer an LLM provider (`_specs/anthropic-only_plan.md` D3). */
export const MEDIA_ONLY_PROVIDERS = ['KIE', 'FAL'] as const;
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
export const DEFAULT_PLATFORM_PROVIDER: PlatformProviderName = 'Anthropic';

export interface PlatformConfig {
  /** Who the platform buys tokens from. Never a user choice (§4.2a) — an operator config. */
  provider: PlatformProviderName;

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
 * To move to a new model: add its price row in Settings → Admin → Marketplace prices (every provider,
 * Anthropic included since 2026-09-29), promote, then set `LLM_MODEL`. NO code change — a price cannot
 * be guessed, but it is the operator's to state, not the source's. `SIGNUP_GRANT_CREDITS` should be
 * re-checked against `grantHeadroom()` afterwards, since a cheaper model makes the grant go further.
 */
/**
 * How an operator makes an unpriced model billable, per provider.
 *
 * A RECORD, not a ternary. This was `provider === 'KIE' ? <marketplace> : <rates.ts>` in two places,
 * which was correct for exactly two providers and silently wrong for any other. Wrong advice in an error
 * message is worse than none; it sends someone to change the wrong file and the symptom does not move.
 */
const UNPRICED_MODEL_FIX: Record<PlatformProviderName, string> = {
  Anthropic: 'Add its row to the Anthropic price list (Settings → Admin → Marketplace prices) and promote.',
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

/**
 * The env var that picks a cheaper model for prompt enhancement, applied to EVERY provider.
 *
 * The cross-provider default. `enhancerModelEnvKeyFor` below outranks it per gateway.
 */
export const ENHANCER_MODEL_ENV_KEY = 'ENHANCE_PROMPT_MODEL';

/**
 * The PER-GATEWAY enhancer selector — `ANTHROPIC_ENHANCE_PROMPT_MODEL` (owner, 2026-08-11). It outranks the
 * cross-provider `ENHANCE_PROMPT_MODEL`. It existed because one model can carry different ids on different
 * gateways; Anthropic is the only LLM gateway since 2026-10-03, so it is now simply the more specific of
 * the two names. Derived from `PLATFORM_PROVIDERS` so the key cannot drift from the list.
 */
export function enhancerModelEnvKeyFor(provider: PlatformProviderName): string {
  return `${provider.toUpperCase()}_${ENHANCER_MODEL_ENV_KEY}`;
}

/**
 * The model that ENHANCES a prompt — `ENHANCE_PROMPT_MODEL`, validated, else the platform model.
 *
 * ## Why this is a separate knob at all
 *
 * Prompt enhancement is a small, fixed, self-contained utility: rewrite ≤10k characters of English
 * into better English, with no project files, no history, no tools and no cache prefix. It was
 * nonetheless running on whatever model builds the games, because the enhancer had exactly one
 * question to answer — "which model?" — and exactly one answer available. The rates make the size of
 * that available saving precise: on Anthropic, `claude-sonnet-5` is **3x** `claude-haiku-4-5` on BOTH
 * input ($3 vs $1) and output ($15 vs $5).
 *
 * ⚠️ **The SHIPPED DEFAULT is `claude-sonnet-5` — the knob exists, and the owner has deliberately not
 * spent it (2026-08-11).** This paragraph argued the cheap-model case as though it described what we
 * ship, which stopped being true the moment the default changed. The reasoning for the default:
 * an enhanced prompt is the INPUT to the most expensive turn in the product, so a worse rewrite is
 * not saved money — it is a worse game built at full price. Sonnet 5 also supports adaptive thinking
 * and `claude-haiku-4-5` does not (probed: `400 adaptive thinking is not supported on this model`),
 * so the cheap rung is also the one that thinks least about the rewrite.
 *
 * The saving is still one variable away, and the arithmetic above is still the arithmetic.
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
export function getEnhancerModel(context?: unknown, providerOverride?: PlatformProviderName): string {
  /*
   * 🔴 THE SELECTED GATEWAY, NOT `LLM_PROVIDER`.
   *
   * This read `getPlatformProvider` — the `kieEnvModel` two-readers class, still live in this one
   * function after the ladder shipped. With `AUTO_MODEL_SELECT` on it validated the model against
   * `LLM_PROVIDER`'s price table while the request could run somewhere else, so an operator whose
   * generations had laddered onto a healthy gateway kept enhancing against the configured one's
   * catalogue. The caller passes the provider it is actually going to use; absent that we resolve the
   * ladder ourselves rather than falling back to the configured name.
   */
  const provider = providerOverride ?? resolvePlatformProvider(context);

  /*
   * PER-GATEWAY FIRST, then the cross-provider default, then that gateway's platform model — the same
   * shape as `platformModelFor`, for the same reason: one question, one precedence chain.
   *
   * ⚠️ The bare `ENHANCE_PROMPT_MODEL` deliberately still WORKS and is still REFUSED when the selected
   * gateway cannot price it. Making it a silent no-op on a gateway that does not serve it would be the
   * costly direction — the operator asked for a cheap model and would get the platform model at
   * several times the price, with nothing saying so. A refusal names the variable and the fix.
   */
  const specificKey = enhancerModelEnvKeyFor(provider);
  const specific = env(context, specificKey)?.trim();
  const configured = specific || env(context, ENHANCER_MODEL_ENV_KEY)?.trim();

  if (!configured) {
    return getPlatformModel(context, provider);
  }

  const sourceKey = specific ? specificKey : ENHANCER_MODEL_ENV_KEY;
  const priced = providerRates(context)[provider] ?? {};

  if (!priced[configured]) {
    throw new NotConfiguredError(
      `${sourceKey}="${configured}" on provider ${provider}`,
      `We have no rates for it, so we cannot bill it. ${UNPRICED_MODEL_FIX[provider]} ` +
        `Priced models: ${Object.keys(priced).join(', ') || '(none)'}. ` +
        `Set ${specificKey} to this gateway's id for the model you want, or unset ` +
        `${ENHANCER_MODEL_ENV_KEY} to enhance with the platform model.`,
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
 * The provider's default model when `LLM_MODEL` is unset — Anthropic's (`DEFAULT_MODEL`). `KIE_DEFAULT_MODEL`
 * stopped mattering when KIE stopped being an LLM provider (2026-10-03, `_specs/anthropic-only_plan.md`).
 */
function defaultModelFor(provider: PlatformProviderName): string {
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
  warnIgnoredProvider(context, 'LLM_PROVIDER', env(context, 'LLM_PROVIDER'));

  return DEFAULT_PLATFORM_PROVIDER;
}

/** Ignored provider settings already warned about — one warning per variable+value per process. */
const warnedProviderSettings = new Set<string>();

/**
 * `LLM_PROVIDER` / `LLM_PROVIDER_CHAIN` naming anything but Anthropic (`_specs/anthropic-only_plan.md` D3):
 * IGNORED, with a warning once per process. Never a throw — `/api/me` and the health check read the config
 * and must not fall over on a stale env line, and ignoring it lands on the only provider there is.
 */
function warnIgnoredProvider(context: unknown, key: string, raw: string | undefined): void {
  const value = raw?.trim();

  if (!value || value.split(',').every((piece) => !piece.trim() || piece.trim().toLowerCase() === 'anthropic')) {
    return;
  }

  const tag = `${key}=${value}`;

  if (!warnedProviderSettings.has(tag)) {
    warnedProviderSettings.add(tag);
    logger.warn(
      `${key}="${value}" is ignored: Anthropic Managed Agents is the only LLM path (KIE and fal are media ` +
        'providers only). Remove the variable.',
    );
  }
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
  return env(context, 'LLM_MODEL')?.trim() || defaultModelFor(provider);
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
export const DEFAULT_PROVIDER_CHAIN: PlatformProviderName[] = ['Anthropic'];

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
  warnIgnoredProvider(context, LLM_PROVIDER_CHAIN_ENV_KEY, env(context, LLM_PROVIDER_CHAIN_ENV_KEY));

  return DEFAULT_PROVIDER_CHAIN;
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
export function resolvePlatformProvider(
  context?: unknown,
  nowMs: number = Date.now(),
  alsoRuns?: string,
): PlatformProviderName {
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
    const native = nativeProviderRates(context);

    const select = (withRung: boolean) =>
      selectPlatformProvider({
        chain: getProviderChain(context),
        fixed,
        isConfigured: (provider) => Boolean(env(context, platformKeyEnvFor(provider))?.trim()),
        canPrice: (provider) =>
          Boolean(rates[provider]?.[platformModelFor(provider, context)]) &&
          (!withRung || !alsoRuns || Boolean(native[provider]?.[alsoRuns])),
        unhealthyUntilMs: providerUnhealthyUntil,
        nowMs,
      });

    /*
     * 🔴 `alsoRuns` — the requested paid rung's model (2026-09-29). The chain used to be gated on the
     * STANDARD model only, which was safe while every rung had to be priced by KIE. A rung may now name
     * a model only some gateways sell (Fable 5.1: not KIE), so a Platinum turn must
     * go to a gateway that sells it NATIVELY — `providerRates` gap-fills every rung into every table
     * and would say yes for all of them. If nothing in the chain sells it, fall back to the standard
     * gate: the tier decision then resolves down or refuses loudly, exactly as before.
     */
    const withRung = select(true);
    const selection = withRung.reason === 'no_candidate' ? select(false) : withRung;

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

/**
 * `requestedTier`: the paid rung this generation ASKED for, so the gateway chosen can serve its model
 * (see `resolvePlatformProvider`'s `alsoRuns`). Absent/standard = gate on the standard model only.
 */
export function getPlatformConfig(context?: unknown, requestedTier?: string): PlatformConfig {
  return {
    provider: resolvePlatformProvider(context, Date.now(), requestedTierModel(context, requestedTier)),
    anthropicApiKey: env(context, 'ANTHROPIC_API_KEY'),
    proFeaturesEnabled: envFlag(context, 'PRO_FEATURES_ENABLED'),
    githubToken: env(context, 'GITHUB_API_KEY') || env(context, 'VITE_GITHUB_ACCESS_TOKEN'),
    adminToken: env(context, 'ADMIN_TOKEN'),
  };
}

/**
 * The model a requested paid rung would run, for ROUTING only — never for billing or authorization
 * (the tier decision re-derives all of that from the balance later). `undefined` for standard, an
 * unknown id, or a rung whose config cannot be resolved: routing then gates on the standard model,
 * which is exactly what it did before rungs could name gateway-specific models.
 */
function requestedTierModel(context: unknown, requestedTier: string | undefined): string | undefined {
  const definition = PAID_MODEL_TIERS.find((tier) => tier.id === requestedTier);

  if (!definition) {
    return undefined;
  }

  try {
    return getModelTier(definition.id, context).model;
  } catch {
    return undefined;
  }
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
};

/**
 * The configured provider's key, or undefined. Server-only — callers ACT on it, never emit it (§5).
 *
 * 🔴 A RECORD, not `provider === 'KIE' ? kie : anthropic` — a ternary is correct for exactly two providers
 * and silently resolves the wrong key for any other.
 *
 * `PLATFORM_KEY_ENV` already had to be exhaustive; this is the same fact and now has the same shape,
 * so the two cannot disagree about which key a provider needs.
 */
function platformKeyFor(config: PlatformConfig): string | undefined {
  const keys: Record<PlatformProviderName, string | undefined> = {
    Anthropic: config.anthropicApiKey,
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

  /* fal serves no LLM, so this key buys renders only. */
  FAL: 'FAL_API_KEY',
};

/** Which env var a media provider's key comes from — a NAME, never the value (§5). */
export function mediaKeyEnvFor(provider: MediaProviderName): string {
  return MEDIA_KEY_ENV[provider];
}

/**
 * Who serves renders — `MEDIA_PROVIDER`, else the LLM provider when it is a media gateway, else KIE.
 *
 * 🔴 **A SEPARATE SWITCH ON PURPOSE.** Media is a different money path from a generation: an exact
 * price debited before any spend, its own refund machinery, its own price rows. Tying it to
 * `LLM_PROVIDER` would mean a text cutover silently moves every render to a gateway whose media
 * surface has not been driven — so the two can be flipped together (the default) or separately (set
 * this), and "should media move in the same cutover?" becomes a config answer instead of a
 * code change.
 *
 * Unset, media is KIE: the LLM provider (Anthropic, the only one since 2026-10-03) sells no renders. It still needs
 * `KIE_API_KEY` — without it `getMediaConfig` is `null`, which callers report as "not configured" (a
 * describable state the Media panel and the agent tool gate on), never as a silent no-op.
 *
 * The return type keeps `null` for its callers' sake; no branch produces it today.
 */
export function getMediaProvider(context?: unknown): MediaProviderName | null {
  const raw = env(context, 'MEDIA_PROVIDER')?.trim();

  if (raw) {
    const match = MEDIA_PROVIDERS.find((name) => name.toLowerCase() === raw.toLowerCase());
    const retired = RETIRED_MEDIA_PROVIDERS.find((name) => name.toLowerCase() === raw.toLowerCase());

    if (retired) {
      throw new NotConfiguredError(
        `MEDIA_PROVIDER="${raw}"`,
        `${retired} is no longer a media gateway. Supported: ${MEDIA_PROVIDERS.join(', ')}.`,
      );
    }

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

  /* Unset: KIE — the LLM provider (Anthropic) sells no renders, so media never follows it (D6). */
  return 'KIE';
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
 * **KIE: `undefined`, deliberately.** `KIE_BASE_URL` is documented as CLAUDE-SCOPED — it moves that
 * one LLM adapter, not the whole account — and `KieMediaProvider` has no base-URL concept at all: its
 * media host is a fixed constant. Returning `KIE_BASE_URL` here would have been a value computed at
 * four call sites and discarded, under a comment claiming both kinds of spend were covered. That is
 * the `PENDING_RENDER_TTL_MS` class, and it is not reintroduced here just to look symmetric.
 */
export function mediaBaseUrlFor(provider: MediaProviderName, context?: unknown): string | undefined {
  return MEDIA_BASE_URL_ENV[provider] ? env(context, MEDIA_BASE_URL_ENV[provider]!) : undefined;
}

/**
 * A RECORD, not a ternary: a new gateway must state its answer here or
 * fail to compile. **FAL: none** — fal has one public queue host (`queue.fal.run`), and its client
 * refuses any task id outside it, so an override would have nowhere safe to point.
 */
const MEDIA_BASE_URL_ENV: Record<MediaProviderName, string | null> = {
  KIE: null,
  FAL: null,
};

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
      `Set ${MEDIA_KEY_ENV[provider]} in the server environment — media generation uses the ` +
        `platform ${provider} key.`,
    );
  }

  return apiKey;
}
