/**
 * The Comet FAMILY DISPATCH (SPEC §4.2a, `_specs/cometapi-provider_plan.md` T2) — one provider,
 * three HTTP surfaces, four families.
 *
 * `cometapi.ts`'s `getModelInstance` resolves `requireFamily(model)` and then picks a WIRE from
 * `COMET_WIRES`. The thing that must never regress is FR3's guarantee: `thinkingFetch`,
 * `stripSamplingParams` and `dropOrphanReasoningSignatures` encode ANTHROPIC wire facts, and any of
 * them applied to another family puts an Anthropic-shaped field into a foreign request body — a hard
 * 400 before a token, on a model the operator believes is configured. The reverse is equally binding:
 * the Claude branch must keep sending `thinking` and `output_config`, or we pay the server-side default
 * effort (`high`) on every turn and get thinking blocks whose text is empty, silently.
 *
 * ## Why this file is NOT `kie-dispatch.spec.ts` with the names changed
 *
 * Two facts are inverted between the providers, and a copied-across assumption is wrong in both cases:
 *
 *  - **`gpt-*` takes chat-completions here, Responses on KIE.** Same dialect, different endpoint —
 *    which is exactly why `model-families.ts` holds the DIALECT and each provider holds its own
 *    family → wire map (FR2). A spec that asserted `/responses` would be asserting KIE's fact.
 *  - **`thinkingFlag` must be ABSENT.** It is private to KIE's Claude adapter, so on KIE its absence is
 *    a silent money leak and here its PRESENCE would be an unknown field on a native passthrough. It is
 *    therefore in `ANTHROPIC_ONLY_BODY_FIELDS`' sibling check below and asserted absent on EVERY
 *    branch, Claude included — the one assertion in this file that has no counterpart in KIE's.
 *
 * ## Why the dispatch is REPRODUCED here rather than imported (this is the weaker of two options)
 *
 * `kie.spec.ts`'s header records that importing a provider class breaks vitest —
 * `base-provider -> manager -> registry -> providers -> base-provider` is an import cycle the bundler
 * tolerates and vitest does not. Re-verified for THIS file (2026-08-10): a bare `import('./cometapi')`
 * fails at collection. So `buildInstance` below reproduces `cometapi.ts`'s branches line for line, in
 * the established `capture()` style, and drives them through the REAL `streamText` against replayed
 * SSE per protocol.
 *
 * A reproduction proves the WIRES behave; it cannot prove `cometapi.ts` still calls them that way. So
 * it is paired with a SOURCE SCAN (the last describe) that reads the file and asserts the branch
 * structure — including a default-deny sweep proving no Claude wrapper name appears anywhere in the two
 * non-Claude branches. That scan carries its own controls, because a scanner that silently matches
 * nothing reports a clean bill of health forever.
 *
 * ⚠️ ONE deliberate deviation from `cometapi.ts`: production calls `rateLimitFetch({provider})` with
 * its default base fetch (the real network); the reproduction injects the capture spy as that base
 * fetch. Everything above it in the chain — including the `thinkingFetch(..., rateLimitFetch(...))`
 * nesting order — is identical, which is the part FR3 is about.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type LanguageModelV1 } from 'ai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dropOrphanReasoningSignatures,
  stripSamplingParams,
  supportsSamplingParams,
  thinkingFetch,
  type EffortLevel,
  type ThinkingMode,
} from '~/lib/modules/llm/capabilities';
import { requireFamily, FAMILY_POLICY } from '~/lib/modules/llm/model-families';
import { rateLimitFetch } from '~/lib/modules/llm/rate-limit';
import {
  cometEnvModel,
  cometGeminiBaseUrl,
  COMET_DEFAULT_BASE_URL,
  COMET_MODELS,
  COMET_WIRES,
  type CometWire,
} from './comet-wire';

/**
 * The fields that are ONLY ever legal on the Anthropic wire. Any of them elsewhere is a 400.
 *
 * `thinkingFlag` is deliberately NOT in this list — it belongs to nothing on Comet, not even the
 * Claude branch, so it gets its own all-branches assertion below rather than being folded in here
 * where the Claude case would be asserted PRESENT.
 */
const ANTHROPIC_ONLY_BODY_FIELDS = ['thinking', 'output_config'] as const;

/** KIE's private Claude-adapter field. Comet is a native passthrough; it must never appear anywhere. */
const KIE_ONLY_BODY_FIELD = 'thinkingFlag';

/* --------------------------------------------------------------------------------------------- */
/* Replayed streams — one per protocol.                                                            */
/* --------------------------------------------------------------------------------------------- */

function anthropicSse(): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];

  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * OpenAI **chat-completions** — not Responses. This is the shape difference from KIE in one function:
 * `kie-dispatch.spec.ts` replays `response.output_text.delta`, and a Comet `gpt-*` request that
 * received that stream would parse nothing.
 */
function chatCompletionsSse(model: string): Response {
  const chunks = [
    {
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];

  return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function geminiSse(): Response {
  const chunks = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
  ];

  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/* --------------------------------------------------------------------------------------------- */
/* The dispatch, reproduced exactly as `cometapi.ts` wires it.                                     */
/* --------------------------------------------------------------------------------------------- */

const API_KEY = 'comet-test-key';
const PROVIDER_NAME = 'Comet';

interface Seen {
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  calls: number;
}

/**
 * Mirror of `getModelInstance`'s body: `requireFamily` FIRST (before any key lookup or wire build),
 * then the wire lookup, then the branches in source order — `chat`, `gemini`, the exhaustive refusal,
 * and Claude LAST but GUARDED rather than defaulted. Keep this in step with `cometapi.ts`; the source
 * scan at the bottom of this file is what notices when it drifts.
 */
function buildInstance(
  model: string,
  options: { mode?: ThinkingMode; effort?: EffortLevel },
  spy: typeof fetch,
): LanguageModelV1 {
  const family = requireFamily(model);
  const mode: ThinkingMode = options.mode ?? 'adaptive';
  const effort: EffortLevel = options.effort ?? 'medium';

  const base = COMET_DEFAULT_BASE_URL;
  const headers = { Authorization: `Bearer ${API_KEY}` };
  const wire = COMET_WIRES[family];

  if (wire === 'chat') {
    const openai = createOpenAI({
      apiKey: API_KEY,
      baseURL: base,
      headers,
      fetch: rateLimitFetch({ provider: PROVIDER_NAME }, spy),
    });

    return openai.chat(model);
  }

  if (wire === 'gemini') {
    const gemini = createGoogleGenerativeAI({
      apiKey: API_KEY,
      baseURL: cometGeminiBaseUrl(base),
      headers,
      fetch: rateLimitFetch({ provider: PROVIDER_NAME }, spy),
    });

    return gemini(model);
  }

  /*
   * 🔴 EXPLICIT, never a fallthrough — mirrors `cometapi.ts`. A wire added to `CometWire` without a
   * branch would otherwise land in the Anthropic client below, which is precisely the hazard `kie.ts`
   * shipped for a week while its Claude branch was an `else`.
   */
  if (wire !== 'messages') {
    const exhaustive: never = wire;
    void exhaustive;

    throw new Error(`Comet has no wire binding for family "${family}" (model "${model}").`);
  }

  const comet = createAnthropic({
    apiKey: API_KEY,
    baseURL: base,
    headers,

    // NO `kieFetch` — `thinkingFlag` is KIE's private field. The chain is thinkingFetch -> rateLimit.
    fetch: thinkingFetch(mode, effort, model, rateLimitFetch({ provider: PROVIDER_NAME }, spy)),
  });

  const instance = supportsSamplingParams(model) ? comet(model) : stripSamplingParams(comet(model));

  return dropOrphanReasoningSignatures(instance);
}

/** Drive the REAL provider stack for `model` and return what landed on the wire. */
async function capture(model: string, options: { mode?: ThinkingMode; effort?: EffortLevel } = {}): Promise<Seen> {
  const seen: Seen = { calls: 0 };

  const spy: typeof fetch = async (input, init) => {
    seen.calls += 1;
    seen.url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    seen.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    seen.body = init?.body ? JSON.parse(init.body as string) : undefined;

    const wire: CometWire = COMET_WIRES[requireFamily(model)];

    return wire === 'chat' ? chatCompletionsSse(model) : wire === 'gemini' ? geminiSse() : anthropicSse();
  };

  const result = streamText({
    model: buildInstance(model, options, spy),
    messages: [{ role: 'user', content: 'hi' }],
  });

  // Drain — the request is not sent until the stream is consumed.
  for await (const _ of result.textStream) {
    void _;
  }

  return seen;
}

/* --------------------------------------------------------------------------------------------- */

describe('the Comet family dispatch', () => {
  /*
   * 🔴 CODEX — `gpt-*` on the CHAT-COMPLETIONS wire, and every Anthropic field absent.
   *
   * The endpoint assertion is the FR2 half: KIE binds this family to `.responses()`, Comet's model list
   * marks `gpt-5*` as `openai` and only `o3-pro` carries `openai-response`, so a ported Responses
   * binding would POST to an endpoint that does not exist here. The absence assertions are the FR3
   * half: `thinkingFetch` would write `thinking` and `output_config` into an OpenAI body.
   */
  it('routes gpt-* to chat-completions — no Anthropic field survives', async () => {
    const seen = await capture('gpt-5');

    expect(seen.url).toBe(`${COMET_DEFAULT_BASE_URL}/chat/completions`);
    expect(seen.body.model).toBe('gpt-5');

    for (const field of ANTHROPIC_ONLY_BODY_FIELDS) {
      expect(seen.body[field], `${field} must never appear on the chat-completions wire`).toBeUndefined();
    }
  });

  /*
   * 🔴 CHAT — the family that did not exist before Comet (Grok, Kimi, Qwen, GLM, DeepSeek, MiniMax).
   *
   * It shares the WIRE with `codex` and not the POLICY, so it is asserted separately rather than
   * folded into the `gpt-*` case: a dispatch that collapsed the two families would pass a test that
   * only ever exercised one of them.
   */
  it('routes grok-4.5 to chat-completions — no Anthropic field survives', async () => {
    const seen = await capture('grok-4.5');

    expect(seen.url).toBe(`${COMET_DEFAULT_BASE_URL}/chat/completions`);
    expect(seen.body.model).toBe('grok-4.5');

    for (const field of ANTHROPIC_ONLY_BODY_FIELDS) {
      expect(seen.body[field], `${field} must never appear on the chat-completions wire`).toBeUndefined();
    }
  });

  /* 🔴 GEMINI — the third protocol, on `/v1beta`. Native Gemini has no room for any Anthropic field. */
  it('routes gemini-* to the native Gemini wire under /v1beta — no Anthropic field survives', async () => {
    const seen = await capture('gemini-3-pro-preview');

    expect(seen.url).toContain(`${cometGeminiBaseUrl(COMET_DEFAULT_BASE_URL)}/models/gemini-3-pro-preview:`);
    expect(seen.url).toContain('/v1beta/');

    for (const field of ANTHROPIC_ONLY_BODY_FIELDS) {
      expect(seen.body[field], `${field} must never appear on the Gemini wire`).toBeUndefined();
    }
  });

  /*
   * 🔴 CLAUDE — the other direction of the same wall. Losing `thinking`/`output_config` here throws
   * nothing: it buys the server-side default effort (`high`) on every turn and returns thinking blocks
   * whose text is EMPTY, and the token count goes DOWN, which reads as a cheaper turn.
   */
  it('routes claude-* to the Anthropic Messages wire — thinking and output_config intact', async () => {
    const seen = await capture('claude-opus-5');

    expect(seen.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(seen.body.output_config?.effort).toBe('medium');
    expect(seen.url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
  });

  /*
   * 🔴 `thinkingFlag` IS KIE'S, ON EVERY BRANCH INCLUDING CLAUDE.
   *
   * This is the assertion with no counterpart in `kie-dispatch.spec.ts`, and it exists because the
   * likely way it regresses is a well-meaning port: someone reads KIE's spec, sees an emphatic
   * "without this we bill thinking and get it back empty", and adds `kieFetch` here. Comet is a native
   * Anthropic passthrough — the flag is an unknown field, and the whole reason `stream-probe.mjs`'s
   * Comet block omits it.
   */
  it.each(['claude-opus-5', 'gpt-5', 'grok-4.5', 'gemini-3-pro-preview'])(
    'never sends KIE’s thinkingFlag for %s',
    async (model) => {
      const seen = await capture(model);

      expect(seen.body[KIE_ONLY_BODY_FIELD]).toBeUndefined();
    },
  );

  /*
   * Every family authenticates on `Authorization: Bearer`. Comet accepts `x-api-key` too, so this is a
   * consistency rule rather than a hard requirement — one header shape to check when auth fails,
   * matching `kie.ts`. It regresses the moment someone drops the explicit `headers` on a branch,
   * because each SDK's own default header (`x-api-key`, `x-goog-api-key`) would still work.
   */
  it.each(['claude-opus-5', 'gpt-5', 'grok-4.5', 'gemini-3-pro-preview'])(
    'sends Authorization: Bearer for %s',
    async (model) => {
      const seen = await capture(model);

      expect(seen.headers?.authorization).toBe(`Bearer ${API_KEY}`);
    },
  );

  /*
   * CONTROL for all of the above. Every "must be absent" assertion is satisfied by a request that never
   * happened, so if the stack ever stopped reaching the wire the FR3 pins would pass vacuously — and
   * this is the test that says so.
   */
  it.each(['claude-opus-5', 'gpt-5', 'grok-4.5', 'gemini-3-pro-preview'])(
    'actually reaches the wire for %s (control for the absence assertions)',
    async (model) => {
      const seen = await capture(model);

      expect(seen.calls).toBe(1);
      expect(seen.body).toBeDefined();
    },
  );
});

describe('an unknown model id refuses before anything is built', () => {
  /*
   * 🔴 The refusal must land at MODEL RESOLUTION, not at the request. `capabilities.ts`'s tables
   * default to modern-Claude, so an id nothing claims would otherwise be handed an Anthropic `thinking`
   * block inside whatever body the guessed branch produced — a 400 after the key lookup, after the wire
   * was built, and attributed to the wrong thing. ZERO fetches is the assertion, not "it throws": a
   * throw after the request is in flight is a different guarantee.
   */
  it('throws naming the id and every accepted prefix, and never touches fetch', () => {
    let calls = 0;
    const spy: typeof fetch = async () => {
      calls += 1;
      return anthropicSse();
    };

    expect(() => buildInstance('llama-3', {}, spy)).toThrow(/llama-3/);
    expect(() => buildInstance('llama-3', {}, spy)).toThrow(/claude-\*.*gpt-\*.*gemini-\*/s);
    expect(calls, 'the refusal must precede every request').toBe(0);
  });

  /*
   * CONTROL. The assertion above is satisfied by a `buildInstance` that throws for EVERYTHING, which
   * would be a total outage reported as a passing suite. A served id must still build and reach the
   * wire, in the same file, through the same helper.
   */
  it('still builds and reaches the wire for a served id (control)', async () => {
    const seen = await capture('claude-opus-5');

    expect(seen.calls).toBe(1);
    expect(seen.url).toBe(`${COMET_DEFAULT_BASE_URL}/messages`);
  });
});

describe('thinkingMode: disabled reaches the Claude wire, and cannot leak onto the others', () => {
  /*
   * The proxy's last-resort retry (`retry-policy.ts`) passes `thinkingMode: 'disabled'`. On KIE that
   * mitigation exists because their gateway kills a step emitting no bytes for ~30s; Comet is not
   * measured to do that, but the parameter still has to be honoured rather than dropped as an excess
   * property — a silently-ignored retry knob is a live no-op on the one attempt that exists because
   * two others already failed.
   */
  it('claude: thinking {type: disabled}', async () => {
    const seen = await capture('claude-opus-4-8', { mode: 'disabled' });

    expect(seen.body.thinking).toEqual({ type: 'disabled' });
  });

  /*
   * 🔴 THE CLAMP SURVIVES THE DISPATCH. `canDisableThinking` refuses `{type:'disabled'}` for
   * `claude-fable-5` outright and for `claude-opus-5` above effort `high` — both are hard 400s, and
   * both would land on the attempt that had already failed twice.
   */
  it.each([
    ['claude-fable-5', 'medium' as EffortLevel],
    ['claude-opus-5', 'xhigh' as EffortLevel],
    ['claude-opus-5', 'max' as EffortLevel],
  ])('claude: %s at effort %s stays ADAPTIVE — the canDisableThinking clamp holds', async (model, effort) => {
    const seen = await capture(model, { mode: 'disabled', effort });

    expect(seen.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  /*
   * The non-Claude wires have no off switch and no `thinking` field at all. `disabled` must therefore
   * be a no-op on them rather than an invented value — an unrecognised key is a 400 on the retry.
   *
   * ⚠️ Comet's `chat`/`gemini` branches deliberately carry NO effort translation at all today (unlike
   * KIE, whose `codexFetch`/`geminiFetch` map it). If one is added later, this test is where the
   * absence assertion has to be replaced by a positive one — not deleted.
   */
  it.each(['gpt-5', 'grok-4.5', 'gemini-3-pro-preview'])(
    '%s: disabled never becomes an Anthropic thinking field',
    async (model) => {
      const seen = await capture(model, { mode: 'disabled', effort: 'max' });

      expect(seen.body.thinking).toBeUndefined();
      expect(seen.body.output_config).toBeUndefined();
    },
  );
});

describe('cometEnvModel sources its token limits from the family policy', () => {
  /*
   * ⚠️ `cometEnvModel` falls back to `process.env` when `serverEnv` does not carry the key, and vitest
   * loads `.env.local` — which on this machine now holds a REAL Comet key and may hold `LLM_MODEL`. An
   * unscrubbed spec resolves the developer's live configuration and fails on their machine only, with
   * CI green. Same trap as `oauth.spec.ts`'s, which is the reason this scrub exists at all.
   */
  beforeEach(() => {
    for (const key of ['LLM_MODEL', 'COMET_DEFAULT_MODEL', 'COMET_API_KEY', 'COMET_BASE_URL']) {
      vi.stubEnv(key, undefined as unknown as string);
    }
  });

  /*
   * Limits come from `FAMILY_POLICY` and are asserted against it, never against literals: `claude`,
   * `codex` and `gemini` happen to share 1M/128k today, so a literal would pass for the wrong reason
   * the moment one of them moves — and `chat` ALREADY differs (128k/32k), which is what makes the
   * failure mode concrete rather than hypothetical.
   */
  it.each([
    ['gpt-9-9-probe', 'codex' as const],
    ['gemini-9-9-probe', 'gemini' as const],
    ['claude-9-9-probe', 'claude' as const],
    ['grok-9-9-probe', 'chat' as const],
  ])('%s takes the %s policy limits', (name, family) => {
    const info = cometEnvModel({ LLM_MODEL: name });

    expect(info?.name).toBe(name);
    expect(info?.provider).toBe('Comet');
    expect(info?.maxTokenAllowed).toBe(FAMILY_POLICY[family].maxTokenAllowed);
    expect(info?.maxCompletionTokens).toBe(FAMILY_POLICY[family].maxCompletionTokens);
  });

  /*
   * CONTROL for the parameterised block above: the four policies must not all be the same object, or
   * every row would pass against any family the function happened to pick. `chat` is the one that
   * differs today — if that ever stops being true, this control needs a new discriminator, not a
   * deletion.
   */
  it('the policies being compared are actually distinguishable (control)', () => {
    expect(FAMILY_POLICY.chat.maxTokenAllowed).not.toBe(FAMILY_POLICY.claude.maxTokenAllowed);
    expect(FAMILY_POLICY.chat.maxCompletionTokens).not.toBe(FAMILY_POLICY.claude.maxCompletionTokens);
  });

  it('reads LLM_MODEL', () => {
    expect(cometEnvModel({ LLM_MODEL: 'grok-4.5' })?.name).toBe('grok-4.5');
  });

  /*
   * 🔴 THERE IS NO SECOND SELECTOR, AND THAT ABSENCE IS THE TEST.
   *
   * KIE carries `KIE_DEFAULT_MODEL` alongside `LLM_MODEL`, which costs a precedence rule that TWO
   * separate readers — `kieEnvModel` here and `defaultModelFor` in `agent/config.ts` — must agree on.
   * They once did not: `kieEnvModel` consulted only `KIE_DEFAULT_MODEL` while `getPlatformModel`
   * preferred `LLM_MODEL`, so a model set via `LLM_MODEL` never reached the provider's list and
   * `stream-text.ts` fell back to `modelsList[0]` — running one model while settlement charged for
   * another. Wrong model, wrong price, no error.
   *
   * Comet deliberately ships one knob, so there is no precedence to get wrong. This asserts the
   * variable is INERT rather than merely lower-priority: adding a `COMET_DEFAULT_MODEL` read here
   * without adding the matching branch to `defaultModelFor` would reopen that exact hole, and it is a
   * one-line change that looks like a feature.
   */
  it('has NO second selector — COMET_DEFAULT_MODEL is not read at all', () => {
    expect(cometEnvModel({ COMET_DEFAULT_MODEL: 'gpt-5' })).toBeUndefined();

    // …and it cannot outrank, override, or even perturb LLM_MODEL.
    expect(cometEnvModel({ LLM_MODEL: 'grok-4.5', COMET_DEFAULT_MODEL: 'gpt-5' })?.name).toBe('grok-4.5');
  });

  /*
   * An UNKNOWN family still gets a `ModelInfo` on purpose. Refusing here would leave the id out of the
   * provider list, which is the `modelsList[0]` mis-bill this function exists to prevent;
   * `getModelInstance` is where it refuses, loudly, naming the id (asserted in the unknown-id describe
   * above — the two halves are a pair).
   */
  it('still lists an unknown-family override rather than silently omitting it', () => {
    expect(cometEnvModel({ LLM_MODEL: 'llama-3' })?.name).toBe('llama-3');
  });

  /* CONTROL: an already-listed model returns undefined, so the assertions above read the synthesis path. */
  it('returns undefined for a model already in COMET_MODELS (control)', () => {
    expect(cometEnvModel({ LLM_MODEL: COMET_MODELS[0].name })).toBeUndefined();
  });

  /* And nothing configured is nothing synthesized — this is also the scrub's own control. */
  it('returns undefined when neither variable is set', () => {
    expect(cometEnvModel({})).toBeUndefined();
    expect(cometEnvModel(undefined)).toBeUndefined();
  });
});

/**
 * The reproduction above proves the three WIRES behave; it cannot prove `cometapi.ts` still calls them
 * that way, because the import cycle keeps `CometApiProvider` out of vitest. This scan closes that gap
 * by reading the source, and carries its own controls — a scan that silently matches nothing is not a
 * weak test, it is no test.
 */
describe('cometapi.ts really wires the branches this spec reproduces', () => {
  const source = readFileSync(join(process.cwd(), 'app/lib/modules/llm/providers/cometapi.ts'), 'utf8');

  /*
   * ⚠️ Comment-stripped, and that is load-bearing rather than tidy.
   *
   * `kie-dispatch.spec.ts` records the failure this prevents: its first draft scanned raw source for
   * `requireFamily(model)`, the FILE'S OWN HEADER quotes that phrase, and the ordering assertion could
   * therefore not fail — moving the call below the key lookup left the suite green. `cometapi.ts`'s
   * header quotes even more of its own wiring than KIE's does (it explains why each wrapper is absent
   * from the non-Claude branches BY NAME), so an unstripped scan here would be vacuous immediately.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /*
   * 🔴 `requireFamily` FIRST — before the key lookup, before any wire is built. An anchored regex, not
   * a loose `toContain`: the point is WHERE it runs, and an offset comparison is the only thing that
   * can express that.
   */
  it('resolves the family BEFORE the key lookup — an unknown id must never reach a guessed wire', () => {
    const familyAt = code.indexOf('requireFamily(model)');
    const keyLookupAt = code.indexOf('getProviderBaseUrlAndKey');

    expect(familyAt, 'control: the call must exist as CODE, not only in a comment').toBeGreaterThan(-1);
    expect(keyLookupAt, 'control: the key lookup must exist as CODE').toBeGreaterThan(-1);
    expect(familyAt).toBeLessThan(keyLookupAt);

    /*
     * Anchored to the DECLARATION, so a decoy `requireFamily(model)` elsewhere cannot satisfy the
     * ordering above while the real resolution moved. Verified against the loose form: with a bare
     * `toContain`, a second occurrence anywhere in the file keeps this green.
     */
    expect(code).toMatch(/const family\s*=\s*requireFamily\(model\);/);
  });

  /*
   * 🔴 THE PARAMETER MUST BE READ, NOT MERELY DECLARED.
   *
   * `thinkingMode` was in `anthropic.ts`'s signature and ABSENT from KIE's, so the proxy's last-resort
   * retry passed it and it was dropped on the floor as an excess property — a silent no-op on the one
   * attempt that exists because two others already failed. Declaring the parameter and pinning
   * `thinkingFetch(thinkingMode, ...)` does NOT catch that: both stay true when the resolution ignores
   * `options.thinkingMode` and reads only the env var. The defect is precisely in the `??`, so the `??`
   * is what is pinned.
   */
  it('READS options.thinkingMode — declaring it is not the same as honouring it', () => {
    expect(code).toMatch(/thinkingMode\?:\s*ThinkingMode/);
    expect(code, 'the retry-with-thinking-disabled parameter must win over the env default').toMatch(
      /const thinkingMode: ThinkingMode\s*=\s*\n?\s*options\.thinkingMode \?\?/,
    );
  });

  /* The wire is chosen from the DATA map, not re-derived from the family with a second set of rules. */
  it('picks the wire from COMET_WIRES rather than re-deriving it', () => {
    expect(code).toMatch(/const wire\s*=\s*COMET_WIRES\[family\];/);
  });

  /* Each branch binds its own builder — and `.chat`, never KIE's `.responses`. */
  it('binds each wire to its own builder', () => {
    expect(code).toContain("if (wire === 'chat')");
    expect(code).toContain('openai.chat(model)');
    expect(code, 'Responses is KIE’s binding; Comet has no such endpoint for gpt-*').not.toContain('.responses(model)');

    expect(code).toContain("if (wire === 'gemini')");
    expect(code).toContain('cometGeminiBaseUrl(base)');

    expect(code).toContain('thinkingFetch(thinkingMode, effort, model, rateLimitFetch(');
  });

  /*
   * 🔴 THE CLAUDE TAIL, SOURCE-PINNED — the reproduction above cannot cover it.
   *
   * `buildInstance` applies the same tail, so replacing production's with a bare `return comet(model)`
   * left this whole spec green (verified). The reproduction proves the tail is CORRECT; only a scan
   * proves the shipped file still has it, and that gap is the entire reason this describe exists.
   *
   * Both halves are §4.2a wire facts, not preferences: without `stripSamplingParams` the `ai@4`
   * pipeline injects `temperature: 0` into every request (current models 400 on it, before a token),
   * and without `dropOrphanReasoningSignatures` an empty thinking block's orphan `signature_delta`
   * crashes the SDK's stream state machine. Loud failures both — but loud on the FIRST generation
   * after a deploy, which is not where anyone wants to discover them.
   */
  it('keeps the Claude tail — sampling-param strip and orphan-signature filter', () => {
    expect(code, 'the strip is GATED on supportsSamplingParams — never applied unconditionally').toMatch(
      /supportsSamplingParams\(model\)\s*\?\s*comet\(model\)\s*:\s*stripSamplingParams\(comet\(model\)\)/,
    );
    expect(code).toMatch(/return dropOrphanReasoningSignatures\(instance\);/);
  });

  /*
   * 🔴 `kieFetch` NOWHERE IN THE FILE — not merely absent from the Claude branch.
   *
   * Unlike the wrappers below, this one would be WRONG on the Claude branch too, so it gets a
   * whole-file scan rather than a slice.
   */
  it('never imports or applies kieFetch — thinkingFlag is KIE’s private field', () => {
    expect(code).not.toContain('kieFetch');
    expect(code).not.toContain('thinkingFlag');
  });

  /*
   * 🔴 FR3 AS A DEFAULT-DENY SCAN: no Claude wrapper name may appear as CODE anywhere between the start
   * of the chat branch and the start of the Claude client. Do not silence a failure here by narrowing
   * the slice.
   *
   * Comments are stripped first (see `code` above), and not as a convenience: both non-Claude branches
   * deliberately NAME these wrappers in prose to explain why they are absent, so an un-stripped scan
   * would fail on the very documentation that records the rule — and the tempting fix, deleting the
   * explanation, trades a real comment for a passing test.
   */
  const nonClaudeBranches = code.slice(code.indexOf("if (wire === 'chat')"), code.indexOf('createAnthropic('));

  it.each(['thinkingFetch', 'stripSamplingParams', 'dropOrphanReasoningSignatures'])(
    'never applies the Claude wrapper %s to a non-Claude family',
    (wrapper) => {
      expect(nonClaudeBranches).not.toContain(wrapper);
    },
  );

  /*
   * CONTROLS for the default-deny scan. `slice` on a `-1` index does not throw — it silently produces
   * a string that matches nothing, so deleting the chat branch outright would turn all three
   * assertions above green. These two are what make that impossible: the slice must be a real,
   * non-trivial region, and it must contain the builders it is supposed to be scanning.
   */
  it('read a real slice of cometapi.ts (control for the default-deny scan)', () => {
    expect(code.indexOf("if (wire === 'chat')"), 'the chat branch must exist as CODE').toBeGreaterThan(-1);
    expect(code.indexOf('createAnthropic('), 'the claude client must exist as CODE').toBeGreaterThan(-1);
    expect(nonClaudeBranches.length).toBeGreaterThan(200);
    expect(nonClaudeBranches).toContain('createOpenAI(');
    expect(nonClaudeBranches).toContain('createGoogleGenerativeAI(');
  });

  /*
   * 🔴 THE CLAUDE BRANCH IS GUARDED, NOT DEFAULTED — and only a source scan can say so, because the
   * import cycle keeps the provider out of vitest and the reproduction above can be faithful to a
   * `cometapi.ts` that has since changed.
   *
   * The guard must sit BEFORE `createAnthropic(`, not merely somewhere in the file: a refusal after
   * the client is built is a different guarantee. `kie.ts` shipped this branch as an `else` for a
   * week, which was correct for exactly as long as every family it did not name was Claude — and the
   * `chat` family ended that.
   */
  it('refuses an unbound wire EXPLICITLY, before createAnthropic is reached', () => {
    const guardAt = code.indexOf("wire !== 'messages'");
    const clientAt = code.indexOf('createAnthropic(');

    expect(guardAt, 'control: the guard must exist as CODE, not only in a comment').toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(-1);
    expect(guardAt, 'a fallthrough would hand a chat/gemini id to the Anthropic wire').toBeLessThan(clientAt);

    // It THROWS — a warn-and-continue here is the fallthrough with a log line attached.
    expect(code.slice(guardAt, clientAt)).toContain('throw new Error(');

    // And it is exhaustive by TYPE, so a new `CometWire` member is a compile error, not a silent branch.
    expect(code.slice(guardAt, clientAt)).toMatch(/const exhaustive: never = wire;/);
  });
});
