/**
 * KIE's GPT surface — wire-level rules (SPEC §4.2a, plan T5).
 *
 * Driven the way `kie.spec.ts` drives the Claude wire: the REAL `@ai-sdk/openai` Responses model fed to
 * the REAL `streamText`, against a replayed Responses-wire SSE `Response`, asserting on the SERIALIZED
 * REQUEST BODY a spy fetch saw. Asserting on our own intermediate objects would prove nothing — these
 * bugs live between us and KIE.
 *
 * The headline rule fails SILENTLY and costs money: `@ai-sdk/openai@1.3.24` only emits
 * `reasoning.effort` when the caller passes `providerOptions.openai.reasoningEffort` AND its internal
 * id heuristic classifies the model as a reasoning model. We pass neither, so without `codexFetch` the
 * body carries no effort at all and the request buys whatever KIE's gateway defaults to — the same
 * pathology `thinkingFetch` exists to kill on the Claude side. The last test here is the control that
 * proves it.
 *
 * NOTE: imports `kie-codex-wire` rather than `KieProvider`, for the import-cycle reason that module's
 * doc comment records.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import type { EffortLevel, ThinkingMode } from '~/lib/modules/llm/capabilities';
import { codexEffort } from '~/lib/modules/llm/model-families';
import { codexFetch, KIE_CODEX_BASE_URL } from './kie-codex-wire';

const MODEL = 'gpt-5-6-sol';

/**
 * A minimal OpenAI **Responses** SSE stream — every event shape read from
 * `@ai-sdk/openai@1.3.24`'s `openaiResponsesChunkSchema` rather than from documentation. The parser is
 * `createEventSourceResponseHandler`, which reads `data:` lines only (an `event:` line is ignored), so
 * the fixture carries just the four events the transform actually acts on.
 */
function sseResponse(): Response {
  const events = [
    { type: 'response.created', response: { id: 'resp_1', created_at: 1_700_000_000, model: MODEL } },
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

/** Drive the REAL provider stack the way `kie.ts` wires the codex family, and capture what lands on the wire. */
async function capture(options: { wrap?: boolean; mode?: ThinkingMode; effort?: EffortLevel } = {}) {
  const { wrap = true, mode = 'adaptive', effort = 'medium' } = options;
  const seen: { url?: string; headers?: Record<string, string>; body?: any } = {};

  const spy: typeof fetch = async (input, init) => {
    seen.url = typeof input === 'string' ? input : String((input as Request).url ?? input);
    seen.headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    seen.body = init?.body ? JSON.parse(init.body as string) : undefined;

    return sseResponse();
  };

  const kie = createOpenAI({
    apiKey: 'kie-test-key',
    baseURL: KIE_CODEX_BASE_URL,
    headers: { Authorization: 'Bearer kie-test-key' },
    fetch: wrap ? codexFetch(codexEffort(mode, effort), spy) : spy,
  });

  const result = streamText({ model: kie.responses(MODEL), messages: [{ role: 'user', content: 'hi' }] });

  // Drain — the request is not sent until the stream is consumed.
  for await (const _ of result.textStream) {
    void _;
  }

  return seen;
}

describe('the KIE codex (OpenAI Responses) wire format', () => {
  /*
   * 🔴 THE ONE THAT COSTS MONEY SILENTLY — parameterized over EVERY mapping `codexEffort` can produce,
   * driven THROUGH the mapper so the mapping and the wire are pinned together. A mapper that starts
   * returning the wrong value, or a wrapper that stops writing it, both fail here.
   */
  const cases: Array<[ThinkingMode, EffortLevel, string]> = [
    ['adaptive', 'medium', 'medium'],
    ['adaptive', 'high', 'high'],
    ['adaptive', 'xhigh', 'xhigh'],
    ['adaptive', 'max', 'xhigh'],
    ['disabled', 'medium', 'low'],
    ['disabled', 'high', 'low'],
    ['disabled', 'xhigh', 'low'],
    ['disabled', 'max', 'low'],
  ];

  it.each(cases)('sends reasoning.effort for mode %s / effort %s → %s', async (mode, effort, expected) => {
    expect(codexEffort(mode, effort)).toBe(expected);

    const seen = await capture({ mode, effort });

    expect(seen.body.reasoning?.effort).toBe(expected);
  });

  /*
   * CONTROL. If the assertions above ever pass because nothing reached the wire, or the body stopped
   * being JSON, this fails first and says so. A suite that silently asserts nothing reports a clean bill
   * of health forever.
   */
  it('actually reaches the wire (control for the assertions above)', async () => {
    const seen = await capture();

    expect(seen.body).toBeDefined();
    expect(seen.body.model).toBe(MODEL);
    expect(seen.body.input).toHaveLength(1);
    expect(seen.body.stream).toBe(true);
  });

  /* The SDK appends `/responses`, so a baseURL without `/v1` POSTs to `/codex/responses` and 404s. */
  it('targets the Responses endpoint under /v1', async () => {
    const seen = await capture();

    expect(KIE_CODEX_BASE_URL).toBe('https://api.kie.ai/codex/v1');
    expect(seen.url).toBe('https://api.kie.ai/codex/v1/responses');
  });

  /* KIE authenticates on Bearer; `createOpenAI`'s own key handling is not what KIE reads. */
  it('authenticates with Authorization: Bearer', async () => {
    const seen = await capture();

    expect(seen.headers?.authorization).toBe('Bearer kie-test-key');
  });

  /*
   * 🔴 PROVES THE WRAPPER IS LOAD-BEARING. Without `codexFetch` the body carries no `reasoning` at all:
   * the SDK emits it only when `providerOptions.openai.reasoningEffort` is set, which nothing on this
   * path sets. The failure mode is silent — a request that buys the gateway's default effort.
   */
  it('carries NO reasoning.effort without codexFetch (the bug the wrapper exists to kill)', async () => {
    const seen = await capture({ wrap: false });

    expect(seen.body).toBeDefined();
    expect(seen.body.reasoning?.effort).toBeUndefined();
  });
});

describe('codexFetch', () => {
  /* MERGED, never replaced — a body already carrying `reasoning.summary` keeps it. */
  it('merges into an existing reasoning object rather than replacing it', async () => {
    let sentBody: any;
    const pass: typeof fetch = async (_i, init) => {
      sentBody = JSON.parse(init!.body as string);
      return new Response('ok');
    };

    await codexFetch('high', pass)('https://x.test', {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, reasoning: { summary: 'auto' } }),
    });

    expect(sentBody.reasoning).toEqual({ summary: 'auto', effort: 'high' });
  });

  /* A rewrite must never be the thing that breaks a generation — same rule as `kieFetch`. */
  it('passes a non-JSON string body through byte-identically', async () => {
    let seenBody: any;
    const pass: typeof fetch = async (_i, init) => {
      seenBody = init?.body;
      return new Response('ok');
    };

    await codexFetch('medium', pass)('https://x.test', { method: 'POST', body: 'not json at all' });
    expect(seenBody).toBe('not json at all');
  });

  it('passes a non-string body through untouched', async () => {
    const blob = new Uint8Array([1, 2, 3]);
    let seenBody: any;
    const pass: typeof fetch = async (_i, init) => {
      seenBody = init?.body;
      return new Response('ok');
    };

    await codexFetch('medium', pass)('https://x.test', { method: 'POST', body: blob });
    expect(seenBody).toBe(blob);
  });
});
