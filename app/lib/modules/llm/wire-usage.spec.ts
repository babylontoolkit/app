/**
 * Bill the step in flight (`_specs/no-unbilled-usage_plan.md` D7, T7).
 *
 * Driven through the REAL `ai@4` `streamText` and the REAL `@ai-sdk/anthropic` adapter, with only the
 * network replaced by a scripted Anthropic SSE fetch — because the property under test is a disagreement
 * between the two: the SDK reports a step's usage only when the step FINISHES, while the provider bills it
 * from `message_start`. A unit test of the tap alone could not show that the SDK really drops a broken
 * step, nor that the SDK's `response.id` is the key the tap records (the no-double-count CONTROL).
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addUnreportedUsage,
  applyWireEvent,
  createWireUsageRecorder,
  tapWireUsage,
  unreportedWireUsage,
  type WireUsageRecorder,
} from './wire-usage';

const MODEL = 'claude-sonnet-5';

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

const U1: Usage = { input: 100, output: 42, cacheRead: 5000, cacheWrite: 300 };
const U2: Usage = { input: 60, output: 17, cacheRead: 5300, cacheWrite: 0 };

const sse = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function messageStart(id: string, u: Usage) {
  return sse({
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: u.input,
        output_tokens: 1,
        cache_read_input_tokens: u.cacheRead,
        cache_creation_input_tokens: u.cacheWrite,
      },
    },
  });
}

const textBlock = (text: string) =>
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
  sse({ type: 'content_block_stop', index: 0 });

const toolBlock = (id: string) =>
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'look', input: {} } }) +
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"what":"x"}' } }) +
  sse({ type: 'content_block_stop', index: 0 });

const finish = (stop: string, u: Usage) =>
  sse({
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: u.output },
  }) + sse({ type: 'message_stop' });

/** One scripted response: the body, and whether it breaks (errors) or hangs until the request aborts. */
interface Scripted {
  body: string;
  end?: 'close' | 'break' | 'hang';
}

function scriptedFetch(responses: Scripted[]): typeof fetch {
  let i = 0;

  return (async (_input: unknown, init?: RequestInit) => {
    const next = responses[i++];

    if (!next) {
      throw new Error('no scripted response left');
    }

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(next.body));

        if (next.end === 'break') {
          /* After the bytes were delivered — `error()` discards whatever is still queued, a real reset does not. */
          setTimeout(() => controller.error(new TypeError('network connection was reset')), 30);
        } else if (next.end === 'hang') {
          const abort = () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));

          if (init?.signal?.aborted) {
            abort();
          } else {
            init?.signal?.addEventListener('abort', abort, { once: true });
          }
        } else {
          controller.close();
        }
      },
    });

    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

function modelOver(recorder: WireUsageRecorder, responses: Scripted[]) {
  return createAnthropic({ apiKey: 'test-not-real', fetch: tapWireUsage(recorder, scriptedFetch(responses)) })(MODEL);
}

const lookTool = { look: tool({ parameters: z.object({ what: z.string() }), execute: async () => 'seen' }) };

/** Consume a streamText the way the proxy's drain does; returns the steps the SDK reported. */
async function run(
  model: ReturnType<typeof modelOver>,
  options: { abort?: AbortController; abortOnSecondStep?: boolean } = {},
) {
  const reported: Array<{ id: string; usage: { promptTokens: number; completionTokens: number } }> = [];
  let error: unknown;
  let steps = 0;

  const result = streamText({
    model,
    prompt: 'go',
    tools: lookTool,
    maxSteps: 3,
    abortSignal: options.abort?.signal,
    onStepFinish: (step) => {
      steps += 1;
      reported.push({ id: step.response.id, usage: step.usage });

      if (options.abortOnSecondStep && steps === 1) {
        setTimeout(() => options.abort?.abort(), 20);
      }
    },
  });

  try {
    for await (const part of result.fullStream) {
      if (part.type === 'error') {
        throw part.error;
      }
    }
  } catch (e) {
    error = e;
  }

  return { reported, error };
}

const wire = (u: Usage) => ({ promptTokens: u.input, cacheReadTokens: u.cacheRead, cacheCreationTokens: u.cacheWrite });

describe('a step that breaks after message_start (D7)', () => {
  it('the SDK reports NOTHING for it — and the wire bills its input, cache and streamed output', async () => {
    const recorder = createWireUsageRecorder();
    const model = modelOver(recorder, [{ body: messageStart('msg_1', U1) + textBlock('x'.repeat(400)), end: 'break' }]);

    const { reported, error } = await run(model);

    expect(error, 'the stream broke').toBeDefined();
    expect(reported, 'the SDK reports no usage for a step that never finished (the gap)').toEqual([]);

    await recorder.settled();

    const extra = unreportedWireUsage(
      recorder.attempts,
      reported.map((s) => s.id),
    );

    expect(extra).toMatchObject({ attempts: 1, ...wire(U1) });
    expect(extra.completionTokens, 'the streamed output is billed at the conservative floor').toBe(100);
  });

  it('a provider-retry attempt that broke after message_start is billed; the attempt that finished is not counted twice', async () => {
    const recorder = createWireUsageRecorder();
    const model = modelOver(recorder, [
      { body: messageStart('msg_broken', U1), end: 'break' },
      { body: messageStart('msg_ok', U2) + textBlock('done') + finish('end_turn', U2) },
    ]);

    const first = await run(model);
    const second = await run(model);

    expect(first.error).toBeDefined();
    expect(second.error).toBeUndefined();
    expect(second.reported.map((s) => s.id)).toEqual(['msg_ok']);

    await recorder.settled();

    const extra = unreportedWireUsage(
      recorder.attempts,
      [...first.reported, ...second.reported].map((s) => s.id),
    );

    expect(extra).toMatchObject({ attempts: 1, ...wire(U1), completionTokens: 1 });
  });

  it('tool loop OFF, aborted mid-turn: both the finished tool step and the step in flight are billed', async () => {
    const recorder = createWireUsageRecorder();
    const abort = new AbortController();
    const model = modelOver(recorder, [
      { body: messageStart('msg_tool', U1) + toolBlock('toolu_1') + finish('tool_use', U1) },
      { body: messageStart('msg_answer', U2) + textBlock('y'.repeat(80)), end: 'hang' },
    ]);

    const { reported, error } = await run(model, { abort, abortOnSecondStep: true });

    expect(error, 'the Stop aborted the stream').toBeDefined();

    /*
     * The tool-loop-off drain bills from `result.steps` only after the stream finishes — an aborted stream
     * never gets there, so NOTHING was billed for this turn: the reported set is empty.
     */
    await recorder.settled();

    const extra = unreportedWireUsage(recorder.attempts, []);

    expect(extra.attempts).toBe(2);
    expect(extra.promptTokens).toBe(U1.input + U2.input);
    expect(extra.cacheReadTokens).toBe(U1.cacheRead + U2.cacheRead);
    expect(extra.cacheCreationTokens).toBe(U1.cacheWrite + U2.cacheWrite);
    expect(extra.completionTokens).toBe(U1.output + 20);

    /* And had the finished tool step been billed by the SDK path, only the step in flight is added. */
    expect(
      unreportedWireUsage(
        recorder.attempts,
        reported.map((s) => s.id),
      ),
    ).toMatchObject({
      attempts: 1,
      ...wire(U2),
    });
  });
});

describe('CONTROL — a normal multi-step turn bills exactly what the SDK reported', () => {
  it('every step finished: the SDK ids are the wire ids, and nothing is added', async () => {
    const recorder = createWireUsageRecorder();
    const model = modelOver(recorder, [
      { body: messageStart('msg_a', U1) + toolBlock('toolu_1') + finish('tool_use', U1) },
      { body: messageStart('msg_b', U2) + textBlock('all done') + finish('end_turn', U2) },
    ]);

    const { reported, error } = await run(model);

    expect(error).toBeUndefined();
    expect(
      reported.map((s) => s.id),
      'the SDK keys a step by the wire message id',
    ).toEqual(['msg_a', 'msg_b']);
    expect(reported.map((s) => s.usage.promptTokens)).toEqual([U1.input, U2.input]);

    await recorder.settled();

    expect(recorder.attempts.map((a) => a.complete)).toEqual([true, true]);
    expect(
      unreportedWireUsage(
        recorder.attempts,
        reported.map((s) => s.id),
      ),
    ).toEqual({
      attempts: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe('the tap', () => {
  it('without a recorder it is the base fetch itself (the chain is unchanged)', () => {
    const base = scriptedFetch([]);

    expect(tapWireUsage(undefined, base)).toBe(base);
  });

  it('records nothing for a refused request (the provider bills an accepted one only)', async () => {
    const recorder = createWireUsageRecorder();
    const tapped = tapWireUsage(
      recorder,
      (async () =>
        new Response('{"type":"error"}', { status: 429, headers: { 'content-type': 'application/json' } })) as never,
    );

    await tapped('https://x');
    await recorder.settled();

    expect(recorder.attempts).toEqual([]);
  });

  it('a non-streamed message is one complete attempt', async () => {
    const recorder = createWireUsageRecorder();
    const tapped = tapWireUsage(
      recorder,
      (async () =>
        new Response(
          JSON.stringify({
            type: 'message',
            id: 'msg_json',
            usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as never,
    );

    await (await tapped('https://x')).text();
    await recorder.settled();

    expect(recorder.attempts[0]).toMatchObject({
      messageIds: ['msg_json'],
      complete: true,
      input: 7,
      output: 3,
      cacheRead: 2,
    });
  });

  it('two generations never see each other’s attempts (request-scoped, unlike the stop tap)', async () => {
    const a = createWireUsageRecorder();
    const b = createWireUsageRecorder();

    await run(modelOver(a, [{ body: messageStart('msg_a', U1), end: 'break' }]));
    await run(modelOver(b, [{ body: messageStart('msg_b', U2) + textBlock('ok') + finish('end_turn', U2) }]));
    await Promise.all([a.settled(), b.settled()]);

    expect(a.attempts.map((x) => x.messageIds)).toEqual([['msg_a']]);
    expect(b.attempts.map((x) => x.messageIds)).toEqual([['msg_b']]);
  });

  it('an attempt with no message id that completed is matched against a reported step the wire never named', () => {
    const recorder = createWireUsageRecorder();
    const attempt = recorder.begin();

    applyWireEvent(attempt, { type: 'message_start', message: { usage: { input_tokens: 9 } } });
    applyWireEvent(attempt, { type: 'message_stop' });

    expect(unreportedWireUsage(recorder.attempts, ['sdk-generated-id']).attempts).toBe(0);
    expect(unreportedWireUsage(recorder.attempts, []).attempts).toBe(1);
  });
});

describe('addUnreportedUsage', () => {
  it('adds every class and keeps totalTokens = prompt + completion', () => {
    const totals = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 100,
      cacheCreationTokens: 7,
    };

    addUnreportedUsage(totals, {
      attempts: 1,
      promptTokens: 3,
      completionTokens: 2,
      cacheReadTokens: 50,
      cacheCreationTokens: 1,
    });

    expect(totals).toEqual({
      promptTokens: 13,
      completionTokens: 7,
      totalTokens: 20,
      cacheReadTokens: 150,
      cacheCreationTokens: 8,
    });
  });
});
