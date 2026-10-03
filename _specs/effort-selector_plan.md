# Effort selector — Medium / High / Extra high / Max (plan)

Owner request (2026-10-02): replace the hidden `/effort` floor (Medium or High only) with a visible
**dropdown / notched slider** offering every effort level the Managed Agents engine supports **except
`low`**: `medium` (default + minimum), `high`, `xhigh`, and `max` behind an operator switch that ships
OFF (D11). "Ultracode" is a Claude Code feature,
not an API effort level — it does not exist in the SDK (`@anthropic-ai/sdk` 0.131.0 enum is
`low | medium | high | xhigh | max`), so excluding it needs no code.

**This REVERSES a standing rule** (SPEC §4.2.9 / §4.2a L571, CLAUDE.md "THE USER SETS A FLOOR, NOT A
LEVEL — `medium` or `high`, NOTHING ELSE", `spec/anthropic-models.md` §3.6a): `xhigh`/`max` become
user-pickable, and the control becomes visible in the chat row. Owner-directed; the docs change in the
same PR (T9).

## How billing works (why this is safe for the platform)

Effort has no price of its own. It changes how many **thinking tokens** the model spends, and thinking
bills at the **output** rate. Credits are cost-proportional
(`credits = ceil(raw / CREDIT_UNIT_COST_USD × CREDIT_MARGIN)`), so a `max` turn that costs us 2× bills
the user ~2× — **margin unchanged**. On managed, longer turns also bill more session-hours
(`MANAGED_SESSION_HOUR_USD`), passed through the same way. Platform exposure is limited to:

- **Hard-failure refunds** — a failed `max` turn refunds a bigger bill (Stop / budget stop never refund).
- **Turn credit ceiling** (`AGENT_TURN_MAX_CREDITS` ∧ balance → the session's `max_list_cost`) is hit
  sooner → more "Keep building" pauses. Bounded spend, no loss.
- **Effort switch on managed = new session** (see below) → a cold cache rewrite (~2× one prefix) the
  user pays for, once per switch.

## What exists today (recon 2026-10-02)

- `capabilities.ts:153` `EFFORT_LEVELS = ['medium','high','xhigh','max']` — already the target set;
  `low` is not representable. `USER_EFFORT_LEVELS = ['medium','high']` (L227) and `parseUserEffort`
  (L244) refuse `xhigh`/`max`.
- Client: `stores/effort.ts` (`baseEffortStore`, session-only), `EffortPanel.tsx` (radio rows, opens only
  via `/effort` or the `/context` row), effort shown in `ModelTierPill` tooltip + `ContextIndicator`.
  Body field `effort` is sent on every send path (`Chat.client.tsx:832`).
- Legacy engine (Plan mode, MCP turns, enhancer): `proxy.ts:2108` → `effortForTurn` folds the user floor
  by rank — already correct for 4 levels.
- 🔴 **DEFECT — MANDATORY FIX IN THIS PLAN (owner, 2026-10-02): the managed engine (the default for
  build turns) IGNORES the user's effort entirely.** The feature is not done until a build turn runs at
  the effort the user picked (T4, verified live in T8).
  `engine.ts:117` declares `effort` and nothing reads it; effort comes from the deploy-wide
  `MANAGED_AGENT_EFFORT` (`config.ts:86`, silently `medium` unless exactly `high`). So `/effort high`
  does nothing on build turns today.
- SDK facts: effort can be set **on the agent** or **per session at create** via
  `agent: { type:'agent_with_overrides', id, version, model:{ id, effort } }`
  (`sessions.d.ts:142–177`). It **cannot** be set per `user.message` event or on `sessions.update`
  (only `tools`/`mcp_servers`). A session is pinned for life. `xhigh`: "Not all models accept this level."

## Decisions

- **D1 — Levels.** `medium` (default) · `high` · `xhigh` (label "Extra high") · `max`. `low`, unknown
  strings and non-strings resolve to `undefined` → the default (`medium`). Never clamp UP — the value
  arrives in a browser body. `parseUserEffort` stays a separate exact-match whitelist; never route a
  browser value through `parseEffort` (which clamps `low`→`medium`, an operator convenience).
- **D2 — Managed: per-session override, NOT 12 agents.** Keep one agent per rung. Create every new
  session with `agent_with_overrides` + `model:{ id: agentRecord.model, effort }`. No extra
  provisioning, no Synchronize change.
- **D3 — Effort change on managed MOVES the session**, exactly like a tier change: detect via
  `session.agent.model.effort`, then the existing supersede → settle old tail → archive → new session →
  `conversationRecap` path. A RESUME never switches. The picker says so ("Changing effort starts a fresh
  session for the next message").
- **D4 — No repair escalation on managed.** Escalating per repair would force a session move per repair.
  Managed repairs run at the user's level. Legacy keeps its ladder (repair 1 ≥ `high`, repair 2 ≥
  `xhigh`, by rank over the user's choice — a `max` user stays `max`).
- **D5 — Per-model `xhigh` support is DATA, default-allowed.** A deny-list
  (`MODELS_WITHOUT_XHIGH`, same shape as `MODELS_WITHOUT_ADAPTIVE_THINKING`) clamps `xhigh`→`high` for a
  model that rejects it; a new model needs no code (§4.6.1a). Seeded from the T1 probe. The served
  (post-clamp) effort is what gets recorded and shown.
- **D6 — Persisted per browser.** The old "never persist" rule existed because a raised floor billed
  more "with no visible signal". The control is now always visible with its current value, so it
  persists like the model tier (`settings.ts` / localStorage). Default `medium` for new browsers.
- **D7 — Visible control, fixed footprint.** A compact pill (`Medium ▾`) in the composer's right group,
  just before `ModelTierPill`, opening the existing `EffortPanel` re-built as a **4-notch segmented
  slider** plus the selected level's description and cost note. Fixed width (the widest label) so the
  row never resizes (§4.1a). `/effort` and the `/context` row still open it. Tooltip line in the model
  pill is dropped (the value is on screen).
- **D8 — Operator default.** `MANAGED_AGENT_EFFORT` widens to all four levels via `parseEffort`
  (provisioned agent base effort, used only when no user value arrives). Precedence: user choice >
  operator default > `medium`; legacy policy escalation on top.
- **D9 — Record the served effort.** New `generations.effort` column (migration `0027`), written on both
  engines, declared in `FIELD_COVERAGE`, shown in `/context`.
- **D10 — No balance threshold for `xhigh`/`max`.** Owner: it just burns the user's credits. The turn
  ceiling already bounds a single turn.
- **D11 — Max ships OFF, behind config (owner, 2026-10-02).** The platform prepays Anthropic, so the
  pool's drain RATE matters even though every credit is user-backed. Offered by default: Medium · High ·
  Extra high. `ENABLE_MAX_EFFORT` (default `false`) adds the Max notch. When off, `parseUserEffort` on the
  server resolves `max` to `undefined` (the default) — never trust the client to hide it — and
  `MANAGED_AGENT_EFFORT`/`THINKING_EFFORT` may still name `max` (operator choice). The offered list
  reaches the client on `/api/me` (`effortLevels`), so the slider shows 3 or 4 notches with no rebuild.

- **D12 — Compact meter in an open project (auto-pilot, T8).** The chat column is a fixed 533px, and a
  labelled pill (87px) pushed the model pill past the composer edge. So in an open project the control is a
  26px level meter (one bar per offered level, filled to the current one; tooltip + aria-label name the
  level); the landing composer keeps the icon + label pill. D7's constraints (always visible, value
  visible, fixed footprint, row never resizes) still hold. Persistence lives in `stores/effort.ts`
  (`bt_effort_level`), not `settings.ts`.

## Tasks

- [x] **T1 — Wire probe (managed).** Script `scripts/effort-probe.mjs`: for each rung model
  (`LLM_MODEL`, `PREMIUM_MODEL`, `PLATINUM_MODEL`) create a session with `agent_with_overrides` at
  `xhigh` and `max`, send one short message, read back `session.agent.model.effort`, archive.
  Also confirm an overrides session still accepts `sessions.update({ budget })` (engine.ts:467 uses it).
  **Acceptance:** a table of model × level → accepted / 400 text, committed in this plan's Findings;
  seeds D5.
- [x] **T2 — Shared levels + parser.** `capabilities.ts`: `USER_EFFORT_LEVELS = EFFORT_LEVELS`
  (derive, don't retype), rewrite the doc comments, add `MODELS_WITHOUT_XHIGH` +
  `servableEffort(model, effort)` (clamps `xhigh`→`high` for listed models; `max` untouched).
  `anthropic.spec.ts`: flip the "refuses xhigh/max" test to accepts; keep `low`/typo/non-string →
  `undefined`; add servableEffort cases incl. an unknown future model (allowed).
  Add `offeredUserEffortLevels(context)` (server) reading `ENABLE_MAX_EFFORT` (D11); the
  server-side parse takes the offered list, so `max` with the switch off → `undefined`.
  **Acceptance:** spec green; mutation — re-narrowing the array fails it; `max` refused with the switch
  off and accepted with it on (pinned both ways).
- [x] **T3 — Managed config + record types.** `config.ts` / `record.ts` widen `effort` to `EffortLevel`;
  `MANAGED_AGENT_EFFORT` parsed with `parseEffort` (default `medium`, `low` → `medium` with a warning).
  Update `config.spec.ts`, `provision.spec.ts`, `.env.example`.
  **Acceptance:** `MANAGED_AGENT_EFFORT=max` provisions at `max`; garbage → `medium`.
- [x] **T4 — 🔴 MANDATORY: fix the managed engine ignoring the user's effort.** `engine.ts`: `effort =
  servableEffort(agentRecord.model, parseUserEffort(request.effort) ?? config.effort)`; session create
  uses `agent_with_overrides` with `model:{ id, effort }`; `session-health.ts` exposes `effort` from
  `agent.model.effort`; the switch condition becomes `model differs || effort differs` (never on
  resume), reusing the tier-switch path unchanged. Emit the served effort in `agentMeta`.
  Tests in `engine-tier.spec.ts` (or new `engine-effort.spec.ts`): effort change moves the session +
  carries the recap; same effort reuses the session (CONTROL); resume never switches; `low`/garbage
  serve the default. `fake-session.testkit.ts` echoes the requested effort.
  **Acceptance:** mutation — dropping the effort comparison fails the move test.
- [x] **T5 — Legacy path.** `effort-policy.ts` comments rewritten; add `xhigh`/`max` floor cases to
  `effort-policy.spec.ts` (max floor stays max on repair 2; xhigh floor on repair 1 stays xhigh); apply
  `servableEffort` after `effortForTurn` in `proxy.ts`. `canDisableThinking` clamp unchanged (Opus 5 at
  xhigh/max keeps thinking adaptive on the last retry — already handled).
  **Acceptance:** spec green.
- [x] **T6 — Record served effort.** Migration `0027_generation_effort.sql` (`effort text null`), store
  writes on both engines, `FIELD_COVERAGE` entry, `ledger-sql.spec.ts`/`field-coverage.spec.ts` pass.
  `/context` reads it from the annotation.
  **Acceptance:** a generation row carries `effort`; NULL = unknown (pre-migration rows).
- [x] **T7 — Store + persistence.** `stores/effort.ts`: 4-entry `EFFORT_LABELS` / `EFFORT_DESCRIPTIONS`
  (honest copy: Max = slowest, most credits per turn; Extra high = for hard bugs/big systems), persist
  in `settings.ts` like `modelTierStore` with `parseUserEffort` on read (a corrupt stored value →
  `medium`). Update `client-commands.ts` description.
  The offered levels come from `/api/me` `effortLevels`; a stored `max` while Max is switched off
  resolves to Medium (the default — never a silent step to `xhigh`).
  **Acceptance:** reload keeps the choice; corrupt localStorage → Medium; stored Max with the switch
  off → Medium.
- [x] **T8 — The control.** Generalise `components/ui/Slider.tsx` to N options with a per-instance
  `layoutId` (and `type="button"`), or add `NotchedSlider.tsx`; rebuild `EffortPanel` around it (4
  notches, labels under each, selected description, "changing effort starts a fresh session" note on
  managed); add `EffortPill` trigger before `ModelTierPill` in `ChatBox.tsx`, fixed width, `aria-label`
  with the current level. Keyboard: arrows move notches, Escape closes. Drop the pill tooltip's effort
  line. Specs: `EffortPanel.spec.tsx` (4 options, no Low, selection sets the store), row-width pin.
  **Acceptance:** driven live in Chrome — pick Max, send a build turn, `/context` shows Max and the
  managed session is new; pick Medium again → another new session; row width identical at Medium and
  Extra high; `body.style.paddingRight` stays `0px` with the panel open.
- [x] **T9 — Docs (same PR).** SPEC.md L286/L288/L466/L570–572/L1144–1163/L1341 + a §8l decision
  entry; `spec/anthropic-models.md` L3, §3.5, §3.6a (+ L486 "nothing selects max"); CLAUDE.md effort
  entry and managed bullet; `_specs/managed-agents-engine_plan.md` new decision (don't edit D10
  history); `spec/agent-seams.md` line refs if `proxy.ts` moved.
  **Acceptance:** spec-consistency sweep finds no remaining "medium or high only" / "xhigh/max
  unofferable" / "/effort does not apply on managed" text.
- [ ] **T10 — Gates.** `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` green; `pnpm dev`
  runs.

## Findings

### T1 — managed effort probe (`scripts/effort-probe.mjs`, run live 2026-10-02 against api.anthropic.com)

Each cell: a session created with `agent: { type: 'agent_with_overrides', id, version, model: { id, effort } }`
on that rung's own provisioned agent (`.data/storage/prompt` `managedAgents`, all `:medium`), WITH a
budget at create (as `engine.ts` `budgetFor(0)` does), read back, budget raised via `sessions.update`,
then archived. No message sent (creation acceptance + matching read-back = accepted; no turn billed).

| rung | model | level | result | read-back `agent.model.id` | read-back `agent.model.effort` | `sessions.update({budget})` | archived |
|---|---|---|---|---|---|---|---|
| standard | claude-sonnet-5-5 | high (control) | accepted | claude-sonnet-5-5 | high | ok | yes |
| standard | claude-sonnet-5-5 | xhigh | accepted | claude-sonnet-5-5 | xhigh | ok | yes |
| standard | claude-sonnet-5-5 | max | accepted | claude-sonnet-5-5 | max | ok | yes |
| premium | claude-opus-5-5 | high (control) | accepted | claude-opus-5-5 | high | ok | yes |
| premium | claude-opus-5-5 | xhigh | accepted | claude-opus-5-5 | xhigh | ok | yes |
| premium | claude-opus-5-5 | max | accepted | claude-opus-5-5 | max | ok | yes |
| platinum | claude-fable-5-1 | high (control) | accepted | claude-fable-5-1 | high | ok | yes |
| platinum | claude-fable-5-1 | xhigh | accepted | claude-fable-5-1 | xhigh | ok | yes |
| platinum | claude-fable-5-1 | max | accepted | claude-fable-5-1 | max | ok | yes |

- **D5 seed: `MODELS_WITHOUT_XHIGH` starts EMPTY** — every rung accepts `xhigh` and `max` as a session
  override, and the read-back echoes the requested effort (a bare string, so T4's `session-health`
  can compare `agent.model.effort` directly). The deny-list stays as data for a future model that rejects it.
- **Budget on an overrides session works — but only if attached AT CREATE.** Two wire facts found on the
  way (both already satisfied by `engine.ts`, recorded so T4 does not regress them): a session created
  WITHOUT a budget can never gain one (`400 budget can only be attached when a session is created`), and
  `max_list_cost.amount` is a STRING of cents (`400 invalid value for string field amount` for a number —
  `budgetAmountCents` returns a string). T4's `agent_with_overrides` create must keep `budget` on create.
- Not measured: whether a model accepts the level on an actual inference call (no message was sent).
  Creation validates the model config; if a live turn ever 400s on a level, add the model to
  `MODELS_WITHOUT_XHIGH` (no code change beyond the entry).
