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
 * Same ids as Anthropic's: this is a passthrough, so the strings are Anthropic's own and carry no
 * date/`-latest` suffix (those 404).
 *
 * 🔴 **`claude-opus-4-8` IS OFFERED HERE ON A KNOWN, DELIBERATE TRADE — NOT BY OVERSIGHT.**
 *
 * It is the one model KIE does not document, and their adapter returns EMPTY thinking text for it under
 * every combination measured, INCLUDING `thinkingFlag` (0/0/0 across three trials, while 4-6 returns
 * 196/196/196). So on 4-8 the platform pays full output rate for reasoning it cannot show — the
 * `display: 'omitted'` pathology §4.2a exists to kill, and the user sees dead air proportional to how
 * hard the model thought (measured elsewhere at 5–57% of output, scaling with difficulty).
 *
 * The owner chose this knowingly on 2026-07-17 ("JUST ENABLE KIE-OPUS-4-8 ... for now"): 4-8 is the
 * strongest coding model and this is a game-coding product, and ~2.34x cheaper generations plus a
 * workable 500-credit signup grant were judged to outweigh a temporarily invisible reasoning stream.
 *
 * ⚠️ THIS IS A `for now`. Two exits, and the first is cheap:
 *   1. KIE ships 4-8 in their adapter — it works on every model they document, so this is a gap, not a
 *      limitation. Retest with `thinkingFlag` and this comment simply goes away.
 *   2. Move `PLATFORM_MODEL` to `claude-opus-4-6`, which DOES return thinking text on KIE today.
 *
 * 🔴 Exit 2 is NOT a config change — 4-6 is deliberately absent from this list. `ratesFor` falls back to
 * the PLATFORM model's rates for a model it does not know, so listing 4-6 without a `KIE_MODEL_RATES`
 * row bills it at 4-8's prices. Measured once via KIE's own `credits_consumed`, 4-6 is CHEAPER than 4-8
 * — so that fallback would over-charge every user of it, silently, and throw nothing. One sample is not
 * a rate table: get 4-6's published prices, add the row, and only then list it here.
 *
 * Do not remove 4-8 without saying which exit was taken.
 */
export const KIE_MODELS: ModelInfo[] = [
  {
    name: 'claude-opus-4-8',
    label: 'Claude Opus 4.8 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
];
