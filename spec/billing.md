# spec/billing.md — Credits, Stripe & Entitlements (governs SPEC §4.6, §4.6.1, §4.5.4)

> **Status: IMPLEMENTED and verified end-to-end (Stage 3, 2026-07).** The design below is what we
> built, with four deliberate divergences recorded in *Divergences from the original design* at the
> bottom. Read that section before assuming a line here describes the code.

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
raw_cost   = in*IN_RATE + cached_in*CACHED_READ_RATE                 // per-model config
           + cache_write*CACHE_WRITE_RATE + out*OUT_RATE
credits    = ceil(raw_cost / CREDIT_UNIT_COST * MARGIN)              // MARGIN ≥ target gross margin
```

⚠️ **FOUR token classes, not three.** The original formula omitted cache WRITES. They are not free,
and they are not billed at the 1.25× headline number either: `proxy.ts` uses the **1-hour** cache tier
(§4.2.8), which writes at **2× base input**. Billing must agree with that choice — assuming 1.25×
under-charges *every* generation, and nothing in the system would notice. `billing.spec.ts` asserts
the 2× relationship across the whole rate table.

⚠️ **Sonnet 5 carries introductory pricing ($2/$10 per MTok) until 2026-08-31; the rate table
deliberately uses the standard $3/$15.** Seeding the intro rate would compress the margin below target
the day it lapses — silently. Under-charging ourselves for a few weeks is the right direction to err.
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

## The Marketplace price list (2026-07-18) — where every KIE price lives

**One versioned document holds everything the platform believes KIE charges us**: the LLM token rates
(`llm`: model → input/output USD per MTok) and the per-task media prices for §4.16 image/video
generation (`media`: model → variants of options → USD, per_image / per_second / per_video). It is
doc-sync rules applied to money, mirroring the §4.4 template pin:

- **Baked fallback in code** (`billing/baked-market-prices.ts`) — captured from KIE's own public
  pricing feed (`POST api.kie.ai/client/v1/model-pricing/page`, 372 rows, 2026-07-18), which
  independently confirmed the measured LLM rates to the cent (4-8 $2/$10, 4-7 $1.425/$7.15, fable-5
  $4/$20). Billing can never find "no prices".
- **Admin-promoted active list** (`billing/market-price-store.ts`): immutable versions in the
  ObjectStore (`pricing/kie-market/versions/mp_*.json`) + an `active.json` pointer. Promote validates
  BEFORE writing (a refused list changes nothing, all errors reported at once); rollback only
  re-points at stored bytes that still validate. The Admin tab's **Marketplace prices** section is
  the only writer; ordinary price maintenance is fetch-feed → edit → promote, no deploy.
- **Sync/async seam**: billing math is synchronous, storage is not — so the active list is an
  in-process cache (`activeMarketPrices()`, 60s TTL) refreshed at async doorways
  (`ensureMarketPrices` in the agent proxy entry, `/api/me`, the admin route). A load failure logs
  and serves the last-loaded/baked list; it can never block a generation.
- **The env price vars are RETIRED and REFUSED**: `KIE_INPUT_DOLLARS`, `KIE_OUTPUT_DOLLARS`,
  `KIE_CACHED_INPUT`, `KIE_CACHED_WRITES`, `PREMIUM_INPUT_DOLLARS`, `PREMIUM_OUTPUT_DOLLARS`.
  Setting any of them throws at config time with directions to the panel — a price var that nothing
  reads is a mis-bill waiting to be believed. `KIE_DEFAULT_MODEL` and `PREMIUM_MODEL` survive as
  SELECTORS, accepted only if the active list prices them (`kieDefaultModel`, `getPremiumTier`).
- **Cache rates are never quoted in the list** — validation refuses the keys. They derive per row
  (0.1× read / 2.0× 1-hour write, measured on KIE), so a promoted reprice moves the whole row and a
  half-repriced row cannot be expressed.
- **Media lookup has NO most-expensive fallback**, unlike `ratesFor`: LLM settlement runs AFTER
  spend (over-charging ourselves is the safe direction); media debits run BEFORE spend (§4.16 debits
  the known price up-front), where the safe direction is refusing to run. Unknown model, unmatched
  options, or a per-second request without a duration → refuse (`lookupMediaPrice` returns null).
- **The kie.ai feed is for the operator's EYES only** (`market-feed.ts`, the panel's "Fetch kie.ai
  feed"): free-text display rows, never machine-applied — auto-applying a third party's feed to our
  billing table would hand KIE's webmaster write access to our margin.
- **Media debits (§4.16, migration 0009) are the INVERSE of LLM settlement**: ledger reason `'media'`,
  taken BEFORE any spend at KIE at the exact quoted price, **never allowed to go negative** (an
  insufficient balance is a 402 refusal before the task exists — unlike `'generation'`, whose
  overdraft allowance exists only because settlement runs after spend). Failures auto-refund exactly
  once (`media/service.ts`: per-task serialisation + a `refunded` latch; a flaky status poll is
  pending, never a failure). Every media task anchors a `generations` row (`med_…`), so the
  `credit_ledger.generation_id` FK, the refund path, and the admin per-model cost breakdown all work
  unchanged. Quote and debit share ONE code path (`quoteMediaRequest`), so the price on the Generate
  button is the price in the ledger. Pinned by `media.spec.ts` + `ledger-sql.spec.ts`.
- **`providerRates` premium injection is non-throwing**: a promoted list that unprices
  `PREMIUM_MODEL` refuses NEW premium requests loudly (`getPremiumModel`) but must not take
  settlement down — an in-flight premium generation settles via the most-expensive fallback.
- **The premium threshold binds on the BALANCE, regardless of `BILLING_ENFORCED` (2026-07-18)**:
  `decidePremium` no longer takes an enforcement flag. The retired "unmetered → premium freely
  usable" bypass rested on a false premise — settlement debits the ledger whether or not the gate
  may refuse, so a 320-credit user could switch on the 2× model and ride the balance negative with
  nothing objecting (observed live). A deploy that wants free premium says `PREMIUM_MINIMUM_CREDITS=0`
  explicitly. Pinned by a structural tripwire in `premium.spec.ts` (no enforcement input exists to
  bypass with).
- **A CREATION turn never runs premium (2026-07-18)**: `decidePremium({ isCreationTurn: true })` →
  `reason: 'creation_turn'`, whatever the balance. KIE serves Fable 5 with a BUFFERED answer
  (accepted for edit-sized replies); a creation-sized artifact (~25k out tokens, 4–7 min decode)
  cannot flush before KIE's ~5-min gateway timeout — measured live: 307.8s of streamed reasoning,
  0 text, `finish=error` at 449s. Creations run the standard streaming model; the premium preference
  applies from the first edit turn. The composer pill mirrors this as a locked state
  (`creationTurnStore`), same look as the under-threshold lock.

Pinned by `market-prices.spec.ts` (validation + lookup + the baked list validates + the 21-credit
worked example), `market-price-store.spec.ts` (promote/rollback/pointer/cache), and the rewritten
selector describes in `billing.spec.ts` / `premium.spec.ts` (absolute per-row price pins replaced
the retired "uniform 0.4x" ratio rule — the feed's own rows disprove it).

---

## Divergences from the original design (recorded per SPEC §11)

Four things the implementation does differently. Each was a deliberate choice, not an oversight.

**1. The charge formula has four token classes, not three.** Cache writes were missing and they bill
at 2× (see above). This is the single most expensive line in the file to get wrong.

**2. The pre-flight gate is `balance > 0`, not `balance ≥ p90-estimate`.** The original wanted a
conservative cost estimate before starting. We do not have one and cannot cheaply get one: a
generation's cost is dominated by the tool loop, whose length is not knowable in advance. So the gate
asks only "do you have anything left", and a generation that overshoots is allowed to drive the
balance **negative** — §4.2.1 forbids killing an in-flight generation for balance, so reality is
allowed to overshoot and the gate on the *next* generation catches it. **Exposure is bounded by one
generation**, which is the price of never yanking a game out from under someone mid-build. Only
`generation` (and admin `adjustment`) rows may go negative; a purchase or refund that computes
negative is a bug and is refused.

**3. "One DB transaction per logical event" is implemented as `append_ledger_entry`** — a Postgres
`security definer` function that takes a per-user advisory lock, reads the latest `balance_after`, and
inserts, atomically. This is *stronger* than the original wording, and it is the point: deriving
`balance_after` in TypeScript is a read-modify-write, i.e. exactly the lost update the append-only
design exists to prevent. There is no INSERT policy on `credit_ledger` at all — a user cannot append
their own credits — and a trigger refuses `UPDATE`/`DELETE` outright, so append-only is enforced by
the database rather than by convention.

**4. `REPAIR_WEIGHT` is not implemented.** Self-healing repair turns settle as their own generation at
full cost rather than accumulating onto the parent at a discount. Repair turns are cheap (they run
against a cached prefix) and a weighting factor is a pricing decision we have no data to make yet. The
`generations` row carries `repairOf`, so the data to make it later is being recorded.

## Also true, and easy to get wrong

- **Bill from `result.steps`, never from `result.usage` + `result.providerMetadata`.** Those two have
  different SCOPES, and ai@4 documents it in passing: `usage` is combined across every step, while
  `providerMetadata` is *"from the LAST step"*. Anthropic reports cache reads/writes **only** in
  provider metadata — so the obvious pairing bills six rounds of input against one round of cache, and
  nothing throws. We shipped that bug and caught it because a real generation logged 133,565
  cache-read tokens: suspiciously close to exactly ONE read of a 133K prefix. `steps` is the only
  surface where both numbers are per-step. Guarded by `step-usage.spec.ts`.

- **The waste diagnostics ARE persisted** (migration `0002_generation_diagnostics.sql`, 2026-07-14).
  `public.generations` carries `tool_rounds`, `duration_ms`, `finish_reason`, `repair_of` and
  `steps jsonb` alongside the token/cost columns, and `SupabaseGenerationStore` writes them. They are not
  decoration: aggregate usage hides every pathology in `spec/context-budget.md` §"Wasted tokens and dead
  time" — measured across 10 live creations (2026-07-16), **5–57% of a creation's output tokens are
  thinking that never reaches the user**, scaling with the difficulty of the ask, and in the totals that
  is indistinguishable from "the model wrote a big answer". Keep them written. Without them the §4.10
  dashboards can chart spend but not diagnose it, and every number in the context-budget doc has to be
  read by hand out of a DevTools stream. ⚠️ **Do not infer that share from `charsPerOutputToken`** — the
  3.5–4 baseline is PROSE and our output is code (~2.0–2.2 healthy); price thinking from the reasoning
  window instead (`spec/context-budget.md` §"MEASURED").

- **What a generation actually costs, measured 2026-07-16** (`claude-opus-4-8`, `medium`, 10 live
  creations): **$0.21–0.35 warm** (whole prefix cache-hits, often `0 written`), $0.9–1.6 on a cold cache
  or an unseen routed block — the latter a cold-start artifact that volume erases. Output is **58–91% of
  a warm bill**, which is the success condition, not a pathology (input was optimised away). The credit
  math is confirmed end-to-end twice: **163 credits** vs a derived $0.485 (× 334 = 162), and **513
  credits** vs a derived $1.5355. **The model does not change the margin, only the volume** — credits
  are cost-proportional, so "downgrade to Sonnet to save money" remains a false economy here.

- **🔴 AN EDIT COSTS ABOUT WHAT THE WHOLE GAME COSTS — the open number that decides plan viability
  (measured 2026-07-16, the first edit turns ever run).** Four turns after a 513-credit creation that
  produced a complete playable game: **393 / 831 / 65 / 574 credits**. Edit 2 billed **1.6× the entire
  creation** for 906 output tokens. Only **1 of 4 turns cache-HIT** — and that one cost **65 credits**
  (`+155,815 cached, 0 written`), which is the floor. The rest paid 110–160k **cache WRITES that nothing
  ever read**, and a write bills at **2×**, so on a churning turn caching is **worse than not caching**.
  Cause: `selectOnDemandBlocks` runs per MESSAGE, keyed off the user's wording, and sits ahead of the
  ~110k file context. See CLAUDE.md §"THE BIGGEST OPEN NUMBER" and `spec/context-budget.md` §"MEASURED".

  **Read the margin correctly before panicking, and before "fixing" it in the wrong place: THE MARGIN IS
  UNAFFECTED.** Credits are cost-proportional (334 credits/$ measured on both the 831 and the 65 — the
  formula holds exactly), so a churning edit bills proportionally more and still earns ~2.78× at
  $50/6,000. **What the bug burns is the USER'S credits, not our margin** — ~13 edits per $50 instead of
  ~92. That makes it a **retention and value problem, not a solvency one**, and it means no pricing
  change can fix it and no ledger alarm will ever fire on it. The only fix is to stop the prefix churn.

  **✅ FIXED 2026-07-17 — sticky block routing** (`selectStickyBlocks` / `stickySkillNames`; see
  `spec/context-budget.md` §"Edit turns"). A warm edit now measures **~11 credits (~545 per $50 pack)**,
  and four consecutive live turns routed an identical block list. **The 13-vs-92 figures above are PRE-FIX
  and must not be quoted as current.** The margin claim is unchanged — it was never the problem, which is
  exactly why nothing alarmed for as long as it did.

- **A pathology can be invisible in aggregate revenue and lethal to the product.** This one bills a
  perfect margin on every single generation while making the plan worthless — which is precisely why
  §4.10 must diagnose spend (`steps`, cache read vs written) rather than chart it. Aggregate usage would
  have shown healthy, growing, on-margin revenue right up until the churn.

- **⚠️ ORDER THE LEDGER BY `seq`, NEVER BY `created_at` (migration 0003).** Balance is derived from "the
  latest row", and a wall clock cannot tell you which that is. `created_at` defaults to `now()` — the
  **transaction** timestamp — and rows written back-to-back routinely share one. The original function
  ordered by `created_at desc, id desc`, and `id` is a **random uuid**, so on a tie "the latest row"
  silently became "a random one of the rows from this millisecond" and the next append derived its
  `balance_after` from the wrong one. **The sequence that triggers it is the one the proxy runs on every
  failed generation**, back-to-back inside a single `finally`: settle the debit, then auto-refund it —
  measured, the refund read the *grant* row and produced a balance that skipped the debit entirely
  (9750 instead of 10000). Nothing throws; the append-only history looks perfectly plausible. `seq` is a
  DB-assigned identity, and because every append serializes on the per-user advisory lock, sequence order
  IS causal order. `SupabaseLedger.balance()` / `.list()` order by it too. **Clocks tie, and clocks go
  backwards — never order money by one.** (`FsLedger` is immune: a JSONL file has inherent order. Which
  is exactly why only the Postgres test could find this.)

- **⚠️ The SQL is now under test — keep it that way (`ledger-sql.spec.ts`).** Every other billing test
  runs against `FsLedger`, the local mirror, which has no foreign keys, no partial unique indexes, no
  triggers and no advisory locks. It can only prove we implemented the rules **twice**; it cannot prove
  the DATABASE enforces them — and the database is what runs in production. That gap is exactly how the
  `credit_ledger.generation_id` foreign key shipped unnoticed (nothing wrote `generations`, so Postgres
  would have rejected **every** debit, `settleGeneration` would have swallowed it, and every generation
  would have billed ZERO — while `FsLedger` stayed perfectly happy). `ledger-sql.spec.ts` runs the real
  migration files against an embedded Postgres (PGlite) and asserts the guarantees where they are
  actually made: balance derivation, the FK, both partial unique indexes, the negative-balance rule, the
  append-only trigger, `security definer` + service-role-only execute, and RLS on every user-scoped table.

- **The cached prefix includes the TOOL DEFINITIONS, not just the system blocks.** Change a tool's
  schema (or the base prompt) and every user's cache entry is invalidated: the next generation pays a
  full cache WRITE at 2×. Measured: an otherwise-trivial generation cost $0.51, of which **$0.36 (71%)
  was the cache write** — then $0.22 on the very next identical run, with writes at zero. This is
  correct behaviour, but it means a deploy has a real, one-off cost, and it is easy to misread a
  post-deploy cost spike as a regression.

- **Tool rounds are SEQUENTIAL LLM round trips, and they are a latency line item.** Each one
  re-prefills the whole prompt before the model can even say what it wants next. A tool that takes one
  item per call turns N items into N round trips: `read_skill_resource` did exactly that and we
  measured a generation burning all six tool rounds to page in a single skill, leaving none to answer
  with. It takes a `paths` ARRAY now, and the same probe drops to two rounds. Any future tool that
  fetches "a thing" should fetch "things".

- **Auto-refund on hard failure is implemented** (§4.6). The provider still bills *us* for the tokens a
  failed generation burned — we do not get those back. But the user asked for a game and got an error,
  so we eat it: the debit stays (it happened) and a compensating `refund` row sits beside it, pointing
  at the same `generation_id`. Append-only means the history stays honest *and* the balance comes out
  right. A **Stop** is not a failure — a stopped generation burned real tokens by the user's own
  decision, and is charged for what it consumed to the abort point (§4.12).

- **The grace window is the subtlest rule in the file.** "The license service said nothing" and "the
  license service said no" are different facts. Conflating them means every blip in *our*
  infrastructure silently revokes BYOK from every paying Pro subscriber — and it looks exactly like a
  normal lapse, so nobody would know to investigate. An unreachable service produces **no entitlement
  change** for 72h.

- **Pro gates exactly one thing.** The collapsed Model Settings toggle *renders the model name*, so it
  is gated alongside the panel; so are the Settings → Cloud/Local Providers tabs, which are the same
  machinery behind a different door. In the shipping default all of it is **absent from the DOM** — not
  disabled, not collapsed.

## Degrade gracefully — local mode is real, not a mock

With no vendor accounts at all, the platform runs as a single verified local developer with filesystem
persistence, a real append-only ledger, real ownership checks, and byte-faithful snapshots. That is
what made Stage 3 buildable and testable before Supabase, S3, Stripe, or the license service existed
(§1.3 principle 0). `assertNotLocalInProduction` **refuses to boot** into that mode when
`NODE_ENV=production`, because it treats every caller as a verified admin.

## Verified end-to-end (2026-07, local mode)

- Signup grant fired **exactly once**: `grant +1000 → 1000` (the `SIGNUP_GRANT_CREDITS` default at the time of this verification; the default is **800** since the KIE move + the 4.0 margin reprice (2026-07-18) — ~3.5× a measured KIE creation at margin 4.0, and deliberately below the 1000-credit premium minimum so a fresh grant cannot buy the 2× model).
- A live generation settled against real usage: `generation −7 → 993` (raw cost $0.0184,
  `cacheReadTokens: 60121` — the 1h cache from §4.2.8 still hitting).
- The `generations` record attributes the charge to a user, a model, and its four token classes.
- `PRO_FEATURES_ENABLED=false`: **zero** model names, provider names, `<select>`s, or API-key inputs in
  the DOM. `=true`: BYOK unlocked, Model Settings appears, Pro badge renders.
