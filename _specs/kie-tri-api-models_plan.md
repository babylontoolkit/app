# Plan for kie-tri-api-models

> Spec: `_specs/kie-tri-api-models_spec.md` (live-probed 2026-08-04). Planned by /bt-plan on
> 2026-08-04. Motivation: KIE's Claude gateway regressed to fully batched delivery (~2026-08-01)
> while KIE's GPT surface streams properly; family support restores progressive file-by-file
> artifact streaming and adds model breadth across Claude / GPT / Gemini on the single KIE provider.

## Codebase Analysis

Read in full: `_specs/kie-tri-api-models_spec.md`, root `SPEC.md` (via CLAUDE.md's binding digest),
plus targeted reads across the provider, billing, delivery, history, retry, tier-UI and probe
layers. Findings that ground the tasks:

- **Provider layer** — `app/lib/modules/llm/providers/kie.ts` (`KieProvider`, `name: 'KIE'`):
  `getModelInstance` builds `createAnthropic({ baseURL: KIE_DEFAULT_BASE_URL, fetch:
  thinkingFetch(...) ∘ kieFetch(...) ∘ rateLimitFetch(...) })`, then `stripSamplingParams` /
  `dropOrphanReasoningSignatures`. 🔴 **It does not accept `thinkingMode`** — `proxy.ts:1802-1809`
  passes `thinkingMode: 'disabled'` on the last-resort retry and kie.ts silently drops it (excess
  property across the function-type boundary), so the retry-with-thinking-disabled mitigation is a
  live no-op on the default platform provider. FR3 fixes this as a side effect.
- **Wire module** — `app/lib/modules/llm/providers/kie-wire.ts` (client-safe, provider-import-free):
  `KIE_DEFAULT_BASE_URL = 'https://api.kie.ai/claude/v1'`, `kieFetch` (sets `thinkingFlag: true`
  unconditionally), `KIE_MODELS` (9 Claude rows), `kieEnvModel` (`LLM_MODEL > KIE_DEFAULT_MODEL`,
  synthesizes a 1M/128k `ModelInfo`; the model MUST be listed or upstream `stream-text.ts` falls
  back to `modelsList[0]`).
- **Capabilities** — `app/lib/modules/llm/capabilities.ts` (client-safe, deny-list tables):
  `thinkingFetch` / `stripSamplingParams` / `dropOrphanReasoningSignatures` / `canDisableThinking`
  are all Claude-shaped. ⚠️ A `gpt-*`/`gemini-*` id today falls through `supportsSamplingParams` →
  false (temperature stripped) and `supportsAdaptiveThinking` → true (Anthropic `thinking` body
  injected) — the exact 400-producing path FR3 pins dead. Family gating must run BEFORE any of
  these wrap.
- **SDK versions** (the hard constraint, verified in `package.json` + node_modules + npm):
  `ai@4.3.16`, `@ai-sdk/anthropic@1.2.12` (HARD GATE — unchanged), `@ai-sdk/openai@1.1.2` (**no
  `.responses()`** — landed in 1.3.x), `@ai-sdk/google@0.0.52` (**ai@3-era**, `@ai-sdk/provider@
  0.0.24`; upstream `google.ts` only type-checks by luck). Evidence-settled path: `@ai-sdk/openai@
  1.3.24` and `@ai-sdk/google@1.2.22` both depend on `@ai-sdk/provider@1.1.3` +
  `@ai-sdk/provider-utils@2.2.8` — **identical to the anthropic/ai tree**, so both bumps preserve
  the gate by construction and no hand-rolled LanguageModelV1 is needed.
- **Billing** — `app/lib/.server/billing/market-prices.ts`: `LlmMarketRate = { inputPerMTok,
  outputPerMTok }`; `validateMarketPriceList` L184-197 is the single "cache rates are never quoted"
  wall (refuses extra keys; errors COLLECTED, never thrown). `rates.ts`: `ratesFromBase(input,
  output, cache?)` **already accepts explicit cache overrides**; `llmRatesFromList` currently
  passes no third arg — these two are the whole schema seam. `ratesFor` most-expensive fallback,
  `providerRates` fill-a-gap injection, `rawCostUsd` settlement math all unchanged in shape.
- **Usage extraction** — two hardcoded `providerMetadata.anthropic` reads: `agent/step-usage.ts`
  L82-84 (`accumulateStepUsage`) and `proxy.ts:1456-1458` (step telemetry → persisted step log).
  No `usage-metadata.ts` or family abstraction exists anywhere (confirmed absent).
- **Delivery** — `agent/delivery.ts`: `DELIVERY: Record<PlatformProviderName, DeliveryMode>`,
  `providerDeliveryMode(provider)`; single call site `proxy.ts:2176` where `config.model` is in
  scope. Heartbeat (`agent/heartbeat.ts`) carries `deliveryMode`/`typicalMs`; client store
  `stores/agent-status.ts` whitelists the mode at ingest, `deliveryNote` emits the batch sentence,
  `PROGRESS_CAP = 0.95`. The file's own doc block argues "keyed by PROVIDER, never by model" — must
  be rewritten (provider+family), not just extended.
- **History** — `app/lib/.server/llm/history.ts` (note: NOT under `agent/`): `stripReasoning`
  drops `parts.type === 'reasoning'` + `message.reasoning` for assistant messages — SDK-level, so
  it may already cover the new families; FR10's audit is fixture-driven from real captures.
- **Retry** — `agent/retry-policy.ts`: module-private `RETRYABLE`/`FATAL` regex lists on message
  text; `retryThinkingMode` (last attempt → 'disabled'); ⚠️ FATAL's broad `/invalid/i` and
  `/not found/i` must be checked against probed gateway strings.
- **Tier UI** — `stores/model-tier.ts` `parseModel` uses a **claude-only regex** (`gpt-5-6-sol`
  falls through to the raw id) — the single choke point for display names. `modelTiersSessionHint`
  (`billing/premium.ts` L373) already returns per-tier `model`, so the server→client plumbing for
  FR8 exists; only parsing/rendering changes.
- **Cache warmer** — `prompt/cache-warmer.ts` `buildWarmupRequest` hardcodes
  `${KIE_DEFAULT_BASE_URL}/messages` + `anthropic-version` header → would warm the wrong endpoint
  for a non-Claude platform model; `ensureCacheWarmer` (L308) is the guard point.
- **Probes** — `scripts/kie-model-health.mjs` (hardcoded claude MODELS array + `/messages`),
  `stream-probe.mjs` (hardcoded `claude-opus-5`, Anthropic SSE parse), `cache-probe.mjs`
  (hardcoded `https://api.kie.ai/claude/v1`, no `KIE_BASE_URL` fallback).
- **Tests that the change breaks (and must become family-aware, keeping Claude assertions exact):**
  `billing.spec.ts` L276 ("cache WRITES at 2× on every provider"), L284 (0.1× reads), L355
  ("derives every baked row exactly"); `market-prices.spec.ts` L118-123 (rejects quoted cache
  rates — splits by family); `delivery.spec.ts` (provider-only signature); `kie.spec.ts` +
  `model-tiers.spec.ts` (listed↔priced pins); `step-usage.spec.ts` (signature gains family).
- **Conventions honored:** additive-first (new modules beside existing ones), client-safe module
  rules (`.server` may import client-safe, never the reverse), wire-level spec style (spy-fetch
  serialized-body assertions per `anthropic.spec.ts`), errors-collected validation, verified-ids
  rule (no unprobed id ships), and the standing hazard: **NO full-suite `pnpm test` run** (it
  currently destroys local `.data`) — targeted vitest only.

**SPEC.md alignment:** conforms to §4.2a (Claude wrappers byte-identical), §4.6.1/§4.6.1a (class
selection, resolve-DOWN, serveable vs available), §4.2.8/`spec/context-budget.md` (append-only
prefix — also powers OpenAI automatic prefix caching), `spec/billing.md` §"Marketplace price list"
(all prices from the promoted list), `spec/anthropic-models.md` (unchanged for Claude).
**spec_impact: yes** (from the feature spec) → T12 is the SPEC.md write-back task. One standing
rule is *extended*, not broken: "cache rates are never quoted in the list" becomes family policy.

## Design decisions (settled, with evidence)

1. **Both SDK bumps, no hand-rolling** — `@ai-sdk/openai@1.3.24` + `@ai-sdk/google@1.2.22` land on
   `@ai-sdk/provider@1.1.3` / `@ai-sdk/provider-utils@2.2.8`, identical to the pinned anthropic/ai
   tree; `pnpm why @ai-sdk/provider` before/after is the gate.
2. **Effort via fetch wrappers, not providerOptions** — `@ai-sdk/openai`'s responses model only
   emits `reasoning.effort` when its internal id heuristic classifies the model as a reasoning
   model (written for OpenAI's own ids; `gpt-5-6-sol` not guaranteed to match, and a silent drop
   buys the server default). `codexFetch` writes `body.reasoning = { ...body.reasoning, effort }`
   deterministically — the established `thinkingFetch`/`kieFetch` seam pattern. Likewise
   `@ai-sdk/google@1.2.22` predates `thinkingLevel` (knows only `thinkingBudget`), so `geminiFetch`
   writes `generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel }` itself.
3. **`model-families.ts` is client-safe** (beside `capabilities.ts`) so both the provider tree and
   `.server` billing can import it. Wire builders do NOT live in the family record (would recreate
   the provider import cycle `kie-wire.ts` documents) — the `kie.ts` switch is the wire binding.
   Delivery mode also stays out (it is `.server` policy in `delivery.ts`).
4. **`KIE_BASE_URL` stays claude-scoped** (its current meaning); codex/gemini get their own base
   constants. Documented in kie.ts.
5. **Stored-list re-validation interaction is acceptable:** already-promoted lists hold only claude
   rows → still valid under the new per-family rules. A future half-paired gpt row fails
   `loadVersion` re-validation → platform serves baked (the existing, documented degradation).

## Tasks

- [x] **T1** — `model-families.ts`: family derivation + per-family policy (pure foundation)
  - Files: `app/lib/modules/llm/model-families.ts` (new), `app/lib/modules/llm/model-families.spec.ts` (new)
  - Details: `MODEL_FAMILIES = ['claude','codex','gemini']`; `familyOf(modelId)` (`claude-*` →
    claude with a `bareModelId`-style `anthropic.` strip, `gpt-*` → codex, `gemini-*` → gemini,
    unknown → undefined); `requireFamily(modelId)` throws naming the id and the three accepted
    prefixes (FR1's loud refusal); `FAMILY_POLICY: Record<ModelFamily, { cacheProfile:
    'derived'|'explicit-pair'|'none'; usageNamespace: 'anthropic'|'openai'|'google';
    maxTokenAllowed; maxCompletionTokens }>`; `codexEffort(mode, effort)` (disabled→low,
    medium→medium, high→high, xhigh→xhigh, max→xhigh); `geminiThinkingLevel(mode, effort)`
    (disabled→low, medium→low, high/xhigh/max→high).
  - Acceptance: spec pins derivation (incl. `anthropic.`-prefixed ids), the `requireFamily` throw
    message, both effort mappers exhaustively over `EFFORT_LEVELS` incl. the disabled mappings.
    `pnpm typecheck` green; nothing existing breaks.

- [x] **T2** — Price-list schema: optional explicit cache pair with per-family policy
  - Files: `app/lib/.server/billing/market-prices.ts`, `app/lib/.server/billing/rates.ts`,
    `app/lib/.server/billing/market-prices.spec.ts`, `app/lib/.server/billing/billing.spec.ts`,
    `app/components/@settings/tabs/admin/MarketPricesSection.tsx`
  - Details: `LlmMarketRate` gains `cachedInputPerMTok?` + `cacheWritePerMTok?`. Replace the flat
    extras-refusal in `validateMarketPriceList` (L184-197) with family policy via `familyOf`:
    unknown family → error; claude → pair REFUSED (current wording); codex → BOTH required
    atomically (half-pair → error naming the missing half); gemini → pair REFUSED ("bills cached
    tokens at full input rate"). All errors still accumulate. In `rates.ts`, `llmRatesFromList`
    passes a per-family third arg to the existing `ratesFromBase(input, output, cache?)`: codex →
    `{ cacheReadPerMTok: cachedInputPerMTok, cacheWritePerMTok }`; gemini → `{ cacheReadPerMTok:
    inputPerMTok, cacheWritePerMTok: inputPerMTok }`; claude → undefined (derive 0.1×/2×,
    unchanged). Reword the admin panel footer ("cache prices derive…") per family + document the
    API-id rule (dashes, never feed display names) in the panel help text; mirror the optional
    pair in the panel's local `LlmRow` type.
  - Acceptance: gpt pair round-trips through validate→rates; half-pair refused (both errors
    reported at once); gemini and claude pairs refused; gemini rows derive read = write = input;
    claude derivation byte-identical (existing exact-number pins stay green). `billing.spec.ts`
    L276/L284/L355 pins rewritten family-aware with claude assertions exact.

- [x] **T3** — `usage-metadata.ts`: one per-family cache-token reader, both call sites rewired
  - Files: `app/lib/.server/agent/usage-metadata.ts` (new), `app/lib/.server/agent/usage-metadata.spec.ts` (new),
    `app/lib/.server/agent/step-usage.ts`, `app/lib/.server/agent/step-usage.spec.ts`,
    `app/lib/.server/agent/proxy.ts` (~L1456)
  - Details: `extractStepCacheTokens(providerMetadata, family): { cacheReadTokens,
    cacheCreationTokens, sawNamespace }`. Namespaces: `anthropic.{cacheReadInputTokens,
    cacheCreationInputTokens}`; `openai` cached-token key written as a named constant with a
    PLACEHOLDER fixture, CONFIRMED and re-pinned from the T11 live capture (FR5 — never assumed);
    `google.cachedContentTokenCount` (expected zeros). Missing individual values → silent zero;
    `sawNamespace: false` on a cache-priced family (claude/codex) drives ONE warning per
    generation in the proxy — "nothing cached" and "counter disappeared" must read differently.
    `accumulateStepUsage` gains a `family` param (caller passes `familyOf(config.model)`); the
    proxy telemetry read at L1456-1458 uses the same reader.
  - Acceptance: claude identity pin — a fixture test asserting the new reader's output is
    byte-identical to today's inline `providerMetadata.anthropic` read; per-family extraction from
    fixtures; missing-namespace warning fires once and only for cache-priced families;
    `step-usage.spec.ts` updated for the signature.

- [x] **T4** — SDK bumps behind the hard gate
  - Files: `package.json`, `pnpm-lock.yaml`; compile fixes (if any) in
    `app/lib/modules/llm/providers/openai.ts` / `google.ts`
  - Details: `@ai-sdk/openai` 1.1.2 → 1.3.24, `@ai-sdk/google` 0.0.52 → 1.2.22. Capture
    `pnpm why @ai-sdk/provider` BEFORE and AFTER. ⚠️ pnpm hazard (a bare `pnpm install`
    re-resolves the whole tree) — add both as exact-versioned updates and DIFF the lockfile:
    the `@ai-sdk/anthropic@1.2.12` and `ai@4.3.16` dependency subtrees must be byte-unchanged.
    If a bump drags `@ai-sdk/provider` incompatible (not expected — both land on 1.1.3), fall
    back to the spec's hand-rolled LanguageModelV1 escape hatch for that family instead.
  - Acceptance: `pnpm why @ai-sdk/provider` shows all three vendor SDKs on 1.1.3 with the
    anthropic/ai tree unchanged; `pnpm typecheck` green; existing provider specs
    (`anthropic.spec.ts`, `kie.spec.ts`) green untouched.

- [x] **T5** — `kie-codex-wire.ts`: the GPT (OpenAI Responses) wire
  - Files: `app/lib/modules/llm/providers/kie-codex-wire.ts` (new),
    `app/lib/modules/llm/providers/kie-codex-wire.spec.ts` (new)
  - Details: `KIE_CODEX_BASE_URL = 'https://api.kie.ai/codex/v1'`; `codexFetch(effort, baseFetch?)`
    following `kieFetch`'s exact defensive shape (non-string/non-JSON body → pass through) writing
    `body.reasoning = { ...(body.reasoning ?? {}), effort }`. Client-safe, provider-import-free.
    Leave a decided seam: if the T11 probe shows KIE's gateway 400s on the `temperature: 0` that
    ai@4 injects, strip sampling params HERE (this one seam) and pin it.
  - Acceptance: wire-level spec in the `anthropic.spec.ts` style (spy fetch, real
    `createOpenAI().responses()` + `streamText` against a replayed Responses-wire SSE Response):
    serialized body carries `reasoning.effort` for every mapping incl. disabled→low; URL is
    exactly `/codex/v1/responses`; `Authorization: Bearer` header; non-JSON passthrough control.

- [x] **T6** — `kie-gemini-wire.ts`: the Gemini native wire
  - Files: `app/lib/modules/llm/providers/kie-gemini-wire.ts` (new),
    `app/lib/modules/llm/providers/kie-gemini-wire.spec.ts` (new)
  - Details: `KIE_GEMINI_BASE_URL = 'https://api.kie.ai/gemini/v1'`; `geminiFetch(thinkingLevel,
    baseFetch?)` writing `body.generationConfig = { ...gc, thinkingConfig: { includeThoughts:
    true, thinkingLevel } }` (the SDK predates `thinkingLevel` — the fetch owns it).
  - Acceptance: wire-level spec: `thinkingConfig` rewrite pinned for both levels; Bearer header;
    composed URL exactly `/gemini/v1/models/<id>:streamGenerateContent`; non-JSON passthrough.

- [x] **T7** — `kie.ts` family dispatcher (+ `thinkingMode` in the signature, `kieEnvModel` family-aware)
  - Files: `app/lib/modules/llm/providers/kie.ts`, `kie-wire.ts` (KIE_MODELS + kieEnvModel),
    `app/lib/.server/billing/baked-market-prices.ts`, `kie.spec.ts`,
    `app/lib/.server/billing/model-tiers.spec.ts`
  - Details: `getModelInstance` gains `thinkingMode?: ThinkingMode` (fixing the live proxy:1802
    no-op — resolution `options.thinkingMode ?? (serverEnv.THINKING_MODE === 'disabled' ?
    'disabled' : 'adaptive')`), calls `requireFamily(options.model)` FIRST (loud refusal before
    any key lookup or wire), then switches: claude → the current body verbatim (wrappers
    byte-identical, `thinkingFetch` now fed the resolved mode — `canDisableThinking` clamps
    unchanged); codex → `createOpenAI({ apiKey, baseURL: KIE_CODEX_BASE_URL, headers: Bearer,
    fetch: codexFetch(codexEffort(mode, effort), rateLimitFetch(...)) }).responses(model)`;
    gemini → `createGoogleGenerativeAI({ apiKey, baseURL: KIE_GEMINI_BASE_URL, headers: Bearer,
    fetch: geminiFetch(geminiThinkingLevel(mode, effort), rateLimitFetch(...)) })(model)`.
    `KIE_BASE_URL` stays claude-scoped (documented). Claude wrappers (`stripSamplingParams`,
    `dropOrphanReasoningSignatures`, `thinkingFetch`, `kieFetch`) NEVER wrap other families.
    `KIE_MODELS` gains `gpt-5-6-sol`, `gpt-5-6-luna`, `gemini-3-5-flash` rows (live-probed ids
    ONLY — `gpt-5-6-terra` stays out); `kieEnvModel` sources `maxTokenAllowed`/
    `maxCompletionTokens` from `FAMILY_POLICY`. Baked price rows added for the three ids from
    KIE's feed rates keyed by API id (dashes — never the feed display name), codex rows carrying
    the explicit cache pair.
  - Acceptance: family dispatch pinned per family (spy-fetch: codex body has `reasoning.effort`
    and NO `thinking`/`thinkingFlag`/`output_config`; gemini body has `thinkingConfig` and none of
    the Anthropic fields — the 400-producing path pinned dead); unknown id (`llama-3` etc.)
    refuses loudly at model resolution; `thinkingMode: 'disabled'` reaches the wire per family
    (claude clamp preserved; codex→low, gemini→low, never a 400); listed↔priced invariant green
    across all families (`kie.spec.ts` rates pin + `model-tiers.spec.ts`).

- [x] **T8** — Delivery keyed by (provider, family) + cache-warmer degradation
  - Files: `app/lib/.server/agent/delivery.ts`, `app/lib/.server/agent/delivery.spec.ts`,
    `app/lib/.server/agent/proxy.ts` (L2176), `app/lib/.server/prompt/cache-warmer.ts` (+ its spec)
  - Details: `DELIVERY` becomes `{ Anthropic: 'streamed', KIE: { claude: 'batched', codex:
    'streamed', gemini: 'streamed' /* provisional — T11 big-answer probe confirms */ } }`;
    `deliveryModeFor(provider, model)` via `familyOf`; unknown provider OR unknown family →
    'streamed' (never tell an unprobed surface's users to expect silence). REWRITE the "keyed by
    PROVIDER, never by model" doc block to "keyed by (provider, family) — the adapter in front of
    the family endpoint is the buffering boundary; still never by raw model id". Single call site
    proxy.ts:2176 → `deliveryModeFor(config.provider, config.model)`; heartbeat/client store
    untouched (mode values unchanged). `ensureCacheWarmer` no-ops when
    `familyOf(platform model) !== 'claude'` (breakpoint warming is an Anthropic `cache_control`
    mechanism; OpenAI prefix caching is automatic/unwarmable; KIE prices no Gemini caching) —
    guard at the top, before any request is built. Verify `MAX_CACHE_BREAKPOINTS` accounting
    (proxy.ts:1204-1212) never refuses/measures a non-claude turn; `CACHE_CONTROL` providerOptions
    stay attached (anthropic-namespaced → inert elsewhere).
  - Acceptance: `delivery.spec.ts` pins the (provider, family) matrix incl. unknown→streamed and
    Anthropic-any-family→streamed; the liveness batch note is reachable ONLY on KIE-claude
    (StreamingStatus/agent-status specs stay green — mode values unchanged); warmer spec pins the
    no-op for a gpt/gemini platform model and the unchanged claude warm.

- [x] **T9** — History compaction per family (fixture-driven audit)
  - Files: `app/lib/.server/llm/history.ts`, `app/lib/.server/llm/history.spec.ts` (fixtures from
    T11 captures)
  - Details: audit what the bumped SDKs round-trip into `Message`: OpenAI Responses reasoning
    items / `encrypted_content`, Gemini thought signatures. `stripReasoning` already drops
    `parts.type === 'reasoning'` + `message.reasoning` (SDK-level) — extend ONLY for whatever the
    captures show surviving (e.g. provider-metadata-carried reasoning artifacts), exactly as the
    Anthropic thinking-strip rule does. Cross-family guarantee: a compacted history never carries
    family A's reasoning artifacts to family B (the mid-conversation rung-repoint edge case).
  - Acceptance: fixture-driven tests from real probe captures (not docs): codex and gemini
    assistant turns round-trip through `compactHistory` with no reasoning artifacts surviving;
    the five existing Anthropic strip pins stay green unchanged.

- [x] **T10** — Retry policy: harvested gateway strings
  - Files: `app/lib/.server/agent/retry-policy.ts`, `app/lib/.server/agent/retry-policy.spec.ts`
  - Details: harvest codex/gemini gateway transient error-message shapes from the T11 probes and
    add to `RETRYABLE` (message-text matching; new gateways mean new text). Check each harvested
    transient shape against FATAL's broad `/invalid/i` and `/not found/i` — a transient that
    FATAL would swallow needs its RETRYABLE entry to be checked first or reworded. Until probed
    strings exist, a transient fault on a new family burns a turn instead of retrying —
    acceptable and temporary (spec FR11); land whatever the probes yield.
  - Acceptance: each harvested string classified retryable in the spec; a probed fatal shape
    (e.g. "model not found") stays fatal; existing classifications unchanged.

- [x] **T11** — Probe tooling, captured fixtures, delivery confirmation + tier-UI model names
  - Files: `scripts/kie-model-health.mjs`, `scripts/stream-probe.mjs`, `scripts/cache-probe.mjs`,
    fixture re-pins in `usage-metadata.spec.ts` / `history.spec.ts`, `app/lib/stores/model-tier.ts`
    (+ its spec if present), `app/components/chat/ModelTierPill.tsx`, `ModelTierPanel.tsx`
    (+ their specs)
  - Details: (a) probes go family-aware — health probe derives endpoint+body shape from the id's
    family and covers the three new ids; stream-probe takes a model argument and parses per-family
    SSE (Responses `response.output_text.delta`, Gemini chunk `candidates[].content.parts`);
    cache-probe gains the `KIE_BASE_URL` fallback it is missing and family awareness. (b) RUN
    them: record a probe result for every shipped id (accept + stream + usage metadata captured);
    the Gemini BIG-ANSWER delivery confirmation (flip the T8 matrix entry and panel expectation if
    it turns out batched — data change only); the `openai` cached-token key CONFIRMED from the
    capture and the T3 constant + fixtures re-pinned; probe `gpt-5-6-terra` — ships in the baked
    list/KIE_MODELS ONLY if its probe succeeds; reconcile KIE's `credits_consumed` against our
    computed raw cost (a gap = an owner pricing decision, per the spec's edge case). (c) Tier UI:
    extend `parseModel` beyond the claude-only regex to render `gpt-5-6-sol` → "GPT 5.6 Sol",
    `gemini-3-5-flash` → "Gemini 3.5 Flash" (names still sourced from `modelTiersSessionHint`'s
    per-tier `model` — never a client-side model table); pill tooltip + panel rows show each
    rung's resolved display name.
  - Acceptance: a recorded probe result exists for every id in `KIE_MODELS`+baked list; fixtures
    in T3/T9 re-pinned from real captures; pill/panel specs pin the new names (e.g. "Premium —
    GPT 5.6 Sol" shape); gemini delivery mode confirmed by measurement before the panel copy
    ships.

- [x] **T12** — Update SPEC.md (+ sub-specs) to match what was built
  - Files: `SPEC.md`, `spec/billing.md`, `spec/model-families.md` (new)
  - Details: §4.2a gains a "model families" subsection (family table, per-family
    wire/effort/cache/delivery policy, the unknown-family loud refusal, the thinkingMode
    per-family mapping); `spec/billing.md` §"The Marketplace price list" gains the optional
    explicit cache pair + per-family derivation rules ("never for claude-*, required-pair for
    gpt-*, refused for gemini-*" — the extension of the standing rule, stated as such); §4.6.1a
    notes rungs may name models from any family and that the pill/panel shows the resolved model
    name; new `spec/model-families.md` records the verified endpoints/ids, per-family wire
    payloads, the probe procedure, and the delivery-mode table with its re-measure-and-flip rule.
    Follow SPEC.md's update contract: replace/merge current-state sections, append to decisions.
  - Acceptance: SPEC.md + sub-specs accurately describe the shipped behavior; no section
    contradicts the code; the probe procedure is reproducible from `spec/model-families.md` alone.

## Verification

- Per task: targeted vitest for the specs named in that task (e.g. `pnpm vitest run
  app/lib/modules/llm/model-families.spec.ts`). **Never run the full `pnpm test` suite** — it
  currently destroys local `.data` (standing hazard, spec acceptance).
- Gates per task: `pnpm typecheck && pnpm lint:fix && pnpm lint` + that task's targeted vitest.
- T4 gate: `pnpm why @ai-sdk/provider` before/after diff + lockfile diff on the anthropic/ai
  subtrees.
- End-to-end (after T11): a live generation on each family via the platform proxy (correct
  artifact parsing, settlement rows, step logs); `gpt-5-6-sol` on a rung streaming file-by-file
  in the real UI — the visible win; batch note appearing ONLY on KIE-claude turns.
- Claude regression bar: every existing claude-touching spec green with assertions unchanged
  (wrappers, cache breakpoints, settlement numbers) + the T3 usage-reader identity pin.

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
