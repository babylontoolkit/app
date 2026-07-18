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
 * The free signup grant (500) sits below the default minimum (1000), so a brand-new account CANNOT burn
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
}

export type PremiumDecision =
  | { usePremium: false; reason: 'not_requested' | 'below_minimum' }
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
