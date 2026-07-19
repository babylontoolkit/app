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

**Two things enforcement does NOT change (2026-07-18):** the **premium model threshold** binds on the
balance either way (settlement debits regardless, so a 320-credit balance cannot switch on the 2×
model even unmetered — a deploy that wants free premium sets `PREMIUM_MINIMUM_CREDITS=0` explicitly),
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

Current baked rates (per MTok, KIE): Opus 4.8 (the default) **$2 / $10**; Fable 5 (the premium tier)
**$4 / $20**. Cache rates always DERIVE from the row — 0.1× read, **2×** write (the 1-hour tier,
§4.2.8; assuming the 1.25× headline number under-charges every generation and nothing throws).

Measured on KIE (2026-07-16/17, `spec/context-budget.md` §MEASURED) **at the old margin 3.34** — at the
current `CREDIT_MARGIN = 4.0` every figure below is ~1.2× higher: a full playable-game creation ran
**163–513 credits** (→ ~195–615 at 4.0) depending on difficulty; a **warm edit is ~11–65 credits** (→
~13–78; sticky block routing); a trivial edit measured **18** (→ ~22). **Media is billed separately per
task** (§4.16): a 2K image is ~24 credits at 4.0, a video clip runs from ~60 (veo3_lite) into the
hundreds (kling-3.0 pro) — debited up-front at the exact price shown on the Generate button.

The 800-credit signup grant (`SIGNUP_GRANT_CREDITS` default) is ~3.5× a measured KIE creation at
margin 4.0 (guarantees one free game + iteration), and deliberately BELOW the 1,200-credit premium
minimum, so a fresh account cannot burn its grant on the 2× model. Premium is also **edit-only**: creations always run the standard streaming model
(`decidePremium` `reason: 'creation_turn'` — KIE-buffered Fable 5 cannot flush a creation-sized
artifact before the gateway timeout).

> **A deploy costs money.** Tool schemas and the base prompt live *inside* the cached prefix. Change
> either and every user's cache entry is invalidated, so the next generation pays a full cache write at
> 2×. Measured: $0.51 for a one-sentence answer right after a schema edit, $0.22 for the identical
> prompt immediately after. A post-deploy cost spike is expected, not a regression.

## Config knobs

All are environment config, never hardcoded (`.env.local` locally, SSM → container env when deployed).

| Var | Default | What it does |
|---|---|---|
| `BILLING_ENFORCED` | `false` | `false` = record usage but never block anyone (premium threshold + media 402 still bind) |
| `SIGNUP_GRANT_CREDITS` | `800` | Starter credits, once per user (~3.5× a KIE creation at margin 4.0; below the premium minimum on purpose) |
| `GRANTS_ENABLED` | `true` | Turn the signup grant off entirely |
| `CREDIT_UNIT_COST_USD` | `0.01` | What one credit represents in raw model spend |
| `CREDIT_MARGIN` | `4.0` | Multiplier over raw cost (~75% gross-margin target; realized ~72–75% at the pack prices) |
| `PREMIUM_MODEL` / `PREMIUM_MINIMUM_CREDITS` | `claude-fable-5` / `1200` | The 2× premium tier: a selector + the balance a user must HOLD to unlock it (edit turns only) |

Model PRICES are not env anymore — they live in the Marketplace price list (admin-promoted, baked
fallback). The retired `KIE_*_DOLLARS` / `PREMIUM_*_DOLLARS` vars are REFUSED if set.

## Credit packs & subscriptions (Stripe)

| Pack | Credits | Price | $/credit | GM @4.0 |
|---|---|---|---|---|
| Starter | 3,000 | $30 | $0.0100 | 75% |
| Pro | 9,500 | $90 | $0.0095 | 74% |
| Studio | 25,000 | $225 | $0.0090 | 72% |

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
| Rate table, config, premium tier | `app/lib/.server/billing/rates.ts` |
| Marketplace price list (baked + versioned store) | `app/lib/.server/billing/{baked-market-prices,market-prices,market-price-store}.ts` |
| Premium eligibility (`decidePremium`) | `app/lib/.server/billing/premium.ts` |
| Ledger (FS + Supabase) | `app/lib/.server/billing/ledger.ts` |
| Gate, settlement, auto-refund | `app/lib/.server/billing/gate.ts` |
| Media debit/refund (§4.16) | `app/lib/.server/media/service.ts` |
| Stripe checkout + webhook | `app/lib/.server/billing/stripe.ts` |
| Schema, RLS, `append_ledger_entry` | `supabase/migrations/0001_stage3_*.sql` (+ `0009` media reason) |
| Admin top-up route | `app/routes/api.admin.credits.ts` |
| Local top-up script | `scripts/credits.mjs` |
