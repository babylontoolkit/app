/**
 * The MCP relay, end to end, against the REAL AI SDK (SPEC §4.14).
 *
 * `mcp-relay.spec.ts` tests the registry and `mcp-tools.spec.ts` calls `execute` by hand. Neither
 * touches the claim the whole design rests on, which is a TIMING claim:
 *
 *   while a tool's `execute` sits BLOCKED awaiting the client, the `mcp-tool-call` data part must
 *   already have reached the client — over the same still-open HTTP response.
 *
 * If it does not, the relay deadlocks: the server waits for a result the client was never told to
 * produce, every MCP generation stalls for `MCP_RELAY_TIMEOUT_MS` and then feeds the model "the tool
 * did not respond in time". Nothing throws. It just silently never works, and the user pays for the
 * whole 60s.
 *
 * That claim is not ours to assert — it is a property of `streamText`'s scheduling and of
 * `createDataStream`'s flushing. So these tests drive the real `ai` package with a mock MODEL (the only
 * mocked thing) and read the wire bytes, which is what the route actually hands the browser.
 */
import { createDataStream, formatDataStreamPart, streamText } from 'ai';
import { MockLanguageModelV1, mockValues, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { deliverClientToolResult } from './mcp-relay';
import { createMcpRelayTools, type McpToolCallEvent } from './mcp-tools';

const RAW_CALL = { rawPrompt: null, rawSettings: {} };

function response(chunks: any[]) {
  return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }), rawCall: RAW_CALL };
}

/** A model that calls `echo` once, then (given the tool result) answers with text — a real 2-step loop. */
function twoStepModel() {
  /*
   * `mockValues` returns each VALUE in turn — so these are the response objects themselves, and the
   * `async` wrapper is what makes `doStream` the promise-returning function the SDK expects. Pass the
   * factories to `mockValues` directly and `doStream` resolves to a FUNCTION; the SDK then dies on
   * `stream.pipeThrough` of undefined.
   */
  const next = mockValues(
    response([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'call-1',
        toolName: 'echo',
        args: JSON.stringify({ text: 'hi' }),
      },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]),
    response([
      { type: 'text-delta', textDelta: 'the tool said hi' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 4 } },
    ]),
  );

  return new MockLanguageModelV1({ doStream: async () => next() });
}

/** Spin the event loop until `predicate` holds, so we never race on a fixed sleep. */
async function until(predicate: () => boolean, what: string, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`timed out waiting for: ${what}`);
}

describe('MCP relay against a live streamText tool loop', () => {
  it('emits the tool-call to the client WHILE execute is blocked, then resumes on delivery', async () => {
    const emitted: McpToolCallEvent[] = [];
    const tools = createMcpRelayTools([{ name: 'echo', description: 'echoes', server: 's1' }], {
      generationId: 'gen-live',
      userId: 'u1',
      emit: (event) => emitted.push(event),
    });

    const result = streamText({
      model: twoStepModel(),
      prompt: 'use the echo tool',
      tools: tools as any,
      maxSteps: 2,
    });

    const text: string[] = [];
    let drained = false;

    // Drive the loop the way the route does, WITHOUT awaiting it — the point is what happens mid-flight.
    const draining = (async () => {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          text.push(part.textDelta);
        }
      }
      drained = true;
    })();

    await until(() => emitted.length === 1, 'the tool-call to be emitted');

    /*
     * The load-bearing assertion. The client has been told what to run, and the generation has NOT
     * finished — it is parked inside `execute` waiting for us. That is the whole relay: one open
     * request, one settlement, the sandbox round-trip happening inside it.
     */
    expect(emitted[0]).toEqual({ toolCallId: 'call-1', toolName: 'echo', server: 's1', args: { text: 'hi' } });
    expect(drained).toBe(false);
    expect(text).toEqual([]);

    // The client ran it in its WebContainer and posted the result back.
    expect(
      deliverClientToolResult({
        generationId: 'gen-live',
        toolCallId: 'call-1',
        userId: 'u1',
        result: { echoed: 'hi' },
      }),
    ).toBe(true);

    await draining;

    expect(drained).toBe(true);
    expect(text.join('')).toBe('the tool said hi');

    // The model was given the client's result — a second step happened, i.e. the loop truly resumed.
    expect((await result.steps).length).toBe(2);
  });

  it('flushes the mcp-tool-call data part over the open response before the result comes back', async () => {
    const tools = createMcpRelayTools([{ name: 'echo', description: 'echoes', server: 's1' }], {
      generationId: 'gen-wire',
      userId: 'u1',
      emit: (event) => emitMcpCall(event),
    });

    let emitMcpCall: (event: McpToolCallEvent) => void = () => undefined;

    /*
     * A faithful miniature of `streamGeneration` (api.agent.ts): subscribe, then drain, writing the
     * tool-call as a data part and the model's prose as text. If `writeData` from inside `execute` did
     * not flush until the stream closed, the client would only learn of the call after the generation it
     * is supposed to unblock had already timed out.
     */
    const stream = createDataStream({
      execute: async (writer) => {
        emitMcpCall = (event) => {
          writer.writeData({
            type: 'mcp-tool-call',
            generationId: 'gen-wire',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            server: event.server,
            args: event.args as any,
          });
        };

        const result = streamText({
          model: twoStepModel(),
          prompt: 'use the echo tool',
          tools: tools as any,
          maxSteps: 2,
        });

        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            writer.write(formatDataStreamPart('text', part.textDelta));
          }
        }
      },
    });

    const wire: string[] = [];
    let closed = false;

    // Read the response the way the browser does, chunk by chunk as it arrives.
    const reading = (async () => {
      const reader = stream.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        wire.push(value);

        /*
         * This IS the client half of `Chat.client.tsx`: the moment the data part lands, run the tool and
         * post the result back. Doing it here — inside the read loop, with the response still open — is
         * the exact ordering the browser has.
         */
        if (value.startsWith('2:') && value.includes('mcp-tool-call')) {
          deliverClientToolResult({
            generationId: 'gen-wire',
            toolCallId: 'call-1',
            userId: 'u1',
            result: { echoed: 'hi' },
          });
        }
      }
      closed = true;
    })();

    await reading;

    expect(closed).toBe(true);

    const dataPart = wire.find((chunk) => chunk.startsWith('2:'));

    // The tool-call reached the wire...
    expect(dataPart).toBeDefined();
    expect(JSON.parse(dataPart!.slice(2))[0]).toMatchObject({
      type: 'mcp-tool-call',
      generationId: 'gen-wire',
      toolCallId: 'call-1',
      toolName: 'echo',
    });

    // ...BEFORE the prose, which only exists because the delivery unblocked the loop.
    expect(wire.indexOf(dataPart!)).toBeLessThan(wire.findIndex((chunk) => chunk.startsWith('0:')));
    expect(wire.filter((c) => c.startsWith('0:')).join('')).toContain('the tool said hi');
  });
});
