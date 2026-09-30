import { describe, expect, it } from 'vitest';
import {
  finishRow,
  hasActivity,
  MAX_TRACKED_GENERATIONS,
  outcomeFromResult,
  readMessageGenerationId,
  readWorkspaceSummary,
  resolveActivityState,
  rowsFromSummary,
  setTodos,
  startRow,
  type WorkspaceActivityStore,
} from './activity';
import type { GameCheckResult } from '~/lib/agent/workspace-protocol-types';

const empty = (): WorkspaceActivityStore => ({ current: null, byGeneration: {} });

const write = (id: string, path = 'src/pages/Pause.tsx') => ({
  toolCallId: id,
  op: 'write' as const,
  params: { path, content: 'x' },
});

describe('startRow / finishRow', () => {
  it('a write start is a running row, then done with the "Wrote" label', () => {
    let s = startRow(empty(), 'g1', write('t1'));

    expect(s.current).toBe('g1');
    expect(s.byGeneration.g1.rows).toEqual([
      expect.objectContaining({
        toolCallId: 't1',
        kind: 'write',
        status: 'running',
        label: 'Writing `src/pages/Pause.tsx`',
      }),
    ]);

    s = finishRow(s, 'g1', 't1', { ok: true });
    expect(s.byGeneration.g1.rows[0]).toMatchObject({ status: 'done', label: 'Wrote `src/pages/Pause.tsx`' });
  });

  it('a failed result marks the row failed', () => {
    let s = startRow(empty(), 'g1', { toolCallId: 'r1', op: 'run', params: { command: 'npm run build' } });
    expect(s.byGeneration.g1.rows[0].label).toBe('Running `npm run build`');

    s = finishRow(s, 'g1', 'r1', { ok: false });
    expect(s.byGeneration.g1.rows[0].status).toBe('failed');
  });

  it('labels a passing check, and counts problems on a failing one (1 when the count is 0)', () => {
    let s = startRow(empty(), 'g1', { toolCallId: 'c1', op: 'check', params: {} });
    s = startRow(s, 'g1', { toolCallId: 'c2', op: 'check', params: {} });
    s = startRow(s, 'g1', { toolCallId: 'c3', op: 'check', params: {} });
    expect(s.byGeneration.g1.rows[0].label).toBe('Checking your game…');

    s = finishRow(s, 'g1', 'c1', { ok: true, screenshotDataUrl: 'data:image/png;base64,AAA' });
    s = finishRow(s, 'g1', 'c2', { ok: false, problems: 3 });
    s = finishRow(s, 'g1', 'c3', { ok: false, problems: 0 });

    const [a, b, c] = s.byGeneration.g1.rows;
    expect(a).toMatchObject({
      label: 'Game check passed',
      status: 'done',
      screenshotDataUrl: 'data:image/png;base64,AAA',
    });
    expect(b).toMatchObject({ label: 'Game check found 3 problems', status: 'failed' });
    expect(c).toMatchObject({ label: 'Game check found 1 problem', status: 'failed' });
  });

  it('ignores a duplicate toolCallId (the data array is re-presented every chunk)', () => {
    const s1 = startRow(empty(), 'g1', write('t1'));
    const s2 = startRow(s1, 'g1', write('t1'));

    expect(s2).toBe(s1);
    expect(s2.byGeneration.g1.rows).toHaveLength(1);
  });

  it('finishing an unknown id changes nothing', () => {
    const s = startRow(empty(), 'g1', write('t1'));
    expect(finishRow(s, 'g1', 'nope', { ok: true })).toBe(s);
    expect(finishRow(s, 'g2', 't1', { ok: true })).toBe(s);
  });

  it('keeps generations apart and caps how many it holds', () => {
    let s = empty();

    for (let i = 0; i < MAX_TRACKED_GENERATIONS + 3; i++) {
      s = startRow(s, `g${i}`, write(`t${i}`));
    }

    expect(Object.keys(s.byGeneration)).toHaveLength(MAX_TRACKED_GENERATIONS);
    expect(s.byGeneration.g0).toBeUndefined();
    expect(s.current).toBe(`g${MAX_TRACKED_GENERATIONS + 2}`);
  });
});

describe('setTodos', () => {
  it('last write wins and sets the current generation', () => {
    let s = setTodos(empty(), 'g1', [{ content: 'a', status: 'pending' }]);
    s = setTodos(s, 'g1', [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ]);

    expect(s.current).toBe('g1');
    expect(s.byGeneration.g1.todos).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ]);
  });

  it('does not disturb the rows', () => {
    let s = startRow(empty(), 'g1', write('t1'));
    s = setTodos(s, 'g1', [{ content: 'a', status: 'pending' }]);
    expect(s.byGeneration.g1.rows).toHaveLength(1);
  });
});

describe('rowsFromSummary', () => {
  it('maps writes, commands and the last check', () => {
    const state = rowsFromSummary({
      writes: ['src/a.ts', 'src/b.ts'],
      commands: [
        { command: 'npm install zod', exitCode: 0 },
        { command: 'npm run build', exitCode: 2 },
      ],
      todos: [{ content: 'x', status: 'completed' }],
      lastCheck: { ok: false, errors: ['e1', 'e2'] },
    });

    expect(state.rows.map((r) => [r.kind, r.label, r.status])).toEqual([
      ['write', 'Wrote `src/a.ts`', 'done'],
      ['write', 'Wrote `src/b.ts`', 'done'],
      ['run', 'Ran `npm install zod`', 'done'],
      ['run', '`npm run build` failed', 'failed'],
      ['check', 'Game check found 2 problems', 'failed'],
    ]);
    expect(state.rows.every((r) => r.screenshotDataUrl === undefined)).toBe(true);
    expect(state.todos).toEqual([{ content: 'x', status: 'completed' }]);
  });

  it('a passing check reads passed; no check → no check row', () => {
    expect(rowsFromSummary({ writes: [], commands: [], todos: [], lastCheck: { ok: true, errors: [] } }).rows).toEqual([
      expect.objectContaining({ kind: 'check', label: 'Game check passed', status: 'done' }),
    ]);
    expect(rowsFromSummary({ writes: [], commands: [], todos: [], lastCheck: null }).rows).toEqual([]);
  });
});

describe('outcomeFromResult', () => {
  const check = (over: Partial<GameCheckResult>): GameCheckResult => ({
    ok: true,
    typecheck: { ok: true, errors: [] },
    home: { errors: [] },
    play: { errors: [], hasScene: true, meshes: 3, ready: true },
    screenshot: { base64: 'QUJD', mimeType: 'image/jpeg' },
    ...over,
  });

  it('builds the thumbnail data URL from a check result', () => {
    expect(outcomeFromResult('check', check({}))).toEqual({
      ok: true,
      problems: 0,
      screenshotDataUrl: 'data:image/jpeg;base64,QUJD',
    });
  });

  it('counts typecheck + home + play errors', () => {
    const out = outcomeFromResult(
      'check',
      check({
        ok: false,
        typecheck: { ok: false, errors: ['a', 'b'] },
        home: { errors: ['c'] },
        play: { errors: ['d'], hasScene: false, meshes: 0, ready: false },
        screenshot: null,
      }),
    );
    expect(out).toEqual({ ok: false, problems: 4 });
  });

  it('a relay error is a failure; a non-zero exit is a failure', () => {
    expect(outcomeFromResult('write', undefined, 'refused')).toEqual({ ok: false });
    expect(outcomeFromResult('check', undefined, 'timed out')).toEqual({ ok: false, problems: 1 });
    expect(outcomeFromResult('run', { exitCode: 1, output: '' })).toEqual({ ok: false });
    expect(outcomeFromResult('run', { exitCode: 0, output: '' })).toEqual({ ok: true });
    expect(outcomeFromResult('write', { ok: true })).toEqual({ ok: true });
  });
});

describe('resolveActivityState (D20 keying)', () => {
  const live = setTodos(startRow(empty(), 'g2', write('t1')), 'g2', [{ content: 'a', status: 'pending' }]);
  const summary = { writes: ['src/x.ts'], commands: [], todos: [], lastCheck: null };

  it('the streaming last message shows the CURRENT generation', () => {
    const state = resolveActivityState({
      store: live,
      isLast: true,
      isStreaming: true,
      generationId: null,
      summary: null,
    });
    expect(state).toBe(live.byGeneration.g2);
  });

  it('the streaming message shows nothing when no part of the new request has arrived', () => {
    const cleared = { ...live, current: null };
    expect(
      resolveActivityState({ store: cleared, isLast: true, isStreaming: true, generationId: null, summary: null }),
    ).toBeNull();
  });

  it('a finished message prefers its live state, then the annotation, then nothing', () => {
    expect(resolveActivityState({ store: live, isLast: false, isStreaming: true, generationId: 'g2', summary })).toBe(
      live.byGeneration.g2,
    );

    const fromAnnotation = resolveActivityState({
      store: live,
      isLast: true,
      isStreaming: false,
      generationId: 'gX',
      summary,
    });
    expect(fromAnnotation?.rows[0].label).toBe('Wrote `src/x.ts`');

    expect(
      resolveActivityState({ store: live, isLast: false, isStreaming: false, generationId: 'gX', summary: null }),
    ).toBeNull();
  });

  it('hasActivity is false for an empty state', () => {
    expect(hasActivity({ rows: [], todos: [] })).toBe(false);
    expect(hasActivity(null)).toBe(false);
    expect(hasActivity(live.byGeneration.g2)).toBe(true);
  });
});

describe('annotation readers', () => {
  const annotations = [
    'no-replay',
    { type: 'agentMeta', value: { generationId: 'gen_1' } },
    {
      type: 'agentWorkspace',
      value: {
        writes: ['a.ts', 3],
        commands: [{ command: 'npm i', exitCode: 0 }],
        todos: [],
        lastCheck: { ok: true, errors: [] },
      },
    },
  ];

  it('reads the generation id and a shape-checked summary', () => {
    expect(readMessageGenerationId(annotations)).toBe('gen_1');
    expect(readWorkspaceSummary(annotations)).toEqual({
      writes: ['a.ts'],
      commands: [{ command: 'npm i', exitCode: 0 }],
      todos: [],
      lastCheck: { ok: true, errors: [] },
    });
  });

  it('returns null when absent', () => {
    expect(readMessageGenerationId(['x'])).toBeNull();
    expect(readWorkspaceSummary(undefined)).toBeNull();
  });
});
