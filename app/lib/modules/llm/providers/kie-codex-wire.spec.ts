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
import { streamText, tool } from 'ai';
import { z } from 'zod';
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
async function capture(
  options: { wrap?: boolean; mode?: ThinkingMode; effort?: EffortLevel; withTools?: boolean } = {},
) {
  const { wrap = true, mode = 'adaptive', effort = 'medium', withTools = false } = options;
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

  /*
   * A real tool, declared the way the proxy declares `load_skill` — a zod schema through the `ai`
   * helper. It matters that this goes through the SDK's own serializer rather than being hand-written:
   * `strict: true` is something the SDK ADDS (`isStrict`, defaulting true on the Responses model), so
   * a hand-built tools array would never carry the field the fix removes.
   */
  const tools = withTools
    ? {
        load_skill: tool({
          description: 'Load the full instructions for a skill.',
          parameters: z.object({ name: z.string().describe('The skill name.') }),
          execute: async () => 'ok',
        }),
      }
    : undefined;

  const result = streamText({
    model: kie.responses(MODEL),
    messages: [{ role: 'user', content: 'hi' }],
    tools,
  });

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

/**
 * 🔴 `strict: true` ON A FUNCTION TOOL IS A DEAD GENERATION ON KIE'S CODEX GATEWAY (measured live,
 * 2026-08-04) — and it broke EVERY tool-bearing generation on this family from the day it shipped.
 *
 * KIE answers it with **HTTP 200 and `{"code":400,"msg":"The server is currently being maintained,
 * please try again later~"}`** — no SSE events. The SDK sees a 200 with an empty stream and finishes
 * cleanly, so nothing throws: the user gets `proxy.ts`'s *"The model returned an empty response"*,
 * `NaN` token counts (no `response.completed` to read `usage` from), and a refund. Bisected from a
 * captured production body at 6 samples per variant: no tools 6/6 ok, `strict: true` **0/6**,
 * `strict: false` 6/6, `strict` absent 6/6, and `strict: true` with `$schema` removed still 0/6 — so
 * it is the flag, not the schema dialect.
 *
 * The CONTROL below is the load-bearing half. `strict: true` is added by the SDK, not by us, so a test
 * that only asserts its absence passes just as well against an SDK that stopped emitting it, a tools
 * array that never reached the wire, or a `capture()` that quietly dropped the tool. The control
 * proves the field is really there to be stripped.
 */
describe('the `strict` flag KIE rejects', () => {
  it('never sends `strict` on a tool, through the real SDK serializer', async () => {
    const seen = await capture({ withTools: true });

    expect(seen.body.tools, 'the tool must actually reach the wire, or this asserts nothing').toHaveLength(1);
    expect(seen.body.tools[0].name).toBe('load_skill');
    expect(seen.body.tools[0]).not.toHaveProperty('strict');

    // The rest of the tool is untouched — this is a surgical key removal, not a rewrite.
    expect(seen.body.tools[0].type).toBe('function');
    expect(seen.body.tools[0].parameters?.properties?.name).toBeDefined();
  });

  it('CONTROL — the unwrapped SDK really does send `strict: true` (so the strip is load-bearing)', async () => {
    const seen = await capture({ withTools: true, wrap: false });

    expect(seen.body.tools[0].strict).toBe(true);
  });

  it('leaves a body with no tools completely alone', async () => {
    const seen = await capture();

    expect(seen.body.tools).toBeUndefined();
  });
});

describe('codexFetch', () => {
  /*
   * The strip is defensive about SHAPE for the same reason the JSON parse is: a body we do not
   * understand is passed through rather than guessed at. A `tools` value that is not an array, or an
   * entry that is not an object, must not throw — that would turn a wire quirk into a dead generation,
   * which is precisely what this function exists to prevent.
   */
  it('tolerates a non-array `tools` and entries that are not objects', async () => {
    let sent: any;
    const pass: typeof fetch = async (_i, init) => {
      sent = JSON.parse(init!.body as string);
      return new Response('ok');
    };

    await codexFetch('medium', pass)('https://x.test', {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, tools: 'not-an-array' }),
    });
    expect(sent.tools).toBe('not-an-array');

    await codexFetch('medium', pass)('https://x.test', {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, tools: [null, 'x', { type: 'function', strict: true, name: 'a' }] }),
    });
    expect(sent.tools[0]).toBeNull();
    expect(sent.tools[1]).toBe('x');
    expect(sent.tools[2]).toEqual({ type: 'function', name: 'a' });
  });

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
