/**
 * The MODEL TIER LADDER (SPEC §4.6.1a) — the vocabulary of model classes a credits user may choose.
 *
 * TWO rungs, ordered by CAPABILITY: **Standard** (the operator's platform model) and **Premium**. The
 * paid rung names an operator-configured model through an env SELECTOR and unlocks at a credit
 * THRESHOLD the user must hold.
 *
 * ⚠️ **This header has now been stale in both directions, and the count is the part that keeps rotting.**
 * It said "Two rungs, ordered by cost" until 2026-08-11 — wrong on both counts, above a three-entry
 * table — and was then corrected to "THREE rungs … Standard, Premium and Platinum", where it sat above
 * a TWO-entry `MODEL_TIER_IDS` from Platinum's retirement on 2026-08-14 until 2026-08-21. **Ordered by
 * CAPABILITY, and that is the rule regardless of what the prices happen to do**; the COUNT is not a rule
 * at all — it is data, it has changed four times, and the body of this file (which names every rung
 * explicitly and dates every move) is the thing to trust over any summary at the top, including this one.
 *
 * ⚠️ Its evidence, though, was a mis-bill: it argued "on Anthropic the Platinum (fable-5) row settles
 * CHEAPER than Premium (opus-5)". It did, because `MODEL_RATES` had no fable-5 row and `providerRates`
 * gap-filled KIE's $4/$20 over a model Anthropic sells at $10/$50 (fixed 2026-08-12). **The ladder is
 * cost-monotonic on every gateway today** — Anthropic $2 / $5 / $10, Comet $1.60 / $4 / $8, KIE
 * $0.85 / $2 / $4. Do not take that as licence to order the rungs BY cost: capability order is what the
 * thresholds, the first-build lock and the step-down-to-standard rule are all written against, and a
 * price coincidence is not a design. The lesson is narrower and sharper — **a rule justified by a
 * measurement inherits that measurement's bugs**, and this one was quoted in four files for two weeks.
 *
 * ## Why this is a table and not two code paths
 *
 * This replaced a boolean (`PREMIUM_MODEL` or nothing), carried a third rung (`SuperMax`, 2026-07-31 →
 * 2026-08-08), dropped to one paid rung, gained a second again as `platinum` on 2026-08-10, and dropped
 * back to one on 2026-08-14 — four shape changes in a fortnight, none of which changed a rule. The ladder is a LIST precisely so that number can move
 * without the rules moving. The alternative, copying the premium
 * machinery into a per-rung twin, means every rule gets written twice and the two copies drift. The
 * rules here are money rules: the threshold that protects the free signup grant, the first-build lock,
 * the refuse-an-unpriced-selector check. A drifted copy of any of them fails silently.
 *
 * ⚠️ **`SUPERMAX_MODEL` / `SUPERMAX_MINIMUM_CREDITS` are RETIRED and REFUSED if set** — see
 * `refuseRetiredModelTierEnv` in `premium-model-flag.ts`. A selector nothing reads is an operator
 * believing they are serving a rung that does not exist, which is the `CREATION_FLAT_CREDITS` rule.
 *
 * ## This module holds DATA ONLY, and that is structural
 *
 * Resolution — reading the env, pricing the selector against the active Marketplace price list —
 * lives in `rates.ts`, because `rates.ts` owns `ratesFromBase` and `activeMarketPrices`. Putting the
 * table here instead of there keeps `rates.ts` free of a second concern, and it means this file can be
 * imported by anything (including the tier DECISION in `premium.ts`, which is pure and imports
 * nothing else) without dragging the pricing layer along.
 *
 * ⚠️ It must never import `rates.ts` — that would be a cycle, since `rates.ts` imports this. And
 * `rates.ts` must never import `agent/config.ts`, which is why the STANDARD rung's model is not
 * resolved anywhere in this layer: the platform model is `getPlatformModel`'s to state (the cycle
 * documented at `rates.ts` `mostExpensive`). Callers that need the whole ladder pass it in.
 *
 * ## Model and price are ONE fact (2026-07-18)
 *
 * A tier's env var names a model; the ACTIVE price list prices it. `PREMIUM_INPUT_DOLLARS` and friends
 * are RETIRED and refused — a price var nothing reads is a mis-bill waiting to be believed. So a
 * selector the active list cannot price is REFUSED, never guessed: "is this tier configured?" and "do
 * we know what it costs?" are the same question.
 *
 * ⚠️ The THRESHOLDS stay env numbers with in-code fallbacks (`envNumber`), and that asymmetry is
 * deliberate: a fallback for a credit threshold is correct, a fallback for a PRICE is catastrophic.
 */

/** The rungs, in LADDER order (ascending capability). Order is meaningful — it is the ladder. ⚠️ Capability order, not price order: the two agree on every gateway today, and that is a coincidence to re-check, never a rule to reorder by. */
export const MODEL_TIER_IDS = ['standard', 'premium'] as const;

export type ModelTierId = (typeof MODEL_TIER_IDS)[number];

/**
 * A rung the user PAYS extra for. `standard` is excluded by type, not by a runtime check: it has no
 * selector, no threshold and no lock, so a function that resolves a paid tier cannot be handed it.
 */
export type PaidModelTierId = Exclude<ModelTierId, 'standard'>;

/**
 * The in-code defaults — what a deploy with NO environment at all gets.
 *
 * They must stay a monotonic ladder (standard ≤ premium in both price and threshold), or a bare deploy
 * offers a rung that is cheaper than the one below it. The signup grant (`SIGNUP_GRANT_CREDITS`, 1000)
 * sits below every paid threshold, which is the whole point of the thresholds: a brand-new account
 * cannot burn its grant on the expensive models out the gate.
 */
export const DEFAULT_PREMIUM_MODEL = 'claude-fable-5';
export const DEFAULT_PREMIUM_MINIMUM_CREDITS = 1500;

/**
 * PLATINUM — the second paid rung (added 2026-08-10, owner).
 *
 * 🔴 **This is the rung `SuperMax` used to be, under a better name — NOT a revival of its env vars.**
 * `SUPERMAX_MODEL` / `SUPERMAX_MINIMUM_CREDITS` stay REFUSED (`refuseRetiredModelTierEnv`), and that
 * is the whole point rather than an oversight: a deploy still carrying `SUPERMAX_MODEL=x` must fail
 * loudly and be told where the model goes now, never be silently adopted into a rung whose threshold
 * and price it was never checked against. Same reasoning as `ENABLE_EXTENDED_MODELS` — a rename that
 * silently starts reading an old value is the costly direction.
 *
 * 🔴 **PLATINUM IS RETIRED (owner, 2026-08-14) — the ladder is STANDARD + PREMIUM.** *"remove PLATNUM
 * level… we will only have Standard — the default for development — or premium IF you wanna go that
 * high."* The rung's model moved DOWN into Premium rather than being dropped: Standard is now Opus 5
 * (`LLM_MODEL`) and Premium is Fable 5, because *"SONNET IS NOT ABLE TO RELIABLY HANDLE GAME
 * CREATION… PERIOD and has been causing A LOT of the reliable finishing issues"* — measured over the
 * last 30 generations, Sonnet failed 5 of 19 with output already billed, and its completions leaned on
 * the rescue machinery (`forced-continuation` x2, `unproductive-rescue`, `creation-completeness` x6,
 * 6-19 steps), where Opus completed 4 of 4 in 3-6 steps.
 *
 * 🔴 **AND "COMPLETED" IS NOT "WORKS" — the telemetry cannot see the real failure (owner, 2026-08-14).**
 * *"It may have passed what you call a successful creation, but the games don't work and very often
 * just freeze at the start, whereas Opus with the same prompt creates a working game."* The counts
 * above are `status` — a fact about whether the TURN finished — and a Sonnet build that streams a
 * complete artifact, writes every file and settles `completed` is counted as a success here while
 * producing a game that freezes on load. So the measured gap UNDERSTATES the decision rather than
 * making it: the real Sonnet failure rate includes an unknown share of its 14 "successes".
 *
 * ⚠️ This is the `wastedOutput` shape again, one layer out: a metric defined against the failure it
 * expects (the turn dying) reports health on the failure it does not (the turn completing and
 * shipping a broken game). **Nothing in this codebase currently measures whether the delivered game
 * RUNS** — the §4.14 preview tools (`get_game_errors`, `evaluate_in_game`) are the channel that
 * could, and wiring them to a post-build health check is the honest next thing, not another count of
 * finish reasons.
 *
 * ⚠️ **Sonnet is NOT removed from `MODEL_RATES`.** It remains the enhancer model
 * (`ENHANCE_PROMPT_MODEL`) and the right tool for light work — the finding is about GAME CREATION, and
 * generalising it into "delete the row" would break the ✨ button to make a point.
 *
 * 🔴 **The four properties that need TWO paid rungs are LOST AGAIN** — the same four this comment has
 * now watched leave, return, and leave a second time: a declined rung steps down to STANDARD and never
 * to the adjacent rung; one broken selector leaves its sibling serveable; `getTierModel` names its OWN
 * env var in its refusal; and the panel can render an unserveable rung beside a serveable one. On a
 * one-paid-rung ladder each is observationally identical to a hardcoded `'premium'`, so their specs
 * are re-anchored or deleted rather than left green and meaningless.
 *
 * ⚠️ **A fixture rung does not restore them.** `decideModelTier` validates the requested id against
 * `MODEL_TIER_IDS` BEFORE consulting the ladder it was handed, so a test cannot invent a third rung to
 * assert against — the table IS the whitelist. Restoring them requires a real second paid rung, which
 * is the condition to re-read this note against. It went unread for a full day last time.
 */
/** The static definition of a paid rung: where its config comes from and what it falls back to. */
export interface ModelTierDefinition {
  id: PaidModelTierId;

  /** User-facing name. The ONE source for it — the pill, the picker and any notice all read this. */
  label: string;

  /** The env var naming this tier's model. A SELECTOR, never a price. */
  modelEnvKey: string;

  /** The env var holding this tier's credit threshold (`envNumber` — a threshold, not a price). */
  minimumEnvKey: string;

  /** Used when `modelEnvKey` is unset. Must be priced by the baked list or the tier is dead on arrival. */
  defaultModel: string;

  /** Used when `minimumEnvKey` is unset or unparseable. */
  defaultMinimumCredits: number;

  /**
   * Locked on the FIRST BUILD turn (§4.4a).
   *
   * 🔴 **FALSE for every rung since 2026-08-03 (owner: "remove the first-premium-build-always-runs-
   * default-model rule — we can choose our model as long as we have enough credits and the additional
   * models are enabled").** A user who has paid for a rung and can afford it gets it on every turn,
   * including the biggest one.
   *
   * ⚠️ **The reason it was introduced is RETIRED, not merely overruled.** The 2026-07-18 rationale was
   * that Fable 5 on KIE serves a BUFFERED answer which a build-sized artifact may not flush before
   * their gateway timeout — read at the time as a property of that MODEL. It is not: KIE buffers every
   * answer on every model, which is why `agent/delivery.ts` keys `deliveryMode` on the PROVIDER and
   * says so in its own doc ("the buffering lives in the adapter, so a `LLM_MODEL` swap must not
   * silently flip it to streamed"), and why the panel has an expectation bar telling the user to wait.
   * So the lock was singling out one rung for something all three do — it never bought what it was
   * charging for.
   *
   * The residual risk is the gateway TIMEOUT on a very long generation, which is real for any rung and
   * is handled where it belongs: a death there is a hard failure, so it refunds and retries
   * (`MAX_PROVIDER_RETRY_ATTEMPTS`, whose last attempt drops thinking).
   *
   * The flag and its branch in `decideModelTier` STAY, so re-locking a single rung is one line and a
   * test — not surgery on the decision function — the next time a provider misbehaves.
   */
  firstBuildLocked: boolean;

  /**
   * The env flag that withdraws THIS rung alone, default ON.
   *
   * 🔴 It only ever NARROWS what `ENABLE_EXTENDED_MODELS` already allows — that variable remains the
   * MASTER switch for every paid rung and is deliberately not renamed. An existing deploy carrying
   * `ENABLE_EXTENDED_MODELS=false` expects no paid rung at all, and making it per-rung on upgrade would
   * silently start serving Platinum to a deploy that had switched the paid models off: the costly
   * direction, nothing thrown, which is precisely the `ENABLE_EXTENDED_MODELS` bug wearing a new hat.
   */
  enabledEnvKey: string;
}

/** Every paid rung, in LADDER order (ascending capability, not price). `standard` is absent by design — see `PaidModelTierId`. */
export const PAID_MODEL_TIERS: readonly ModelTierDefinition[] = [
  {
    id: 'premium',
    label: 'Premium',
    modelEnvKey: 'PREMIUM_MODEL',
    minimumEnvKey: 'PREMIUM_MINIMUM_CREDITS',
    defaultModel: DEFAULT_PREMIUM_MODEL,
    defaultMinimumCredits: DEFAULT_PREMIUM_MINIMUM_CREDITS,
    firstBuildLocked: false,
    enabledEnvKey: 'ENABLE_EXTENDED_MODELS',
  },
];

/** The user-facing name of the free rung. Standard has no definition row — it has nothing to configure. */
export const STANDARD_TIER_LABEL = 'Standard';

/** The definition for a paid rung. Total over `PaidModelTierId`, so callers need no null check. */
export function paidModelTierDefinition(id: PaidModelTierId): ModelTierDefinition {
  const definition = PAID_MODEL_TIERS.find((tier) => tier.id === id);

  if (!definition) {
    // Unreachable while the type and the table agree; a loud throw is better than a silent undefined.
    throw new Error(`No model tier definition for "${id}"`);
  }

  return definition;
}
