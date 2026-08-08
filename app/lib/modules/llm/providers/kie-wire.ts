/**
 * KIE's wire-level requirements, in a module with NO provider imports (SPEC §4.2a).
 *
 * Separate from `kie.ts` for one reason: `base-provider -> manager -> registry -> providers ->
 * base-provider` is an import cycle the bundler tolerates and vitest does not (`anthropic.spec.ts`
 * documents it and says not to restructure it for a test). So the rules that MUST be pinned live here,
 * importable on their own, and `kie.ts` consumes them.
 */
import type { ModelInfo } from '~/lib/modules/llm/types';
import { FAMILY_POLICY, familyOf } from '~/lib/modules/llm/model-families';

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
/*
 * 🔴 EVERY RUNG OF THE MODEL TIER LADDER MUST BE LISTED HERE, not merely priced (SPEC §4.6.1a).
 *
 * `stream-text.ts` falls back to `modelsList[0]` for a model it cannot find, so an unlisted rung would
 * silently run a DIFFERENT model than the one settlement charges for — wrong model, wrong price, no
 * error. That is survivable for an operator override (`kieEnvModel` below synthesises a `ModelInfo`
 * from `LLM_MODEL`) and NOT survivable for an in-code default, where there is no env var to synthesise
 * from. The two rungs today: `claude-sonnet-5` (Standard) and `claude-opus-5` (Premium). Pinned by
 * `model-tiers.spec.ts`.
 *
 * ⚠️ Ordering is NOT meaningful except for index 0, which is the fallback above. Do not read the first
 * entry as "the default" — this comment used to sit on `claude-opus-4-7` and read exactly that way,
 * long after 4-7 stopped being the default.
 */
export const KIE_MODELS: ModelInfo[] = [
  /* A selectable prior default. Never removed silently — see the exit note above. */
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
   * The PREMIUM rung (`DEFAULT_PREMIUM_MODEL`) since 2026-07-31; THE PLATFORM DEFAULT before that,
   * from 2026-07-27, at 4-8's exact KIE price ($2/$10 — baked-market-prices.ts). Probe-verified on
   * 07-27: cache accounting reports honestly like 4-8 (5,419-token write reported cold, 5,419-token
   * read warm), and thinking text is empty like every KIE model since the 2026-07-24 regression (see
   * the re-measure table above) — the heartbeat carries the UX. It is also the standing revert target
   * for the Standard rung (`LLM_MODEL=claude-opus-5`), so it must stay listed and priced regardless of
   * which rung it currently occupies.
   */
  {
    name: 'claude-opus-5',
    label: 'Claude Opus 5 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * THE PLATFORM DEFAULT (`DEFAULT_MODEL`) — the Standard rung — since 2026-07-31. Listed 2026-07-30,
   * one day before it took the slot, which is why the listing rule above exists in the first place.
   *
   * ⚠️ It carries a KNOWN VENDOR RISK: on 2026-07-30 KIE answered it with `HTTP 500 "Network error"`
   * on **77% of requests** (7 ok / 30, against Opus 5's 21/22 on an interleaved control), which is why
   * it was reverted that day. The owner shipped it anyway on 07-31 for a measured 2.73x cost saving,
   * on the strength of the config-only revert (`LLM_MODEL=claude-opus-5`). Full measurement and the
   * money case live on `DEFAULT_MODEL` in `utils/constants.ts`; re-probe before trusting either
   * verdict, because a vendor fault can clear or return with nobody telling us.
   */
  {
    name: 'claude-sonnet-5',
    label: 'Claude Sonnet 5 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * The strongest model KIE serves whose thinking text their adapter returns (224/223 chars, vs 4-8's
   * 0), at 2x Opus's price. It was the SuperMax rung's in-code default until that rung was retired
   * (2026-08-08), and it is what `PREMIUM_MODEL` names on the owner's deploy today — but that is ENV,
   * not a fact about this build. Listed AND priced (`KIE_MODEL_RATES['claude-fable-5']`, plus the
   * `providerRates` tier injection): the proxy hands it straight to `getModelInstance`, so it runs as
   * itself; listing it here keeps the enhancer's `modelsList[0]` fallback from ever standing in for
   * it, and lets the Pro model selector show it.
   *
   * ⚠️ **The tier word is GONE from the label, deliberately.** `label` is RENDERED (the Pro model
   * selector), so a tier word in it is a live claim, not a comment — it read "· Premium" for a day
   * after Fable 5 moved up a rung, then "· SuperMax" after that rung was deleted. Which rung a model
   * serves is `PREMIUM_MODEL`'s answer and it can change without a redeploy, so no label in this array
   * may assert one. Do not re-add it.
   */
  {
    name: 'claude-fable-5',
    label: 'Claude Fable 5 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * 🔴 THE REST OF KIE'S CLAUDE CATALOGUE — listed 2026-07-31 to close a LATENT MIS-BILL.
   *
   * `claude-opus-4-6` and `claude-haiku-4-5` had been PRICED (baked list) but NOT LISTED here for
   * weeks. That combination is the exact trap the comment at the top of this array describes, and it
   * is worse than being unpriced: `getPlatformModel` ACCEPTS the selector (it validates against the
   * price table, and the row exists), so `LLM_MODEL=claude-opus-4-6` looks configured and generations
   * run — while `stream-text.ts`'s enhancer path cannot find the id, falls through to `modelsList[0]`
   * (`claude-opus-4-7`), and runs a DIFFERENT model than the one settlement charges for. Wrong model,
   * right price, no error. Being unpriced fails loudly; being priced-but-unlisted fails silently.
   *
   * `claude-sonnet-4-6`, `claude-sonnet-4-5` and `claude-opus-4-5` were added to the price list the
   * same day (KIE serves them; an operator setting one got a hard refusal because the row was simply
   * missing), and they are listed here in the same edit so the pair can never drift apart again.
   *
   * The invariant — every priced Claude row is listed, and every listed row is priced — is pinned in
   * `model-tiers.spec.ts`. Add a row in one place and the test names the other.
   */
  {
    name: 'claude-opus-4-6',
    label: 'Claude Opus 4.6 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-opus-4-5',
    label: 'Claude Opus 4.5 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5 (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * 🔴 THE NON-CLAUDE FAMILIES (2026-08-04) — same list, different WIRE. See `kie.ts`'s dispatcher.
   *
   * The listed↔priced invariant above applies to these identically: an id listed here without a
   * Marketplace row is `ratesFor`'s most-expensive fallback, and a priced id missing from here is
   * `stream-text.ts`'s `modelsList[0]` fallback. `model-tiers.spec.ts` pins both directions.
   *
   * ⚠️ **EVERY ID HERE IS LIVE-PROBED (FR9, the no-rabbit-hole rule)** — accepted by its family
   * endpoint, streaming observed, usage metadata captured. KIE's pricing FEED is not evidence that an
   * id exists: the feed's display names are not the API ids (`gpt-5.6-sol` with dots vs the real
   * `gpt-5-6-sol` with dashes), so a row copied from the feed prices a model that cannot be called —
   * which is exactly why the probe is the gate and the feed is only the price.
   *
   * PROBE RESULTS, 2026-08-04 (`scripts/kie-model-health.mjs`, 2 rounds, plus a big-answer capture):
   *   gpt-5-6-sol      2/2 OK, 0 failures · streamed 2,382 deltas / 1.0% in the final second
   *   gpt-5-6-luna     2/2 OK, 0 failures
   *   gpt-5-6-terra    HTTP 200, streamed, usage captured — ADDED on the strength of that probe
   *   gemini-3-5-flash streamed 19 deltas / 6.8% in the final second (one timeout in 2 health rounds)
   *
   * ⚠️ For contrast, the CLAUDE family was failing badly on the same run — `claude-sonnet-5` (the
   * platform default) 0/4, and every other Claude model 25–75%, all `Server exception, please try
   * again later`. That is a live vendor incident, not a property of this list; re-probe before reading
   * it as a reason to move a rung.
   *
   * The GPT family is also why this work happened: KIE's Claude gateway regressed to fully BATCHED
   * delivery around 2026-08-01, while these stream properly (`agent/delivery.ts`).
   */
  {
    name: 'gpt-5-6-sol',
    label: 'GPT 5.6 Sol (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'gpt-5-6-luna',
    label: 'GPT 5.6 Luna (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'gpt-5-6-terra',
    label: 'GPT 5.6 Terra (KIE)',
    provider: 'KIE',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * ⚠️ Gemini ships with NO cache economics on KIE — their feed quotes exactly two rows for this model
   * (input + output, verified against the live feed 2026-08-04) and their wire returns no cached-token
   * counter, so cached tokens bill at the FULL input rate. Owner decision, taken with the flag up.
   */
  {
    name: 'gemini-3-5-flash',
    label: 'Gemini 3.5 Flash (KIE)',
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

  /*
   * The token limits come from the model's FAMILY, not from a pair of literals repeated here.
   *
   * They were `1_000_000`/`128_000` inline — the Claude numbers — which was correct while the provider
   * served one family and would have silently attributed Claude's context window to a `gpt-*` or
   * `gemini-*` operator override. `FAMILY_POLICY` is the one place those numbers live now, so raising a
   * family's limit is one edit rather than a hunt.
   *
   * An UNKNOWN family still gets a `ModelInfo`, deliberately: refusing here would make the operator's
   * error surface as "your model silently isn't in the list" (which is the `modelsList[0]` mis-bill
   * this function exists to prevent), whereas `getModelInstance` refuses it LOUDLY at the moment of
   * use, naming the id. One refusal, at the point where it can be explained.
   */
  const policy = FAMILY_POLICY[familyOf(name) ?? 'claude'];

  return {
    name,
    label: `${name} (KIE)`,
    provider: 'KIE',
    maxTokenAllowed: policy.maxTokenAllowed,
    maxCompletionTokens: policy.maxCompletionTokens,
  };
}
