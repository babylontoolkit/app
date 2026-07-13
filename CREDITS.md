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

**Production top-ups need `POST /api/admin/credits`** — gated on the `is_admin` flag read from
`profiles` (never from `user_metadata`, which the user can write). Not built yet; it belongs to §4.10
(admin), Stage 4.

---

## Reading the ledger

```
14:36:39  grant         +2250  ->    2250   Welcome — starter credits
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
| `refund` | Compensating row for a hard-failed generation (auto). | no |
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

Credits are priced from real token usage:

```
raw_cost = in·$3/MTok + cache_read·$0.30/MTok + cache_write·$6/MTok + out·$15/MTok
credits  = ceil(raw_cost / CREDIT_UNIT_COST_USD × CREDIT_MARGIN)
```

**Four token classes, not three.** Cache *writes* bill at **2×** base input, because we use the 1-hour
cache tier (§4.2.8). Assuming the 1.25× headline number under-charges every single generation and
nothing anywhere throws.

Measured, real "make me a kart racer" builds:

| | Before the tool-batching fix | After |
|---|---|---|
| Output tokens | 44,308 | 33,777 |
| Tool rounds | 6 (hit the cap) | 0 |
| Raw cost | $2.14 | $0.86 |
| **Credits** | **716** | **289** |

At ~289 credits per build, the 2,250-credit signup grant is roughly **7–8 project creations**. Edit
turns are much cheaper.

> **A deploy costs money.** Tool schemas and the base prompt live *inside* the cached prefix. Change
> either and every user's cache entry is invalidated, so the next generation pays a full cache write at
> 2×. Measured: $0.51 for a one-sentence answer right after a schema edit, $0.22 for the identical
> prompt immediately after. A post-deploy cost spike is expected, not a regression.

## Config knobs

All are environment config, never hardcoded (`.env.local` locally, SSM → container env when deployed).

| Var | Default | What it does |
|---|---|---|
| `BILLING_ENFORCED` | `false` | `false` = record usage but never block anyone |
| `SIGNUP_GRANT_CREDITS` | `2250` | Starter credits, once per user |
| `GRANTS_ENABLED` | `true` | Turn the signup grant off entirely |
| `CREDIT_UNIT_COST_USD` | `0.01` | What one credit represents in raw model spend |
| `CREDIT_MARGIN` | `3.34` | Multiplier over raw cost |

## Credit packs (Stripe)

| Pack | Credits | Price |
|---|---|---|
| Hobby | 5,000 | $15 |
| Pro | 15,000 | $40 |
| Studio | 40,000 | $100 |

Defined in `app/lib/.server/billing/stripe.ts`. Purchases are idempotent on the Stripe session id, so
a webhook retry or a double-clicked tab cannot double-credit an account.

## Where the code lives

| Thing | File |
|---|---|
| Rate table, config | `app/lib/.server/billing/rates.ts` |
| Ledger (FS + Supabase) | `app/lib/.server/billing/ledger.ts` |
| Gate, settlement, auto-refund | `app/lib/.server/billing/gate.ts` |
| Stripe checkout + webhook | `app/lib/.server/billing/stripe.ts` |
| Schema, RLS, `append_ledger_entry` | `supabase/migrations/0001_stage3_*.sql` |
| Local top-up script | `scripts/credits.mjs` |
