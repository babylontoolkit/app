# Implementation plan — cometapi-provider

Spec: `_specs/cometapi-provider_spec.md` (`spec_impact: yes`)
Branch: `project/feature/cometapi-provider`

---

## Codebase Analysis

Read read-only before any task was written: the feature spec in full, root `SPEC.md` (§1.3, §2.1a, §4.2a, §4.2.8, §4.6, §4.6.1a, §4.16, §5, §8f), `spec/model-families.md`, `CLAUDE.md`, and the modules below.

### What exists today (the shape this feature must mirror)

**The provider layer.** `app/lib/modules/llm/providers/kie.ts` is one provider fronting three wires, dispatched on the model id. `getModelInstance` (`kie.ts:111-232`) is a **field of function type** (not a method) taking `{model, serverEnv, apiKeys?, providerSettings?, effort?, thinkingMode?}`. Its body order is load-bearing and source-scanned: `requireFamily(model)` at `:144` **before** the key lookup at `:146`, then `thinkingMode`/`effort` resolution at `:159-161`, then three branches — `codex` (`:163`, `createOpenAI(...).responses(model)` + `codexFetch`), `gemini` (`:182`, `createGoogleGenerativeAI` + `geminiFetch`), and **claude as an `else` fallthrough** (`:194-231`, `createAnthropic` + `thinkingFetch(… kieFetch(rateLimitFetch(…)))` + `supportsSamplingParams ? … : stripSamplingParams` + `dropOrphanReasoningSignatures`). Wire modules (`kie-wire.ts`, `kie-codex-wire.ts`, `kie-gemini-wire.ts`) hold base URLs, fetch wrappers and `KIE_MODELS`, and import **no** provider — deliberately, to avoid the `base-provider → manager → registry → providers` cycle vitest rejects (`kie-dispatch.spec.ts:14-21`).

**🔴 The claude branch is a FALLTHROUGH, and that is the single highest-risk fact for this feature.** Adding a fourth family makes `requireFamily('grok-4.5')` succeed, and a `grok-*` id would then fall straight through into `createAnthropic` — an Anthropic `thinking` block in a non-Anthropic body, a hard 400 before a token, on exactly the failure mode `requireFamily` exists to prevent (SPEC §4.2a, §8f item 2). The same fallthrough shape exists in three other places: `llmRatesFromList` (`rates.ts:169`, unknown family → `derived`), `market-prices.ts:285-290` (unknown family refused — the one that is already correct), and `delivery.ts:105-119`.

**Families.** `app/lib/modules/llm/model-families.ts` — `MODEL_FAMILIES = ['claude','codex','gemini']` (`:33`), `FAMILY_POLICY` (`:60-79`, `cacheProfile`/`usageNamespace`/caps), `FAMILY_PREFIXES` (`:82-86`), `familyOf` (`:97`), `requireFamily` (`:113`, throws naming the id + every prefix), `codexEffort` (`:147`), `geminiThinkingLevel` (`:176`). Client-safe by design (beside `capabilities.ts`, outside `~/lib/.server/**`), and deliberately holds **no wire builders and no delivery mode** (`:25-29`). `FAMILY_POLICY`/`FAMILY_PREFIXES` are already provider-agnostic; only `requireFamily`'s error string names KIE (`:118-120`).

**Anthropic hardening.** `capabilities.ts` — `thinkingFetch` (`:261-311`), `stripSamplingParams` (`:320`), `dropOrphanReasoningSignatures` (`:354`), `supportsSamplingParams` (`:39`), `canDisableThinking(modelId, effort)` (`:221`), `parseEffort`/`DEFAULT_EFFORT`. The deny-lists name OLD models and default to modern (SPEC §4.2a — never invert). `anthropic.ts:201-209` additionally wraps `refusalFallbackFetch` + `tapStopReasons`; **`kie.ts` wraps neither**, which is the precedent for what Comet's claude branch should ship with on day one.

**Registration.** `registry.ts` is a flat import + re-export barrel (KIE at `:9`/`:35`) and `manager.ts:34-56` instantiates everything in it — a new provider needs exactly two lines there. `constants.ts:188-198` derives `PROVIDER_LIST` and `providerBaseUrlEnvKeys` automatically. **But** `stream-text.ts:36` (the enhancer path) looks a model up in the provider's list and falls back to `modelsList[0]` behind a `logger.warn` on a miss — the "priced but not LISTED" mis-bill recorded in CLAUDE.md — so Comet needs its own `kieEnvModel` analogue (`kie-wire.ts:358-399`) synthesizing a `ModelInfo` for an unlisted `LLM_MODEL`, with the same `LLM_MODEL > COMET_DEFAULT_MODEL > baked` precedence.

**Provider-keyed tables that become type errors the moment `PLATFORM_PROVIDERS` grows** (this is the good kind of coupling — the compiler enumerates the work): `providerRates` (`rates.ts:544-547`), `DELIVERY` (`delivery.ts:68`), `PLATFORM_MODEL_BY_PROVIDER` (`config.ts:132`), `PLATFORM_KEY_ENV` (`config.ts:390`). **And the bad kind — `provider === 'KIE' ? … : …` ternaries that silently fall to the Anthropic side for a third provider**: `config.ts:164`, `:226`, `:316` (`defaultModelFor`), `:397` (`platformKeyFor`), `cache-warmer.ts:131` (fanout) and `:343` (key selection). Every one must become a record or an exhaustive switch.

**Prices.** `market-prices.ts` holds the types (`LlmMarketRate` `:43-52`, `MediaModelPricing` `:59-99`, `MarketPriceList` `:107-131`) and the validator (`:160-266`), whose `validateLlmCachePolicy` (`:275-337`) **refuses any id outside `claude-`/`gpt-`/`gemini-`** — so no `grok-*`/`qwen*` row can be promoted until `FAMILY_PREFIXES` grows. `market-price-store.ts` is **KIE-scoped in its keys** (`VERSION_PREFIX = 'pricing/kie-market/versions'` `:32`, `POINTER_KEY = 'pricing/kie-market/active.json'` `:33`) with a single module-level cache and a no-arg `activeMarketPrices()` (`:79`). `rates.ts` — `KIE_MODEL_RATES = llmRatesFromList(BAKED_MARKET_PRICES)` (`:145`), `kieRates(context)` (`:284`), `ratesFor(model, provider, context)` (`:564`) with the most-expensive-row fallback (`:581`). `lookupMediaPrice` (`market-prices.ts:488-526`) deliberately has **no** fallback — unknown model / unmatched variant / `per_second` without a duration all return `null`.

**🔴 OQ1 is already answered in the code, and the answer is the opposite of the spec's fear.** `rates.ts:86-89` states explicitly: Sonnet 5's `$2/$10` is **introductory pricing expiring 2026-08-31**, and we bill the standard `$3/$15` deliberately, because seeding the intro rate would compress margin below target the day it lapses with nothing failing. Comet's feed reporting official `$2/$10` is therefore evidence the comment is *correct*, not evidence the row is stale. **No change to `rates.ts:92-97`; T5 records the finding and touches nothing.** (After 2026-08-31 the row simply becomes the plain list price.)

**Media.** The `MediaProvider` seam (`media/kie-client.ts:25-46`) is two methods — `create(input)` / `query(endpoint, taskId)` — and three things sit *outside* it: `downloadResult(url)` is a free function (`:177`) imported directly by the file route (`api.projects.$projectId.media.$taskId.file.ts:44`); `MediaEndpoint = 'jobs' | 'veo'` is a KIE-shaped union that is **persisted on the task record** (`store.ts:22`); and there is **no factory** — four call sites `new KieMediaProvider(...)` concretely (`proxy.ts:1252`, `api…media.ts:96`, `api…media.$taskId.ts:34`, plus the file route). `service.ts` hardcodes `provider: 'KIE'` on the generations anchor (`:242`), and `proxy.ts:1248` gates `hasMediaTools` on `config.kieApiKey`. The money order (`service.ts:219-372`) is price → refuse-if-unpriced → anchor → **debit** → create, with refund-exactly-once via `pollChains` serialisation + a `record.refunded` latch (`:378-393`, `:467`, `:491`). `media-tools.ts` already takes `provider: MediaProvider` and needs no change.

**Transparency.** `app/lib/media/output-format.ts:155-168` — `resolveImageDelivery(hints)` returns `{cutout, renderFormat, finalFormat}`, computed **once** in `startMediaTask` (`service.ts:226-230`) and read by all three of the quote, `buildProviderPayload` (`:631`) and `deriveDestPath` (`:663`), which is what stops them disagreeing. `cutout: true` currently means **both** "the user wants alpha" **and** "run a second priced stage" — two facts in one boolean, and they separate under Comet where `gpt-image-1.5` + `background:"transparent"` produces alpha in one call.

**Probes.** `scripts/cache-probe.mjs` and `scripts/stream-probe.mjs` are already modified (uncommitted) and **already handle Comet** — `IS_COMET` (`cache-probe.mjs:87`), `COMET_BASE` (`:94`), the codex-rides-chat-completions branch (`:163-166`), and stream-probe's presence-driven Comet block (`:347-378`) which deliberately omits `thinkingFlag` (KIE's private adapter field). `scripts/kie-model-health.mjs` has **no** provider switch (`:53-57` hard-requires `KIE_API_KEY`) — and it is the catalogue prober FR4 depends on.

### SPEC.md alignment

- **§4.2a** — additive. The Claude family's hardening (`thinkingFetch` adaptive+summarized+`output_config.effort`, `stripSamplingParams`, `dropOrphanReasoningSignatures`) composes on Comet's claude branch exactly as it does on KIE's; `capabilities.ts` stays outside `.server`; no model id gains a date or `-latest` suffix. §4.2a's "swapping the platform model is a config operation" is preserved and extended to the provider.
- **§4.2.8 / `spec/context-budget.md`** — nothing about the prefix, the four breakpoints or the ≤4 ceiling changes. AC1 is the bar.
- **§4.6 / `spec/billing.md`** — prices keep coming from a *promoted* Marketplace list (T4 makes that list provider-scoped rather than adding a hardcoded second table, so "rates are config, never hardcoded" survives); env price vars stay retired and refused; unpriced LLM → most-expensive row, unpriced media → refused.
- **§4.6.1a** — the Standard/Premium ladder is untouched; rungs stay selectors the active list must price in their own right.
- **§4.16** — the media money order (debit-before-spend, `'media'` may never go negative, refund-exactly-once) is preserved verbatim; only the provider behind the seam changes.
- **§5** — `COMET_API_KEY` is server-only, never `VITE_`-prefixed, never emitted in a response body.
- **§2.1a** — additive-first (new provider file + new wire module + new baked list), hide-don't-delete (FR9: KIE stays selectable), platform-as-provider (rides upstream's existing extension point). No upstream restructure.
- **§8f** — this plan extends the §8f decisions rather than reversing any: family still derives from the model id (decision 1), an unknown id still refuses (2), Claude wrappers still wrap the Claude branch only, by structure (3), family cache policy is extended not broken (4), ids ship only on a live probe and the feed is not a probe (7), delivery is data and an unmeasured surface is assumed to stream (8).

**Spec-impacting: YES** (carried from the feature spec's `spec_impact: yes`). A new platform provider, a fourth model family, a provider-scoped price store and an independent media-provider switch are all durable architecture. Final task writes back to `SPEC.md` **and** the two sub-specs that currently assert KIE-only facts.

### Assumptions and standing constraints recorded here

1. **Every task's definition of done includes the gates** (`CLAUDE.md`): `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` green. Not repeated per task. ⚠️ `spec/model-families.md` §12 warns a full `pnpm test` run destroys local `.data`.
   - 🔴 **MEASURED WORSE THAN DOCUMENTED (2026-08-10, during T6): a THIRTEEN-FILE TARGETED SUBSET
     DESTROYED A USER PROJECT.** Running the Comet-touching specs deleted
     `prj_20260810125354_61dirayg` ("Mario Kart Racer Clone") in full — project row, chat index entry,
     transcript under `storage/messages/`, and its `storage/working/` crash-recovery copy. The
     standing advice "prefer the targeted spec list" is therefore **not a mitigation**; the hazard is
     not a function of how many spec files you run.
   - **The mechanism is the point: the specs did not corrupt anything.** They exercised the REAL
     delete path against the REAL store — which is why the ledger correctly fired the §4.4a
     `project_create` refund for a project the operator never deleted. So the rule is **not** "back up
     `.data`" (it was backed up, and see the next bullet), it is **a spec that can reach the real
     `.data` store must be pointed at a throwaway directory**. This is the *third* recorded instance
     of that family after `oauth.spec.ts`'s `env()` fallback and `media-tools.spec.ts`'s real `med_*`
     rows, and it deserves a CLAUDE.md entry as a fourth occurrence.
   - ⚠️ **A FILE-LEVEL RESTORE CANNOT UNDO A LEDGER ENTRY, AND "the restore is complete" was
     therefore wrong.** All four deleted files were restored from a pre-run backup and `diff -rq`
     reports nothing missing — but the ledger is **append-only by design**, so the refund stands:
     row 178 `-100 project_create` and row 185 `+100 refund` net to **zero for a project that exists
     again**. Materially trivial (100 credits, local operator account) and nothing reads it, but two
     stores now disagree about one fact, which is the money-path class this repo does not let pass
     silently. **Left recorded rather than hand-patched**: the correct fix is a compensating
     adjustment through the Admin credit-adjustment route, which goes through `append_ledger_entry`
     and its per-user lock — hand-appending a JSONL row would bypass the writer that computes
     `balance_after`, i.e. reintroduce the exact race migration 0003 exists to prevent.
2. **Money-path specs must `vi.stubEnv('COMET_API_KEY', undefined)`** (and `COMET_BASE_URL`). `env()` falls back to `process.env`, vitest loads `.env.local`, and `.env.local` now holds a real key — the `oauth.spec.ts` trap, fourth occurrence. Add it to `media.spec.ts`'s `MONEY_ENV` list and any new billing spec.
3. **OQ7 (is a ~2× cost increase acceptable to leave KIE?) is an owner decision and it gates T13 only.** T1–T12 are worth building regardless: they leave KIE selectable, cost nothing to hold, and make the decision reversible by config. OQ7 option (b) — running KIE and Comet *simultaneously* per rung — is **out of scope for this plan** and would need a spec amendment: FR2 and §8f decision 1 both rest on the provider being one value per deploy.
4. **OQ5 (media in the same cutover?) is answered by construction, not by asking** — T7 gives media its own `MEDIA_PROVIDER` switch defaulting to the LLM provider, so the two cutovers can be split or joined by config with no code change.
5. **OQ2/OQ3 (does Comet forward `fallbacks` + `anthropic-beta`?) are probed in T6, and the default until proven is NOT to wire `refusalFallbackFetch` on the Comet claude branch** — matching `kie.ts`, which wraps neither. A beta header a gateway rejects is a hard 400 on every request; a fallback field it silently drops is a Fable 5 refusal surfacing as today's error, which is survivable.
6. **OQ6 (rate limits) stays open.** `rateLimitFetch({provider})` already wraps every branch and will surface a 429 if Comet publishes one; a queueing soft-throttle, as with KIE, is invisible by construction.

---

## Tasks

- [x] **T1** — Add the `chat` family and make every family dispatch EXPLICIT (close the fallthroughs)
  - Files: `app/lib/modules/llm/model-families.ts`, `app/lib/modules/llm/providers/kie.ts`, `app/lib/.server/agent/delivery.ts`, `app/lib/.server/billing/market-prices.ts`, `app/lib/.server/agent/usage-metadata.ts`, `app/lib/modules/llm/model-families.spec.ts`, `app/lib/modules/llm/providers/kie-dispatch.spec.ts`
  - Details:
    - `MODEL_FAMILIES` gains `'chat'`. `FAMILY_PREFIXES` gains `['grok-','chat'], ['kimi-','chat'], ['qwen','chat'], ['glm-','chat'], ['deepseek','chat'], ['minimax-','chat']` — note `qwen`/`deepseek` are deliberately **not** dash-terminated per FR3; add a comment saying so, because the surrounding entries all are and the asymmetry reads as a typo. Prefix order matters: `claude-`/`gpt-`/`gemini-` stay first so nothing existing re-routes.
    - `FAMILY_POLICY.chat = { cacheProfile: 'none', usageNamespace: 'openai', maxTokenAllowed, maxCompletionTokens }`. Caps come from the feed's `context_length`/`max_completion_tokens` for the ids T5 ships; until then use the conservative documented values and say in the comment that they are floors. `cacheProfile: 'none'` because Comet quotes no cached rate for these rows — never a discount we cannot verify (§8f decision 4/5).
    - **🔴 `kie.ts`: replace the claude `else` fallthrough with an explicit `if (family === 'claude') { … }` and add a final exhaustive refusal** naming the family and the fact that KIE serves no `chat` models. Without this, a `chat` id builds an Anthropic client on KIE — the precise hazard `requireFamily` exists to prevent.
    - `requireFamily`'s error message currently says "The KIE provider serves three families"; make it provider-neutral and count-neutral (it is now shared by two providers and four families).
    - `DELIVERY` (`delivery.ts:68`) is `Record<PlatformProviderName, DeliveryMode | Record<ModelFamily, DeliveryMode>>` — KIE's per-family record must gain `chat` to compile. Set `chat: 'streamed'` and note it is unreachable on KIE (T1's refusal) and present for exhaustiveness only.
    - `validateLlmCachePolicy` (`market-prices.ts:275`) needs no rule change but must now *accept* `chat` rows through the `none` profile; confirm its unknown-family refusal still fires for a genuinely unknown prefix.
    - `usage-metadata.ts` — `chat` maps to the `openai` namespace; confirm the "wholly missing namespace on a cache-priced family" warning does **not** fire for `chat` (`cacheProfile: 'none'`, same exemption gemini has).
  - Acceptance: `requireFamily('grok-4.5') === 'chat'` and `requireFamily('llama-3')` still throws naming **all four** families' prefixes. **A `chat`-family id passed to `KieProvider.getModelInstance` throws and reaches no wire** — asserted with a spy proving zero fetches, in `kie-dispatch.spec.ts`, and mutation-verified by restoring the `else` (the test must fail). `claude-*`, `gpt-*` and `gemini-*` dispatch on KIE are byte-identical: every existing assertion in `kie-dispatch.spec.ts` / `kie.spec.ts` / `kie-codex-wire.spec.ts` / `kie-gemini-wire.spec.ts` passes unchanged (AC7 control).

- [x] **T2** — The `Comet` provider + wire module, Claude branch first
  - ⚠️ **DEVIATION FROM THIS TASK AS WRITTEN, decided during execution and documented in the code
    (found 2026-08-10 by T6's verifier, recorded here so plan and reality stop disagreeing).** The
    Details below specify precedence `LLM_MODEL > COMET_DEFAULT_MODEL`. **`COMET_DEFAULT_MODEL` was
    never built: Comet has ONE knob, `LLM_MODEL`** (`config.ts` `defaultModelFor`, `comet-wire.ts`
    `cometEnvModel`). The reason is the failure this plan's own Codebase Analysis records against
    KIE — `KIE_DEFAULT_MODEL` costs a precedence rule that **two separate readers must agree on, and
    they once did not**, so a model set via `LLM_MODEL` never reached the provider's model list while
    settlement charged it anyway. One variable has no precedence to get wrong, which keeps the two
    readers in agreement **by construction rather than by a rule someone has to remember**. Copying
    KIE's shape would have copied its bug. Nothing else in T2 changed.
  - Files: `app/lib/modules/llm/providers/comet-wire.ts` (new), `app/lib/modules/llm/providers/cometapi.ts` (new), `app/lib/modules/llm/registry.ts`, `app/lib/modules/llm/providers/cometapi-dispatch.spec.ts` (new), `app/lib/modules/llm/providers/cometapi.spec.ts` (new)
  - Details:
    - `comet-wire.ts` (imports **no** provider — the `kie-wire.ts` cycle rule): `COMET_DEFAULT_BASE_URL = 'https://api.cometapi.com/v1'`, `COMET_GEMINI_BASE_URL` (`…/v1beta`), `COMET_MODELS: ModelInfo[]` (only ids live-probed in T5 — start with the five claude ids the spec verified), and `cometEnvModel(serverEnv)` mirroring `kie-wire.ts:358-399` with precedence `LLM_MODEL > COMET_DEFAULT_MODEL`, caps from `FAMILY_POLICY[familyOf(id) ?? 'claude']`, returning `undefined` for an id already in `COMET_MODELS`.
    - `cometapi.ts` mirrors `kie.ts`'s structure exactly: `name = 'Comet'`, `config = { baseUrlKey: 'COMET_BASE_URL', apiTokenKey: 'COMET_API_KEY' }`, `staticModels = COMET_MODELS`, `getDynamicModels` returning `cometEnvModel(serverEnv)`. `getModelInstance` is a **field of function type** with the same options object, `requireFamily(model)` FIRST, then key lookup, then `thinkingMode`/`effort` resolution identical to `kie.ts:159-161`.
    - **FR2 — the provider maps family → wire, and the map is explicit data in this file**, not a fallthrough: `claude` → `createAnthropic` on `/v1/messages`; `codex` → `createOpenAI(...).chat(model)` on `/v1/chat/completions` (**not `.responses()`** — Comet marks `gpt-5*` as `openai`, and only `o3-pro` carries `openai-response`); `chat` → `createOpenAI(...).chat(model)`; `gemini` → `createGoogleGenerativeAI` on `/v1beta`. Any family without an entry throws.
    - **FR1/FR3 — the Claude wrappers wrap the claude branch ONLY.** Claude branch chain: `thinkingFetch(thinkingMode, effort, model, rateLimitFetch({provider: this.name}))` — **no `kieFetch`** (`thinkingFlag` is KIE's private adapter field; stream-probe already omits it deliberately) and **no `refusalFallbackFetch`/`tapStopReasons`** on day one (assumption 5). Tail: `supportsSamplingParams(model) ? comet(model) : stripSamplingParams(comet(model))`, then `dropOrphanReasoningSignatures`.
    - Auth: Comet accepts both, so send `Authorization: Bearer` (matching `kie.ts`) on every branch. `COMET_BASE_URL`, unlike `KIE_BASE_URL`, is the base for **all** families here — say so in a comment, because the KIE file states the opposite rule for its own variable and a reader will carry it across.
    - Register in `registry.ts` (import + export).
  - Acceptance: `cometapi-dispatch.spec.ts` reproduces the dispatch the way `kie-dispatch.spec.ts` does (it cannot import the provider — cycle) and asserts, **default-deny with controls**, that a comment-stripped slice of `cometapi.ts` between the non-claude branches contains none of `thinkingFetch`, `stripSamplingParams`, `dropOrphanReasoningSignatures`; controls assert the slice is non-trivial (`length > 200`) and does contain the chat/gemini builders. Field-by-field, `ANTHROPIC_ONLY_BODY_FIELDS` (`thinking`, `output_config`) are **absent** from a serialized `gpt-5`/`grok-4.5`/`gemini-3-pro-preview` request and **present** on `claude-opus-5`. An unknown id throws with **zero** fetches. `requireFamily` precedes the key lookup (source-order scan over comment-stripped source, anchored regex — not a loose `toContain`). `cometEnvModel` limits are asserted against `FAMILY_POLICY`, never literals. Mutation-verify: removing the claude-branch guard must fail the dispatch spec.

- [x] **T3** — Config: `PLATFORM_PROVIDERS`, keys, delivery, and the death of the `=== 'KIE'` ternaries
  - Files: `app/lib/.server/agent/config.ts`, `app/lib/.server/agent/delivery.ts`, `app/lib/.server/prompt/cache-warmer.ts`, `.env.example`, `app/lib/.server/billing/env-example.ts`, `app/routes/api.health.ts` (or wherever the dependency report lives), plus the specs pinning each
  - Details:
    - `PLATFORM_PROVIDERS = ['Anthropic','KIE','Comet']`. `DEFAULT_PLATFORM_PROVIDER` **unchanged** (FR9 — this task must not move anyone).
    - `getPlatformConfig` reads `COMET_API_KEY`; `PlatformConfig` gains `cometApiKey`. `PLATFORM_KEY_ENV` gains `Comet: 'COMET_API_KEY'`.
    - **Convert every `provider === 'KIE' ? … : …` to a record or an exhaustive switch**: `platformKeyFor` (`config.ts:397`), `defaultModelFor` (`:316`), the two operator-guidance message ternaries (`:164`, `:226`), `cacheWarmerFanout`'s fallback (`cache-warmer.ts:131`) and its key selection (`:343`). Each of these currently falls to the **Anthropic** side for an unrecognised provider — which for `platformKeyFor` means a Comet deploy silently authenticating with (or refusing for the lack of) the wrong key. This is the whole reason the task exists; a compile error would have been the good outcome and a ternary denies you one.
    - `PLATFORM_MODEL_BY_PROVIDER.Comet = DEFAULT_MODEL`.
    - `DELIVERY.Comet = { claude: 'streamed', codex: 'streamed', chat: 'streamed', gemini: 'streamed' }` — claude is **measured** (spec: 388 deltas, 4% in the final second); the other three are the standing assume-streams default for an unmeasured surface (§8f decision 8) and the comment must say which is which, so a later reader does not cite an assumption as a measurement.
    - `cacheWarmerFanout`: `Comet` fallback **1** for now, with a comment pointing at T11 — the probe saw writes at requests 1/3/5, but a 12-request sample is exactly the sample size that produced a wrong verdict on KIE (AC6). The warmer ships default-off, so 1 costs nothing and cannot over-spend.
    - `.env.example`: add `COMET_API_KEY` and a commented `COMET_BASE_URL`, and update the `LLM_PROVIDER accepts …` line (`:160`) to name all three. **Assign each variable exactly once** — the duplicate-key pin (`env-example.ts:27-60`) exists because a second assignment silently wins, and this file has already been bitten twice.
    - Health/dependency report: `Comet` reports key-configured as a **boolean**, never the value (§5).
  - ⚠️ **DISCOVERED DURING EXECUTION (2026-08-10) — T3 cannot go green alone; its last line is T4's.** `billing.spec.ts` asserts (a) every `PLATFORM_PROVIDERS` entry has a `providerRates` table and (b) every provider's `PLATFORM_MODEL_BY_PROVIDER` default is priced. Adding the name here fails both until a Comet price source exists, which is exactly the guard `config.ts`'s own header describes ("adding a name here is not enough"). The plan listed `providerRates` in the Codebase Analysis but not in T3's file list — a planning gap, not a code defect. **Resolution: T3's config work lands first, then T4 creates `BAKED_COMET_PRICES` + `cometRates` and the two assertions go green, then T3's box is flipped.** T3 is therefore verified AFTER T4 rather than before it; no work was reordered, only the verification point.
  - Acceptance: `LLM_PROVIDER=Comet` resolves through `getPlatformProvider` and `requirePlatformKey` returns the Comet key (and refuses, describably, with no key — never falling back to `ANTHROPIC_API_KEY`). `deliveryModeFor('Comet', 'claude-opus-5') === 'streamed'`. `pnpm typecheck` passes with **no** `Record<PlatformProviderName, …>` left partially filled. `.env.example` passes the duplicate-key pin. A grep for `=== 'KIE'` in `config.ts` and `cache-warmer.ts` returns only comments. **Plus (see the note above): `billing.spec.ts`'s per-provider rate-table and priced-default assertions pass — satisfied by T4.**

- [x] **T4** — Make the Marketplace price store PROVIDER-SCOPED (enabler; no price change)
  - Files: `app/lib/.server/billing/market-price-store.ts`, `app/lib/.server/billing/rates.ts`, `app/routes/api.admin.market-prices.ts`, `app/components/@settings/tabs/admin/MarketPricesSection.tsx`, `app/lib/.server/billing/market-price-store.spec.ts`
  - Details:
    - Today the store is a KIE singleton: `VERSION_PREFIX = 'pricing/kie-market/versions'`, `POINTER_KEY = 'pricing/kie-market/active.json'`, one module-level cache, and a no-arg `activeMarketPrices()`. A second provider needs its own promotable list, or Comet prices could only be corrected by a deploy — which breaks this repo's own "rates and limits are config, never hardcoded" rule.
    - Introduce `MarketPriceProvider = 'KIE' | 'Comet'` **local to the billing layer** (do **not** import `PlatformProviderName` from `agent/config.ts` — `config → rates → market-price-store` would close an import cycle; add a spec assertion that the two lists agree instead, mirroring the existing `billing.spec.ts` `PLATFORM_PROVIDERS`-agrees-with-rates pin).
    - Key by provider: `pricing/{slug}-market/versions` + `active.json`, with **`kie` preserved byte-identically** so every promoted version and pointer already in the store keeps working with no migration.
    - Cache becomes `Map<MarketPriceProvider, CacheState>`. `activeMarketPrices(provider)` and `ensureMarketPrices(context, provider)` take the provider **explicitly** — an implicit "the active provider's list" default is how a media lookup on one provider would silently price against the other's list once T7 lands. Update all call sites (`rates.ts:284`, the proxy doorway, `/api/me`, admin).
    - `baked` fallback per provider: KIE → `BAKED_MARKET_PRICES`, Comet → `BAKED_COMET_PRICES` (a stub in this task, filled in T5; a stub that fails validation is better than one that quietly prices nothing).
    - Admin route + panel gain a provider dimension: the loader returns per-provider active/pointer/versions; promote/rollback carry the provider; the panel gets a provider selector. Validation, promote-before-write, all-errors-reported and rollback-onto-valid-bytes are unchanged.
  - Acceptance: an existing promoted KIE version continues to load and serve — asserted against a store seeded at the **old** key with no rewrite. `activeMarketPrices('Comet')` returns the Comet baked list and `activeMarketPrices('KIE')` the KIE one, with promotion on one provider provably not moving the other's pointer. `kieRates(context)` is byte-identical to before (AC7 control). Promoting an invalid list still writes nothing.

- [x] **T5** — Capture Comet prices with the ratio applied; ship only live-probed ids
  - ⚠️ **EXECUTION FINDING (2026-08-10) — the spec was wrong and FR4 caught it.** `claude-haiku-4-5`,
    listed in the spec as live-probed on Comet, returns a hard **400** (`"has not been priced by the
    administrator yet"`) and is absent from the feed entirely; Comet serves the DATED
    `claude-haiku-4-5-20251001`, whose `code` is the bare id and whose output cap the feed reports as
    8K, not 64K. **Dropped from `COMET_MODELS` and never priced** — it is not a rung the ladder names,
    and shipping it would have meant two guesses at once. `claude-opus-4-8` was ADDED (feed-priced,
    probed 200), closing the gap T4 deliberately left. Three `chat` rows shipped priced-but-unlisted
    (`grok-4.5`, `kimi-k3`, `qwen3-coder`), which makes OQ7's cheap-model lever real. **OQ1 CLOSED: the
    Anthropic Sonnet 5 row is correct and deliberate — `rates.ts:86-89` already recorded that $2/$10 is
    introductory pricing expiring 2026-08-31; Comet's feed confirms that comment rather than
    contradicting it. Nothing was changed.** All findings written back into
    `_specs/cometapi-provider_spec.md`. Verified independently, including a second live re-probe.
  - Files: `app/lib/.server/billing/baked-comet-prices.ts` (new), `app/lib/.server/billing/rates.ts`, `app/lib/.server/billing/market-feed.ts`, `app/routes/api.admin.market-prices.ts`, `app/components/@settings/tabs/admin/MarketPricesSection.tsx`, `scripts/kie-model-health.mjs` → provider-switched, `app/lib/.server/billing/comet-prices.spec.ts` (new)
  - Details:
    - **🔴 The charged rate is `pricing.input × pricing.ratio`, and `ratio` is per row.** 273/276 rows carry `0.8`; three carry `1.0` (`minimax-h3`, `seedance-2-5`, `seedream-5-0-pro-260628`). Apply at capture time, store the **charged** rate as `inputPerMTok`/`outputPerMTok`, and keep `officialInputPerMTok`/`officialOutputPerMTok`/`ratio` alongside as **provenance comments or a sibling constant** — do not add them to `LlmMarketRate` unless the validator learns them, or a promoted list carrying them is refused as an unsupported key.
    - Cache keys: `claude-*` rows quote **nothing** (derived 0.1×/2.0× — validator refuses the pair); `chat`/`gemini` rows quote nothing (`cacheProfile: 'none'`). **`gpt-*` is the trap:** its family is `codex` → `explicit-pair`, which *requires* both cached keys, and Comet quotes neither. Either ship no `gpt-*` rows in the Comet list for now (preferred — nothing needs them yet), or the profile becomes provider-dependent, which is a real spec change and belongs in its own task, not smuggled in here.
    - **FR4 — no id ships on the strength of the feed.** Extend `scripts/kie-model-health.mjs` with the same `PROBE_PROVIDER` switch `cache-probe.mjs` already has (rename or alias the script accordingly), and probe every candidate id before it gets a row. The feed's `code` and `id` already disagree (`grok-4.5` has `code: "grok-4-5"`) — the identical drift class that shipped a 404 on KIE.
    - **Do NOT ship** the 21 `cometapi-*` alias ids (unknown backing, unknown pricing) or the `-thinking` id suffix variants (two rows for one model that can disagree about price).
    - `rates.ts`: add `cometRates(context)` = `llmRatesFromList(activeMarketPrices('Comet'))` and a third key on `providerRates`. `refuseRetiredPriceEnv` is unchanged and still applies. **Leave `MODEL_RATES['claude-sonnet-5']` alone** — OQ1 is resolved by `rates.ts:86-89` (intro pricing, deliberate); record the finding in the spec write-back rather than editing the row.
    - `market-feed.ts`: add `fetchCometMarketFeed()` against `GET /api/models`; the Admin "Fetch feed" button becomes provider-aware. **Operator's eyes only, never machine-applied**, exactly as the KIE variant.
  - Acceptance: `comet-prices.spec.ts` asserts every row's `inputPerMTok`/`outputPerMTok` equals `official × ratio` from the captured feed snapshot, **including at least one `ratio: 1` row**; a mutation replacing the per-row ratio with a constant `0.8` must fail the spec (AC8). `validateMarketPriceList(BAKED_COMET_PRICES)` returns ok, prices `DEFAULT_MODEL`, and refuses if a claude row is given a cache key. Every shipped id has a recorded probe result. `KIE_MODEL_RATES` and the Anthropic `MODEL_RATES` are unchanged (AC7 control).

- [x] **T6** — Live-drive a real build turn on Comet: AC1–AC4
  - ⚠️ **EXECUTION FINDING (2026-08-10) — AC3 IS UNSATISFIABLE AS WORDED, and that is a fact about
    the PLATFORM, not about Comet.** AC3 asks for "thinking text non-empty **with a valid
    signature** on a real generation". The first half passed decisively (7,770 / 2,781 / 2,173 /
    1,577 reasoning chars across separate steps of the real build turn). The second half **can never
    be observed through the proxy**: `AgentChunk` carries no signature field and `llm/history.ts`
    strips prior-turn thinking deliberately, so no signature reaches any persisted artefact by
    design. It is instead proven two other ways, both recorded in the spec — at the WIRE
    (`claude-opus-5`, 10,528-char `signature_delta` on its own `thinking` block, zero on the text
    block), and BEHAVIOURALLY (a 17-step tool loop with thinking on most steps cannot complete if the
    signature is absent — Anthropic rejects the next request with `thinking.signature: Field
    required`; it did not). **Recorded as AC3 PARTIAL rather than quietly re-scored as PASS.**
  - ⚠️ **AC4's `strict` clause was UNREACHABLE and is still untested on Comet.** `strict: true` is
    emitted only by `@ai-sdk/openai`'s Responses binding; the Comet **claude** branch builds via
    `createAnthropic` and never serialises it, so a claude-only drive could not have produced the
    fault whatever the gateway did. Comet's `chat`/`codex` branches were not driven. AC4 passes on
    its substance (17-step tool loop completed, settlement exact to 8dp against the Comet rate row
    and against neither KIE's nor Anthropic's), but the strict half tested nothing and says so.
  - ⚠️ **THE PROVIDER IDENTIFIER WAS RENAMED `CometAPI` → `Comet` DURING THIS TASK** (owner request,
    2026-08-10): 272 occurrences across 31 files, `.env.local` included. The justification is not
    brevity — the key was already `COMET_API_KEY`, so `Comet` restores the `<Provider>` ↔
    `<PROVIDER>_API_KEY` pattern `Anthropic` and `KIE` follow, which `CometAPI` broke. **Free of data
    consequences by luck of an earlier decision**: `STORE_SLUG` was already `comet`, so no promoted
    price list migrates, and no billing or admin code matches on the persisted `generations.provider`
    string. 🔴 **But the mechanical replace rewrote a QUOTATION of persisted data** — the spec came to
    claim turn one recorded `provider: Comet` when all three records say `"CometAPI"`, because they
    predate the rename and both stores are append-only. Caught by the verifier, not by me, and now
    noted in the spec. **A find-and-replace across a document that quotes stored artefacts will
    silently falsify the quotations; the artefacts do not get renamed.**
  - ⚠️ **The first write-up of this task OVERSTATED in seven checkable ways** and was caught by the
    independent verifier, not by me: a fabricated file count (11 → **10**), a cache pattern that
    omitted a write and mis-stated a run length, a flatly false "`cacheRead` equals `cacheWrite` to
    the token" printed two lines under a table showing 342,122 vs 182,052, AC2 numbers taken from
    `claude-opus-5` while the drive ran `claude-sonnet-5`, a browser observation presented in a table
    of measurements with no artefact, media calls that actually ran on **KIE** listed among
    Comet-exercised tools, and an unmentioned `stop+forced-continuation`. All corrected in the spec.
    **This is the class this repo keeps recording — a false claim in a document is how a defect
    survives review — arriving in the document that was supposed to be the evidence.**
  - Files: none expected (verification); fixes land in `cometapi.ts` / `comet-wire.ts` if the drive finds defects. Record results in `_specs/cometapi-provider_spec.md`'s ground-truth table or a sibling note.
  - Details:
    - Point a local dev deploy at `LLM_PROVIDER=Comet` (leave production alone — T13 is the cutover) and run a **real first build turn plus at least one edit turn** through the actual proxy, not a probe.
    - Read `generations.cacheCreationTokens` / `cache_read_input_tokens` from the persisted step log on turn two. **A regression here throws nothing and only makes the bill go up** — the whole reason AC1 is the blocking criterion.
    - Streaming: `PROBE_PROVIDER=Comet node scripts/stream-probe.mjs` **and** confirm progressive artifact rendering in the browser. Server totals cannot distinguish "streamed for 244s" from "buffered and flushed at 244s"; only per-delta timing can.
    - Thinking: confirm non-empty reasoning text **with a signature** arrives on the `g:` channel and never merges into `text` (leaked reasoning is written into the user's file).
    - Tools: drive a turn that exercises file tools and at least one non-media tool; confirm no `strict` fault (KIE's codex gateway 400s on `strict: true` behind an HTTP 200 — a shape that raises no error through the real SDK).
    - **Probe OQ2/OQ3 while here**: send one request carrying `fallbacks` + the `server-side-fallback-2026-07-01` beta header and one carrying an ordinary `anthropic-beta` header. If both are forwarded cleanly, wiring `refusalFallbackFetch` onto the Comet claude branch becomes a follow-up task; if either faults, record it and leave the branch as shipped.
  - Acceptance: AC1 — turn two reports `cache_read_input_tokens > 0` (evidence pasted into the spec). AC2 — >50 text deltas and <20% of characters in the final second. AC3 — thinking text non-empty with a valid signature on a real generation. AC4 — a tool-bearing generation completes with no `strict` fault and correct settlement. OQ2/OQ3 answered with recorded evidence, either way.

- [x] **T7** — Widen the media seam so a provider can be chosen — and so an in-flight task is polled by the provider that created it
  - 🔴 **EXECUTION FINDING (2026-08-10) — THE FIRST CUT OF THIS TASK BROKE EVERY CHAT TURN ON THIS
    REPO'S OWN CONFIGURATION, and no test in the plan's Acceptance could have seen it.** The
    Acceptance is entirely about the media path; the defect was on the GENERATION path. `getMediaConfig`
    resolves `MEDIA_PROVIDER` → falls back to `LLM_PROVIDER` → `Comet`, which is in `MEDIA_PROVIDERS`
    and holds a real key, so it returned a config; `mediaProviderFor('Comet', …)` then throws by design
    (no client until T8) — as an **eager argument inside `createMediaTools({…})` in straight-line
    code**, on every turn with a project. `/api/agent` returned **HTTP 500 before a token**: no chat at
    all, because image generation was unavailable. `.env.local` on this box is exactly that shape
    (`LLM_PROVIDER=Comet`, no `MEDIA_PROVIDER`), and the OLD gate — `config.kieApiKey` — was present, so
    T7 turned a working box into a broken one. **Fixed with `resolveMediaProvider(context)`**, a
    non-throwing door returning `MediaProvider | null` that catches BOTH throwing readers
    (`getMediaProvider`'s typo refusal and the factory's no-client refusal), warns, and degrades to "no
    media tools this turn". The routes keep the THROWING `mediaProviderFor`, because there media *is*
    the request and a silent no-op is the §4.16 failure. **This is the `/api/me` premium-hint entry
    arriving in a new place: a degraded capability reports OFF, never ON, and must not take the request
    down.** Found by the independent verifier, not by me, and not by 904 green tests.
  - ⚠️ Three smaller defects the same review found, all fixed: the Comet refusal was a plain `Error`,
    which `errorResponse` turns into a generic 500 — so the carefully-worded message naming
    `MEDIA_PROVIDER` reached nobody while the module's doc comment promised a *describable* refusal (now
    `NotConfiguredError`, a `SAFE_ERRORS` member, pinned by CLASS + set membership with a negative
    control, because a message assertion cannot see this); `ensureMarketPrices` still carried a
    `= 'KIE'` default, which T4's own Details forbade (now `(provider, context?)` — provider first and
    required, so every call site states it by position); and the create-failure ledger note was
    hardcoded `KIE refused the task`, which is user-visible text that would be wrong for a Comet task.
  - ⚠️ **A comment claimed a protection that did not cover its own case.** The `MEDIA_PROVIDER` block
    added to `.env.example` said the duplicate-key pin covered it. It does not — that pin is
    **key-scoped** (`model-tiers.spec.ts` `LADDER_KEYS`), and it only caught the block's first draft
    because that draft accidentally opened a comment line with `LLM_PROVIDER=`, i.e. it fired on a
    different key. `MEDIA_PROVIDER` now has its own at-most-one pin (with a control) in
    `media-config.spec.ts`. Same class as every other entry here: the false claim was in the comment.
  - Files: `app/lib/.server/media/kie-client.ts`, `app/lib/.server/media/provider.ts` (new — the seam + factory), `app/lib/.server/media/store.ts`, `app/lib/.server/media/service.ts`, `app/lib/.server/agent/proxy.ts`, `app/routes/api.projects.$projectId.media.ts`, `app/routes/api.projects.$projectId.media.$taskId.ts`, `app/routes/api.projects.$projectId.media.$taskId.file.ts`, `app/lib/.server/agent/config.ts`, `app/lib/.server/media/media.spec.ts`
  - Details:
    - **Move the seam out of `kie-client.ts`** into `media/provider.ts`: the `MediaProvider` interface, the `MediaEndpoint` union, and a `mediaProviderFor(name, key)` factory. `kie-client.ts` keeps only the KIE implementation. There are four concrete `new KieMediaProvider(...)` sites today and no factory — that is the change point.
    - **`download` joins the interface.** `downloadResult(url)` is a free function the file route imports directly (`…file.ts:44`); Comet's result URLs are presigned S3 with expiry and may need different handling. The route must ask **the task's** provider.
    - **🔴 Record the media provider ON the task record** (`store.ts`), defaulting absent → `'KIE'` for records written before this task. `MediaEndpoint` is persisted and its `'jobs' | 'veo'` spelling is KIE-shaped; widen it with Comet's routes (`comet-image`, `comet-gemini-image`, `comet-video`). **Without the provider field, flipping `MEDIA_PROVIDER` while a render is in flight polls a KIE task against Comet** — the task never completes, and the refund path fires on a render that may have succeeded. Poll and download both resolve the provider from the record, never from current config.
    - `service.ts:242` — the generations anchor's hardcoded `provider: 'KIE'` becomes the resolved media provider. This is what the Admin margin report attributes spend by.
    - `proxy.ts:1248` — `hasMediaTools` gates on the resolved media key, not `config.kieApiKey`.
    - **`MEDIA_PROVIDER` env, defaulting to `getPlatformProvider(context)`** (with `Anthropic` → no media provider, since Anthropic serves none — a describable "not configured", never a silent no-op). This is what makes OQ5 a config answer.
    - Media price lookup reads **the media provider's** list: `activeMarketPrices(mediaProvider)` (T4). `lookupMediaPrice` keeps refuse-never-guess.
  - Acceptance: `media.spec.ts` passes unchanged for the KIE path (AC7 control), with its `FakeProvider` now implementing the moved interface including `download`. A task record written with no provider field resolves to `'KIE'` on read. A task created under `MEDIA_PROVIDER=KIE` is still polled and downloaded via KIE after the env flips to `Comet` — asserted directly, mutation-verified by resolving the provider from config instead of the record (the test must fail). No route constructs a provider class directly.

- [x] **T8** — `CometMediaProvider` + one-stage transparency behind a per-model capability table
  - ⚠️ **Ground truth live-probed; two of this task's premises were wrong.** Owner decisions taken
    during execution: build it in full; default image quality `medium`; price each variant GENEROUSLY
    (a flat number covering worst-observed usage) rather than debit-worst-case-then-refund.
  - 🔴 **THE REWRITE BROKE `kling-2.6` ON THE INCUMBENT PROVIDER, AND THE WHOLE SUITE STAYED GREEN.**
    Restructuring `quoteMediaRequest` to decide KIND first dropped `lookupOptions`, the helper that
    merges `durationSeconds` INTO the option record before variant matching. All four `kling-2.6`
    variants are keyed on `durationSeconds`, so the lookup matched none of them and every kling-2.6
    render — offered by both the Media panel and the `generate_video` tool — became unquotable. Found
    by the independent verifier, not by 1110 passing tests. **Nothing covered it**: `market-prices.spec.ts`
    drives `lookupMediaPrice` directly with the duration already merged, and every video case in
    `media.spec.ts` used `kling-3.0`, which is keyed on `mode` — a whole model class that every test
    drove around. **The generalisable half: `durationSeconds` is BOTH a matcher and a multiplier, and
    an AC7 control only controls the paths it actually drives.**
    - ⚠️ **AND THE FIRST REGRESSION TEST WRITTEN FOR IT WAS VACUOUS, WHILE THIS PLAN CLAIMED IT WAS
      MUTATION-VERIFIED.** It compared `{5s, sound:false}` against `{10s, sound:true}` and asserted only
      that the second cost more — an ordering the SOUND dimension satisfies by itself. The verifier's
      mutation (merge a hardcoded `durationSeconds: 5`, i.e. **a 50% under-charge on every 10-second
      render**) left it green. The mutation I had run only proved it caught a TOTAL matching failure,
      and I wrote "mutation-verified" without stating against what. It now holds `sound` constant and
      asserts the literal prices (0.275 / 0.55 / 1.1), and the verifier's mutation fails it. **Varying
      two dimensions to test one is the `PROGRESS_CAP` trap — both sides of the comparison moved
      together — and a mutation-verified claim scoped to a class the mutation never exercised is worse
      than no claim, because it stops the next reader looking.**
  - 🔴 **AND EVERY OPAQUE COMET IMAGE WOULD HAVE BEEN WRITTEN AS `.jpg` CONTAINING PNG.**
    `buildCometPayload` stated no `output_format`, so `gpt-image-1.5` returned OpenAI's default PNG
    while `deriveDestPath` named the file from `finalFormat` (`jpg`, the photographic default) — the
    file proxy's byte sniffer would have reported `media-format-mismatch` on the DEFAULT path. This is
    the exact "billed as one thing, written as another, referenced as a third" failure the delivery
    decision exists to prevent, reintroduced by omission on a new branch. Fixed and pinned as a PAIR
    (payload format and destination extension asserted together, both cases), because they are only
    wrong relative to each other. ⚠️ `jpeg` on the wire, `jpg` in the filename — the spellings differ.
  - ⚠️ Three declared-but-unimplemented things were removed rather than left as promises the code did
    not keep — all the `PENDING_RENDER_TTL_MS` class: `ImageModelCapability.minPixels` (never set,
    never read; what actually refuses an unserveable size is the price list); `session.media.transparency`
    (computed in `/api/me`, read by nobody, with a doc comment claiming it "gates the Background
    control" — it did not exist in the UI); and the Background dropdown itself, which was HAND-ATTACHED
    to `gpt-image-1.5` and merely AGREED with the capability table. It is derived from the table now
    (`withBackgroundField`), so adding a model or flipping `nativeAlpha` cannot desynchronise them —
    which is what FR7's "a table, never a flag" actually asks for.
  - ⚠️ `COMET_BASE_URL` reached the LLM wire and NOT the media client (`CometMediaProvider`'s `baseUrl`
    param existed and nothing passed it), so an operator's proxy or regional endpoint was silently
    honoured for text and ignored for renders. Threaded through `mediaBaseUrlFor` — one variable, both
    kinds of spend, the two-readers-of-one-variable rule.
  - 🔴 **THE FLAT-PRICED IMAGE MODELS DO NOT EXIST IN PRACTICE — FR4, third occurrence.** The feed
    lists `doubao-seedream-5` (`per_request` $0.035) and `seedream-5-0-pro` ($0.045, and the `ratio: 1`
    row T5 recorded) with clean flat prices. Both return **HTTP 503 `no available channel for group
    default`**. `flux-2-pro` returns 400 (it must be called on `/flux/v1/{model}`, not the OpenAI
    route). **Every image model that actually serves is TOKEN-priced** — `gpt-image-1.5` at $6.40/$25.60
    per MTok charged, `gemini-3-pro-image` at $1.60/$9.60 — which the plan's "price the Comet media
    rows" step assumed away. It is expressible without a type change: `MediaPriceVariant.options` is a
    subset match, so a variant keyed on `{quality, resolution}` prices a token-priced model exactly,
    because the platform CONTROLS both fields in `buildProviderPayload`.
  - 🔴 **TWO OF THE THREE ROUTES ARE SYNCHRONOUS.** `POST /v1/images/generations` and
    `:generateContent` render INSIDE the request (measured 16.7s at `low`, ~27s at `medium/1536x1024`,
    ~100s at `high`) and return no task id; only video is async (`POST /v1/videos` → id in 1.3s →
    `GET /v1/videos/{id}`, completed in 56s with a presigned `video_url`, `X-Amz-Expires=259200`).
    §4.16's design is debit → enqueue → **return in milliseconds** → the client polls, exactly so the
    tool loop never parks on a render. Bridged in `comet-client.ts`: `create` fires the request without
    awaiting, parks the promise under a synthetic `comet-local-…` id, returns at once; `query` reports
    `pending` until it settles. ⚠️ A parked render is process memory, so a restart orphans it — which
    would be `spec/fail-loud.md`'s fifth terminal state (debited, rendering, nothing able to finish or
    refund it). `PENDING_RENDER_TTL_MS` closes it: an id this process has never heard of is reported
    FAILED, which routes into the existing refund-exactly-once path.
  - 🔴 **`response_format: 'url'` IS NOT USABLE, and it looked fine on the first probe.** 200 with a
    hosted URL at `low`/`1024x1024`; hard **400 `Unknown parameter: 'response_format'`** at
    `high`/`1536x1024`, same model, same key, minutes apart. Comet's image adaptor is inconsistent
    across backends — the same per-backend inconsistency `cache-probe.mjs` found on the LLM surface.
    So the client never sends it and accepts whichever of `url` / `b64_json` arrives. **A parameter
    that works is not a parameter that will work**; one green probe is not a capability.
  - ✅ **Transparency is real and one-stage**: `gpt-image-1.5` + `background:"transparent"` →
    **74.31% fully transparent, 6.69% semi**, verified by decoding every pixel's alpha byte (never the
    colortype — this repo has shipped that false positive once). `gemini-3-pro-image` returns
    **image/jpeg** inline and has no alpha, as expected for the Nano Banana line.
  - 📊 **Measured price grid** (charged = official × ratio; `gpt-image-1.5` $6.40 in / $25.60 out):
    | quality | size | image_tok | text_tok | in | cost |
    |---|---|---|---|---|---|
    | low | 1024×1024 | 272 | 114 | 14 | $0.00997 |
    | medium | 1024×1024 | 1056 | 162 | 14 | $0.03127 |
    | high | 1024×1024 | 4160 | 180 | 14 | $0.11121 |
    | low | 1536×1024 | 400 | 61 | 14 | $0.01189 |
    | medium | 1536×1024 | 1568 | **430** | 12 | $0.05123 |

    `image_tokens` is exactly OpenAI's published table and fully deterministic per (size, quality).
    ⚠️ **`text_tokens` is NOT** — it ranged 61→430 across five renders, worth up to ~$0.011, which is
    35% of a `medium` render. So a variant price needs headroom above the measured cost, and the
    residual is absorbed by `CREDIT_MARGIN`. **The headroom is an unresolved judgement on five data
    points** and is the one open item before these rows can be promoted. `gemini-3-pro-image` measured
    $0.0113 (9 prompt + 1179 candidate tokens, 1120 of them IMAGE). Comet video: veo3-fast **$0.08/s**,
    veo3 **$0.32/s** (`per_second`, expressible today with no changes).
  - Files: `app/lib/.server/media/comet-client.ts` (new), `app/lib/media/output-format.ts`, `app/lib/.server/media/service.ts`, `app/lib/.server/billing/baked-comet-prices.ts`, `app/components/media/MediaPanel.tsx`, `app/lib/media/output-format.spec.ts`, `app/lib/.server/media/media.spec.ts`
  - Details:
    - `CometMediaProvider implements MediaProvider`: image via `POST /v1/images/generations`; nano-banana via `POST /v1beta/models/gemini-3-pro-image:generateContent`; video via `POST /v1/videos` → `GET /v1/videos/{task_id}`; `download` fetching the presigned URL promptly. Its own `parseTaskState` analogue, keeping KIE's deliberate rule that **success with no URL is reported as FAILED, not succeeded**.
    - **Separate the two facts currently fused in `ImageDelivery.cutout`.** `resolveImageDelivery` stays the one pure INTENT decision and returns `wantsAlpha` (the user's answer, from the explicit `transparent` boolean → explicit `png` → filename/prompt hints, precedence unchanged); the **service** maps `(provider, model, wantsAlpha)` to the realization — KIE: `cutout: true`, `renderFormat: 'jpg'`, `finalFormat: 'png'` (byte-identical to today, including `cutoutRenderPrompt`); Comet: one stage, `renderFormat: 'png'`, `finalFormat: 'png'`, `background: 'transparent'` on the payload, **no** `cutoutRenderPrompt` (the checkerboard directive exists for the remover's benefit and would only degrade a native-alpha render).
    - **The realization is computed ONCE in `startMediaTask` and passed to the quote, `buildProviderPayload` and `deriveDestPath`** — the existing invariant, preserved. If they can disagree, a file is billed as one thing, written as another and referenced as a third.
    - **FR7 — a per-model capability table, never a flag.** `gpt-image-1.5` supports `background:"transparent"`; `gpt-image-1` and `gpt-image-2` **refuse the parameter**. A transparent request whose model lacks native alpha resolves to the capable model, and **the quote reports the model actually called** (`quote.model` already drives the anchor and the ledger, so the substitution is visible and billed honestly — it is not silent). A transparent request that **cannot** be served at all — no capable model, unpriced capable model, an unserveable size — is **REFUSED before the debit**, naming why. Never downgraded to an opaque render: that is the bug §4.16 already fixed once, and it is the one failure mode that looks like success.
    - Price the Comet media rows (image / nano-banana / video / the transparent model) into `baked-comet-prices.ts` with the same per-row ratio rule as T5. **The `recraft/remove-background` row stays** in the KIE list — deleting it breaks in-flight and historical KIE cut-outs.
    - `MediaPanel.tsx`: the Background dropdown is offered only on models the capability table marks capable **for the active media provider**; the model dropdowns become provider-aware (they are hardcoded arrays today). `buildRequest` is unchanged.
    - ⚠️ **Image size floors are per-model and not portable** — seedream refused 1024×1024 (`must be at least 3686400 pixels`). Encode the floor in the capability table and refuse in the quote, not after paying for a render.
  - Acceptance: `output-format.spec.ts` proves the intent decision is unchanged for every existing case (AC7 control) and that `wantsAlpha` is provider-independent. `media.spec.ts` gains: a Comet transparent request debits **once** for **one** stage; a transparent request on a model without native alpha resolves to the capable model and the quote/anchor name that model; a transparent request that cannot be served **refuses before the debit** with **zero** ledger rows — mutation-verified by making the refusal fall through to an opaque render (the test must fail); refund-exactly-once still holds under the concurrent-poll harness. The KIE cut-out path passes every existing assertion unchanged.

- [x] **T9** — Live-drive media on Comet: AC5
  - ✅ **DRIVEN LIVE 2026-08-11** through the real UI on a throwaway project
    (`prj_20260811045242_ga5znrpy`), `MEDIA_PROVIDER` **unset** — which is the shipping resolution
    path, since `getMediaProvider` falls back to `LLM_PROVIDER=Comet`. Every number below is measured,
    not inferred.

    **AC5, all six clauses:**

    | claim | evidence | retained? |
    |---|---|---|
    | three tasks via the AGENT tool path | one generation; `media-service` log shows three `Media task … started` | ✅ `.data` task records |
    | three single debits | `-7` / `-20` / `-256`, chain 26439→26432→26412→26156; **54 media rows / 54 unique ids / 0 duplicates**, balance chain intact across all 200 rows | ✅ `.data/ledger` |
    | extensions match sniffed type | proxy `image/jpeg` · `image/png` · `video/mp4`; **zero** mismatch warns in seven dev logs | ✅ re-measured, below |
    | exactly one refund | server killed mid-render; 3 polls (2 concurrent) → **1** row `+7`, `refunded: true` | ✅ `.data` + `t9-dev2.log` |
    | real bytes on disk | see the RETENTION DRIVE below | ✅ (was ❌) |
    | alpha pixel-decoded | see the RETENTION DRIVE below | ✅ (was ❌) |

    ⚠️ **THE FIRST WRITE-UP TICKED THE LAST TWO ROWS ON EVIDENCE THAT NO LONGER EXISTED, AND THE
    VERIFIER WAS RIGHT TO FAIL IT.** Both were genuinely measured live (`readBinaryFile` returned
    1,042,807 / 743,982 / 8,023,025 with valid trailers; the browser decoded 74.08% transparent) — but
    nothing retained them, the project's own working copy holds **no** `assets/generated` entry, and
    the ✅ was never connected to the OPEN item four paragraphs down. **A measurement whose artifact
    did not survive is a claim, not evidence** — and the one clause the plan itself singles out as the
    historical false-positive trap was the one with nothing behind it. Closed by re-driving with
    retention rather than by softening the wording.

  - ✅ **RETENTION DRIVE (2026-08-11, `gen_mso97gnr_rhqybt`) — artifacts in `scratchpad/t9-artifacts/`.**
    One generation, **1 tool round**, both assets in that round (the defaults fix working: before it,
    step 0's three calls were all refused). It also closes the second gap the verifier found — the
    Details name **`generate_video`**, which the original drive never successfully exercised on Comet
    (it was called once, refused as a KIE id, and the video came from `generate_google_video`).

    - `generate_image transparent:true` → `gpt-image-1.5` → `.png`, **20 credits** ($0.049 = medium/1:1)
    - `generate_video` **naming no model** → **`veo3-fast`**, Comet's default from the table → `.mp4`,
      **128 credits** ($0.32 = 4s × $0.08)

    🔴 **THAT SECOND LINE DESCRIBES A PATH THAT NO LONGER EXISTS, AND THE REASON IS THE POINT
    (owner directive, 2026-08-11, after this drive).** Comet's ONLY video models are Google Veo, so
    making Veo `generate_video`'s default was the cheapest possible way to reach the most expensive
    video generator on the market by accident — and it was strictly WORSE than the bug it "fixed":
    before the defaults table, an unnamed `generate_video` on Comet was refused for free; after it, the
    same call silently rendered 128 credits of Veo. `Comet.video` is `null` now, `generate_video`
    refuses when no non-Google model is named, and a Veo id passed to it is refused too — **the ban is
    on the MODEL, not on the tool**, or it would be advisory. Video on Comet goes through
    `generate_google_video`, deliberately, by name.

    **AC5's video clause therefore rests on the FIRST drive, not this one** — which exercised exactly
    that tool and whose `-256` debit is in the retained ledger. This retention drive still carries the
    two clauses it was run for (real bytes on disk, alpha pixel-decoded), both of which are the IMAGE.
    Left in place rather than rewritten: a plan that quietly re-words its own evidence to match a later
    decision is how a measurement stops being a measurement.
    - Proxy `Content-Type` from the BYTES: `image/png` (magic `89 50 4e 47`), `video/mp4` (`ftyp`)

    ⚠️ **Grep for the LOGGED SENTENCE, not the monitor scope.** The mismatch warn reads
    `"media task …: … is actually …"` (`api.projects.$projectId.media.$taskId.file.ts`);
    `media-format-mismatch` is the monitoring SCOPE and never appears in a dev log, so searching for it
    returns zero hits whether or not the check works — a vacuous grep dressed as evidence. On the real
    string: **0 hits across all seven `t9-dev*.log`**, on a path the deliveries provably exercised,
    while other warns from the same logger ARE present (which is the control).

    ⚠️ **One content type has no retained bytes**: the first drive's `.jpg` (gemini-3-pro-image) has a
    `succeeded` task record and its `-7` ledger row, but nothing kept the file. Two of the three kinds
    are byte-verified from the working copy; `.jpg` rests on the task record plus the absence of any
    mismatch warn. Stated rather than rounded up — this task has already been failed once for ticking a
    clause whose artifact did not survive.
    - Ledger: two rows, one per task, chain intact; **54/54/0** across the whole file

    **Alpha decoded TWICE, independently, from the RETAINED file** — `decode-alpha.py` parses IHDR,
    inflates the IDAT stream and reverses the scanline filters itself, so it reads every alpha byte
    with no image library and no canvas. It prints the colortype and **deliberately does not use it**,
    because colortype 6 at 100% alpha=255 is precisely the false positive. Browser canvas and the
    from-scratch decoder agree to the digit:

        dimensions 1024x1024 (1,048,576 px)   colortype 6  <- reported, not used
        fully transparent   561,615   53.56%
        semi transparent    103,258    9.85%
        fully opaque        383,703   36.59%
        corner alphas       [0, 0, 0, 0]        VERDICT: REAL ALPHA

    Also confirmed live: **async-enqueue** — `start` returned in **8 ms** (observed in the browser at
    the time; ⚠️ not derivable from anything retained, so treat the architecture claim, which
    `comet-client.ts` `_park` does establish, as the durable one and the number as a single reading);
    the FR7 table resolving a transparent request to `gpt-image-1.5` while the opaque one used
    `gemini-3-pro-image`, **one debit for one stage** (Comet has no cut-out pass); and a describable
    failure message, not a generic one: *"The render was interrupted (the server restarted while it
    was still rendering)… The credits have been refunded."*

  - 🔴 **FOUND AND FIXED — THE MEDIA TOOLS' DEFAULT MODELS WERE HARDCODED KIE IDS**
    (`app/lib/media/provider-defaults.ts`, new). `generate_image` defaulted to `nano-banana-2`,
    `generate_video` to `kling-3.0/video`, `generate_google_video` to `veo3_fast` — three literals in
    the tool schemas, every one a KIE model. On Comet none is priced, so **every call that did not name
    a model was refused**. Measured on the first live media turn (`gen_mso6s0gd_frqrfh`):

        step0  8.2s  out=578  cacheWrite=31,098  tools=[generate_image, generate_image, generate_video]   -> 0 tasks
        step1  8.0s  out=666  cacheWrite=31,098  tools=[generate_image, generate_image, generate_google_video]
        step2  6.8s  out=207  cacheWrite=31,098  tools=[generate_google_video]
        step3  3.7s  out=79   cacheWrite=0       ANSWER

    **Step 0 was entirely wasted** and step 2 existed only because step 1's video call was a KIE id
    too: four steps where two are the floor. ⚠️ **It SELF-HEALS, which is exactly why it would never
    have been reported** — `MediaRefusedError` names the available models, so the agent recovers on the
    next round; the art arrives, the ledger is right, and the only trace is a turn costing about twice
    what it should. The §4.2.8 silent-failure shape: nothing throws, the bill goes up. Same class as
    the cache warmer's `!== 'KIE'` guard — **in a codebase where the gateway is a config swap, any
    value that quietly means "the vendor we started with" stops being true on the next deploy.**
    The DESCRIPTIONS are provider-derived too, not just the defaults: they ride in the CACHED prompt,
    so advertising `nano-banana-2` on a Comet deploy teaches the agent a refused id on every turn of
    every conversation. Fallback for an unknown provider is KIE's row and **never a throw** — a throw
    inside a tool `execute` kills a generation the user has already paid for. **Re-driven live with no
    model named** (`gen_mso7fbm2_qwywbm`): `1 tool round`, 2 steps, `gemini-3-pro-image` chosen from
    the table, task created on the FIRST round, 691,469 real bytes delivered. Rounds wasted before the
    first successful call: **1 → 0** — ⚠️ measured on an **image-only** turn. A video turn where the
    agent reaches for `generate_video` first still spends one round on Comet, since `Comet.video` is
    `null` by owner directive; that round is FREE (refused before any debit) and is the deliberate
    trade for never falling into Veo by accident.

  - ⏳ **FIXED IN THE NODEPOD FORK'S WORKING TREE, NOT YET COMMITTED OR PUBLISHED** (owner-directed,
    2026-08-11, version bumped to `1.9.18-btk.9`; the owner commits and publishes by hand). Until it
    ships, this repo runs it only via a locally-built `dist` copied into `node_modules`, which the next
    `pnpm install` erases. **THE PREVIEW COULD NOT SERVE A STATIC FILE OVER 4 MiB.** The 8 MB generated video was byte-correct on disk and 404'd in
    the preview. Bisected: 4,194,304 bytes served, **4,194,305 returned the SPA fallback**; a tiny
    `.mp4` served and a 9 MB `.jpg` did not, so it was SIZE, never extension or MIME.

    **Cause** — `ProcessManager.VFS_BROADCAST_MAX_BYTES` (`src/threading/process-manager.ts`): above
    it, `broadcastVFSChange` sends workers `{type:'vfs-invalidate', path}` (path only, no bytes)
    instead of `vfs-sync`, on the assumption that they re-pull lazily. ⚠️ **The gate has three terms,
    not one** — it also requires `_spawnSnapshotMode === 'lean'` and `_syncBuffer !== null`, so outside
    lean mode an oversized write still ships its bytes and the ceiling does not bite. Anyone
    reproducing this must confirm lean mode is on, or they will fail to see it. But the worker's handler,
    `markLazyInvalidated`, **early-returns when no miss handler is installed**, justified in its own
    comment as *"better a stale copy than a lost file"* — **which is true for an UPDATE and false for
    a CREATE**: a file the worker has never seen has no stale copy to preserve, so it simply never
    appears. Every generated asset is a create. Raised 4MB → 256MB, owner's call.

    ⚠️ **The value is a PER-RECIPIENT CLONE budget, not a cache** — `postMessage` without a transfer
    list structured-clones once per live worker — so one write costs `filesize × worker count` against
    MemoryHandler's 400MB budget. Fine at generated-media sizes (1–30MB); a genuine 256MB write with
    several workers live would be felt. The correct end state is to make the invalidation path work for
    creates and lower this again.

    **Verified live after a full rebuild** (`build:lib` **and** `build:types`, dist swapped into
    `node_modules`, `pnpm sync:nodepod`, `node_modules/.vite` cleared): 4,194,305 / 9 MB / 30 MB all
    serve. ⚠️ **The first attempt "failed" and the fix was innocent** — Vite pre-bundles deps into
    `node_modules/.vite/deps`, and swapping a package's `dist` does NOT invalidate that cache, so the
    browser was still running the old constant (confirmed by grepping the cached chunk: it still read
    `4194304`). **Never conclude a dependency fix does not work without checking the dep cache is not
    serving the old bytes.**

  - ✅ **CLOSED 2026-08-11 by re-reading `.data` — the earlier "media absent after remount" was a
    SNAPSHOT OF A RACE, not a defect.** It read: *"the server working copy (seq 2, 76 files) contains
    no `assets/generated` entries at all… the bytes were never in the saved copy"*, and that sentence
    is now false. The same file is **seq 3 / 66 files** and holds BOTH assets —
    `shield-lightning-badge-mso97k.png` at 934,137 bytes (sha256 **identical** to the retained
    artifact, so the project file and the evidence file are one file) and
    `neon-light-trails-mso97l.mp4` at 2,355,914 bytes (`ftypisom`). The confounder named at the time
    was the right one: a render completes AFTER the stream ends, so a save observed mid-flight predates
    the delivery, and a later save picked them up.

    ⚠️ **Worth keeping for the lesson, which is about the observation and not the code: an absence
    observed ONCE, on a server that had been killed four times, was written up as a finding with a
    seq number attached — and the seq number is exactly what proved it wrong later.** Recording the
    version you looked at is what makes a wrong observation recoverable instead of permanent. Nobody
    re-checked it until an adversarial verifier did.

  - 🔴 **AND THE SAME TERNARY BUG ONE LAYER UP, IN THE UI (owner-directed, 2026-08-11).** A deployment
    can serve NO media at all — `LLM_PROVIDER=Anthropic` with no `MEDIA_PROVIDER` makes
    `getMediaProvider` return `null` (it keeps the platform provider only if it is in
    `MEDIA_PROVIDERS`), which `/api/me` reports faithfully. Two surfaces mishandled it:

    **(a) The panel drew KIE's catalogue for `null`.** `provider === 'Comet' ? COMET : KIE` sent the
    third state down the KIE branch, so a box that could serve nothing offered nano-banana-2 and
    kling-3.0 and refused only at quote time. Replaced by ONE writer, `modelsForProvider(kind,
    provider)`, returning `[]` for null — and an empty list is a state the panel RENDERS (an
    unavailable card) rather than indexes into. ⚠️ **Two sentences, not one**: `session.loading` says
    *"checking…"* and a settled `null` says *"not available on this deployment"*. Collapsing them
    either tells a healthy user their platform has no media, or leaves someone watching a spinner
    that will never resolve — `mount-source.ts`'s "said none ≠ said nothing", one screen up.

    **(b) The Media button rendered regardless.** Now hidden — but on **TWO** signals,
    `!sessionLoading && !media.provider`, because `media.provider` is null *both* before `/api/me`
    answers and when there is genuinely no gateway. Gating on the provider alone would hide the button
    on every page load and pop it back in: the toolbar resize §4.1a forbids. **Hidden, not disabled —
    deliberately the opposite of Share/Deploy**, which are disabled-not-absent because they become
    available a moment later; this one never will on that deployment, and §4.1a's other half is that a
    permanently-disabled control "is a dead end, not a roadmap".

    ⚠️ **Consequence, accepted not overlooked**: `refreshSession`'s non-ok/catch path sets
    `{...EMPTY_SESSION, loading: false}`, so a transient `/api/me` failure hides Media on a box that
    HAS a gateway. Consistent with how that path already degrades everything else (it also reports the
    user as unauthenticated, credits 0 and the tier ladder locked), so Media hiding is the least
    visible symptom of a session that has plainly failed — not a new regression. Revisit only if
    `/api/me` ever gains a partial-failure mode.

    ⚠️ **`veo3` is NOT unique across gateways** — KIE serves `veo3_fast`/`veo3`/`veo3_lite`, Comet
    `veo3-fast`/`veo3`, so the id `veo3` collides exactly while the fast variants differ by one
    character. The specs pin images as disjoint and the single video overlap as a literal; **do not
    "tidy" that into a blanket disjointness assertion, which would be false.**

  - Files: `app/lib/media/provider-defaults.ts` (new), `app/lib/.server/agent/media-tools.ts`,
    `app/components/media/MediaPanel.tsx`, `app/components/media/MediaButton.tsx`.
    Specs: `provider-defaults.spec.ts`, `MediaButton.spec.tsx` (new), plus additions to
    `media-tools.spec.ts` and `media-panel-fields.spec.tsx`. **77 files / 1,870 tests green**,
    typecheck clean, lint 0 errors, `.data` verified unchanged after every run.
  - Details: with `MEDIA_PROVIDER=Comet`, run `generate_image`, a **transparent** `generate_image`, and
    `generate_google_video` end to end (⚠️ **amended 2026-08-11**: this said `generate_video`, which on
    Comet is now impossible by construction — every video model Comet serves is Google Veo, and Veo must
    be asked for by name. AC5 says "three tasks" without naming tools, so the acceptance is unchanged;
    the instruction was not) — from the agent tool path (not only the routes), through the client poller, to real bytes in the sandbox file tree. Then induce a failure (an unserveable option set, or a killed task) and confirm exactly one refund.
    - **Verify alpha by decoding every pixel's alpha byte, not by reading the PNG colortype.** A fully opaque image in an RGBA container passes a naive `colortype === 6` check, and this repo has already shipped that exact false positive once.
    - Confirm the file proxy's byte-sniffing types the response from the **bytes** and reports any destPath/content mismatch — that check is what caught KIE writing JPEGs behind `.png` URLs.
  - Acceptance: AC5 — three tasks, three single debits, real bytes on disk in the project, correct extensions matching the sniffed content type, and exactly one refund on the induced failure. The transparent render is pixel-decoded and reports a substantial fully-transparent share.

- [x] **T10** — Probe the `chat` family's `reasoning_content`; add a wire wrapper only if it is real
  - ✅ **PROBED 2026-08-10 (`scratchpad/probe-reasoning.mjs`, real Comet key, non-streaming AND
    streaming). The field is REAL — and the hazard it was feared for does NOT occur.**

    | model | non-streaming | streaming deltas | reasoning in `content`? |
    |---|---|---|---|
    | `grok-4.5` | `reasoning_content` (111 chars) | `reasoning_content`, `role`, `content` | **no** |
    | `kimi-k3` | `reasoning_content` (82 chars) | `reasoning_content`, `role`, `content` | **no** |
    | `qwen3-coder` | `reasoning` — an **object**, not text | `content`, `role` only | **no** |
    | `glm-5.2` | none | `reasoning_content`, `role`, `content` | **no** |

  - 🔴 **The finding that decides it: reasoning is DROPPED, not LEAKED.** `@ai-sdk/openai` does not map
    `reasoning_content`, so the text is silently discarded — and every model's `content` came back a
    clean answer with no `<think>` wrapper and no reasoning prose. The §4.2a danger this task exists
    for is reasoning reaching the TEXT channel, which feeds the artifact parser and would be written
    into the user's source file. **That is not happening on any of the four.**
  - **So NO WRAPPER SHIPS**, per the task's own rule that an unused wrapper on a money path is a
    liability. What it would buy today is nothing: no shipped rung is a `chat` model (§4.6.1a is
    Standard/Premium, both `claude-*`), so there is no surface where that text would be displayed.
    ⚠️ **What would change the answer**: routing a `chat` model to any user-visible generation — OQ7
    option (c)'s cheap-model lever is exactly that. At that point the wrapper becomes required, and
    it must route to `g:` and NEVER to `text`, with a spec asserting both directions.
  - ⚠️ Two details worth keeping, because they would each mislead a later reader: `qwen3-coder`'s
    `reasoning` is an OBJECT (4 chars of JSON — effort metadata, not text), so a probe that only
    checked for the KEY would wrongly report it as having reasoning; and `glm-5.2` returns nothing
    non-streaming but DOES emit `reasoning_content` deltas when streamed, so a non-streaming-only
    probe would wrongly report it as having none. **The field name and its presence vary per vendor
    AND per request shape — probe both.**
  - Files: `scripts/` probe of choice, `app/lib/modules/llm/providers/comet-wire.ts`, `app/lib/modules/llm/providers/cometapi.ts`, spec for the wrapper if one lands
  - Details: Grok and Kimi return reasoning on a non-standard `reasoning_content` field that `@ai-sdk/openai` does not map, so thinking text may be silently dropped for the `chat` family. Probe `grok-4.5` and `kimi-k3` for the field's presence and shape. **If it is real, the wrapper must route it to the reasoning channel (`g:`) and NEVER into `text`** — the text channel feeds the artifact parser, so leaked reasoning is written into the user's source file (§4.2a). If it is absent, record that and add nothing: an unused wrapper on a money path is a liability.
  - Acceptance: a recorded probe result either way. If a wrapper ships, a spec asserting reasoning reaches the reasoning channel and that a control request without the wrapper carries none — plus an assertion that no reasoning text appears on the text channel.

- [x] **T11** — Re-measure the cache pattern over ≥30 requests, THEN set the warmer fanout: AC6
  - ✅ **MEASURED 2026-08-11 against real Comet. `DEFAULT_COMET_FANOUT` 1 → 5.** Raw output for the two
    runs taken today is retained in `scratchpad/t11-artifacts/` (the T9 lesson: a measurement whose
    artifact did not survive is a claim, not evidence). ⚠️ **Cold C is the 08-10 T3-era probe and has NO
    retained artifact** — it is recorded in `_specs/cometapi-provider_spec.md` and at plan line 126 with
    the identical `1/3/5`, and it is the ONLY sample that saw a write at index 5, i.e. the single
    reading the chosen value rests on. Said plainly because an earlier draft of this bullet implied
    three retained artifacts and there are two.

    **Comet warms PER BACKEND like KIE — not first-request like Anthropic direct.** Three cold runs
    plus a warm re-probe, `PROBE_PROVIDER=Comet node scripts/cache-probe.mjs`, ~3,375-token prefix,
    `max_tokens=1`, 3s spacing:

    | run | model | n | writes at | then |
    |---|---|---|---|---|
    | cold A | `claude-sonnet-5` | 30 | **1, 2, 4** | 26 consecutive HITs (27/30) |
    | cold B | `claude-opus-4-8` | 20 | **1, 2, 3, 4** | 16 consecutive HITs (16/20) |
    | cold C (T3, 08-10) | `claude-sonnet-5` | 12 | **1, 3, 5** | hits |
    | warm | `claude-sonnet-5` | 12 | — | **12/12 HIT, zero writes** |

    Cold A's per-request grid, which is the thing the AC actually asks for:

        1 miss(wrote) · 2 miss(wrote) · 3 HIT · 4 miss(wrote) · 5-30 HIT  (26 in a row)

    ⚠️ **A different MODEL was used for cold B deliberately** — the probe's prefix is a hardcoded
    constant, so the only way to get a genuinely cold entry after run A is to change the cache key.
    That makes B an independent sample rather than a re-run of A, at the cost of confounding model with
    attempt; the agreement between them is what matters.

    **Reading it.** Three distinct writes in A and C, four in B, all inside the first five requests —
    and A's request 3 HIT *between* two writes. That is requests spreading over a small pool of
    backends, each needing its own write, with a request able to land on one already warmed. **5 is the
    deepest index at which any sample still wrote**, so it covers all three. ⚠️ **The ratios are NOT hit
    rates** — 27/30 and 16/20 are both 100% after the warmup and 0% inside it. Reading a warmup as a
    rate is the exact mistake that cost a day on KIE and came within one env var of buying a 2.5×
    provider to fix a defect that did not exist.

    ⚠️ **Honest residual, recorded rather than rounded away — and SHARPENED after review:** if the pool
    were 4 with uniform random assignment, coupon-collector says covering it needs ~8 touches on average
    (4·H₄ = 8.33), and P(cover 4 in ≤5 draws) ≈ 23% — so full warmth by 4-5 three times out of three is
    ≈1.3% likely under that model. An earlier draft offered "either the pool is ~3, or assignment is not
    uniform"; **cold B wrote FOUR distinct times, which puts the pool at ≥4 for that key and kills the
    first branch.** What is left is non-uniform assignment (round-robin or sticky), under which fanout
    simply needs to equal the pool size — and 5 ≥ 4 covers it. That is a stronger position than the
    disjunction, arrived at by someone checking the arithmetic rather than by the author. The
    answer to that gap is to measure again, never to inflate the number: a fanout touch on a cold prefix
    is a **2× WRITE**, so guessing high bills real money every cycle forever, while guessing low costs
    one avoidable cold read that the next cycle (45 min, against a 1h TTL) fixes by itself.

  - ✅ **The warmer still ships DEFAULT OFF**, and the arithmetic that justifies that is untouched by
    this measurement — a fanout is *how much* a cycle costs, not *whether* the cycle is worth running.
    A test states that explicitly so the two questions cannot be conflated later.
  - ✅ **Claude-only no-op confirmed** (T11's second ⚠️): a `gpt-*` or `gemini-*` platform model makes
    the cycle skip with a describable reason and **zero fetches**, on every gateway, with a control
    proving the same env DOES warm for `claude-sonnet-5`. The guard's placement inside `runWarmCycle`
    (not `ensureCacheWarmer`) is source-scanned with controls, because `warmAfterPromptChange` is
    VITEST-guarded and cannot be driven behaviourally.
  - **89 tests** in `cache-warmer.spec.ts` (75 → 89), fanouts asserted as **literals** 5/6/1 per the
    AC's vacuity warning. Mutation-verified: `DEFAULT_COMET_FANOUT` → 1 fails 13, → **6** fails 13 (so
    the assertion is a literal and not "any number"), removing the Claude guard fails 7, defaulting the
    warmer ON fails 3.
  - 🔴 **INCIDENT, disclosed — a subagent ran `git checkout <file>` to revert a mutation on a DIRTY
    working tree and destroyed the uncommitted implementation** (T3's Comet warmer work plus the ladder
    threading; the file was modified-but-unstaged, so `checkout` restored HEAD). It was rewritten from
    the copy the agent still held in context and is byte-verified against its pre-mutation hash — and,
    independently: `pnpm typecheck` clean and **2,833 tests across 127 files green**, including every
    spec T3 wrote against this exact file, which is what makes the reconstruction *checked* rather than
    *asserted*. **Never `git checkout` a file to revert a mutation test.** Use a scratchpad copy — which
    is what every other mutation in this task used.
  - **Pre-existing vacuity found while pinning:** Comet's placeholder fanout of `1` COLLIDED with
    Anthropic's `1`, so three ladder tests could not distinguish the branch they were named for (a cycle
    that laddered to Comet and one that fell all the way to Anthropic produced the same number). Three
    distinct values fixes it as a side effect. **Two constants that happen to be equal make every test
    between them vacuous, and nothing reports it.**
  - Files: `app/lib/.server/prompt/cache-warmer.ts`, `app/lib/.server/prompt/cache-warmer.spec.ts`
  - Details: `PROBE_PROVIDER=Comet node scripts/cache-probe.mjs 30` plus a warm re-probe. **One 12-request sample is the exact sample size that produced a wrong verdict on KIE** — a miss rate measured over a warmup is not a miss rate, and a clustered failure (`1, 3, 5` and never again) is a pattern, not a rate. Read the distribution, not the ratio, and do not diagnose from production turns whose prefix changed between them. Only then set `Comet`'s fanout default from the observed warmup depth (the T3 placeholder is 1).
    - ⚠️ The warmer ships **default off** and the arithmetic that justifies it is unchanged: it warms only the shared prefix, so its value is a function of how many cold starts per day the platform actually has — `generations.cacheCreationTokens > 0` is a cold start, and a week of counting turns the guess into a decision. Do not turn it on as part of this plan.
    - ⚠️ The warmer is Claude-only; confirm it no-ops cleanly rather than warming a prefix nobody sends when the platform model is not a claude id.
  - Acceptance: a ≥30-request measurement recorded in the spec with the per-request hit/miss grid (not just a percentage). `cacheWarmerFanout` returns the measured value for `Comet` and is unchanged for `KIE` (6) and `Anthropic` (1). The warmer still defaults off. ⚠️ Assert the fanout against the measured number **as a literal in the test**, not against the constant it reads — an assertion that moves with the value passes for any value (the `PROGRESS_CAP` vacuity trap).

- [x] **T12** — Full-surface control pass: AC7
  - ✅ **DONE 2026-08-11 — verified PASS by an independent adversarial verifier. It did NOT come back
    clean, and the interesting part of this task is what it found.**

    **Gates.** `pnpm typecheck` clean · `pnpm lint` 0 errors / 17 pre-existing warnings ·
    `pnpm check:brand` clean · `.env.example` duplicate-key pin green. **All 321 spec files under
    `app/`, 6,513 tests, green.** ⚠️ The full `pnpm test` was NOT run — a standing session constraint
    forbids it — so it was run as four chunks instead. That is not a shortcut: the verifier confirmed
    from `package.json:17` + `vite.config.ts:105-115` that the three globs **partition the suite
    exactly** (150 + 135 + 36 = 321, zero files outside them), and chunking is what made `.data` drift
    attributable to a chunk, which is how the token-store leak below was caught at all. Residual: three
    processes cannot surface cross-chunk interference a single run would.

    **The live generation.** ⚠️ **KIE's entire `claude-*` catalogue is unserveable** — `pnpm
    kie-health` measured **92–100% failure across all ten Claude ids** (`200-then-error: Server
    exception`) while `gpt-5-6-*` and `gemini-3-5-flash` sit at **0%**. A plain HTTP probe returns
    **200 in 0.25s**, because the failure arrives after the status line; do not health-check this
    gateway with a status code. The turn was therefore driven on `LLM_PROVIDER=KIE` /
    `LLM_MODEL=gpt-5-6-terra` through the real UI. The verifier judged this to satisfy the clause —
    T12's Details name the **provider**, and `gpt-5` is the family T1 actually touched. **Disclosed,
    not blocking: no live turn ran a `claude-*` model on KIE or on Anthropic-direct**, so for those two
    wires "the incumbent is untouched" rests on unit tests plus two live Comet `claude-sonnet-5` turns.

    🔴 **AND THE CONTROL PASS FOUND A LIVE OVER-CHARGE — see the entry under T12b below.** T12's
    Acceptance says *settles at the expected rates*, and the first live turn settled at **1.86×**. The
    box could not be flipped until that was fixed, which is the entire reason this task exists in a
    plan that "only ever added to" the incumbent.

  - Files: none expected; failures land wherever they land
  - Details: run `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` clean, then re-run the KIE and Anthropic paths explicitly — `kie.spec.ts`, `kie-dispatch.spec.ts`, `kie-codex-wire.spec.ts`, `kie-gemini-wire.spec.ts`, `anthropic.spec.ts`, `model-families.spec.ts`, `billing.spec.ts`, `market-prices.spec.ts`, `media.spec.ts`, `delivery.spec.ts`, `model-tiers.spec.ts`, `usage-metadata.spec.ts`, `cache-warmer.spec.ts` — and drive **one real generation on `LLM_PROVIDER=KIE`** (or Anthropic, whichever is live) to prove the incumbent path is untouched by a plan that only ever added to it. Confirm `.env.example` still passes the duplicate-key pin and the brand gate is green.
  - Acceptance: AC7 — all gates green; every pre-existing spec listed above passes without modification; one real generation on the incumbent provider completes and settles at the expected rates.

- [x] **T12b** — 🔴 CACHED TOKENS WERE BILLED TWICE ON EVERY NON-CLAUDE FAMILY (found by T12, fixed, live-verified 2026-08-11)
  - **What it was.** `costForRates` bills `promptTokens` at the full input rate and `cacheReadTokens`
    at the cache rate and **adds them**, which is only correct if the two do not overlap. Whether they
    overlap is a property of each vendor's wire, and the conventions are opposites: Anthropic reports
    `input_tokens` EXCLUSIVE of the cache classes (siblings), while OpenAI and Google report the cached
    count as a **breakdown of** the prompt total. So on every gpt/gemini/chat turn the cached portion
    was billed **once at the full input rate and again at the cache-read rate**.
  - **How it hid, and it is this repo's own recurring shape.** `step-usage.ts`'s field comment declared
    `promptTokens` to be *"UNCACHED input"* and justified it with a sentence about
    `@ai-sdk/anthropic` — **a fact about one vendor doing duty as a contract on a vendor-neutral
    field.** True when written; silently false from the moment the gpt/gemini families shipped
    (2026-08-04). `rates.ts`'s `TokenUsage` carried the same claim. Another false claim in a comment,
    which is what a reviewer reads instead of the SDK. **No test could see it**: every usage fixture in
    the repo is Anthropic-shaped, and the nearest spec (`cache-neutral-billing.spec.ts`) sets
    `promptTokens: 0`. A vector where the two overlap did not exist anywhere in 6,500 tests.
  - **Worse than the multiple suggests.** The excess is `cacheReadTokens x inputPerMTok`, so **it grows
    with cache warmth** — largest on exactly the warm-prefix turns the whole context-budget programme
    exists to make cheap. And it **inverts `gate.ts`'s own stated rule** that "the customer is never
    billed for the state of our cache": the platform absorbs a COLD cache and was charging extra for a
    WARM one.
  - **The fix is a declared per-family fact about the WIRE, never a family check** (the cache-warmer's
    `=== 'KIE'` lesson): `FamilyPolicy.promptTokensIncludeCacheRead` — `claude` false, `codex`/`gemini`/
    `chat` true — with `accumulateStepUsage` subtracting **per step, floored at 0**. Per step because a
    totals-level subtraction lets one step's surplus absorb another's over-report; floored because
    settlement can never refuse (§4.6) and a negative would flow into `costForRates` and **credit** the
    user at the input rate. Required (not optional) inside `Record<ModelFamily, FamilyPolicy>`, so
    **a new family cannot compile without answering** — verified: deleting it is `TS2741`.
    ⚠️ `gemini` is declared `true` although its counter is never populated (the SDK maps none, so the
    subtraction is a no-op today). The entry states what Google's API DOES, so the arithmetic is
    already right the day an adapter reports it — inferring it from `cacheProfile` would tie a billing
    question to a pricing enum, two questions that merely agree today.
  - **Live-verified, both directions.** Same turn shape on KIE/`gpt-5-6-terra`: **before** `promptTokens
    35,066` (cache-inclusive) → `$0.021434` / 9 credits; **after** `promptTokens 17,464` → `$0.011044`
    / 5 credits, reconciling to the last digit. **CONTROL:** a WARM Comet `claude-sonnet-5` turn
    reports `cacheRead 31,094` against `promptTokens 2,049` — a cache read 15× the prompt total, which
    is only coherent on an exclusive wire — and the subtraction correctly did NOT fire. Had it, prompt
    tokens would have floored to 0 and **under**-charged. That pair is the evidence; the unit CONTROL
    (flipping `claude` to `true` fails 5 tests) is the guard.
  - **Measured exposure: 1 real turn, 10 credits.** `gen_msn5d82w_vn5t67` (2026-08-10, `gpt-5-6-terra`,
    43,224 cached) billed **28 credits against a correct 18 — 54% over**. Every other over-charged row
    is a T12 probe turn. Local `.data` only; a one-line `generations` query settles production, where
    exposure is very likely nil because the default rung is `claude-sonnet-5`.
  - **A second, smaller defect the verifier found in the FIRST draft of this fix**, and it is the reason
    an independent pass is worth its cost: subtracting from `promptTokens` alone left **`totalTokens`
    with two values** — `proxy.ts` persists the wire's number while `gate.ts` and the Supabase read both
    derive `promptTokens + completionTokens`. Live: `gen_msopyq5f` is 17,464 + 78 and stored **35,431**.
    Nothing bills from it, which is exactly why it would have sat there. Now subtracted in step and
    pinned as a RELATIONSHIP, not a literal (a literal passes for an implementation that subtracts the
    wrong amount from both sides), mutation-verified.
  - ⚠️ **Still open, and it becomes live if T13 takes option (c):** `api.enhancer.ts` settles with raw
    `usage.promptTokens` and a hardcoded `cacheReadTokens: 0`, never reading `providerMetadata`. Today
    `ENHANCE_PROMPT_MODEL=claude-haiku-4-5` (claude, exclusive) so cached tokens simply bill at zero —
    an UNDER-charge, the safe direction. Point it at `qwen3-coder` per T13's option (c) and the same
    cached tokens start billing at the **full input rate**. **Close this before that switch, not after.**
  - Files: `app/lib/modules/llm/model-families.ts`, `app/lib/.server/agent/step-usage.ts`,
    `app/lib/.server/billing/rates.ts` (comment), + specs
  - Acceptance: a real generation on an inclusive family settles at its true cost; claude numbers are
    byte-identical; the per-family answer is compile-time required. **All met and verified.**

- [ ] **T13** — Cutover (⚠️ GATED on OQ7 — owner decision, nothing technical resolves it)
  - ⏳ **OQ7 ANSWERED AND THE CONFIG IS FLIPPED (2026-08-11). The box stays OPEN because two of its
    Acceptance clauses are PRODUCTION OBSERVATIONS that no local run can supply.**

    **Done and verified locally:**
    - **OQ7 recorded in the spec** — owner chose **(a) cut over to Comet**.
    - `LLM_PROVIDER=Comet`, plus `LLM_PROVIDER_CHAIN=Comet,Anthropic`. ⚠️ **The chain is not
      cosmetic:** `AUTO_MODEL_SELECT=true` and the DEFAULT chain leads with KIE, which T12 measured at
      92–100% failure for Claude — so leaving the default would burn one generation into the 5-minute
      cooldown every window, forever, with a fully-known cause. KIE is dropped from the ORDER, not
      from the config.
    - **Served by Comet, verified on a real turn** (`gen_msp1zq2d_5o0mov`, `provider: "Comet"`).
    - **`cache_read > 0` on a warm turn, verified** — and the distribution corroborates T11 rather than
      merely satisfying the clause: writes at requests 1, 2, 3, 5 and a **read of 31,094 at request
      4**, i.e. the per-backend warmup with the straggler re-write T11 measured, reproduced on the
      cutover config.
    - **Reversal by config alone, verified** — `LLM_PROVIDER=KIE` produced a healthy settled generation
      during T12 (`gen_msopyq5f_e4aj43`) with no rebuild and no code change, then Comet again. The
      round trip was actually driven, not asserted.

    **Outstanding, and inherently the owner's:**
    - **Production** must be pointed at Comet (SSM → container env). This session flipped the LOCAL
      deploy only.
    - **"No elevated failure rate versus the prior week"** is a week of production traffic. There is
      none here to measure, and claiming it from local turns would be exactly the kind of
      evidence-outrunning-claim this plan caught twice already (T9's artifact citation, T12's
      `pnpm test`-wipes-`.data` note).
    - **OQ4** — whether Comet BILLS the ratio-adjusted rate or only advertises it. Only Comet's invoice
      answers it. The one failure mode is us UNDER-charging by ~20%, which is `rates.ts`'s safe
      direction, so it is a monitoring item and not a rollback trigger.
  - Files: deployment config only (`LLM_PROVIDER`, optionally `MEDIA_PROVIDER`); no code
  - Details:
    - **Do not start this task until the owner has answered OQ7.** The choice is between (a) accept ~2× KIE's Claude prices for reliability + streaming + real thinking text, or (c) push cheap `chat`-family models into the fixed utility paths (`ENHANCE_PROMPT_MODEL` — `qwen3-coder` at $0.24/$0.96 is a fortieth of Opus 5) so the blended rate lands nearer KIE's. Option (b), running both providers at once, is out of scope per assumption 3.
    - State plainly at handover, in both directions, because only the pair is honest: **Comet is ~2× a working KIE and ~20% cheaper than the Anthropic stopgap the platform is running today.** Margin is unaffected (credits are cost-proportional, so `CREDIT_MARGIN` holds), but **reach halves** — the same pack funds roughly half as many generations as it did on KIE. ⚠️ **Do not answer that by lowering `CREDIT_MARGIN`**: it trades the platform's margin for the user's reach and buries a provider cost increase inside the pricing model where nothing will ever attribute it back. The levers are the model ladder and the `chat` family.
    - Flip `LLM_PROVIDER=Comet`. **KIE stays selectable** (FR9) — one env var back, no rebuild.
    - Monitor for the first days: `generations.cacheCreationTokens` (cold-start rate, and whether the 3-write pool warmup is real at production volume), `finish_reason`, failure rate, and a ledger-level check of OQ4 — whether the 20% discount is applied at billing time or only advertised. Two sources agree; only the ledger proves it.
  - Acceptance: the owner's OQ7 answer is recorded in the spec. Production runs on Comet with `cache_read_input_tokens > 0` on warm turns, no elevated failure rate versus the prior week, and a reversal to `LLM_PROVIDER=KIE` verified to still work by config alone.

- [x] **T14** — Update `SPEC.md` (and the two sub-specs that assert KIE-only facts) to match what was built
  - ✅ **DONE 2026-08-11 — verified PASS on the SIXTH adversarial round. Rounds 1-5 all returned FAIL, and in EVERY one of them a fix from the previous round was itself wrong.** The journal below is kept in chronological order because that pattern is the deliverable: see the fourth-pass note for what each round found. *(The 'box stays OPEN' framing below was true when written and is superseded by this line.)*

  - ⏳ **MOSTLY WRITTEN 2026-08-11 — the box stays OPEN, and the reason is a dependency, not an oversight.**
    Two clauses are unmet. Its **Acceptance** requires *"every new env var appears in the config sections
    and in `.env.example`"* — `.env.example` carries all five, `SPEC.md` carries none of
    `COMET_API_KEY` / `COMET_BASE_URL` / `MEDIA_PROVIDER`. And its **Details** require
    `_specs/cometapi-provider_spec.md`'s **OQ7 marked with the owner's decision** — the cutover cost
    decision that gates **T13**, which nothing technical resolves.

    ⚠️ **An earlier draft of this note said the OQ7 requirement was in the Acceptance. It is in the
    Details.** Correct conclusion, wrong citation — in a write-back whose entire purpose is removing
    claims the source does not support, which is worth recording rather than quietly editing. Caught by
    an adversarial verifier, not by the author.

    **Written:**
    - `SPEC.md` §4.2a — the families block retitled to *the family names a DIALECT, the provider chooses
      the WIRE*, with the four-family reality and why `chat`'s cache profile is `none`. The original
      KIE-shaped sentence is kept, introduced as *"still true of KIE"*, rather than edited to sound
      general.
    - `SPEC.md` §4.2a — **`AUTO_MODEL_SELECT`**, which T14 predates: the ladder, default-off, chosen once
      at request start, the three gates, cooldown-as-a-preference, every provider-resolving reader taking
      the SELECTED gateway, and why it degrades instead of 503ing `/api/me`.
    - `SPEC.md` §4.6 — price lists per provider; `pricing × ratio` read per row; OQ1's resolution
      (`MODEL_RATES['claude-sonnet-5']` deliberately left at $3/$15); the user-visible discount and its
      three refuse-rather-than-guess rules; ledger rows labelled from `status_kind`.
    - `SPEC.md` §4.16 — retitled off "(KIE media)"; media as its own switch incl. the honest `null` state,
      the provider stamped on the task record, transparency as a per-model capability, the Veo ban, and
      provider-derived tool defaults/descriptions.
    - `SPEC.md` **§8g** — a new decisions log, appended, 11 entries. Nothing in §8–§8f was rewritten.
    - `spec/model-families.md` — retitled and given a framing block; §1–§8 left KIE-first **on purpose**
      (a probe log re-worded to sound general stops being a probe log), with the probe rule restated as
      an id-**plus-gateway** rule.
    - `spec/billing.md` — the Marketplace section retitled per-provider, with the ratio rule, the
      ensure-the-whole-chain rule, and what the user now sees.

    **Fixed on the second pass, after an adversarial read** — every one a claim the document made and the
    code or the document itself did not support: the family TABLE still had three rows under prose saying
    four (T14's Details asked for the row explicitly); "across all three families" in §4.2a and in
    `model-families.md` §12, which sits OUTSIDE that file's declared §1–§8 carve-out; the §11 sub-spec
    index still describing `model-families.md` by its retired title; §4.16 claiming the Media button
    "gates on TWO signals" when it gates on three and the real transient runs the other way; and §4.16's
    "REFUSED, never downgraded" not saying that a transparent request IS re-pointed to an alpha-capable
    model — and re-priced from that model's row.

    **Written on the third pass (2026-08-11), closing all but one clause:**
    - `SPEC.md` §4.2a — **the gateway variables in one table**: `LLM_PROVIDER` (now three values),
      `LLM_MODEL`, `AUTO_MODEL_SELECT`, `LLM_PROVIDER_CHAIN`, `COMET_API_KEY`, `COMET_BASE_URL`,
      `MEDIA_PROVIDER`, plus Comet's measured `streamed` delivery for `claude`. It also records WHY
      `COMET_BASE_URL` and `MEDIA_PROVIDER` are prose in `.env.example` rather than commented
      assignments — a later assignment wins in a real `.env`, and this repo already shipped
      `SIGNUP_GRANT_CREDITS` twice with different values.
    - `_specs/cometapi-provider_spec.md` — **OQ4** (open, and CANNOT be closed from here: only Comet's
      invoice answers it, and the one failure mode is us UNDER-charging, i.e. `rates.ts`'s safe
      direction), **OQ5** (closed — answered by construction once `MEDIA_PROVIDER` became an
      independent switch with the provider stamped on the task record; building the seam dissolved the
      sequencing question), **OQ6** (partially answered and honestly still open — 62 sequential probe
      requests drew zero throttling, which is the WRONG AXIS for a concurrency question, and KIE's
      queue-don't-reject failure mode would be invisible to a sequential probe by construction).
    - **OQ7 REFRAMED against T12's measurement.** It asked "is a ~2× cost increase acceptable to leave
      KIE?" — a comparison against a WORKING KIE, which the health run shows does not exist for Claude
      (92–100% failure on all ten `claude-*` ids). Against what the platform is ACTUALLY running today,
      Comet is **~20% cheaper**, not 2× dearer. Both numbers stay recorded; only the pair is honest.
    - `CLAUDE.md` — the T12b double-billing rule, and 🔴 **a correction: the ladder entry asserted the
      exact OPPOSITE of the code.** It described SuperMax as retired and `ENABLE_EXTENDED_MODELS` as
      refused, while the tree has three rungs (`standard | premium | platinum`), READS
      `ENABLE_EXTENDED_MODELS`, and refuses `ENABLE_PREMIUM_MODEL`. The flag name has now flipped twice;
      the knowledge base loaded into every session was teaching the inverse polarity on the switch that
      decides who gets served a paid model. Found by this write-back, not by anything failing — which
      is the argument for doing the write-back at all.
    - `SPEC.md` §8g — entries 12 (the per-family wire fact) and 13 (measure a gateway on its wire, not
      its status code). Nothing earlier was rewritten.

    **Fourth pass (2026-08-11), after a SECOND adversarial FAIL — and both rounds found the same
    class of error, which is the durable lesson of this task.** Round one: the flag-polarity fix had
    been applied to `CLAUDE.md` and NOT to `SPEC.md` §4.6.1a, so the document `CLAUDE.md` tells every
    session to read first still taught `ENABLE_PREMIUM_MODEL` as live and the third rung as retired —
    **a polarity fix applied to one document is half a fix.** Round two: the §9 probe-procedure
    correction was itself wrong, having grouped the scripts from memory rather than from source (it put
    `kie-model-health.mjs` in the wrong group and documented a `PROBE_PROVIDER=` flag on
    `stream-probe.mjs` that the script does not read) — **an inert flag on a documented command line is
    worse than the sentence it replaced, because it looks like it works.** Also fixed in round two:
    §4.16 described a FIXED defect as an accepted residual (it claimed a failed `/api/me` hides the
    Media button; `MediaButton.tsx`'s `!loadFailed` term exists to prevent exactly that, and a spec
    that documents a fix as a residual invites the next author to delete it); §4.6.1a's heading,
    `firstBuildLocked` default, and "coverage lost with the third rung" were all pre-`platinum`; three
    passages quoted the owner's live `.env.local` in the present tense and had gone stale
    (`PREMIUM_MODEL` is `claude-opus-5`, not `claude-fable-5`) — **state the RULE and cite config as
    dated evidence**; and `model-tiers.ts`'s own header read "Two rungs, ordered by cost" above a
    three-entry table, wrong on both counts.

    **Remaining: NOTHING.** OQ7 is recorded with the owner's decision (cut over to Comet, option (a),
    2026-08-11) and matches `.env.local`.
  - Files: `SPEC.md`, `spec/model-families.md`, `spec/billing.md`, `_specs/cometapi-provider_spec.md`
  - Details:
    - `SPEC.md` **§4.2a** — the model-families block currently reads "ONE `KIE` PROVIDER, THREE TEXT APIs". Replace/merge to: two gateway providers, four families, and **the family names a DIALECT while the PROVIDER chooses the wire** (`gpt-5` rides Responses on KIE and chat-completions on Comet). Add the `chat` family row to the family table with its cache profile, usage namespace and delivery. Record that the family still derives from the model id and that the provider is still one value per deploy — the reason it cannot come from `LLM_PROVIDER`.
    - `SPEC.md` **§4.6** — the Marketplace price list is now **per provider** (immutable versions + pointer per provider; the KIE keys unchanged so nothing migrated). Record Comet's pricing semantics: the feed's `pricing.*` are OFFICIAL vendor rates and **the charged rate is `pricing × ratio`, read per row** (three rows carry `1.0`, and a hardcoded `0.8` would under-charge exactly the newest, most expensive models). Record that `MODEL_RATES['claude-sonnet-5']` was **verified and deliberately left at $3/$15** — Comet's feed reporting official $2/$10 confirms `rates.ts:86-89`'s introductory-pricing note rather than contradicting it (**closes OQ1**).
    - `SPEC.md` **§4.16** — transparency is now provider-dependent: two priced stages on KIE, one native call on Comet, chosen by a per-model capability table; a request that cannot be served is refused, never downgraded. Record that the media provider is its own switch and that the provider is stored on the task record.
    - `SPEC.md` **§4.2a config** — `COMET_API_KEY` / `COMET_BASE_URL` / `MEDIA_PROVIDER`; `LLM_PROVIDER` accepts three values; delivery for Comet is `streamed` for claude (**measured**) and assumed-streaming elsewhere.
    - **Append to the decisions log** (§8f or a new §8g), never rewriting entries: family-names-dialect-provider-chooses-wire; the `chat` family and why its cache profile is `none`; provider-scoped price lists; media provider as an independent switch and why the provider is stamped on the record; and the OQ7 cost decision with its rationale.
    - Sub-specs: `spec/model-families.md` is titled "KIE's three text APIs, one provider" and its §1–§8 assert KIE-only facts throughout — retitle and extend rather than fork it; add Comet's probe procedure alongside §9's. `spec/billing.md` needs the per-provider list and the ratio rule.
    - `_specs/cometapi-provider_spec.md` — mark OQ1 closed with its resolution, OQ2–OQ4 with their probe results, OQ5 answered by construction, and OQ7 with the owner's decision.
  - Acceptance: `SPEC.md` describes the architecture as actually implemented — no section still claims one gateway provider, three families, or a single Marketplace list; the decisions log is appended to, never truncated; `spec/model-families.md` no longer reads as KIE-only; every new env var appears in the config sections and in `.env.example`; each spec's claims are traceable to a task above, and nothing is described that was not built.

---

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
