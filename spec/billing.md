# spec/billing.md — Credits, Stripe & Entitlements (governs SPEC §4.6, §4.6.1, §4.6.1a, §4.5.4)

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

🔴 **SONNET 5 IS $2/$10, AND THE INTRO-PRICING CARVE-OUT IS RETIRED (2026-08-12).** This section read:
*"Sonnet 5 carries introductory pricing ($2/$10 per MTok) until 2026-08-31; the rate table deliberately
uses the standard $3/$15. Seeding the intro rate would compress the margin below target the day it
lapses — silently. Under-charging ourselves for a few weeks is the right direction to err."* **Anthropic
has made $2/$10 the standard price and cancelled the scheduled 1 September increase**, so the premise is
gone and the deviation inverted from prudent to wrong.

⚠️ **Be precise about who paid for it, because this file's other deviations lean the other way.** Credits
are cost-proportional, so an OVERSTATED cost in `MODEL_RATES` is not retained margin — it is billed
straight through: every Anthropic-served Sonnet 5 turn (the platform default, and the last rung of
`LLM_PROVIDER_CHAIN`) charged **1.5× the credits it should have**. It also fed `savings.ts`, whose
reference table IS `MODEL_RATES`, so the "you saved N" figure beside a money number claimed a ~47%
discount against Comet where the honest number is **20%**.

⚠️ **The generalisable rule: a rate held deliberately off the vendor's current price is a DATED decision
that needs an expiry review, not a comment.** Four documents plus a named spec assertion
(`'uses standard Sonnet pricing, not the expiring introductory rate'`) all faithfully recorded *why*
$3/$15 was right, and every one kept reading as correct after the fact underneath it moved — the same
"cite config as DATED evidence" failure recorded three times already in `CLAUDE.md`. **A test pinned to a
deliberate deviation goes green every day the deviation is wrong.**

⚠️ **"User project compute ≈ $0" is RETIRED, and sandbox compute is now an ASSERTED cost input
(2026-07-28, `billing/vm-cost.ts`).** It was true on WebContainer — the project ran in the user's own
browser, and the only real cost is a fixed StackBlitz plan fee (SPEC §7) that a per-credit margin
cannot see. A CodeSandbox build (SPEC §8) runs the project on a platform-billed microVM charged by
**wall clock**, and the clock runs while the user THINKS. Metering is still not built (no `sandbox`
ledger reason, no sweep), so by owner decision (2026-07-27) the cost is folded into the margin — but
it is no longer folded in *invisibly*:

- Two explicit inputs, kept apart because one is a measurement and one is a guess:
  `SANDBOX_VM_USD_PER_HOUR` (MEASURED list price — **$0.149/hr Nano, the default tier since
  2026-07-28**; $0.074/hr Pico. **Derived from `CODESANDBOX_VM_TIER`**, since "raise it with the tier"
  was a comment and an operator moving to Nano without it priced compute at half its real cost; the
  DEFAULT price is `MEASURED_VM_TIER_USD_PER_HOUR[DEFAULT_SANDBOX_VM_TIER]`, so the pair cannot drift.
  An unrecognised tier name prices at the DEAREST measured tier — note the sandbox itself PROVISIONS
  the cheapest in that case, which is deliberate: each side fails in its own safe direction) and
  `SANDBOX_EST_VM_HOURS_PER_KCREDIT` (the operator ESTIMATE, 8.33 ≈ CREDITS.md's ~120 credits per
  active build-hour, inverted). A nonsensical override falls back rather than being obeyed — obeying
  `0` would silently restore the belief this retires.
- `effectivePackMargin()` is `packMargin()` with VM overhead added to the cost side, and
  **`billing.spec.ts` and `subscriptions.spec.ts` assert every active pack AND PLAN still clears
  `MIN_PACK_MARGIN` after it** — plans are a second, independently editable price array, which is why
  they need the second floor too (a repriced plan can clear the LLM floor and fail this one). The same
  floor discipline that caught the packs shipping at 0.84×. Measured today at the Nano default:
  **2.67× / 2.53× / 2.41×** (Starter / Pro / Studio), i.e. ~63% / 61% / 58% GM, which is exactly
  CREDITS.md's ~58–63% band (Pico's 3.21× / 3.04× / 2.89× is graded too, as its own case). The specs
  also assert the **CEILING**: at Micro ($0.298/hr) the Pro and Studio packs and every plan fall under
  `MIN_PACK_MARGIN` — so Nano is the last tier the current prices support.
- ⚠️ **Never restore a failing floor by lowering a cost input or raising `CREDIT_MARGIN` to cover it.**
  Same rule as `rates.ts`: these are the numbers we PAY. A failing floor means the pack price or the
  estimate is wrong, and both of those are answers.
- Applied to BOTH providers by owner decision until real per-provider numbers exist. `5.0` restores
  the ~75% target under the placeholder. Full derivation and operator guidance stay in **CREDITS.md
  §"Sandbox compute"** — and the two documents must keep agreeing, since the placeholder's
  credits-per-active-hour assumption IS `SANDBOX_EST_VM_HOURS_PER_KCREDIT` inverted. The end state is
  metering, at which point the placeholder comes OUT of the margin.
> ⚠️ **SUPERSEDED 2026-07-29 (§4.4a). The section below describes a mechanism that has been RETIRED**,
> and is kept because it explains the shape of the replacement. Under the project-first flow there is no
> creation TURN to price: New Project clones the pinned starter, installs it and serves it without
> running a generation at all, and carries its own flat charge at registration (`PROJECT_CREATE_CREDITS`,
> ledger reason `project_create`). The first BUILD turn bills cost-derived like every other turn.
> `CREATION_FLAT_CREDITS` is now **REFUSED** — `getBillingConfig` throws a `NotConfiguredError` naming
> the replacement, on the retired-KIE-price-var precedent. `decideCredits`' `flat`/`maxCredits` levers
> and the gate's `minimumCredits` wall survive as tested-but-uncalled capability (`creation-flat.spec.ts`
> pins both the refusal and the levers).

🔴 **CREATION TURNS ARE FLAT-PRICED (2026-07-28, `creationFlatCredits`, default 500, env
`CREATION_FLAT_CREDITS`) — RETIRED, see the banner above.** The cost-proportional formula above is the DEFAULT for every turn except
the one the product is sold on: a creation's cost is dominated by prompt-cache luck (the same creation
measured **54 credits warm vs 430–633 cold** — cache writes at 2×, reads at 0.1×, KIE warming per
backend), a 12× spread the user can neither see nor influence. So the creation turn (detected by the
same `CREATION_BRIEF_MARKER` predicate the proxy already computes — never a second predicate) charges
ONE number and the platform absorbs the variance; that is what the margin is for. Rules, each of which
fails silently if broken:

- The override lives INSIDE `settleGeneration` (`decideCredits`, pure + exported like `decideModelTier` —
  it spends/waives money without the user asking), so the `generations` row, the ledger debit, the
  auto-refund, and the client `credits` annotation cannot disagree about the number.
- `raw_cost_usd` is STILL the true token-derived cost — the Admin report watches realized margin
  (flat revenue vs true cost) per creation. Overriding the cost instead of the credits blinds it.
- A **Stop** mid-creation charges `min(consumed, flat)` (`maxCredits`) — §4.12 bills what was consumed,
  and the advertised price is a ceiling: never more than the flat price for less than a creation.
- A generation that consumed NOTHING stays free even when a flat price is set — flat pricing charges
  for a creation, not for an instant failure. A failed creation settles flat then auto-refunds flat,
  same net-zero as today.
- The pre-flight gate takes `minimumCredits = flat` on creation turns only: the one turn whose price is
  knowable up front is refused honestly (402 naming price and balance) instead of landing 490 negative.
  BYOK and unenforced modes bypass, as ever. Ordinary turns still gate on "balance > 0" — their cost is
  unknowable pre-flight and the one-generation overshoot stays the accepted design.
- `0` disables (operator escape hatch back to cost-proportional); negative/garbage → default 500.
- The ledger debit note appends `— flat creation price` so reconciliation doesn't read a 500-credit
  debit beside a $0.20 raw cost as a mis-bill.

The companion lever is the **base-prompt cache warmer** (`prompt/cache-warmer.ts`): it keeps the one
byte-identical-for-everyone block warm (platform-paid, no `generations` row, no ledger entry — ops
spend by design) so the AVERAGE true cost under the flat price falls. It cannot warm per-project bytes;
`spec/context-budget.md` §"Levers that are NOT built" records the shared-starter prefix restructure
that could.

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

## Entitlements (Pro Tools) — RETIRED 2026-07-20

> **RETIRED.** The external ASMX license service (`licenser.asmx`) and its `ValidateSubscription` operation are no longer called: the SOAP client is deleted, `refreshEntitlement`/`linkSubscriberEmail` and the `/api/entitlement` route are removed, and `getEntitlement` returns the stored row without revalidating. BYOK/Pro is disabled by default (`PRO_FEATURES_ENABLED=false`) and is a **manual, testing-only** knob; the `entitlements` table and `resolveByok` remain but are inert. The only subscription signal the platform reads is the live **Stripe** plan, consumed solely by the Unity Editor subscription check (SPEC §4.18a) to answer whether a developer has paid. (It previously also picked a tier for the Unity Project Licenser, which was removed 2026-08-30.) See SPEC §4.6.1. The historical design below is kept for context only.

- ~~`ValidateSubscription(email) → {active, tier: indie|small_business|enterprise, expiry}`~~ (retired); server-to-server (shared secret min., mTLS preferred); timeout 5s; response cached 24h per user.
- Lifecycle: check on sign-in + daily job for active entitlements + freshness check when honoring BYOK. Fail-open grace: service unreachable ≤72h → status unchanged. Explicit `active:false` → `status='lapsed'` → BYOK no longer honored; fall back to credits with notice.
- The entitlement's platform effect is a single boolean capability: BYOK honored. Tier recorded for display/analytics; all tiers identical at launch.
- Email-mismatch link flow: user submits license key / subscription id / payer email → verified against license service → `entitlements.subscriber_email` set. Self-serve UI; log for support.

## UI surfaces

Balance chip, per-message cost badge (shows 'BYOK' for Pro-key generations), billing page (packs, history from ledger, Pro/BYOK status panel), zero-balance upsell (buy credits / go Pro for BYOK).

## Flags & caps

`BILLING_ENFORCED` (gate on/off; recording always on), `SIGNUP_GRANT_CREDITS`, `DAILY_TOKEN_BUDGET` (platform breaker), per-user rate limits. Anthropic Console spend caps are the backstop of last resort.

## The Marketplace price list (2026-07-18; PER PROVIDER since 2026-08-10) — where every gateway price lives

> 🔴 **THE LIST IS SCOPED TO A GATEWAY.** Immutable versions + an active pointer **per provider**
> (`activeMarketPrices(provider)` sync on the billing path, `ensureMarketPrices(provider)` at the async
> doorways). KIE's storage keys are unchanged, so nothing migrated. Two gateways reselling the same
> models at different prices cannot share one document, and the failure of pretending otherwise is
> silent: whichever list was promoted last would price the other gateway's turns.
>
> ⚠️ **The doorway must ensure every provider the ladder could SELECT**, not just `LLM_PROVIDER`
> (`providersToPrice`). Ensuring one and laddering to another gates and settles the selected gateway
> from its BAKED table while the operator's promoted list sits unread — the same mis-bill, one door over.
>
> **Comet's feed quotes OFFICIAL vendor rates; the charged rate is `pricing × ratio`, READ PER ROW.**
> Not a constant: three rows carry `1.0`, so a hardcoded `0.8` would under-charge exactly the newest and
> most expensive models.
>
> 🔴 ⚠️ **AND COMET'S FEED WAS RIGHT ABOUT SONNET 5 WHILE OUR OWN TABLE WAS WRONG (2026-08-12).** This
> paragraph read: *"`MODEL_RATES['claude-sonnet-5']` was verified and deliberately left at $3/$15 — Comet
> reporting the official $2/$10 confirms the introductory-pricing note in `rates.ts` rather than
> contradicting it."* The $2/$10 Comet reported was the **standard** rate, not an expiring one, and the
> "confirmation" reading kept a 1.5× over-charge in place on the platform's default model for weeks.
>
> **The lesson is about which source wins a disagreement.** An independent capture of the vendor's own
> number was reporting the truth and was explained away in favour of a hand-maintained table, because a
> plausible explanation was available — and one that was *unfalsifiable from inside this repo*: nothing
> here could tell "the feed shows the intro rate" from "the feed shows the current rate" without reading
> the vendor's page. **When a captured source contradicts a hand-maintained one, the burden of proof is on
> the hand-maintained one, and "we know why they differ" is a claim with an expiry date.**
>
> **What the user SEES of all this (2026-08-10, `billing/savings.ts`, `billing/ledger-view.ts`).**
> Credits are cost-proportional, so a cheaper gateway is the user's purchasing power, not our margin —
> and it was invisible. The `/context` panel names the serving provider and the turn's saving; the
> credits panel carries a headline total **with its scope** and a per-row `saved N`, and rows are
> labelled by `generations.status_kind` so a creation build, an edit, an auto-repair and a plan stop
> reading as four identical "Generation" rows. Three rules, each of which printed a flattering number
> when broken: the reference is **`MODEL_RATES` directly, never `providerRates().Anthropic`** (which
> gap-fills paid-rung models at marketplace rates); the comparison is a **USD ratio against the recorded
> `raw_cost_usd`**, so a `CREDIT_MARGIN` change cannot retroactively invent a discount; and the function
> **cannot throw**, because it runs on `/api/credits`. Anything unanswerable returns `null` and the UI
> says nothing at all.

**One versioned document PER PROVIDER holds everything the platform believes that gateway charges
us.** ⚠️ This opened *"everything the platform believes **KIE** charges us"* until 2026-08-11 — true
when there was one gateway, and false from the moment a second shipped (T4). The KIE keys were left
untouched so nothing migrated, which is exactly why the singular kept reading as correct: the storage
layout for the incumbent did not change, only the number of layouts. The document holds the LLM token rates
(`llm`: model → input/output USD per MTok) and the per-task media prices for §4.16 image/video
generation (`media`: model → variants of options → USD, per_image / per_second / per_video). It is
doc-sync rules applied to money, mirroring the §4.4 template pin:

- **Baked fallback in code** (`billing/baked-market-prices.ts`) — captured from KIE's own public
  pricing feed (`POST api.kie.ai/client/v1/model-pricing/page`, 372 rows, 2026-07-18), which
  independently confirmed the measured LLM rates to the cent (4-8 $2/$10, 4-7 $1.425/$7.15, fable-5
  $4/$20). `claude-opus-5` (the §4.6.1a **Premium** rung; platform default 2026-07-27 → 2026-07-31) was added at 4-8's exact $2/$10 —
  owner-confirmed, with cache accounting probe-verified against KIE's own usage numbers the same day
  (writes and reads REPORTED, unlike the 4-7/fable rows that report 0 write while being charged).
  Billing can never find "no prices".
- **A list MUST price the platform default model (owner rule, 2026-07-27).** `validateMarketPriceList`
  refuses a list whose `llm` table lacks the `DEFAULT_MODEL` row — at PROMOTE and at LOAD
  (`loadVersion` re-validates stored bytes, so a legacy list missing the row fails to load and baked
  serves instead). Without this, an omitted default would bill every ordinary generation at the
  most-expensive row's rates — `claude-fable-5`'s (the retired SuperMax rung's model; still the top of
  the baked table), and since the default moved to `claude-sonnet-5` ($0.85/$4.275 baked on KIE) that
  is **~4.7×** the default rather than the 2× this line said while Opus 5 was the default. A paid rung can never become the default's effective price
  through any path (`market-prices.spec.ts` + `market-price-store.spec.ts` pin both doors).
- **Admin-promoted active list** (`billing/market-price-store.ts`): immutable versions in the
  ObjectStore, keyed PER PROVIDER (`pricing/kie-market/versions/mp_*.json` for KIE, and its sibling
  prefix for each other gateway — the KIE prefix is unchanged so no stored bytes moved) + an
  `active.json` pointer per provider. Promote validates
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
  SELECTORS, accepted only if the active list prices them in their own right (`kieDefaultModel`,
  `getModelTier`/`getModelTiers` — SPEC §4.6.1a). ⚠️ **`SUPERMAX_MODEL`, `SUPERMAX_MINIMUM_CREDITS` and — TODAY — `ENABLE_PREMIUM_MODEL`
  are the retired-and-refused model-tier names; the LIVE master switch is `ENABLE_EXTENDED_MODELS`**
  (`premium-model-flag.ts`, default ON, with `ENABLE_PLATINUM_MODEL` gating the top rung). 🔴 **This
  paragraph said the exact INVERSE until 2026-08-11** — that `ENABLE_EXTENDED_MODELS` was refused and
  `ENABLE_PREMIUM_MODEL` was the flag. That was true between 2026-08-08 and 2026-08-10, and the
  polarity flipped back when the second paid rung returned as `platinum` (`claude-fable-5`,
  `PLATINUM_MINIMUM_CREDITS` 2000). ⚠️ **The refused name is always whichever one is NOT currently
  read — take it from `premium-model-flag.ts`, never from a document.** And note HOW this survived:
  the same correction was applied to `SPEC.md` §4.6.1a and to `CLAUDE.md` on 2026-08-11 and **this
  third document was missed in both passes**. The lesson the second pass wrote down — *a polarity fix
  applied to one document is half a fix* — turned out to have a third half. When a fact lives in three
  documents, grep for the VARIABLE NAME across all of them; fixing the two you remembered is how the
  third goes on teaching the inverse. Same rule, different family of variable:
  a var nothing reads is a configuration the operator believes they have. Their refusal lives in
  `billing/premium-model-flag.ts` and is called from `getModelTier` (so `/api/me` degrades and only the
  money path throws), never from `kieRates`, which runs on every settlement. A selector is never a
  price: naming a model the active list cannot price is a `NotConfiguredError` pointing at the panel,
  never a silent fallback to some other row's rates.
- **Cache rates are never quoted in the list** — validation refuses the keys. They derive per row
  (0.1× read / 2.0× 1-hour write, measured on KIE), so a promoted reprice moves the whole row and a
  half-repriced row cannot be expressed.
- **🔴 …AND THAT RULE IS NOW PER-FAMILY — EXTENDED, NOT BROKEN (2026-08-04, `spec/model-families.md`).**
  The rule above protected against a row half-priced from two sources. It still does. What changed is
  that "derive it" stopped being a correct answer for every family, so the refusal became a policy
  keyed on the model id's family (`model-families.ts` `cacheProfile`), enforced by
  `validateLlmCachePolicy` and consumed by `llmRatesFromList`:
  - **`claude-*` → `derived`.** Unchanged, byte-identical. `cachedInputPerMTok`/`cacheWritePerMTok`
    are **REFUSED** on these rows; read/write derive 0.1×/2.0× from the row's own input rate.
  - **`gpt-*` → `explicit-pair`.** The row must quote **BOTH** rates, **atomically** — both or
    neither, never one. A row quoting only Cached Input would leave the write derived at 2.0× of an
    input rate KIE does not use for writes, which is the *original* half-priced-row bug surviving
    into the family that needs quotes; a row quoting neither is the same bug with both halves
    derived. ⚠️ `llmRatesFromList` passes `number | undefined` straight through and `ratesFromBase`
    reads `undefined` as "derive", so **validation at the wall is the ONLY thing standing between a
    gpt row and Claude's 0.1×/2.0×** — there is no honest default for a price the vendor publishes.
  - **`gemini-*` → `none`.** The pair is REFUSED, and cached tokens bill at the **FULL INPUT RATE**
    (read = write = input). Never a discount we cannot verify KIE grants, never a surcharge we cannot
    observe. **The consequence is real and intended — a warm Gemini edit costs what a cold one costs
    — so the Admin margin report must not read that as a caching regression** (owner decision,
    flagged and accepted 2026-08-04).
  - An **unknown family** on an `llm` key is REFUSED with an error naming the accepted prefixes and
    the dashes-not-dots id rule — the same reasoning as `requireFamily` throwing at model resolution:
    pricing a model whose wire (and therefore whose cache economics) we cannot name is the
    "priced but not LISTED" trap approached from the other side. (`llmRatesFromList` falls back to
    `derived` for such a row, which is unreachable through validation and is deliberately the answer
    the function has always given rather than a new opinion.)

  **The evidence that forced this — one number.** KIE's feed publishes four prices for each gpt-5.6
  row, and the WRITE is **1.25× input, not the 2.0×** every Claude row derives (sol $1.4 input /
  $1.75 write; luna $0.056 / $0.07; terra $0.56 / $0.70 — the READ is 0.1× on all three, coinciding
  with Claude). 1.25× is the **five-minute** cache tier; KIE does not resell the 1-hour tier on that
  surface. Deriving these would have over-charged the write class by **60% on every cold turn**,
  silently, with nothing throwing. **A rule that holds for one family is not a rule** — and the only
  way to find that out was to read the vendor's own numbers. If a future row breaks the 0.1× read
  pattern too, **quote it, do not infer it**.

  **✅ RECONCILED AGAINST KIE'S OWN BILLING, 2026-08-04** — the second source the late Claude rows
  never got. Method (reproducible, `spec/model-families.md` §9.4): read the account credit balance,
  run a real generation, read it again, convert at **$0.005/credit** (KIE prices every CHAT/TOKEN row
  at exactly that — 70 of 71 feed rows exact to 8 decimals), compare against our computed raw cost.
  ⚠️ **Not universal — the one outlier found was a MEDIA row** (veo 3.1 4K, 380cr/$1.85 = 0.004868),
  so do not carry this conversion into §4.16 pricing without re-deriving it.
  - `gpt-5-6-sol`: ours $0.004586 vs KIE $0.004600 → **ratio 0.997**. 🔴 **This confirms the OUTPUT
    rate ONLY** — KIE reported ZERO input tokens, so any input price reproduces that figure to the
    digit, and the run cached nothing. **Measure a row's CACHE accounting before making it a default
    rung** (that check is exactly what disqualified `claude-opus-4-7` and `claude-fable-5`, both of
    which report zero cache-write tokens while being charged the 2×).
  - `gemini-3-5-flash`: counting **candidates only** as output → ratio **1.001** ✅; counting
    candidates **+ thinking** → 1.674 ❌. **KIE does not bill Gemini thinking tokens**, and we match
    only because `@ai-sdk/google@1.2.22` maps `completionTokens` from `candidatesTokenCount` alone
    and drops `thinkingTokenCount`. Our correctness is INHERITED from that SDK's choice, not asserted
    by us. 🔴 **TRIPWIRE: an SDK bump that folds thinking into `completionTokens` — the natural thing
    for it to do — would immediately over-charge every Gemini generation by ~1.67×, silently, with
    nothing throwing. Re-run this reconciliation on any bump of `@ai-sdk/google`.**

  **🔴 The gpt Cache Writes price is quoted and, today, never applied.** KIE returns
  `input_tokens_details.cache_write_tokens` and `@ai-sdk/openai@1.3.24` maps it to no
  `providerMetadata` key at all, so `cacheCreationTokens` is **structurally always 0 on codex**. That
  is an UNDER-charge — the safe direction, per `rates.ts`'s rule that every fallback errs in our own
  disfavour — so it is recorded rather than worked around, and it is deliberately NOT "fixed" in
  `usage-metadata.ts`, which receives the SDK's normalized metadata and not KIE's response body.
  Both captured values were 0; revisit only when a real generation reports a non-zero one.
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
- **Project-creation debits (§4.4a, migration 0015) are the `'media'` shape, and the reason they exist
  is that there is no longer a creation TURN to price.** Ledger reason `'project_create'`, a flat
  `PROJECT_CREATE_CREDITS` (default 150, `0` disables and writes no row at all — a zero-value entry is
  noise, not an audit trail), **QUOTED before the project row exists and DEBITED after it**, in `POST /api/projects`
  (`quoteProjectCreate` → 402 → `store.create` → `debitProjectCreate`) — the refusal must leave no row
  behind, and the debit's audit note is the project id, which does not exist until the row does. Never
  allowed to go negative (absent from `mayGoNegative`; enforced +
  insufficient → **402 naming the price and the balance, with ZERO project rows and ZERO ledger rows
  written**). The posture follows the same reasoning as `'media'` vs `'search'`: it debits before
  anything is provisioned, so it must REFUSE rather than overdraw — the opposite of `'generation'`,
  whose overdraft allowance exists only because settlement runs after the spend has happened.
  Not anchored to a `generations` row (generation_id null, like `'grant'`/`'search'`). The new balance
  rides back on the response so the client can settle it without a second round trip — the enhancer's
  drifted-balance defect is the precedent: a settled charge the UI cannot see reads as a leak. A debit that throws AFTER the row exists (a concurrent
  creation drained the balance between quote and debit) **rolls the project back and returns a
  retryable 402** — an unpaid project is worse than a refused one, because nothing downstream would
  ever notice it — and the rollback is reported by its RESULT, with an `UNPAID PROJECT` error log if
  even that fails (never a `catch` that logs success). Refund
  lives on the **server DELETE path**, when a project is deleted having never had a completed
  generation — that is the observable definition of "creation did not deliver", and it correctly
  declines to refund someone who built a game and then deleted it. It is deliberately NOT hung off
  `rollbackRegisteredProject`, which is fire-and-forget and never rejects: a refund there is a refund
  that can silently not happen. ⚠️ This is the ONE thing permitted to stop a project being created
  (§4.4a's "nothing else should be able to stop the project from getting created"), and it is allowed
  because it refuses BEFORE anything is provisioned — a clean, described 402 leaves nothing half-made,
  which is categorically different from a mid-creation failure. Pinned by `project-create.spec.ts` +
  the route specs + `ledger-sql.spec.ts`.
- **The `'license'` ledger reason is GONE, and its schema was DELETED rather than migrated away
  (SPEC §4.18, 2026-08-30).** The Unity Project Licenser debited it as a flat per-tier charge before
  issuing a `license.json`. A first pass kept the reason readable "because the ledger is append-only"
  and added a migration to drop the table; the owner correctly rejected that — **the platform has never
  been deployed**, so a first deploy would have created the column and table only to drop them. So
  migrations `0011`/`0012` are deleted from the repo, `'license'` is out of `0015`'s CHECK constraint,
  out of `LedgerReason`, out of `ledger-display.ts` and out of `money-paths.spec.ts`, and the numbering
  gap at 0011/0012 is deliberate. 🔴 **The append-only rule was not broken, it had nothing to protect** —
  it exists to stop a schema edit invalidating rows a live database holds, and the local FS ledger was
  grepped first (zero `license` rows). **That licence is one-time and expires at the first deploy:**
  after a database exists, removing a ledger reason must again be a forward migration that leaves the
  value readable.
- **🔴 ANTHROPIC SELLS FABLE 5 AND `MODEL_RATES` DENIED IT — THE PLATINUM RUNG WAS UNDER-BILLED BY 2.5×
  (found + fixed 2026-08-12).** `PLATINUM_MODEL=claude-fable-5` is live and `Anthropic` is the last rung
  of `LLM_PROVIDER_CHAIN`, and there was no `claude-fable-5` row in the Anthropic table — three comments
  in `rates.ts` gave the reason as *"Anthropic does not sell it"*. Anthropic sells it at **$10/$50**. So
  `providerRates`' gap-fill did not fill a hole, it **substituted KIE's $4/$20 for a price Anthropic
  publishes**, and the platform ate ~60% of the cost of every Anthropic-served Platinum turn. That is the
  exact mirror of the 231-vs-576 defect this same function is guarded against — same mechanism, opposite
  direction, and the direction where the credit count goes DOWN and reads as a cheaper turn.
  - ⚠️ **It retro-corrected a measurement four documents reasoned from.** *"On Anthropic the fable-5 rung
    settled 814 credits against Opus 5's 1,017"* was quoted as evidence that the ladder is not
    cost-monotonic on Anthropic. **814/1017 is exactly 4/5** — it is the gap-filled $4/$20 rate, i.e. the
    mis-bill itself. At the true $10/$50 the same turn is ~2,035 credits and **the ladder is cost-monotonic
    on every gateway** (Anthropic $2/$5/$10, Comet $1.60/$4/$8, KIE $0.85/$2/$4). Rungs still order
    CAPABILITY and must not be reordered by price — the rule survives, its counterexample does not.
    **A rule justified by a measurement inherits that measurement's bugs.**
  - ⚠️ **A row in `MODEL_RATES` is a statement that the platform may SERVE that model**, since it is what
    `getPlatformModel` and the ladder validate a selector against. Anthropic's published rows for Opus
    4.5/4.6/4.7, Sonnet 4.5/4.6 and **Mythos 5** ($10/$50, limited availability) are deliberately ABSENT:
    absent means `LLM_MODEL=claude-opus-4-7` on Anthropic is a loud config refusal rather than a live model
    nobody vetted. **"The vendor publishes a price" is not a reason to add a row; "a selector names it" is.**
  - ⚠️ **Every "fill case" in the specs had to be re-anchored to a `gpt-*` id.** Four tests used fable-5 as
    the model "Anthropic bakes no row for", so they asserted the under-charge as correct and one CONTROL
    stopped controlling anything. **A fill case must name a model the vendor is structurally incapable of
    pricing, never one it merely has not priced yet.**

- **⚠️ THE 4.7+ TOKENIZER PRODUCES ~30% MORE TOKENS FOR THE SAME TEXT (vendor note, 2026-08-12) — no code
  change, two things to stop getting wrong.** Claude 4.7 and later (Opus 4.7/4.8/5, Sonnet 5, Fable 5,
  Mythos 5) use a newer tokenizer; **Sonnet 4.6 and earlier, including Haiku 4.5, use the previous one.**
  - **Char budgets are not token budgets, and the gap widened.** `MAX_READ_CHARS`, `AGENT_MAX_PLAN_READ_CHARS`,
    `MAX_INSTRUCTIONS_CHARS`, `ASSET_INDEX_CHAR_BUDGET` and `MAX_SCHEMA_CHARS` are all denominated in CHARS,
    so the old "≈4 chars/token" folk rule under-states their real cost on every model we run: 80k chars is
    ~26k tokens, not ~20k. The budgets are still correct as *bounds* — nothing is mis-billed — but anyone
    sizing one by that rule of thumb will be ~30% optimistic.
  - **A cross-model rate ratio is not a cross-model cost ratio.** Haiku 4.5 at $1/$5 against Sonnet 5 at
    $2/$10 looks like 2×; Haiku is on the OLD tokenizer, so it also emits fewer tokens for the same text and
    the effective gap is wider than the rate card implies. That makes the cheap-model lever
    (`<PROVIDER>_ENHANCE_PROMPT_MODEL`) *better* than it looks — the safe direction — but it also means
    `charsPerOutputToken` is **not comparable across the tokenizer boundary**: the ~2.0–2.2 healthy baseline
    for code was measured on Opus 4.8 (new tokenizer), and the same healthy output on Haiku reads higher.
    Do not diagnose an old-tokenizer model's density against a new-tokenizer baseline.

- **🔴 `providerRates` injects EVERY paid rung, FILL-A-GAP AND NEVER OVERWRITE, non-throwing.** A
  promoted list that unprices a rung's selector refuses NEW requests for that rung loudly
  (`getTierModel`) but must not take settlement down — an in-flight generation settles via the
  most-expensive fallback. Two properties, both silent when broken: **(a)** each rung is resolved in
  its own try/catch, so one broken selector cannot drop another rung's row; **(b)** a provider that
  prices a model NATIVELY is the authority and the injection only ever fills a hole. (b) became
  load-bearing the moment Premium moved to `claude-opus-5`, which Anthropic prices itself — while
  `PREMIUM_MODEL` was `claude-fable-5` (no Anthropic row) filling and overwriting were the same
  operation, so an unconditional overwrite would have looked correct forever. Measured live
  2026-07-31: Premium on Anthropic billed **$2.5414 = the native $5/$25 exactly**; the KIE-shaped
  $2/$10 would have billed $1.0166 — **407 credits instead of 1,017**.
- **A tier threshold binds on the BALANCE, regardless of `BILLING_ENFORCED` (2026-07-18)**:
  `decideModelTier` takes no enforcement flag. The retired "unmetered → premium freely
  usable" bypass rested on a false premise — settlement debits the ledger whether or not the gate
  may refuse, so a 320-credit user could switch on an expensive rung and ride the balance negative with
  nothing objecting (observed live). A deploy that wants a free paid rung says that rung's
  `*_MINIMUM_CREDITS=0` explicitly. Pinned by a structural tripwire in `premium.spec.ts` (no
  enforcement input exists to bypass with).
- **A CREATION turn never runs a PAID RUNG (2026-07-18)**:
  `decideModelTier({ isFirstBuildTurn: true })` → `reason: 'creation_turn'`, whatever the balance,
  for every rung carrying `firstBuildLocked` (all of them today). KIE serves Fable 5 with a BUFFERED answer
  (accepted for edit-sized replies); a creation-sized artifact (~25k out tokens, 4–7 min decode)
  cannot flush before KIE's ~5-min gateway timeout — measured live: 307.8s of streamed reasoning,
  0 text, `finish=error` at 449s. The lock was GENERALIZED to the whole ladder rather than kept on
  the rung that produced it: the first build is the largest artifact in the product, so the safe
  assumption is that the next expensive model has the same problem until a live drive says otherwise.
  Creations run the platform default; every paid rung unlocks from the first edit turn. `ModelTierPill`
  mirrors this as a locked state (`creationTurnStore`), and the picker row states the creation reason
  rather than a threshold — telling a funded user to "add credits" here would be a lie that costs
  them money.

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

  **✅ FIXED 2026-07-17 — sticky block routing** (`selectStickyBlocks`; the `stickySkillNames` half was deleted 2026-07-26 — `spec/skills.md`; see
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

- Signup grant fired **exactly once**: `grant +1000 → 1000` — which is also the LIVE `SIGNUP_GRANT_CREDITS` default (`rates.ts`; this line claimed 1000 was historical and 800 current until 2026-07-31, contradicting its own transcript one clause earlier). It sits deliberately below BOTH shipped tier thresholds (`.env.example` ships `PREMIUM_MINIMUM_CREDITS=1500`; the in-code default is 1200), so a fresh grant cannot buy a paid rung — §4.6.1a.
- A live generation settled against real usage: `generation −7 → 993` (raw cost $0.0184,
  `cacheReadTokens: 60121` — the 1h cache from §4.2.8 still hitting).
- The `generations` record attributes the charge to a user, a model, and its four token classes.
- `PRO_FEATURES_ENABLED=false`: **zero** model names, provider names, `<select>`s, or API-key inputs in
  the DOM. `=true`: BYOK unlocked, Model Settings appears, Pro badge renders.
