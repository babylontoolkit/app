/**
 * Comet's wire facts — base URLs, the family -> wire map, and the shipped model list.
 *
 * ## Why this is a separate module from `cometapi.ts`
 *
 * Exactly the reason `kie-wire.ts` exists: `base-provider` -> `manager` -> `registry` -> `providers`
 * is an import cycle, and a spec that imports the provider to test its dispatch trips it (vitest
 * rejects it outright — see `kie-dispatch.spec.ts`'s header). Constants and pure functions live here
 * so a test can reach them without dragging the registry in.
 *
 * ## 🔴 The family names a DIALECT; THIS FILE names the wire (FR2)
 *
 * `model-families.ts` answers "what protocol dialect does this id speak". It cannot answer "which
 * URL", because the same dialect rides different endpoints on different gateways: `gpt-5` is
 * OpenAI-dialect on both providers but takes **Responses** on KIE (`codex/v1/responses`) and
 * **chat-completions** on Comet. Comet's model list marks `gpt-5*` as `openai`; only `o3-pro` and
 * `o3-pro-2025-06-10` carry `openai-response`, and neither is a model this platform would run. So
 * KIE's `createOpenAI().responses()` binding does not port, and the mapping below is the seam.
 *
 * ## Auth and base URLs (live-probed 2026-08-10)
 *
 * Comet accepts BOTH `Authorization: Bearer` and `x-api-key` on every surface. We send Bearer
 * explicitly, matching `kie.ts` — the SDKs' native headers (`x-api-key`, `x-goog-api-key`) are not
 * wrong here, but sending one header shape on every branch means one thing to check when auth fails.
 *
 * ⚠️ **`COMET_BASE_URL` is the base for ALL families — the opposite of `KIE_BASE_URL`, which is
 * deliberately Claude-scoped.** Do not carry KIE's rule across: KIE fronts three separately-hosted
 * adapters under three different paths, so one override repointing all three would change a config
 * value's meaning underneath the operator. Comet serves every family from one origin, so an operator
 * pointing `COMET_BASE_URL` at a proxy means all of it, and scoping it to Claude would silently send
 * the other three families somewhere they did not ask for.
 *
 * ## The model list is deliberately SHORT (FR4)
 *
 * Only ids live-probed against Comet's own API. Comet's feed lists 276 rows and its `code` and `id`
 * fields already disagree (`grok-4.5` carries `code: "grok-4-5"`) — the exact drift class that shipped
 * a 404 on KIE. A row here that Comet does not serve is not a harmless extra option; it is a 404 at
 * the first generation, on a model the operator believes is configured.
 *
 * ⚠️ Deliberately NOT shipped: the 21 `cometapi-*` alias ids (Comet's own routing pool — unknown
 * backing, unknown pricing) and the `-thinking` id suffix variants (`claude-opus-5-thinking` is a
 * distinct id, and shipping both spellings risks two price rows for one model disagreeing).
 */
import type { ModelInfo } from '~/lib/modules/llm/types';
import { FAMILY_POLICY, familyOf, type ModelFamily } from '~/lib/modules/llm/model-families';

/**
 * The origin every family is served from. `@ai-sdk/anthropic` appends `/messages` and
 * `@ai-sdk/openai` appends `/chat/completions`, so this ends at `/v1` and never at a route.
 */
export const COMET_DEFAULT_BASE_URL = 'https://api.cometapi.com/v1';

/**
 * Gemini rides `/v1beta`, not `/v1` — Google's own versioning, which Comet mirrors
 * (`/v1beta/models/<id>:generateContent`). `@ai-sdk/google` appends `/models/<id>:...`, so this must
 * end at the version segment.
 *
 * Derived from whatever base is configured rather than hardcoded, so an operator pointing
 * `COMET_BASE_URL` at a proxy gets their Gemini traffic proxied too. A base that does not end in a
 * recognisable version segment is left alone and `/v1beta` is appended — the honest fallback for a
 * base whose shape we cannot parse.
 */
export function cometGeminiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');

  return trimmed.endsWith('/v1') ? `${trimmed}beta` : `${trimmed}/v1beta`;
}

/** Which HTTP surface a family takes on Comet. */
export type CometWire = 'messages' | 'chat' | 'gemini';

/**
 * 🔴 FR2 — the family -> wire map, as DATA.
 *
 * `codex` and `chat` share the `chat` wire and that is the whole point of the split: they are the same
 * OpenAI dialect on this provider but they are NOT the same family, because they differ in the thing a
 * family exists to decide — `codex` rows quote KIE's published cache pair (`explicit-pair`) while no
 * vendor quotes a cached rate for `chat` (`none`). Wire sameness and policy sameness are different
 * questions; collapsing them would price a Grok row on GPT's cache economics.
 *
 * This is an exhaustive `Record`, so adding a family to `MODEL_FAMILIES` is a compile error here
 * rather than a model that silently reaches no branch.
 */
export const COMET_WIRES: Record<ModelFamily, CometWire> = {
  claude: 'messages',
  codex: 'chat',
  chat: 'chat',
  gemini: 'gemini',
};

/**
 * The models Comet is confirmed to serve, all live-probed 2026-08-10.
 *
 * Claude only, on purpose: this is the family the platform actually runs, it is the one whose
 * hardening is proven, and the `chat`/`codex`/`gemini` families reach the wire correctly without
 * being listed (`getModelInstance` takes the id straight from config). A row here is a claim that we
 * probed it; adding one on the strength of the pricing feed is the drift the header warns about.
 *
 * Probe evidence (`PROBE_PROVIDER=Comet node scripts/cache-probe.mjs`): the Messages endpoint
 * returned a real 1h-tier cache write (5,420) and a matching read, streamed 388 text deltas with 4%
 * of characters in the final second, and returned 386 chars of thinking text with a valid signature.
 *
 * Per-id re-probe, 2026-08-10 (`POST /v1/messages`, `max_tokens: 1`) — the FR4 pass, and it did not
 * agree with the spec: `claude-sonnet-5`, `claude-opus-5`, `claude-opus-4-8` and `claude-fable-5`
 * all answered **200**, while `claude-haiku-4-5` answered **400** despite the spec listing it as
 * verified. See the note where its row would have been. **The pricing feed is not a probe and the
 * SPEC is not a probe either — only a request is.**
 */
export const COMET_MODELS: ModelInfo[] = [
  {
    name: 'claude-sonnet-5',
    label: 'Claude Sonnet 5 (Comet)',
    provider: 'Comet',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-opus-5',
    label: 'Claude Opus 5 (Comet)',
    provider: 'Comet',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-opus-4-8',
    label: 'Claude Opus 4.8 (Comet)',
    provider: 'Comet',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },
  {
    name: 'claude-fable-5',
    label: 'Claude Fable 5 (Comet)',
    provider: 'Comet',
    maxTokenAllowed: 1_000_000,
    maxCompletionTokens: 128_000,
  },

  /*
   * 🔴 `claude-haiku-4-5` IS NOT LISTED, AND THE SPEC SAYING IT WAS PROBED IS WRONG.
   *
   * `_specs/cometapi-provider_spec.md` names it among the five verified ids. Re-probed 2026-08-10
   * against the real API, it is a **hard 400**:
   *
   *     {"error":{"type":"comet_api_error",
   *               "message":"model claude-haiku-4-5 has not been priced by the administrator yet…"}}
   *
   * Comet serves the DATED id `claude-haiku-4-5-20251001` instead. That is not a spelling we may
   * adopt casually: SPEC §4.2a's model table is explicit that ids carry no date suffix, because on
   * Anthropic the dated-snapshot scheme 404s — so the same string is correct on one provider and
   * broken on another, which is exactly the drift FR4 exists to catch. Comet's feed also reports its
   * output cap as **8K**, against the 64K this platform uses for Haiku elsewhere; overshooting an
   * output cap is a hard 400, so adopting the id would mean adopting an unverified number with it.
   *
   * Haiku is not a rung the §4.6.1a ladder names and nothing on the platform requires it, so it is
   * dropped here rather than shipped on two guesses. If it is ever wanted, probe the dated id AND its
   * real output cap, and add both in the same edit.
   */
];

/**
 * The operator's configured model, when it is not already a static row above.
 *
 * 🔴 **A model that is priced but not LISTED is billed as itself and run as something else.**
 * `stream-text.ts` (the enhancer's path, upstream code) looks the model up in the provider's list and
 * falls back to `modelsList[0]` behind a `logger.warn` on a miss — so a configured model absent from
 * the list would quietly run Sonnet 5 while `settleGeneration` charged the configured model's rates.
 * Wrong model, wrong price, no error. This is `kie-wire.ts`'s `kieEnvModel` for the same reason, and
 * it is why a Comet deploy pointed at, say, `grok-4.5` still bills what it runs.
 *
 * 🔴 **`LLM_MODEL` is the ONLY knob, and there is deliberately no `COMET_DEFAULT_MODEL`.**
 *
 * KIE carries a second selector (`KIE_DEFAULT_MODEL`) for historical reasons, and it costs a
 * precedence rule that two separate readers must agree on — `kieEnvModel` once consulted only
 * `KIE_DEFAULT_MODEL` while `getPlatformModel` preferred `LLM_MODEL`, so a model set via `LLM_MODEL`
 * never reached the provider's list and `stream-text.ts` silently ran `modelsList[0]` while
 * settlement charged the configured model. Wrong model, wrong price, no error.
 *
 * A new provider does not have to inherit that. One variable has no precedence rule to get wrong, and
 * SPEC §4.2a's standing rule says it plainly: a second knob meaning the same thing is the two-writers
 * drift this repo keeps rediscovering. If a per-provider default is ever genuinely wanted, add it to
 * `defaultModelFor` (`agent/config.ts`) and here in the SAME edit, with the precedence written down.
 *
 * ⚠️ This module is client-importable (the registry is imported by the browser bundle), so it reads
 * `serverEnv ?? process.env` directly rather than `~/lib/.server/env` — mirroring `base-provider.ts`'s
 * own key lookup. Billing reads the same variables through `env(context, ...)`, which also works from
 * a Cloudflare loader context. Same variables, two doors.
 *
 * No validation here on purpose: this answers "what will Comet serve", and the operator's promoted
 * rate table answers "may we bill it". `agent/config.ts` refuses an unpriced model before a request is
 * made, so a model listed here without rates is unreachable rather than mis-billed.
 */
export function cometEnvModel(serverEnv?: Record<string, string>): ModelInfo | undefined {
  const name = (serverEnv?.LLM_MODEL || process?.env?.LLM_MODEL)?.trim();

  if (!name || COMET_MODELS.some((m) => m.name === name)) {
    return undefined;
  }

  /*
   * Caps come from the model's FAMILY, never from a pair of literals repeated here — otherwise a
   * `grok-*` or `gemini-*` override silently inherits Claude's 1M context window.
   *
   * An UNKNOWN family still gets a `ModelInfo`, deliberately: refusing here would surface the
   * operator's error as "your model silently is not in the list", which is the `modelsList[0]`
   * mis-bill this function exists to prevent. `getModelInstance` refuses it LOUDLY at the moment of
   * use, naming the id. One refusal, at the point where it can be explained.
   */
  const policy = FAMILY_POLICY[familyOf(name) ?? 'claude'];

  return {
    name,
    label: `${name} (Comet)`,
    provider: 'Comet',
    maxTokenAllowed: policy.maxTokenAllowed,
    maxCompletionTokens: policy.maxCompletionTokens,
  };
}
