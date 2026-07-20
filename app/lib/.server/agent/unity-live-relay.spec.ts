/**
 * The Unity Editor bridge, end to end, against the REAL AI SDK (SPEC §4.17, §4.14).
 *
 * The whole Unity design rests on ONE claim: a Unity tool is just another MCP tool to the relay. Same
 * emit-then-park-then-resume timing, same single generation — therefore one credit gate and one
 * settlement, i.e. Unity costs the billing path nothing new.
 *
 * `mcp-live-relay.spec.ts` pins that timing for a WebContainer MCP server. This file pins it for the
 * UNITY source, because the two differ in exactly the places that could silently break it: the tool
 * arrives from a different transport, it carries `server: 'unity'` (which the client routes on — the
 * wrong label runs the call against the wrong process), and it is the one server with a 180s relay
 * window instead of the 60s default.
 *
 * If the `mcp-tool-call` data part did NOT flush while `execute` is parked, every Unity generation would
 * deadlock for the FULL 180s and then feed the model "the tool did not respond in time". Nothing throws.
 * The user just pays for three minutes of nothing. That is a property of `streamText`'s scheduling and
 * `createDataStream`'s flushing, not of our code — so, like the MCP file, these tests drive the real `ai`
 * package with only the MODEL mocked, and read the wire bytes the route hands the browser.
 */
import { createDataStream, formatDataStreamPart, streamText } from 'ai';
import { MockLanguageModelV1, mockValues, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpRelayTools, UNITY_RELAY_TIMEOUT_MS, type McpToolCallEvent } from './mcp-tools';
import { deliverClientToolResult, type AwaitToolResultInput } from './mcp-relay';
import { UNITY_SERVER_NAME } from '~/lib/mcp/webcontainer-bridge';

/*
 * The relay stays REAL — the parked-execute property under test IS the real registry blocking and
 * resolving. We only wrap `awaitClientToolResult` so its input is observable: `timeoutMs` is decided in
 * `mcp-tools.ts` and consumed in `mcp-relay.ts`, so the hand-off is the only place the 180s window can be
 * seen. (Same technique as `mcp-tools.spec.ts`; it composes with the live harness unchanged, because the
 * spread keeps the registry — and therefore `deliverClientToolResult` — the genuine module.)
 */
const relayCalls = vi.hoisted(() => [] as AwaitToolResultInput[]);

vi.mock('./mcp-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcp-relay')>();

  return {
    ...actual,
    awaitClientToolResult: (input: AwaitToolResultInput) => {
      relayCalls.push(input);
      return actual.awaitClientToolResult(input);
    },
  };
});

beforeEach(() => {
  relayCalls.length = 0;
});

const RAW_CALL = { rawPrompt: null, rawSettings: {} };

const UNITY_TOOL = { name: 'refresh_assets', description: 'reimports changed assets', server: UNITY_SERVER_NAME };
const UNITY_ARGS = { recompile: true };

function response(chunks: any[]) {
  return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }), rawCall: RAW_CALL };
}

/** Calls the Unity tool once, then (given the result) answers with text — a real 2-step loop. */
function twoStepUnityModel() {
  const next = mockValues(
    response([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'call-u1',
        toolName: 'refresh_assets',
        args: JSON.stringify(UNITY_ARGS),
      },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]),
    response([
      { type: 'text-delta', textDelta: 'the editor reimported 3 assets' },
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

describe('Unity relay against a live streamText tool loop', () => {
  it('emits a unity tool-call while execute is parked, then resumes the SAME generation on delivery', async () => {
    const generationId = 'gen-unity-live';
    const emitted: McpToolCallEvent[] = [];
    const tools = createMcpRelayTools([UNITY_TOOL], {
      generationId,
      userId: 'u1',
      emit: (event) => emitted.push(event),
    });

    const result = streamText({
      model: twoStepUnityModel(),
      prompt: 'refresh the unity assets',
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

    await until(() => emitted.length === 1, 'the unity tool-call to be emitted');

    /*
     * The load-bearing assertion. The client has been told what to run — with the unity label intact, so
     * it routes to the editor bridge and not to some WebContainer server — and the generation has NOT
     * finished. It is parked inside `execute`, waiting for us.
     */
    expect(emitted[0]).toEqual({
      toolCallId: 'call-u1',
      toolName: 'refresh_assets',
      server: UNITY_SERVER_NAME,
      args: UNITY_ARGS,
    });
    expect(emitted[0].server).toBe('unity');
    expect(drained).toBe(false);
    expect(text).toEqual([]);

    /*
     * The 180s window, observed where it is actually handed over (§4.17). At the 60s default the editor is
     * still recompiling when the model is told the tool failed — a false failure for work that succeeds.
     */
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0].timeoutMs).toBe(180_000);
    expect(relayCalls[0].timeoutMs).toBe(UNITY_RELAY_TIMEOUT_MS);

    /*
     * ONE generation across the whole round trip — one credit gate, one settlement (§4.14). The relay
     * parked under the id the loop started with, and no other id can unblock it: a second generation id
     * would mean the tool round-trip had fragmented into a second billed request.
     */
    expect(relayCalls[0].generationId).toBe(generationId);
    expect(
      deliverClientToolResult({
        generationId: 'gen-unity-other',
        toolCallId: 'call-u1',
        userId: 'u1',
        result: { reimported: 3 },
      }),
    ).toBe(false);
    expect(drained).toBe(false);

    // The client ran it against the Unity editor and posted the result back, on the SAME generation.
    expect(
      deliverClientToolResult({
        generationId,
        toolCallId: 'call-u1',
        userId: 'u1',
        result: { reimported: 3 },
      }),
    ).toBe(true);

    await draining;

    expect(drained).toBe(true);
    expect(text.join('')).toBe('the editor reimported 3 assets');

    // A second step happened, i.e. the loop truly resumed rather than a new generation starting.
    expect((await result.steps).length).toBe(2);

    // And it parked exactly once — no re-entry, no second gate.
    expect(relayCalls.map((c) => c.generationId)).toEqual([generationId]);
  });

  it('flushes the unity tool-call data part over the open response before the result comes back', async () => {
    const generationId = 'gen-unity-wire';

    let emitUnityCall: (event: McpToolCallEvent) => void = () => undefined;

    const tools = createMcpRelayTools([UNITY_TOOL], {
      generationId,
      userId: 'u1',
      emit: (event) => emitUnityCall(event),
    });

    /*
     * A faithful miniature of `streamGeneration` (api.agent.ts): subscribe, then drain, writing the
     * tool-call as a data part and the model's prose as text. If `writeData` from inside `execute` did not
     * flush until the stream closed, the Unity client would learn of the call only after the generation it
     * is supposed to unblock had already burned its 180s.
     */
    const stream = createDataStream({
      execute: async (writer) => {
        emitUnityCall = (event) => {
          writer.writeData({
            type: 'mcp-tool-call',
            generationId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            server: event.server,
            args: event.args as any,
          });
        };

        const result = streamText({
          model: twoStepUnityModel(),
          prompt: 'refresh the unity assets',
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
    const deliveredWith: string[] = [];
    let closed = false;

    // Read the response the way the Unity-connected browser does, chunk by chunk as it arrives.
    const reading = (async () => {
      const reader = stream.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        wire.push(value);

        /*
         * The client half: the moment the data part lands, route it by `server`, run it, post the result
         * back — using the generationId the wire itself carried. Doing it here, inside the read loop with
         * the response still open, is the exact ordering the browser has.
         */
        if (value.startsWith('2:') && value.includes('mcp-tool-call')) {
          const part = JSON.parse(value.slice(2))[0];

          if (part.server === UNITY_SERVER_NAME) {
            deliveredWith.push(part.generationId);
            deliverClientToolResult({
              generationId: part.generationId,
              toolCallId: part.toolCallId,
              userId: 'u1',
              result: { reimported: 3 },
            });
          }
        }
      }
      closed = true;
    })();

    await reading;

    expect(closed).toBe(true);

    const dataPart = wire.find((chunk) => chunk.startsWith('2:'));

    // The unity tool-call reached the wire, labelled and named so the client can route it...
    expect(dataPart).toBeDefined();
    expect(JSON.parse(dataPart!.slice(2))[0]).toMatchObject({
      type: 'mcp-tool-call',
      generationId,
      toolCallId: 'call-u1',
      toolName: 'refresh_assets',
      server: UNITY_SERVER_NAME,
      args: UNITY_ARGS,
    });

    // ...BEFORE the prose, which only exists because the delivery unblocked the parked loop.
    expect(wire.indexOf(dataPart!)).toBeLessThan(wire.findIndex((chunk) => chunk.startsWith('0:')));
    expect(wire.filter((c) => c.startsWith('0:')).join('')).toContain('the editor reimported 3 assets');

    // The round trip stayed inside ONE generation — the id on the wire is the id the relay parked under.
    expect(deliveredWith).toEqual([generationId]);
    expect(relayCalls.map((c) => [c.generationId, c.timeoutMs])).toEqual([[generationId, UNITY_RELAY_TIMEOUT_MS]]);
  });
});
