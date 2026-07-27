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
| Claude Sonnet 5 | `claude-sonnet-5` | 1_000_000 | 128_000 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200_000 | **64_000** |
| Claude Opus 4.8 | `claude-opus-4-8` | 1_000_000 | 128_000 |
| Claude Opus 5 (default since 2026-07-27) | `claude-opus-5` | 1_000_000 | 128_000 |
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
| `app/utils/constants.ts` | ✅ | `DEFAULT_MODEL = 'claude-opus-5'` (since 2026-07-27; same KIE price as its predecessor `claude-opus-4-8`, which superseded `claude-sonnet-5`, and originally the retired `claude-3-5-sonnet-latest`, which matched no `staticModels` entry) — the strongest coding model, this being a game-coding product |
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

## 3. The four failures (in the order you will hit them)

Each looks like a config mistake and is not. All four live **between our code and the wire**, which
is why call-site fixes bounce off them.

⚠️ **The fourth (§3.3a) was found nine months after the other three, in production-shaped local use, and
it had broken every edit turn the whole time.** The first three all fire on turn ONE, so any smoke test
catches them. §3.3a fires only on turn TWO — and nothing had ever run a second turn. When you add a
verification step to §4, ask what turn it exercises.

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

### 3.3a `messages.2.content.0.thinking.signature: Field required` — the same coin, other face

**Found live 2026-07-16. It had broken EVERY edit turn, on EVERY project, since thinking was enabled.**

§3.3 is signatures coming **in**. This is signatures going back **out**, and it is the more expensive
half:

```
Custom error: messages.2.content.0.thinking.signature: Field required
```

0 in, 0 out, ~0.3s, `finish=error` — the API refuses the request before generating a single token.
Anthropic requires that any `thinking` block you send back in history carry the opaque `signature` it
issued with it. Ours never had one, because the signature never survives our own pipeline:

```ts
// app/lib/.server/agent/proxy.ts
export type AgentChunk = { type: 'text'; value: string } | { type: 'reasoning'; value: string };
//                                                          ^ no signature field ANYWHERE
```

`dropOrphanReasoningSignatures` correctly passes legitimate signatures through to the AI SDK — and
then our proxy re-emits reasoning to the client as plain **text** on its own channel. The client saves
it, posts it back next turn, `convertToCoreMessages` rebuilds a `thinking` block with no signature, and
Anthropic rejects it. **Creations worked (no history). Everything after turn one did not.**

**Fix: STRIP prior-turn thinking in `compactHistory` (`llm/history.ts`), do not forward the signature.**
Anthropic only requires thinking to be preserved *within* a turn (across tool results), which
`streamText` handles internally because our whole tool loop lives in one call. Previous turns' thinking
may simply be omitted — and omitting is also the cheaper half: the history is UNCACHED and re-sent in
full every turn, and a real creation emits ~15k chars of reasoning summary
(`spec/context-budget.md` §"MEASURED").

⚠️ **Do NOT "fix" this by adding a signature to `AgentChunk` and threading it to the client.** That
restores correctness while paying, forever, to re-send reasoning the model does not need — and the 400
returns the instant any path in that chain drops the field. Pinned by `history.spec.ts`.

**Why it survived 704 tests, a full spec, and nine live creations: nothing had ever exercised turn
two.** Every measurement, every eval, every manual check pointed at the first turn. §4 below says
verification "is not optional" — it was, and this is what it cost.

### 3.4 We were paying for reasoning and throwing it away

The most expensive of the four, and the only one that throws nothing, breaks nothing, and surfaces as
a **product** complaint rather than an error.

On Sonnet 5 and the whole 4.6+ family, **omitting the `thinking` parameter does not mean "off" — it
means adaptive thinking ON**, and `thinking.display` then defaults to `"omitted"`. So the model
reasoned at length, we were billed for every one of those tokens at the full output rate, and the API
returned a thinking block whose text was **empty**. Ninety seconds in which the client received
*nothing* — not text, not even response headers. That is what the owner reported as the app "just
sitting there... no status of what it is doing". It was not a hang and not a dev-mode artifact: it was
the model thinking in the dark.

**The wrong fix is to stop thinking.** Disabling it does make the app feel fast (measured: 152s → 72s,
$0.293 → $0.200, first byte 90.5s → 1.6s), and that is a real lever worth keeping — but a game build
is exactly the multi-step work adaptive thinking exists for, and buying a progress bar with
intelligence is a bad trade.

**The right fix is `display: 'summarized'`.** It costs **nothing** — thinking is billed identically
under every display setting — and it turns the tokens we were already buying into a stream we can put
on screen. Measured, same creation:

| | first byte to the client | wall clock | output tokens | cost |
|---|---|---|---|---|
| adaptive + `omitted` (the accidental default) | **90.5s of dead air** | 152s | 16,619 | $0.293 |
| adaptive + `summarized` (now the default) | **3.9s — reasoning starts streaming** | 105s | 12,209 | $0.227 |
| `disabled` (opt-in speed lever) | 1.6s | 72s | 10,403 | $0.200 |

The user now watches the model plan their game from ~4 seconds in, and the artifact follows.

**And `providerOptions` cannot express any of this.** `@ai-sdk/anthropic@1.2.12` predates adaptive
thinking: it hardcodes the LEGACY `thinking: {type: 'enabled', budget_tokens: N}` shape and *throws*
if you omit the budget — while `budget_tokens` is exactly what current models reject with a 400. So no
value of `providerOptions` yields `{type: 'adaptive'}` or `{type: 'disabled'}`, and the
`LanguageModelV1` wrappers above cannot help either: they see the SDK's call options, not the JSON
body. The body is assembled inside the provider and handed straight to `fetch`.

**Fix:** `thinkingFetch(mode, effort, modelId)` — a `fetch` wrapper that sets `thinking` (and the
`effort`, §3.5, which likewise cannot go through `providerOptions`) on the serialized body. It is the
only layer that can. Guarded per-model: models without adaptive thinking are left
untouched, and Fable 5 is never sent `{type: 'disabled'}` (it thinks unconditionally; an explicit
disable is a 400).

**Config, never hardcoded:** `THINKING_MODE=adaptive|disabled`, defaulting to `adaptive`.

**Reasoning is a SEPARATE CHANNEL, never merged into text.** The client feeds `text` straight into the
artifact parser, so a sentence of reasoning leaking into a `<boltAction>` would be written into the
user's file. It rides the AI SDK's own reasoning part (`g:`), which `useChat` collects onto
`message.reasoning`; `ThinkingPanel` renders it. It also does **not** count as "the model produced
output" — a generation that only ever thought and never wrote an artifact is still a failed generation
and must still refund (§4.6).

**Flipping the mode invalidates the prompt cache once** (a ~142k-token write at 2×, one generation),
then steady state resumes. Do not mistake that one-off for a regression.

### 3.4a The provider can take the reasoning stream away — the liveness heartbeat (2026-07-24)

§3.4's fix assumes the provider actually RETURNS the summarized thinking text. KIE's Claude adapter
stopped doing that: measured 2026-07-24, **every model tested returns thinking blocks with EMPTY
text while still billing the thinking tokens** — claude-fable-5 went from 224 chars (2026-07-17
trial) to 0 even on a forced 2,980-token think, and claude-opus-4-7/4-8 are 0. A control run of the
identical body against `api.anthropic.com` streamed 209 chars of summarized thinking live during the
think, pinning the fault on KIE's adapter (full table: `kie-wire.ts`; send-ready report:
`KIE_BUG_REPORT.md`). On KIE's wire the silence is total — `message_start` at ~2s, then nothing but
a ping until the empty thinking block and the first text arrive together at the END of the think —
so a creation-sized think was minutes of dead dots, indistinguishable from a hang, while credits
were genuinely spent. That is §3.4's product complaint back again, with the fix intact and the
provider quietly defeating it.

**The mitigation must not depend on the provider: `agent/heartbeat.ts` + `stores/agent-status.ts` +
`StreamingStatus.tsx`.** While the model stream is silent (quiet ≥2.5s, checked every 3s), the proxy
— which holds the open SSE response the whole time — writes an `agent-status` DATA part (phase
`thinking`/`generating`, server-clock `elapsedMs`, monotonic `seq`); the client renders a ticking
"Thinking — 1m 12s" panel in place of the dots. Invariants, each a silent failure if regressed:

- **It is a liveness signal, never a thinking channel.** It rides the data stream (like
  `media-task`), never `text` (artifact parser) or `reasoning` (`g:`), never the model's context
  (zero tokens, zero cache impact). It never fabricates or paraphrases reasoning.
- **Real content wins automatically.** Any non-empty chunk — including real thinking text, the day
  KIE fixes their adapter — resets the quiet clock, the heartbeats stop, and the client's freshness
  window (`STATUS_STALE_MS`) expires the panel back to the ordinary indicator. No code change is
  needed on either side when the reasoning stream returns.
- **Empty deltas are not activity.** KIE streams thinking deltas whose text is `""`; counting those
  as activity would suppress the heartbeat during the exact silence it exists to cover.
- **The client gates replay on `(generationId, seq)`.** `useChat` re-presents the whole data array
  on every chunk; re-ingesting an old heartbeat refreshes its arrival time and a stale "Thinking —
  5s" panel would sit on top of the streaming answer forever.
- **A throwing status write is swallowed** — the narration channel must never break the generation
  it narrates (same rule as monitoring).

Pinned by `heartbeat.spec.ts` (server: emission timing, phase transitions, pass-through
byte-identity, stop-on-end/throw) and `agent-status.spec.ts` (client: replay gate, freshness expiry,
display copy).

### 3.5 `effort` — the default nobody chose

Thinking tokens are billed as **output** tokens, at the full output rate. So "how long does it think"
is not a UX question, it is the single biggest line on the bill — and it has exactly one control:
`output_config.effort` (GA, no beta header; `low` | `medium` | `high` | `xhigh` | `max`).

**The API default is `high`.** Omitting the field — which is what we did — is therefore not "no
opinion". It is silently buying the second-most-expensive setting on every generation. That is how one
creation came to spend ~15,000 thinking tokens to emit ~5,500 tokens of landing page: nobody chose
that, and nobody could see it. (`budget_tokens` is NOT the alternative — it is a hard 400 on current
models. `effort` replaced it.)

Swept on an identical creation — same prompt, same files:

| effort | wall clock | output tokens | cost | credits |
|---|---|---|---|---|
| `high` (the accidental default) | 103s | 12,567 | $0.232 | 78 |
| **`medium`** (the default, and the FLOOR) | **80s** | **10,433** | **$0.200** | **67** |
| ~~`low`~~ (removed — see §3.5a) | 58s | 7,461 | $0.156 | 52 |

All three produced a full-size landing page that passed every play-contract, bundle-integrity and
no-attribution check. On a **creation** turn the deliberation shrank and the deliverable did not — which
is exactly what made `low` look like free money. It was not. See §3.5a.

`medium` is the default: a third off the bill and a third off the clock, and Anthropic's own guidance
puts Sonnet 5 at `medium` on par with Sonnet 4.6 at `high`.

**Config, never hardcoded:** `THINKING_EFFORT=medium|high|xhigh|max` (`DEFAULT_EFFORT` in
`capabilities.ts`). Raise it for hard work. There is nothing below `medium` to drop to.

### 3.4b The last-resort retry runs THINKING-OFF — the silence is the failure (2026-07-27)

Measured against KIE: **every step that emitted no bytes for ~30s was killed** with `Internal error, please
try again later` (28,956ms / 31,532ms / 30,058ms, all zero-output), while every step that emitted anything
ran for minutes. An extended think IS that silence — their adapter forwards thinking text on only ~14% of
requests (3/21 opus-4-8, 1/7 opus-5: identical rates, so it tracks the BACKEND, not the model), so on the
other 86% a long think puts nothing on the wire and their own gateway times out the request they are
buffering.

Retrying is a dice roll against the same window. The final attempt therefore sends
`thinking: {type: 'disabled'}` (`retryThinkingMode`, `getModelInstance({ thinkingMode })`): text starts
within ~1s, the stream is never quiet, and the timeout cannot fire.

| Attempt | Thinking | Why |
|---|---|---|
| 1 | adaptive | normal quality |
| 2 | adaptive | likely a different backend; often just works |
| 3 (last) | **disabled** | guaranteed early bytes — cannot hit the silent-stream timeout |

**Scoped to the last attempt deliberately.** The tempting generalisation — "if the stream goes quiet, drop
thinking" — would sacrifice the reasoning text on exactly the long thinks whose reasoning is worth reading,
on every generation. Here attempts 1–2 are byte-identical to a build with no retry logic, and the only turn
that loses thinking is one the silent think had already killed twice: you cannot lose reasoning on a turn
that was about to die. The trade on that attempt is real (no extended thinking is a weaker build — §3.5a)
and still better than a red error card and no game.

⚠️ **Clamp with `canDisableThinking(model, effort)`.** Fable 5 rejects `{type:'disabled'}` outright and
Opus 5 rejects it above `high`; an unclamped override swaps a timeout for a hard 400 on the attempt that
had already failed twice. Pinned at the wire in `anthropic.spec.ts` (serialized body, both directions).

### 3.5a `low` is REMOVED — it is a correctness bug, not a discount

The creation sweep above says `low` is 22% cheaper and just as good. That conclusion **does not
survive contact with an edit turn**, and edit turns are most of a session.

Measured on a substantial edit ("add a boost mechanic to the kart racer") against a real project:

| effort | credits | what it actually did |
|---|---|---|
| `low` | 67 | edited **`src/routing/router.tsx`** — READ-ONLY SHELL (§4.4c) — and rewrote whole files instead of patching them |
| `medium` | 125 | created `src/scripts/BoostController.ts` in the correct zone and patched the rest; **5/5** search-replace blocks matched exactly once |

`low` was not a cheaper tier. It was a **wrong** one: it bought a 58-credit saving with a never-violate
zone breach, and it discarded the diff-edit protocol that makes follow-up turns cheap in the first
place. A model that under-thinks does not produce a smaller correct answer — it produces a confident
wrong one, and the file zones are exactly the kind of constraint it drops first.

So `low` is **not in the `EffortLevel` union at all**. It is unrepresentable in the type system, which
means no config value, no policy branch, and no future "let's shave a bit here" refactor can reach it
without deliberately deleting the comment that says why. Because `.env.local` is a string file and a
cast cannot stop an operator, `parseEffort()` clamps a literal `THINKING_EFFORT=low` back up to
`medium` with a warning, and rejects typos rather than putting a 400 on the wire mid-generation.

### 3.6 Per-turn effort — escalate on evidence, never guess from prose

Effort is chosen per turn by `effortForTurn()` (`app/lib/.server/agent/effort-policy.ts`).

> **All three escalation rows now fire (2026-07-14).** They previously could not: the repair rows key
> off `repairAttempt` / `errors`, which the server accepted and the proxy honoured, but **no client code
> ever sent them** — so effort was a constant in practice and this table described a policy that never
> ran. The client half is now built (`app/lib/runtime/auto-repair.ts`; SPEC §4.2 item 7): a Vite compile
> error arriving within 8s of a generation finishing re-POSTs with `repairOf` + `repairAttempt`, which
> is exactly the signal this policy reads.

**It decides by turn KIND, never by reading the user's prompt.** A prose classifier ("does this sound
hard?") is wrong in both directions, impossible to debug when a bill doubles, and puts a language model
in charge of spend. Every signal below is one the proxy already computes deterministically, for free,
before a single token is bought.

| Turn | Signal (already in the proxy) | Effort |
|---|---|---|
| Repair, attempt 2 (the last one it gets) | `repairAttempt >= 2` | `xhigh` |
| Repair, attempt 1 | `errors.length > 0` | `high` |
| `/slash` skill invocation (`/bt-spec`, `/bt-prototype`) | `slash` resolved | `high` |
| Creation and ordinary edits | — | operator default (`medium`) |

Precedence: **policy > `THINKING_EFFORT` > `medium`**. The policy overriding operator config is
deliberate — a build that has already failed twice is not the place to economise, and repairs are
capped (`MAX_REPAIR_TURNS = 2`), so the escalated spend is bounded and rare.

### 3.6a The user's floor — `/effort`, and why it stops at `high` (2026-07-27)

`effortForTurn` takes one more input: `baseEffort`, the level the USER chose for their session with
`/effort` (SPEC §4.2.9). It is a **floor**, folded in by rank:

| Turn | `medium` session | `high` session |
|---|---|---|
| Creation / ordinary edit | `medium` | `high` |
| `/slash` skill invocation | `high` | `high` |
| Repair, attempt 1 | `high` | `high` |
| Repair, attempt 2 | `xhigh` | `xhigh` |

Three properties, each of which fails silently if dropped:

1. **It never caps.** A `high` session's second repair still gets `xhigh`. Taking the floor there instead
   would mean choosing `high` makes hard failures think *less* than the default session does — backwards,
   and invisible.
2. **Only `medium` and `high` are offerable.** `xhigh`/`max` are what the ladder spends on *evidence*; as a
   session default they turn an escalation ceiling into a floor, so every ordinary edit would start where a
   twice-failed build ends. `parseUserEffort` enforces this at the boundary — the value arrives in a
   **browser body**, on the platform's credit pool, and a tampered client asking for `max` on every turn
   must cost nothing. Unlike `parseEffort` (which clamps an operator's `low` *up* to `medium`), it never
   clamps: an unrecognised value is "no choice", i.e. the operator default.
3. **It is not persisted.** It resets to `medium` on every reload. A raised floor bills more on every
   subsequent turn while producing no visible signal, so persisting it means a user raises it once for one
   hard problem and quietly pays more for months. Session-scoped, the expensive state cannot outlive its
   reason.

This is still not a prose classifier (§3.6): the user is choosing a visible, up-front session floor, not
having their wording read to guess how hard the turn is.

`xhigh` is the ceiling; `max` exists in the union but nothing selects it. **The policy only ever
escalates.** Its value is not paying less on easy turns (there is no cheap tier — §3.5a) but paying
more on the turns that have already *demonstrated* they need it: without this, a repair turn thinks
exactly as hard as the turn that just failed, which is backwards.

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

**⚠️ EXERCISE TURN TWO. This section did not, and that is exactly what §3.3a cost.**

Every check above fires a single request and inspects it. §3.3a cannot fail a single request — it
fails only when a previous assistant turn is sent BACK, so a suite that only ever asks "is the request
we build correct?" is structurally blind to it. It shipped past 704 tests and nine live creations.

The rule, and it generalises past Anthropic: **a conversation is a state machine, and turn one is one
state.** Anything that only round-trips on a later turn — thinking signatures, tool results, history
compaction, cache reuse of a prior prefix — is untested until a test (or a human) sends turn two.
`history.spec.ts` now covers the reasoning strip; the live check is: create a project, then EDIT it.

```bash
pnpm test                       # 704 passing
npx vitest --run app/lib/modules/llm/providers/anthropic.spec.ts
npx vitest --run app/lib/.server/llm/history.spec.ts   # §3.3a — turn two
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
- **Fix one layer at a time and you will chase this for hours.** The original three (§3.1–§3.3) were all
  live simultaneously; each fix only exposed the next. Read the whole request path — call site → `ai` →
  `@ai-sdk/anthropic` → wire — before changing anything.
- **A tidy explanation is not a diagnosis.** §3.3a presented as "edit turns fail", and a client-side
  `ReferenceError` from an unrelated stale module was live in the same window. That was a coherent story
  covering every symptom, and it was wrong — the bug reproduced in a clean tab. What settled it was
  reading the actual wire frame (`3:"Custom error: …"`), not reasoning about causes. **When the request
  path is the suspect, look at the request.**

---

## 6. Still outstanding

**Amazon Bedrock** (`app/lib/modules/llm/providers/amazon-bedrock.ts`) has the same retired models
(Sonnet 3.5, Haiku 3) and has not been touched. It is a real migration, not a find-and-replace: its
entries use legacy ARN-versioned IDs (`anthropic.claude-3-5-sonnet-20241022-v2:0`) from Bedrock's old
`InvokeModel` integration, whereas current Bedrock IDs are prefixed-bare (`anthropic.claude-sonnet-5`)
and use a different client and request shape. Decide which integration you're on first.

Note `supportsSamplingParams()` already tolerates the `anthropic.` prefix, so the §3.1 fix will cover
Bedrock once its models are current.
