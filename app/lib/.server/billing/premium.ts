/**
 * Whether a generation may use the PREMIUM model tier (SPEC §4.6.1).
 *
 * This spends the user's credits at a HIGHER rate without them confirming the price a second time, so —
 * exactly like the auto-repair loop (`auto-repair.ts`) and restore-target selection (`restore-target.ts`)
 * — the decision is a PURE function with its own exhaustive tests, never inlined into the proxy. Both of
 * those categories fail silently: a wrong `true` here bills a user 2x without them asking.
 *
 * The rule is ONE threshold, and it is the entire reason the tier exists:
 *
 *   A user may use premium only when they HOLD at least `minimumCredits`.
 *
 * The free signup grant (800) sits below the default minimum (1200), so a brand-new account CANNOT burn
 * its grant on a 2x model out the gate — to cross the threshold they must buy a credit pack or subscribe,
 * which is the exact funnel the grant protects. There is deliberately NO separate subscription check:
 * holding the credits IS the proof of intent, and gating on a subscription would wrongly punish someone
 * who bought a credit pack but never subscribed yet legitimately holds the balance.
 *
 * ⚠️ This is an ELIGIBILITY pre-gate, not a reservation. Like the credit gate (`gate.ts`) it runs once,
 * before the model. A premium generation that overshoots may drive the balance below the minimum — that
 * is fine and by design: the NEXT premium request is refused, in-flight generations are never killed
 * (§4.2.1). The minimum is "may you START a premium turn", never "is the whole turn pre-paid".
 */

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
  if (!input.requested) {
    return { usePremium: false, reason: 'not_requested' };
  }

  if (input.isFirstBuildTurn) {
    return { usePremium: false, reason: 'creation_turn' };
  }

  return input.balance >= input.minimumCredits
    ? { usePremium: true, reason: 'sufficient_credits' }
    : { usePremium: false, reason: 'below_minimum' };
}

/**
 * The friendly notice shown when a user ASKED for premium but was declined for want of credits (§4.6.1).
 *
 * The generation still runs — on the standard model — so this is never an error. The client-side gate
 * normally prevents the request reaching here, so this is the defense-in-depth message for the race
 * where a balance dropped between the page load and the send.
 */
export function premiumDeclinedNotice(minimumCredits: number): string {
  return `The premium model needs at least ${minimumCredits.toLocaleString()} credits — this build used the standard model. Add credits to unlock it.`;
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
