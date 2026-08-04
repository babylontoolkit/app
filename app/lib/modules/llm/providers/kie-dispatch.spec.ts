/**
 * The KIE FAMILY DISPATCH (SPEC §4.2a, plan T7) — one provider, three protocols.
 *
 * `kie.ts`'s `getModelInstance` picks a wire from `requireFamily(model)`. The thing that must never
 * regress is FR3's guarantee: the Claude wrappers (`thinkingFetch`, `kieFetch`, `stripSamplingParams`,
 * `dropOrphanReasoningSignatures`) encode Anthropic wire facts, and any of them applied to another
 * family puts Anthropic-shaped fields in a foreign request body — a hard 400 before a token, on a model
 * the operator believes is configured. The reverse is equally binding: the Claude branch must keep
 * sending `thinking` + `thinkingFlag` + `output_config`, or KIE bills thinking and returns it empty.
 * So this file pins the 400-producing path DEAD IN BOTH DIRECTIONS, per family, on the serialized body.
 *
 * ## Why the dispatch is REPRODUCED here rather than imported (this is the weaker of two options)
 *
 * `kie.spec.ts`'s header records that importing `KieProvider` breaks vitest —
 * `base-provider -> manager -> registry -> providers -> base-provider` is an import cycle the bundler
 * tolerates and vitest does not. That was re-verified for THIS file (2026-08-04): a bare
 * `import('./kie')` fails at collection with `Class extends value undefined is not a constructor or
 * null` in `anthropic.ts`, reached through `registry.ts`. So `buildInstance` below reproduces the three
 * branches exactly as `kie.ts` wires them, in the established `capture()` style.
 *
 * A reproduction proves the WIRES are right and proves nothing about whether `kie.ts` still calls them
 * that way, so it is paired with a SOURCE SCAN (the last describe) that reads `kie.ts` and asserts the
 * branch structure — including that no Claude wrapper name appears anywhere in the two non-Claude
 * branches. The scan carries its own control, because a scanner that silently matches nothing reports a
 * clean bill of health forever.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type LanguageModelV1 } from 'ai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dropOrphanReasoningSignatures,
  stripSamplingParams,
  supportsSamplingParams,
  thinkingFetch,
  type EffortLevel,
  type ThinkingMode,
} from '~/lib/modules/llm/capabilities';
import { codexEffort, geminiThinkingLevel, requireFamily, FAMILY_POLICY } from '~/lib/modules/llm/model-families';
import { codexFetch, KIE_CODEX_BASE_URL } from './kie-codex-wire';
import { geminiFetch, KIE_GEMINI_BASE_URL } from './kie-gemini-wire';
import { kieEnvModel, kieFetch, KIE_DEFAULT_BASE_URL, KIE_MODELS } from './kie-wire';

/** The fields that are ONLY ever legal on the Anthropic wire. Any of them elsewhere is a 400. */
const ANTHROPIC_ONLY_BODY_FIELDS = ['thinking', 'thinkingFlag', 'output_config'] as const;

/* --------------------------------------------------------------------------------------------- */
/* Replayed streams — one per protocol, each copied from that family's own wire spec.             */
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

function responsesSse(model: string): Response {
  const events = [
    { type: 'response.created', response: { id: 'resp_1', created_at: 1_700_000_000, model } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', delta: 'ok' },
    {
      type: 'response.completed',
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];

  return new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`, {
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
/* The dispatch, reproduced exactly as `kie.ts` wires it.                                          */
/* --------------------------------------------------------------------------------------------- */

const API_KEY = 'kie-test-key';

interface Seen {
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  calls: number;
}

/**
 * Mirror of `getModelInstance`'s body: `requireFamily` FIRST (before any key lookup or wire build),
 * then the three branches. Keep this in step with `kie.ts` — the source scan below is what notices.
 */
function buildInstance(
  model: string,
  options: { mode?: ThinkingMode; effort?: EffortLevel },
  spy: typeof fetch,
): LanguageModelV1 {
  const family = requireFamily(model);
  const mode: ThinkingMode = options.mode ?? 'adaptive';
  const effort: EffortLevel = options.effort ?? 'medium';

  if (family === 'codex') {
    const codex = createOpenAI({
      apiKey: API_KEY,
      baseURL: KIE_CODEX_BASE_URL,
      headers: { Authorization: `Bearer ${API_KEY}` },
      fetch: codexFetch(codexEffort(mode, effort), spy),
    });

    return codex.responses(model);
  }

  if (family === 'gemini') {
    const gemini = createGoogleGenerativeAI({
      apiKey: API_KEY,
      baseURL: KIE_GEMINI_BASE_URL,
      headers: { Authorization: `Bearer ${API_KEY}` },
      fetch: geminiFetch(geminiThinkingLevel(mode, effort), spy),
    });

    return gemini(model);
  }

  const kie = createAnthropic({
    apiKey: API_KEY,
    baseURL: KIE_DEFAULT_BASE_URL,
    headers: { Authorization: `Bearer ${API_KEY}` },
    fetch: thinkingFetch(mode, effort, model, kieFetch(spy)),
  });

  const instance = supportsSamplingParams(model) ? kie(model) : stripSamplingParams(kie(model));

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

    const family = requireFamily(model);

    return family === 'codex' ? responsesSse(model) : family === 'gemini' ? geminiSse() : anthropicSse();
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

describe('the KIE family dispatch', () => {
  /*
   * 🔴 CODEX — the Anthropic fields must be ABSENT. `thinkingFetch` would write `thinking` and
   * `output_config` into an OpenAI Responses body and `kieFetch` would add KIE's Claude-adapter-only
   * `thinkingFlag`: a hard 400 before a token. Their absence is the FR3 guarantee, so it is asserted
   * field by field rather than inferred from "the branch looks different".
   */
  it('routes gpt-* to the Responses wire — reasoning.effort present, every Anthropic field absent', async () => {
    const seen = await capture('gpt-5-6-sol');

    expect(seen.body.reasoning?.effort).toBe('medium');
    expect(seen.url).toBe(`${KIE_CODEX_BASE_URL}/responses`);

    for (const field of ANTHROPIC_ONLY_BODY_FIELDS) {
      expect(seen.body[field], `${field} must never appear on the Responses wire`).toBeUndefined();
    }
  });

  /*
   * 🔴 GEMINI — same guarantee on the third protocol. The native Gemini body has no room for any of
   * these, and KIE's gateway rejects the request rather than ignoring them.
   */
  it('routes gemini-* to the native Gemini wire — thinkingConfig present, every Anthropic field absent', async () => {
    const seen = await capture('gemini-3-5-flash');

    expect(seen.body.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'low' });
    expect(seen.url).toContain(`${KIE_GEMINI_BASE_URL}/models/gemini-3-5-flash:streamGenerateContent`);

    for (const field of ANTHROPIC_ONLY_BODY_FIELDS) {
      expect(seen.body[field], `${field} must never appear on the Gemini wire`).toBeUndefined();
    }
  });

  /*
   * 🔴 CLAUDE — UNCHANGED. This is the other direction of the same wall: the dispatcher must not have
   * quietly cost the Claude branch its wrappers. Losing `thinkingFlag` alone means KIE bills every
   * thinking token and returns the text empty, which throws nothing and shows nothing.
   */
  it('routes claude-* to the Anthropic wire — thinking, thinkingFlag and output_config all intact', async () => {
    const seen = await capture('claude-opus-5');

    expect(seen.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(seen.body.thinkingFlag).toBe(true);
    expect(seen.body.output_config?.effort).toBe('medium');
    expect(seen.url).toBe(`${KIE_DEFAULT_BASE_URL}/messages`);
  });

  /* Every family authenticates on `Authorization: Bearer` — the SDKs' own auth headers are all wrong for KIE. */
  it.each(['claude-opus-5', 'gpt-5-6-sol', 'gemini-3-5-flash'])('sends Authorization: Bearer for %s', async (model) => {
    const seen = await capture(model);

    expect(seen.headers?.authorization).toBe(`Bearer ${API_KEY}`);
  });

  /*
   * CONTROL for all of the above. Every "must be absent" assertion is satisfied by a request that never
   * happened, so if the stack ever stopped reaching the wire the FR3 pins would pass vacuously and this
   * is the test that says so.
   */
  it.each(['claude-opus-5', 'gpt-5-6-sol', 'gemini-3-5-flash'])(
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
   * 🔴 The refusal must land at MODEL RESOLUTION, not at the request. Before `requireFamily`, a `gpt-*`
   * id fell through `capabilities.ts`'s Claude-shaped tables and was handed an Anthropic `thinking`
   * block inside a foreign body — a 400 after the key lookup, after the wire was built, and attributed
   * to the wrong thing. `llama-3` stands in for any id nothing claims.
   */
  it('throws naming the id and every accepted prefix, and never touches fetch', async () => {
    let calls = 0;
    const spy: typeof fetch = async () => {
      calls += 1;
      return anthropicSse();
    };

    expect(() => buildInstance('llama-3', {}, spy)).toThrow(/llama-3/);
    expect(() => buildInstance('llama-3', {}, spy)).toThrow(/claude-\*.*gpt-\*.*gemini-\*/s);
    expect(calls, 'the refusal must precede every request').toBe(0);
  });
});

describe('thinkingMode: disabled reaches each wire in that family’s own vocabulary', () => {
  /*
   * The proxy's last-resort retry (`retry-policy.ts`) passes `thinkingMode: 'disabled'` — and until
   * 2026-08-04 `kie.ts` dropped it on the floor as an excess property, making the mitigation a live
   * no-op on the default platform provider. Each wire expresses "as little thinking as possible"
   * differently, and NONE of them may express it with a field that 400s.
   */
  it('claude: thinking {type: disabled}', async () => {
    const seen = await capture('claude-opus-4-8', { mode: 'disabled' });

    expect(seen.body.thinking).toEqual({ type: 'disabled' });
    expect(seen.body.thinkingFlag).toBe(true);
  });

  /*
   * 🔴 THE CLAMP SURVIVES THE DISPATCH. `canDisableThinking` refuses `{type:'disabled'}` for
   * `claude-fable-5` outright and for `claude-opus-5` above effort `high` — both are hard 400s, and both
   * would land on the attempt that has already failed twice. The dispatcher must not have bypassed it.
   */
  it.each([
    ['claude-fable-5', 'medium' as EffortLevel],
    ['claude-opus-5', 'xhigh' as EffortLevel],
    ['claude-opus-5', 'max' as EffortLevel],
  ])('claude: %s at effort %s stays ADAPTIVE — the canDisableThinking clamp holds', async (model, effort) => {
    const seen = await capture(model, { mode: 'disabled', effort });

    expect(seen.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  /* The Responses wire has no off switch — `low` is the floor, and an invented value would 400. */
  it('codex: reasoning.effort low', async () => {
    const seen = await capture('gpt-5-6-luna', { mode: 'disabled', effort: 'max' });

    expect(seen.body.reasoning?.effort).toBe('low');
    expect(seen.body.thinking).toBeUndefined();
  });

  /* Gemini likewise: two levels, so `disabled` takes the lower one rather than an unsupported value. */
  it('gemini: thinkingLevel low', async () => {
    const seen = await capture('gemini-3-5-flash', { mode: 'disabled', effort: 'max' });

    expect(seen.body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'low' });
    expect(seen.body.thinking).toBeUndefined();
  });
});

describe('kieEnvModel sources its token limits from the family policy', () => {
  /*
   * The limits were two inline literals — the CLAUDE numbers — which would silently attribute Claude's
   * context window to a `gpt-*` or `gemini-*` operator override. Asserted against `FAMILY_POLICY` and
   * never against literals: the three families happen to share these numbers today, so a literal here
   * would pass for the wrong reason the moment one of them moves.
   */
  it.each([
    ['gpt-9-9-probe', 'codex' as const],
    ['gemini-9-9-probe', 'gemini' as const],
    ['claude-9-9-probe', 'claude' as const],
  ])('%s takes the %s policy limits', (name, family) => {
    const info = kieEnvModel({ LLM_MODEL: name });

    expect(info?.name).toBe(name);
    expect(info?.maxTokenAllowed).toBe(FAMILY_POLICY[family].maxTokenAllowed);
    expect(info?.maxCompletionTokens).toBe(FAMILY_POLICY[family].maxCompletionTokens);
  });

  /*
   * An UNKNOWN family still gets a `ModelInfo` (falling back to the claude policy) on purpose: refusing
   * here would leave the id out of the provider list, which is the `modelsList[0]` mis-bill this
   * function exists to prevent. `getModelInstance` is where it refuses, loudly, naming the id.
   */
  it('still lists an unknown-family override rather than silently omitting it', () => {
    expect(kieEnvModel({ LLM_MODEL: 'llama-3' })?.name).toBe('llama-3');
  });

  /* CONTROL: a listed model returns undefined, so the assertions above are reading the synthesis path. */
  it('returns undefined for an already-listed model (control)', () => {
    expect(kieEnvModel({ LLM_MODEL: KIE_MODELS[0].name })).toBeUndefined();
  });
});

/**
 * The reproduction above proves the three WIRES behave; it cannot prove `kie.ts` still calls them that
 * way, because the import cycle keeps `KieProvider` out of vitest. This scan closes that gap by reading
 * the source, and carries its own control — a scan that silently matches nothing is not a weak test, it
 * is no test.
 */
describe('kie.ts really wires the branches this spec reproduces', () => {
  const source = readFileSync(join(process.cwd(), 'app/lib/modules/llm/providers/kie.ts'), 'utf8');

  /*
   * 🔴 THE PARAMETER MUST BE READ, NOT MERELY DECLARED.
   *
   * `thinkingMode` was in `anthropic.ts`'s signature and ABSENT from KIE's, so the proxy's last-resort
   * retry (`proxy.ts`, `retry-policy.ts`) passed it and it was dropped on the floor as an excess
   * property — a silent no-op on the default platform provider, on the one attempt that exists because
   * the previous two were killed by KIE's ~30s silent-step timeout.
   *
   * ⚠️ Declaring the parameter and pinning `thinkingFetch(thinkingMode, ...)` does NOT catch that:
   * both stay true when the resolution ignores `options.thinkingMode` and reads only the env var. The
   * defect is precisely in the `??`, so the `??` is what is pinned. (Behaviourally unreachable here —
   * `kie.ts` cannot be imported under vitest; see this describe's header.)
   */
  it('READS options.thinkingMode — declaring it is not the same as honouring it', () => {
    expect(code).toMatch(/thinkingMode\?:\s*ThinkingMode/);

    /*
     * Bound to the DECLARATION, not floating: a bare `toContain('options.thinkingMode ??')` passes for
     * any occurrence anywhere, so a decoy line elsewhere in the file would satisfy it while the real
     * resolution went back to reading only the env var. Verified: with the loose form, a `const _decoy
     * = options.thinkingMode ?? 'adaptive'` kept the suite green.
     */
    expect(code, 'the retry-with-thinking-disabled parameter must win over the env default').toMatch(
      /const thinkingMode: ThinkingMode\s*=\s*options\.thinkingMode \?\?/,
    );
  });

  /*
   * ⚠️ Scanned over the COMMENT-STRIPPED source, and that is load-bearing rather than tidy.
   *
   * The first draft of this test used `source.indexOf('requireFamily(model)')` — and the file's own
   * header comment says *"picks the wire from `requireFamily(model)`"*, so `indexOf` returned that
   * line-9 offset no matter where the real call sat. The assertion could not fail: moving
   * `requireFamily` below the key lookup left all 38 tests green. A scan that decides WHERE code runs
   * must never be able to match the prose describing it.
   */
  it('resolves the family BEFORE the key lookup — an unknown id must never reach a guessed wire', () => {
    const familyAt = code.indexOf('requireFamily(model)');
    const keyLookupAt = code.indexOf('getProviderBaseUrlAndKey');

    expect(familyAt, 'control: the call must exist as CODE, not only in a comment').toBeGreaterThan(-1);
    expect(keyLookupAt).toBeGreaterThan(-1);
    expect(familyAt).toBeLessThan(keyLookupAt);
  });

  /*
   * ⚠️ `code`, not `source` — the same reason as the ordering scan above. None of these literals sits
   * in a comment TODAY, so scanning the raw source would not be vacuous yet; it would become vacuous
   * the first time someone documented a wiring line by quoting it. Closing the class costs one word.
   */
  it('binds each family to its own wire builder', () => {
    expect(code).toContain('codexFetch(codexEffort(thinkingMode, effort)');
    expect(code).toContain('baseURL: KIE_CODEX_BASE_URL');
    expect(code).toContain('.responses(model)');

    expect(code).toContain('geminiFetch(geminiThinkingLevel(thinkingMode, effort)');
    expect(code).toContain('baseURL: KIE_GEMINI_BASE_URL');

    expect(code).toContain('thinkingFetch(thinkingMode, effort, model, kieFetch(');
  });

  /*
   * 🔴 FR3 AS A DEFAULT-DENY SCAN: no Claude wrapper name may appear as CODE anywhere between the start
   * of the codex branch and the start of the Claude one. Do not silence a failure here by narrowing the
   * slice.
   *
   * Comments are stripped first, and that is not a convenience: both non-Claude branches deliberately
   * NAME the wrappers in prose to explain why they are absent, so an un-stripped scan fails on the very
   * documentation that records the rule — and the tempting fix (delete the explanation) trades a real
   * comment for a passing test.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const nonClaudeBranches = code.slice(code.indexOf("if (family === 'codex')"), code.indexOf('createAnthropic('));

  it.each(['thinkingFetch', 'kieFetch', 'stripSamplingParams', 'dropOrphanReasoningSignatures'])(
    'never applies the Claude wrapper %s to a non-Claude family',
    (wrapper) => {
      expect(nonClaudeBranches).not.toContain(wrapper);
    },
  );

  /* CONTROL: the slice above is a real region of a real file, not an empty string that matches nothing. */
  it('read a real slice of kie.ts (control for the default-deny scan)', () => {
    expect(nonClaudeBranches.length).toBeGreaterThan(200);
    expect(nonClaudeBranches).toContain('codexFetch');
    expect(nonClaudeBranches).toContain('geminiFetch');
  });
});
