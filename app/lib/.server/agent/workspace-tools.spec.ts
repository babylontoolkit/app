/**
 * The workspace tools (tool-loop plan D1–D8) — driven through the REAL relay registry, with a fake
 * `emit` standing in for the browser (the `preview-tools.spec.ts` pattern).
 *
 * The properties worth pinning are the silent ones: an overlay updated on a write that never landed
 * (the model reads back a file the disk does not have), a Plan-mode write outside `_specs/` (a tool
 * write bypasses the client-side render-only wall), and a check verdict the next segment decision
 * trusts.
 */
import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/.server/llm/constants';
import type { TodoItem } from '~/lib/agent/workspace-protocol-types';
import { deliverClientToolResult } from './mcp-relay';
import { MAX_SCREENSHOT_BASE64 } from './preview-tools';
import {
  checkBreakerTripped,
  createWorkspaceTools,
  newWorkspaceTurnState,
  PLAN_ONLY_REFUSAL,
  summarizeWorkspace,
  TODO_NUDGE,
  TODO_TICK_HINT,
  todoNudgeFor,
  type WorkspaceToolCallEvent,
  WorkspaceOverlay,
} from './workspace-tools';

const text = (content: string) => ({ type: 'file' as const, content, isBinary: false });

let callSeq = 0;

type Answer = { result?: unknown; error?: string } | null;

/**
 * A harness: a fresh overlay + state, and a "browser" that answers every emitted call on the next tick
 * with `answer(event)` — or never, when it returns null.
 */
function harness(
  opts: { files?: Record<string, unknown>; planOnly?: boolean; answer?: (e: WorkspaceToolCallEvent) => Answer } = {},
) {
  const generationId = `gen_ws_${++callSeq}`;
  const overlay = new WorkspaceOverlay((opts.files ?? {}) as unknown as FileMap);
  const state = newWorkspaceTurnState();
  const emitted: WorkspaceToolCallEvent[] = [];
  const todos: TodoItem[][] = [];
  const answer = opts.answer ?? (() => ({ result: { ok: true } }));

  const tools = createWorkspaceTools({
    generationId,
    userId: 'u1',
    emit: (event) => {
      emitted.push(event);

      const reply = answer(event);

      if (reply) {
        setTimeout(
          () => deliverClientToolResult({ generationId, toolCallId: event.toolCallId, userId: 'u1', ...reply }),
          0,
        );
      }
    },
    emitTodos: (items) => todos.push(items),
    overlay,
    state,
    planOnly: opts.planOnly ?? false,
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> };
    return t.execute(args, { toolCallId: `call_${++callSeq}`, abortSignal: undefined });
  };

  return { tools, overlay, state, emitted, todos, call };
}

describe('write_file', () => {
  it('relays the write, then updates the overlay', async () => {
    const h = harness();
    const out = await h.call('write_file', { file_path: 'src/scripts/Kart.ts', content: 'a\nb\nc' });

    expect(out).toBe(`Wrote src/scripts/Kart.ts (3 lines).\n${TODO_NUDGE}`);
    expect(h.emitted).toEqual([
      { toolCallId: expect.any(String), op: 'write', params: { path: 'src/scripts/Kart.ts', content: 'a\nb\nc' } },
    ]);
    expect(h.overlay.read('src/scripts/Kart.ts')).toBe('a\nb\nc');
    expect([...h.overlay.writes]).toEqual(['src/scripts/Kart.ts']);
    expect(h.overlay.lastWriteSeq).toBe(1);
  });

  it('normalises a sandbox-absolute path to project-relative', async () => {
    const h = harness();
    await h.call('write_file', { file_path: '/home/project/src/a.ts', content: 'x' });

    expect((h.emitted[0].params as { path: string }).path).toBe('src/a.ts');
  });

  /* 🔴 A write that never landed must not be readable back — the model would edit text the disk lacks. */
  it('a failed relay leaves the overlay untouched', async () => {
    const h = harness({ files: { 'src/a.ts': text('original') }, answer: () => ({ error: 'disk full' }) });
    const out = await h.call('write_file', { file_path: 'src/a.ts', content: 'changed' });

    expect(out).toBe('The workspace could not complete this: disk full');
    expect(h.overlay.read('src/a.ts')).toBe('original');
    expect(h.overlay.writes.size).toBe(0);
    expect(h.overlay.lastWriteSeq).toBe(0);
  });

  it('refuses missing arguments with a sentence and emits nothing', async () => {
    const h = harness();

    expect(await h.call('write_file', {})).toMatch(/needs a "file_path"/);
    expect(await h.call('write_file', { file_path: 'a.ts' })).toMatch(/needs "content"/);
    expect(h.emitted).toHaveLength(0);
  });

  it('refuses paths that escape the project', async () => {
    const h = harness();

    for (const bad of ['../secret.ts', 'src/../../x.ts', '/etc/passwd', 'src\\a.ts']) {
      expect(await h.call('write_file', { file_path: bad, content: 'x' })).toMatch(
        /outside the project|not a valid project path/,
      );
    }

    expect(h.emitted).toHaveLength(0);
  });

  it('refuses binaries, the lockfile and the read-only zones — naming the zone', async () => {
    const h = harness();

    expect(await h.call('write_file', { file_path: 'public/hero.png', content: 'x' })).toMatch(/media tools/);
    expect(await h.call('write_file', { file_path: 'package-lock.json', content: '{}' })).toMatch(/package-lock\.json/);
    expect(await h.call('write_file', { file_path: 'src/babylon/system/a.ts', content: 'x' })).toMatch(
      /read-only zone: src\/babylon\/system\//,
    );
    expect(await h.call('write_file', { file_path: 'src/babylon/classes/Demo.ts', content: 'x' })).toMatch(
      /read-only zone: src\/babylon\/classes\//,
    );
    expect(await h.call('write_file', { file_path: 'src/routing/x.tsx', content: 'x' })).toMatch(
      /read-only zone: src\/routing\//,
    );
    expect(await h.call('write_file', { file_path: 'src/app.tsx', content: 'x' })).toMatch(
      /read-only zone: src\/app\.tsx/,
    );
    expect(h.emitted).toHaveLength(0);
  });

  it('CONTROL: an ordinary game path is allowed', async () => {
    const h = harness();
    expect(await h.call('write_file', { file_path: 'src/chrome/splash.tsx', content: 'x' })).toMatch(/^Wrote/);
  });
});

describe('Plan mode (planOnly)', () => {
  it('offers only write_file and update_todos', () => {
    expect(Object.keys(harness({ planOnly: true }).tools).sort()).toEqual(['update_todos', 'write_file']);
    expect(Object.keys(harness().tools).sort()).toEqual([
      'check_game',
      'edit_file',
      'run_command',
      'update_todos',
      'write_file',
    ]);
  });

  it('refuses src/a.ts', async () => {
    const h = harness({ planOnly: true });
    expect(await h.call('write_file', { file_path: 'src/a.ts', content: 'x' })).toBe(PLAN_ONLY_REFUSAL);
    expect(h.emitted).toHaveLength(0);
  });

  it('allows _specs/x_plan.md', async () => {
    const h = harness({ planOnly: true });
    expect(await h.call('write_file', { file_path: '_specs/x_plan.md', content: '# plan' })).toBe(
      'Wrote _specs/x_plan.md (1 lines).',
    );
    expect(h.emitted).toHaveLength(1);
  });

  it('refuses traversal out of _specs/', async () => {
    const h = harness({ planOnly: true });
    expect(await h.call('write_file', { file_path: '_specs/../src/x.ts', content: 'x' })).not.toMatch(/^Wrote/);
    expect(h.emitted).toHaveLength(0);
  });
});

describe('edit_file', () => {
  it('resolves on the server and relays the FULL content as a write', async () => {
    const h = harness({ files: { '/home/project/src/a.ts': text('const speed = 1;\nconst x = 2;') } });
    const out = await h.call('edit_file', { file_path: 'src/a.ts', old_string: 'speed = 1', new_string: 'speed = 9' });

    expect(out).toBe(`Edited src/a.ts (1 replacement(s)).\n${TODO_NUDGE}`);
    expect(h.emitted[0]).toMatchObject({
      op: 'write',
      params: { path: 'src/a.ts', content: 'const speed = 9;\nconst x = 2;' },
    });
    expect(h.overlay.read('src/a.ts')).toBe('const speed = 9;\nconst x = 2;');
  });

  it('edits against the overlay, not the stale request map', async () => {
    const h = harness({ files: { 'src/a.ts': text('v1') } });
    await h.call('write_file', { file_path: 'src/a.ts', content: 'v2 v2' });

    const out = await h.call('edit_file', {
      file_path: 'src/a.ts',
      old_string: 'v2',
      new_string: 'v3',
      replace_all: true,
    });

    expect(out).toBe('Edited src/a.ts (2 replacement(s)).');
    expect(h.overlay.read('src/a.ts')).toBe('v3 v3');
  });

  it('not found returns the string-edit error with zero emits', async () => {
    const h = harness({ files: { 'src/a.ts': text('abc') } });
    const out = await h.call('edit_file', { file_path: 'src/a.ts', old_string: 'zzz', new_string: 'y' });

    expect(out).toMatch(/old_string was not found/);
    expect(h.emitted).toHaveLength(0);
  });

  it('a missing file says to create it', async () => {
    const h = harness();
    expect(await h.call('edit_file', { file_path: 'src/nope.ts', old_string: 'a', new_string: 'b' })).toBe(
      'src/nope.ts does not exist — create it with write_file.',
    );
  });

  it('a failed relay leaves the overlay untouched', async () => {
    const h = harness({ files: { 'src/a.ts': text('abc') }, answer: () => ({ error: 'The generation was stopped.' }) });
    await h.call('edit_file', { file_path: 'src/a.ts', old_string: 'b', new_string: 'X' });

    expect(h.overlay.read('src/a.ts')).toBe('abc');
    expect(h.overlay.writes.size).toBe(0);
  });

  it('applies the zone rules', async () => {
    const h = harness({ files: { 'src/routing/router.tsx': text('abc') } });
    expect(
      await h.call('edit_file', { file_path: 'src/routing/router.tsx', old_string: 'b', new_string: 'X' }),
    ).toMatch(/read-only zone/);
  });
});

describe('run_command', () => {
  it('refuses npm run dev / preview and non-npm commands without emitting', async () => {
    const h = harness();

    expect(await h.call('run_command', { command: 'npm run dev' })).toMatch(/not allowed/);
    expect(await h.call('run_command', { command: 'npm install x && npm run preview' })).toMatch(/not allowed/);
    expect(await h.call('run_command', { command: 'rm -rf /' })).toMatch(/not allowed/);
    expect(await h.call('run_command', {})).toMatch(/needs a "command"/);
    expect(h.emitted).toHaveLength(0);
  });

  it('applies the returned package.json to the overlay and records the command', async () => {
    const h = harness({
      files: { 'package.json': text('{"old":true}') },
      answer: () => ({ result: { exitCode: 0, output: 'added 1 package', packageJson: '{"new":true}' } }),
    });
    const out = await h.call('run_command', { command: 'npm install @babylonjs/loaders' });

    expect(out).toBe(`exit 0\nadded 1 package\n${TODO_NUDGE}`);
    expect(h.emitted[0]).toMatchObject({ op: 'run', params: { command: 'npm install @babylonjs/loaders' } });
    expect(h.overlay.read('package.json')).toBe('{"new":true}');
    expect(h.state.commands).toEqual([{ command: 'npm install @babylonjs/loaders', exitCode: 0 }]);
  });

  it('keeps the TAIL of long output, capped', async () => {
    const long = `${'a'.repeat(20_000)}THE_END`;
    const h = harness({ answer: () => ({ result: { exitCode: 2, output: long } }) });
    h.state.todoNudged = true; // the output tail is what this pins, not the nudge

    const out = String(await h.call('run_command', { command: 'npm run build' }));

    expect(out.startsWith('exit 2\n')).toBe(true);
    expect(out.endsWith('THE_END')).toBe(true);
    expect(out.length).toBeLessThan(12_100);
    expect(out).toContain('truncated');
  });
});

const passing = {
  ok: true,
  typecheck: { ok: true, errors: [] },
  home: { errors: [] },
  play: { errors: [], hasScene: true, meshes: 12, ready: true },
  screenshot: { base64: 'AAAA', mimeType: 'image/jpeg' },
};

describe('check_game', () => {
  it('relays the params and sets lastCheck with afterWriteSeq', async () => {
    const h = harness({ answer: (e) => (e.op === 'check' ? { result: passing } : { result: { ok: true } }) });
    await h.call('write_file', { file_path: 'src/a.ts', content: 'x' });
    await h.call('write_file', { file_path: 'src/b.ts', content: 'y' });

    const out = (await h.call('check_game', { gameMode: 'KartMode' })) as { verdict: string; screenshot?: unknown };

    expect(h.emitted[2]).toMatchObject({ op: 'check', params: { gameMode: 'KartMode' } });
    expect(out.verdict).toBe('check_game: PASSED\nScene: hasScene=true meshes=12 ready=true');
    expect(out.screenshot).toEqual({ base64: 'AAAA', mimeType: 'image/jpeg' });
    expect(h.state.lastCheck).toEqual({ ok: true, errors: [], afterWriteSeq: 2 });
  });

  it('a failed check lists the errors, capped at 30 × 300, and records a signature', async () => {
    const failing = {
      ok: false,
      typecheck: { ok: false, errors: Array.from({ length: 25 }, (_, i) => `TS${i} ${'x'.repeat(400)}`) },
      home: { errors: ['home boom', 'home boom 2', 'home 3', 'home 4', 'home 5', 'home 6', 'home 7'] },
      play: null,
      screenshot: null,
    };
    const h = harness({ answer: () => ({ result: failing }) });
    const out = (await h.call('check_game', {})) as { verdict: string };

    expect(out.verdict.startsWith('check_game: FAILED\nTS0 ')).toBe(true);
    expect(h.state.lastCheck!.ok).toBe(false);
    expect(h.state.lastCheck!.errors).toHaveLength(30);
    expect(h.state.lastCheck!.errors.every((e) => e.length <= 300)).toBe(true);
    expect(h.state.checkFailureSignatures).toHaveLength(1);
  });

  /* The client's `ok` is not believed on its own — the evidence it sent must agree. */
  it('a claimed pass with a missing scene is a failure that names it', async () => {
    const h = harness({
      answer: () => ({ result: { ...passing, play: { errors: [], hasScene: false, meshes: 0, ready: false } } }),
    });
    const out = (await h.call('check_game', { gameMode: 'KartMode' })) as { verdict: string };

    expect(out.verdict).toMatch(/^check_game: FAILED\nNo Babylon scene was created on \/play for KartMode/);
    expect(h.state.lastCheck!.ok).toBe(false);
  });

  it('drops an oversized screenshot with a note (whole or nothing)', async () => {
    const h = harness({
      answer: () => ({
        result: { ...passing, screenshot: { base64: 'A'.repeat(MAX_SCREENSHOT_BASE64 + 1), mimeType: 'image/jpeg' } },
      }),
    });
    const out = (await h.call('check_game', { gameMode: 'KartMode' })) as { verdict: string; screenshot?: unknown };

    expect(out.screenshot).toBeUndefined();
    expect(out.verdict).toContain('too large');
  });

  it('returns the image as a vision part', () => {
    const h = harness();
    const t = h.tools.check_game as unknown as { experimental_toToolResultContent: (r: unknown) => unknown };

    expect(
      t.experimental_toToolResultContent({
        verdict: 'check_game: PASSED',
        screenshot: { base64: 'QQ', mimeType: 'image/jpeg' },
      }),
    ).toEqual([
      { type: 'text', text: 'check_game: PASSED' },
      { type: 'image', data: 'QQ', mimeType: 'image/jpeg' },
    ]);
    expect(t.experimental_toToolResultContent({ verdict: 'x' })).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('a relay error leaves lastCheck unset', async () => {
    const h = harness({ answer: () => ({ error: 'The tool did not respond in time.' }) });
    const out = (await h.call('check_game', {})) as { verdict: string };

    expect(out.verdict).toBe('The workspace could not complete this: The tool did not respond in time.');
    expect(h.state.lastCheck).toBeNull();
  });
});

describe('update_todos', () => {
  it('emits the items, drops empty content and coerces an unknown status', async () => {
    const h = harness();
    const out = await h.call('update_todos', {
      items: [
        { content: 'Write the GameMode', status: 'completed' },
        { content: 'Build the HUD', status: 'in_progress' },
        { content: '  ', status: 'pending' },
        { content: 'Wire the landing page', status: 'doing' },
        { status: 'pending' },
      ],
    });

    const expected = [
      { content: 'Write the GameMode', status: 'completed' },
      { content: 'Build the HUD', status: 'in_progress' },
      { content: 'Wire the landing page', status: 'pending' },
    ];

    expect(out).toBe('Todo list updated (1/3 complete).');
    expect(h.todos).toEqual([expected]);
    expect(h.state.todos).toEqual(expected);
    expect(h.emitted).toHaveLength(0);
  });

  it('the schema admits a bare-string item and odd field types, and execute coerces them', async () => {
    const h = harness();
    const args = { items: ['Plan the level', { content: 'Build the HUD', status: 7 }, { content: 3 }] };
    const schema = (
      h.tools.update_todos as unknown as { parameters: { safeParse: (v: unknown) => { success: boolean } } }
    ).parameters;

    expect(schema.safeParse(args).success).toBe(true);
    expect(await h.call('update_todos', args)).toBe('Todo list updated (0/2 complete).');
    expect(h.state.todos).toEqual([
      { content: 'Plan the level', status: 'pending' },
      { content: 'Build the HUD', status: 'pending' },
    ]);
  });

  it('a missing list clears the checklist rather than throwing', async () => {
    const h = harness();
    expect(await h.call('update_todos', {})).toBe('Todo list updated (0/0 complete).');
  });
});

describe('checkBreakerTripped', () => {
  it('requires 3 EQUAL signatures', () => {
    const s = newWorkspaceTurnState();

    s.checkFailureSignatures = ['a', 'a'];
    expect(checkBreakerTripped(s)).toBe(false);

    s.checkFailureSignatures = ['a', 'b', 'a'];
    expect(checkBreakerTripped(s)).toBe(false);

    s.checkFailureSignatures = ['a', 'a', 'a'];
    expect(checkBreakerTripped(s)).toBe(true);
  });

  it('trips after three identical failing checks through the tool, and keeps only the last 3', async () => {
    const failing = {
      ok: false,
      typecheck: { ok: false, errors: ['error TS2339 same'] },
      home: { errors: [] },
      play: null,
      screenshot: null,
    };
    const h = harness({ answer: () => ({ result: failing }) });

    await h.call('check_game', {});
    await h.call('check_game', {});
    expect(checkBreakerTripped(h.state)).toBe(false);

    await h.call('check_game', {});
    await h.call('check_game', {});
    expect(h.state.checkFailureSignatures).toHaveLength(3);
    expect(checkBreakerTripped(h.state)).toBe(true);
  });
});

describe('summarizeWorkspace', () => {
  it('lists writes in first-write order, unique, and caps check errors to 10', async () => {
    const h = harness();
    await h.call('write_file', { file_path: 'b.ts', content: '1' });
    await h.call('write_file', { file_path: 'a.ts', content: '1' });
    await h.call('write_file', { file_path: 'b.ts', content: '2' });
    h.state.lastCheck = { ok: false, errors: Array.from({ length: 15 }, (_, i) => `e${i}`), afterWriteSeq: 3 };

    const summary = summarizeWorkspace(h.overlay, h.state);

    expect(summary.writes).toEqual(['b.ts', 'a.ts']);
    expect(summary.lastCheck!.errors).toHaveLength(10);
    expect(summary.commands).toEqual([]);
  });
});

describe("write tools accept read_file's `path` spelling (found live, T9)", () => {
  /* Through the zod schema, as the SDK does — zod strips unknown keys, which is how `path` was lost. */
  const callParsed = async (h: ReturnType<typeof harness>, name: string, args: Record<string, unknown>) => {
    const t = h.tools[name] as unknown as {
      parameters: { parse: (a: unknown) => unknown };
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };

    return t.execute(t.parameters.parse(args), { toolCallId: `call_${++callSeq}`, abortSignal: undefined });
  };

  it('write_file with `path` writes', async () => {
    const h = harness();
    const out = await callParsed(h, 'write_file', { path: 'src/scripts/Pause.ts', content: 'x' });

    expect(String(out)).not.toMatch(/needs a "file_path"/);
    expect(h.emitted.map((e) => (e.params as { path: string }).path)).toEqual(['src/scripts/Pause.ts']);
  });

  it('edit_file with `path` edits', async () => {
    const h = harness({
      files: { '/home/project/src/a.ts': { type: 'file', content: 'const a = 1;', isBinary: false } },
    });
    const out = await callParsed(h, 'edit_file', { path: 'src/a.ts', old_string: '1', new_string: '2' });

    expect(String(out)).not.toMatch(/needs a "file_path"/);
    expect((h.emitted[0]?.params as { content: string }).content).toBe('const a = 2;');
  });

  it('file_path wins when both are sent', async () => {
    const h = harness();
    await callParsed(h, 'write_file', { file_path: 'src/b.ts', path: 'src/c.ts', content: 'x' });

    expect((h.emitted[0].params as { path: string }).path).toBe('src/b.ts');
  });
});

describe('the one-per-turn update_todos nudge (T9 fix loop 2)', () => {
  it('rides on the first successful write when there is no list, and only once', async () => {
    const h = harness();

    expect(String(await h.call('write_file', { file_path: 'src/a.ts', content: 'x' }))).toContain(TODO_NUDGE);
    expect(String(await h.call('write_file', { file_path: 'src/b.ts', content: 'x' }))).not.toContain(TODO_NUDGE);
  });

  it('also rides on a first edit_file', async () => {
    const h = harness({
      files: { '/home/project/src/a.ts': { type: 'file', content: 'const a = 1;', isBinary: false } },
    });

    expect(String(await h.call('edit_file', { file_path: 'src/a.ts', old_string: '1', new_string: '2' }))).toContain(
      TODO_NUDGE,
    );
  });

  it('never once a list exists', async () => {
    const h = harness();
    await h.call('update_todos', { items: [{ content: 'Add HUD', status: 'in_progress' }] });

    expect(String(await h.call('write_file', { file_path: 'src/a.ts', content: 'x' }))).not.toContain(TODO_NUDGE);
  });

  it('never in plan mode', async () => {
    const h = harness({ planOnly: true });

    expect(String(await h.call('write_file', { file_path: '_specs/x_plan.md', content: 'x' }))).not.toContain(
      TODO_NUDGE,
    );
  });

  it('a refused write does not spend the nudge', async () => {
    const h = harness();
    await h.call('write_file', {});

    expect(String(await h.call('write_file', { file_path: 'src/a.ts', content: 'x' }))).toContain(TODO_NUDGE);
  });
});

describe('the nudge is once per turn ACROSS tools (T9 fix loop 3)', () => {
  it('a command that comes first takes it; the later write does not repeat it', async () => {
    const h = harness({ answer: () => ({ result: { exitCode: 0, output: 'ok' } }) });

    expect(String(await h.call('run_command', { command: 'npm run build' }))).toContain(TODO_NUDGE);
    expect(String(await h.call('write_file', { file_path: 'src/a.ts', content: 'x' }))).not.toContain(TODO_NUDGE);
  });

  it('a read that already took it (shared state) leaves writes clean', async () => {
    const h = harness();
    expect(todoNudgeFor(h.state, false)).toBe(TODO_NUDGE); // what read_file's wiring calls

    expect(String(await h.call('write_file', { file_path: 'src/a.ts', content: 'x' }))).not.toContain(TODO_NUDGE);
  });
});

describe('a passing check asks for the checklist to be ticked (T9 re-attempt)', () => {
  const failing = { ...passing, ok: false, typecheck: { ok: false, errors: ['TS1 boom'] } };
  const verdictOf = async (result: unknown, todos: TodoItem[] | null) => {
    const h = harness({ answer: () => ({ result }) });
    h.state.todoNudged = true; // isolate the tick hint from the first-result nudge

    if (todos) {
      await h.call('update_todos', { items: todos });
    }

    return ((await h.call('check_game', { gameMode: 'KartMode' })) as { verdict: string }).verdict;
  };

  it('pass + unfinished items → the hint', async () => {
    const v = await verdictOf(passing, [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ]);
    expect(v).toContain(TODO_TICK_HINT);
  });

  it('pass + every item completed → no hint', async () => {
    expect(await verdictOf(passing, [{ content: 'a', status: 'completed' }])).not.toContain(TODO_TICK_HINT);
  });

  it('fail → no hint (the model is busy fixing)', async () => {
    expect(await verdictOf(failing, [{ content: 'a', status: 'pending' }])).not.toContain(TODO_TICK_HINT);
  });

  it('no todos → no hint', async () => {
    expect(await verdictOf(passing, null)).not.toContain(TODO_TICK_HINT);
  });
});
