# spec/billing.md — Credits, Stripe & Entitlements (governs SPEC §4.6, §4.6.1, §4.5.4)

## Invariants (unit-test all of these)

1. Ledger is append-only. Balance derived: latest `balance_after` per user. Single bucket; credits never expire.
2. Pro Tools entitlement = **BYOK unlock**, not credit grants. BYOK generations charge zero credits and are honored only while the server verifies an active entitlement (per generation).
3. Debit path: platform-key generations debit credits; BYOK generations do not (still recorded).
4. Signup grant: at email **verification**, once ever — partial unique index `(user_id) WHERE reason='grant'`.
5. A lapsed entitlement silently falls back to the credit gate (friendly notice); nothing is clawed back.
6. Every debit row has a `generation_id`. Every purchase row has `payment_provider` + `payment_ref` (unique).
7. In-flight generations are never killed for balance; the gate is pre-flight only.
8. All ledger writes for one logical event happen in one DB transaction.

## Charge computation (post-generation)

```
raw_cost   = in*IN_RATE + cached_in*CACHED_RATE + out*OUT_RATE      // per-model config
credits    = ceil(raw_cost / CREDIT_UNIT_COST * MARGIN)              // MARGIN ≥ target gross margin
```
- Self-healing repair turns: tokens accumulate onto the parent generation at `REPAIR_WEIGHT` (config, e.g. 0.5).
- Aborted (Stop): charge tokens actually consumed to abort.
- Hard failure (API error, zero actions parsed + error status): auto-refund row (`reason='refund'`).
- BYOK generations (Pro-entitled only): no LLM debit; still write a `generations` row (tokens, `credits_charged=0`) and enforce rate limits. Optional platform fee behind config, default off. Server MUST verify entitlement freshness before honoring BYOK on each generation.

## Pre-flight gate (single choke point, in agent proxy)

session → verified? → active Pro entitlement + BYOK enabled? use user's key, skip credit check : balance ≥ conservative estimate (config heuristic, e.g. p90 recent cost for the model)? → else 402-style friendly block with upsell (buy credits / go Pro for BYOK).

## Stripe

- Checkout Session created server-side: `client_reference_id=user_id`, metadata `{user_id, pack_id}`; store/reuse `stripe_customer_id` on profile.
- Webhooks (verified signature, idempotent on `payment_ref`=session/payment_intent id): `checkout.session.completed` → purchase row. Refund/dispute events → negative ledger row + flag account for review.
- Assets store one-time purchases share the same webhook plumbing with their own reason/config (Phase 4 detail).
- Test mode throughout Phase 2; live keys are a Phase 3 gate.

## Entitlements (Pro Tools via license service)

- `ValidateSubscription(email) → {active, tier: indie|small_business|enterprise, expiry}`; server-to-server (shared secret min., mTLS preferred); timeout 5s; response cached 24h per user.
- Lifecycle: check on sign-in + daily job for active entitlements + freshness check when honoring BYOK. Fail-open grace: service unreachable ≤72h → status unchanged. Explicit `active:false` → `status='lapsed'` → BYOK no longer honored; fall back to credits with notice.
- The entitlement's platform effect is a single boolean capability: BYOK honored. Tier recorded for display/analytics; all tiers identical at launch.
- Email-mismatch link flow: user submits license key / subscription id / payer email → verified against license service → `entitlements.subscriber_email` set. Self-serve UI; log for support.

## UI surfaces

Balance chip, per-message cost badge (shows 'BYOK' for Pro-key generations), billing page (packs, history from ledger, Pro/BYOK status panel), zero-balance upsell (buy credits / go Pro for BYOK).

## Flags & caps

`BILLING_ENFORCED` (gate on/off; recording always on), `SIGNUP_GRANT_CREDITS`, `DAILY_TOKEN_BUDGET` (platform breaker), per-user rate limits. Anthropic Console spend caps are the backstop of last resort.
