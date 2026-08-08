# CREDITS.md — operating the credit system

Practical guide for the platform operator. The design lives in [SPEC.md](SPEC.md) §4.6 and
[spec/billing.md](spec/billing.md); this is the "what do I actually type" file.

## TL;DR — give yourself credits (local dev)

```bash
pnpm credits                      # print the whole ledger + current balance
pnpm credits 25000                # top up
pnpm credits 25000 "why I did it" # top up with a note (do this)
pnpm credits -500 "clawback"      # negative works too
```

Nothing else is needed to keep building: with `BILLING_ENFORCED=false` (the default) **you cannot be
blocked anyway** — see below.

---

## The three things that trip people up

### 1. You are probably not actually blocked

`BILLING_ENFORCED` defaults to **false**. The gate then returns `unmetered`: usage is still recorded
in full, but **no generation is ever refused**. That is why the header tooltip reads *"credits are not
enforced on this server"*, and why the balance will happily run negative in local dev.

Turning enforcement on is a single flag:

```bash
BILLING_ENFORCED=true    # .env.local
```

**Two things enforcement does NOT change (2026-07-18):** the **paid-tier thresholds** bind on the
balance either way (settlement debits regardless, so a 320-credit balance cannot switch on an
expensive rung even unmetered — a deploy that wants a free paid rung sets that rung's
`PREMIUM_MINIMUM_CREDITS=0` explicitly),
and **media generation debits** (§4.16) are taken up-front either way and refuse at 402 rather than
overdraw — the `media` ledger reason may never go negative.

### 2. The balance is DERIVED, not stored

There is no `balance` column and no counter anywhere. The balance is the `balance_after` of the most
recent ledger row.

This is why you should not hand-edit the ledger file: if you append a row and compute `balance_after`
wrong, **every balance after it is silently wrong** and nothing throws. `pnpm credits` reads the last
row and does the arithmetic for you.

The reason it is built this way: a mutable counter loses updates under concurrency (two generations
both read 100, both write 60) and can never answer *"where did my credits go?"*. An append-only log
can always answer both.

### 3. Local mode ≠ production

| | Local dev | Production |
|---|---|---|
| Ledger | `.data/ledger/<user-id>.jsonl` | Postgres `credit_ledger` |
| Top-up | `pnpm credits N` | admin endpoint (see below) |
| Can you hand-append? | Yes | **No — by design** |

In production `credit_ledger` has **no INSERT policy at all** (a user cannot append their own
credits), a trigger **refuses UPDATE and DELETE** outright, and `balance_after` is computed inside
`append_ledger_entry()` — a `security definer` function holding a per-user advisory lock. So the
file-edit trick has no production equivalent, deliberately. `scripts/credits.mjs` refuses to run when
`NODE_ENV=production`.

**Production top-ups go through `POST /api/admin/credits`** (`app/routes/api.admin.credits.ts` —
BUILT, §4.10) — `requireAdmin`-gated, takes `{ userId, delta, note }`, and writes through the SAME
append-only ledger as everything else (`reason: 'adjustment'`), so the top-up is auditable forever.
The Admin settings tab exposes it as the credit-adjustment control.

---

## Reading the ledger

```
14:36:39  grant         +1000  ->    1000   Welcome — starter credits
15:01:14  generation     -716  ->    1527   claude-sonnet-5: 213348 in / 44308 out
15:39:43  generation     -289  ->     976   claude-sonnet-5: 695 in / 33777 out
16:10:22  adjustment   +25000  ->   25976   Admin top-up — platform owner
```

Every row is permanent. A mistake is corrected by appending a compensating row, never by editing or
deleting — that is what keeps the history able to explain the balance.

### Reasons

| Reason | What it means | May go negative? |
|---|---|---|
| `grant` | Signup credits. **Once per user, ever** — enforced by a partial unique index, not an app check. | no |
| `purchase` | Stripe pack. Idempotent on the session/payment id via a partial unique index. | no |
| `generation` | An LLM build, charged against real token usage. | **yes** |
| `media` | An image/video render (§4.16), debited UP-FRONT at the exact quoted price. Refuses at 402 instead of overdrawing (migration 0009); auto-refunds exactly once on a failed render. | no |
| `refund` | Compensating row for a hard-failed generation or render (auto). | no |
| `promo` | Marketing credits. | no |
| `adjustment` | **An operator reached in and moved the number.** This is the one `pnpm credits` writes. | **yes** |

Only `generation` and `adjustment` may drive the balance negative. `generation` must be allowed to,
because §4.2.1 forbids killing an in-flight build for balance — the gate runs once, before the model,
and settlement afterwards **can never refuse**. So a build that overshoots goes negative and the *next*
gate catches it. Exposure is bounded to one generation, which is the price of never yanking a game out
from under someone mid-build.

Use `adjustment` for operator top-ups rather than forging a `grant` (which would corrupt the
once-per-user grant story) or a `purchase` (which would put money in your books that never existed).

---

## What a build costs

Credits are priced from real token usage, at the rates in the **Marketplace price list** (Settings →
Admin → Marketplace prices — a versioned, admin-promoted document with a baked fallback in
`billing/baked-market-prices.ts`; the old `*_DOLLARS` env vars are RETIRED and refused, 2026-07-18):

```
raw_cost = in·inputRate + cache_read·(0.1×inputRate) + cache_write·(2×inputRate) + out·outputRate
credits  = ceil(raw_cost / CREDIT_UNIT_COST_USD × CREDIT_MARGIN)
```

Current baked rates (per MTok, KIE), by SPEC §4.6.1a rung: Sonnet 5 (**Standard** — the platform
default since 2026-07-31) **$0.85 / $4.275**; Opus 5 (**Premium** — the default 2026-07-27 →
2026-07-31, at its predecessor Opus 4.8's exact price) **$2 / $10**; Fable 5 **$4 / $20** (the SuperMax rung's model until that rung was retired 2026-08-08; still priced, and reachable by pointing `PREMIUM_MODEL` at it, which the owner's deploy does). Cache rates always DERIVE from the row — 0.1× read, **2×** write (the 1-hour tier,
§4.2.8; assuming the 1.25× headline number under-charges every generation and nothing throws).

Measured on KIE (2026-07-16/17, `spec/context-budget.md` §MEASURED) **at the old margin 3.34** — at the
current `CREDIT_MARGIN = 4.0` every figure below is ~1.2× higher: a full playable-game creation ran
**163–513 credits** (→ ~195–615 at 4.0) depending on difficulty; a **warm edit is ~11–65 credits** (→
~13–78; sticky block routing); a trivial edit measured **18** (→ ~22). **Media is billed separately per
task** (§4.16): a 2K image is ~24 credits at 4.0, a video clip runs from ~60 (veo3_lite) into the
hundreds (kling-3.0 pro) — debited up-front at the exact price shown on the Generate button.

The 1000-credit signup grant (`SIGNUP_GRANT_CREDITS` default) is ~3.7× a measured KIE build turn at
margin 4.0 (guarantees one free game + iteration), and deliberately BELOW both shipped tier
thresholds (1500/1500), so a fresh account cannot burn its grant on a paid rung. Every paid rung is
also **edit-only**: the first build turn always runs the platform default
(`decideModelTier` `reason: 'creation_turn'` — KIE-buffered Fable 5 cannot flush a build-sized
artifact before the gateway timeout, and the lock was generalized to the whole ladder because the
first build is the largest artifact in the product).

> **A deploy costs money.** Tool schemas and the base prompt live *inside* the cached prefix. Change
> either and every user's cache entry is invalidated, so the next generation pays a full cache write at
> 2×. Measured: $0.51 for a one-sentence answer right after a schema edit, $0.22 for the identical
> prompt immediately after. A post-deploy cost spike is expected, not a regression.

### Creating a project is FLAT; every TURN is cost-derived (2026-07-29)

Creating a project no longer runs a generation. **New Project** clones the pinned starter template,
installs it and serves it — so there is no creation TURN to price, and the flat charge moved to
project **registration**: `PROJECT_CREATE_CREDITS` (default **150**), debited once under ledger reason
`project_create`, before anything is provisioned. The build turn the user sends afterwards is an
ordinary turn, billed by the formula above like any other.

Why flat at all, and why only here: creation cost used to be dominated by prompt-cache luck — the same
creation measured **54 credits warm vs 430–633 cold**, a 12× spread the user could neither see nor
influence. Attaching a single predictable price to the one moment the user actually clicks a button
answers "what does starting a game cost?" in one sentence, without pretending we can predict what any
particular turn will cost. Operator notes:

- **`PROJECT_CREATE_CREDITS=0` makes creating a project free.** Negative or garbage values are ignored
  in favor of the default.
- The charge is decided **before** the project row, the VM or the template fetch — so a refusal (402,
  naming both the price and the balance) leaves nothing half-made. `project_create` is deliberately
  absent from `mayGoNegative`: a debit taken before the spend it pays for must refuse, never overdraw.
- **BYOK and unmetered mode create for free**, and no zero-value ledger row is written — a `0` entry is
  noise in an audit trail, not evidence.
- Deleting a project that never completed a generation **refunds** the charge.
- Every paid rung is still **edit-only**: the first build turn always runs the platform default
  (`decideModelTier` `reason: 'creation_turn'` — KIE-buffered Fable 5 cannot flush a build-sized artifact
  before the gateway timeout; `firstBuildLocked` is per-rung data, so all of them are locked today).
- **`CREATION_FLAT_CREDITS` is RETIRED and REFUSED.** It priced the creation TURN, which no longer
  exists. Leaving it set is a pricing intent nothing honours, so the platform refuses to boot with it
  and names its replacement — the same posture as the retired `KIE_*_DOLLARS` vars, and for the same
  reason: a price variable nothing reads is a mis-bill waiting to be believed. **`=0` throws too** —
  it used to mean "creations are free", and under the replacement they are charged, so silently
  accepting it would let an operator keep believing something that stopped being true.
- The **base-prompt cache warmer** (`CACHE_WARMER_*`) still shrinks the platform's average cost per
  build: it keeps the byte-identical-for-everyone prompt block reading at 0.1× instead of writing at
  2×. Pennies/day, platform-paid, no ledger rows.
- `generations.raw_cost_usd` records the true cost of every turn, so the Admin usage report still shows
  realized margin — flat price and margin remain one decision in two knobs.

## Sandbox compute — the margin fold-in (2026-07-27, PLACEHOLDER)

`CREDIT_MARGIN` has only ever covered **LLM + media raw cost**, and that was complete while projects
ran on WebContainer: the user's project computes in their own BROWSER (~$0 marginal to us), and the
only real cost — the StackBlitz plan fee — is a fixed monthly number (SPEC §7) that a per-credit
margin cannot see. **Nothing was ever folded in for WebContainer, and nothing needed to be.**

The CodeSandbox provider (SPEC §8, `spec/sandbox-codesandbox.md`) changes the shape: the project runs
on a microVM billed by **wall clock, not tokens** — MEASURED $0.149/hr on Nano (the default
`CODESANDBOX_VM_TIER` since 2026-07-28), $0.074/hr Pico — and it accrues while the user *thinks*, not just while the
model runs. Metering is NOT built yet (no `sandbox` ledger reason, no sweep, no overdraw policy —
`spec/sandbox-codesandbox.md` §8 item 4), so today every VM-hour is an unbilled cost that comes
straight out of the generation margin.

**The placeholder, until metering ships:** assume an active build-hour bills ~120 credits (a few warm
edits plus a share of a creation — the measured ranges above). The raw LLM spend behind those credits
at margin 4.0 is ~$0.30/hr; a **Nano** hour adds $0.149 on top ≈ **+50% on raw cost** (it was +25% while
Pico was the default tier — the tier change doubled it, and the numbers below moved with it). What that
does to the numbers:

- Effective gross margin at `CREDIT_MARGIN=4.0` drops from ~72–75% (LLM-only) to **~58–63%**.
- Equivalently: one Nano VM-hour eats the margin earned by **~20 billed credits** ($0.149 ÷ $0.0075).
- To hold the ~75% GM target while sandbox time rides unmetered you would now need **`CREDIT_MARGIN`
  ≈ 8.0**, not the 5.0 this section used to quote — that figure was derived against Pico and 5.0 now
  buys only ~68%.

  🔴 **`CREDIT_MARGIN` STAYS 4.0 — owner decision 2026-07-28.** Not an oversight and not a number
  waiting to be raised: pricing is management's call, it is env/SSM-configurable, and nothing here
  forces it. Every pack and plan still clears `MIN_PACK_MARGIN` at 4.0 on the Nano default (worst case
  2.41× packs / 2.13× plans, asserted in `billing.spec.ts` + `subscriptions.spec.ts`), so this is a
  margin the business chose, not a floor being breached. **Raising `CREDIT_MARGIN` is a PRICE INCREASE
  to customers** — the same generation bills proportionally more credits, so a pack buys proportionally
  fewer generations. Treat it as a pricing decision, never as a knob for making this section's numbers
  look nicer (`vm-cost.ts` and `rates.ts` both carry that warning for the same reason).

  ⚠️ **The ≈8.0 figure assumes `SANDBOX_EST_VM_HOURS_PER_KCREDIT` is left at 8.33, and that assumption
  is wrong the moment you act on it.** That estimate is denominated in CREDITS, so it moves with
  `CREDIT_MARGIN`: at 8.0 a credit represents half the raw cost it does at 4.0, so the same VM-hour
  spans twice as many credits and the honest estimate becomes ~4.17, not 8.33. Rescale it and 8.0
  actually lands near **81%**, overshooting the target badly. Whoever changes `CREDIT_MARGIN` must
  change this estimate with it — the two are one model, and (like "raise the price with the tier"
  before it) that instruction currently lives in prose rather than in a mechanism. The margin-free way
  to state the estimate is **~$0.30 of raw LLM spend per active VM-hour**, from which the hours-per-
  kcredit figure derives at any margin; deriving it was considered and deliberately deferred
  (owner, 2026-07-28) since it fails in the SAFE direction — an unrescaled estimate over-states VM cost.
- Sensitivity: +50% assumes ~120 credits/active-hour. Lighter usage is worse (100/hr → +60%), heavier
  is better (300/hr → +20%); dropping back to Pico halves all of it. The hibernation default
  (`CODESANDBOX_HIBERNATION_SECONDS=300`) bounds the idle tail to ~5 minutes — and the placeholder is
  only honest while VMs actually get reaped (the 2026-07-27 sandbox review found orphan paths — the
  two-tab create race and `reset` overwrites — that leak VMs past the model; fix before trusting it).

**WebContainer builds use the SAME placeholder as CodeSandbox — whatever it currently is (owner
decision, 2026-07-27; +50% on the Nano default as of 2026-07-28)** — not because the
cost shape matches (it does not: browser compute is ~$0 and the StackBlitz license is a fixed fee),
but as a conservative stand-in until real numbers exist on either side. StackBlitz's
beyond-500-sessions/month pricing is unpublished, and CodeSandbox's true accrual needs the metering
sweep to measure. Replace the placeholder with measured $/active-hour per provider when either
number arrives.

**The placeholder is ASSERTED as of 2026-07-28 (`app/lib/.server/billing/vm-cost.ts`).** The two
numbers above are now explicit config — `SANDBOX_VM_USD_PER_HOUR` (the MEASURED list price) and
`SANDBOX_EST_VM_HOURS_PER_KCREDIT` (the ESTIMATE; **8.33 is the ~120-credits-per-active-hour figure
above, inverted** — change one and change the other) — and `effectivePackMargin()` re-runs the
`MIN_PACK_MARGIN` floor with compute on the cost side. `billing.spec.ts` and `subscriptions.spec.ts`
assert it for every active pack AND plan **at the default tier**: measured **2.67× / 2.53× / 2.41×**
(Starter / Pro / Studio), i.e. **62.6% / 60.5% / 58.4%** GM — the band this section states, now pinned
rather than described. The rate is **derived from `CODESANDBOX_VM_TIER`**, so those figures follow the
tier automatically; the specs also grade Pico (3.21× / 3.04× / 2.89×) and assert the CEILING — **Micro
($0.298/hr) puts the Pro and Studio packs and every plan UNDER the floor**, which is what makes Nano
the last free step up.
⚠️ A nonsensical override (including a literal `0`) falls back rather than being obeyed: obeying it
would collapse the floor onto the LLM-only one and silently restore "compute is free".

**The honest fix is metering, not margin.** Folding VM time into `CREDIT_MARGIN` makes light sandbox
users subsidize heavy ones and hides the cost from the ledger it belongs in. The end state
(`spec/sandbox-codesandbox.md` §8 item 4) is a `sandbox` ledger reason with its own sweep and overdraw
policy — at which point the placeholder comes OUT of the margin and `CREDIT_MARGIN` goes back to
pricing model spend only.

## Config knobs

All are environment config, never hardcoded (`.env.local` locally, SSM → container env when deployed).

| Var | Default | What it does |
|---|---|---|
| `BILLING_ENFORCED` | `false` | `false` = record usage but never block anyone (paid-tier thresholds + media 402 still bind) |
| `SIGNUP_GRANT_CREDITS` | `1000` | Starter credits, once per user (~3.7× a KIE build turn at margin 4.0 **after** the flat `PROJECT_CREATE_CREDITS` charge comes off the top; below **both** paid-tier minimums on purpose) |
| `GRANTS_ENABLED` | `true` | Turn the signup grant off entirely |
| `CREDIT_UNIT_COST_USD` | `0.01` | What one credit represents in raw model spend |
| `CREDIT_MARGIN` | `4.0` | Multiplier over raw LLM+media cost (~75% GM target; realized ~72–75% LLM-only, **~58–63% effective while sandbox compute rides unmetered on the Nano default tier** — see "Sandbox compute"). **4.0 is a DECISION, not a placeholder (owner, 2026-07-28)** — every pack and plan clears `MIN_PACK_MARGIN` at it, and raising it is a price increase to customers, so it is management's call and env/SSM-configurable. The "~`8.0` restores ~75%" figure in that section is arithmetic, NOT a plan — and it is only true if `SANDBOX_EST_VM_HOURS_PER_KCREDIT` is rescaled alongside it. |
| `SANDBOX_VM_USD_PER_HOUR` | *derived from `CODESANDBOX_VM_TIER`* | MEASURED list price of the configured VM tier (**default Nano `0.149`**, Pico `0.074`; larger tiers derived at ~$0.0745/CPU-hour, an unknown name priced at the most expensive measured tier). An OPTIONAL override for a negotiated or changed rate — leave it unset so raising the tier raises the price. "Raise it with the tier" was a comment, and a comment cannot fail — see "Sandbox compute" |
| `SANDBOX_EST_VM_HOURS_PER_KCREDIT` | `8.33` | The ESTIMATE: VM-hours dragged along by 1,000 billed credits (~120 credits per active build-hour, inverted). Replaced by measurement once the Admin VM-hours report has data |
| `LLM_MODEL` | *`DEFAULT_MODEL`, `claude-sonnet-5`* | §4.6.1a **Standard** rung — the platform default. Always usable, no threshold |
| `PREMIUM_MODEL` / `PREMIUM_MINIMUM_CREDITS` | `claude-opus-5` / `1200` *(`.env.example` ships `1500`)* | §4.6.1a **Premium** rung: a selector the ACTIVE price list must price + the balance a user must HOLD to unlock it (edit turns only) |
| `ENABLE_PREMIUM_MODEL` | `true` | §4.6.1a master switch for the paid rung. `false` serves Standard alone. ⚠️ Renamed from `ENABLE_EXTENDED_MODELS` on 2026-08-08; the old name — and the retired `SUPERMAX_MODEL` / `SUPERMAX_MINIMUM_CREDITS` — are **REFUSED if set**, because this flag defaults ON and a stale `false` would silently start serving the paid rung to everyone. An unrecognised, unpriceable or unaffordable rung resolves DOWN to Standard — never up |
| `PROJECT_CREATE_CREDITS` | `150` | Flat price of creating a project, charged at registration before anything is provisioned (`0` makes it free). Every generation turn — including the first build — bills cost-derived. See "Creating a project is FLAT" |
| ~~`CREATION_FLAT_CREDITS`~~ | *retired* | **REFUSED if set** (including `0`), naming `PROJECT_CREATE_CREDITS`. There is no creation turn to flat-price any more |
| `CACHE_WARMER_ENABLED` | `true` | Base-prompt cache warmer (KIE only): keeps the shared prompt block warm so generations read at 0.1× instead of writing at 2×. Platform-paid, no ledger rows |
| `CACHE_WARMER_INTERVAL_MINUTES` | `45` | Warm cycle cadence; must stay under the 60m cache TTL (values >55 or <1 are ignored) |
| `CACHE_WARMER_FANOUT` | `6` | Requests per cycle — KIE warms per BACKEND (~4–5 measured behind their balancer) |

Model PRICES are not env anymore — they live in the Marketplace price list (admin-promoted, baked
fallback). The retired `KIE_*_DOLLARS` / `PREMIUM_*_DOLLARS` vars are REFUSED if set.

## Credit packs & subscriptions (Stripe)

| Pack | Credits | Price | $/credit | GM @4.0 |
|---|---|---|---|---|
| Starter | 3,000 | $30 | $0.0100 | 75% |
| Pro | 9,500 | $90 | $0.0095 | 74% |
| Studio | 25,000 | $225 | $0.0090 | 72% |

The GM column is **LLM-only** raw cost at margin 4.0. While sandbox compute rides unmetered
(the +50% placeholder above, at the Nano default tier), subtract ~12–14 points across the board
(~58–63% effective).

Priced as a **premium specialty game platform** (2026-07-18): base $0.01/credit with a shallow volume
discount to Studio, mirroring the market's shape (Lovable is a flat $0.25/message, discounting only
2–10% at volume). At margin 4.0 a single edit costs ~$0.41 vs Lovable's $0.25 — already premium per
unit of heavier work, so we bank the KIE cost advantage as margin rather than competing on price.

Subscriptions mirror the packs monthly (Pro 9,500/mo at $90, Studio 25,000/mo at $225); credits
never expire or reset — a plan accumulates. Defined in `app/lib/.server/billing/stripe.ts`, and
**every pack/plan must clear `MIN_PACK_MARGIN`** (`packMargin()` — the floor that caught the shipped
0.84× loss-making pack; never add or reprice without re-running it). Purchases are idempotent on the
Stripe session id; subscription grants fire ONLY on `invoice.paid`.

## Where the code lives

| Thing | File |
|---|---|
| Rate table, config, tier resolution (`getModelTier`/`getModelTiers`) | `app/lib/.server/billing/rates.ts` |
| The tier ladder's shape (zero-import: ids, labels, in-code defaults) | `app/lib/.server/billing/model-tiers.ts` |
| Tier picker + pill (client) | `app/components/chat/ModelTierPanel.tsx`, `ModelTierPill.tsx`, `app/lib/stores/model-tier.ts` |
| Marketplace price list (baked + versioned store) | `app/lib/.server/billing/{baked-market-prices,market-prices,market-price-store}.ts` |
| Tier eligibility (`decideModelTier`) + the `/api/me` hint (`modelTiersSessionHint`) | `app/lib/.server/billing/premium.ts` |
| Ledger (FS + Supabase) | `app/lib/.server/billing/ledger.ts` |
| Gate, settlement, auto-refund | `app/lib/.server/billing/gate.ts` |
| Media debit/refund (§4.16) | `app/lib/.server/media/service.ts` |
| Stripe checkout + webhook | `app/lib/.server/billing/stripe.ts` |
| Schema, RLS, `append_ledger_entry` | `supabase/migrations/0001_stage3_*.sql` (+ `0009` media reason) |
| Admin top-up route | `app/routes/api.admin.credits.ts` |
| Local top-up script | `scripts/credits.mjs` |
