# SuperMax model tier — implementation plan

Generalize the two-model premium toggle (§4.6.1a) into an ordered **three-class ladder** —
**Standard (Sonnet 5) · Premium (Opus 5) · SuperMax (Fable 5)** — configured by env selectors, priced
from the Marketplace price list, gated by per-tier credit thresholds, and chosen from a popover picker
in the composer.

Created by `/bt-plan` in Quick Plan mode (no feature spec file — the brief plus a clarifying round is
the mini-spec). Owner decisions recorded in the interview:

| Question | Decision |
|---|---|
| Threshold ladder | `PREMIUM_MINIMUM_CREDITS=1500`, `SUPERMAX_MINIMUM_CREDITS=1500` (both unlock together) |
| Pill UI | Popover picker, cloned from the `/effort` panel pattern |
| Server architecture | Generalized tier ladder (one pure decision over an ordered list), not a third copied branch |
| Default model | Flip **in code as well**: `DEFAULT_MODEL = 'claude-sonnet-5'`, premium default `claude-opus-5`, supermax default `claude-fable-5` |

---

## Codebase Analysis

Read read-only across three parallel exploration passes plus direct reads of the money-path files.
Everything below cites what was actually inspected.

### The existing tier is small, pure, and well-fenced

- **The decision** is one pure function with no imports:
  [`app/lib/.server/billing/premium.ts:64`](app/lib/.server/billing/premium.ts#L64) `decidePremium` —
  `not_requested` → `creation_turn` → `balance >= minimumCredits`. Its doc block (`:54-63`) records why
  the threshold binds regardless of `BILLING_ENFORCED`, and
  [`premium.ts:117`](app/lib/.server/billing/premium.ts#L117) `premiumSessionHint` records why a
  misconfigured tier must degrade to `available: false` and must never throw (it feeds `/api/me`, which
  runs on every page load). Both are in the same "spends money without a second confirmation" category
  as `auto-repair.ts` / `restore-target.ts`, so both have exhaustive tests.
- **The config** is [`rates.ts:271-302`](app/lib/.server/billing/rates.ts#L271) — `DEFAULT_PREMIUM_MODEL
  = 'claude-fable-5'`, `DEFAULT_PREMIUM_MINIMUM_CREDITS = 1200`, and `getPremiumTier` reading
  `PREMIUM_MODEL` / `PREMIUM_MINIMUM_CREDITS` and refusing a selector the **active Marketplace price
  list** cannot price. Prices never come from env (`refuseRetiredPriceEnv`, `rates.ts:173-192`).
- **The pricing injection** is [`rates.ts:314-355`](app/lib/.server/billing/rates.ts#L314)
  `providerRates`, carrying the 2026-07-30 **fill-a-gap-never-overwrite** fix. This is the single most
  load-bearing line for this feature: the moment `PREMIUM_MODEL` names a model Anthropic prices
  natively — which is exactly what this plan does — an unconditional overwrite would bill Anthropic's
  Opus 5 at KIE's $2/$10 instead of $5/$25 (measured 231 credits where 576 was correct). The fix is
  already in place; every new tier must go through the same `withPremium`-style gap-fill.
- **The wiring** is one block: [`proxy.ts:654-674`](app/lib/.server/agent/proxy.ts#L654) —
  `getPremiumTier` → `decidePremium` → `getPremiumModel` → `premiumDeclinedNotice`, deliberately
  resolved **after** the credit gate (`:649-653`) so an out-of-credits user gets a 402 rather than the
  operator's config error. The client flag is `premium?: boolean`
  ([`proxy.ts:207`](app/lib/.server/agent/proxy.ts#L207)), forwarded from
  [`api.agent.ts:64,165`](app/routes/api.agent.ts#L64).
- **The session hint** is [`api.me.ts:135-185`](app/routes/api.me.ts#L135), each lookup individually
  try/caught, shaped into `credits.premium` and consumed by
  [`session.ts:69-107`](app/lib/stores/session.ts#L69) with `canUsePremium` at `:196` computed **live
  from `balance`** (not the server's cached `available`) so it re-locks after a settlement.
- **The UI** is [`PremiumToggle.tsx`](app/components/chat/PremiumToggle.tsx) — 137 lines, a single
  `IconButton`, three visual states, all hooks unconditional at the top (`:47-51` documents the crash
  when that was violated). Preference persists in
  [`settings.ts:263,295,313,336`](app/lib/stores/settings.ts#L263) as a **boolean** under
  `premiumModelEnabled`. Mounted at [`ChatBox.tsx:423`](app/components/chat/ChatBox.tsx#L423).

### The pattern to clone for the picker

The `/effort` panel is the existing precedent for "a user picks a setting that costs money":
[`effort.ts`](app/lib/stores/effort.ts) (`baseEffortStore`, `effortPanelOpen`, `EFFORT_LABELS` +
`EFFORT_DESCRIPTIONS` as **one** source shared by picker, pill tooltip and `/context`),
[`EffortPanel.tsx`](app/components/chat/EffortPanel.tsx) (the anchor `<div className="relative">` is
**always** rendered; only the popup is conditional — returning `null` when closed removed a flex child
and shifted the toolbar), and boundary validation in
[`capabilities.ts:190`](app/lib/modules/llm/capabilities.ts#L190) `parseUserEffort`, which **never
clamps** — an invalid value falls back to the cheap default rather than inventing an expensive one.

### What the ladder move changes about money

- `claude-fable-5` is priced in the baked list at **$4/$20**
  ([`baked-market-prices.ts:88`](app/lib/.server/billing/baked-market-prices.ts#L88)) and is the
  **most-expensive row**, which is `ratesFor`'s fallback for any unpriced model
  ([`rates.ts:371-390`](app/lib/.server/billing/rates.ts#L371)). Moving it from Premium to SuperMax
  does not change that — good, no repricing of the fallback.
- `claude-sonnet-5` **is** priced ($0.85/$4.275, `baked-market-prices.ts:91`) and **is** listed in
  `KIE_MODELS` ([`kie-wire.ts:180`](app/lib/modules/llm/providers/kie-wire.ts#L180)), so it satisfies
  `validateMarketPriceList`'s "a list must price `DEFAULT_MODEL`" rule
  ([`market-prices.ts:163`](app/lib/.server/billing/market-prices.ts#L163)) and the enhancer path's
  `modelsList[0]` fallback cannot stand in for it.
- No new ledger reason: a SuperMax turn settles as `'generation'` like any other
  ([`ledger.ts:54-65`](app/lib/.server/billing/ledger.ts#L54)).
- `packMargin` / `effectivePackMargin` / `grantHeadroom` are **model-price independent** on the tier
  axis — `grantHeadroom` is only ever called with the platform model
  ([`rates.ts:699`](app/lib/.server/billing/rates.ts#L699), asserted at `billing.spec.ts:575`). The
  1000-credit signup grant stays below both 1500 thresholds, so the grant protection holds.
- `claude-fable-5` is in `MODELS_THAT_CANNOT_DISABLE_THINKING`
  ([`capabilities.ts:66`](app/lib/modules/llm/capabilities.ts#L66)), so the last-resort
  thinking-disabled retry ([`proxy.ts:1677`](app/lib/.server/agent/proxy.ts#L1677)) correctly declines
  to fire on a SuperMax turn — no capability change needed, but it means SuperMax keeps full exposure
  to KIE's ~30s silent-step kill.

### Landmines found (each one silently wrong if missed)

1. **`.env.example` already ships a `SUPERMAX` block** (lines 31-35) with `SUPERMAX_MINIMUM_CREDITS=2000`,
   and **nothing in the codebase reads it** — `grep -rn SUPERMAX` matches that file only. The owner's
   chosen value is 1500; the committed file says 2000. It must be reconciled, not both left standing.
2. **`PREMIUM_MODEL` already has TWO assignments in `.env.example`** (`:28` live, `:164` commented) —
   and the duplicate-key pin at
   [`project-create.spec.ts:248-277`](app/lib/.server/billing/project-create.spec.ts#L248) counts
   commented lines by design. That is the exact two-writers trap the file documents; it is armed today
   for the premium keys and would be armed again for the supermax ones.
3. **`KIE_ENV` in `billing.spec.ts:77-99` does not scrub `PREMIUM_MODEL`/`PREMIUM_MINIMUM_CREDITS`.**
   `env()` falls back to `process.env`, Vitest loads `.env.local`, and the owner's `.env.local` now sets
   these — so `providerRates` reads them **inside the test**, changing `mostExpensive()` and the
   Anthropic table that `billing.spec.ts:645-686` grades against. This is the third occurrence of the
   trap the file itself warns about twice (`:79-89`, `:116-129`): it fails on the developer's machine
   only, with CI green.
4. **`getPremiumModel`'s error message is already stale** —
   [`config.ts:181`](app/lib/.server/agent/config.ts#L181) still says *"Set PREMIUM_INPUT_DOLLARS and
   PREMIUM_OUTPUT_DOLLARS"*, vars that are **refused** at `rates.ts:182`. Copying it into a SuperMax
   version would propagate the lie to a third place.
5. **Three tests assert the *shape* of the two-tier design and will break by construction**, which is
   correct and must be updated deliberately rather than deleted:
   [`creation-flat.spec.ts:163-169`](app/lib/.server/billing/creation-flat.spec.ts#L163) source-scans
   that `minimumCredits` appears in `proxy.ts` only on the `decidePremium` call;
   [`first-build-turn.spec.ts:349`](app/lib/.server/agent/first-build-turn.spec.ts#L349) `it.each`
   names `decidePremium`, and `:478` regex-scans `PremiumToggle.tsx` for the literal
   `const eligible = canUsePremium(session) && !creationTurn`;
   [`PremiumToggle.spec.tsx`](app/components/chat/PremiumToggle.spec.tsx) asserts boolean toggling.
6. **Stale prose in four places** contradicts the live numbers already (grant 800 vs 1000, minimum 1200
   vs 1500): `premium.ts:13`, `proxy.ts:560`, `.env.example:161-162`, `spec/billing.md:417`.
7. **`session.ts:135` merges `credits` shallowly** — a nested tier object arrives whole, but a
   *partially* omitted nested field is not defaulted. The replacement payload must be all-or-nothing.
8. **The temporary `.env.local` model.** The owner reports running "sonnet 4-6" while KIE is
   misbehaving. There is no `claude-sonnet-4-6` row in the baked price list (`claude-opus-4-6` exists)
   and no such entry in `KIE_MODELS`; an `LLM_MODEL` the active list cannot price is refused at config
   time by `getPlatformModel`. T2 includes a verification step rather than assuming a typo.

### SPEC.md alignment

- **Conforms to:** §4.6 (append-only ledger, gate-once-settle-after, credits are cost-proportional),
  §4.6.1a (the premium tier's threshold/creation-lock/pure-decision rules — generalized, not
  weakened), §4.2a (model choice is a **config** property, never a free-form user string; the client
  sends a tier id the server maps to an operator-configured model), §4.2.8 (nothing here touches the
  cached prefix), §4.1a (toolbar rules — one shared control, no new always-visible button), §5 (no
  secret crosses to the client; the tier hint is a rendering hint, never authorization).
- **`spec_impact: yes` — INFERRED** (Quick Plan mode; there is no feature spec file to carry the field).
  It changes an architectural decision recorded verbatim in §4.6.1a — *"a **boolean toggle** between
  exactly two operator-configured, operator-priced models"* — and changes the platform default model
  named in §4.2a and in `CLAUDE.md`'s standing rules. A SPEC.md write-back task is therefore required
  and is the last task.
- **No conflict requiring a stop.** The one rule that reads like a conflict — "model choice is a config
  property, never a user choice" — is already satisfied by the premium tier's design and is preserved:
  the client sends an **enum tier id**, never a model string, and the server maps it through env
  selectors that must be priced in the active list.

### Assumptions where the interview left room

- **Both thresholds at 1500 is deliberate**, so Premium and SuperMax unlock at the same balance. They
  stay two independent env vars so the ladder can be separated later without a code change. The
  **in-code** defaults keep `DEFAULT_PREMIUM_MINIMUM_CREDITS = 1200` (changing it is not requested and
  is pinned by `premium.spec.ts:187`) and add `DEFAULT_SUPERMAX_MINIMUM_CREDITS = 1500`, so a deploy
  with no env at all still gets a monotonic ladder.
- **Every tier above Standard stays locked on the first build turn.** Fable 5's measured KIE gateway
  timeout is a function of artifact size and the first build is the largest artifact in the product
  (SPEC §11 note 7). Generalizing the lock preserves today's premium behaviour exactly and is the safe
  direction for the new tier; it is expressed as a per-tier `firstBuildLocked` flag (default `true` for
  every non-standard tier) so relaxing it later for a streaming model is config, not surgery.
- **An unknown/invalid tier id resolves to Standard**, mirroring `parseUserEffort`: never clamp upward,
  because inventing a more expensive tier the user did not ask for is the costly direction.

---

## Tasks

- [x] **T1** — The tier ladder config (server, pure)
  - Files: `app/lib/.server/billing/model-tiers.ts` (new), `app/lib/.server/billing/rates.ts`, `app/lib/.server/billing/model-tiers.spec.ts` (new)
  - Details: Define `MODEL_TIER_IDS = ['standard', 'premium', 'supermax'] as const`, `ModelTierId`, and a `MODEL_TIER_CONFIG` table giving each non-standard tier its env keys (`PREMIUM_MODEL`/`PREMIUM_MINIMUM_CREDITS`, `SUPERMAX_MODEL`/`SUPERMAX_MINIMUM_CREDITS`), its display label (`Premium`, `SuperMax`), its in-code default model and default minimum, and `firstBuildLocked: true`. Set `DEFAULT_PREMIUM_MODEL = 'claude-opus-5'`, add `DEFAULT_SUPERMAX_MODEL = 'claude-fable-5'` and `DEFAULT_SUPERMAX_MINIMUM_CREDITS = 1500`; keep `DEFAULT_PREMIUM_MINIMUM_CREDITS = 1200`. Generalize `getPremiumTier` into `getModelTier(id, context)` returning `{ id, label, model, rates, minimumCredits, firstBuildLocked }`, keeping every existing rule: `refuseRetiredPriceEnv` first, selector trimmed, `envNumber` fallback for the threshold, and a `NotConfiguredError` when the **active** price list has no row. Add `getModelTiers(standardModel, context)` returning the ladder with unpriceable tiers reported rather than thrown. *(Amended during T1: the table shipped as `PAID_MODEL_TIERS` in a new zero-import `model-tiers.ts`, and `getModelTiers` takes the standard model as a PARAMETER — `rates.ts` may not import `agent/config.ts`, the cycle documented at `mostExpensive`. T5 and T8 must read against that signature.)* Re-express `getPremiumTier` as `getModelTier('premium', ...)` so existing callers keep working. **Write the new error copy from scratch** — do not copy `config.ts:181`, which still names the retired `PREMIUM_INPUT_DOLLARS`/`PREMIUM_OUTPUT_DOLLARS` vars; point at Settings → Admin → Marketplace prices. Fix that stale string at `config.ts:181` in the same edit.
  - Acceptance: with no env set, `getModelTier('premium')` → `claude-opus-5` @ the list's $2/$10 with minimum 1200, and `getModelTier('supermax')` → `claude-fable-5` @ $4/$20 with minimum 1500; a `SUPERMAX_MODEL` the active list cannot price throws `NotConfiguredError` naming the admin panel and **not** naming any retired env var; `getModelTiers` returns three entries with the unpriceable one flagged, never throwing; an unparseable `SUPERMAX_MINIMUM_CREDITS` falls back to 1500. Tests stub every `PREMIUM_*` and `SUPERMAX_*` key to `undefined` first (the `oauth.spec.ts` `env()`-falls-back-to-`process.env` trap).

- [x] **T2** — Flip the in-code platform default to Sonnet 5
  - Files: `app/utils/constants.ts`, `app/lib/modules/llm/providers/kie-wire.ts`, `app/lib/.server/billing/market-prices.ts` (verify only), any price-list test fixtures keyed off `DEFAULT_MODEL`
  - Details: Set `DEFAULT_MODEL = 'claude-sonnet-5'` and rewrite the doc block above it: the 2026-07-30 entry currently records sonnet-5 as **attempted and rejected** (77% KIE HTTP 500 against a 21/22 Opus control) — replace it with the owner's decision, preserving the measured failure history as *why the fallback matters* and naming `LLM_MODEL=claude-opus-5` as the instant config-only revert. Confirm `claude-sonnet-5` is present in `KIE_MODELS` (it is, `kie-wire.ts:180`) so the enhancer path cannot substitute `modelsList[0]`. Sweep every fixture/tripwire literal that hard-codes the old default: `market-price-store.spec.ts:85,104` (a list must price `DEFAULT_MODEL`), `billing.spec.ts:621-686`. **Verify the temporary `.env.local` model**: report whether `claude-sonnet-4-6` exists in the active price list and in `KIE_MODELS`; if it does not, say so plainly rather than adding a row — an unpriced `LLM_MODEL` is refused at config time and the correct fix is the owner picking a priced id.
  - Acceptance: `DEFAULT_MODEL === 'claude-sonnet-5'`; the baked list prices it; `validateMarketPriceList` accepts the baked list unchanged; a full `pnpm test` run has no failure caused by a stale default literal; Standard and Premium name **different** models (the incoherent state where both are Opus 5 never exists on a committed tree).

- [x] **T3** — Price every tier on every provider, gap-fill only
  - Files: `app/lib/.server/billing/rates.ts`, `app/lib/.server/billing/billing.spec.ts`
  - ⚠️ *Flagged during T2 — fix as part of this task: `rates.ts` (the fill-a-gap post-mortem block) still says in the PRESENT tense "It was invisible because the default `PREMIUM_MODEL` **is** `claude-fable-5`, which Anthropic bakes NO row for — the exact case the injection was written for, where filling and overwriting are the same thing." That safe case ENDED at T1: `DEFAULT_PREMIUM_MODEL` is now `claude-opus-5`, which Anthropic prices natively. The sentence now tells a reader they are still safe at the precise moment they stopped being — and this is the comment sitting on the line the whole task is about.*
  - Details: Generalize `providerRates`' single premium injection to loop the whole ladder. Preserve both properties exactly: **non-throwing** (an unpriceable tier is skipped so in-flight settlement can never be taken down) and **fill-a-gap-never-overwrite** (`premium && !table[model]`). This is now load-bearing in a way it was not before: with `PREMIUM_MODEL=claude-opus-5`, Anthropic prices that model natively at $5/$25 and the KIE-shaped list row must **not** replace it — the exact 231-vs-576-credit regression documented at `rates.ts:331-347`. Keep `mostExpensive`'s behaviour unchanged. ⚠️ *Corrected after T1: fable-5 is the top row on **KIE** only. On Anthropic it is no longer injected by default (premium is now Opus 5, which Anthropic prices natively), so Anthropic's unpriced-model fallback rose from $20 to $25 output — the safe direction, but do not assert "$20 remains the top row" on both tables.*
  - Acceptance: with premium=`claude-opus-5` and supermax=`claude-fable-5`, `providerRates().Anthropic['claude-opus-5']` is Anthropic's own $5/$25 row (**not** $2/$10) and `providerRates().Anthropic['claude-fable-5']` exists via injection; the KIE table is byte-identical to `kieRates()` plus nothing; an unpriced supermax selector leaves both tables intact and throws nothing. A regression test that inverts the gap-fill condition must fail.

- [x] **T4** — `decideModelTier` — the pure eligibility decision
  - Files: `app/lib/.server/billing/premium.ts`, `app/lib/.server/billing/premium.spec.ts`
  - Details: Replace `decidePremium` with `decideModelTier({ requested: ModelTierId, balance, tiers, isFirstBuildTurn })` returning `{ tier: ModelTierId; reason }` where `reason ∈ 'standard_requested' | 'creation_turn' | 'below_minimum' | 'sufficient_credits' | 'unavailable'`. Keep the file (docs across the repo cite `premium.ts`) and keep the decision order: not-requested → first-build lock → threshold. Rules that must survive verbatim: the threshold binds **regardless of `BILLING_ENFORCED`** (no enforcement input may exist — keep the structural tripwire test); a declined tier **falls back to Standard**, never to an adjacent tier; an unknown or unpriceable tier id resolves to Standard; the decision is never an error. Generalize `premiumDeclinedNotice` to `tierDeclinedNotice(label, minimumCredits)` so the copy names the tier the user actually asked for.
  - Acceptance: exhaustive tests over the cross-product of {standard, premium, supermax} × {below, at, above each threshold} × {first-build, edit turn}; requesting SuperMax at 1,499 credits yields Standard with `below_minimum` (not Premium); requesting SuperMax on a first build turn yields Standard with `creation_turn` at any balance; the tripwire asserting no `enforced` field exists still passes; mutation-verified — flipping `>=` to `>` fails a test.

- [x] **T5** — `modelTiersSessionHint` — degrade to off, never throw
  - Files: `app/lib/.server/billing/premium.ts`, `app/lib/.server/billing/premium.spec.ts`
  - Details: Generalize `premiumSessionHint` to produce the whole ladder: `{ standardModel, tiers: [{ id, label, model, minimumCredits, available }] }`. A tier whose config threw is reported with its **baked fallback** model/threshold and `available: false` — degrading a capability to "off" is honest, degrading it to "on" invents one (`premium.ts:96-116`). Must be total: never throws for any input, including a null ladder, a null standard model, and a negative balance.
  - Acceptance: a misconfigured SuperMax reports `available: false` at a 10,000,000 balance while Premium stays available; every tier available at exactly its minimum and unavailable one credit below; a property test over arbitrary inputs asserts the function never throws.

- [x] **T6** — Proxy wiring: one resolution point for the ladder
  - Files: `app/lib/.server/agent/proxy.ts`, `app/lib/.server/agent/config.ts`
  - Details: Change the request interface's `premium?: boolean` to `tier?: ModelTierId`, **accepting the legacy boolean as an alias** (`premium: true` → `'premium'`) so an in-flight client mid-deploy is not silently downgraded. Validate at the boundary the way `parseUserEffort` does — an unrecognised value resolves to `'standard'`, never upward. Replace the `getPremiumTier`→`decidePremium`→`getPremiumModel` block at `:654-674` with the ladder equivalent, preserving the two ordering constraints: tier resolution stays **after** the credit gate (an out-of-credits user must get their 402, not a config error), and BYOK still short-circuits (`requested && !useByok`). Generalize `getPremiumModel` to `getTierModel(id, context)` with its re-validation against `providerRates()[provider]` intact. Record the chosen tier id alongside the model in the log line and in the `agentMeta` annotation so a SuperMax turn is identifiable in the generation log — today premium is only inferable from the model string, which stops working the moment two tiers could name the same model.
  - Acceptance: a `tier: 'supermax'` request from a 2,000-credit user on an edit turn runs `claude-fable-5` and settles at its rates; the same request on a first build turn runs the platform default silently; a legacy `premium: true` body behaves exactly as before; `tier: 'nonsense'` runs Standard and charges Standard's rates; an unpriced `SUPERMAX_MODEL` does not prevent an out-of-credits user receiving a 402.

- [x] **T7** — Route plumbing
  - Files: `app/routes/api.agent.ts`
  - *(Note from T6: `AgentGeneration` already exposes `tier` and `tierReason`, so T7 is purely the route half. Until it lands, `tier` is **unreachable over HTTP** — `api.agent.ts` still forwards only `premium` — so T6's acceptance clause 1 cannot be driven end-to-end before this task. Two source-scan specs were repointed from `decidePremium` to `decideModelTier` during T6 (`creation-flat.spec.ts`, `first-build-turn.spec.ts`), which removes that part of T14's scope.)*
  - Details: Widen the request type and forward `tier` (and keep forwarding `premium` for the legacy alias) to `runAgentGeneration`. Carry the resolved tier into the `agentMeta` annotation next to `model`, and keep the declined-tier `notice` on the `credits` annotation.
  - Acceptance: a POST carrying `tier` reaches the proxy with it intact; a POST carrying only `premium: true` still runs premium; the stream's `agentMeta` names the tier that actually ran, not the one requested.

- [x] **T8** — `/api/me` emits the ladder
  - Files: `app/routes/api.me.ts`
  - Details: Replace the `credits.premium` object with `credits.modelTiers = { standardModel, tiers: [...] }` built from `getModelTiers` + `modelTiersSessionHint`. Every lookup stays individually try/caught — this endpoint runs on every page load, and an unpriced selector taking the app down for every user is the exact 2026-07-25 incident. Keep the `await ensureMarketPrices(context)` doorway call.
  - Acceptance: with a misconfigured `SUPERMAX_MODEL`, `/api/me` returns 200 with SuperMax `available: false` and the rest of the payload intact; with no billing config at all it still returns 200; the response never contains a price, a key, or any server-only value.

- [x] **T9** — Client session store learns the ladder
  - Files: `app/lib/stores/session.ts`
  - ⚠️ *Measured after T8 — the client is DEGRADED right now and must not be left this way: the shallow `credits` merge backfills `premium` from `EMPTY_SESSION`, so nothing crashes but the composer pill names **Opus 5** as the standard model while the platform runs **Sonnet 5**, names **Fable 5** as premium when premium is **Opus 5**, and `canUsePremium` unlocks at the hardcoded 1200 rather than the configured 1500 (sending `premium: true` for a user the server declines). Three readers: `session.ts:197`, `PremiumToggle.tsx:68`, `Chat.client.tsx:254` — T9/T11 cover all three.*
  - *Also found: `premiumSessionHint` now has ZERO production callers (live only in `premium.spec.ts`), joining `decidePremium` / `premiumDeclinedNotice` / `PremiumSessionHint`. Two functions answering one question is the two-writers drift this repo keeps rediscovering — decide their fate at T14/T16 rather than leaving them indefinitely.*
  - *Pre-existing, NOT introduced here and outside every task's scope: an invalid `LLM_PROVIDER` still 503s `/api/me` for every user, because `getPlatformConfig(context)` sits outside every guard the tier block added — the same 2026-07-25 outage shape through a different variable. Pinned as a clearly-labelled characterization test in `session-payload.spec.ts` with a flip-me-when-fixed note.*
  - Details: Replace the `credits.premium` interface and its `EMPTY_SESSION` default with the tier ladder, defaulting to `standardModel: 'claude-sonnet-5'` and the three tiers all `available: false`. Replace `canUsePremium` with `canUseTier(session, tierId)` — still computed **live from `balance`**, not from the server's cached `available`, so `applySettlement` re-locks a tier mid-session. Because the `credits` merge at `:135` is shallow, the new object must arrive whole; add a defensive normaliser so a server that omits `modelTiers` yields the locked default rather than `undefined.tiers`.
  - Acceptance: `canUseTier` returns false for every non-standard tier at a 0 balance and true at each tier's minimum; a `/api/me` response with no `modelTiers` key leaves the store in the locked default with no thrown error; Standard is always usable.
  - *Built with two deliberate departures from the text above, both recorded so T16 writes down what shipped rather than what was planned: **(1)** the plan said "the three tiers all `available: false`", which contradicts its own acceptance line "Standard is always usable" — the locked default marks STANDARD `available`/`serveable` true and only the paid rungs locked, matching what `modelTiersSessionHint`'s own degraded fallback emits (two fallbacks disagreeing about one fault would draw a lock on the free rung in T11's picker). **(2)** `serveable` was ADDED to the server hint (`ModelTierHint`, outside T9's stated files) because `available` is a page-load SNAPSHOT: folding the two forces one of two silent failures — a user who buys credits mid-session stays locked on the screen they just paid on, or a misconfigured rung renders enabled and hard-fails. `canUseTier` reads `serveable` from the server and recomputes affordability live. Acceptance clause 2 therefore holds only for a serveable ladder: at 1,500 credits against the LOCKED default, SuperMax is correctly `false`.*

- [x] **T10** — Client preference store + localStorage migration
  - Files: `app/lib/stores/settings.ts`, `app/lib/stores/settings.spec.ts` (new if absent)
  - Details: Replace `premiumModelStore: atom<boolean>` with `modelTierStore: atom<ModelTierId>` persisted under a **new** key `modelTier`, defaulting to `'standard'`. Migrate on read: an existing `premiumModelEnabled === true` becomes `'premium'`, `false`/absent becomes `'standard'` — without the migration every current premium user is silently downgraded. Reject an unrecognised stored value to `'standard'` (a hand-edited localStorage must not select an expensive tier). Add `updateModelTier`.
  - Acceptance: a browser holding `premiumModelEnabled: true` and no `modelTier` key reads `'premium'`; one holding `'supermax'` reads `'supermax'`; one holding `'"gold"'` or malformed JSON reads `'standard'`; the tier survives a reload.

- [x] **T11** — The picker panel and the pill
  - Files: `app/components/chat/ModelTierPanel.tsx` (new), `app/components/chat/PremiumToggle.tsx` (rewritten → `ModelTierPill.tsx`), `app/components/chat/ChatBox.tsx`
  - Details: Clone the `/effort` panel shape exactly: an **always-rendered** `<div className="relative">` anchor with only the popup conditional (returning `null` when closed removes a flex child and shifts the toolbar), Escape-to-close, and one shared label/description source so the pill tooltip, the panel and `/context` cannot disagree. The pill keeps its current job — the always-visible readout of the model **actually in use** — plus a lock glyph when the selected tier is unavailable; clicking opens the panel instead of toggling. Each row states its tier label, its model (via the existing `parseModel`, which already renders `claude-fable-5` as "Fable 5" with no lookup table), its credit consequence, and, when locked, the threshold or the creation-lock reason. Keep both existing behaviours: every hook is unconditional above the early returns (`PremiumToggle.tsx:47-51`), and a locked row **explains rather than being HTML-`disabled`** — §4.1a's dead-end rule. Reuse the shared toolbar button style; add no second always-visible control to the row.
  - Acceptance: with a 2,000-credit balance on an edit turn all three rows are selectable and choosing SuperMax updates the pill to "Fable 5"; on a first build turn every non-standard row is locked and clicking one explains the creation lock without changing the selection; at a 500-credit balance the locked rows name 1,500 credits; opening and closing the panel does not move any sibling control by a pixel; a rendered test drives real pointer events (a scripted `.click()` does not open a Radix-style menu).

- [x] **T12** — Send the tier on every generation path
  - Files: `app/components/chat/Chat.client.tsx`
  - Details: Replace the `premium: premiumRequested` body field with `tier`, derived as `modelTierStore` narrowed by `canUseTier` (the client's own honest guess — the server re-derives regardless). Thread it through **every** send path, not just the main one: the `useChat` body, the repair/retry path around `:837`, and any `reload()`-driven resend — `reload()` refreshes from committed render state, so a value set after the last commit is invisible (the `projectId: undefined` lesson). Leave `creationTurnStore` alone; it stays the UI's mirror of the server's first-build lock.
  - Acceptance: a generation started from the composer, one started by the auto-repair loop, and one started by a retry all carry the same tier; switching tier and immediately sending sends the **new** tier; the server-side `agentMeta` tier matches what the pill showed.

- [x] **T13** — Env surface: types, `.env.example`, setup script
  - Files: `worker-configuration.d.ts`, `.env.example`, `scripts/setup-env.sh`
  - Details: Add `SUPERMAX_MODEL` and `SUPERMAX_MINIMUM_CREDITS` to the model-selector block in `worker-configuration.d.ts`. In `.env.example`: set the banner block to `LLM_MODEL=claude-sonnet-5`, `PREMIUM_MODEL=claude-opus-5` / `PREMIUM_MINIMUM_CREDITS=1500`, `SUPERMAX_MODEL=claude-fable-5` / `SUPERMAX_MINIMUM_CREDITS=1500` (reconciling the stray 2000 that is committed today), and **delete the duplicate commented assignments** at `:164-165` — the prose block keeps its explanation but must not re-assign a key, since the pinning regex counts commented lines and a later line wins in a real `.env`. Rewrite that prose block to describe the three-class ladder, and fix its stale "800 granted < 1200 minimum" sentence to the live 1000/1500. Verify `setup-env.sh` still parses the file.
  - Acceptance: each of `LLM_MODEL`, `PREMIUM_MODEL`, `PREMIUM_MINIMUM_CREDITS`, `SUPERMAX_MODEL`, `SUPERMAX_MINIMUM_CREDITS` appears **exactly once** in `.env.example` counting commented lines, asserted by a test in the shape of `project-create.spec.ts:248-277`; copying `.env.example` to `.env.local` yields a working three-tier deploy.

- [x] **T14** — Update the tests that pin the two-tier shape
  - Files: `app/lib/.server/billing/billing.spec.ts`, `app/lib/.server/billing/creation-flat.spec.ts`, `app/lib/.server/billing/premium.spec.ts`, `app/lib/.server/agent/first-build-turn.spec.ts`, `app/components/chat/ModelTierPanel.spec.tsx` (replacing `PremiumToggle.spec.tsx`)
  - ⚠️ *Measured during T3's verification — two scrub lists, not one, and the acceptance below is not satisfiable without both: (a) with `SUPERMAX_MODEL=claude-opus-4-7` in the real environment, `billing.spec.ts:836` ("validates against the CONFIGURED provider, not against models in general") **fails** — the test relies on `claude-opus-4-7` having no Anthropic row, and the new supermax injection can now supply one. Dormant on the owner's current `.env.local` (opus-5/fable-5 do not collide), which is exactly why it needs the scrub rather than luck. (b) `premium.spec.ts`'s own `stubPremium()` helper scrubs only the four `PREMIUM_*` vars and never the `SUPERMAX_*` pair, now that both rungs share one code path.*
  - Details: Add `PREMIUM_MODEL`, `PREMIUM_MINIMUM_CREDITS`, `SUPERMAX_MODEL`, `SUPERMAX_MINIMUM_CREDITS` to the `KIE_ENV` scrub list at `billing.spec.ts:77-99` — **this is a real defect today**, not new work: the owner's `.env.local` sets these, `env()` falls back to `process.env`, and money-path assertions therefore fail on their machine with CI green. Update `creation-flat.spec.ts:163-169`'s source scan for a `proxy.ts` that now resolves a ladder. Add the ladder decision to `first-build-turn.spec.ts:349`'s `it.each` and repoint its `:478` component regex at the new pill. Port `PremiumToggle.spec.tsx`'s seven cases to the panel, keeping the two that matter most — a locked row does not change the selection, and an already-selected expensive tier is still overridden by the first-build lock.
  - Acceptance: `pnpm test` is green with `PREMIUM_MODEL` and `SUPERMAX_MODEL` **set** in the environment and again with them unset; each updated source scan is mutation-verified (reverting the code it guards makes it fail).
  - *Built with one departure and one addition, both recorded for T16. **Departure:** the four tier vars went into a NEW `MODEL_TIER_ENV` list rather than into `KIE_ENV` as the text said, and the two retired `PREMIUM_*_DOLLARS` vars MOVED out of `KIE_ENV` to join them — `billing.spec.ts` states the convention twice in its own comments ("not KIE variables… a scrub list that stops describing its own contents is how `LLM_MODEL` went missing"), and splitting one family across two lists is the shape of the very defect being fixed. Both lists feed one `beforeEach` spread, and the move is mutation-verified independently (drop the dollars vars and `refuseRetiredPriceEnv` throws through every rate assertion). **Addition:** the `SUPERMAX_*` half of `stubPremium` had NO test depending on it — removing it passed 116/116 under three hostile values — so `premium.spec.ts` gained `injects ONLY for rungs the operator selected`, which fails without the scrub and carries a control proving it cannot pass by the injection being dead. Also fixed three doc comments the port carried over verbatim from `PremiumToggle.spec.tsx` and which had become false (`premiumModelStore === true`, an `active = enabled && eligible` expression that does not exist, Fable 5 named as the premium rung, and an `openPanel` claiming to press a pill this file does not render) — the `shell-strip.ts` rule, in the file whose own header is a lecture about it.*
  - *Verified: the full suite (226 files / 4,190 tests) green under five environment conditions — vars neutralised, the shipped defaults, and three hostile ladders including an unpriced selector. Six mutation checks applied and restored byte-identical by an independent verifier. ⚠️ Mutation 1 needs care: `creation-flat.spec.ts` asserts `stripped.toContain('decideModelTier')`, and the IMPORT line is code — renaming only the call site leaves the string present and the scan stays green, so the honest mutation removes the identifier entirely.*

- [x] **T15** — Gates and a live drive
  - Files: —
  - *Owed from T12: **(c)** `ModelTierPill.tsx` and `Chat.client.tsx` narrow the selected rung DIFFERENTLY — the pill applies `!creationTurn && canUseTier(...)`, the wire applies `canUseTier(...)` alone. On a first build turn the pill shows Standard while the body says `premium`. The end state is still correct (the server declines with `creation_turn`, and `tierNotice` fires only on `below_minimum`, so `agentMeta.tier` is `standard` and matches the pill) — but that equality is held by reasoning across two files and one server rule, with nothing asserting the two derivations agree. T12's Details forbade touching `creationTurnStore`, hence flagged rather than fixed.*
  - *Owed from T11: **(a)** `ContextIndicator.tsx` renders the RAW model id (`claude-fable-5`) where the pill and picker render `Fable 5` via the shared `parseModel`, and it ignores the `tier`/`tierReason` the server now puts on `agentMeta` for exactly this purpose — the three surfaces do not literally share one source, which is the drift shape §4.6.1a's "one label source" rule exists to prevent. **(b)** "opening the panel moves no sibling by a pixel" is proxied STRUCTURALLY (jsdom has no layout): the tests assert child-count invariance and `previousElementSibling` identity across open/close. A live Chrome measurement is the only thing that can actually check the claim, and it belongs in this task's drive.*
  - 🔴 *BLOCKED ON THE PROVIDER as of 2026-07-31, measured: KIE serves ONLY the Opus 4-8 / Opus 5 line. 96 interleaved live requests — opus-5 18/18, opus-4-8 8/8, sonnet-4-6 2/18, and **sonnet-5 0/18, fable-5 0/18**. Two of the three rungs cannot run a generation, so the "three live generations at three distinct rates" acceptance is currently unachievable and NOT because of anything in this plan. Re-probe before attempting; if KIE is still degraded, the honest options are to drive the ladder against the Anthropic provider instead, or to temporarily point the Standard and SuperMax rungs at Opus-line models via env. Do not weaken the acceptance to make it pass.*
  - Details: Run `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test`. Then drive the real UI: start the dev server, open a project, and take one generation on **each** tier, reading the actual settlement off the `credits` annotation and the generation record — the three tiers must produce three different credit costs consistent with $0.85/$4.275, $2/$10 and $4/$20, and the `/context` Model row must name the model that actually ran. Confirm the first-build lock live by starting a new project with SuperMax selected and verifying the build runs the default model. This step exists because every "correct by construction" claim in this repo that was not driven live turned out to have defects in the wiring between correct parts (§4.14 relay, §4.5.6).
  - Acceptance: all four gates green; three live generations recorded at three distinct rates with the tier named in `agentMeta`; a live first-build turn with SuperMax selected runs Sonnet 5 and does not error.
  - *✅ **DRIVEN LIVE 2026-07-31, acceptance met without weakening it.** Gates: typecheck / lint:fix / lint clean, 226 files / 4,190 tests green (re-run independently by the verifier). KIE re-probed first (`kie-model-health.mjs`, 4 rounds × 10 models × both thinking flags): still degraded, **nothing at 0 failures**, sonnet-5 0/8 and fable-5 0/8 — so the plan's authorized Anthropic fallback was taken, `.env.local`'s `LLM_PROVIDER` flipped KIE→Anthropic behind a backup and **restored byte-identical** (sha256 `c0c6b17a…`). Eight generation records recomputed from disk by the verifier against the rate tables and the ledger: **exact on all eight**, ledger `balance_after` chaining without a gap. All three Details dollar figures were each demonstrated live: **$0.85/$4.275** (sonnet-5 on KIE, 3 credits), **$2/$10** (opus-5 on KIE, 5 credits), **$4/$20** (fable-5 on Anthropic via the marketplace injection, 814 credits). Three tiers named in a PERSISTED `agentMeta` — `standard(standard_requested)` / `premium(sufficient_credits)` / `supermax(sufficient_credits)` — with every pre-ladder generation carrying `tier: null` as the control. First-build lock: with `modelTier=supermax` stored, a new project's build ran `claude-sonnet-5` to completion (785 credits at Sonnet's rate, **not** fable-5's) and did not error — `stop+forced-continuation` was checked against `shouldForceContinuation` and is the FIXED path firing legitimately (`lastStepToolCalls = 1`), not the 2026-07-17 regression.*
  - *🔴 **THE FILL-A-GAP-NEVER-OVERWRITE PROPERTY IS NOW PROVEN AGAINST REAL MONEY, not asserted.** Premium on Anthropic billed **$2.5414 = the native $5/$25 exactly**. Had the KIE-shaped row overwritten Anthropic's own, the same turn would have billed $1.01656 → **407 credits instead of 1,017**. That is the 231-vs-576 regression `rates.ts` documents, measured on a live generation. Driving on Anthropic turned out to be STRONGER than the KIE drive the Details describe, because KIE is the provider where filling and overwriting are indistinguishable.*
  - *Found by the drive, each for T16 to write down:* **(1) 🔴 the ladder is NOT monotonic in cost on Anthropic** — SuperMax settled 814 credits against Premium's 1,017, because Anthropic prices Opus 5 above the fable-5 list row. Correct behaviour (rungs order CAPABILITY, not price) but the exact opposite of what "$0.85 → $2 → $4" leads a reader to expect, and nothing says so anywhere. 🔴 ⚠️ **RETRACTED 2026-08-12 — THIS FINDING WAS A MIS-BILL, AND THIS DRIVE IS WHERE IT ENTERED THE DOCS.** Anthropic sells Fable 5 at **$10/$50**; `MODEL_RATES` had no row for it, so the 814 was `providerRates`' gap-fill substituting KIE's $4/$20 for a price Anthropic publishes — `814/1017 = exactly 4/5`, the tell. The rung was under-billed by 2.5× and the platform ate ~60% of every Anthropic-served Platinum turn until the row was added. At the true rate the ladder is cost-monotonic on every gateway. **The RULE (rungs order capability, never price) survives; the evidence does not.** ⚠️ The measurement itself was honest and the *interpretation* was the defect: a number read off a live generation was taken as a fact about the vendor's prices, when it was a fact about our own table. **Reading a rate off our own settlement can only ever confirm what we believe we pay — the vendor's published price is the independent source, and nobody consulted it for two weeks.** **(2) `tier` is written to the message annotation but NEVER to the generation record**, so which rung a charge came from survives only as long as the transcript — a deleted chat erases it, which weakens the §4.10 margin report for the ladder. **(3) 🔴 `env()` PREFERS `context.cloudflare.env`, and the Cloudflare dev proxy loads `.env.local` INTO it — so `VAR=x pnpm dev` CANNOT override the dev server.** Measured: an exported `LLM_PROVIDER=Anthropic` was present in the server process's own environment (`ps -Ewwp`) and lost to `.env.local`'s `KIE` anyway. Every "export a var for one run" debugging instinct is wrong in this repo, silently, with the old value winning. **(4) the KIE health probe UNDER-reports availability** — it called sonnet-5 0/8 and the very next live generation completed on sonnet-5 via KIE, because `max_tokens: 1` with no cached prefix is a different code path from the proxy; do not read its baseline as authority on whether a rung can run. **(5) the first-build project's transcript persisted `annotations: null`** while its sibling's are fully populated — unexplained, outside this plan. **(6) out of scope, flagged not chased: zero `project_create` ledger rows exist EVER**, despite `PROJECT_CREATE_CREDITS=100` and projects created during the drive.*
  - *Owed items, all three now settled as OBSERVATIONS rather than fixes (none were acceptance clauses): **(a) CONFIRMED and unfixed** — `/context` rendered `Model: claude-sonnet-5`, the raw id, where the pill and picker render "Sonnet 5" through the shared `parseModel`, and it ignores the `tier`/`tierReason` now on `agentMeta`. The acceptance clause ("names the model that actually ran") IS met — it is correct and inconsistently formatted, not wrong. **(b) MEASURED LIVE in Chrome** — opening the picker moved no sibling: every control held identical x/y/w (the pill at x=1236.22 before and after), closing the jsdom-proxy gap. ⚠️ A transient browser measurement leaves no artefact, so this is unrefuted rather than independently re-verifiable. **(c) CONFIRMED and unfixed** — on the first build the pill showed "Sonnet 5" while the wire body carried `tier: "supermax"`; the server declined to `standard(creation_turn)` so the end state is correct, but the two derivations still disagree with nothing asserting they agree.*

- [x] **T16** — Update SPEC.md and the supporting docs to match what was built
  - Files: `SPEC.md`, `spec/billing.md`, `CLAUDE.md`, `CREDITS.md`, `spec/anthropic-models.md`, `GETTING_STARTED.md`
  - *(Added during T2: `spec/anthropic-models.md:46` carries a ✅-marked row asserting `DEFAULT_MODEL = 'claude-opus-5'` and `GETTING_STARTED.md:85` says "claude-opus-5 default". Both were outside every task's stated scope and would have survived the whole plan.)*
  - Details: Rewrite **SPEC.md §4.6.1a** from a two-model boolean to the three-class ladder: the tier ids and their default models, the per-tier env selectors, the threshold ladder and what it protects, the generalized first-build lock and its Fable-5 evidence, and the pure `decideModelTier`/`modelTiersSessionHint` pair. Update **§4.2a** and any line naming `claude-opus-5` as the platform default. In `spec/billing.md`, update §"The Marketplace price list" (the surviving selectors are now `KIE_DEFAULT_MODEL`, `PREMIUM_MODEL` **and** `SUPERMAX_MODEL`), the premium-tier paragraphs at `:238-254`, and the stale grant/threshold numbers at `:417`. In `CLAUDE.md`, update the credits-only standing rule that names `DEFAULT_MODEL` as `claude-opus-5`, and add a short entry recording the ladder plus the two invariants that fail silently: the gap-fill-never-overwrite injection now matters because a tier names a natively-priced model, and a tier id from the browser is never clamped upward. Update `CREDITS.md`'s tier/pricing references. Follow SPEC.md's own update contract: **replace/merge** the current-state sections, **append** to the Decisions log (supersede, never delete — the old two-model decision stays, marked superseded by this one).
  - Acceptance: no section of SPEC.md still describes the model choice as a boolean or names Opus 5 as the platform default; `spec/billing.md` names all three selectors and the live 1000/1500 numbers; `CLAUDE.md`'s standing rules match the shipped defaults; the Decisions log gains an entry and loses none.
  - *⚠️ **The verifier returned FAIL on the first pass, on the acceptance's own headline clause**, and the shape of the miss is worth keeping: three live "Standard/Max **toggle**" / "no model choice" claims survived in §2.3 and §4.1 — current-state sections — while the IDENTICAL phrase was found and reconciled one screen away at §4.2's `Model policy` line, and while the bullet directly beneath one of them (`:203`) was edited in the same pass. The docs were swept by following the plan's file list and the feature's own vocabulary ("premium", `decidePremium`, `PremiumToggle`); the surviving claims used **different words for the same idea**. A rename sweep that greps the OLD implementation's nouns will not find the places that described the old BEHAVIOUR in a vocabulary nobody standardised. Also missed: `CLAUDE.md`'s surviving-selectors sentence still named two of three (its mirror in `spec/billing.md` was explicitly in the task text and got fixed — the un-named mirror did not), and §8b-3 cited the **superseded** 2026-07-30 sonnet-only KIE reading as evidence about sonnet-5, which `constants.ts` itself records as a misreading. All eight fixed and re-verified.*
  - *Built with one **scope departure**: three files outside T16's list (`spec/context-budget.md`, `spec/fail-loud.md`, `FORK_BASE.md`, 21 lines) carried outright FALSE present-tense claims rather than merely stale ones — most sharply `spec/context-budget.md` asserting "the platform default is now Opus 4.8", a THIRD answer disagreeing with every other document in the repo, in a file SPEC §11 indexes as a sub-spec. T16 is the last task, so nothing later would have covered them. Also fixed while following SPEC's own update contract: `SPEC.md:1424`'s sub-spec index listed 7 of the 14 files in `spec/` — including neither of the two carrying wrong default-model claims.*
  - *A second FAIL-then-fix on a residual: `GETTING_STARTED.md:147` told a rebuilder to **verify** "credits UI only, **no model names anywhere**" — false since the pill renders `Sonnet 5`, and one line below text edited in this very pass. Same species as the round-1 miss (an unswept neighbour of an edited line), and worse in kind because it is a VERIFICATION INSTRUCTION: someone following it literally would look at a correct build and call it broken.*
  - *🔴 **`rates.ts:814-821` fixed too, outside the file list and deliberately** — `800` → `1000`, `~2.8×` → `~3.7×`. Not a passing mention: it is the worked example inside `grantHeadroom`'s doc block, i.e. the function whose whole job is guarding the grant-vs-provider relationship, and the block is itself a lecture about *"the grant size and the provider are ONE number split across two files… the same shape of bug as `packMargin()`"*. **A doc block warning about two numbers drifting, while holding the drifted number, is the `shell-strip.ts` pathology in its purest form** — a false claim in a comment is how the thing it warns about survives review. Comment-only, no behaviour.*
  - *⚠️ **Flagged, NOT fixed:** the "~231 credits a cold build" figure that the ~3.7× headroom derives from is an **Opus-era measurement**, never re-derived for the `claude-sonnet-5` default (~2.35× cheaper on KIE). Left alone on purpose: `grantHeadroom` computes from the LIVE platform model and `MIN_GRANT_HEADROOM = 1.5` is asserted in `billing.spec.ts`, so the CODE already recomputes — only the prose is stale, and it errs SAFE (the real headroom exceeds the documented one). A doc that understates a safety margin is a far smaller problem than one that overstates it, and inventing a replacement number is worse than carrying a conservative one. Re-derive when someone next measures a real Sonnet cold build.*

---

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute _specs/supermax-model-tier_plan.md T1`), run every remaining task in order with `bt-execute _specs/supermax-model-tier_plan.md ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at _specs/supermax-model-tier_plan.md".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
