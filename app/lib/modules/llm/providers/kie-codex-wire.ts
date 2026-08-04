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

    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}
