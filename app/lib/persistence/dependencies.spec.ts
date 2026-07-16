/**
 * When a mounted project needs `npm install` (SPEC §4.5.4b).
 *
 * Both wrong answers are bad in different ways, which is why this is a pure function rather than an
 * `if` inside the mount path:
 *
 *   - too eager → 30+ seconds of install on every reload of a project that was already fine;
 *   - too shy → the repo mounts a complete, correct, entirely non-running game, and it looks like the
 *     product is broken rather than like a missing install.
 */
import { describe, expect, it } from 'vitest';
import { decideDependencyInstall, findLockfile, hasManifest } from './dependencies';

const LOCK = '{"lockfileVersion":3,"packages":{}}';

describe('decideDependencyInstall', () => {
  /** The repo-mount case: files arrived from GitHub, `node_modules` was never in the repo. */
  it('installs when there is no node_modules', () => {
    expect(decideDependencyInstall({ hasNodeModules: false, hasManifest: true, lockfile: LOCK })).toEqual({
      install: true,
      reason: 'no-node-modules',
    });
  });

  /**
   * Checked before the lockfile comparison: a project whose lockfile happens to match a previous
   * install still cannot run without the directory.
   */
  it('installs when node_modules is missing even if the lockfile is unchanged', () => {
    expect(
      decideDependencyInstall({
        hasNodeModules: false,
        hasManifest: true,
        lockfile: LOCK,
        installedLockfile: LOCK,
      }),
    ).toMatchObject({ install: true });
  });

  it('installs when the lockfile changed — a pull that added a dependency', () => {
    expect(
      decideDependencyInstall({
        hasNodeModules: true,
        hasManifest: true,
        lockfile: '{"lockfileVersion":3,"packages":{"three":{}}}',
        installedLockfile: LOCK,
      }),
    ).toEqual({ install: true, reason: 'lockfile-changed' });
  });

  it('does NOT install when nothing changed — no 30-second tax on every reload', () => {
    expect(
      decideDependencyInstall({ hasNodeModules: true, hasManifest: true, lockfile: LOCK, installedLockfile: LOCK }),
    ).toEqual({ install: false, reason: 'up-to-date' });
  });

  it('does nothing for a project with no package.json', () => {
    expect(decideDependencyInstall({ hasNodeModules: false, hasManifest: false })).toEqual({
      install: false,
      reason: 'no-manifest',
    });
  });

  /** A repo with no lockfile at all is legitimate; it just means the comparison has nothing to say. */
  it('treats a project that has never had a lockfile as up to date once installed', () => {
    expect(decideDependencyInstall({ hasNodeModules: true, hasManifest: true })).toEqual({
      install: false,
      reason: 'up-to-date',
    });
  });

  it('installs when a lockfile appears where there was none', () => {
    expect(decideDependencyInstall({ hasNodeModules: true, hasManifest: true, lockfile: LOCK })).toEqual({
      install: true,
      reason: 'lockfile-changed',
    });
  });
});

describe('findLockfile', () => {
  it.each([['package-lock.json'], ['pnpm-lock.yaml'], ['yarn.lock']])('recognises %s', (name) => {
    expect(findLockfile([`/home/project/${name}`, '/home/project/src/game.ts'])).toBe(`/home/project/${name}`);
  });

  it('is undefined when there is none', () => {
    expect(findLockfile(['/home/project/package.json'])).toBeUndefined();
  });

  it('is not fooled by a lookalike', () => {
    expect(findLockfile(['/home/project/my-package-lock.json.bak'])).toBeUndefined();
  });
});

describe('hasManifest', () => {
  it('finds the root package.json', () => {
    expect(hasManifest(['/home/project/package.json', '/home/project/src/game.ts'])).toBe(true);
  });

  /**
   * A `package.json` belonging to a dependency is not this project's manifest. Matching one would make
   * every project look installable whether or not it really is.
   */
  it('ignores a package.json nested inside node_modules', () => {
    expect(hasManifest(['/home/project/src/game.ts', '/home/project/node_modules/three/package.json'])).toBe(false);
  });

  it('is false for a project with no manifest', () => {
    expect(hasManifest(['/home/project/README.md'])).toBe(false);
  });

  it('handles an empty project without throwing', () => {
    expect(hasManifest([])).toBe(false);
  });
});
