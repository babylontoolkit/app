/**
 * KIE's wire-level requirements, in a module with NO provider imports (SPEC §4.2a).
 *
 * Separate from `kie.ts` for one reason: `base-provider -> manager -> registry -> providers ->
 * base-provider` is an import cycle the bundler tolerates and vitest does not (`anthropic.spec.ts`
 * documents it and says not to restructure it for a test). So the rules that MUST be pinned live here,
 * importable on their own, and `kie.ts` consumes them.
 */
import type { ModelInfo } from '~/lib/modules/llm/types';

/**
 * The `/v1` suffix is REQUIRED — `@ai-sdk/anthropic` appends `/messages` to whatever it is given, and
 * KIE's docs say to configure `https://api.kie.ai/claude` because Claude Code appends `/v1/messages`
 * itself. The SDK only appends the second half, so the `/v1` has to be here or every call 404s.
 */
export const KIE_DEFAULT_BASE_URL = 'https://api.kie.ai/claude/v1';

/**
 * 🔴 `thinkingFlag: true` — KIE-PROPRIETARY, MANDATORY, AND THE ONLY WAY TO GET THINKING TEXT.
 *
 * KIE documents it as "project-specific thinking flag used by the current Claude adapter". It appears
 * in NO Anthropic documentation, so nothing about treating KIE as a native passthrough would ever lead
 * you to send it — and WITHOUT IT, KIE returns thinking blocks whose text is EMPTY while still billing
 * the thinking tokens. That is exactly the `display: 'omitted'` pathology §4.2a exists to kill: full
 * output rate for reasoning we cannot show, and a dead spinner for the user.
 *
 * It is an ADDITION, never a replacement. Sent alone it does not even enable thinking (measured:
 * `thinking_tokens: 0`). Both must travel on the same request — `thinkingFetch` sets
 * `{type:'adaptive', display:'summarized'}`, this adds the flag KIE needs in order to honour it.
 *
 * MEASURED 2026-07-17 — 3 streaming trials per model, `thinkingFlag` ON vs OFF, thinking-text chars:
 *
 * | model             | flag on            | flag off  |
 * |-------------------|--------------------|-----------|
 * | claude-opus-4-6   | 196, 196, 196 ✅   | 0, 0, 0   |
 * | claude-opus-4-5   | 410, 405, 642 ✅   | 0, 0, 0   |
 * | claude-sonnet-4-5 | 211, 215, 230 ✅   | 0, 0, 0   |
 * | claude-fable-5    | 224, 223, err ⚠️   | 0, 0, 0   |
 * | claude-opus-4-8   | 0, 0, 0 ❌         | 0, 0, 0   |
 */
export function kieFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (!init?.body || typeof init.body !== 'string') {
      return baseFetch(input, init);
    }

    let body: Record<string, unknown>;

    try {
      body = JSON.parse(init.body);
    } catch {
      // Never let a body rewrite be the thing that breaks a generation — same rule as `thinkingFetch`.
      return baseFetch(input, init);
    }

    body.thinkingFlag = true;

    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * Only models KIE DOCUMENTS and that return thinking text with `thinkingFlag` (see the table above).
 * Same ids as Anthropic's: this is a passthrough, so the strings are Anthropic's own and carry no
 * date/`-latest` suffix (those 404).
 *
 * ⚠️ `claude-opus-4-8` is deliberately ABSENT even though it responds normally. It is the one model KIE
 * does not document, and their adapter returns EMPTY thinking text for it under every combination
 * measured — including `thinkingFlag`. Offering it would silently trade away the reasoning stream while
 * still billing for it (§4.2a). Add it the day KIE's adapter supports it, and not a day before.
 */
export const KIE_MODELS: ModelInfo[] = [
  {
    name: 'claude-opus-4-6',
    label: 'Claude Opus 4.6 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
];
