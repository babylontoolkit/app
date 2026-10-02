/**
 * The custom-tool dispatcher (`dispatch.ts`, managed-agents-engine T5): each managed tool name reaches
 * the right LEGACY execute through the real in-process relay, with the session event id as the relay's
 * tool-call id; a detached request forwards nothing; the read tools answer from the server-side view.
 */
import { describe, expect, it } from 'vitest';
import type { PreviewToolCallEvent } from '~/lib/.server/agent/preview-tools';
import { deliverClientToolResult } from '~/lib/.server/agent/mcp-relay';
import {
  newWorkspaceTurnState,
  WorkspaceOverlay,
  type WorkspaceToolCallEvent,
} from '~/lib/.server/agent/workspace-tools';
import type { TodoItem } from '~/lib/agent/workspace-protocol-types';
import type { FileMap } from '~/lib/.server/llm/constants';
import { createManagedDispatcher } from './dispatch';

const USER = 'user-1';

const FILES: FileMap = {
  '/home/project/src/main.ts': { type: 'file', content: 'import "./a";\nconsole.log(1);\n', isBinary: false },
  '/home/project/src/a.ts': { type: 'file', content: 'export const kart = 1;\n', isBinary: false },
  '/home/project/public/logo.png': { type: 'file', content: '', isBinary: true, size: 99 },
  '/home/project/package-lock.json': { type: 'file', content: '{}', isBinary: false },
} as unknown as FileMap;

function setup(abortSignal?: AbortSignal) {
  const generationId = `gen_test_${Math.random().toString(36).slice(2)}`;
  const workspace: WorkspaceToolCallEvent[] = [];
  const preview: PreviewToolCallEvent[] = [];
  const todos: TodoItem[][] = [];
  const overlay = new WorkspaceOverlay(FILES);
  const state = newWorkspaceTurnState();

  /* The browser: answers every relayed call the moment it is emitted. */
  const browser = (toolCallId: string, result: unknown) =>
    queueMicrotask(() => deliverClientToolResult({ generationId, toolCallId, userId: USER, result }));

  const dispatcher = createManagedDispatcher({
    generationId,
    userId: USER,
    abortSignal,
    files: FILES,
    overlay,
    state,
    emitWorkspace: (event) => {
      workspace.push(event);

      if (event.op === 'check') {
        browser(event.toolCallId, { ok: true, typecheck: { ok: true, errors: [] }, home: { errors: [] }, play: null });
      } else if (event.op === 'run') {
        browser(event.toolCallId, { exitCode: 0, output: 'added 1 package' });
      } else {
        browser(event.toolCallId, { ok: true });
      }
    },
    emitPreview: (event) => {
      preview.push(event);
      browser(
        event.toolCallId,
        event.method === 'screenshot' ? { base64: 'AAAA', mimeType: 'image/jpeg', width: 2, height: 2 } : 42,
      );
    },
    emitTodos: (items) => todos.push(items),
  });

  return { dispatcher, workspace, preview, todos, overlay, state };
}

const call = (id: string, name: string, input: Record<string, unknown>) => ({ id, name, input });

describe('createManagedDispatcher — the legacy executes', () => {
  it('project_write → write_file: relays a `write` with the EVENT id, and the overlay holds the write', async () => {
    const t = setup();
    const answer = await t.dispatcher.dispatch(
      call('sevt_1', 'project_write', { path: 'src/b.ts', content: 'export {}' }),
    );

    expect(t.workspace).toEqual([
      { toolCallId: 'sevt_1', op: 'write', params: { path: 'src/b.ts', content: 'export {}' } },
    ]);
    expect(answer).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: expect.stringContaining('Wrote src/b.ts') }],
    });
    expect(t.overlay.read('src/b.ts')).toBe('export {}');
  });

  it('project_edit → edit_file: resolved on the server, relayed as a full write', async () => {
    const t = setup();
    const answer = await t.dispatcher.dispatch(
      call('sevt_2', 'project_edit', { path: 'src/a.ts', old_string: 'kart = 1', new_string: 'kart = 2' }),
    );

    expect(t.workspace[0]).toEqual({
      toolCallId: 'sevt_2',
      op: 'write',
      params: { path: 'src/a.ts', content: 'export const kart = 2;\n' },
    });
    expect(answer?.isError).toBe(false);
  });

  it('project_run → run_command, check_game → check, update_todos → the checklist', async () => {
    const t = setup();

    expect(
      (await t.dispatcher.dispatch(call('r', 'project_run', { command: 'npm install three' })))?.content[0],
    ).toMatchObject({
      text: expect.stringContaining('exit 0'),
    });
    expect((await t.dispatcher.dispatch(call('c', 'check_game', { gameMode: 'KartMode' })))?.content[0]).toMatchObject({
      text: expect.stringContaining('check_game: PASSED'),
    });
    await t.dispatcher.dispatch(
      call('u', 'update_todos', { items: [{ content: 'Build the kart', status: 'in_progress' }] }),
    );

    expect(t.workspace.map((e) => [e.toolCallId, e.op])).toEqual([
      ['r', 'run'],
      ['c', 'check'],
    ]);
    expect(t.todos).toEqual([[{ content: 'Build the kart', status: 'in_progress' }]]);
    expect(t.state.lastCheck).toMatchObject({ ok: true });
  });

  it('preview tools relay to the preview; a screenshot comes back as an IMAGE block', async () => {
    const t = setup();

    await t.dispatcher.dispatch(call('e', 'evaluate_in_game', { expression: '1+1' }));

    const shot = await t.dispatcher.dispatch(call('s', 'capture_game_screenshot', {}));

    expect(t.preview.map((p) => [p.toolCallId, p.method])).toEqual([
      ['e', 'evaluate'],
      ['s', 'screenshot'],
    ]);
    expect(shot?.content).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
  });

  it('a refusal is an error result; an unknown tool is an error result', async () => {
    const t = setup();

    expect(
      await t.dispatcher.dispatch(call('x', 'project_write', { path: 'src/babylon/system/x.ts', content: '' })),
    ).toMatchObject({
      isError: true,
    });
    expect(await t.dispatcher.dispatch(call('y', 'rm_rf', {}))).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Unknown tool "rm_rf".' }],
    });
    expect(t.workspace).toEqual([]);
  });

  it('DETACHED: a call that was running when the request aborted forwards NOTHING', async () => {
    const controller = new AbortController();
    const generationId = 'gen_detach';
    const emitted: string[] = [];

    const dispatcher = createManagedDispatcher({
      generationId,
      userId: USER,
      abortSignal: controller.signal,
      files: FILES,
      overlay: new WorkspaceOverlay(FILES),
      state: newWorkspaceTurnState(),
      emitWorkspace: (event) => {
        emitted.push(event.toolCallId);
        queueMicrotask(() => controller.abort()); // the tab closes while the browser runs the write
      },
      emitPreview: () => undefined,
      emitTodos: () => undefined,
    });

    expect(await dispatcher.dispatch(call('w', 'project_write', { path: 'src/c.ts', content: 'x' }))).toBeNull();
    expect(emitted).toEqual(['w']);
  });

  it('reply:false runs the call for its side effect only', async () => {
    const t = setup();

    expect(await t.dispatcher.dispatch(call('u2', 'update_todos', { items: ['one'] }), { reply: false })).toBeNull();
    expect(t.todos).toHaveLength(1);
  });
});

describe('createManagedDispatcher — the server-side read tools', () => {
  it('project_read numbers lines, honours offset/limit, and reads this turn’s writes', async () => {
    const t = setup();

    expect((await t.dispatcher.dispatch(call('a', 'project_read', { path: 'src/main.ts' })))?.content[0]).toMatchObject(
      {
        text: '     1\timport "./a";\n     2\tconsole.log(1);\n     3\t',
      },
    );
    expect(
      (await t.dispatcher.dispatch(call('b', 'project_read', { path: 'src/main.ts', offset: 2, limit: 1 })))
        ?.content[0],
    ).toMatchObject({
      text: expect.stringMatching(/^ {5}2\tconsole\.log\(1\);\n…\(1 more lines/),
    });

    t.overlay.write('src/new.ts', 'fresh');
    expect((await t.dispatcher.dispatch(call('c', 'project_read', { path: 'src/new.ts' })))?.content[0]).toMatchObject({
      text: '     1\tfresh',
    });
  });

  it('project_read refuses a binary, an opaque file, a path outside the project, and suggests on a miss', async () => {
    const t = setup();

    expect(await t.dispatcher.dispatch(call('a', 'project_read', { path: 'public/logo.png' }))).toMatchObject({
      isError: true,
    });
    expect(await t.dispatcher.dispatch(call('b', 'project_read', { path: 'package-lock.json' }))).toMatchObject({
      isError: true,
    });
    expect(await t.dispatcher.dispatch(call('c', 'project_read', { path: '/etc/passwd' }))).toMatchObject({
      isError: true,
    });
    expect((await t.dispatcher.dispatch(call('d', 'project_read', { path: 'a.ts' })))?.content[0]).toMatchObject({
      text: expect.stringContaining('src/a.ts'),
    });
  });

  it('project_list and project_grep cover the request map plus this turn’s writes', async () => {
    const t = setup();

    t.overlay.write('src/scripts/Kart.ts', 'export class Kart { drift() {} }');

    const list = (await t.dispatcher.dispatch(call('l', 'project_list', { path: 'src' })))?.content[0];
    const grep = (await t.dispatcher.dispatch(call('g', 'project_grep', { pattern: 'kart|Kart' })))?.content[0];

    expect(list).toMatchObject({ text: 'src/a.ts\nsrc/main.ts\nsrc/scripts/Kart.ts' });
    expect(grep).toMatchObject({
      text: 'src/a.ts:1: export const kart = 1;\nsrc/scripts/Kart.ts:1: export class Kart { drift() {} }',
    });
    expect(await t.dispatcher.dispatch(call('h', 'project_grep', { pattern: '(' }))).toMatchObject({ isError: true });
  });
});
