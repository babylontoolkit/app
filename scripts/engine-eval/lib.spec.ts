/**
 * The engine eval harness's pure helpers (`scripts/engine-eval/lib.mjs`, managed-agents-engine plan T11).
 *
 * The harness IS the T12 evidence, so its arithmetic and its reading of the wire are pinned: a parser
 * that drops a data part split across two network chunks silently leaves a tool call unanswered (the run
 * then hangs and reads as an engine failure), and a report that miscounts makes the switch decision on a
 * wrong number.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateResults,
  applyStreamPart,
  buildFileMap,
  buildGameCheckResult,
  classifyRunCommand,
  createDataStreamParser,
  formatReport,
  isStrictPass,
  median,
  newTurnTally,
  parseArgs,
  parseResultsJsonl,
  parseTypecheckOutput,
  resolveInside,
} from './lib.mjs';

describe('createDataStreamParser', () => {
  const wire = [
    '0:"Building your "\n',
    '0:"kart racer."\n',
    'g:"Thinking about drift."\n',
    '2:[{"type":"workspace-tool-call","generationId":"gen_1","toolCallId":"t1","op":"write","params":{"path":"src/a.ts","content":"x\\ny"}}]\n',
    '8:[{"type":"credits","value":{"creditsCharged":42,"balanceAfter":100}}]\n',
    '3:"Custom error: boom"\n',
  ].join('');

  it('decodes every line of a realistic stream', () => {
    const parser = createDataStreamParser();
    const parts = [...parser.push(wire), ...parser.flush()];

    expect(parts.map((p: any) => p.code)).toEqual(['0', '0', 'g', '2', '8', '3']);
    expect((parts[3] as any).value[0].params.content).toBe('x\ny');
  });

  it('a data part split across chunks at every offset decodes exactly once, intact', () => {
    for (let cut = 1; cut < wire.length; cut++) {
      const parser = createDataStreamParser();
      const parts = [...parser.push(wire.slice(0, cut)), ...parser.push(wire.slice(cut)), ...parser.flush()];

      expect(parts.length).toBe(6);
      expect(parts.every((p: any) => !p.invalid)).toBe(true);
      expect((parts[3] as any).value[0].toolCallId).toBe('t1');
    }
  });

  it('withholds a partial line until its newline arrives (CONTROL: nothing is emitted early)', () => {
    const parser = createDataStreamParser();

    expect(parser.push('2:[{"type":"media-task"')).toEqual([]);
    expect(parser.push(',"taskId":"m1"}]\n')).toEqual([{ code: '2', value: [{ type: 'media-task', taskId: 'm1' }] }]);
  });

  it('a malformed line is reported, never thrown', () => {
    const parser = createDataStreamParser();
    const parts = parser.push('2:[{"broken"\n0:"ok"\n');

    expect(parts[0]).toMatchObject({ code: '2', invalid: true });
    expect(parts[1]).toEqual({ code: '0', value: 'ok' });
  });

  it('flush emits a final line that has no trailing newline', () => {
    const parser = createDataStreamParser();

    expect(parser.push('0:"tail"')).toEqual([]);
    expect(parser.flush()).toEqual([{ code: '0', value: 'tail' }]);
  });
});

describe('applyStreamPart', () => {
  it('tallies text, reasoning, data, errors, credits and agentMeta', () => {
    const turn = newTurnTally();
    const parser = createDataStreamParser();

    for (const part of parser.push(
      '0:"a"\n0:"b"\ng:"xyz"\n2:[{"type":"agent-todos"},{"type":"media-task","credits":9}]\n' +
        '8:[{"type":"usage","value":{"promptTokens":1}},{"type":"agentMeta","value":{"generationId":"gen_9","outcome":{"state":"finished"}}}]\n' +
        '8:[{"type":"credits","value":{"creditsCharged":30}}]\n8:[{"type":"credits","value":{"creditsCharged":12}}]\n3:"bad"\n',
    )) {
      applyStreamPart(turn, part);
    }

    expect(turn.text).toBe('ab');
    expect(turn.reasoningChars).toBe(3);
    expect(turn.data.map((d: any) => d.type)).toEqual(['agent-todos', 'media-task']);
    expect(turn.credits).toBe(42);
    expect(turn.agentMeta).toMatchObject({ generationId: 'gen_9' });
    expect(turn.usage).toEqual({ promptTokens: 1 });
    expect(turn.errors).toEqual(['bad']);
  });
});

describe('typecheck + game check', () => {
  it('a clean tsc that read TypeScript passes', () => {
    expect(parseTypecheckOutput(0, 'Files: 120\nLines of TypeScript: 9876\n').value).toEqual({ ok: true, errors: [] });
  });

  it('a clean tsc that read ZERO lines is unavailable, never a pass', () => {
    const verdict = parseTypecheckOutput(0, 'Lines of TypeScript: 0\n');

    expect(verdict.value).toBe('unavailable');
    expect(verdict.reason).toMatch(/0 lines/);
  });

  it('tsc errors fail the check', () => {
    const verdict = parseTypecheckOutput(
      2,
      "src/pages/Home.tsx(3,14): error TS2322: Type 'string' is not assignable.\n",
    );

    expect(verdict.value).toEqual({
      ok: false,
      errors: ["src/pages/Home.tsx(3,14): error TS2322: Type 'string' is not assignable."],
    });
  });

  it('buildGameCheckResult: a failed vite build fails the check through home.errors', () => {
    const result = buildGameCheckResult({
      tsc: { exitCode: 0, output: 'Lines of TypeScript: 500' },
      build: { ok: false, output: 'Could not resolve "./missing"' },
    });

    expect(result.ok).toBe(false);
    expect(result.home.errors[0]).toMatch(/vite build/);
    expect(result.play).toBeNull();
    expect(isStrictPass(result)).toBe(false);
  });

  it('buildGameCheckResult: typecheck + build passing is a strict pass (CONTROL)', () => {
    const result = buildGameCheckResult({
      tsc: { exitCode: 0, output: 'Lines of TypeScript: 500' },
      build: { ok: true, output: '' },
    });

    expect(result).toEqual({
      ok: true,
      typecheck: { ok: true, errors: [] },
      home: { errors: [] },
      play: null,
      screenshot: null,
    });
    expect(isStrictPass(result)).toBe(true);
  });

  it("an 'unavailable' typecheck is not a strict pass even though the server-shaped ok is true", () => {
    const result = buildGameCheckResult({ tsc: { exitCode: 0, output: '' }, build: { ok: true, output: '' } });

    expect(result.ok).toBe(true);
    expect(isStrictPass(result)).toBe(false);
  });
});

describe('classifyRunCommand', () => {
  it('allows npm run scripts, including && chains', () => {
    expect(classifyRunCommand('npm run build')).toEqual({ kind: 'allow', segments: ['npm run build'] });
    expect(classifyRunCommand('npm run lint && npm run build').kind).toBe('allow');
  });

  it('refuses installs, dev/preview, and anything that is not npm', () => {
    expect(classifyRunCommand('npm install three')).toMatchObject({ kind: 'refuse', reason: /dependencies are fixed/ });
    expect(classifyRunCommand('npm run dev')).toMatchObject({ kind: 'refuse', reason: /already running/ });
    expect(classifyRunCommand('npm run build && rm -rf /').kind).toBe('refuse');
    expect(classifyRunCommand('npx tsc').kind).toBe('refuse');
    expect(classifyRunCommand('').kind).toBe('refuse');
  });
});

describe('buildFileMap', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips node_modules/dist/.git, marks binaries, keeps text content, adds folders', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-eval-'));
    fs.mkdirSync(path.join(dir, 'src/pages'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/pages/Home.tsx'), 'export default 1;\n');
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'x');
    fs.writeFileSync(path.join(dir, 'dist/index.html'), 'x');
    fs.writeFileSync(path.join(dir, '.git/HEAD'), 'x');
    fs.writeFileSync(path.join(dir, 'public/babylon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'public/data.dat'), Buffer.from([1, 0, 2]));
    fs.writeFileSync(path.join(dir, 'tsconfig.app.tsbuildinfo'), '{}');

    const map = buildFileMap(dir, { workDir: '/home/project' });

    expect(Object.keys(map).sort()).toEqual([
      '/home/project/public',
      '/home/project/public/babylon.png',
      '/home/project/public/data.dat',
      '/home/project/src',
      '/home/project/src/pages',
      '/home/project/src/pages/Home.tsx',
    ]);
    expect(map['/home/project/src/pages/Home.tsx']).toEqual({
      type: 'file',
      content: 'export default 1;\n',
      isBinary: false,
    });
    expect(map['/home/project/public/babylon.png']).toEqual({ type: 'file', content: '', isBinary: true, size: 4 });
    expect(map['/home/project/public/data.dat']).toMatchObject({ isBinary: true, content: '' });
    expect(map['/home/project/src']).toEqual({ type: 'folder' });
  });
});

describe('resolveInside', () => {
  it('resolves project-relative and sandbox-absolute paths, refuses escapes', () => {
    expect(resolveInside('/r', 'src/a.ts')?.rel).toBe('src/a.ts');
    expect(resolveInside('/r', '/home/project/src/a.ts')?.rel).toBe('src/a.ts');
    expect(resolveInside('/r', './src/../src/a.ts')?.rel).toBe('src/a.ts');
    expect(resolveInside('/r', '../etc/passwd')).toBeNull();
    expect(resolveInside('/r', '')).toBeNull();
  });
});

describe('report', () => {
  it('median handles odd, even, empty and non-numbers', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([null, undefined, Number.NaN, 5])).toBe(5);
  });

  const records = [
    {
      engine: 'managed',
      prompt: 'mario',
      success: true,
      minutes: 6,
      minutesToFirstWrite: 2,
      credits: 300,
      errorCount: 0,
    },
    {
      engine: 'legacy',
      prompt: 'mario',
      success: false,
      minutes: 25,
      minutesToFirstWrite: 7,
      credits: 900,
      errorCount: 2,
    },
    {
      engine: 'managed',
      prompt: 'mario',
      success: false,
      minutes: 10,
      minutesToFirstWrite: 4,
      credits: 500,
      errorCount: 1,
    },
    { engine: 'legacy', prompt: 'edit', success: true, minutes: 2, credits: 40, errorCount: 0, rawCostUsd: 0.1 },
    { engine: 'managed', prompt: 'mario', success: true, minutes: 7, minutesToFirstWrite: null, credits: 350 },
  ];

  it('groups by (prompt, engine) and computes success rate and medians', () => {
    const rows = aggregateResults(records);

    expect(rows.map((r: any) => `${r.prompt}/${r.engine}`)).toEqual(['mario/legacy', 'mario/managed', 'edit/legacy']);

    const managed = rows.find((r: any) => r.prompt === 'mario' && r.engine === 'managed');

    expect(managed).toMatchObject({
      runs: 3,
      successes: 2,
      failedRuns: 1,
      errors: 1,
      medianMinutes: 7,
      medianFirstWriteMinutes: 3,
      medianCredits: 350,
      medianRawUsd: null,
    });
    expect(managed!.successRate).toBeCloseTo(2 / 3);
  });

  it('formats a markdown table with one row per group', () => {
    const table = formatReport(aggregateResults(records));
    const lines = table.split('\n');

    expect(lines[0]).toMatch(/^\| Prompt \| Engine \| Runs \| Success/);
    expect(lines).toHaveLength(2 + 3);
    expect(table).toContain('| mario | managed | 3 | 2/3 (67%) | 7.0 | 3.0 | 350 | — | 1 | 1 |');
    expect(table).toContain('| edit | legacy | 1 | 1/1 (100%) | 2.0 | — | 40 | 0.10 | 0 | 0 |');
  });

  it('an empty result set says so rather than printing an empty table', () => {
    expect(formatReport(aggregateResults([]))).toBe('No eval results yet.');
  });

  it('parseResultsJsonl skips malformed lines instead of throwing', () => {
    const { records: parsed, skipped } = parseResultsJsonl(
      `${JSON.stringify(records[0])}\nnot json\n\n{"engine":"x"}\n${JSON.stringify(records[1])}\n`,
    );

    expect(parsed).toHaveLength(2);
    expect(skipped).toBe(2);
  });
});

describe('parseArgs', () => {
  it('reads values and bare flags', () => {
    expect(parseArgs(['--engines', 'legacy,managed', '--n', '2', '--report', '--base', 'http://x'])).toEqual({
      engines: 'legacy,managed',
      n: '2',
      report: true,
      base: 'http://x',
    });
  });
});
