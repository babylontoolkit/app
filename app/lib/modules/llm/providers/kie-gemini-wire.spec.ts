/**
 * KIE's Gemini surface — the wire rules, driven against the REAL `@ai-sdk/google` + `streamText` stack.
 *
 * Same shape and the same reason as `kie.spec.ts`: these bugs live BETWEEN us and KIE, so asserting on
 * our own intermediate objects would prove nothing — every assertion here reads the serialized request
 * body a spy `fetch` saw. And the same import note: this drives `kie-gemini-wire` rather than the
 * provider, because `base-provider -> manager -> registry -> providers -> base-provider` is an import
 * cycle vitest will not tolerate.
 *
 * The headline rule is the merge: `generationConfig` already carries what the SDK put there, so a
 * replace instead of a merge silently drops the token cap — nothing throws, the generation just runs
 * uncapped.
 */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import type { EffortLevel, ThinkingMode } from '~/lib/modules/llm/capabilities';
import { geminiThinkingLevel } from '~/lib/modules/llm/model-families';
import { geminiFetch, KIE_GEMINI_BASE_URL } from './kie-gemini-wire';

/**
 * A minimal NATIVE-Gemini SSE stream — enough for `@ai-sdk/google@1.2.22` to consume without erroring.
 *
 * Built from the SDK source, not from documentation: `doStream` requests `?alt=sse` and hands the body
 * to `createEventSourceResponseHandler(chunkSchema)`, which parses bare `data:` lines (no `event:`) and
 * validates each against `{candidates[].content.parts[].text, finishReason, usageMetadata}`. The success
 * handler never inspects the content-type — only the status code — so the header below is honesty, not
 * a requirement.
 */
function geminiSseResponse(): Response {
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

/** Drive the REAL provider stack the way the Gemini family wires it, and capture what lands on the wire. */
async function capture(options?: { thinkingLevel?: string; wrap?: boolean; maxTokens?: number }) {
  const { thinkingLevel = 'low', wrap = true, maxTokens = 4096 } = options ?? {};
  const model = 'gemini-3-pro';
  const seen: { url?: string; headers?: Record<string, string>; body?: any } = {};

  const spy: typeof fetch = async (input, init) => {
    seen.url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    seen.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    seen.body = init?.body ? JSON.parse(init.body as string) : undefined;

    return geminiSseResponse();
  };

  const kie = createGoogleGenerativeAI({
    apiKey: 'kie-test-key',
    baseURL: KIE_GEMINI_BASE_URL,
    headers: { Authorization: 'Bearer kie-test-key' },
    fetch: wrap ? geminiFetch(thinkingLevel, spy) : spy,
  });

  const result = streamText({ model: kie(model), messages: [{ role: 'user', content: 'hi' }], maxTokens });

  // Drain — the request is not sent until the stream is consumed.
  for await (const _ of result.textStream) {
    void _;
  }

  return seen;
}

describe('the KIE Gemini wire format', () => {
  /*
   * 🔴 THE ONE THAT COSTS MONEY SILENTLY.
   *
   * `@ai-sdk/google@1.2.22` knows only `thinkingBudget`, so there is no `providerOptions` value that
   * produces this shape — `fetch` is the seam. Without `includeThoughts`, KIE bills every thinking token
   * and returns no readable trace of the reasoning, which is the §4.2a pathology exactly.
   *
   * Parameterized over EVERY mapping in `geminiThinkingLevel`, and the value is PRODUCED by that mapper
   * rather than written as a literal — so the mapper and the wire are pinned together and cannot drift.
   */
  const cases: Array<{ mode: ThinkingMode; effort: EffortLevel; expected: string }> = [
    { mode: 'adaptive', effort: 'medium', expected: 'low' },
    { mode: 'adaptive', effort: 'high', expected: 'high' },
    { mode: 'adaptive', effort: 'xhigh', expected: 'high' },
    { mode: 'adaptive', effort: 'max', expected: 'high' },
    { mode: 'disabled', effort: 'high', expected: 'low' },
  ];

  it.each(cases)('sends thinkingConfig for $mode/$effort → $expected', async ({ mode, effort, expected }) => {
    const level = geminiThinkingLevel(mode, effort);
    expect(level).toBe(expected);

    const seen = await capture({ thinkingLevel: level });

    expect(seen.body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: expected });
  });

  /*
   * 🔴 MERGED, NEVER REPLACED. `maxOutputTokens` is put there by the SDK from `streamText`'s `maxTokens`;
   * a replace drops the token cap and nothing throws — the generation simply runs uncapped on our bill.
   */
  it('MERGES thinkingConfig into generationConfig — the SDK-set maxOutputTokens survives', async () => {
    const seen = await capture({ maxTokens: 4096 });

    expect(seen.body.generationConfig.maxOutputTokens).toBe(4096);
    expect(seen.body.generationConfig.thinkingConfig.includeThoughts).toBe(true);
  });

  /*
   * CONTROL. If the assertions above ever pass because the wrapper stopped being applied, this fails
   * first and says so. A suite that silently asserts nothing reports a clean bill of health forever.
   */
  it('carries NO thinkingConfig without geminiFetch (control — the wrapper is load-bearing)', async () => {
    const seen = await capture({ wrap: false });

    expect(seen.body.generationConfig.maxOutputTokens).toBe(4096);
    expect(seen.body.generationConfig.thinkingConfig).toBeUndefined();
  });

  /* A baseURL without `/v1` composes `/gemini/models/...` and 404s. The SDK appends its own `?alt=sse`. */
  it('targets /gemini/v1/models/<id>:streamGenerateContent', async () => {
    const seen = await capture();

    expect(new URL(seen.url!).pathname).toBe('/gemini/v1/models/gemini-3-pro:streamGenerateContent');
  });

  /* `createGoogleGenerativeAI` only ever sends `x-goog-api-key`, which KIE ignores — every request 401s. */
  it('authenticates with Authorization: Bearer, which the Google provider never sends', async () => {
    const seen = await capture();

    expect(seen.headers?.authorization).toBe('Bearer kie-test-key');
  });
});

describe('geminiFetch', () => {
  /* A body rewrite must never be the thing that breaks a generation — same rule as `kieFetch`. */
  it('passes a non-JSON string body through untouched rather than throwing', async () => {
    let seenBody: any;
    const pass: typeof fetch = async (_i, init) => {
      seenBody = init?.body;
      return new Response('ok');
    };

    await geminiFetch('low', pass)('https://x.test', { method: 'POST', body: 'not json at all' });
    expect(seenBody).toBe('not json at all');
  });

  it('passes a non-string body through untouched', async () => {
    const blob = new Uint8Array([1, 2, 3]);
    let seenBody: any;
    const pass: typeof fetch = async (_i, init) => {
      seenBody = init?.body;
      return new Response('ok');
    };

    await geminiFetch('low', pass)('https://x.test', { method: 'POST', body: blob });
    expect(seenBody).toBe(blob);
  });
});
