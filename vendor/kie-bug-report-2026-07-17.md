<!--
STATUS: drafted 2026-07-17, NOT yet filed with KIE.
How to file: Discord/Telegram 1-on-1 via https://kie.ai/vip-support (support hours UTC 21:00–17:00),
             or email support@kie.ai (slower). Attach request IDs from https://kie.ai/logs.
Check for a fix afterwards at https://kie.ai/changelog and https://kie.ai/api-updates.
Context: these are provider-side quirks; our streaming pipeline is fine (Opus 4.8 answer streams as the
control). We stay on the premium model as-is ("hard thinking text") until KIE responds. See the "Fable 5
streaming" finding in the session notes.
-->

# KIE.ai — two Claude adapter bugs (Opus 4.8 empty thinking, Fable 5 answer-text buffering)

**Endpoint:** `POST https://api.kie.ai/claude/v1/messages` (Anthropic-native Messages API, `Authorization: Bearer <key>`)
**Client:** Vercel AI SDK + `@ai-sdk/anthropic` pointed at the KIE base URL, `stream: true` (SSE).
**Request shape:** standard Anthropic Messages body **plus** `thinkingFlag: true` (your project-specific flag) and `thinking` / `output_config` for adaptive thinking with `display: "summarized"`.
**Date measured:** 2026-07-17. All figures are from live streaming runs, 3 trials each unless noted.

We run two Claude models through your adapter and hit one distinct bug on each. Both are streaming/thinking-adapter issues; neither is a prompt or client problem (same client, same request builder, only the `model` field differs).

---

## Bug 1 — `claude-opus-4-8` returns EMPTY thinking text (every other model returns it)

With `thinkingFlag: true` set, every Claude model we tested streams non-empty thinking text **except `claude-opus-4-8`, which returns thinking blocks whose text is empty (0 characters) on every trial.** The tokens still appear to be spent; only the text is missing — i.e. we pay the reasoning cost but the reasoning summary never arrives, so a thinking/reasoning UI stays blank.

Measured thinking-text characters, `thinkingFlag` ON vs OFF (3 streaming trials each):

| model             | flag ON            | flag OFF |
|-------------------|--------------------|----------|
| claude-opus-4-6   | 196, 196, 196 ✅   | 0, 0, 0  |
| claude-opus-4-5   | 410, 405, 642 ✅   | 0, 0, 0  |
| claude-sonnet-4-5 | 211, 215, 230 ✅   | 0, 0, 0  |
| claude-fable-5    | 224, 223, (1 err) ⚠️ | 0, 0, 0 |
| **claude-opus-4-8** | **0, 0, 0 ❌**   | 0, 0, 0  |

**Expected:** `claude-opus-4-8` behaves like the other models — with `thinkingFlag: true`, thinking blocks carry non-empty summarized thinking text.
**Actual:** `claude-opus-4-8` streams empty thinking text under every combination we tried, including `thinkingFlag: true`.
**Note:** your own docs page for this model (docs.kie.ai → Claude → Claude Opus 4.8) documents `thinkingFlag` generically as *"project-specific thinking flag used by the current Claude adapter,"* with no caveat that 4.8 is exempt — so the empty output appears to contradict the documented behavior. This reads like a per-model gap in the adapter (4.8 is the one model that isn't wired up), not intended behavior.

**Ask:** enable thinking-text passthrough for `claude-opus-4-8` so it matches 4-5/4-6/sonnet-4-5, or confirm/​document if 4.8 genuinely cannot return it via your adapter.

---

## Bug 2 — `claude-fable-5` streams THINKING live but BUFFERS the answer text, delivering it all at once at the end

On `claude-fable-5`, the **thinking** deltas stream in real time, but the **answer/text content block is withheld and delivered in a single burst at the very end of the turn** — a long dead-air window where nothing is emitted, then the entire answer arrives at once.

Instrumented one generation at the SSE-chunk level (timestamps relative to first byte):

- **Thinking (reasoning) deltas:** streamed live, **0s → 124s, 119 chunks**, evenly spaced.
- **Then: 62.8 seconds of complete silence** — no SSE data at all.
- **Answer text (~16,990 chars):** arrived at **187s in just 2 chunks** (one burst), not incrementally.

The same client, same endpoint, same request builder on **`claude-opus-4-8` streams the answer text normally** — as a control:

- **Answer text (~20,260 chars):** streamed **68s → 165s in 194 chunks**, **max gap 1.9s**. Smooth, incremental.

So the buffering is **specific to `claude-fable-5`** on your adapter. Opus 4.8's answer streams fine; Fable 5's answer is accumulated server-side and flushed at completion. (Context: for Fable 5, Anthropic returns adaptive thinking with `display: summarized` / raw chain-of-thought withheld — so streaming *summarized thinking* then a final answer is expected, but the **answer content block itself should still stream token-by-token**, as it does for Opus 4.8.)

**Expected:** `claude-fable-5` answer/text content-block deltas stream incrementally as generated (like `claude-opus-4-8`).
**Actual:** answer text is buffered for the whole generation (~63s here) and delivered in one burst at `message_stop`; only the thinking deltas stream during generation.
**Impact:** any streaming UI shows ~1 minute of no output after thinking finishes, then the whole response at once — the response looks frozen, scaling with answer length.

**Ask:** stream `content_block_delta` for the Fable 5 **text** block in real time (not only for the thinking block), matching the Opus 4.8 behavior on the same endpoint.

---

## What would help us verify a fix

- A confirmation of whether these are adapter-side (per-model) issues.
- We can supply exact **request IDs / logs** for the runs above from our KIE dashboard Logs (kie.ai/logs) on request.
- Minimal repro on either: single `stream:true` Messages request with `thinkingFlag:true`; Bug 1 = inspect thinking-block text is empty for `claude-opus-4-8`; Bug 2 = timestamp `content_block_delta` events for `claude-fable-5` and observe the text block arrives only at the end.
