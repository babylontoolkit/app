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
 *
 * 🔴 RE-MEASURED 2026-07-24 — KIE HAS REGRESSED ADAPTER-WIDE. The table above is HISTORY, not the
 * current state. With the exact request shape this file sends (`thinking: adaptive/summarized` +
 * `thinkingFlag: true`), thinking-text chars today:
 *
 * | model (via KIE)   | thinking tokens billed | thinking text |
 * |-------------------|------------------------|---------------|
 * | claude-opus-4-8   | 103 / 254              | 0 ❌          |
 * | claude-opus-4-7   | 80                     | 0 ❌          |
 * | claude-fable-5    | 56, then 2,980 forced  | 0 ❌ (was 224/223 on 07-17) |
 * | claude-opus-4-8 via api.anthropic.com (CONTROL) | 121 | 209 ✅ streamed live during the think |
 * | claude-opus-5 (probed 2026-07-27, on becoming the default) | — | 0 ❌ — ZERO thinking deltas on a
 * |   forced think (not even empty ones); 12.4s of wire silence, then the answer. The regression
 * |   covers the new default too; the heartbeat below remains load-bearing. |
 *
 * The control run pins the fault on KIE's adapter, not our request shape: the same body against
 * Anthropic directly streams summarized thinking DURING the think. KIE also still BILLS the
 * thinking tokens (`output_tokens_details.thinking_tokens` accrues) while returning the text
 * empty — the exact billed-but-invisible pathology `thinkingFlag` exists to prevent. On the wire,
 * KIE's silence is total: `message_start` at ~2s, then nothing but a single ping until the (empty)
 * thinking block and the first text arrive TOGETHER at the end of the think — so a creation-sized
 * think is minutes of dead air. Two consequences already acted on:
 *   1. The UX no longer depends on thinking text existing — the §4.2a liveness heartbeat
 *      (`agent/heartbeat.ts`) covers any silent stream, and stands down by itself when real
 *      reasoning returns.
 *   2. Reported to KIE — see `KIE_BUG_REPORT.md` (repo root) for the send-ready report. When they
 *      fix it, thinking text flows through the existing reasoning pipe with NO code change here;
 *      re-run the trials and update this table.
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
 * 🔴 AS OF 2026-07-24 EXIT 2 IS DEAD AND THE TRADE IS MOOT: KIE's adapter regressed to returning
 * EMPTY thinking text for EVERY model measured (fable-5 went 224 → 0; 4-7 is 0; see the re-measure
 * table on `kieFetch` above, with an api.anthropic.com control proving our request shape correct).
 * Switching models within KIE currently buys nothing — the visible-thinking UX is carried by the
 * §4.2a liveness heartbeat (`agent/heartbeat.ts`) until KIE fixes their side (`KIE_BUG_REPORT.md`).
 *
 * 🔴 Exit 2 is NOT a config change — 4-6 is deliberately absent from this list. `ratesFor` falls back to
 * the PLATFORM model's rates for a model it does not know, so listing 4-6 without a `KIE_MODEL_RATES`
 * row bills it at 4-8's prices. Measured once via KIE's own `credits_consumed`, 4-6 is CHEAPER than 4-8
 * — so that fallback would over-charge every user of it, silently, and throw nothing. One sample is not
 * a rate table: get 4-6's published prices, add the row, and only then list it here.
 *
 * Do not remove 4-8 without saying which exit was taken.
 *
 * 2026-07-27: the DEFAULT moved to `claude-opus-5` — same KIE price ($2/$10), same honest cache
 * accounting (probe-verified), same missing thinking text. The trade above carries over unchanged
 * to the new default; 4-8 stays listed as a selectable prior default.
 */
export const KIE_MODELS: ModelInfo[] = [
  /*
   * The platform default (`DEFAULT_MODEL`). It MUST be listed here, not merely priced: `stream-text.ts`
   * falls back to `modelsList[0]` for a model it cannot find, so an unlisted default would silently run
   * a different model than the one settlement charges for. See `kieEnvModel` below.
   */
  {
    name: 'claude-opus-4-7',
    label: 'Claude Opus 4.7 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-opus-4-8',
    label: 'Claude Opus 4.8 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * THE PLATFORM DEFAULT since 2026-07-27 (`DEFAULT_MODEL`), at 4-8's exact KIE price ($2/$10 —
   * baked-market-prices.ts). Probe-verified same day: cache accounting reports honestly like 4-8
   * (5,419-token write reported cold, 5,419-token read warm), and thinking text is empty like every
   * KIE model since the 2026-07-24 regression (see the re-measure table above) — the heartbeat
   * carries the UX. Listed here for the same reason as the others: an unlisted default silently runs
   * `modelsList[0]` on the enhancer path while settlement charges the configured model's rates.
   */
  {
    name: 'claude-opus-5',
    label: 'Claude Opus 5 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * The PREMIUM tier (§4.6.1). Listed AND priced (`KIE_MODEL_RATES['claude-fable-5']`, and the
   * `providerRates` premium injection): it is the strongest model KIE serves whose thinking text their
   * adapter returns (224/223 chars, vs 4-8's 0), at 2x the price. The proxy hands it straight to
   * `getModelInstance`, so it runs as itself; listing it here keeps the enhancer's `modelsList[0]`
   * fallback from ever standing in for it, and lets the Pro model selector show it.
   */
  {
    name: 'claude-fable-5',
    label: 'Claude Fable 5 (KIE · Premium)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
];

/**
 * The operator's `KIE_DEFAULT_MODEL`, as a model the provider will actually SERVE.
 *
 * 🔴 **A model that is priced but not LISTED is billed as itself and run as something else.**
 * `stream-text.ts` (the enhancer's path, upstream code) looks the model up in the provider's list and,
 * on a miss, falls back to `modelsList[0]` behind a `logger.warn` — so `KIE_DEFAULT_MODEL=some-model`
 * would quietly run Opus 4.8 while `settleGeneration` charged `some-model`'s rates. Wrong model, wrong
 * price, no error. Hence this: the model reaches the list through upstream's own `getDynamicModels`
 * seam, so both money paths agree on what is running. (The proxy hands `model` straight to
 * `getModelInstance` and was never affected — which is exactly why this would have hidden.)
 *
 * ⚠️ **The env var has TWO readers, deliberately, and they must never disagree about its VALUE.**
 * Billing reads it via `env(context, ...)` because it must also work from a Cloudflare loader context;
 * this file cannot — it is client-importable, so `~/lib/.server/env` is off limits (the registry is
 * imported by the browser bundle, which is why `capabilities.ts` lives outside `.server` too). Same
 * variable, two doors. `serverEnv ?? process.env` mirrors `base-provider.ts`'s own key lookup exactly.
 *
 * There is no validation here on purpose: this answers "what will KIE serve", and the operator's rate
 * table answers "may we bill it". `agent/config.ts` refuses an unpriced model before a request is ever
 * made, so a model listed here without rates is unreachable rather than mis-billed.
 */
export function kieEnvModel(serverEnv?: Record<string, string>): ModelInfo | undefined {
  /*
   * ⚠️ The SAME precedence as `getPlatformModel`: `LLM_MODEL` > `KIE_DEFAULT_MODEL`. This read used to
   * consult only `KIE_DEFAULT_MODEL`, so a platform model set via `LLM_MODEL` never reached the list —
   * reopening the exact hole the doc comment above describes, one variable to the left. `stream-text.ts`
   * would fall back to `modelsList[0]` and the enhancer would RUN Opus 4.8 while settlement charged the
   * configured model's rates. If the two readers disagree about which var wins, the mis-bill is back.
   */
  const name = (
    serverEnv?.LLM_MODEL ||
    process?.env?.LLM_MODEL ||
    serverEnv?.KIE_DEFAULT_MODEL ||
    process?.env?.KIE_DEFAULT_MODEL
  )?.trim();

  if (!name || KIE_MODELS.some((m) => m.name === name)) {
    return undefined;
  }

  return {
    name,
    label: `${name} (KIE)`,
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  };
}
