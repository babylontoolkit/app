# Spec for kie-tri-api-models

branch: project/feature/kie-tri-api-models
design_system: DESIGN.md
spec_impact: yes

> Authored by /bt-spec on 2026-08-04. All endpoint/id/wire facts below were LIVE-PROBED that day —
> none are taken from KIE's pricing-feed display names, which demonstrably differ from the API ids
> (feed `gpt-5.6-sol` vs real id `gpt-5-6-sol`).

## Summary

Support all three of KIE's text-API families — Claude (`claude/v1/messages`), GPT
(`codex/v1/responses`, OpenAI Responses wire), and Gemini
(`gemini/v1/models/<id>:streamGenerateContent`, native wire) — as platform generation models. The
family is derived from the **model id** (`claude-*` / `gpt-*` / `gemini-*`) inside the single `KIE`
provider, so the three tier rungs can each point at a model from any family. Cache economics come
from the promoted Marketplace price list with per-family policy (Claude derives 0.1×/2×; GPT rows
quote KIE's explicit Cached Input + Cache Writes prices; Gemini bills cached tokens at full input
rate — KIE prices no Gemini caching). Every shipped model id is live-probed, never taken from KIE's
pricing-feed display names. The tier pill/panel additionally shows each rung's resolved model name.

**Motivation:** beyond model breadth, KIE's Claude gateway regressed to fully BATCHED delivery
(~2026-08-01, measured: first text delta at 31–33s of a ~32s request, 100% in the final second, both
Opus models), while KIE's GPT surface STREAMS properly (measured: first delta 3.7s, 1,400
evenly-spread deltas). Family support is also the path back to progressive file-by-file artifact
streaming.

## Ground truth (live-probed 2026-08-04)

| Family | Endpoint | Wire | Verified ids | Streams? | Cache pricing on KIE |
|---|---|---|---|---|---|
| Claude | `api.kie.ai/claude/v1/messages` | Anthropic Messages | claude-opus-5, claude-sonnet-5, claude-opus-4-8, claude-fable-5, … | ❌ batched (regressed ~Aug 1); non-streaming requests 500 | derived 0.1× read / 2.0× 1h write (our standing rule) |
| GPT | `api.kie.ai/codex/v1/responses` | OpenAI **Responses** (`input` array, `reasoning.effort: low\|medium\|high\|xhigh`, SSE `response.output_text.delta`) | gpt-5-6-sol, gpt-5-6-luna, gpt-5-6-terra (**dashes**; terra was UNPROBED at spec time and PROBED CLEAN on 2026-08-04 during T11 — HTTP 200, streamed, usage captured — so it now ships) | ✅ measured | **explicit** Cached Input + Cache Writes rows (5.6 family); gpt-5.5 Cached Input only |
| Gemini | `api.kie.ai/gemini/v1/models/<id>:streamGenerateContent` | native Gemini (`contents`/`parts`, `generationConfig.thinkingConfig {includeThoughts, thinkingLevel: low\|high}`), Bearer auth accepted | gemini-3-5-flash | ✅ probed (small answer; big-answer confirmation owed) | **none** — no cached rate quoted, no cached-token counter observed (`usageMetadata: {thinkingTokenCount, candidatesTokenCount, totalTokenCount, promptTokenCount}`) |

Owner decisions (2026-08-04): Gemini ships fully with cached tokens billed at full input rate (it
fails the "supports prompt caching" bar *economically* — flagged, accepted); **no Grok** (noted as a
later candidate; feed prices its Cached Input but its endpoint shape is unverified); the 3-rung
ladder stays the only user-facing choice **plus the pill/panel shows each rung's resolved model
name** (e.g. "Premium — GPT 5.6 Sol").

## Project Spec Alignment (from SPEC.md — REQUIRED)

- Relies on / conforms to: **§4.2a** (Anthropic provider hardening — the Claude family keeps every
  existing wrapper unchanged), **§4.6.1 / §4.6.1a** (credits users pick a CLASS; rung selectors are
  operator config validated against the active price list; unaffordable resolves DOWN),
  **§4.2.8 / `spec/context-budget.md`** (prefix ordering — which *also* powers OpenAI automatic
  prefix caching, so the append-only prefix discipline is load-bearing for all families),
  **`spec/billing.md`** §"The Marketplace price list" (all prices from the promoted list; env price
  vars retired/refused), **§4.2** (agent proxy), **`spec/anthropic-models.md`** (unchanged for the
  Claude family).
- Fits the architecture as **platform-as-provider, additive-first**: new wire modules beside
  `kie-wire.ts`; `kie.ts` becomes a family dispatcher; the `PLATFORM_PROVIDERS` tuple is unchanged.
  Family CANNOT come from `LLM_PROVIDER`: rungs may point at models from different families
  simultaneously, while the provider is one value per deploy — so family derives from the model id.
- **spec_impact = yes** → SPEC.md changes on landing: §4.2a gains a "model families" subsection
  (family table, per-family wire/effort/cache/delivery policy, the unknown-family loud refusal);
  `spec/billing.md`'s price-list section gains the optional explicit cache pair + per-family
  derivation rules; §4.6.1a notes rungs may name models from any family and that the pill/panel
  shows the resolved model name. A new `spec/model-families.md` sub-spec records the verified
  endpoints/ids and the probe procedure.
- Conflicts: none — but one standing rule is *extended*, not broken: "cache rates are never quoted
  in the list" becomes family policy ("never for claude-*, required-pair for gpt-* when the adapter
  reports cached tokens, refused for gemini-*").

## Functional Requirements

1. **Family derivation from model id** (`model-families.ts`, client-safe, beside `capabilities.ts`):
   `claude-*` → claude, `gpt-*` → codex, `gemini-*` → gemini; unknown → the KIE provider REFUSES
   loudly at `getModelInstance` (model-resolution time, before any request — never a guessed wire).
   The per-family record carries: wire builder, effort mapping, cache profile, delivery mode,
   usage-metadata namespace, maxTokens defaults.
2. **One `KIE` provider, three wire builders**: existing `kie-wire.ts` (Claude — byte-identical
   behavior, all wrappers preserved); new `kie-codex-wire.ts` (`baseURL api.kie.ai/codex/v1`,
   `@ai-sdk/openai` 1.3.x `.responses()`, a `codexFetch` that writes `reasoning: {effort}` mapping
   medium→medium, high→high, xhigh→xhigh, max→xhigh); new `kie-gemini-wire.ts` (native wire, Bearer
   header, a `geminiFetch` that writes `generationConfig.thinkingConfig {includeThoughts: true,
   thinkingLevel}` mapping medium→low, high/xhigh/max→high; the composed URL must be exactly
   `/gemini/v1/models/<id>:streamGenerateContent`).
3. **Claude wrappers never touch other families**: `thinkingFetch`, `kieFetch`,
   `stripSamplingParams`, `dropOrphanReasoningSignatures` are claude-family-only by construction —
   this kills the current failure where an unknown id gets an Anthropic-shaped body and 400s. The
   proxy's `thinkingMode: 'disabled'` retry parameter (proxy.ts:1802) is accepted by the KIE
   provider signature (today silently omitted) and maps per family: claude → existing
   `canDisableThinking` clamps; codex/gemini → their lowest effort/thinking level, never a 400.
4. **Price-list schema**: `LlmMarketRate` gains optional `cachedInputPerMTok` + `cacheWritePerMTok`,
   validated as an atomic BOTH-or-NEITHER pair (a half-repriced row must stay inexpressible). Family
   policy: claude-* rows REFUSE the pair (derivation unchanged); gpt-* rows REQUIRE it (KIE quotes
   both); gemini-* rows REFUSE it and derive cachedInput = input, cacheWrite = input (no discount we
   cannot verify KIE grants, no surcharge we cannot observe). All validation errors reported at once.
5. **Usage extraction**: one pure per-family reader (`usage-metadata.ts`) replaces BOTH hardcoded
   `providerMetadata.anthropic` reads (`step-usage.ts` accumulation + `proxy.ts` step telemetry).
   Namespaces: `anthropic.{cacheReadInputTokens, cacheCreationInputTokens}`, `openai` cached-token
   key (exact key CONFIRMED from a live capture, not assumed), `google.cachedContentTokenCount`
   (expected zeros). Claude numbers must be byte-identical to today (pinned by an identity test).
   Missing individual values stay silent-zero; a wholly missing expected namespace on a cache-priced
   family logs one warning per generation — "nothing cached" and "counter disappeared" must read
   differently.
6. **Delivery mode keyed by (provider, family)**: Anthropic→streamed; KIE-claude→batched (measured
   2026-08-03/04); KIE-codex→streamed (measured); KIE-gemini→streamed provisionally, CONFIRMED by a
   big-answer probe before the panel copy ships. Unknown → streamed (never tell an unprobed
   surface's users to expect silence). The liveness panel's batch note must appear ONLY on
   KIE-claude turns.
7. **Tier rungs across families**: `LLM_MODEL` / `PREMIUM_MODEL` / `SUPERMAX_MODEL` may name any
   live-probed, list-priced id from any family. Every existing refusal rule holds: unpriced →
   `NotConfiguredError`; unaffordable → resolve DOWN to standard; `serveable` vs `available` stay
   separate fields; the provider must LIST what we price (`getDynamicModels` invariant).
8. **Rung model names visible** (owner decision): the tier pill tooltip and picker panel rows show
   each rung's resolved model display name, sourced from the server session hint
   (`modelTiersSessionHint`) — never a client-side model table.
9. **Verified-ids rule (the no-rabbit-hole rule)**: a model id ships ONLY after a live probe
   succeeds against its family endpoint (id accepted + streaming observed + usage metadata
   captured). `gpt-5-6-terra` stays out until probed. Probe tooling: `scripts/kie-model-health.mjs`,
   `scripts/stream-probe.mjs`, `scripts/cache-probe.mjs` extended to all three families; captured
   fixtures drive the usage/history tests.
10. **History compaction per family**: audit what the bumped SDKs round-trip (OpenAI Responses
    reasoning items / `encrypted_content`; Gemini thought signatures); strip what cannot
    round-trip, exactly as the Anthropic thinking-strip rule does today (`llm/history.ts`).
    Fixture-driven from real probe captures, not docs.
11. **Retry policy**: harvest codex/gemini gateway error-message shapes from live probes and add to
    `RETRYABLE` (`retry-policy.ts` matches message text; new gateways mean new text). Until then a
    transient fault on a new family burns a turn instead of retrying — acceptable, temporary.
12. **Claude-only subsystems degrade cleanly**: `cache-warmer.ts` no-ops for non-claude platform
    models (automatic caching cannot be breakpoint-warmed); `CACHE_CONTROL` providerOptions stay
    attached (namespaced → inert on other vendors); `MAX_CACHE_BREAKPOINTS` accounting remains
    claude-scoped so its degradation logic never measures a budget that doesn't exist.
13. **SDK bumps bounded**: `@ai-sdk/openai` → 1.3.x (Responses API), `@ai-sdk/google` → last 1.x.
    HARD GATE: `@ai-sdk/anthropic@1.2.12` and `ai@4.3.16` dependency trees unchanged (`pnpm why
    @ai-sdk/provider` before/after); upstream `openai.ts`/`google.ts` compile and their specs pass.
    If a bump drags `@ai-sdk/provider` incompatible, hand-roll a LanguageModelV1 for that family
    instead.

## Design System Reference

No DESIGN.md design system found — follow the existing UI conventions already in the codebase:
- Tier pill/panel changes reuse `ModelTierPill.tsx` / `ModelTierPanel.tsx` exactly as styled (§4.1a
  toolbar rules — one shared button style, no new variants).
- Model display names arrive via the server session hint, mirroring how tier availability reaches
  the client today.

## Possible Edge Cases

- A rung selector names an id whose family adapter exists but which was never probed → refuse at
  config (same `NotConfiguredError` family as an unpriced model).
- KIE feed display name entered as a price-row key (`gpt-5.6-sol` with dots) → the row prices
  nothing real; admin help text documents the API-id rule; the live reconciliation is the catch.
- Cache Writes billed by KIE but unobservable on the Responses wire → detected by reconciling KIE's
  `credits_consumed` against our computed raw cost in the probe; a gap is an owner pricing decision
  (bill uncached input at the write rate — over-collect on our side, never a user mis-bill).
- Mid-conversation rung repoint across families → compaction must never send family A's reasoning
  artifacts to family B (FR10's audit covers it; prior-turn thinking is already stripped).
- Gemini warm edits bill at full input by design — the admin margin report must not read that as a
  caching regression.
- The KIE-claude batched regression healing → the delivery table is data; re-measure and flip
  KIE-claude back to streamed with no other code change.

## Acceptance Criteria

- [ ] A generation runs end-to-end on each family via the platform proxy (live, all three): correct
      artifact parsing, settlement rows, step logs.
- [ ] `gpt-5-6-sol` (or luna) on a rung streams file-by-file in the real UI — the visible win.
- [ ] Claude-family behavior byte-identical: wrappers, cache breakpoints, settlement numbers
      (existing specs stay green + the usage-reader identity pin).
- [ ] Price-list validation: gpt pair round-trips; half-pair refused; gemini pair refused; gemini
      cached tokens bill at full input (PGlite-backed billing specs).
- [ ] An unknown model id through the KIE provider refuses loudly at model resolution.
- [ ] Liveness panel: batch note ONLY on KIE-claude; codex turns show the ordinary streaming flow.
- [ ] Tier pill/panel shows resolved model names per rung.
- [ ] Every shipped id has a recorded probe result.
- [ ] `pnpm typecheck && pnpm lint:fix && pnpm lint` + targeted vitest green; NO full-suite run (it
      currently destroys local `.data` — standing hazard).

## Open Questions

- Which models earn rungs at launch — operator/manual-eval decision; code only makes families
  available. Skills, briefs and all measured behavior are Claude-tuned; output quality on
  GPT/Gemini is unevaluated and there are no output-quality evals yet.
- Does KIE's Responses endpoint report cached tokens in practice (probe answers; decides whether
  the gpt cache discount is creditable or unobservable).
- Gemini rung-worthiness given zero cache economics on KIE (owner flagged, deferred).

## Testing Guidelines

Tests live beside the code they pin (repo convention):
- `model-families.spec.ts` — derivation, unknown-id refusal, effort mappings per family.
- `market-prices.spec.ts` additions — cache-pair atomicity, per-family refusal/requirement.
- `billing.spec.ts` additions — gemini full-rate cache billing; gpt explicit-rate settlement math.
- `usage-metadata.spec.ts` — per-family extraction from CAPTURED fixtures; claude identity pin;
  missing-namespace warning.
- `kie-codex-wire.spec.ts` / `kie-gemini-wire.spec.ts` — wire-level serialized-body assertions
  (the `anthropic.spec.ts` style): reasoning.effort mapping, thinkingConfig rewrite, URL
  composition, Bearer header.
- `kie.spec.ts` additions — family dispatch; claude wrappers never wrap other families (the
  400-producing path pinned dead).
- `delivery.spec.ts` — (provider, family) matrix; unknown→streamed.

## Implementation sequencing (for bt-plan)

Phase A (pure foundations): T1 `model-families.ts` · T2 price-list schema + rates · T3 usage reader.
Phase B (SDKs + wires): T4 SDK bumps behind the hard gate · T5 codex wire · T6 gemini wire ·
T7 `kie.ts` dispatcher (+ `thinkingMode` in the signature, `kieEnvModel` family-aware).
Phase C (cross-cutting): T8 delivery keying · T9 history per family · T10 retry strings ·
T11 probe tooling + fixtures + big-answer gemini delivery confirmation + terra probe.
Phase D (operator, no code): T12 Marketplace rows (API ids!) + rung assignment after manual eval.
