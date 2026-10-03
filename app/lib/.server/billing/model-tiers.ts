/**
 * The MODEL TIER LADDER (SPEC §4.6.1a) — the vocabulary of model classes a credits user may choose.
 *
 * THREE rungs, ordered by CAPABILITY: **Standard** (the operator's platform model), **Premium** and
 * **Platinum** (restored 2026-09-29). Each paid rung names an operator-configured model through an env
 * SELECTOR and unlocks at a credit THRESHOLD the user must hold. `ENABLE_EXTENDED_MODELS` is the master
 * switch over both paid rungs; `ENABLE_PLATINUM_MODEL` narrows Platinum alone.
 *
 * ⚠️ **This header has now been stale in both directions, and the count is the part that keeps rotting.**
 * It said "Two rungs, ordered by cost" until 2026-08-11 — wrong on both counts, above a three-entry
 * table — and was then corrected to "THREE rungs … Standard, Premium and Platinum", where it sat above
 * a TWO-entry `MODEL_TIER_IDS` from Platinum's retirement on 2026-08-14 until 2026-08-21, and Platinum
 * came back on 2026-09-29. **Ordered by
 * CAPABILITY, and that is the rule regardless of what the prices happen to do**; the COUNT is not a rule
 * at all — it is data, it has changed four times, and the body of this file (which names every rung
 * explicitly and dates every move) is the thing to trust over any summary at the top, including this one.
 *
 * ⚠️ Its evidence, though, was a mis-bill: it argued "on Anthropic the Platinum (fable-5) row settles
 * CHEAPER than Premium (opus-5)". It did, because `MODEL_RATES` had no fable-5 row and `providerRates`
 * gap-filled KIE's $4/$20 over a model Anthropic sells at $10/$50 (fixed 2026-08-12). **The ladder is
 * cost-monotonic on Anthropic** — $2 / $5 / $10 (the only LLM gateway since 2026-10-03). Do not take that as licence to order the rungs BY cost: capability order is what the
 * thresholds, the first-build lock and the step-down-to-standard rule are all written against, and a
 * price coincidence is not a design. The lesson is narrower and sharper — **a rule justified by a
 * measurement inherits that measurement's bugs**, and this one was quoted in four files for two weeks.
 *
 * ## Why this is a table and not two code paths
 *
 * This replaced a boolean (`PREMIUM_MODEL` or nothing), carried a third rung (`SuperMax`, 2026-07-31 →
 * 2026-08-08), dropped to one paid rung, gained a second again as `platinum` on 2026-08-10, dropped
 * back to one on 2026-08-14, and regained it on 2026-09-29 — five shape changes, none of which changed a rule. The ladder is a LIST precisely so that number can move
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
export const MODEL_TIER_IDS = ['standard', 'premium', 'platinum'] as const;

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
export const DEFAULT_PREMIUM_MODEL = 'claude-opus-5-5';
export const DEFAULT_PREMIUM_MINIMUM_CREDITS = 1200;

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
 * 🔴 **PLATINUM IS RESTORED (owner, 2026-09-29) — the ladder is STANDARD · PREMIUM · PLATINUM again.**
 * It was retired on 2026-08-14 (*"we will only have Standard … or premium IF you wanna go that
 * high"*), with its model moved down into Premium. The owner has since put `PLATINUM_MODEL` back in
 * their deploy, so the rung comes back as a real table entry — the refusal of `PLATINUM_*` in
 * `premium-model-flag.ts` is removed with it, because refusing a key the ladder READS is an outage.
 *
 * The defaults are the owner's ladder (2026-09-29): Premium `claude-opus-5-5` @ 1200, Platinum
 * `claude-fable-5-1` @ 2000 — the thresholds are the reviewed 2026-08-10 values. These are only
 * FALLBACKS: the live models are `PREMIUM_MODEL` / `PLATINUM_MODEL`, and adopting a model released
 * later is an env change plus a price row in Settings → Admin → Marketplace prices — no code.
 * ⚠️ The baked Standard default (`DEFAULT_MODEL`) stays `claude-sonnet-5`, not Sonnet 5.5: every
 * price list must price the platform default (`validateMarketPriceList`), and KIE does not sell Sonnet
 * 5.5 (its feed, 2026-09-29). `LLM_MODEL` is what picks the live Standard model.
 *
 * ⚠️ **The 2026-08-14 evidence about Sonnet still stands** — measured over 30 generations it failed
 * 5 of 19 with output already billed, and "completed" never meant "the game runs". Restoring a third
 * rung does not revisit it; which model sits on which rung is config (`LLM_MODEL`, `PREMIUM_MODEL`,
 * `PLATINUM_MODEL`), not code.
 *
 * ✅ **A second paid rung makes the four two-paid-rung PROPERTIES writable again**, and their specs
 * are restored from the 2026-08-10 ladder rather than re-derived: a declined rung steps down to
 * STANDARD and never to the adjacent rung (`premium.spec.ts`); one broken selector leaves its sibling
 * serveable (`model-tiers.spec.ts`); `getTierModel` names its OWN env var in its refusal
 * (`tier-model-provider.spec.ts`, asserted on a PLATINUM refusal); and the panel renders an
 * unserveable rung beside a serveable one (`ModelTierPanel.spec.tsx`).
 */
export const DEFAULT_PLATINUM_MODEL = 'claude-fable-5-1';

/**
 * Above Premium's 1200 and well above `SIGNUP_GRANT_CREDITS` (1000).
 *
 * The ladder must stay monotonic in threshold or a bare deploy offers a dearer rung for less. It is
 * cost-monotonic too on Anthropic: fable-5 at $10/$50 against opus-5's $5/$25. **Rungs still order CAPABILITY, not price** — the two agreeing
 * is a coincidence to re-check, never a rule to reorder by.
 */
export const DEFAULT_PLATINUM_MINIMUM_CREDITS = 2000;

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
  {
    id: 'platinum',
    label: 'Platinum',
    modelEnvKey: 'PLATINUM_MODEL',
    minimumEnvKey: 'PLATINUM_MINIMUM_CREDITS',
    defaultModel: DEFAULT_PLATINUM_MODEL,
    defaultMinimumCredits: DEFAULT_PLATINUM_MINIMUM_CREDITS,
    firstBuildLocked: false,
    enabledEnvKey: 'ENABLE_PLATINUM_MODEL',
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
