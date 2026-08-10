/**
 * `read_file` (`file-tools.ts`) — the other half of Inversion 3.
 *
 * The budget cases are money-path: an unbounded `read_file` is the 36k-token dump reassembled one
 * call at a time, at WORSE cost, because every read re-sends the growing conversation. The refusal
 * cases are correctness-path: a throw here kills a paid generation after the tokens are spent.
 */
import { describe, expect, it } from 'vitest';
import { createFileTools, MAX_FILE_READS, MAX_READ_CHARS, resolveFile, suggestPaths } from './file-tools';
import type { FileMap } from '~/lib/.server/llm/constants';
import { type AgentBudgets, DEFAULT_AGENT_BUDGETS } from './budgets';

const text = (content: string) => ({ type: 'file' as const, content, isBinary: false });
const binary = (size: number) => ({ type: 'file' as const, content: '', isBinary: true, size });

const ctx = (files: Record<string, unknown>) => ({
  files: files as unknown as FileMap,
  readThisTurn: new Set<string>(),
  charsThisTurn: { total: 0 },
});

const run = async (context: ReturnType<typeof ctx>, path?: string) => {
  const tools = createFileTools(context);
  return (await tools.read_file.execute!({ path } as { path?: string }, {} as never)) as string;
};

describe('read_file — the happy path', () => {
  it('returns the file body for a project-relative path', async () => {
    const c = ctx({ 'src/main.ts': text('export const x = 1;') });
    expect(await run(c, 'src/main.ts')).toBe('export const x = 1;');
  });

  /*
   * The map is keyed sandbox-absolute; the MANIFEST shows project-relative paths, so that is what the
   * model asks for. Both spellings must resolve or the model is shown a path it cannot read — the
   * `toSandboxStoreKey` lesson, one layer up.
   */
  it('resolves a manifest path against a sandbox-absolute map', async () => {
    const c = ctx({ '/home/project/src/main.ts': text('body') });
    expect(await run(c, 'src/main.ts')).toBe('body');
    expect(await run(c, '/home/project/src/main.ts')).toBe('body');
  });

  /*
   * Re-reading must stay free, and must not spend budget. It is how a model recovers its bearings
   * after a long tool loop, and charging for it turns a recovery into a refusal.
   */
  it('re-reads a file it already read without spending budget', async () => {
    const c = ctx({ 'a.ts': text('one') });
    await run(c, 'a.ts');
    await run(c, 'a.ts');
    await run(c, 'a.ts');

    expect(c.readThisTurn.size).toBe(1);
    expect(c.charsThisTurn.total).toBe(3);
  });
});

describe('read_file — recoverable mistakes never throw', () => {
  /*
   * 🔴 Every one of these returns a STRING. A throw inside `execute` aborts the stream and kills the
   * generation after the tokens are spent — the measured `load_skill({})` failure. `path` is
   * `.optional()` in the schema for exactly this reason.
   */
  it('handles a missing argument', async () => {
    const c = ctx({ 'a.ts': text('x') });
    expect(await run(c, undefined)).toMatch(/needs a "path"/);
  });

  it('handles an empty argument', async () => {
    const c = ctx({ 'a.ts': text('x') });
    expect(await run(c, '   ')).toMatch(/needs a "path"/);
  });

  it('suggests near-matches for a wrong path', async () => {
    const c = ctx({ 'src/pages/Home.tsx': text('x'), 'src/pages/Home.css': text('y') });
    const out = await run(c, 'Home.tsx');

    expect(out).toContain('src/pages/Home.tsx');
  });

  it('says so plainly when nothing is close', async () => {
    const c = ctx({ 'src/main.ts': text('x') });
    expect(await run(c, 'totally/unrelated.py')).toMatch(/No file at/);
  });
});

describe('read_file — what may never be returned', () => {
  /*
   * SPEC §1.3 principle 10. The map holds `isBinary` + a size and an EMPTY body — returning it hands
   * the model an empty string it may then write back over a texture.
   */
  it('never returns binary content, and says why', async () => {
    const c = ctx({ 'public/player.png': binary(107_000) });
    const out = await run(c, 'public/player.png');

    expect(out).toMatch(/binary file/);
    expect(out).toContain('107000');
    expect(c.readThisTurn.size).toBe(0);
  });

  /*
   * Opaque = text for which no correct edit exists. `public/scripts/` alone was half the starter's
   * text payload in the dump; letting the model read it back one call at a time undoes the change.
   */
  it('refuses opaque files with their reason', async () => {
    const c = ctx({ 'public/scripts/babylon.js': text('x'.repeat(500_000)) });
    const out = await run(c, 'public/scripts/babylon.js');

    expect(out).toMatch(/generated, vendored or minified/);
    expect(c.charsThisTurn.total).toBe(0);
  });
});

describe('read_file — the budgets', () => {
  /*
   * 🔴 THE WHOLE POINT. Without a cap, a model that reads everything has rebuilt the dump one call at
   * a time — and worse, because each read re-sends the growing conversation at full rate.
   */
  it('refuses past the read COUNT and names what it already has', async () => {
    const files: Record<string, unknown> = {};

    for (let i = 0; i < MAX_FILE_READS + 5; i++) {
      files[`src/f${String(i).padStart(3, '0')}.ts`] = text('body');
    }

    const c = ctx(files);

    for (let i = 0; i < MAX_FILE_READS; i++) {
      await run(c, `src/f${String(i).padStart(3, '0')}.ts`);
    }

    const refused = await run(c, `src/f${String(MAX_FILE_READS).padStart(3, '0')}.ts`);

    expect(refused).toMatch(/REFUSED/);
    expect(refused).toContain('src/f000.ts');
    expect(c.readThisTurn.size).toBe(MAX_FILE_READS);
  });

  /*
   * The count cap alone is not enough: 24 reads of 100KB generated files is the dump again. Whichever
   * ceiling binds first, binds.
   */
  it('refuses past the BYTE budget even when the count is fine', async () => {
    const c = ctx({
      'a.ts': text('x'.repeat(MAX_READ_CHARS)),
      'b.ts': text('small'),
    });

    await run(c, 'a.ts');

    const refused = await run(c, 'b.ts');

    expect(refused).toMatch(/REFUSED/);
    expect(c.readThisTurn.size).toBe(1);
  });

  /*
   * A refusal must tell the model what to do instead. "REFUSED" with no next action produces a model
   * that asks the user what to do — the half-written turn wearing a question mark.
   */
  it('tells the model to write the code rather than keep reading', async () => {
    const c = ctx({ 'a.ts': text('x'.repeat(MAX_READ_CHARS)), 'b.ts': text('s') });
    await run(c, 'a.ts');

    expect(await run(c, 'b.ts')).toMatch(/write the code now/i);
  });
});

describe('the pure helpers', () => {
  it('resolveFile matches on the project-relative path', () => {
    const files = { '/home/project/src/a.ts': text('x') } as unknown as FileMap;

    expect(resolveFile(files, 'src/a.ts')?.path).toBe('src/a.ts');
    expect(resolveFile(files, 'src/missing.ts')).toBeNull();
  });

  it('resolveFile ignores folders', () => {
    const files = { src: { type: 'folder' } } as unknown as FileMap;
    expect(resolveFile(files, 'src')).toBeNull();
  });

  it('suggestPaths prefers a basename match over a substring match', () => {
    const files = {
      'src/deep/nested/Home.tsx': text('x'),
      'src/HomeScreenUtils.ts': text('y'),
    } as unknown as FileMap;

    expect(suggestPaths(files, 'Home.tsx')[0]).toBe('src/deep/nested/Home.tsx');
  });

  it('suggestPaths returns nothing for a wholly unrelated path', () => {
    const files = { 'src/main.ts': text('x') } as unknown as FileMap;
    expect(suggestPaths(files, 'zzzz.py')).toEqual([]);
  });
});

/**
 * 🔴 A PLANNING ARTIFACT SPENDS ITS OWN POOL (owner, 2026-08-09).
 *
 * Reported live: a `/bt-execute` turn spent its budget on eleven system-API files, was then refused
 * the 28KB plan it was executing against, and correctly declined to tick an Acceptance box it could no
 * longer verify. Charging a plan to the same pool as the source it describes means the harder a turn
 * looks at the project, the less able it is to check its own work — exactly backwards.
 *
 * RESERVED, never exempt. The two halves are tested separately because "unbounded" and "reserved" pass
 * every test that only asks whether the plan read succeeded.
 */
describe('read_file — the _specs/ pool', () => {
  const PLAN = 'x'.repeat(5_000);

  const planCtx = (files: Record<string, unknown>, budgets?: Partial<AgentBudgets>) => ({
    ...ctx(files),
    planCharsThisTurn: { total: 0 },
    budgets: { ...DEFAULT_AGENT_BUDGETS, ...budgets },
  });

  /* 🔴 The reported bug: a spent general budget must not refuse the plan. */
  it('reads the plan when the project budget is exhausted', async () => {
    const c = planCtx({ '_specs/kart_plan.md': text(PLAN) });
    c.charsThisTurn.total = DEFAULT_AGENT_BUDGETS.maxReadChars; // eleven system files already read
    c.readThisTurn = new Set(Array.from({ length: DEFAULT_AGENT_BUDGETS.maxFileReads }, (_, i) => `src/f${i}.ts`));

    expect(await run(c as never, '_specs/kart_plan.md')).toBe(PLAN);
  });

  it('does not charge the project pool for a plan read', async () => {
    const c = planCtx({ '_specs/kart_plan.md': text(PLAN) });
    await run(c as never, '_specs/kart_plan.md');

    expect(c.charsThisTurn.total).toBe(0);
    expect(c.planCharsThisTurn.total).toBe(5_000);
  });

  /*
   * 🔴 The other half: a reserved pool that is never checked is an unbounded read path wearing the
   * shape of a budget. Without this, "exempt `_specs/`" passes every test above.
   */
  it('refuses once the plan pool itself is spent', async () => {
    const c = planCtx({ '_specs/kart_plan.md': text(PLAN) }, { maxPlanReadChars: 4_000 });
    c.planCharsThisTurn.total = 4_000;

    expect(await run(c as never, '_specs/kart_plan.md')).toMatch(/REFUSED/);
  });

  /*
   * 🔴 The pool must accumulate ACROSS calls. A counter created inside `execute` starts at zero every
   * invocation, so the ceiling could never be reached — the bug this exact test caught while it was
   * being written.
   */
  it('accumulates across reads rather than resetting per call', async () => {
    const c = planCtx(
      { '_specs/a_plan.md': text(PLAN), '_specs/b_plan.md': text(PLAN), '_specs/c_plan.md': text(PLAN) },
      { maxPlanReadChars: 12_000 },
    );

    await run(c as never, '_specs/a_plan.md');
    await run(c as never, '_specs/b_plan.md');
    expect(c.planCharsThisTurn.total).toBe(10_000);

    expect(await run(c as never, '_specs/c_plan.md')).toBe(PLAN); // 10,000 < 12,000 — still allowed
    expect(await run(c as never, '_specs/a_plan.md')).toBe(PLAN); // a re-read is always free
  });

  /*
   * 🔴 The pool rides on the SHARED path rule, so the quarantine has no back door. `isPlanArtifactPath`
   * rejects traversal; a bespoke `startsWith('_specs/')` here would let `_specs/../src/x.ts` read the
   * whole project for free.
   */
  it('does not let a traversal path ride the plan pool', async () => {
    const c = planCtx({ 'src/secret.ts': text('shh') });
    c.charsThisTurn.total = DEFAULT_AGENT_BUDGETS.maxReadChars;

    expect(await run(c as never, '_specs/../src/secret.ts')).toMatch(/REFUSED/);
  });

  /* CONTROL — ordinary source still spends the ordinary pool, or the split has just disabled the budget. */
  it('still charges the project pool for ordinary source', async () => {
    const c = planCtx({ 'src/main.ts': text('export const x = 1;') });
    await run(c as never, 'src/main.ts');

    expect(c.charsThisTurn.total).toBe(19);
    expect(c.planCharsThisTurn.total).toBe(0);
  });
});

/** The budgets are CONFIGURABLE — a context that carries them must be honored over the defaults. */
describe('read_file — configured budgets', () => {
  it('honors a raised char budget', async () => {
    const c = {
      ...ctx({ 'src/main.ts': text('abc') }),
      budgets: { ...DEFAULT_AGENT_BUDGETS, maxReadChars: 200_000 },
    };
    c.charsThisTurn.total = 150_000; // over the shipped 120k, under the configured 200k

    expect(await run(c as never, 'src/main.ts')).toBe('abc');
  });

  it('honors a lowered count budget', async () => {
    const c = {
      ...ctx({ 'src/main.ts': text('abc') }),
      budgets: { ...DEFAULT_AGENT_BUDGETS, maxFileReads: 1 },
    };
    c.readThisTurn = new Set(['src/other.ts']);

    expect(await run(c as never, 'src/main.ts')).toMatch(/REFUSED/);
  });
});
