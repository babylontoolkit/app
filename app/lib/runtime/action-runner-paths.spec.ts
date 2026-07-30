/**
 * THE PATH AN ACTION NAMES vs THE PATH THE SANDBOX IS ASKED FOR.
 *
 * ## Why this file exists
 *
 * `type="edit"` never worked. Not "worked and regressed" — never, on any provider, since it shipped.
 * The runner turned the model's `filePath="SPEC.md"` into a sandbox path with
 * `nodePath.relative(sandbox.workdir, action.filePath)`, and `path.relative` resolves BOTH arguments
 * against the process cwd first. In the browser that cwd is `/`, so the result was `../../SPEC.md` — a
 * traversal out of the project, which the CodeSandbox provider correctly refuses and WebContainer
 * cannot resolve either (`/home/project` traverses identically).
 *
 * Measured live on a real generation: three `Edit SPEC.md` actions, all failed, against a file sitting
 * in the project root with search blocks that matched it EXACTLY ONCE each when checked by hand.
 *
 * ## How it hid, which is the part worth keeping
 *
 * 1. **A second code path was doing the real work for `type="file"`.** `workbenchStore._runAction`
 *    joins the workdir itself and calls `FilesStore.saveFile(fullPath)` with a correct absolute path.
 *    The runner's own write threw on every single file action — into a `catch` that only logged, while
 *    the action still reported `complete`. So the identical bug was invisible on the common path.
 * 2. **The error text named the wrong cause.** A bare `catch` around the read reported "does not
 *    exist" for ANY failure, and the alert hardcoded "a search/replace block did not match the file".
 *    A path bug was therefore presented as a model accuracy problem, twice over.
 * 3. **3,678 tests passed.** `edit-blocks.spec.ts` and `edit-blocks.live.spec.ts` both test the pure
 *    patcher with a string already in hand. NOTHING drove the runner against a filesystem, so nothing
 *    could see that the file was never read.
 *
 * The tests below drive the REAL `ActionRunner` against a fake FS that behaves like the real one in the
 * one respect that matters: **it refuses a traversal**, exactly as `resolveInWorkdir` does. A fake that
 * accepts any string would pass with the bug restored, which is what "correct by construction" looked
 * like here.
 */
import { describe, expect, it, vi } from 'vitest';
import { ActionRunner, type ActionState } from './action-runner';
import type { ActionAlert } from '~/types/actions';
import type { SandboxProvider } from '~/lib/sandbox';

const WORKDIR = '/project/workspace';

class SandboxPathError extends Error {
  constructor(path: string) {
    super(`Refusing a sandbox path that escapes the project directory: ${path}`);
    this.name = 'SandboxPathError';
  }
}

/**
 * A filesystem keyed by workdir-relative path.
 *
 * 🔴 The traversal refusal is the load-bearing part. It mirrors `resolveInWorkdir`'s
 * `assertNoTraversal`, so a `../../` path fails here for the same reason it fails in production. Drop
 * it and every test in this file passes against the original bug.
 */
function createFakeSandbox(initial: Record<string, string>, onRead?: () => void) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set<string>(['.']);

  const guard = (p: string) => {
    if (p.split('/').some((segment) => segment === '..')) {
      throw new SandboxPathError(p);
    }

    return p;
  };

  const fs = {
    async readFile(p: string, encoding?: string) {
      guard(p);
      onRead?.();

      const content = files.get(p);

      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      }

      return encoding ? content : new TextEncoder().encode(content);
    },
    async writeFile(p: string, data: string) {
      files.set(guard(p), data);
    },
    async mkdir(p: string) {
      dirs.add(guard(p));
    },
    async readdir(p: string) {
      guard(p);

      const prefix = p === '.' ? '' : `${p}/`;

      return [...files.keys()]
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map((key) => key.slice(prefix.length));
    },
  };

  return { sandbox: { workdir: WORKDIR, fs } as unknown as SandboxProvider, files };
}

function createRunner(initial: Record<string, string>, onRead?: () => void) {
  const { sandbox, files } = createFakeSandbox(initial, onRead);
  const alerts: ActionAlert[] = [];

  const runner = new ActionRunner(
    Promise.resolve(sandbox),
    () => ({}) as never,
    (alert) => alerts.push(alert),
    undefined,
    undefined,
    vi.fn(),
  );

  return { runner, files, alerts };
}

const EDIT_BODY = `<<<<<<< SEARCH
- _(Seed placeholder.)_
=======
- Real content.
>>>>>>> REPLACE`;

async function run(
  runner: ActionRunner,
  action: { type: 'file' | 'edit'; filePath: string; content: string },
  actionId = '0',
) {
  const data = {
    artifactId: 'a',
    messageId: 'm',
    actionId,
    action: { ...action, content: action.content },
  } as never;

  runner.addAction(data);
  await runner.runAction(data);

  /*
   * `error` only exists on the failed variant of the union, and every assertion below needs to read it
   * on an action whose status it is ALSO asserting. Widened once here rather than cast at each site.
   */
  return runner.actions.get()[actionId] as ActionState & { error?: string };
}

describe('ActionRunner path resolution — the model emits PROJECT-RELATIVE paths', () => {
  /*
   * The regression test proper. `SPEC.md` is what a model actually emits; before the fix this became
   * `../../SPEC.md`, the fake FS refuses it exactly as the real one does, and the edit fails.
   */
  it('applies an edit to a file the model named relative to the project root', async () => {
    const { runner, files } = createRunner({ 'SPEC.md': '# Spec\n\n- _(Seed placeholder.)_\n' });

    const action = await run(runner, { type: 'edit', filePath: 'SPEC.md', content: EDIT_BODY });

    expect(action.status).toBe('complete');
    expect(files.get('SPEC.md')).toBe('# Spec\n\n- Real content.\n');
  });

  it('applies an edit to a nested file', async () => {
    const { runner, files } = createRunner({ 'src/pages/Home.css': '.a {}\n- _(Seed placeholder.)_\n' });

    const action = await run(runner, { type: 'edit', filePath: 'src/pages/Home.css', content: EDIT_BODY });

    expect(action.status).toBe('complete');
    expect(files.get('src/pages/Home.css')).toContain('- Real content.');
  });

  /*
   * A path already carrying the sandbox root must resolve to the same file, not to a second one — the
   * store keys files absolutely, so both forms reach this code depending on the caller.
   */
  it('accepts a workdir-absolute path as the same file', async () => {
    const { runner, files } = createRunner({ 'SPEC.md': '- _(Seed placeholder.)_\n' });

    const action = await run(runner, {
      type: 'edit',
      filePath: `${WORKDIR}/SPEC.md`,
      content: EDIT_BODY,
    });

    expect(action.status).toBe('complete');
    expect(files.get('SPEC.md')).toBe('- Real content.\n');
    expect([...files.keys()]).toEqual(['SPEC.md']);
  });

  /*
   * A map key written under the OTHER provider's root (a working copy restored across a provider
   * change, §4.5.4c) must rebase rather than traverse.
   */
  it('rebases a path carrying a foreign sandbox root', async () => {
    const { runner, files } = createRunner({ 'SPEC.md': '- _(Seed placeholder.)_\n' });

    const action = await run(runner, {
      type: 'edit',
      filePath: '/home/project/SPEC.md',
      content: EDIT_BODY,
    });

    expect(action.status).toBe('complete');
    expect(files.get('SPEC.md')).toBe('- Real content.\n');
  });

  it('writes a file action to the path the model named', async () => {
    const { runner, files } = createRunner({});

    const action = await run(runner, {
      type: 'file',
      filePath: 'src/scripts/ArenaMode.ts',
      content: 'export const x = 1;\n',
    });

    expect(action.status).toBe('complete');
    expect(files.get('src/scripts/ArenaMode.ts')).toBe('export const x = 1;\n');
  });
});

describe('ActionRunner reports the failure it actually had', () => {
  /*
   * The honest-message rule. Before the fix EVERY read failure claimed the file did not exist and told
   * the model to re-create it with `type="file"` — which, for a path bug, is an instruction to
   * overwrite a file that is present and correct.
   */
  it('says "does not exist" only when the file is genuinely missing', async () => {
    const { runner, alerts } = createRunner({});

    const action = await run(runner, { type: 'edit', filePath: 'nope.md', content: EDIT_BODY });

    expect(action.status).toBe('failed');
    expect(action.error).toContain('does not exist');
    expect(alerts[0].description).toContain('does not exist');
  });

  /*
   * The case that actually happened. A path/permission/transport failure is NOT absence, and saying it
   * is sends both the user and the model after the wrong thing.
   */
  it('reports a non-ENOENT read failure verbatim instead of calling it a missing file', async () => {
    const { runner, alerts } = createRunner({ 'SPEC.md': 'x' }, () => {
      throw new SandboxPathError('../../SPEC.md');
    });

    const action = await run(runner, { type: 'edit', filePath: 'SPEC.md', content: EDIT_BODY });

    expect(action.status).toBe('failed');
    expect(action.error).not.toContain('does not exist');
    expect(action.error).toContain('Refusing a sandbox path');
    expect(alerts[0].description).not.toContain('does not exist');
  });

  /*
   * The alert description is derived from the error, never fixed. A hardcoded "a search/replace block
   * did not match" is what sent a live path failure to be investigated as a model-accuracy problem.
   */
  it('derives the alert description from the error rather than a fixed sentence', async () => {
    const { runner, alerts } = createRunner({ 'SPEC.md': 'nothing matching here\n' });

    await run(runner, { type: 'edit', filePath: 'SPEC.md', content: EDIT_BODY });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].description).toContain('did not match');
    expect(alerts[0].description).toContain('Nothing was changed.');

    // …and a DIFFERENT failure must not reuse that sentence.
    const other = createRunner({});
    await run(other.runner, { type: 'edit', filePath: 'gone.md', content: EDIT_BODY });
    expect(other.alerts[0].description).not.toContain('did not match');
  });

  /*
   * A write that throws must fail the action. It used to be swallowed into a log line while the action
   * reported `complete` — which is exactly what hid the path bug on the `type="file"` path.
   */
  it('fails a file action whose write throws instead of reporting success', async () => {
    const { runner } = createRunner({});

    const action = await run(runner, {
      type: 'file',

      // A traversal the fake FS refuses, standing in for any provider-side write failure.
      filePath: '../escape.txt',
      content: 'x',
    });

    expect(action.status).toBe('failed');
  });
});
