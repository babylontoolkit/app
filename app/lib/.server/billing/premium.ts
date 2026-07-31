/**
 * Which rung of the MODEL TIER LADDER a generation may run on (SPEC §4.6.1a).
 *
 * This spends the user's credits at a HIGHER rate without them confirming the price a second time, so —
 * exactly like the auto-repair loop (`auto-repair.ts`) and restore-target selection (`restore-target.ts`)
 * — the decision is a PURE function with its own exhaustive tests, never inlined into the proxy. Both of
 * those categories fail silently: a wrong answer here bills a user several times over without them asking.
 *
 * The rule is ONE threshold PER RUNG, and it is the entire reason the paid rungs exist:
 *
 *   A user may run a paid rung only when they HOLD at least that rung's `minimumCredits`.
 *
 * The free signup grant (1000) sits below every paid minimum (1200 premium / 1500 supermax by default),
 * so a brand-new account CANNOT burn its grant on an expensive model out the gate — to cross a threshold
 * they must buy a credit pack or subscribe, which is the exact funnel the grant protects. There is
 * deliberately NO separate subscription check: holding the credits IS the proof of intent, and gating on
 * a subscription would wrongly punish someone who bought a credit pack but never subscribed yet
 * legitimately holds the balance.
 *
 * ⚠️ This is an ELIGIBILITY pre-gate, not a reservation. Like the credit gate (`gate.ts`) it runs once,
 * before the model. A paid generation that overshoots may drive the balance below the minimum — that
 * is fine and by design: the NEXT request on that rung is refused, in-flight generations are never killed
 * (§4.2.1). The minimum is "may you START a turn on this rung", never "is the whole turn pre-paid".
 *
 * ## A DECLINED RUNG FALLS TO STANDARD, NEVER TO THE RUNG BELOW IT
 *
 * Every refusal here resolves to `standard`. Stepping down one rung would be the expensive direction
 * wearing a helpful face: a user who asked for SuperMax at 1,499 credits did not ask for Premium, and
 * silently running the rung they did not choose bills them more than the fallback they would have
 * accepted. The same reasoning makes an unknown tier id resolve DOWN (see `resolveTierId`).
 */

import { MODEL_TIER_IDS, PAID_MODEL_TIERS, STANDARD_TIER_LABEL, type ModelTierId } from './model-tiers';

export type { ModelTierId };

export interface PremiumDecisionInput {
  /**
   * The client asked for premium (a persisted per-user preference — `settings.ts`). NEVER trusted as
   * authorization on its own; this function is the authorization.
   */
  requested: boolean;

  /** The user's current balance, as read by the credit gate (`checkCreditGate` returns it). */
  balance: number;

  /** `PREMIUM_MINIMUM_CREDITS` — the credits a user must hold to unlock premium. */
  minimumCredits: number;

  /**
   * The turn carries the creation brief — the one turn premium must NEVER run (2026-07-18, observed
   * live). KIE serves Fable 5 with a BUFFERED answer (the accepted trade of the provider decision):
   * fine for an edit-sized reply, fatal for a creation — the ~25k-token artifact takes 4–7 minutes to
   * decode, KIE's gateway cuts the connection at ~5, and the generation dies at `finish=error` after
   * 7+ minutes of the user watching reasoning stream with no artifact ever arriving (measured: step 2
   * = 307.8s, 17,635 chars reasoning, 0 text). Creations run the standard streaming model; the
   * premium preference kicks in from the first edit turn.
   */
  isFirstBuildTurn?: boolean;
}

export type PremiumDecision =
  | { usePremium: false; reason: 'not_requested' | 'below_minimum' | 'creation_turn' }
  | { usePremium: true; reason: 'sufficient_credits' };

/*
 * ⚠️ The threshold binds REGARDLESS of `BILLING_ENFORCED` (changed 2026-07-18). The original rule
 * bypassed it when enforcement was off, on the premise "nobody is charged at all" — which is FALSE:
 * `settleGeneration` debits the ledger on every generation no matter what; enforcement only decides
 * whether the GATE may refuse at zero. So the bypass let a 320-credit user switch on a 2x model and
 * ride the balance negative with nothing ever objecting (observed live). The balance is always being
 * debited, so the balance is always the eligibility fact. An operator who genuinely wants free
 * premium (a demo box) says so explicitly with `PREMIUM_MINIMUM_CREDITS=0` — a stated choice, never
 * an inference from a flag that means something else.
 */
export function decidePremium(input: PremiumDecisionInput): PremiumDecision {
  const decision = decideModelTier({
    requested: input.requested ? 'premium' : 'standard',
    balance: input.balance,
    isFirstBuildTurn: input.isFirstBuildTurn,
    tiers: [
      {
        id: 'premium',
        label: 'Premium',
        minimumCredits: input.minimumCredits,
        firstBuildLocked: true,
        serveable: true,
      },
    ],
  });

  if (decision.tier === 'premium') {
    return { usePremium: true, reason: 'sufficient_credits' };
  }

  /*
   * Narrowed by hand rather than cast. A cast here would SUPPRESS the compile error that is the only
   * thing telling a future reader that a reason has been added which this wrapper cannot express —
   * and the one-row ladder above makes `unavailable` unreachable today, so the error would never
   * surface at runtime either. `unavailable` maps to `below_minimum` because that is what the sole
   * caller acts on, and because the alternative (inventing a new premium reason) would fork the two.
   */
  switch (decision.reason) {
    case 'standard_requested':
      return { usePremium: false, reason: 'not_requested' };
    case 'creation_turn':
      return { usePremium: false, reason: 'creation_turn' };
    default:
      return { usePremium: false, reason: 'below_minimum' };
  }
}

/** One rung as the decision needs to see it. Structural, so this file imports no pricing layer. */
export interface ModelTierOption {
  id: ModelTierId;

  /** User-facing name, for the declined notice. From the tier table — never re-typed here. */
  label: string;

  /** Credits the user must HOLD. Zero for `standard`, which is why standard is never declined. */
  minimumCredits: number;

  /** Never runs on the first build turn (§4.4a) — see `model-tiers.ts` for the measured reason. */
  firstBuildLocked: boolean;

  /** False when the operator's selector for this rung cannot be priced by the active list. */
  serveable: boolean;
}

export interface ModelTierDecisionInput {
  /**
   * The tier the CLIENT asked for. Typed `string` on purpose: this value arrives in a browser body, so
   * it is untrusted input, and the boundary that narrows it must live here rather than in a caller who
   * might forget. NEVER trusted as authorization on its own — this function is the authorization.
   */
  requested: string | undefined;

  /** The user's current balance, as read by the credit gate (`checkCreditGate` returns it). */
  balance: number;

  /** The resolved ladder. A rung absent from this list is unreachable, exactly as if unserveable. */
  tiers: readonly ModelTierOption[];

  /**
   * The turn carries the creation brief — the one turn a paid rung must NEVER run (2026-07-18, observed
   * live). KIE serves Fable 5 with a BUFFERED answer (the accepted trade of the provider decision):
   * fine for an edit-sized reply, fatal for a creation — the ~25k-token artifact takes 4–7 minutes to
   * decode, KIE's gateway cuts the connection at ~5, and the generation dies at `finish=error` after
   * 7+ minutes of the user watching reasoning stream with no artifact ever arriving (measured: step 2
   * = 307.8s, 17,635 chars reasoning, 0 text). First builds run the standard streaming model; the tier
   * preference kicks in from the first edit turn.
   */
  isFirstBuildTurn?: boolean;
}

/**
 * Why the ladder landed where it did. Four of the five mean "declined, running standard instead".
 *
 * - `standard_requested` — the user asked for `standard`, or for something that is not a tier id at all.
 * - `unavailable` — the rung exists but its selector cannot be priced. The only OPERATOR-fault reason.
 * - `creation_turn` — the rung is locked on the first build turn (§4.4a).
 * - `below_minimum` — the rung is fine; the user cannot afford it yet.
 * - `sufficient_credits` — granted.
 */
export type ModelTierDecisionReason =
  | 'standard_requested'
  | 'unavailable'
  | 'creation_turn'
  | 'below_minimum'
  | 'sufficient_credits';

export interface ModelTierDecision {
  /** The rung that will actually run. `standard` for every refusal — never an adjacent paid rung. */
  tier: ModelTierId;
  reason: ModelTierDecisionReason;
}

/**
 * Narrow an untrusted tier id, resolving DOWN on anything unrecognised.
 *
 * Mirrors `parseUserEffort` (`capabilities.ts`), and for the same money reason: it **never clamps
 * upward**. A typo, a stale client, a hand-edited request body — every one of them lands on the cheap
 * rung. Inventing a more expensive tier than the user asked for is the costly direction, and it is the
 * direction a "closest match" or "default to the highest available" would take.
 */
function resolveTierId(requested: string | undefined): ModelTierId {
  return (MODEL_TIER_IDS as readonly string[]).includes(requested ?? '') ? (requested as ModelTierId) : 'standard';
}

/*
 * ⚠️ The threshold binds REGARDLESS of `BILLING_ENFORCED` (changed 2026-07-18). The original rule
 * bypassed it when enforcement was off, on the premise "nobody is charged at all" — which is FALSE:
 * `settleGeneration` debits the ledger on every generation no matter what; enforcement only decides
 * whether the GATE may refuse at zero. So the bypass let a 320-credit user switch on a 2x model and
 * ride the balance negative with nothing ever objecting (observed live). The balance is always being
 * debited, so the balance is always the eligibility fact. An operator who genuinely wants free
 * premium (a demo box) says so explicitly with `PREMIUM_MINIMUM_CREDITS=0` — a stated choice, never
 * an inference from a flag that means something else.
 *
 * That is why this input has NO `enforced` field, and a structural test pins its absence.
 */
export function decideModelTier(input: ModelTierDecisionInput): ModelTierDecision {
  const requested = resolveTierId(input.requested);

  if (requested === 'standard') {
    return { tier: 'standard', reason: 'standard_requested' };
  }

  const tier = input.tiers.find((candidate) => candidate.id === requested);

  /*
   * Availability is checked BEFORE the first-build lock deliberately. Both end at `standard`, so the
   * user sees no difference — but the reason reaches the generation log, and `unavailable` is the only
   * one of the five that means an OPERATOR must go and fix something. Ordering it behind a per-turn
   * condition would hide a broken selector on exactly the turns it is most likely to be requested.
   */
  if (!tier || !tier.serveable) {
    return { tier: 'standard', reason: 'unavailable' };
  }

  if (tier.firstBuildLocked && input.isFirstBuildTurn) {
    return { tier: 'standard', reason: 'creation_turn' };
  }

  return input.balance >= tier.minimumCredits
    ? { tier: requested, reason: 'sufficient_credits' }
    : { tier: 'standard', reason: 'below_minimum' };
}

/**
 * The friendly notice shown when a user ASKED for a paid rung but was declined for want of credits.
 *
 * The generation still runs — on the standard model — so this is never an error. The client-side gate
 * normally prevents the request reaching here, so this is the defense-in-depth message for the race
 * where a balance dropped between the page load and the send.
 *
 * It names the rung the user actually asked for. A single hardcoded "premium" would tell a SuperMax
 * user the wrong threshold and the wrong model, which is worse than saying nothing.
 */
export function tierDeclinedNotice(label: string, minimumCredits: number): string {
  return `The ${label} model needs at least ${minimumCredits.toLocaleString()} credits — this build used the standard model. Add credits to unlock it.`;
}

/** @deprecated Use `tierDeclinedNotice`. Kept while the premium-only callers are migrated (T6). */
export function premiumDeclinedNotice(minimumCredits: number): string {
  return tierDeclinedNotice('premium', minimumCredits);
}

/** What `/api/me` tells the client about the premium tier. A rendering hint — never authorization. */
export interface PremiumSessionHint {
  model: string;
  minimumCredits: number;
  available: boolean;
}

/**
 * Derive the premium half of the session payload, INCLUDING the misconfigured case.
 *
 * Pure and tested because both of its failure directions are silent, and they are not symmetrical:
 *
 * 🔴 **A misconfigured tier must degrade to `available: false`, never to the baked default's
 * availability.** `getPremiumTier` throws when `PREMIUM_MODEL` names a model the active Marketplace price
 * list cannot price — the normal transient state while an operator moves to a new premium model (set the
 * SSM var, promote the price a minute later, or do the two in the wrong order). In that state premium
 * genuinely cannot be served: `getPremiumModel` applies the same validation and refuses at generation
 * time. So reporting it available renders an enabled toggle that hard-fails the moment it is used.
 * Degrading a capability to "off" is honest; degrading it to "on" invents one.
 *
 * ⚠️ And it must not THROW, because its caller is `/api/me` — the session endpoint on every page load.
 * Before this was guarded, an unpriced `PREMIUM_MODEL` took the whole app down for every user because a
 * toggle's rendering hint was misconfigured. `getPlatformModel` in the same object literal was already
 * guarded for exactly that reason; this half was not.
 *
 * This can never GRANT premium: `decidePremium` re-derives eligibility server-side on every generation.
 * It can only fail to offer it.
 */
export function premiumSessionHint(input: {
  tier: { model: string; minimumCredits: number } | null;
  balance: number;
  fallbackModel: string;
  fallbackMinimumCredits: number;
}): PremiumSessionHint {
  if (!input.tier) {
    return { model: input.fallbackModel, minimumCredits: input.fallbackMinimumCredits, available: false };
  }

  return {
    model: input.tier.model,
    minimumCredits: input.tier.minimumCredits,
    available: input.balance >= input.tier.minimumCredits,
  };
}

/** One rung as `/api/me` reports it. A rendering hint — never authorization. */
export interface ModelTierHint {
  id: ModelTierId;
  label: string;

  /** The model this rung would run. On a misconfigured rung, its in-code DEFAULT — never the bad selector. */
  model: string;

  /** Zero for `standard`. What the picker shows beside a locked row. */
  minimumCredits: number;

  /** May THIS user pick this rung right now: it is serveable AND they hold the minimum. */
  available: boolean;

  /**
   * Can the platform serve this rung AT ALL — i.e. is the operator's selector priceable?
   *
   * Reported ALONGSIDE `available` rather than folded into it, because the client needs the two apart
   * and cannot derive one from the other. `available` is a SNAPSHOT taken when `/api/me` was fetched;
   * the balance moves on every generation afterwards, so the client recomputes affordability live. If
   * it had to read `available`, a user who bought credits mid-session to unlock a rung would watch it
   * stay locked until they reloaded — on the exact screen they just paid on. Whereas `serveable` is a
   * fact about the OPERATOR'S CONFIG that the client cannot know any other way, and a rung the platform
   * will refuse must stay unpickable however many credits are held.
   */
  serveable: boolean;
}

/** The whole ladder as `/api/me` reports it. */
export interface ModelTiersSessionHint {
  /** The model a `standard` turn runs — so the composer pill can name what is actually in use. */
  standardModel: string;
  tiers: ModelTierHint[];
}

/** A resolved rung as this function needs to see it — structurally `ModelTierStatus` from `rates.ts`. */
export interface ModelTierStatusLike {
  id: ModelTierId;
  label: string;
  model: string;
  minimumCredits: number;
  serveable: boolean;
}

/**
 * Derive the model-tier half of the session payload, INCLUDING every misconfigured case.
 *
 * Pure and tested because both of its failure directions are silent, and they are not symmetrical:
 *
 * 🔴 **A misconfigured rung must degrade to `available: false`, never to the baked default's
 * availability.** `getModelTier` throws when a rung's selector names a model the active Marketplace
 * price list cannot price — the normal transient state while an operator moves a rung to a new model
 * (set the SSM var, promote the price a minute later, or do the two in the wrong order). In that state
 * the rung genuinely cannot be served: `getTierModel` applies the same validation and refuses at
 * generation time. So reporting it available renders an enabled picker row that hard-fails the moment
 * it is used. **Degrading a capability to "off" is honest; degrading it to "on" invents one.**
 *
 * ⚠️ And it must not THROW, because its caller is `/api/me` — the session endpoint on every page load.
 * Before the premium half was guarded, an unpriced `PREMIUM_MODEL` took the whole app down for every
 * user because a toggle's rendering hint was misconfigured (2026-07-25). Generalizing the ladder
 * multiplies the ways an operator can reach that state, so this function is TOTAL by construction: a
 * null ladder, a null standard model, a malformed row and a NaN balance all yield a locked ladder
 * rather than an exception.
 *
 * This can never GRANT a rung: `decideModelTier` re-derives eligibility server-side on every
 * generation. It can only fail to offer one.
 */
export function modelTiersSessionHint(input: {
  /** From `getModelTiers`, which never throws. Null/undefined only if the caller could not call it. */
  tiers: readonly ModelTierStatusLike[] | null | undefined;

  /** From `getPlatformModel`, guarded by the caller. */
  standardModel: string | null | undefined;

  /**
   * Named by the caller rather than imported, because `DEFAULT_MODEL` lives in `~/utils/constants`,
   * which imports `LLMManager` — dragging the whole provider registry into this pure module.
   */
  fallbackStandardModel: string;

  balance: number;
}): ModelTiersSessionHint {
  const standardModel = nonEmpty(input.standardModel) ?? input.fallbackStandardModel;

  /*
   * A missing ladder is reported as the in-code rungs, the paid ones LOCKED. Reporting no rungs at all
   * would be the other silent direction: the picker would render a single-option list and the user
   * would read "this platform has one model" from what is actually a transient config fault.
   *
   * 🔴 The degraded ladder must have the SAME SHAPE as the healthy one, `standard` row included.
   * `getModelTiers` prepends standard (`rates.ts`) and `PAID_MODEL_TIERS` excludes it by design, so
   * mapping the table alone emitted a ladder missing the ONE rung every user can always use — a
   * consumer that renders `tiers` verbatim would show a picker with no free option during a config
   * fault, i.e. the fallback for "we cannot read the config" would hide the model we are certainly
   * about to run. Two shapes for one field is also how a client normaliser ends up with a branch
   * nobody tests.
   */
  const rows: readonly ModelTierStatusLike[] = input.tiers?.filter((row): row is ModelTierStatusLike =>
    Boolean(row),
  ) ?? [
    { id: 'standard', label: STANDARD_TIER_LABEL, model: standardModel, minimumCredits: 0, serveable: true },
    ...PAID_MODEL_TIERS.map((definition) => ({
      id: definition.id,
      label: definition.label,
      model: definition.defaultModel,
      minimumCredits: definition.defaultMinimumCredits,
      serveable: false,
    })),
  ];

  return {
    standardModel,
    tiers: rows.map((row) => ({
      id: row.id,
      label: row.label,
      model: row.model,
      minimumCredits: row.minimumCredits,

      /*
       * `standard` has a zero minimum and is always serveable, so it falls out of this same expression
       * as `true` — no special case, which is what stops the free rung ever being reported as locked.
       * A NaN balance compares false against any minimum, i.e. it locks. The safe direction.
       *
       * ⚠️ `=== true`, not a truthiness test: a row that reached here missing `serveable` (impossible
       * through `getModelTiers`, possible through any future caller) would otherwise put `undefined`
       * on the wire, and `undefined` is neither "off" nor honest — it is a locked row that a client
       * reading `!available` renders correctly and a client reading `available === false` renders as
       * an enabled control that hard-fails. Being total means answering `false`, not answering nothing.
       */
      available: row.serveable === true && input.balance >= row.minimumCredits,
      serveable: row.serveable === true,
    })),
  };
}

/** A string that is actually a value. `''` from a misread env var is not a model name. */
function nonEmpty(value: string | null | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}
