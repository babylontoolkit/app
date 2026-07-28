/**
 * A sandbox belongs to a PROJECT, and there is no per-user registry to fall back to
 * (`spec/sandbox-codesandbox.md` §11 M1).
 *
 * The stopgap this replaced stored one VM per USER at `sandboxes/{userId}.json`. It had no project
 * identity to check against, so opening project B warm-booted project A's filesystem: the workbench
 * mounted A's files, the agent edited them believing they were B's, and a Commit pushed A's code into
 * B's repository. Nothing threw at any point — the sandbox booted perfectly, which is the whole
 * problem.
 *
 * That failure cannot come back through the routes any more (they read `sandboxId` off the row behind
 * `requireOwnedProject`), but it can come back through the DOOR: someone re-adds a small helper that
 * keys a sandbox by user id "just for the boot path", and the identity check has nowhere to happen
 * again. So this is a default-deny source scan for the module and its four exports, in the shape of
 * `no-server-storage.spec.ts` — the deleted system is pinned as deleted, not merely unused.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The API the per-user registry exposed. Any one of these reappearing is the model coming back. */
const BANNED = /\b(sandboxRecordKey|getSandboxRecord|putSandboxRecord|deleteSandboxRecord)\b/;

/**
 * A storage key derived from a USER id rather than a project id — the mistake underneath the names
 * above, expressed structurally so a rename does not evade the scan.
 */
const USER_KEYED_SANDBOX = /sandboxes\/[^A-Za-z0-9]{0,6}user/i;

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

async function sourceFiles(): Promise<string[]> {
  const root = path.resolve(process.cwd(), 'app');
  const found: string[] = [];

  for (const entry of await fs.readdir(root, { recursive: true })) {
    const full = path.resolve(root, entry as string);

    if (!/\.(ts|tsx)$/.test(full) || /\.spec\./.test(full)) {
      continue;
    }

    found.push(full);
  }

  return found;
}

describe('the per-user sandbox registry is deleted, not dormant', () => {
  /**
   * The module file is the door itself. An uncalled helper that hands a user their "current sandbox"
   * re-opens the cross-project adoption by being imported — no review, no call site to notice.
   */
  it('has no registry module', async () => {
    const exists = await fs
      .access(path.resolve(process.cwd(), 'app/lib/.server/sandbox/registry.ts'))
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(false);
  });

  it('exports none of the registry API from the sandbox module', async () => {
    const config = await import('./config');
    const service = await import('./service');
    const lifecycle = await import('./lifecycle');

    for (const mod of [config, service, lifecycle]) {
      expect(mod).not.toHaveProperty('sandboxRecordKey');
      expect(mod).not.toHaveProperty('getSandboxRecord');
      expect(mod).not.toHaveProperty('putSandboxRecord');
      expect(mod).not.toHaveProperty('deleteSandboxRecord');
    }
  });

  /**
   * The stronger half. Comments are stripped first: the files explaining why the registry is gone
   * necessarily name it, and a scanner that reads prose flags the documentation of the fix as the bug.
   */
  it('no module under app/ references the registry API or a user-keyed sandbox key', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles()) {
      const code = stripComments(await fs.readFile(file, 'utf8'));

      if (BANNED.test(code) || USER_KEYED_SANDBOX.test(code)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The control. Without it, a scanner broken into always-passing — a bad regex, a `readdir` that
   * silently returns nothing, a comment-stripper that eats the whole file — reports a clean bill of
   * health forever, which is this file's own failure mode wearing this file's costume.
   */
  it('the scanner can actually find what it is looking for', async () => {
    expect(BANNED.test('const key = sandboxRecordKey(user.id);')).toBe(true);
    expect(BANNED.test('await putSandboxRecord(userId, { sandboxId });')).toBe(true);
    expect(BANNED.test('await getSandboxRecord(userId)')).toBe(true);
    expect(BANNED.test('await deleteSandboxRecord(userId)')).toBe(true);

    expect(USER_KEYED_SANDBOX.test('const key = `sandboxes/${userId}.json`;')).toBe(true);
    expect(USER_KEYED_SANDBOX.test("read('sandboxes/' + user.id)")).toBe(true);

    /* And it does not fire on the model that replaced it. */
    expect(BANNED.test('const before = project.sandboxId;')).toBe(false);
    expect(USER_KEYED_SANDBOX.test('`sandboxes/${projectId}.json`')).toBe(false);

    // The file walk really walks: this spec's own directory has source in it.
    expect((await sourceFiles()).length).toBeGreaterThan(100);
  });
});
