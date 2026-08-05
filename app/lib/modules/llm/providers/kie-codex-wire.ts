/**
 * KIE's GPT surface — the OpenAI **Responses** wire, in a module with NO provider imports.
 *
 * Same split, and the same reason, as `kie-wire.ts`: `base-provider -> manager -> registry ->
 * providers -> base-provider` is an import cycle the bundler tolerates and vitest does not, so the
 * rules that must be PINNED live here on their own and `kie.ts` consumes them.
 *
 * ## Why this family exists at all
 *
 * KIE's Claude gateway regressed to fully BATCHED delivery around 2026-08-01 (measured: first text
 * delta at 31–33s of a ~32s request, 100% of the answer in the final second, on both Opus models),
 * while the same account's GPT surface STREAMS properly (measured: first delta at 3.7s, ~1,400
 * evenly-spread deltas). So this is not only model breadth — it is the path back to progressive,
 * file-by-file artifact streaming, which is the difference between watching a build happen and
 * watching a spinner (`agent/delivery.ts`).
 */

/**
 * The `/v1` suffix is REQUIRED for the same reason as the Claude base URL: `@ai-sdk/openai` appends
 * only `/responses` to whatever it is given, so `https://api.kie.ai/codex` alone POSTs to
 * `/codex/responses` and 404s. The composed URL must be exactly `/codex/v1/responses`.
 */
export const KIE_CODEX_BASE_URL = 'https://api.kie.ai/codex/v1';

/**
 * Set `reasoning.effort` on the request body, at the only layer that reliably reaches it.
 *
 * ## Why a `fetch` wrapper and not `providerOptions`
 *
 * `@ai-sdk/openai@1.3.24`'s Responses model only emits `reasoning.effort` when its INTERNAL id
 * heuristic classifies the model as a reasoning model — a heuristic written against OpenAI's own id
 * scheme (`o1`, `o3`, `gpt-5`…). KIE's ids are their own (`gpt-5-6-sol`), so there is no guarantee
 * the heuristic matches, and the failure mode of a miss is SILENT: the field is simply dropped and
 * the request buys whatever the gateway's default effort is. That is the exact pathology
 * `thinkingFetch` exists to kill on the Claude side — paying for a depth of deliberation we never
 * chose — so the effort is written here, deterministically, the same way.
 *
 * Merged, never overwritten: `body.reasoning` may already carry `summary` or other fields.
 *
 * The defensive shape is copied from `kieFetch` verbatim and is not decoration: a body that is not a
 * string, or not JSON we can parse, is passed through untouched. **A body rewrite must never be the
 * thing that breaks a generation** — if we cannot understand the request, the honest move is to leave
 * it alone rather than to guess at its shape.
 */
/*
 * ⚠️ THE ONE DECIDED-BUT-UNMEASURED SEAM ON THIS WIRE: `temperature`.
 *
 * `ai@4` INJECTS `temperature: 0` when the caller supplies none (`temperature != null ? temperature :
 * 0`), which is the whole reason `stripSamplingParams` exists for Claude — current Anthropic models
 * 400 on it. OpenAI's own Responses API rejects `temperature` on REASONING models, and every model we
 * send here is one (we set `reasoning.effort` on all of them), so KIE's gateway plausibly 400s the
 * same way.
 *
 * ✅ **The SDK very probably already handles it, and that was READ FROM ITS SOURCE, not assumed**:
 * `@ai-sdk/openai@1.3.24`'s `getResponsesModelConfig` classifies any id starting with `gpt-5` — so
 * `gpt-5-6-sol` and `gpt-5-6-luna` — as a reasoning model and strips `temperature`/`top_p` itself with
 * a warning, before the body is serialized. That defuses the risk for the ids we ship today. It does
 * NOT settle it: the heuristic is keyed on OpenAI's id scheme, so a future KIE id outside `gpt-5*`
 * would fall out of it silently, and only a live probe proves KIE's gateway behaves like OpenAI's.
 *
 * It is deliberately NOT pre-emptively stripped. `stripSamplingParams` is a CLAUDE wrapper and FR3's
 * whole point is that Claude wrappers never touch another family; adding an untested, unreachable off
 * switch here would be dead code pretending to be a safeguard. If the T11 live probe shows a 400, the
 * fix belongs in THIS file — strip it inside `codexFetch` (the body is already parsed here) and pin it
 * with a serialized-body assertion, exactly as `anthropic.spec.ts` pins the Claude strip. Until then
 * the honest state is: measured on Claude, unmeasured here.
 */
export function codexFetch(effort: string, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (!init?.body || typeof init.body !== 'string') {
      return baseFetch(input, init);
    }

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(init.body);
    } catch {
      return baseFetch(input, init);
    }

    body.reasoning = { ...((body.reasoning as Record<string, unknown>) ?? {}), effort };
    stripStrictTools(body);

    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * 🔴 KIE'S CODEX GATEWAY REJECTS `strict: true` ON A FUNCTION TOOL — AND CALLS IT MAINTENANCE
 * (measured 2026-08-04, and it broke EVERY tool-bearing generation on this family).
 *
 * `@ai-sdk/openai@1.3.24`'s Responses model defaults `strictSchemas` to `true` (`isStrict`), so every
 * function tool it serializes carries `strict: true`. KIE's gateway answers that with **HTTP 200 and
 * `{"code":400,"msg":"The server is currently being maintained, please try again later~"}`** — no SSE
 * events at all. The SDK sees a 200 with an empty stream and finishes cleanly, so `proxy.ts`'s
 * `!producedText` guard is what fires: *"The model returned an empty response"*, `finish=error`,
 * `NaN` token counts (there is no `response.completed` to read `usage` from), and a refund.
 *
 * Bisected from a captured production body, 6 samples per variant:
 *
 *   no tools at all                        6/6 ok
 *   strict: true   (as the SDK ships it)   0/6
 *   strict: false                          6/6 ok
 *   strict absent                          6/6 ok
 *   strict: true, `$schema` removed        0/6      ← so it is `strict`, not the schema dialect
 *
 * ⚠️ **The message is a lie in the most expensive direction.** "Being maintained… try again later"
 * describes a transient outage, so the honest response to it is to wait — but this is deterministic
 * and waiting never fixes it. It is also, verbatim, one of the strings `retry-policy.ts` classifies as
 * RETRYABLE. It never actually reached that policy here (the 200 raises no error, so the retry loop
 * sees nothing and the `!producedText` throw happens after it closes), which is the only reason this
 * failed loudly instead of burning three attempts on an unwinnable request.
 *
 * Stripped here rather than via `providerOptions.openai.strictSchemas` in `proxy.ts`, for the reason
 * this file's temperature note already set out: the proxy must not learn family-specific quirks, and a
 * body rewrite at the wire survives an SDK that renames or re-defaults its setting. **We lose nothing
 * real** — strict mode has the provider validate tool args against the schema, and this platform
 * deliberately validates in `execute` instead (a schema-level violation kills a generation *after* the
 * tokens are spent, `spec/context-budget.md`).
 *
 * The key is DELETED, not set to `false`. Both pass, and absent is the smaller claim: it makes the
 * body identical to one from a client that never heard of strict mode, rather than betting that KIE's
 * validator reads the value rather than the key.
 */
function stripStrictTools(body: Record<string, unknown>): void {
  if (!Array.isArray(body.tools)) {
    return;
  }

  body.tools = body.tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || !('strict' in tool)) {
      return tool;
    }

    const { strict: _strict, ...rest } = tool as Record<string, unknown>;

    return rest;
  });
}
