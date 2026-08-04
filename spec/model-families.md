# spec/model-families.md — KIE's three text APIs, one provider (governs SPEC §4.2a; money rules in `spec/billing.md`)

> **BUILT 2026-08-04** (`_specs/kie-tri-api-models_spec.md` / `_plan.md`, T1–T11). Every endpoint, id,
> field name and number in this file was **live-probed on 2026-08-04** against the real KIE account,
> or read out of a vendor SDK's source. Nothing here is copied from KIE's pricing feed, which
> demonstrably does not agree with their API about what a model is called.
>
> ⚠️ **What this file does NOT claim.** No generation has been driven end-to-end through the platform
> proxy on the `codex` or `gemini` families — the wires, the dispatcher, the billing and the delivery
> table are unit-pinned and probe-measured, the full request path is not. Output QUALITY on those
> families is **unevaluated**: every skill, brief and measurement in this repo is Claude-tuned, and
> there are no output-quality evals at all. No rung has been reassigned; `LLM_MODEL`,
> `PREMIUM_MODEL` and `SUPERMAX_MODEL` all still name Claude models.

---

## 1. Why family is a property of the MODEL ID

KIE fronts three completely different text APIs behind **one API key, one account, one bill**:

| Family | Endpoint | Wire |
|---|---|---|
| `claude` | `https://api.kie.ai/claude/v1/messages` | Anthropic **Messages** (native passthrough, not an OpenAI shim) |
| `codex` | `https://api.kie.ai/codex/v1/responses` | OpenAI **Responses** |
| `gemini` | `https://api.kie.ai/gemini/v1/models/<id>:streamGenerateContent?alt=sse` | native Gemini `generateContent` |

They are **one PROVIDER and three PROTOCOLS**, so `LLM_PROVIDER` cannot answer "which wire". Nor can
it in principle: the §4.6.1a ladder has three rungs which may point at models from three different
families **simultaneously**, while the provider is one value per deploy. The model id is the only
thing that varies per rung, so the family derives from it.

`app/lib/modules/llm/model-families.ts` (**client-safe** — it sits beside `capabilities.ts`, outside
`~/lib/.server/**`, because both the browser-imported provider registry and `.server` billing need
it) holds the rule:

```
claude-*  → claude      gpt-*  → codex      gemini-*  → gemini
```

`anthropic.`-prefixed Bedrock-style ids are stripped before the prefix test, mirroring
`capabilities.ts`'s own private `bareModelId`.

**🔴 An unknown id REFUSES; it never defaults.** `requireFamily` throws — naming the id and every
accepted prefix — and it is called **FIRST in `getModelInstance`, before the key lookup and before
any wire is built.** The alternative is not "a sensible default", it is guessing a protocol: before
this module existed, `capabilities.ts`'s tables were Claude-shaped deny-lists with a
default-to-modern-Claude fallthrough, so a `gpt-*` id got `supportsAdaptiveThinking() === true` and
would have had an **Anthropic `thinking` block written into an OpenAI request body** — a hard 400
before a token, on a model the operator believes is configured. One loud, immediate, free refusal
beats a guessed wire.

⚠️ `model-families.ts` deliberately holds **no wire builders and no delivery mode**, which is a
divergence from the feature spec's FR1 (it listed both as fields of the per-family record). A fetch
builder here would recreate the `base-provider → manager → registry → providers` import cycle that
`kie-wire.ts` exists to avoid, and delivery mode is `.server` policy living in `agent/delivery.ts`.

---

## 2. Per-family policy (`FAMILY_POLICY`)

| Family | `cacheProfile` | `usageNamespace` | `maxTokenAllowed` | `maxCompletionTokens` |
|---|---|---|---|---|
| `claude` | `derived` | `anthropic` | 1,000,000 | 128,000 |
| `codex` | `explicit-pair` | `openai` | 1,000,000 | 128,000 |
| `gemini` | `none` | `google` | 1,000,000 | 128,000 |

These are the one place the token limits live. `kieEnvModel` reads them when it synthesizes a
`ModelInfo` for an operator's unlisted `LLM_MODEL` — it used to inline `1_000_000`/`128_000`, the
Claude numbers, which would have silently attributed Claude's context window to a `gpt-*` or
`gemini-*` override. An **unknown** family still gets a `ModelInfo` there (falling back to `claude`'s
limits) on purpose: refusing in the list-builder would surface the operator's error as "your model
silently isn't in the list", which is the `modelsList[0]` mis-bill that function exists to prevent.
`getModelInstance` refuses it loudly at the moment of use instead — one refusal, at the point where
it can be explained.

---

## 3. The dispatcher and the wires

`app/lib/modules/llm/providers/kie.ts` branches on `requireFamily(model)` and builds one of three
instances. Auth is `Authorization: Bearer <key>` on **all three** (KIE ignores `x-api-key`).

### 3.1 🔴 The Claude wrappers wrap the CLAUDE branch ONLY

`thinkingFetch`, `kieFetch`, `stripSamplingParams` and `dropOrphanReasoningSignatures` all encode
Anthropic wire facts. Applying any of them to another family puts Anthropic-shaped fields in a
foreign request body — a hard 400 before a token. The **branch structure** is what makes that
impossible rather than merely unlikely, and `kie-dispatch.spec.ts` pins it with a default-deny source
scan. Claude-family behavior is otherwise **byte-identical to what it has always been** (§4.2a's
regression bar), including `KIE_BASE_URL`, which stays **Claude-scoped**: it has always meant "the
Claude endpoint", and one override silently repointing all three would be a config value whose
meaning changed under the operator.

⚠️ The codex/gemini base URLs are **module constants, not env vars.** (`kie-model-health.mjs` and
`stream-probe.mjs` read `KIE_CODEX_BASE_URL`/`KIE_GEMINI_BASE_URL` from `.env.local`; the app does
not. A probe pointed elsewhere is measuring something the platform will not call.)

### 3.2 `codex` — OpenAI Responses (`kie-codex-wire.ts`)

- `baseURL = https://api.kie.ai/codex/v1`. The `/v1` is REQUIRED: `@ai-sdk/openai` appends only
  `/responses`, so `.../codex` alone POSTs to `/codex/responses` and 404s.
- Instantiated as `createOpenAI({...}).responses(model)`.
- `codexFetch(effort)` rewrites the serialized body:

```jsonc
{ "reasoning": { "effort": "medium" } }   // MERGED into any existing `reasoning`, never replacing it
```

- **Why a `fetch` wrapper and not `providerOptions`:** `@ai-sdk/openai@1.3.24` emits
  `reasoning.effort` only when its internal id heuristic classifies the model as a reasoning model —
  a heuristic written against OpenAI's own id scheme. KIE's ids are their own, and the failure mode
  of a miss is **silent**: the field is dropped and the request buys whatever the gateway's default
  effort is. That is exactly the pathology `thinkingFetch` exists to kill on the Claude side.
- **`temperature` is the one decided-but-unmeasured seam.** `ai@4` injects `temperature: 0` when the
  caller supplies none. Read from the SDK's source: `getResponsesModelConfig` classifies any
  `gpt-5*` id as a reasoning model and strips `temperature`/`top_p` itself before serialization,
  which covers every id we ship today — but the heuristic is keyed on OpenAI's scheme, so a future
  KIE id outside `gpt-5*` falls out of it silently, and only a live probe proves KIE's gateway
  behaves like OpenAI's. It is deliberately NOT pre-emptively stripped (`stripSamplingParams` is a
  Claude wrapper; §3.1). If a probe ever shows a 400, the fix belongs **inside `codexFetch`**, pinned
  with a serialized-body assertion.

### 3.3 `gemini` — native `generateContent` (`kie-gemini-wire.ts`)

- `baseURL = https://api.kie.ai/gemini/v1`; `@ai-sdk/google` composes
  `/models/<id>:streamGenerateContent`. A missing `/v1` yields `/gemini/models/...` and 404s.
- `geminiFetch(thinkingLevel)` rewrites the serialized body:

```jsonc
{ "generationConfig": { "thinkingConfig": { "includeThoughts": true, "thinkingLevel": "low" } } }
```

- `generationConfig` is **MERGED, never replaced** — it already carries `maxOutputTokens` and the
  response format the SDK put there; overwriting silently drops the token cap.
- **Why a `fetch` wrapper:** `@ai-sdk/google@1.2.22` predates `thinkingLevel` entirely (its thinking
  option knows only `thinkingBudget`, a token count). No value of `providerOptions` produces the
  shape KIE's gateway accepted on the probe — the identical situation `thinkingFetch` documents for
  Anthropic adaptive thinking against `@ai-sdk/anthropic@1.2.12`.
- `includeThoughts: true` is the counterpart of Claude's `display: 'summarized'`: without it we are
  billed for reasoning that comes back with no readable trace. Paying full rate for reasoning we
  throw away is family-independent (§4.2a).

Both wrappers copy `kieFetch`'s defensive shape verbatim: a non-string or unparseable body is passed
through **untouched**. A body rewrite must never be the thing that breaks a generation.

---

## 4. Effort and `thinkingMode`, per family

Our `EffortLevel` is `medium | high | xhigh | max` (`low` is deleted — §4.2a). `ThinkingMode` is
`adaptive | disabled`; `disabled` is set by the proxy's **last-resort retry attempt**
(`retry-policy.ts`), whose entire purpose is to get bytes on the wire fast enough that KIE's ~30s
silent-step gateway timeout cannot kill it.

| Our value | claude | codex (`reasoning.effort`) | gemini (`thinkingConfig.thinkingLevel`) |
|---|---|---|---|
| `medium` | adaptive + `output_config.effort: medium` | `medium` | `low` |
| `high` | … `high` | `high` | `high` |
| `xhigh` | … `xhigh` | `xhigh` | `high` |
| `max` | … `max` | `xhigh` (**clamped DOWN** — the wire's ceiling) | `high` |
| `mode: 'disabled'` | `canDisableThinking(model, effort)`, clamped to `adaptive` when refused | `low` | `low` |

**🔴 `disabled` maps to the LOWEST effort, never to an off switch.** Neither foreign wire has a "no
reasoning" value, and a 400 for an unsupported field would land on the attempt that had already
failed twice. `max → xhigh` clamps DOWN because clamping up spends more than the caller asked for —
the same direction rule as `parseUserEffort`.

**🔴 `thinkingMode` reaching the KIE provider at all is new (2026-08-04) and its absence was a silent
no-op.** `proxy.ts` had been passing `thinkingMode: 'disabled'` on the final retry since the ~30s
timeout was diagnosed (2026-07-27). It reached `anthropic.ts`, which declares the parameter, and was
**dropped on the floor by `kie.ts`** as an excess property across the function-type boundary. So on
the provider the mitigation was written FOR, the third attempt was byte-identical to the first two,
and a generation that had already burned two 30-second timeouts re-rolled the same coin a third
time. The parameter is declared on `getModelInstance` now.

---

## 5. Usage metadata — where each family reports cache counters

The `ai` SDK normalises `usage.promptTokens`/`completionTokens` and does **not** normalise cache
counters: they arrive under a vendor key inside `providerMetadata`. One reader
(`agent/usage-metadata.ts`) serves both money paths — `step-usage.ts` (what settlement bills from)
and `proxy.ts` (the persisted step log the Admin dashboard diagnoses from) — which used to be two
independent hardcoded `providerMetadata.anthropic` literals.

| Namespace | read key | write key | status |
|---|---|---|---|
| `anthropic` | `cacheReadInputTokens` | `cacheCreationInputTokens` | unchanged; identity-pinned |
| `openai` | `cachedPromptTokens` | *(none)* | ✅ CONFIRMED from a live capture |
| `google` | `cachedContentTokenCount` | *(none)* | never present on KIE |

**Live capture, `gpt-5-6-sol`, 2026-08-04** — verbatim:

```json
"input_tokens_details": { "cache_write_tokens": 0, "cached_tokens": 0 }
```

`@ai-sdk/openai@1.3.24` maps `input_tokens_details.cached_tokens` →
`providerMetadata.openai.cachedPromptTokens`. Measured field, measured mapping.

**🔴 And the capture found something the SDK drops: KIE reports `cache_write_tokens`, and
`@ai-sdk/openai` maps it to nothing.** There is no `providerMetadata` key for it at any version we
pin, so `cacheCreationTokens` is **structurally always 0 on codex** — the explicit Cache Writes price
the gpt rows quote is therefore never actually applied. That is an **UNDER-charge**, i.e. the safe
direction, which is why it is recorded rather than worked around. Do **not** "fix" it by reading the
raw field in the usage reader: that module receives the SDK's normalized `providerMetadata`, not
KIE's response body. Closing it needs an SDK that maps it or a fetch-level capture, and neither is
worth doing until a real generation reports a **non-zero** `cache_write_tokens`.

**Live capture, `gemini-3-5-flash`, 2026-08-04** — verbatim, and this is the whole of it:

```json
{ "thinkingTokenCount": 770, "candidatesTokenCount": 1226, "totalTokenCount": 2105, "promptTokenCount": 109 }
```

No cached-token counter of any kind. `cachedContentTokenCount` is still *read* so that a KIE adapter
which starts reporting it is picked up automatically — expected zeros, never assumed zeros.

**Silent-zero vs loud-absence.** A missing individual value bills as zero and says nothing ("this
step cached nothing" — the common case, and the honest reading). A **wholly missing namespace on a
family whose cache we PRICE** means the counter we bill from disappeared, so every generation on that
family silently bills as if the cache did not exist: nothing throws, no test fails, and the credit
total goes DOWN, which reads as a cheaper turn. `sawNamespace` +
`shouldWarnMissingUsageNamespace` let the proxy warn once per generation — and it deliberately does
**not** warn on `gemini` (`cacheProfile: 'none'`), where absence is expected and a warning would
train the operator to ignore it on the two families where it means real money.

An unknown/absent family reads the `anthropic` namespace — the historical behavior, byte-identical
for every Claude generation ever billed. The fallback is today's answer, not a new opinion.

---

## 6. Cache economics per family

Full money rules and evidence live in `spec/billing.md` §"The Marketplace price list". Summary:

| Family | Profile | Rule |
|---|---|---|
| `claude` | `derived` | read = 0.1× input, write = **2.0×** input (the 1-hour tier, measured on KIE). The price list **REFUSES** an explicit pair. |
| `codex` | `explicit-pair` | The row must quote **both** `cachedInputPerMTok` and `cacheWritePerMTok`, or **neither** is accepted. KIE publishes both and the write is **1.25×**, not 2.0×. |
| `gemini` | `none` | KIE quotes no cached rate and their wire reports no cached-token counter, so cached tokens bill at the **full input rate** (read = write = input). |

**The 1.25× is the entire justification for `explicit-pair.`** KIE's feed (2026-08-04):

| model | Input | Output | Cached Input | Cache Writes |
|---|---|---|---|---|
| `gpt-5-6-sol` | $1.4 | $8.4 | $0.14 = 0.1× | $1.75 = **1.25×** |
| `gpt-5-6-luna` | $0.056 | $0.336 | $0.0056 = 0.1× | $0.07 = **1.25×** |
| `gpt-5-6-terra` | $0.56 | $3.36 | $0.056 = 0.1× | $0.70 = **1.25×** |
| `gemini-3-5-flash` | $0.45 | $2.7 | — (no row) | — (no row) |

1.25× is the **five-minute** cache tier; KIE does not resell the 1-hour tier on this surface.
Deriving these would have over-charged the write class by 60% on every cold turn, silently, with
nothing throwing. **A rule that holds for one family is not a rule** — and the only way to find that
out was to read the vendor's own numbers.

⚠️ The read multiplier is 0.1× on every gpt row, coinciding with Claude's derived value. **If a
future row breaks that pattern, quote it — do not infer it.**

⚠️ **Gemini warm edits cost what cold ones cost, by design** (owner decision, flagged and accepted
2026-08-04): never a discount we cannot verify KIE grants, never a surcharge we cannot observe. The
Admin margin report must not read that as a caching regression.

**Claude-only subsystems degrade rather than misfire.** `prompt/cache-warmer.ts` no-ops when the
platform model is not `claude` — breakpoint warming is an Anthropic mechanism end to end
(`buildWarmupRequest` speaks the Messages wire), OpenAI-style prefix caching is automatic and
unwarmable, and Gemini has nothing priced to warm. ⚠️ The guard sits in `runWarmCycle`, not
`ensureCacheWarmer`, because that is the one choke point every door passes through — including
`warmAfterPromptChange`, fired on every prompt promotion. Guarding only the starter would leave the
promotion path spending real money on a request that warms nothing, which is this module's own
documented failure shape.

---

## 7. Delivery mode — and the rule that it is DATA

`agent/delivery.ts` keys `DeliveryMode` by **(provider, family)** — never by a raw model id.

| Provider | Family | Mode | Evidence |
|---|---|---|---|
| Anthropic | all | `streamed` | `KIE_BUG_REPORT.md` control, 2026-07-24 |
| KIE | `claude` | **`batched`** | 2026-08-03, 3/3 request shapes on `claude-opus-5`: 26,539 chars, **100% in the final second**, after 130s / 168s of silence |
| KIE | `codex` | `streamed` | 2026-08-04, `gpt-5-6-sol`: 46,498ms, **2,382 deltas**, first at 3,016ms (6% in), **1.0% of chars in the final second** |
| KIE | `gemini` | `streamed` | 2026-08-04, `gemini-3-5-flash`: 12,542ms, 19 deltas, 6,828 chars, first at 5,650ms (45% in), **6.8% of chars in the final second** |
| anything | unknown family / unknown provider | `streamed` | never measured → claim the quieter thing |

**The number that matters is the final-second share**, not the total: it is what separates "streamed
for 46s" from "buffered for 46s and arrived at 46s", and **no server-side aggregate can tell those
apart** — identical durations, identical token counts, identical tok/s. Gemini's 19 deltas are few
and fat (the expectation bar will move in coarser steps), but they are spread across the run: that is
a streaming shape.

**🔴 Keyed by family, never by model.** A per-model table would report `streamed` the day someone
points `LLM_MODEL` at another Claude model on the same buffering adapter — a wrong sentence during
exactly the wait it exists to explain. A family is a property of the endpoint; a model id is not.
(It was keyed by provider alone, correctly, until KIE stopped being one API: the 2026-08-03 probe
proved the model was not the variable, and the 2026-08-04 probe then measured the GPT surface
streaming on the **same account and same key**.)

**🔴 An unmeasured surface is assumed to STREAM.** The `batched` sentence tells the user to expect
nothing for minutes; saying that about a surface we have not measured manufactures the very despair
the panel exists to prevent, and it is unfalsifiable from the user's side.

**🔴 THIS TABLE IS DATA.** If KIE's Claude adapter heals, re-measure and flip **one word** — no other
code change, no test rewrite. The re-measure command is in §9.

---

## 8. Verified ids — and why the pricing feed is not evidence

**FR9, the no-rabbit-hole rule: an id ships only after a live probe succeeds against its family
endpoint** (id accepted + streaming observed + usage metadata captured). It must be added to
`KIE_MODELS` (`kie-wire.ts`) **and** the baked price list **in the same edit** — a priced-but-unlisted
model runs as `modelsList[0]` while settlement charges the configured model's rates (wrong model,
right price, no error), and a listed-but-unpriced model bills at the most expensive row. Pinned both
directions by `model-tiers.spec.ts`.

**🔴 KIE's pricing feed is NOT evidence that an id exists.** The feed's display names are not the API
ids: the feed says **`gpt-5.6-sol`** (dots) where the API answers to **`gpt-5-6-sol`** (dashes). A
price row copied verbatim from the feed prices a model that cannot be called. The probe is the gate;
the feed is only the price. `validateLlmCachePolicy` says so in the error text it prints for an
unknown-family key.

**Shipped, all live-probed 2026-08-04:**

| Family | Ids |
|---|---|
| `claude` (10, unchanged) | `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-fable-5` |
| `codex` | `gpt-5-6-sol`, `gpt-5-6-luna`, `gpt-5-6-terra` |
| `gemini` | `gemini-3-5-flash` |

Probe results (health probe, 2 rounds × 13 models):

- `gpt-5-6-sol` **2/2**, `gpt-5-6-luna` **2/2** — zero failures.
- `gemini-3-5-flash` — 1 ok / 1 timeout.
- `gpt-5-6-terra` — held back at spec time pending its own probe; **PROBED CLEAN** (HTTP 200,
  streamed, usage captured), so it shipped priced AND listed in one edit.

⚠️ **Snapshot, not a verdict — re-probe before acting on it.** On the same run, same key, same
minute, the **CLAUDE** family was failing **25–100%** with `Server exception, please try again
later`, including **`claude-sonnet-5` — the platform default — at 0/4.** That is a live vendor
incident on one adapter, not a property of the catalogue and not a reason to move a rung. A vendor
fault can clear or return with nobody telling us.

---

## 9. PROBE PROCEDURE (reproducible from this file alone)

Three committed scripts. Each reads `KIE_API_KEY` (and base-URL overrides) from `.env.local` at the
repo root, and each derives endpoint, request body and response parsing from `familyOf(model)` using
the **same prefix rule as `model-families.ts`, duplicated deliberately** (they are plain `.mjs` with
no TS pipeline — keep the two in step; a probe that guessed the wrong wire would report a healthy
model as dead).

### ⚠️ Read this before interpreting any output

**KIE reports faults as HTTP 200 with a JSON envelope** — `{"code":N,"msg":"..."}` — never an HTTP
error status, and not an SSE stream at all. A probe that trusts `response.ok` reports a dead model as
"0 deltas, cause unknown". All three scripts keep the raw body and re-read it for that envelope
whenever no deltas arrive. Harvested strings, 2026-08-04:

| String | Class |
|---|---|
| `Server exception, please try again later` | transient (dominant; seen on claude **and** gemini) |
| `The server is currently being maintained, please try again later~` | transient (codex; note the trailing `~`) |
| `Internal error, please try again later` | transient |
| `The page does not exist` | **fatal** — unknown model id or unknown endpoint |
| `Unauthorized – Authentication failed…` | **fatal** |

**🔴 Replaying that 200-plus-envelope shape through the real SDKs raises NO error on any family.**
Measured 2026-08-04: the SDK sees a 200, finds no SSE events, and finishes cleanly with empty text
and `finishReason: 'unknown'`. What catches it in production is the proxy's `!producedText` guard,
which throws, marks the generation `failed` and **refunds** — see §10.

### 9.1 Catalogue health — "will KIE serve this id right now?"

```bash
node scripts/kie-model-health.mjs [rounds]      # default 6 rounds
```

Every model in `MODELS` (keep it in step with `KIE_MODELS` + `baked-market-prices.ts`) is tried once
per round, **interleaved and order-rotated**, so a provider blip cannot masquerade as a model fault
and no model is advantaged by going first. `max_tokens: 1`, no cached prefix — a failing model costs
nothing and a passing one costs a rounding error. Both `thinkingFlag` states are exercised on the
Claude family (it is KIE-proprietary, so a failure that only appears with it on would otherwise look
like a model fault).

**Read the round GRID, not the percentage.** A rate from a single sample is not a rate, and a
clustered failure is a pattern rather than a ratio. **A one-model probe cannot distinguish a model
fault from an outage** — that mistake was made on 2026-07-30 and corrected only when the full
catalogue came into view.

### 9.2 Streaming liveness — "progressively, or one lump at the end?"

```bash
node scripts/stream-probe.mjs [model] [maxTokens]     # default claude-opus-5, 6000
node scripts/stream-probe.mjs gpt-5-6-sol 6000
node scripts/stream-probe.mjs gemini-3-5-flash 6000
```

Arguments are order-free: an argument that parses as a number is the token cap, anything else is the
model id. Per-family SSE extraction — Claude `content_block_delta`, codex
`response.output_text.delta`, gemini `candidates[].content.parts`.

Output is a **gap histogram plus the largest single silence plus the final-second char share**.
Read the DISTRIBUTION, never the total: a stream that delivers everything in the last delta and one
that trickles for four minutes have identical char counts, token counts and durations.

**The Anthropic control only exists for the Claude family** and is SKIPPED with a printed note for
the other two — "no control was run" and "the control passed" must never look the same.

**This is the command that flips the §7 table.** A run whose final-second share is near 100% after a
long silence is `batched`; one that spreads deltas across the run is `streamed`.

### 9.3 Prompt cache — "when does a cached prefix start paying?"

```bash
node scripts/cache-probe.mjs [requests] [delayMs]              # default 12, 3000ms
PROBE_MODEL=gpt-5-6-sol node scripts/cache-probe.mjs 12 3000
```

Model precedence: `PROBE_MODEL` > `.env.local` `LLM_MODEL` > `KIE_DEFAULT_MODEL` >
`claude-sonnet-5`. **`PROBE_MODEL` is the whole reason this probe can produce a trustworthy answer
rather than a plausible one** — a probe that can only read `.env.local` can only measure one model,
so every result it gives is uncontrolled.

Per family:

- **claude** → `/claude/v1/messages` with an explicit `cache_control: {type:'ephemeral', ttl:'1h'}`
  breakpoint (the platform's exact shape). Counters:
  `usage.{cache_read_input_tokens, cache_creation_input_tokens}` — and the write counter is **also**
  served as a TIERED object `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`;
  both shapes are summed, because reading only the flat field reports a real write as **zero**.
- **codex** → `/codex/v1/responses` with the stable prefix as `instructions` (OpenAI caches prefixes
  automatically; there is no breakpoint to place). Counters come off the `response.completed` event
  as `response.usage.input_tokens_details.{cached_tokens, cache_write_tokens}`.
- **gemini** → `:streamGenerateContent?alt=sse`. **No cached-token counter exists**, so the probe
  prints an explicit "not reported" note rather than zeros that would read as a measured cache miss.

**🔴 Never diagnose the cache from production turns whose prefix changed between them, and never
read a miss rate measured over a WARMUP as a miss rate.** A new prefix costs ~4–5 cache WRITES before
it pays back, then holds at ~100% (`spec/context-budget.md`). This repo has twice nearly bought a
fix for a defect that did not exist.

### 9.4 Reconciliation — the balance-delta method

Neither the feed nor our own arithmetic proves what KIE actually charges. The check that does:

1. Read the KIE account **credit balance**:

   ```
   GET https://api.kie.ai/api/v1/chat/credit
   Authorization: Bearer $KIE_API_KEY
   → {"code":200,"msg":"success","data":75704.64}
   ```

   The balance is `data`, in credits, to **2 decimal places** — which bounds the method's precision at
   ±0.01 credit (±$0.00005). Size the run so the charge is well above that or the ratio is noise: a
   first attempt at this measured a "16× gap" on Gemini that was entirely quantization on a 0.03-credit
   charge, and it disappeared when the run was made 100× larger. The same URL is already in the code as
   `KIE_CREDIT_URL` (`app/lib/.server/billing/provider-balance.ts`), which is where to look if the
   endpoint moves.
2. Run a real generation (any of the probes above will do, sized to produce real usage).
3. Read the balance again; `delta_credits` is the charge. Wait ~6–15s first — KIE's billing settles
   after the stream closes, and reading too early reports a charge of zero.
4. Convert: **KIE prices every CHAT/TOKEN row at exactly $0.005/credit** — `creditPrice` 280 =
   `usdPrice` 1.40 on sol input; 70 of 71 feed rows checked are exact to 8 decimals. So
   `kie_usd = delta_credits × 0.005`.

   ✅ Independently corroborated in the code: `provider-balance.ts`'s `DEFAULT_CREDITS_PER_USD = 200`
   (measured 2026-07-26) is the same number from the other direction — 1/200 = $0.005. Two derivations,
   two dates, one rate.
5. Compute our own raw cost from the reported usage and the baked rates; compare as a ratio.

⚠️ **$0.005/credit is NOT universal.** The one outlier found was a MEDIA row (veo 3.1 4K, 380cr /
$1.85 = 0.004868). Do not carry this conversion over to §4.16 pricing without re-deriving it.

**Results, 2026-08-04:**

| Run | Ours vs KIE | Ratio |
|---|---|---|
| `gpt-5-6-sol`, 0 input / 546 output | $0.004586 vs $0.004600 | **0.997** |
| `gemini-3-5-flash`, 385 prompt / 5,349 candidates / 3,639 thinking — counting candidates **only** as output | $0.014616 vs $0.014600 | **1.001** ✅ |
| same run, counting candidates **+ thinking** as output | $0.024441 vs $0.014600 | 1.674 ❌ |

**🔴 The sol run confirms the OUTPUT rate ONLY.** KIE reported **zero input tokens**, so the input
rate is multiplied by zero and *any* input price reproduces $0.004586 to the digit. Its input and
cache rates are untested by it, and it cached nothing — **measure a row's CACHE accounting before
making it a default rung.** (This is the check `claude-opus-4-7` and `claude-fable-5` failed: both
report zero cache-write tokens while being charged the 2×.) The gemini run weakly constrains its
input rate: 385 prompt tokens are ~1.2% of the charge, so a 0.1% match bounds it to roughly ±8%.

**🔴 KIE does not bill Gemini thinking tokens — and we match only by inheritance.**
`@ai-sdk/google@1.2.22` maps `completionTokens` from `candidatesTokenCount` **alone** (dist L562,
L621) and drops `thinkingTokenCount` on the floor. Our correctness here is a consequence of that
SDK's choice, not something we assert.

> **TRIPWIRE.** If a future `@ai-sdk/google` bump starts folding thinking into `completionTokens` —
> the natural thing for it to do, since Google reports the counter — every Gemini generation would
> immediately **over-charge the user by ~1.67×, silently, with nothing throwing.** That is the wrong
> direction to be wrong in. **Re-run this reconciliation on any bump of that SDK.**

---

## 10. Retry, history and the cross-family guarantees

**Retry (`retry-policy.ts`).** The 2026-08-04 harvest added `/server exception/i` and
`/being maintained/i` to `RETRYABLE`, `/returned an empty response/i` to `RETRYABLE` (our OWN
`EMPTY_RESPONSE_ERROR`, exported as a shared constant so a reword cannot silently break the match),
and `/does not exist/i` to `FATAL`. None of the gateway strings are reachable via the existing
`\b5\d\d\b` rule, because the digits live in the envelope's `code` field and never in the message
text.

⚠️ **Stated plainly: these patterns are DEFENCE-IN-DEPTH, not a live behaviour change.** As wired,
the SDKs raise no error for KIE's 200-plus-envelope shape at all (§9), so the retry classifier is
never consulted for the most common KIE failure there is — the `!producedText` guard in `proxy.ts`
catches it, and **that throw sits AFTER the retry loop closes.** Moving the check inside the loop is
a real behaviour change with its own money implications and belongs in its own task. If it is ever
done, it is safe only because of the `outTokens > 0` gate: the other generation that produces the
same message is a clean `stop` with no text and 10,054 output tokens **billed**, which must still be
refused a retry and refunded. The distinction is not in the message; it is in whether anything was
billed.

**History (`llm/history.ts`).** Prior-turn reasoning is stripped from the conversation, and **🔴 the
strip is NOT family-conditional and must never become so.** That is exactly what makes the
cross-family guarantee hold: a conversation's earlier turns may have run family A while this turn
resolves to family B (any tier decline, any `LLM_MODEL` change, any resumed cross-device chat), so a
strip keyed on "this turn's family" would fail on precisely the case the guarantee names. It is keyed
on the message ROLE and nothing else; `familyOf` is deliberately not imported there.

The audit behind that (recorded in full in the file) has three independent layers: neither bumped
SDK's `doStream` emits anything but `{type:'reasoning', textDelta}`; zod strips vendor extras at the
parse boundary (⚠️ **true for google, NOT for codex** — the openai file carries a `.passthrough()`
unknown-chunk fallback, so layer 3 is the backstop there); and our own `drain` is a three-branch
whitelist. ⚠️ **The audit is derived from the vendor SDKs' SOURCE, not from a live KIE capture** — if
KIE returns a chunk shape neither SDK anticipates, only layer 3 catches it. ⚠️ Google has shipped
`thoughtSignature` upstream, so a later `@ai-sdk/google` bump WILL surface it and layer 2 stops
holding: **re-run the audit on any bump of either vendor SDK.**

**Cache breakpoints.** `CACHE_CONTROL` `providerOptions` are namespaced, so they stay attached and
are inert on non-Anthropic vendors; `MAX_CACHE_BREAKPOINTS` accounting remains Claude-scoped so its
degradation logic never measures a budget that does not exist.

---

## 11. SDK versions (the hard gate)

| Package | Before | After |
|---|---|---|
| `@ai-sdk/openai` | 1.1.2 | **1.3.24** (Responses API) |
| `@ai-sdk/google` | 0.0.52 | **1.2.22** |
| `@ai-sdk/anthropic` | 1.2.12 | **1.2.12 — UNCHANGED** |
| `ai` | 4.3.16 | **4.3.16 — UNCHANGED** |

Both bumped packages resolve to `@ai-sdk/provider@1.1.3` / `@ai-sdk/provider-utils@2.2.8` —
**identical to the untouched anthropic tree**, which was the gate. §4.2a's rule stands: never
downgrade `@ai-sdk/anthropic` below 1.x (0.0.x cannot parse thinking blocks), and 2.x needs `ai@5`.
Verify with `pnpm why @ai-sdk/provider` before and after any future bump — and note that a bare
`pnpm install` re-resolves the whole tree, so diff the lockfile before blaming a dependency.

---

## 12. Where the rules are pinned

| Rule | Test |
|---|---|
| Family derivation, unknown-id refusal, effort/thinking mappings | `model-families.spec.ts` |
| Family dispatch; Claude wrappers never wrap another family (default-deny source scan) | `kie-dispatch.spec.ts` |
| Serialized-body assertions: `reasoning.effort`, URL composition, Bearer header | `kie-codex-wire.spec.ts` |
| Serialized-body assertions: `thinkingConfig` merge, URL composition | `kie-gemini-wire.spec.ts` |
| Per-family usage extraction from captured fixtures; Claude identity pin; missing-namespace warning | `usage-metadata.spec.ts` |
| Cache-pair atomicity; per-family refusal/requirement; unknown-family key refused | `market-prices.spec.ts` |
| Gemini full-rate cache billing; gpt explicit-rate settlement math | `billing.spec.ts` |
| (provider, family) delivery matrix; unknown → streamed | `delivery.spec.ts` |
| Listed ⇔ priced, both directions, all families | `model-tiers.spec.ts` |
| `parseModel` across all three families | `ModelTierPanel.spec.tsx` |

⚠️ Do not run the full `pnpm test` suite — it currently destroys local `.data` (standing hazard).
Run the targeted specs.
