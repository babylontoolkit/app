/**
 * The workspace relay, end to end, against the REAL AI SDK (the `mcp-live-relay.spec.ts` pattern).
 *
 * Two claims the unit specs cannot reach:
 *
 *  1. TIMING — while `write_file`'s `execute` is parked awaiting the browser, the `workspace-tool-call`
 *     data part has ALREADY reached the wire over the still-open response. If not, every write stalls
 *     for `WORKSPACE_WRITE_TIMEOUT_MS` and then fails, silently, on the user's bill.
 *  2. READ-YOUR-WRITES across steps — the next step's `read_file` of the same path returns the NEW
 *     content (the overlay), not the stale map the request arrived with. Without it the model's next
 *     `edit_file` is computed against text the disk no longer has.
 *
 * Plus the tool loop's SEGMENT runner (T4), driven the way the proxy drives it: the proxy's
 * `runAgentGeneration` cannot be constructed in a unit test (it boots the prompt store, the ledger and
 * a provider), so the loop lives in `tool-loop.ts` (`runToolLoopSegments`, `createTurnMeter`) and the
 * proxy calls it. The harness below mirrors the proxy's per-step meter, its budget-swallowing `drain`
 * and its first-segment-then-runner shape:
 *
 *  3. a model that ends after a delivered `write_file` without `check_game` gets a SECOND segment whose
 *     last user message is exactly `GATE_PROMPT`;
 *  4. a step whose cost crosses the ceiling aborts the turn — no further step, no further segment —
 *     and the usage it settles is the per-step total (> 0), not the nothing a thrown stream used to bill.
 *
 * Only the MODEL is mocked.
 */
import { createDataStream, formatDataStreamPart, streamText } from 'ai';
import { MockLanguageModelV1, mockValues, simulateReadableStream } from 'ai/test';
import type { CoreMessage, StreamTextResult } from 'ai';
import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/.server/llm/constants';
import { createFileTools } from './file-tools';
import { deliverClientToolResult } from './mcp-relay';
import { emptyUsage } from './step-usage';
import {
  checkBreakerTripped,
  createWorkspaceTools,
  newWorkspaceTurnState,
  summarizeWorkspace,
  type WorkspaceToolCallEvent,
  WorkspaceOverlay,
  TODO_NUDGE,
} from './workspace-tools';
import {
  createTurnMeter,
  DEFAULT_TOOL_LOOP_CONFIG,
  GATE_PROMPT,
  runToolLoopSegments,
  type ToolLoopSegmentKind,
  type ToolLoopTurnState,
} from './tool-loop';

const RAW_CALL = { rawPrompt: null, rawSettings: {} };

function response(chunks: any[]) {
  return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }), rawCall: RAW_CALL };
}

/** Step 1: write_file. Step 2: read_file of the same path. Step 3: answer. */
function writeThenReadModel() {
  const prompts: unknown[] = [];

  const next = mockValues(
    response([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'call-write',
        toolName: 'write_file',
        args: JSON.stringify({ file_path: 'src/scripts/Kart.ts', content: 'export const speed = 99;' }),
      },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]),
    response([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'call-read',
        toolName: 'read_file',
        args: JSON.stringify({ file_path: 'src/scripts/Kart.ts' }),
      },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 20, completionTokens: 5 } },
    ]),
    response([
      { type: 'text-delta', textDelta: 'done' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 30, completionTokens: 1 } },
    ]),
  );

  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return next();
    },
  });

  return { model, prompts };
}

async function until(predicate: () => boolean, what: string, ticks = 300): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`timed out waiting for: ${what}`);
}

function setup(generationId: string, emit: (event: WorkspaceToolCallEvent) => void) {
  const files = {
    '/home/project/src/scripts/Kart.ts': { type: 'file', content: 'export const speed = 1;', isBinary: false },
  } as unknown as FileMap;
  const overlay = new WorkspaceOverlay(files);
  const tools = {
    ...createFileTools({ files, readThisTurn: new Set(), charsThisTurn: { total: 0 }, overlay }),
    ...createWorkspaceTools({
      generationId,
      userId: 'u1',
      emit,
      emitTodos: () => undefined,
      overlay,
      state: newWorkspaceTurnState(),
      planOnly: false,
    }),
  };

  return { tools, overlay };
}

/** The text of the tool_result the model was handed for `toolCallId`, from the prompt it received. */
function toolResultIn(prompt: unknown, toolCallId: string): unknown {
  for (const message of prompt as Array<{ role: string; content: any }>) {
    if (message.role !== 'tool') {
      continue;
    }

    for (const part of message.content) {
      if (part.toolCallId === toolCallId) {
        return part.result;
      }
    }
  }

  return undefined;
}

describe('workspace relay against a live streamText tool loop', () => {
  it('parks write_file on the browser, resumes on delivery, and the next step reads the NEW content', async () => {
    const emitted: WorkspaceToolCallEvent[] = [];
    const { tools, overlay } = setup('gen-ws-live', (event) => emitted.push(event));
    const { model, prompts } = writeThenReadModel();

    const result = streamText({ model, prompt: 'make the kart faster', tools: tools as any, maxSteps: 3 });

    let drained = false;
    const text: string[] = [];
    const draining = (async () => {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          text.push(part.textDelta);
        }
      }
      drained = true;
    })();

    await until(() => emitted.length === 1, 'the write to be emitted');

    /* Parked: the browser has been told, the loop has not moved on, and nothing is in the overlay yet. */
    expect(emitted[0]).toEqual({
      toolCallId: 'call-write',
      op: 'write',
      params: { path: 'src/scripts/Kart.ts', content: 'export const speed = 99;' },
    });
    expect(drained).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(overlay.writes.size).toBe(0);

    expect(
      deliverClientToolResult({
        generationId: 'gen-ws-live',
        toolCallId: 'call-write',
        userId: 'u1',
        result: { ok: true },
      }),
    ).toBe(true);

    await draining;

    expect(text.join('')).toBe('done');
    expect((await result.steps).length).toBe(3);

    /* Step 2 was handed the write's confirmation; step 3 was handed the NEW body, not the stale map. */
    expect(toolResultIn(prompts[1], 'call-write')).toBe(`Wrote src/scripts/Kart.ts (1 lines).\n${TODO_NUDGE}`);
    expect(toolResultIn(prompts[2], 'call-read')).toBe('export const speed = 99;');
  });

  it('flushes the workspace-tool-call data part over the open response before the result comes back', async () => {
    let emitCall: (event: WorkspaceToolCallEvent) => void = () => undefined;
    const { tools } = setup('gen-ws-wire', (event) => emitCall(event));
    const { model } = writeThenReadModel();

    const stream = createDataStream({
      execute: async (writer) => {
        emitCall = (event) => {
          writer.writeData({
            type: 'workspace-tool-call',
            generationId: 'gen-ws-wire',
            toolCallId: event.toolCallId,
            op: event.op,
            params: event.params as any,
          });
        };

        const result = streamText({ model, prompt: 'make the kart faster', tools: tools as any, maxSteps: 3 });

        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            writer.write(formatDataStreamPart('text', part.textDelta));
          }
        }
      },
    });

    const wire: string[] = [];
    const reader = stream.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      wire.push(value);

      /* The browser half: the moment the part lands (response still open), write and post the result. */
      if (value.startsWith('2:') && value.includes('workspace-tool-call')) {
        deliverClientToolResult({
          generationId: 'gen-ws-wire',
          toolCallId: 'call-write',
          userId: 'u1',
          result: { ok: true },
        });
      }
    }

    const dataPart = wire.find((chunk) => chunk.startsWith('2:'));

    expect(dataPart).toBeDefined();
    expect(JSON.parse(dataPart!.slice(2))[0]).toEqual({
      type: 'workspace-tool-call',
      generationId: 'gen-ws-wire',
      toolCallId: 'call-write',
      op: 'write',
      params: { path: 'src/scripts/Kart.ts', content: 'export const speed = 99;' },
    });
    expect(wire.indexOf(dataPart!)).toBeLessThan(wire.findIndex((chunk) => chunk.startsWith('0:')));
    expect(wire.filter((c) => c.startsWith('0:')).join('')).toContain('done');
  });
});

/*
 * ─── the segment runner (T4) ───────────────────────────────────────────────────────────────────────
 */

const toolCall = (toolCallId: string, toolName: string, args: unknown) => ({
  type: 'tool-call',
  toolCallType: 'function',
  toolCallId,
  toolName,
  args: JSON.stringify(args),
});

const finish = (finishReason: string, completionTokens: number) => ({
  type: 'finish',
  finishReason,
  usage: { promptTokens: 100, completionTokens },
});

/**
 * One model across every segment: each `doStream` is one step. A step requested after the turn's
 * signal aborted rejects like a real `fetch` would, and is counted separately.
 */
function scriptedModel(steps: any[][]) {
  const prompts: any[] = [];
  let abortedCalls = 0;
  const next = mockValues(...steps.map((chunks) => response(chunks)));

  const model = new MockLanguageModelV1({
    doStream: async (options) => {
      if (options.abortSignal?.aborted) {
        abortedCalls++;
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      }

      prompts.push(options.prompt);

      return next();
    },
  });

  return { model, prompts, abortedCalls: () => abortedCalls };
}

/** The browser half: answer every relayed op on the next tick, the way the client posts a result. */
function autoDeliver(generationId: string, results: Partial<Record<WorkspaceToolCallEvent['op'], unknown>>) {
  return (event: WorkspaceToolCallEvent) => {
    setTimeout(() => {
      deliverClientToolResult({
        generationId,
        toolCallId: event.toolCallId,
        userId: 'u1',
        result: results[event.op] ?? { ok: true },
      });
    }, 0);
  };
}

/** Mirrors `proxy.ts`: meter in `onStepFinish`, `drain` that swallows a BUDGET abort, then the runner. */
async function runTurn(input: {
  generationId: string;
  model: MockLanguageModelV1;
  ceiling: number | null;
  creditsFor: (usage: ReturnType<typeof emptyUsage>) => number | null;
}) {
  const files = {
    '/home/project/src/scripts/Kart.ts': { type: 'file', content: 'export const speed = 1;', isBinary: false },
  } as unknown as FileMap;
  const overlay = new WorkspaceOverlay(files);
  const wsState = newWorkspaceTurnState();
  const controller = new AbortController();
  const totals = emptyUsage();
  const meter = createTurnMeter({ totals, ceiling: input.ceiling, creditsFor: input.creditsFor, controller });

  const tools = {
    ...createFileTools({ files, readThisTurn: new Set(), charsThisTurn: { total: 0 }, overlay }),
    ...createWorkspaceTools({
      generationId: input.generationId,
      userId: 'u1',
      abortSignal: controller.signal,
      emit: autoDeliver(input.generationId, {
        check: { ok: true, typecheck: 'unavailable', home: { errors: [] } },
      }),
      emitTodos: () => undefined,
      overlay,
      state: wsState,
      planOnly: false,
    }),
  };

  let finishReason = 'unknown';
  let lastStepToolCalls = 0;
  const started: ToolLoopSegmentKind[] = [];
  const text: string[] = [];

  const start = (messages: CoreMessage[]) =>
    streamText({
      model: input.model,
      messages,
      tools: tools as any,
      maxSteps: DEFAULT_TOOL_LOOP_CONFIG.segmentSteps,
      abortSignal: controller.signal,
      onStepFinish: (step) => meter.onStep(step),
    });

  async function* drain(result: StreamTextResult<any, never>): AsyncGenerator<string> {
    try {
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          yield part.textDelta;
        } else if (part.type === 'error') {
          throw part.error;
        }
      }
    } catch (error) {
      if (meter.budgetHit && controller.signal.aborted) {
        return;
      }

      throw error;
    }

    if (meter.budgetHit && controller.signal.aborted) {
      return;
    }

    const steps = await result.steps;
    finishReason = await result.finishReason;
    lastStepToolCalls = steps[steps.length - 1]?.toolCalls?.length ?? 0;
  }

  const base: CoreMessage[] = [{ role: 'user', content: 'make the kart faster' }];
  const state: ToolLoopTurnState = { segmentsRun: 0, nudgesUsed: 0, stopReason: 'none' };
  const first = start(base);

  for await (const chunk of drain(first)) {
    text.push(chunk);
  }

  for await (const chunk of runToolLoopSegments({
    cfg: DEFAULT_TOOL_LOOP_CONFIG,
    base,
    first,
    state,
    readFacts: () => ({
      aborted: false,
      budgetHit: meter.budgetHit,
      finishReason,
      lastStepToolCalls,
      wroteThisTurn: overlay.writes.size > 0,
      lastCheck: wsState.lastCheck,
      lastWriteSeq: overlay.lastWriteSeq,
      breakerTripped: checkBreakerTripped(wsState),
      lastStepInputTokens: 0,
    }),
    summary: () => summarizeWorkspace(overlay, wsState),
    start: (kind, messages) => {
      started.push(kind);
      return start(messages);
    },
    drain,
  })) {
    text.push(chunk);
  }

  return { state, started, totals, meter, overlay, wsState, text: text.join('') };
}

/** The text of a prompt's LAST user message. */
function lastUserText(prompt: any[]): string {
  const last = [...prompt].reverse().find((m) => m.role === 'user');

  return (last?.content ?? []).map((p: any) => p.text ?? '').join('');
}

describe('the tool-loop segment runner against a live streamText', () => {
  it('gates a turn that wrote without checking: segment 2 is prompted with GATE_PROMPT, then it is done', async () => {
    const { model, prompts } = scriptedModel([
      /* Segment 1: write, then end the turn without check_game. */
      [
        toolCall('w1', 'write_file', { file_path: 'src/scripts/Kart.ts', content: 'export const speed = 5;' }),
        finish('tool-calls', 20),
      ],
      [{ type: 'text-delta', textDelta: 'Made it faster.' }, finish('stop', 5)],

      /* Segment 2 (the gate): check, then finish. */
      [toolCall('c1', 'check_game', {}), finish('tool-calls', 10)],
      [{ type: 'text-delta', textDelta: ' Verified.' }, finish('stop', 3)],
    ]);

    const turn = await runTurn({ generationId: 'gen-loop-gate', model, ceiling: null, creditsFor: () => null });

    expect(turn.started).toEqual(['tool-loop-gate']);
    expect(prompts).toHaveLength(4);
    expect(lastUserText(prompts[2])).toBe(GATE_PROMPT);

    /* The gate segment re-sends segment 1's work — the model sees its own write and its result. */
    expect(toolResultIn(prompts[2], 'w1')).toBe(`Wrote src/scripts/Kart.ts (1 lines).\n${TODO_NUDGE}`);

    /* CONTROL: segment 1 was NOT gate-prompted. */
    expect(lastUserText(prompts[0])).toBe('make the kart faster');

    expect(turn.state).toEqual({ segmentsRun: 2, nudgesUsed: 1, stopReason: 'none' });
    expect(turn.wsState.lastCheck).toMatchObject({ ok: true, afterWriteSeq: 1 });
    expect(turn.text).toBe('Made it faster. Verified.');
    expect(turn.totals.completionTokens).toBe(38);
  });

  it('CONTROL: an answer-only turn is never gated', async () => {
    const { model, prompts } = scriptedModel([[{ type: 'text-delta', textDelta: 'It is fast.' }, finish('stop', 4)]]);

    const turn = await runTurn({ generationId: 'gen-loop-answer', model, ceiling: null, creditsFor: () => null });

    expect(turn.started).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(turn.state).toEqual({ segmentsRun: 1, nudgesUsed: 0, stopReason: 'none' });
  });

  it('stops at the credit ceiling: no further step, no further segment, usage settled from the per-step total', async () => {
    const { model, prompts, abortedCalls } = scriptedModel([
      [
        toolCall('w1', 'write_file', { file_path: 'src/scripts/Kart.ts', content: 'export const speed = 5;' }),
        finish('tool-calls', 500),
      ],
      [{ type: 'text-delta', textDelta: 'never sent' }, finish('stop', 5)],
    ]);

    const turn = await runTurn({
      generationId: 'gen-loop-budget',
      model,
      ceiling: 40,
      creditsFor: (usage) => usage.completionTokens / 10,
    });

    expect(turn.meter.budgetHit).toBe(true);
    expect(turn.state.stopReason).toBe('budget');
    expect(turn.state.segmentsRun).toBe(1);
    expect(turn.started, 'the ceiling must not start a gate segment over the unchecked write').toEqual([]);

    /* Exactly one step reached the model; the next one was cancelled before a token of it. */
    expect(prompts).toHaveLength(1);
    expect(abortedCalls()).toBeLessThanOrEqual(1);
    expect(turn.text).not.toContain('never sent');

    /* The write that step made DID land, and the step that made it is billed. */
    expect(turn.overlay.writes.size).toBe(1);
    expect(turn.totals.completionTokens).toBe(500);
    expect(turn.totals.promptTokens).toBe(100);
  });
});
