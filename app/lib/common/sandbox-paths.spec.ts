/**
 * The workdir is a provider property, not a product constant (SPEC §8).
 *
 * This rule replaced ~10 hardcoded `'/home/project/'` string literals. They all agreed while there
 * was one provider, and every one of them became a SILENT NO-OP under a provider with a different
 * root — the path stayed absolute and failed later, somewhere that does not mention paths. MEASURED:
 * the first live CodeSandbox project creation died with
 * `path should be a \`path.relative()\`d string, but got "/project/workspace/CLAUDE.md"`.
 */
import { describe, expect, it } from 'vitest';
import { isSandboxAbsolutePath, SANDBOX_ROOTS, toProjectRelativePath } from './sandbox-paths';

describe('toProjectRelativePath', () => {
  it('strips every known provider root', () => {
    expect(toProjectRelativePath('/home/project/src/main.ts')).toBe('src/main.ts');
    expect(toProjectRelativePath('/project/workspace/src/main.ts')).toBe('src/main.ts');
  });

  it('handles the file that actually broke — a root-level CLAUDE.md', () => {
    expect(toProjectRelativePath('/project/workspace/CLAUDE.md')).toBe('CLAUDE.md');
  });

  it('maps the workdir ROOT itself to the empty string, not to a plausible-looking file', () => {
    /*
     * The `(\/|$)` case. Requiring a trailing slash turns `/home/project` into `home/project` — a
     * value that reads as an ordinary file two directories deep. `planRestore` treats "not empty and
     * not in the incoming map" as DELETE IT, so that bug once pointed `deleteFile` at the workdir.
     */
    for (const root of SANDBOX_ROOTS) {
      expect(toProjectRelativePath(root)).toBe('');
      expect(toProjectRelativePath(`${root}/`)).toBe('');
    }
  });

  it('is idempotent, so it is safe on a value of unknown provenance', () => {
    /*
     * Store keys, repo trees and working copies do not agree about which form they carry, and the
     * call sites cannot always tell. Running it twice must not eat a directory named like a root.
     */
    for (const input of ['/home/project/a/b.ts', 'a/b.ts', '/project/workspace/x.ts']) {
      const once = toProjectRelativePath(input);
      expect(toProjectRelativePath(once)).toBe(once);
    }
  });

  it('leaves an already-relative path alone', () => {
    expect(toProjectRelativePath('src/main.ts')).toBe('src/main.ts');
  });

  it('strips stray leading slashes from a path with no recognised root', () => {
    expect(toProjectRelativePath('/src/main.ts')).toBe('src/main.ts');
  });

  it('does not strip a root that is only a PREFIX of a longer directory name', () => {
    // `/home/projectile` is not `/home/project` — a substring match would corrupt it.
    expect(toProjectRelativePath('/home/projectile/x.ts')).toBe('home/projectile/x.ts');
  });

  it('keeps a path that merely CONTAINS a root deeper in the tree', () => {
    expect(toProjectRelativePath('/home/project/home/project/x.ts')).toBe('home/project/x.ts');
  });
});

describe('isSandboxAbsolutePath', () => {
  it('recognises every root', () => {
    for (const root of SANDBOX_ROOTS) {
      expect(isSandboxAbsolutePath(`${root}/src/a.ts`)).toBe(true);
      expect(isSandboxAbsolutePath(root)).toBe(true);
    }
  });

  it('rejects relative paths and near-misses', () => {
    expect(isSandboxAbsolutePath('src/a.ts')).toBe(false);
    expect(isSandboxAbsolutePath('/home/projectile/a.ts')).toBe(false);
    expect(isSandboxAbsolutePath('/somewhere/else/a.ts')).toBe(false);
  });
});

describe('the root list is the single place a provider is registered', () => {
  it('covers both shipped providers', () => {
    // A missing root does not throw at the boundary — paths silently stay absolute and fail later.
    expect(SANDBOX_ROOTS).toContain('/home/project');
    expect(SANDBOX_ROOTS).toContain('/project/workspace');
  });
});
