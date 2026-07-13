# Anthropic Model Support — Rebuild Guide

How to wire current Claude models into this bolt.diy fork, and the three non-obvious
failures you WILL hit if you only swap the model ID strings.

**Context:** upstream bolt.diy ships an Anthropic provider whose models are all retired and
whose plumbing predates adaptive thinking. Getting a current model working is four changes,
not one. Written 2026-07-12 against `ai@4.3.16`.

> **If you are rebuilding from scratch, read §3 first.** The model IDs (§1) are the easy part.
> §3 is the part that costs a day if you rediscover it by trial and error.

---

## 1. Model IDs and limits

Current-generation IDs are **complete as written**. Do NOT append a date (`-20251114`) or a
`-latest` suffix — those belong to the old dated-snapshot scheme and now 404. `-latest` still
exists for *skill* versions; that is unrelated.

| Model | ID | Context (`maxTokenAllowed`) | Output (`maxCompletionTokens`) |
|---|---|---|---|
| Claude Sonnet 5 (default) | `claude-sonnet-5` | 1_000_000 | 128_000 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200_000 | **64_000** |
| Claude Opus 4.8 | `claude-opus-4-8` | 1_000_000 | 128_000 |
| Claude Fable 5 | `claude-fable-5` | 1_000_000 | 128_000 |

⚠️ **Haiku is the exception**: 200k context and a **64k** output cap, not 128k. Copying another
row's numbers over Haiku asks for more output than the model allows, which is a hard 400.

Everything upstream shipped (`claude-3-5-sonnet-20241022`, `claude-3-haiku-20240307`,
`claude-opus-4-20250514`) is retired and 404s. Delete, don't keep "as fallbacks."

---

## 2. Every file that changed

The complete change set (verified against `git diff`). Four are required; the rest are
documentation, tests, or defense-in-depth.

| File | Req? | Change |
|---|---|---|
| `app/lib/modules/llm/providers/anthropic.ts` | ✅ | `staticModels` (table above); fix `getDynamicModels`; compose both wrappers in `getModelInstance`; drop the obsolete `output-128k-2025-02-19` beta header |
| `app/lib/modules/llm/capabilities.ts` | ✅ | **new** — `supportsSamplingParams`, `stripSamplingParams`, `dropOrphanReasoningSignatures` |
| `app/utils/constants.ts` | ✅ | `DEFAULT_MODEL = 'claude-sonnet-5'` (was `claude-3-5-sonnet-latest`, which is retired **and** matched no entry in `staticModels`) |
| `package.json` + `pnpm-lock.yaml` | ✅ | `@ai-sdk/anthropic` `0.0.39` → `^1.2.12` (§3.2) |
| `app/lib/modules/llm/providers/anthropic.spec.ts` | — | **new** — regression tests for §3.1 and §3.3. Not required to run, required to trust (§4) |
| `app/routes/api.llmcall.ts` | ⚪️ | Gates `temperature` behind `supportsSamplingParams()`. **Redundant** — the provider-level strip already covers every call path. Kept as defense in depth; safe to skip on a rebuild |
| `app/lib/.server/llm/constants.ts` | ⚪️ | **Comments only** — `PROVIDER_COMPLETION_LIMITS.Anthropic` stays `64000`. The comment now says it is a *floor*, not a ceiling, so nobody "helpfully" raises it to 128k (see below) |

`capabilities.ts` must live **outside `~/lib/.server/**`**. The provider registry is imported by
client code (model pickers), so a provider importing a `.server` module breaks the client bundle.
That is why the sampling check lives there rather than next to `isReasoningModel`.

### `getDynamicModels` — read the right fields

The Models API returns **two different** numbers. Upstream conflated them:

```ts
// The API gives you both — do not guess, and do not swap them.
const contextWindow: number = m.max_input_tokens ?? 200000;   // context window
const maxCompletionTokens: number = m.max_tokens ?? 8192;     // OUTPUT cap
```

Upstream assigned `m.max_tokens` (the output cap) to the context window, under-reporting context
by ~8x, and then guessed output caps with substring matches (`includes('claude-opus-4')` → 32k,
which also matches `claude-opus-4-6/-7/-8`, all of which do 128k). Both `if/else` ladders are
deletable — the API is self-describing.

Fallbacks are deliberately asymmetric: **undershooting output truncates; overshooting is a 400.**
Same reason `PROVIDER_COMPLETION_LIMITS.Anthropic` in `app/lib/.server/llm/constants.ts` must be
`64000` (the *floor* across the lineup — Haiku), never `128000`. That constant is only consulted
when a model's real cap is unknown, i.e. exactly when you want to be pessimistic.

### `getModelInstance` — compose both wrappers

```ts
const anthropic = createAnthropic({ apiKey }); // no `output-128k-2025-02-19` header — GA on Claude 4+
const instance = supportsSamplingParams(model) ? anthropic(model) : stripSamplingParams(anthropic(model));

return dropOrphanReasoningSignatures(instance); // ALL Claude models, see §3.2
```

---

## 3. The three failures (in the order you will hit them)

Each looks like a config mistake and is not. All three live **between our code and the wire**, which
is why call-site fixes bounce off them.

### 3.1 `temperature is deprecated for this model`

Sonnet 5, Opus 4.8, Opus 4.7, and Fable 5 **removed** the sampling params. Sending `temperature`,
`top_p`, or `top_k` is a **400 — not ignored**.

**The trap:** you cannot fix this at the call site. `ai@4.3.16` *injects* the parameter:

```js
// node_modules/ai/dist/index.mjs
// TODO v5 remove default 0 for temperature
temperature: temperature != null ? temperature : 0,
```

Supply no temperature and the SDK sends `0`. Pass `undefined` and it **still** sends `0`
(`undefined != null` is false). The only reliable removal point is the `LanguageModelV1` boundary —
after the SDK builds call options, before the provider serializes the body. Hence
`stripSamplingParams()`, a Proxy over `doGenerate`/`doStream`.

Older models (Haiku 4.5, Opus 4.6, Sonnet 4.6) still accept sampling params, so the strip is gated
on `supportsSamplingParams()`. Upgrading to `ai@5` should make this wrapper unnecessary — verify
against the spec before deleting it.

### 3.2 `Type validation failed ... Expected 'text' | 'tool_use'`

Sonnet 5 runs **adaptive thinking by default** — unlike Opus 4.8/4.7, omitting the `thinking` field
does NOT disable it. So its streams always contain `thinking` content blocks. On Fable 5 thinking
**cannot be disabled at all** (`{type:"disabled"}` → 400).

Upstream pins `@ai-sdk/anthropic@0.0.39`, which predates thinking entirely (zero mentions in its
dist) and whose schema only knows `text | tool_use`.

**Fix:** upgrade to `@ai-sdk/anthropic@^1.2.12` — the newest release on the `ai@4` line (2.x+
requires `ai@5`). Note it was the ONLY provider left on a `0.0.x` release; the rest were already 1.x.

**Use pnpm.** `npm install` dies on this lockfile (`Cannot read properties of null (reading 'matches')`).

### 3.3 `InvalidStreamPart: reasoning-signature without reasoning`

The subtle one. Current Claude models default `thinking.display` to `"omitted"`: the thinking block
is present but its text is an **empty string**. Look closely at the §3.2 error payload — it was
there all along:

```json
{"type":"thinking","thinking":"","signature":""}
```

So the wire carries a thinking block and a signature with **no thinking text between them**, and the
two libraries disagree about what that means:

- `@ai-sdk/anthropic` emits `reasoning` only on a `thinking_delta`, but emits `reasoning-signature`
  **unconditionally** on a `signature_delta`.
- `ai@4` requires every `reasoning-signature` to be preceded by a `reasoning` part (which it
  consumes) and throws otherwise.

An empty thinking block yields a signature with no reasoning — the exact contradiction. This is a
genuine incompatibility between two libraries that predate adaptive thinking.

**Fix:** `dropOrphanReasoningSignatures()` wraps `doStream` and mirrors ai's own state machine —
`reasoning` arms the signature, `reasoning-signature` consumes it, an unarmed signature is dropped.
Real reasoning and its legitimate signature pass through untouched.

Apply it to **every** Claude model (any thinking-capable model can emit an empty thinking block), and
note it cannot be avoided by disabling thinking, because Fable 5 won't let you.

---

## 4. Verification — do this, it is not optional

These bugs are invisible to typecheck and to any test that asserts on our own intermediate objects.
The suite in `app/lib/modules/llm/providers/anthropic.spec.ts` therefore:

- asserts on the **actual serialized request body** (stub `fetch`, parse `init.body`) — §3.1
- drives the **real `ai.streamText` pipeline** with a replayed SSE stream — §3.2/§3.3

**Replay the real stream shape.** An empty thinking block with a `signature_delta` and **no**
`thinking_delta` is what production sends. I first wrote this test with an invented `thinking_delta`
carrying text; it passed against a stream that does not exist and the bug shipped.

**Prove the test fails without the fix.** Bypass the wrapper (`return model;`), run the spec, and
confirm you see the production error verbatim. Then restore. A green test you never watched fail is
not evidence.

```bash
pnpm test                       # 63 passing
npx vitest --run app/lib/modules/llm/providers/anthropic.spec.ts
```

**Circular import:** the spec imports `capabilities` + the ai-sdk directly rather than
`AnthropicProvider`, because `base-provider → manager → registry → providers → base-provider` is a
cycle that the bundler tolerates and vitest does not. Pre-existing; don't restructure it for a test.

---

## 5. Gotchas that cost real time

- **`rg` skips hidden dirs.** `app/lib/.server/` starts with a dot, so a plain `rg temperature app/`
  silently misses the entire server tree, including `stream-text.ts`. **Always `rg --hidden`.** I
  concluded "only one file sets temperature" off a search that never looked at the LLM server code.
- **pnpm, not npm** (see §3.2).
- **Fix one layer at a time and you will chase this for hours.** All three failures were live
  simultaneously; each fix only exposed the next. Read the whole request path — call site → `ai` →
  `@ai-sdk/anthropic` → wire — before changing anything.

---

## 6. Still outstanding

**Amazon Bedrock** (`app/lib/modules/llm/providers/amazon-bedrock.ts`) has the same retired models
(Sonnet 3.5, Haiku 3) and has not been touched. It is a real migration, not a find-and-replace: its
entries use legacy ARN-versioned IDs (`anthropic.claude-3-5-sonnet-20241022-v2:0`) from Bedrock's old
`InvokeModel` integration, whereas current Bedrock IDs are prefixed-bare (`anthropic.claude-sonnet-5`)
and use a different client and request shape. Decide which integration you're on first.

Note `supportsSamplingParams()` already tolerates the `anthropic.` prefix, so the §3.1 fix will cover
Bedrock once its models are current.
