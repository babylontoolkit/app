/**
 * KIE's Gemini surface — the NATIVE Gemini wire, in a module with NO provider imports.
 *
 * Same split, and the same reason, as `kie-wire.ts` and `kie-codex-wire.ts`: the provider registry is
 * an import cycle vitest will not tolerate, so the wire rules that must be pinned live on their own.
 *
 * ⚠️ **This family has NO cache economics on KIE** (`model-families.ts` `cacheProfile: 'none'`). KIE
 * quotes no cached rate and their wire returns no cached-token counter, so cached tokens bill at the
 * FULL input rate. That is an owner decision taken with the flag up (2026-08-04), not an oversight —
 * and it means a warm Gemini edit costs what a cold one costs. The admin margin report must not read
 * that as a caching regression.
 */

/**
 * The base URL `@ai-sdk/google` composes against. It appends `/models/<id>:streamGenerateContent`, so
 * the composed URL is exactly `/gemini/v1/models/<id>:streamGenerateContent` — the endpoint the
 * 2026-08-04 probe accepted. A missing `/v1` produces `/gemini/models/...` and 404s.
 */
export const KIE_GEMINI_BASE_URL = 'https://api.kie.ai/gemini/v1';

/**
 * Set `generationConfig.thinkingConfig` on the request body — a field the pinned SDK cannot express.
 *
 * ## Why a `fetch` wrapper and not `providerOptions`
 *
 * `@ai-sdk/google@1.2.22` predates `thinkingLevel` entirely: its thinking option knows only
 * `thinkingBudget` (a token count). There is no value of `providerOptions` that produces
 * `{includeThoughts, thinkingLevel}`, which is the shape KIE's gateway accepted on the probe — the
 * identical situation `capabilities.ts`'s `thinkingFetch` documents for Anthropic's `adaptive`
 * thinking against `@ai-sdk/anthropic@1.2.12`. The body is assembled inside the provider and handed
 * straight to `fetch`, so `fetch` is the seam.
 *
 * `includeThoughts: true` is the counterpart of Claude's `display: 'summarized'`: without it the model
 * reasons, we are billed for every thinking token, and the response carries no readable trace of it.
 * Paying full rate for reasoning we then throw away is the pathology §4.2a exists to kill, and it is
 * family-independent.
 *
 * `generationConfig` is MERGED, never replaced — it already carries `maxOutputTokens`, `temperature`
 * and the response format the SDK put there. Overwriting it would silently drop the token cap.
 *
 * The defensive shape is `kieFetch`'s, verbatim: a non-string or non-JSON body passes through
 * untouched, because a body rewrite must never be the thing that breaks a generation.
 */
export function geminiFetch(thinkingLevel: string, baseFetch: typeof fetch = fetch): typeof fetch {
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

    const generationConfig = (body.generationConfig as Record<string, unknown>) ?? {};

    body.generationConfig = {
      ...generationConfig,
      thinkingConfig: {
        ...((generationConfig.thinkingConfig as Record<string, unknown>) ?? {}),
        includeThoughts: true,
        thinkingLevel,
      },
    };

    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}
