/**
 * A relayed call the browser does not answer IN TIME (the relay's timer — `ClientToolResult.timedOut`)
 * means the browser is gone on the managed engine (D6): the call is NOT answered and the engine is told
 * to detach. A genuine browser-side error is still forwarded as `is_error`, and the legacy engine still
 * hands the timeout sentence to the model exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverClientToolResult } from '~/lib/.server/agent/mcp-relay';
import {
  createWorkspaceTools,
  newWorkspaceTurnState,
  WorkspaceOverlay,
  type WorkspaceToolCallEvent,
} from '~/lib/.server/agent/workspace-tools';
import { WORKSPACE_CHECK_TIMEOUT_MS } from '~/lib/agent/workspace-protocol-types';
import type { FileMap } from '~/lib/.server/llm/constants';
import { createManagedDispatcher } from './dispatch';
import type { CustomToolUse } from './events';

const USER = 'user-timeout';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(answer: 'never' | 'error') {
  const generationId = `gen_${Math.random().toString(36).slice(2)}`;
  const gone: CustomToolUse[] = [];
  const dispatcher = createManagedDispatcher({
    generationId,
    userId: USER,
    files: {} as FileMap,
    overlay: new WorkspaceOverlay({}),
    state: newWorkspaceTurnState(),
    emitWorkspace: (event: WorkspaceToolCallEvent) => {
      if (answer === 'error') {
        queueMicrotask(() =>
          deliverClientToolResult({ generationId, toolCallId: event.toolCallId, userId: USER, error: 'tsc crashed' }),
        );
      }
    },
    emitPreview: () => undefined,
    emitTodos: () => undefined,
    onBrowserTimeout: (call) => gone.push(call),
  });

  return { dispatcher, gone };
}

describe('managed engine: a relay TIMEOUT is "the browser is gone", never a tool failure', () => {
  it('sends NOTHING back and reports the browser gone', async () => {
    const { dispatcher, gone } = setup('never');
    const pending = dispatcher.dispatch({ id: 'sevt_check', name: 'check_game', input: {} });

    await vi.advanceTimersByTimeAsync(WORKSPACE_CHECK_TIMEOUT_MS + 10);

    expect(await pending).toBeNull();
    expect(gone.map((c) => c.id)).toEqual(['sevt_check']);
  });

  it('CONTROL: a genuine browser-side error is forwarded as is_error, and the browser is NOT gone', async () => {
    const { dispatcher, gone } = setup('error');
    const answer = await dispatcher.dispatch({ id: 'sevt_check', name: 'check_game', input: {} });

    expect(answer?.isError).toBe(true);
    expect(JSON.stringify(answer?.content)).toContain('tsc crashed');
    expect(gone).toEqual([]);
  });
});

describe('LEGACY: the relay timeout still reaches the model as a sentence (unchanged)', () => {
  it('check_game without the managed hook returns the timeout as a failure result', async () => {
    const generationId = 'gen_legacy_timeout';
    const tools = createWorkspaceTools({
      generationId,
      userId: USER,
      emit: () => undefined,
      emitTodos: () => undefined,
      overlay: new WorkspaceOverlay({}),
      state: newWorkspaceTurnState(),
      planOnly: false,
    }) as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>;

    const pending = tools.check_game.execute({}, { toolCallId: 'c1', messages: [] });

    await vi.advanceTimersByTimeAsync(WORKSPACE_CHECK_TIMEOUT_MS + 10);

    expect(JSON.stringify(await pending)).toContain('The tool did not respond in time.');
  });
});
