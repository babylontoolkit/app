# Spec for cometapi-provider

branch: project/feature/cometapi-provider
design_system: DESIGN.md
spec_impact: yes

> Authored 2026-08-10. **Every endpoint, id, wire and pricing fact below was LIVE-PROBED that day
> against the owner's real `COMET_API_KEY`** — none is taken from Comet's marketing pages or from
> their docs prose, both of which were demonstrably incomplete (the docs list no `remove_background`
> action for a model id that exists; the `/v1/messages` page names only one Claude id where the API
> serves 45). Probe scripts were extended rather than re-derived, so every number here is
> reproducible: `PROBE_PROVIDER=Comet node scripts/cache-probe.mjs`.

## Summary

📝 **Naming, so the rest of this document is unambiguous: the VENDOR is called CometAPI** (domain
`api.cometapi.com`), **and `Comet` is this platform's provider IDENTIFIER** — the `LLM_PROVIDER`
value, the `PLATFORM_PROVIDERS` entry, the provider class `name`, the `providerRates`/`DELIVERY` key.
It is `Comet` rather than `CometAPI` because the key is `COMET_API_KEY`, so `Comet` restores the
`<Provider>` ↔ `<PROVIDER>_API_KEY` pattern `Anthropic` and `KIE` already follow (`CometAPI` would
imply `COMETAPI_API_KEY`). Where this document says "Comet" it means the identifier or the service
interchangeably; where a precise distinction matters — the persisted `provider` field, the storage
slug — it is called out explicitly.

Add **Comet as a first-class platform provider** — one key, one account, one bill — fronting the
same protocol families the platform already speaks, plus a fourth (`chat`) that opens Grok, Kimi,
Qwen, GLM, DeepSeek and MiniMax. Comet serves a **native Anthropic Messages endpoint** with full
`cache_control` support and correct tiered cache counters, which is the single property that makes a
gateway viable for this platform at all (§4.2.8: an OpenAI-compat `/chat/completions` endpoint cannot
carry `cache_control`, so routing Claude traffic there silently disables every breakpoint and costs
~3× on every edit turn, with identical bytes and nothing thrown).

**Motivation is not the discount.** KIE is measurably failing at the job: its Claude gateway regressed
to fully BATCHED delivery (`agent/delivery.ts` records it), its adapter returns EMPTY thinking text
while still billing thinking tokens (`spec/anthropic-models.md` §3.4a), it kills any step that emits
no bytes for ~30s (`retry-policy.ts` exists solely to mitigate that), and **as of this probe run its
Claude endpoint returns `api_error` on every request shape**. The platform is currently on
Anthropic-direct as a stopgap at ~2.3× cost. Comet passed every one of those failure points.

## Ground truth (live-probed 2026-08-10)

### Text families

| Family | Endpoint | Wire | Streams? | Cache | Verified ids |
|---|---|---|---|---|---|
| `claude` | `api.cometapi.com/v1/messages` | Anthropic Messages (native) | ✅ **388 text deltas**, 4% in final second | ✅ real 1h-tier write + read, tiered split intact | claude-opus-5, claude-sonnet-5, claude-fable-5, claude-opus-4-8 (**45 ids** accept this wire) — ⚠️ **NOT claude-haiku-4-5, see below** |
| `chat` | `api.cometapi.com/v1/chat/completions` | OpenAI Chat Completions | ✅ | counters returned, **no price quoted** | gpt-5, grok-4.5, grok-4.3, kimi-k3, qwen3-coder, glm-5.2 |
| `gemini` | `api.cometapi.com/v1beta/models/<id>:generateContent` | native Gemini | (unprobed for text) | no counter | gemini-3-pro-preview, gemini-3-flash |

Auth: **both** `Authorization: Bearer` and `x-api-key` accepted on every surface.

🔴 **CORRECTION (2026-08-10, during T5 — this spec was WRONG): `claude-haiku-4-5` is NOT served by
Comet.** The row above originally listed it among the verified ids. A per-id re-probe
(`POST /v1/messages`, `max_tokens: 1`) returns a hard **400**:

```
{"error":{"type":"comet_api_error",
          "message":"model claude-haiku-4-5 has not been priced by the administrator yet…"}}
```

It is also **absent from `GET /api/models` entirely**. Comet serves the DATED
`claude-haiku-4-5-20251001` instead — which carries `code: "claude-haiku-4-5"`, i.e. exactly the
id/code drift FR4 warns about — at a `max_completion_tokens` the feed reports as **8K**, not the 64K
this platform uses for Haiku elsewhere. Adopting the bare id ships a 400; adopting the dated one
imports an unverified cap **and** contradicts SPEC §4.2a, whose model table is explicit that ids
carry no date suffix because on Anthropic the dated scheme 404s. Same string, correct on one
provider, broken on the other.

Haiku is not a rung the §4.6.1a ladder names, so it was **dropped** rather than shipped on two
guesses (`comet-wire.ts`, `baked-comet-prices.ts`). It stays in the probe list in
`scripts/kie-model-health.mjs` so the 400 keeps being reported rather than becoming folklore.

**The generalisable lesson, and it cost nothing only because the probe was run: a SPEC is not a
probe.** This document asserted the id was live-verified, and it was believed through planning and
two implementation tasks. Only a request returning 200 is evidence — which is what FR4 already said,
applied to its own author.

🔴 **There is no Responses wire for any model we would run.** Comet's model list marks `gpt-5*` as
`openai`; only `o3-pro` and `o3-pro-2025-06-10` carry `openai-response`. KIE's `codex` family is built
on `createOpenAI().responses()` and **does not port**. See FR2.

### Probe results, verbatim

| Property | Result | Why it matters |
|---|---|---|
| Prompt caching | write 5,420 → read 5,420; `cache_creation.ephemeral_1h_input_tokens` populated | §4.2.8's entire economy |
| Cache hit pattern | writes at requests 1/3/5, then **7 consecutive HITs** (9 hits of 12) | pool warmup, shallower than KIE's documented 1–4 miss curve |
| Anthropic-direct control | write then 2 HITs (warm on request 1) | same 5,420 accounting ⇒ numbers directly comparable |
| Thinking text | **386 chars + valid signature**, `thinking_tokens: 177` | KIE returns EMPTY here while billing it |
| Tool calling | `stop_reason: tool_use`, clean args, **no `strict` rejection** | KIE's codex gateway 400s on `strict: true` behind an HTTP 200 |
| Streaming | 5,825 chars / 388 deltas / 4% in final second ⇒ `STREAMING` | KIE Claude is `batched`; restores progressive artifact streaming |
| KIE control | `api_error` on all three request shapes | the provider being replaced is hard-down |

### Media (§4.16) — all probed end to end

| Capability | Route | Result |
|---|---|---|
| Image (OpenAI-compat) | `POST /v1/images/generations` | seedream-5 → **2048×2048, 438KB** |
| Image (nano banana) | `POST /v1beta/models/gemini-3-pro-image:generateContent` | **676KB**, 1408×768 — the feed labels this endpoint "nano banana" |
| Video | `POST /v1/videos` → `GET /v1/videos/{task_id}` | veo3-fast: queued → completed in **54s**, **3.6MB MP4** downloaded |
| **Transparency** | `POST /v1/images/generations`, `background:"transparent"`, `gpt-image-1.5` | **77.48% fully transparent, 7.75% semi**, pixel-decoded |
| Image editing | `POST /bria/image/edit/{action}` → `GET /bria/{request_id}` | 202 + `request_id`, async poll works |

🔴 **Transparency is now ONE call, not two.** The current KIE pipeline is render(jpg) →
`recraft/remove-background` — two priced stages under one debit, a 4K refusal rule, and a prompt
directive forbidding checkerboards. `gpt-image-1.5` with `background:"transparent"` produces real
alpha directly. ⚠️ `gpt-image-1` and `gpt-image-2` **refuse** the parameter — the capability is
per-model and must be a table, never an assumption.

⚠️ Alpha was verified by **decoding every pixel's alpha byte**, not by reading the PNG colortype.
A fully opaque image in an RGBA container passes a naive `colortype === 6` check — this repo has
already shipped that exact false positive once (CLAUDE.md §4.16).

## Live drive through the real proxy (T6, 2026-08-10) — AC1, AC2, AC4 PASS; AC3 PARTIAL

Everything above this section was probed at the WIRE. This section is different in kind: a local dev
deploy was pointed at `LLM_PROVIDER=Comet` / `LLM_MODEL=claude-sonnet-5` and a real project was
built and then edited **through `/api/agent`**, so these numbers come from the platform's own
persisted step log (`.data/generations/*.json`), not from a script. That distinction is the whole
point of T6: a probe can only prove the gateway answers, never that the platform's four cache
breakpoints, its tool loop, its reasoning channel and its settlement all survive on it.

🔴 **THE SOURCE RECORDS ARE EPHEMERAL — the per-step grids below ARE the evidence now.** This
section's authority rested on `.data/generations/gen_msnd2rcz_rvmcu9.json` and
`gen_msndslam_qy8aa1.json`, so the load-bearing numbers are transcribed inline rather than cited by
path. Do not "tidy" them into prose: a claim whose evidence has been deleted is a claim nobody can
check.

⚠️ **The stated REASON was wrong, and correcting it matters more than the conclusion.** This read
*"this plan's own T12 runs the full `pnpm test` suite, which wipes local `.data`"*. T12 ran all 321
spec files and **`.data` was byte-identical afterwards** — both records survive today. Nothing in the
suite wipes it. The precaution was right for a reason nobody had checked, which is a coin-flip away
from being a precaution nobody takes.

🔴 **What T12 DID find is the real hazard, and it is narrower and nastier:** `delete-account.spec.ts`
called `new FsGitTokenStore(path.join(tmp, 'tokens'))` against a `(context, root?)` signature —
passing a path as the CONTEXT and leaving the root defaulted to `platformDataDir()`, so it wrote
fixture git-token rows into the developer's real `.data/git-tokens/` on every run. It typechecked
because `context` is `unknown`, and the comment four lines below it already named the hazard. Specs
do not wipe `.data`; **a spec with one argument in the wrong position writes to it.** Fixed, and the
deposited row removed.

**Turn 2 (`gen_msndslam_qy8aa1`) — the AC1 grid, per step:**

| # | inTokens | cacheRead | cacheWrite | out | reasoning | text | tools |
|---|---|---|---|---|---|---|---|
| 0 | 2,712 | **29,892** | 1,322 | 397 | 125 | 0 | `read_file` ×5 |
| 1 | 13,290 | 29,892 | 1,322 | 348 | 379 | 0 | `read_file` |
| 2 | 17,285 | 29,892 | 1,322 | 80 | 0 | 73 | `evaluate_in_game` |
| 3 | 17,374 | 31,214 | 0 | 411 | 514 | 0 | `read_file` |
| 4 | 19,807 | 31,214 | 0 | 76 | 0 | 62 | `evaluate_in_game` |
| 5 | 19,889 | 31,214 | 0 | 68 | 0 | 0 | `read_file` |
| 6 | 22,656 | 31,214 | 0 | 70 | 0 | 23 | `read_file` |
| 7 | 25,154 | 31,214 | 0 | 72 | 0 | 31 | `read_file` |
| 8 | 26,403 | 31,214 | 0 | 3,330 | 0 | 7,372 | — |

Totals: `cacheRead 276,960` · `cacheWrite 3,966` · `promptTokens 164,570` · `completionTokens 4,852`
· `finishReason "stop"` · `creditsCharged 139` · `rawCostUsd 0.35913280` · `durationMs 74,317`.

**Turn 1 (`gen_msnd2rcz_rvmcu9`)** — 17 steps, pattern `W W W R R R R R W R R R R W R R W`, every read
exactly 31,102 and the writes 31,102 ×5 / 26,542 (step 17); `cacheRead 342,122` · `cacheWrite
182,052` · `promptTokens 1,057,167` · `completionTokens 39,288` · `finishReason
"stop+forced-continuation"` · `toolRounds 15` · `creditsCharged 836` · `rawCostUsd 2.64307712` ·
`durationMs 437,360`. Reasoning chars by step: 208, 233, 236, 210, **7,770**, 1,577, 2,173, 2,781,
0, 56, 0, 166, 0, 230, 0, 0, 0 — i.e. thinking on **11 of 17** steps.

⚠️ **`.data/` is a LIVE store even before T12**: a third turn (`gen_msne74q1_ogt5mt`, 11 steps, all
reads 29,892/31,214, raw `$0.32546784`, 123 credits, ledger chained 27,421 → 27,298) was written
*during* verification and corroborates AC1 independently. `.env.local` was also modified at **15:21Z**,
between turns one and two; **the reason is not recorded** and no artefact shows what changed — turn
one already ran on this provider, so the switch was complete before it. All three turns reconcile
against the identical `CREDIT_MARGIN=4.0` and Comet rates, so nothing here is affected, but a reader
should not assume a static environment across the table below.

🔴 **EVERY GENERATION RECORD FROM THIS DRIVE CARRIES `provider: "CometAPI"`, NOT `"Comet"`.** The
provider identifier was renamed `CometAPI` → `Comet` *after* these turns were recorded (owner
request, same day — see the rename note in the plan), and the ledger and generations stores are
append-only history, so the old string stands in them forever. The spec and the raw JSON therefore
*correctly* disagree about that one field. ⚠️ Nothing reads it — no billing or admin code matches on
the persisted `generations.provider` string — so the historical rows mis-price nothing. **This note
exists because a mechanical find-and-replace across this document silently rewrote a QUOTATION of
persisted data into something the artefact does not say**, which is the same false-claim-in-a-doc
class recorded three times above, arriving through a rename rather than through a draft.

| Turn | Generation | Steps | cacheRead | cacheWrite | out | finish | credits | raw |
|---|---|---|---|---|---|---|---|---|
| 1 — first build | `gen_msnd2rcz_rvmcu9` | 17 | **342,122** | 182,052 | 39,288 | `stop+forced-continuation` | 836 | $2.643 |
| 2 — edit | `gen_msndslam_qy8aa1` | 9 | **276,960** | 3,966 | 4,852 | `stop` | 139 | $0.359 |

**AC1 (blocking) — PASS, and the edit turn is the number that matters.** Turn two read **276,960**
cached tokens against **3,966** written — a **70:1 read/write ratio**, i.e. the cached prefix
survived across a user message and only the delta was re-written. The decisive single number is its
**first** step reading **29,892**: no earlier step in *that request* could have written that prefix,
so it can only have come from an earlier request — which is precisely what cross-turn cache survival
means. ⚠️ Note it is **not** a turn-one artefact: 29,892 matches none of turn one's own write sizes
(26,542 / 31,102) and recurs identically in turn three, so it is a **shared prefix boundary** — the
base-prompt block that is byte-identical across users and projects. AC1 is satisfied either way,
because what it turns on is that no step in this request wrote it. Every one of its 9 steps read ~30k
(`29,892 ×3`, `31,214 ×6`).
Turn one is the corroborating half: 11 of its 17 steps read exactly 31,102 tokens off a prefix
written earlier in the same generation — i.e. **each read equals the 31,102-token prefix that was
written**, which is what makes the tiered accounting coherent rather than merely non-zero. (The
*totals* are 342,122 read vs 182,052 written and are not meant to be equal; an earlier draft of this
paragraph claimed they were, which was simply false and is corrected here.) **The four breakpoints
survive on Comet.**

Turn one's per-step cache pattern, verbatim, is `W W W R R R R R W R R R R W R R W` — pool warmup
visible *inside* one generation, with writes recurring at steps 9, 14 **and 17** rather than only at
the front. See AC6/T11: this must still be measured over ≥30 requests before any warmer fanout is
set, and a pattern read off one generation is exactly the sample size that produced a wrong verdict
on KIE.

**AC2 — PASS, with its scope stated.** `stream-probe.mjs` on **`claude-opus-5`**: 16,237 chars in
**1,024 text deltas, 2% in the final second, verdict STREAMING** (bar: >50 deltas, <20%). The
Anthropic control streamed too (8,067 chars / 41 deltas / 5%), and KIE returned `api_error` on all
three request shapes — the incumbent is still hard-down. ⚠️ **The probe model is `claude-opus-5`, not
the drive's `claude-sonnet-5`**, and the probe output is not committed; re-run
`PROBE_PROVIDER=Comet node scripts/stream-probe.mjs` to reproduce. Progressive rendering was also
observed in the browser during the real build turn (chat DOM growing across ~15 distinct increments
over 57s rather than arriving in one lump) — that observation has **no persisted artefact** and is
recorded as corroboration, not as a measurement.

**AC3 — PARTIAL. The half that matters is proven; the signature half cannot be observed through the
proxy, by design.**
- **Non-empty thinking on a real generation: PROVEN.** Turn one's step log carries 7,770 / 2,781 /
  2,173 / 1,577 reasoning chars on separate steps and the thinking panel rendered a long readable
  trace. This is the exact property KIE regressed (`spec/anthropic-models.md` §3.4a: empty thinking,
  still billed) and it is the reason AC3 exists.
- **Signature: proven at the WIRE, on `claude-opus-5` only — NOT on a real generation.** Under the
  platform's exact production shape (`thinking:{adaptive,summarized}` + `output_config.effort`),
  opus-5 returns 4,265 chars of thinking with a **10,528-char `signature_delta`**
  (`CAIS0T0KcAgQEAEYAipAKgeM…`) on its own `thinking` block, while the sibling `text` block carries
  **zero** thinking and zero signature — so reasoning is signed and never merged into the text
  channel that feeds the artifact parser.
- ⚠️ **A signature can never appear in a real generation's persisted evidence**: `AgentChunk` has no
  signature field and `llm/history.ts` strips prior-turn thinking deliberately (both by design, see
  CLAUDE.md's edit-turn entry). So AC3's "on a real generation" is unsatisfiable as literally worded
  for the signature clause. The nearest available proof is **behavioural**: turn one ran a 17-step
  tool loop with thinking on most steps, and Anthropic rejects the *next* request in such a loop with
  `thinking.signature: Field required` if the signature is absent or invalid. It did not.
- ⚠️ `claude-sonnet-5` declined to think on the same hard prompt while opus-5 thought for 4,265
  chars. That is **adaptive working correctly**, not a defect — sonnet-5 thinks freely on the real
  build turn. Do not read one no-think response as a provider fault; that is the small-sample trap
  this project keeps re-learning.

**AC4 — PASS on settlement and the tool loop; its `strict` clause tested nothing.** Turn one drove
`read_file`, `load_reference`, `generate_image` (×2), `get_game_errors`, `get_game_console`,
`evaluate_in_game` and `capture_game_screenshot` across 17 steps — file tools, media tools and the
§4.14 preview relay. It shipped **10** files and the game runs: the preview at `/play` renders the
canvas with a live HUD. Settlement is exact on both turns (`status: completed`; raw
`$2.64307712` / `$0.35913280` reconcile to 8dp against `BAKED_COMET_PRICES`' claude-sonnet-5 row,
and against neither KIE's nor Anthropic's rows — so the correct provider's list was used; 836 and
139 credits, both matching ledger rows that chain correctly).

⚠️ **Credits are NOT `ceil(rawCostUsd / CREDIT_UNIT_COST_USD × CREDIT_MARGIN)`, and checking them that
way makes a correct system look broken.** That relation gives 1,058 for turn one, not 836. Credits
derive from `gate.ts`'s **`billedUsage`**, which prices cache-creation at the READ rate (owner rule,
2026-08-07) — `ceil(2.08963904/0.01×4.0)` = **836** and `ceil(0.34707616/0.01×4.0)` = **139**, both
exact. `rawCostUsd` records the TRUE provider cost for the §4.10 margin report and is deliberately a
different number. Two readers of this section have now re-derived the wrong one first; the clause is
here so the third does not.

Three honesty notes on AC4, none of which change the verdict:
- 🔴 **The `strict` clause was UNREACHABLE and remains untested on Comet.** `strict: true` is emitted
  only by `@ai-sdk/openai`'s Responses binding; the Comet **claude** branch builds via
  `createAnthropic` and never serialises it. A claude-only drive could not have produced a strict
  fault whatever the gateway did. **Comet's `chat` and `codex` branches — where the hazard actually
  lives — have not been driven**, and should be before either is used in anger.
- The two `generate_image` calls ran on **KIE**, not Comet (`med_msnd6kw0_or0cyg`,
  `med_msnd8gxk_nw4deg`, provider `KIE`, 24 + 18 credits). Correct — media moves in T7/T8 — but the
  media path was still on the incumbent, so this drive says nothing about Comet media (that is AC5).
- Turn one finished `stop+forced-continuation` at `toolRounds: 15`: it hit the tool-round cap and the
  `shouldForceContinuation` rescue re-wrote a 26,542-token prefix to emit 863 output tokens (that
  gate lives in the agent proxy; §4.2.8 is the context-budget section, not the rescue). That is a
  **known platform
  cost pathology on first build turns, not a Comet property** (the same shape is recorded in
  CLAUDE.md against other providers), but a new provider's first build turn hitting it is worth
  knowing before reading turn one's 836 credits as a steady-state figure. Turn two, the ordinary
  case, finished clean at 139.

### Two findings the drive produced that no acceptance criterion asked for

🔴 **Comet's Claude models are served via AWS Bedrock, and Bedrock validates the request.** An
unknown `anthropic-beta` header is a hard **400** with the backend named in the error
(`InvokeModel: operation error Bedrock Runtime … ValidationException: invalid beta flag`). A known
beta (`interleaved-thinking-2025-05-14`) returns 200. **So any beta header this platform adds later
must be probed on Comet before it ships — an unrecognised one fails EVERY request, before a token.**

🔴 **`thinking:{type:'enabled'}` is REFUSED** — *"is not supported for this model. Use `adaptive` and
`output_config.effort` to control thinking behavior."* The platform never sends `enabled`, so this
costs nothing today, but it means Comet's Claude surface accepts a **narrower** thinking vocabulary
than Anthropic's and a shape that works direct can 400 here. ✅ **`thinking:{type:'disabled'}` was
probed separately and returns 200**, so `retry-policy.ts`'s final attempt (`retryThinkingMode`,
which drops thinking so text starts flowing in ~1s) is compatible — worth confirming explicitly,
because a 400 there would land on the turn that had already failed twice.

## PLATINUM / Fable 5 on Comet — 3 live edit turns, 0 refusals (2026-08-10)

The §4.6.1a ladder gained a third rung (`PLATINUM_MODEL`, default `claude-fable-5`) the same day, so
Fable 5 became a rung a USER can select rather than a model nothing pointed at. Three consecutive
edit turns were driven through the real proxy. Transcribed here because `.data` is ephemeral:

| turn | steps | out | cacheRead | cacheWrite | credits | raw | finish | rawStops |
|---|---|---|---|---|---|---|---|---|
| `gen_msnh7d6s_eii872` | 6 | 14,594 | 61,348 | 30,674 | 677 | $2.1569 | `stop` | `[]` |
| 17:03 | 2 | 360 | 29,352 | 1,322 | 119 | $0.3159 | `stop` | `[]` |
| 17:05 | 2 | 283 | 60,026 | 1,322 | 63 | $0.1765 | `stop` | `[]` |

**Settlement is provably on the right row.** Turn one's `rawCostUsd 2.15686240` reconciles to 8 d.p.
against the Comet **fable-5** row ($8/$40, read 0.8, write 16.0) and against **neither** Comet's
opus-5 row nor KIE's fable-5 row — both of which compute $1.07843120. A rung that silently served a
cheaper model, or billed against the wrong provider's list, would fail that check.

⚠️ **Cost is dominated by OUTPUT, and the spread across these three turns is TURN SIZE, not cache
state.** An earlier draft of this section said the 677 was "almost entirely the cache write". That is
false, and it is false for a reason worth stating because it recurs: **`billedUsage` makes the
platform cache-neutral** (2026-08-07) — every cache-CREATION token is billed at the READ rate and the
platform absorbs the 2× write premium, precisely so *"the customer is never billed for the state of
our cache"*. So a cold prefix cannot make a user's turn dearer, and reading a credit spread as a
cache-warmth effect is reading a number the billing layer deliberately removed.

Turn one's real composition: input 129,155 × $8 = **$1.033 (61%)**, output 14,594 × $40 = **$0.584
(35%)**, all cached reads (incl. the 30,674 written) 92,022 × $0.8 = **$0.074 (4%)**. It cost 677
because it was a **six-step turn that wrote 14,594 output tokens**, against 360 and 283 on the two
after it. At $40/MTok output, Fable 5 makes output the driver — §"Wasted tokens and dead time"'s
standing rule, arriving on the ladder's top rung.

⚠️ Therefore **63–119 credits is NOT a steady-state Platinum figure**; those were tiny turns. A
Platinum edit that writes real code lands near 677 again whatever the cache is doing.

🔴 **THIS DOES NOT CLEAR THE REFUSAL RISK, AND THE REASON IS SPECIFIC.** OQ2 established that Comet
accepts `fallbacks` and silently DROPS it, so `llm/refusal-fallback.ts` cannot mitigate a Fable 5
safety-classifier decline here. The declines recorded in CLAUDE.md were observed on **first build
turns**, usually on the continuation step after media tool results — and all three turns above are
EDITS. So the healthy run is real evidence about the rung, and no evidence at all about the path
where the failure lives. ⚠️ Three samples also cannot bound a low-rate intermittent failure: this
document has already recorded two wrong verdicts from small samples (a 12-request cache curve, and a
2-request claude caching probe that read as "no caching" and was pool warmup). **A first build turn
on Platinum is the outstanding test.**

## Pricing semantics (a money path — read this before touching rates)

🔴 **`pricing.input`/`pricing.output` in `GET /api/models` are the OFFICIAL vendor rates. The
charged rate is `pricing.* × pricing.ratio`.** Misreading this is not academic: it was got wrong on
the first pass of this very investigation and reported as "no discount on Opus 5".

Settled by two independent anchors whose official prices are externally known:

- `gpt-5` → `pricing 1.25/10` = OpenAI's exact official rate; `ratio 0.8` ⇒ charged **$1/$8**
- `claude-opus-5` → `pricing 5/25` = Anthropic's exact official rate; `ratio 0.8` ⇒ charged **$4/$20**,
  which matches Comet's own published "-20%" table to the cent.

⚠️ **`ratio` is per-row and is NOT always 0.8** — 273 of 276 rows carry 0.8; three carry **1.0**
(`minimax-h3`, `seedance-2-5`, `seedream-5-0-pro-260628`, all newest-generation media). A hardcoded
0.8 would under-charge exactly the newest, most expensive models. The ratio must be read per row and
applied at capture time, never assumed globally.

⚠️ **Comet quotes NO cached-token rates for any model.** Per `spec/model-families.md`'s standing
rule this means: `claude` family **derives** 0.1× read / 2.0× 1h write off its own charged input rate
(unchanged, and the counters are genuinely returned); every other family gets `cacheProfile: 'none'`
and bills cached tokens at full input rate — never a discount we cannot verify.

### Charged rates for the models this spec ships

🔴 **Comet is roughly 2× KIE's price on every Claude model. This is the single largest cost of
the migration and it must not be buried under the comparison against Anthropic-direct.** KIE was not
discounting 20% — it was discounting **~60–72% off official**. Comet's uniform 20% is about a third
as deep.

| Model | Comet | KIE (baked) | vs KIE | Anthropic | vs Anthropic |
|---|---|---|---|---|---|
| claude-opus-5 | $4 / $20 | $2 / $10 | **+100%** | $5 / $25 | −20% |
| claude-sonnet-5 | $1.60 / $8 | $0.85 / $4.275 | **+88%** | $3 / $15 *(see OQ1)* | −47% |
| claude-fable-5 | $8 / $40 | $4 / $20 | **+100%** | — | — |
| ~~claude-haiku-4-5~~ | **NOT SERVED** | $0.275 / $1.425 | — | $1 / $5 | — |
| grok-4.5 | $1.60 / $4.80 | — | new | — | — |
| kimi-k3 | $2.40 / $12 | — | new | — | — |
| qwen3-coder | $0.24 / $0.96 | — | new | — | — |

**The cost ladder is: KIE (cheapest, broken) < Comet < Anthropic-direct (dearest, first-party).**
Comet is a ~2× cost increase against a working KIE and a ~20% saving against the Anthropic stopgap the
platform is actually running today. Both statements are true and only the pair is honest.

**Margin is unaffected; REACH is halved.** Credits are cost-proportional (`spec/billing.md`), so
`CREDIT_MARGIN` holds at any provider price — the platform's percentage is safe. What changes is what
a credit BUYS: at the same `CREDIT_MARGIN`, a pack funds roughly **half as many generations** on
Comet as on KIE. That is a §4.6 positioning consequence, not a billing bug, and it is the owner's
call — but it must be stated before cutover rather than discovered from the ledger.

⚠️ **Do not answer this by lowering `CREDIT_MARGIN`.** That trades the platform's margin for the
user's reach and hides a provider cost increase inside the pricing model, where nothing will ever
attribute it back. If reach must be preserved, the levers are the model ladder (Sonnet 5 at $1.60/$8
is the cheap volume rung) and the new `chat` family — `qwen3-coder` at **$0.24/$0.96** is a fortieth
of Opus 5 and an obvious candidate for the enhancer (`ENHANCE_PROMPT_MODEL`) and other fixed
utilities.

## Project Spec Alignment (from SPEC.md — REQUIRED)

- **§4.2a** — the Claude family keeps every piece of Anthropic hardening unchanged: `thinkingFetch`
  (`adaptive` + `display:'summarized'` + explicit `output_config.effort`), `stripSamplingParams`,
  `dropOrphanReasoningSignatures`. Comet is a native passthrough, so all three compose exactly as
  they do for the direct provider.
- **§4.2.8 / `spec/context-budget.md`** — all four cache breakpoints, the ordered-by-sharedness
  prefix, and the ≤4-breakpoint ceiling are untouched. Caching is the acceptance bar (AC1).
- **§4.6 / `spec/billing.md`** — prices come from the promoted Marketplace price list. Env price vars
  stay retired and refused. An unpriced LLM model bills at the most expensive row; an unpriced MEDIA
  model is refused outright.
- **§4.6.1a** — the tier ladder is unchanged (Standard/Premium — `platinum` joined it on 2026-08-10, after this bullet was written). Rungs are selectors that the active
  price list must price in their own right.
- **§4.16** — media debits precede all spend; refund-exactly-once; `'media'` may never go negative.
- **§5** — `COMET_API_KEY` is server-only, never `VITE_`-prefixed, never returned in a response body.
- **§2.1a** — additive: a new provider file plus a fourth family. No upstream restructure.

## Functional Requirements

**FR1 — one provider, four families, dispatched on model id.**
`app/lib/modules/llm/providers/cometapi.ts` mirrors `kie.ts`'s branch structure exactly, including
its FR3 guarantee: **Claude wrappers wrap the Claude branch only.** Applying `thinkingFetch` to a
chat-completions body puts an Anthropic `thinking` block in an OpenAI request — a hard 400 before a
token. The branch structure is what makes that impossible rather than merely unlikely, and it must be
pinned by a default-deny source scan (`cometapi-dispatch.spec.ts`) the way `kie-dispatch.spec.ts`
pins KIE's.

**FR2 — the family names a DIALECT; the PROVIDER chooses the wire.**
This is the one real architectural change. `gpt-5` is OpenAI-dialect on both providers but rides
Responses on KIE and chat-completions on Comet, so family alone can no longer imply an endpoint.
`model-families.ts` keeps deriving the family from the model id (its FR1 refusal for unknown ids is
unchanged and load-bearing); each provider maps family → wire. **Do not fix this by making the family
depend on the provider** — the three tier rungs may point at different families simultaneously while
the provider is one value per deploy, which is the reason the family comes from the id in the first
place.

**FR3 — a fourth family, `chat`.**
Prefixes: `grok-`, `kimi-`, `qwen`, `glm-`, `deepseek`, `minimax-`. Policy: `usageNamespace: 'openai'`,
`cacheProfile: 'none'` (nothing quoted), context/completion caps from the feed's `context_length` /
`max_completion_tokens`. `gpt-` stays on the existing `codex` family and is routed to chat-completions
by the Comet provider under FR2. Wire: `createOpenAI({...}).chat(model)`.

**FR4 — every shipped model id is live-probed.**
No id ships on the strength of the feed alone. The feed's `code` and `id` already disagree
(`grok-4.5` has `code: "grok-4-5"`), which is precisely the class of drift that shipped a 404 on KIE.

**FR5 — price list captured with the ratio applied.**
A new baked list (`baked-comet-prices.ts`) captured from `GET /api/models`, storing the **charged**
rate (`pricing × ratio`) with the official rate and ratio retained as provenance. The Admin panel's
"Fetch feed" gains a Comet variant; as with KIE it is **for the operator's eyes and never
machine-applied**.

**FR6 — media provider.**
A `CometMediaProvider` behind the existing `MediaProvider` seam: image via `/v1/images/generations`,
nano-banana via `:generateContent`, video via `/v1/videos` create+poll, transparency via the
per-model capability table from FR7. Prices from the same list; `lookupMediaPrice` keeps its
refuse-never-guess rule.

**FR7 — transparency is a per-model capability table, not a flag.**
`gpt-image-1.5` supports `background:"transparent"`; `gpt-image-1` and `gpt-image-2` refuse it. The
existing `transparent` boolean on the tool and the Background dropdown are unchanged — what changes is
that a transparent request resolves to a capable model and takes **one** stage. A transparent request
that cannot be served is **REFUSED, never downgraded to an opaque render** (that is the bug §4.16
already fixed once).

**FR8 — config.**
`PLATFORM_PROVIDERS` gains `'Comet'`; `COMET_API_KEY`; `COMET_BASE_URL` optional override;
`deliveryModeFor` gains a `Comet` row (`claude: 'streamed'` — **measured**, not assumed);
cache-warmer fanout defaults per provider and must be **measured before being set** (see AC6) —
**measured 2026-08-11 at 5 for Comet**, against KIE's 6 and Anthropic-direct's 1.

**FR9 — KIE is retained, not deleted.**
Hide-don't-delete. `LLM_PROVIDER` remains the switch; KIE stays selectable so a cutover is reversible
by config with no rebuild (§4.2a).

## Possible Edge Cases

- **`reasoning_content` is non-standard.** Grok and Kimi return reasoning on a `reasoning_content`
  field that `@ai-sdk/openai` does not map, so thinking text may be silently dropped for the `chat`
  family. Must be probed; if real, it needs a wire wrapper — and it must never be merged into the
  text channel, which feeds the artifact parser (§4.2a).
- **`cometapi-*` alias ids** (`cometapi-sonnet-5` etc., 21 of them) are Comet's own routing pool with
  unknown backing and unknown pricing. **Do not ship them** without separate probes.
- **The `-thinking` id suffix** (`claude-opus-5-thinking`) is a distinct id. Shipping both spellings
  risks two rows for one model disagreeing about price.
- **Pool warmup costs more than Anthropic-direct** — 3 writes vs 1. At the 2× write rate that is real
  money on short conversations.
- **Image size floors**: seedream refused 1024×1024 (`must be at least 3686400 pixels`). A size that
  works on one model is not portable.
- **Feed `official_pricing` is null on every text row** — only `pricing` + `ratio` are usable.
- **Video URLs are presigned S3 with expiry** — bytes must be fetched promptly, as today.

## Acceptance Criteria

1. **AC1 (blocking)** — a real platform generation on Comet reports `cache_read_input_tokens > 0`
   on its second turn, proving the four breakpoints survive. A regression here throws nothing and
   only makes the bill go up.
2. **AC2** — a first build turn streams progressively: >50 text deltas and <20% of characters in the
   final second, measured by `stream-probe.mjs`.
3. **AC3** — thinking text arrives non-empty with a signature on a real generation.
4. **AC4** — a tool-bearing generation completes (media tools + file tools) with no `strict` fault.
5. **AC5** — `generate_image`, a transparent `generate_image`, and `generate_video` each debit once,
   deliver real bytes into the sandbox, and refund exactly once on induced failure.
6. **AC6** — the cache hit pattern is re-measured over ≥30 requests **before** any warmer fanout is
   set. One 12-request sample is the exact sample size that produced a wrong verdict on KIE.
   - ✅ **MET 2026-08-11 (T11). `DEFAULT_COMET_FANOUT` = 5.** Comet warms PER BACKEND like KIE, not
     first-request like Anthropic direct. Three cold runs — 30 req `claude-sonnet-5` (writes at **1, 2,
     4**, then 26 consecutive hits), 20 req `claude-opus-4-8` (writes at **1, 2, 3, 4**, then 16
     consecutive hits) and T3's 12 req (writes at **1, 3, 5**) — plus a warm re-probe at **12/12 hits,
     zero writes**. Full per-request grids and the reasoning are in `_specs/cometapi-provider_plan.md`
     T11; raw probe output retained in `scratchpad/t11-artifacts/`. ⚠️ **27/30 and 16/20 are not hit
     RATES** — both are 100% after the warmup and 0% inside it; the distribution is the finding.
7. **AC7** — `pnpm typecheck && pnpm lint && pnpm test` green; the KIE and Anthropic paths are
   unchanged and still pass their existing specs (control).
8. **AC8** — every price row's charged rate equals `pricing × ratio` from the captured feed, asserted
   including at least one `ratio: 1` row.

## Open Questions

1. ✅ **CLOSED (T5, 2026-08-10) — our Anthropic `claude-sonnet-5` rate is CORRECT and deliberate.**
   The fear was that `rates.ts`'s **$3/$15** was stale against Comet's reported official **$2/$10**.
   It is the opposite: `rates.ts:86-89` already records that $2/$10 is Anthropic's **INTRODUCTORY**
   price, expiring **2026-08-31**, and that the platform bills the STANDARD $3/$15 on purpose —
   seeding the intro rate would compress margin below target the day it lapses, with nothing failing
   and the invoices simply getting bigger. Comet's feed reporting $2/$10 CONFIRMS that comment rather
   than contradicting it. **No change made; the row was not touched.** Note the two tables now
   legitimately disagree: `BAKED_COMET_PRICES` uses the $2/$10 input because that is what Comet
   actually charges us today, while `MODEL_RATES` uses $3/$15 because that is what Anthropic will.
   They price two different vendors, so agreement was never the goal.
2. ✅ **CLOSED (T6, 2026-08-10) — `fallbacks` is ACCEPTED AND SILENTLY DROPPED. Do NOT wire
   `refusalFallbackFetch` onto the Comet claude branch.** Three probes settle it, and the third is
   the one that proves it rather than merely failing to disprove it:
   - beta header + `fallbacks:[{model:'claude-opus-5'}]` on `claude-fable-5` → **200**
   - `fallbacks[]` with **no** beta header → **200**
   - `fallbacks[]` naming an **unlisted** target (`claude-sonnet-5`, not in fable-5's
     `allowed_fallback_models`) → **200**

   That last one is decisive. On Anthropic an unlisted fallback target is a hard **400 on every
   request** (`refusal-fallback.ts` says so explicitly). Getting a 200 means the field never reached
   anything that validates it — it is being dropped at the gateway, which is consistent with the
   Bedrock backing the beta-flag error revealed. Bedrock has no server-side-fallback feature.

   ⚠️ **A 200 here would otherwise read as "it works", and wiring the fetch on that reading is worse
   than leaving it off**: the platform would send a field that does nothing, and a Fable 5 refusal
   would surface as today's unexplained empty response while the code claims to handle it. Plan
   assumption 5 called this correctly in advance and stands; `cometapi.ts` ships without
   `refusalFallbackFetch` and without `tapStopReasons`, matching `kie.ts`. **The consequence to
   record: Fable 5 on Comet has NO refusal mitigation.**

   🔴 **AND THAT RISK IS NOW LIVE. This paragraph said "Fable 5 is not a shipped rung today
   (§4.6.1a Standard/Premium), so nothing regresses" — false since 2026-08-10**, when `platinum`
   shipped with `claude-fable-5` as its DEFAULT model, and doubly so since the 2026-08-11 cutover put
   the owner's deploy on `LLM_PROVIDER=Comet` with `PLATINUM_MODEL=claude-fable-5`. The sentence
   correctly identified the condition that would make this matter ("promoting it to a rung on Comet
   needs its own answer first") and the condition was met eight hours later by a different task, in
   the same document — §"PLATINUM / Fable 5 on Comet" above says so explicitly. **A premise written
   as a reassurance is the one nobody re-reads when the world changes under it.**

   **What is actually known:** three live Fable-5 EDIT turns on Comet drew zero refusals (§"PLATINUM /
   Fable 5 on Comet"). The failure that motivated `refusalFallbackFetch` on Anthropic was concentrated
   on the FIRST BUILD turn at ~190k context, and **that path has not been driven on Fable 5 on Comet**.
   So: a user-selectable rung, on a gateway that silently drops the fallback field, with the one path
   the mitigation was built for untested. Not a blocker — Platinum is opt-in and threshold-gated at
   2000 credits, and a refusal produces no text, so the turn FAILS and auto-refunds (§4.6) — but it is a
   known gap, not an absence of risk.

   ⚠️ **An earlier draft of this paragraph said "a refusal surfaces as `describeRefusal` copy rather
   than a charge". That is false on Comet, and it is the exact error this OQ warns about 15 lines
   above.** `describeRefusal` fires only when the wire tap SAW the refusal (`proxy.ts`), and
   `tapStopReasons` is wrapped in `anthropic.ts` alone — `cometapi.ts`'s own header says so. On this
   gateway a refusal arrives as the generic `EMPTY_RESPONSE_ERROR`: unattributable, indistinguishable
   from any other empty response. So the user is not charged, and nobody can tell WHY it failed.
   **Writing a reassurance is how a risk stops being tracked — check that the mechanism you are
   reassuring with is wired on the provider you are reassuring about.**
3. ✅ **CLOSED (T6) — `anthropic-beta` IS forwarded, and the gateway VALIDATES it.** A known beta
   (`interleaved-thinking-2025-05-14`) → 200; a bogus one (`not-a-real-beta-19990101`) → **hard 400**
   from AWS Bedrock (`ValidationException: invalid beta flag`). So passthrough is real but unforgiving:
   an unrecognised beta breaks every request before a token. **Probe any new beta header on Comet
   before shipping it.** This also revealed the backend — Comet fronts Claude via Bedrock, not
   Anthropic first-party, which is the mechanism behind OQ2's silent drop.
4. ⏳ **OPEN, and it CANNOT be closed from here — it needs Comet's own invoice (T13 monitoring).**
   The question is whether Comet BILLS the ratio-adjusted rate or merely advertises it. Nothing on our
   side can answer it: the platform prices from `pricing x ratio` at capture time, so our
   `raw_cost_usd` is what we BELIEVE the turn cost, and comparing our number to itself proves nothing.
   Only Comet's account statement against a known token vector settles it, which is why T13 lists it as
   a first-days check rather than a task.

   **What matters is the DIRECTION of being wrong, and it is the safe one.** If Comet silently charged
   full official rates, the platform would be UNDER-charging by ~20% — margin compressed, users
   unaffected, and visible as our recorded cost drifting below the invoice. The reverse (us charging
   more than Comet does) is not reachable: the ratio is read per row from Comet's own feed. Per
   `rates.ts`'s standing rule that every fallback errs in our disfavour rather than the user's, an open
   question with only that failure mode is not a cutover blocker.

5. ✅ **CLOSED (T7/T8) — answered BY CONSTRUCTION, so the question no longer needs an answer.**
   `MEDIA_PROVIDER` is an independent switch that falls back to `LLM_PROVIDER` when unset, and the
   provider is **stamped on the task record**, so an in-flight render is polled, downloaded and
   refunded by the gateway that created it. Media therefore moves when an operator moves it — same
   cutover or later, one variable, no code, and no orphaned money either way. The question was framed
   as a sequencing decision because at spec time it WAS one; building the seam dissolved it. ⚠️ Unset
   is not neutral: on an Anthropic deploy it honestly means *no media* (`getMediaProvider` returns
   `null` and the surface renders that third state) rather than silently indexing another gateway's
   catalogue.
6. ⏳ **PARTIALLY ANSWERED (T11) and honestly still open at production concurrency.** Three cold runs
   plus a warm re-probe — **62 sequential requests** — drew **zero** rejections, zero 429s and no
   latency cliff. That is real evidence and it is the wrong shape for the question: every probe was
   SEQUENTIAL, and the concern is CONCURRENT load. KIE's failure mode (soft-throttle by **queueing**,
   which no retry can see and no header reports) would be invisible to a sequential probe by
   construction, so "62 clean requests" cannot be read as "no throttling" — it is exactly the
   measured-the-wrong-axis error this spec's own cache-warmup entry warns about. Unchanged as a
   cutover risk; the cheap resolution is the first days of real traffic, not another probe.
7. ✅ **DECIDED 2026-08-11 (owner): CUT OVER TO COMET — option (a).** `LLM_PROVIDER=Comet`.

   **Rationale as decided, not as originally framed:** the question below asked whether a ~2× increase
   was acceptable, and T12's health measurement invalidated that premise — there is no working KIE
   Claude to pay 2× *against*. Against the Anthropic stopgap the platform was actually running, Comet
   is **~20% cheaper**, streams, and returns real thinking text. The decision is therefore a cost
   REDUCTION on today's bill, not a cost increase.

   **Recorded consequence, unchanged and still owed to §4.6 positioning:** reach still HALVES against
   the KIE the credit packs were priced around. That is a positioning fact, not a billing bug, and it
   must not be answered by lowering `CREDIT_MARGIN`.

   🔴 **KIE was dropped from the LADDER ORDER, not from the config.** `LLM_PROVIDER_CHAIN=Comet,Anthropic`.
   With `AUTO_MODEL_SELECT=true` the default chain leads with KIE, so leaving it first would spend one
   generation failing into the 5-minute cooldown every window — a measurable, recurring cost with a
   fully-measured cause. Anthropic stays as the fallback because it is the rung with the longest
   working record. KIE remains configured and one line away (FR9).

   Options (b) and (c) are NOT taken and remain available: (b) splitting Claude/utility across
   gateways, and (c) pushing `chat`-family models into the fixed utility paths — **(c) still carries
   its precondition**, the `api.enhancer.ts` cache-accounting gap (T12b), which is harmless on today's
   claude enhancer and a live over-charge on an inclusive family.

   *The original framing is kept below, because the measurement that invalidated it is the useful part.*

   🔴 **Owner decision required — but T12 MEASURED THE PREMISE AND IT NO LONGER HOLDS AS WRITTEN.**

   ⚠️ **The question below was framed as "is a ~2× cost increase acceptable to leave KIE?" That
   compares Comet against a WORKING KIE, and there is no working KIE to compare against.** Measured
   2026-08-11 (`pnpm kie-health`, 6 rounds × 14 models × thinking on/off):

   | KIE family | result |
   |---|---|
   | all ten `claude-*` | **92–100% failure** — `200-then-error: Server exception` |
   | `gpt-5-6-sol` / `-luna` / `-terra` | **0% failure** |
   | `gemini-3-5-flash` | **0% failure** |

   ⚠️ **A plain HTTP probe of KIE returns 200 in 0.25s**, because the failure arrives after the status
   line. Do not health-check this gateway with a status code; that reading is what makes the outage
   look intermittent.

   **So the real comparison is against what the platform is ACTUALLY running today — the Anthropic
   stopgap — and against that Comet is ~20% CHEAPER, not 2× dearer.** The 2× figure is against a
   counterfactual. Both numbers stay recorded in the pricing table above because the pair is the only
   honest statement, but the decision is no longer "pay 2× for reliability"; it is "pay ~80% of today's
   bill for a gateway that streams, returns real thinking text, and serves Claude at all".

   Options, restated against the measurement:
   - **(a) Cut over to Comet.** Cheaper than today. Reach still HALVES versus the KIE the platform was
     priced around, and that is a §4.6 positioning consequence to state before cutover, not discover.
   - **(b) Split — Claude on Comet, utility models on KIE.** No longer the "run two providers for no
     reason" option it was at spec time: KIE's gpt/gemini rungs are measurably perfect and materially
     cheaper. The cost is that every family rule must be correct on two gateways at once, and
     `AUTO_MODEL_SELECT` already implements the mechanism.
   - **(c) Push `chat`-family models into the fixed utility paths** (`ENHANCE_PROMPT_MODEL` —
     `qwen3-coder` at $0.24/$0.96 is a fortieth of Opus 5) to pull the blended rate down. **Precondition:
     close the `api.enhancer.ts` cache-accounting gap first (T12b) — that path hardcodes
     `cacheReadTokens: 0` and never reads `providerMetadata`, which is harmless on today's claude
     enhancer and becomes a live over-charge on an inclusive family.**

   ⚠️ **Do not answer any of these by lowering `CREDIT_MARGIN`** — it trades the platform's margin for
   the user's reach and buries a provider cost change inside the pricing model where nothing will ever
   attribute it back. The levers are the model ladder and the `chat` family.

   **Nothing technical resolves this. It gates T13, and T14's final clause.**

## Testing Guidelines

- `cometapi-dispatch.spec.ts` — default-deny source scan with **controls**, proving no Claude wrapper
  reaches another family, mirroring `kie-dispatch.spec.ts`.
- `model-families.spec.ts` — extend for the `chat` family; assert the unknown-id refusal still names
  every accepted prefix.
- `comet-prices.spec.ts` — charged = `pricing × ratio`, including a `ratio: 1` row; a mutation setting
  ratio to a constant 0.8 must fail.
- `media.spec.ts` — extend for the Comet provider: debit-before-spend, refund-exactly-once, and the
  transparency **refusal** path (a capable-model miss must refuse, never downgrade).
- Probe scripts stay the live instrument; they are already extended and committed.
- ⚠️ Money-path specs must `vi.stubEnv` `COMET_API_KEY` to `undefined` — `env()` falls back to
  `process.env` and `.env.local` now contains a real key, so an unscubbed spec resolves the
  developer's live credential and can spend real money (the `oauth.spec.ts` trap, fourth occurrence).

## Implementation sequencing (for bt-plan)

1. **T1** — `chat` family + provider-chooses-wire refactor (FR2/FR3), with dispatch scan + controls.
2. **T2** — `Comet` provider + wire modules; Claude branch first, byte-identical hardening.
3. **T3** — config: `PLATFORM_PROVIDERS`, key, delivery mode, `getPlatformProvider` routing.
4. **T4** — price capture + `baked-comet-prices.ts` + Admin feed variant (blocked on OQ1).
5. **T5** — live drive of a real build turn: AC1–AC4.
6. **T6** — media provider + transparency capability table: AC5.
7. **T7** — 30-request cache re-measure, then warmer fanout: AC6.
8. **T8** — probe the `chat` family's `reasoning_content` handling; wire wrapper if needed.
   ⚠️ Partial evidence already in hand (T5, 2026-08-10): a `qwen3-coder` probe on
   `/v1/chat/completions` returned a **`reasoning`** field on the message object. So the edge case is
   real on at least one vendor; the open question is the field NAME per vendor and whether
   `@ai-sdk/openai` drops it. It must never be merged into the text channel.
9. **T9** — cutover: flip `LLM_PROVIDER`, keep KIE selectable, monitor `cacheCreationTokens`.
