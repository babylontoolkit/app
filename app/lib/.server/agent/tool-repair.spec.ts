/**
 * Unknown-tool calls must be a bounce, never a dead generation (`tool-repair.ts`).
 *
 * Reproduces the live failure: the first media-enabled creation died with "Model tried to call
 * unavailable tool 'boltArtifact'" — the model emitted the artifact as a TOOL CALL, and the SDK's
 * `NoSuchToolError` killed the whole paid generation. The headline test drives the REAL `streamText`
 * (only the model mocked, the mcp-live-relay pattern) and proves the same call now becomes a
 * corrective tool result and the generation CONTINUES to an answer — plus a control showing that
 * without the repair hook the stream still dies, so the test would catch the hook being dropped.
 */
import { streamText } from 'ai';
import { MockLanguageModelV1, mockValues, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  createRepairTool,
  repairUnavailableToolCall,
  UNAVAILABLE_TOOL_NAME,
  unavailableToolNotice,
} from './tool-repair';

const RAW_CALL = { rawPrompt: null, rawSettings: {} };

function response(chunks: any[]) {
  return { stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }), rawCall: RAW_CALL };
}

/** A model that calls the nonexistent `boltArtifact` tool, then (bounced) answers with text. */
function artifactAsToolModel() {
  const next = mockValues(
    response([
      {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'call-bad',
        toolName: 'boltArtifact',
        args: JSON.stringify({ id: 'project-setup', content: 'the whole game' }),
      },
      { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 } },
    ]),
    response([
      { type: 'text-delta', textDelta: '<boltArtifact id="project-setup">as text this time</boltArtifact>' },
      { type: 'finish', finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 6 } },
    ]),
  );

  return new MockLanguageModelV1({ doStream: async () => next() });
}

describe('a boltArtifact tool call against the real streamText loop', () => {
  it('survives via the repair hook: bounce result, then the generation continues to an answer', async () => {
    const result = streamText({
      model: artifactAsToolModel(),
      prompt: 'create the project',
      tools: createRepairTool() as never,
      maxSteps: 3,
      experimental_repairToolCall: repairUnavailableToolCall as never,
    });

    const errors: unknown[] = [];
    let text = '';

    for await (const part of result.fullStream) {
      if (part.type === 'error') {
        errors.push(part.error);
      }

      if (part.type === 'text-delta') {
        text += part.textDelta;
      }
    }

    expect(errors).toEqual([]);
    expect(text).toContain('as text this time');

    // The bounce ran as a real tool round: the notice tool executed with the attempted name.
    const steps = await result.steps;
    expect(steps.length).toBe(2);

    const toolResults = steps[0].toolResults as Array<{ toolName: string; result: string }>;
    expect(toolResults[0].toolName).toBe(UNAVAILABLE_TOOL_NAME);
    expect(toolResults[0].result).toContain('plain-text output tag');
  });

  /* The control: without the hook the SDK still kills the stream — proving the hook is load-bearing. */
  it('still dies without the repair hook (the pre-fix behaviour)', async () => {
    const result = streamText({
      model: artifactAsToolModel(),
      prompt: 'create the project',
      tools: createRepairTool() as never,
      maxSteps: 3,
    });

    const errors: unknown[] = [];

    for await (const part of result.fullStream) {
      if (part.type === 'error') {
        errors.push(part.error);
      }
    }

    expect(errors.length).toBeGreaterThan(0);
    expect(String((errors[0] as Error).message ?? errors[0])).toContain('boltArtifact');
  });
});

describe('the repair decision', () => {
  const badCall = { toolCallType: 'function' as const, toolCallId: 'c1', toolName: 'boltAction', args: '{}' };

  it('reroutes only NoSuchToolError — other errors keep the SDK behaviour', async () => {
    expect(await repairUnavailableToolCall({ toolCall: badCall, error: new Error('some parse failure') })).toBeNull();
  });

  it('tailors the notice for output-protocol tags and stays generic otherwise', () => {
    expect(unavailableToolNotice('boltArtifact')).toContain('plain-text output tag');
    expect(unavailableToolNotice('boltAction')).toContain('plain-text output tag');
    expect(unavailableToolNotice('str_replace_editor')).toContain('No tool named');
    expect(unavailableToolNotice(undefined)).toContain('that tool');
  });
});
