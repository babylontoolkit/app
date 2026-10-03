# Anthropic Only: Managed Agents is the one LLM path; KIE and fal are the media paths

**Owner, 2026-10-03:** *"there should NOT be ANY Comet... KIE and FAL only media providers that cover image, video and sound"* and *"Anthropic Managed Agent SHOULD be the Only LLM_PROVIDER PATH and KIE and FAL should be the only media paths.. period"*.

Follows `_specs/managed-only_plan.md` (which moved Plan mode, MCP turns and the enhancer onto Managed Agents but kept `AGENT_ENGINE=legacy` as a kill switch and KIE/Comet as legacy LLM gateways).

## Decisions

- **D1 — One engine.** `resolveAgentEngine` always answers `managed`. `AGENT_ENGINE` is no longer a switch: a set value other than `managed` (including `legacy`) is IGNORED with a once-per-process warning — ignoring it lands on the engine the owner wants, so refusing (and taking turns down over a stale env line) buys nothing. `/api/agent` and `/api/enhancer` call only the managed engine; their legacy branches are deleted.
- **D2 — The legacy loop is dormant, not a path.** `proxy.ts` and its tool loop stay on disk (helpers and types the managed engine imports live there, and its own unit tests keep it compiling) but NOTHING routes to it: a default-deny source scan (`anthropic-only.spec.ts`) fails if any route or `agent-managed` module calls `runAgentGeneration` or imports the provider-path `streamText`. Deleting the dormant code is a separate cleanup.
- **D3 — One LLM provider: Anthropic.** `PLATFORM_PROVIDERS = ['Anthropic']`, default `Anthropic`. `LLM_PROVIDER`, `LLM_PROVIDER_CHAIN` and `AUTO_MODEL_SELECT` cannot select anything else: a non-Anthropic value is ignored with a once-per-process warning (never a throw — `/api/me` and health read the config and must not fall over).
- **D4 — LLM prices come from Anthropic's list only.** `LLM_PRICE_PROVIDERS = ['Anthropic']`, so the paid rungs (Premium/Platinum) are serveable only when Anthropic prices their model — which is the gateway that runs them. KIE's list stays for its MEDIA rows; its LLM rows no longer price anything.
- **D5 — Comet is removed.** `providers/cometapi.ts`, `providers/comet-wire.ts`, `billing/baked-comet-prices.ts`, the Comet market feed, the Comet admin price list, the `COMET_*` env declarations and the scripts' Comet branches are deleted. **One deliberate exception:** media task records Comet stamped before 2026-10-01 still parse (`MediaEndpoint` `comet-*`, `RETIRED_MEDIA_PROVIDERS`) so their next poll fails and REFUNDS them without contacting anyone; removing that would strand a debit.
- **D6 — Media: KIE and fal only.** Already true (`MEDIA_PROVIDERS = ['KIE', 'FAL']`); with Anthropic as the LLM provider an unset `MEDIA_PROVIDER` falls back to KIE, as today.
- **D7 — Out of scope, stated:** the `chat` model family (Grok/Kimi/Qwen…) stays in the family table with no gateway serving it; the KIE LLM provider module stays dormant like the legacy loop (the cache warmer was deleted — it only warmed the legacy prefix); Pro/BYOK UI (`PRO_FEATURES_ENABLED`, default off) would show provider pickers that no longer reach anything.

## Tasks

- [x] **T1 — One engine (D1, D2).** `resolveAgentEngine`; route branches deleted; guard scan; specs that drove the legacy route updated.
- [x] **T2 — Anthropic the only LLM provider (D3, D4).** Config + price-provider lists; compile-driven fix-ups; specs.
- [x] **T3 — Remove Comet (D5).** Files, admin, feed, env, scripts, specs.
- [x] **T4 — Docs.** SPEC.md, CLAUDE.md, `.env.example`, sub-specs.
- [x] **T5 — Gates + live check.**

## Results (2026-10-03)

- **Gates:** typecheck clean; lint 0 errors; `pnpm test` 9,126 passed (446 files); brand gate clean. `anthropic-only.spec.ts` mutation-checked (a planted `runAgentGeneration` import in `api.enhancer.ts` fails it).
- **Live against Anthropic (dev server, real key):** an enhancement — HTTP 200, first text 1.9 s, 10.7 s total; a Plan turn whose `project_run` was refused by the dispatcher wall — 7.7 s, 4 credits, `plan-mode`/`no-replay` marks first. No `ignored` warnings (the local env names only Anthropic/managed).
- **Deleted:** `engine-select.ts` (+ specs), `scripts/engine-eval*`, the legacy branch of `api.enhancer.ts` and its spec + `billing/enhancer-usage.ts`, `prompt/cache-warmer.ts` (+ spec), `providers/cometapi.ts`, `providers/comet-wire.ts` (+ specs), `billing/baked-comet-prices.ts` (+ spec), the Comet market feed and admin price tab, `scripts/cache-probe.mjs`, `scripts/stream-probe.mjs`, `scripts/kie-model-health.mjs` (+ `pnpm kie-health`), the committed Comet measurement artifacts, `COMET_*` / `CACHE_WARMER_*` / `AGENT_ENGINE_EVAL_OVERRIDE` declarations.
- **Fixed on the way:** a stale bundle's deprecated `premium: true` is translated to a Premium request at the route (it had been honoured only by the legacy loop); a typo'd `LLM_PROVIDER` no longer 503s `/api/me` for every user (the flipped pre-existing finding in `session-payload.spec.ts`).
- **Still dormant (D2/D7), not paths:** `agent/proxy.ts` and the tool loop, the KIE LLM provider module and upstream's provider registry, `provider-select.ts`, the `chat` model family. A follow-up can delete them.
- **Capabilities only the legacy loop offered (not offered on a managed turn):** the Unity Bridge tools, the web-search tool, and the Game Backend (§4.15) RLS note.
