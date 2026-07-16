/**
 * The premium-asset add gate (SPEC §4.9) — a PURE decision, tested exhaustively.
 *
 * Adding a store asset to a project is a money-adjacent action: a premium item must not enter a project
 * unless the user has bought it. Like the auto-repair and restore-target decisions, this logic is a pure
 * function rather than something buried in a route, because the failure mode (a paywall that leaks, or
 * one that blocks a paying user) is silent and consequential.
 *
 * The four outcomes:
 *   - FREE item                      → allow, always.
 *   - premium + already entitled     → allow.
 *   - premium + not entitled + Stripe configured    → refuse, needs purchase (client opens checkout).
 *   - premium + not entitled + Stripe NOT configured → refuse, "payments not configured" (§1.3 pr. 0).
 */
import type { CatalogItem } from './catalog';

export interface PremiumGateInput {
  item: CatalogItem;
  entitled: boolean;
  stripeConfigured: boolean;
}

export type PremiumGateDecision =
  | { allow: true; reason: 'free' | 'entitled' }
  | { allow: false; reason: 'needs-purchase'; priceCents: number }
  | { allow: false; reason: 'payments-not-configured' };

export function decidePremiumAssetAdd(input: PremiumGateInput): PremiumGateDecision {
  if (!input.item.premium) {
    return { allow: true, reason: 'free' };
  }

  if (input.entitled) {
    return { allow: true, reason: 'entitled' };
  }

  if (!input.stripeConfigured) {
    // Built and wired; degrades to a clear "not configured" state rather than a stub (§1.3 principle 0).
    return { allow: false, reason: 'payments-not-configured' };
  }

  return { allow: false, reason: 'needs-purchase', priceCents: input.item.priceCents ?? 0 };
}
