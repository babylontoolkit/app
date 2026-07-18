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
import {
  decideDependencyInstall,
  devScriptFromManifest,
  findLockfile,
  findManifest,
  hasManifest,
  shouldStartDevServer,
} from './dependencies';

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

describe('findManifest', () => {
  it('finds the root package.json', () => {
    expect(findManifest(['/home/project/package.json', '/home/project/src/game.ts'])).toBe(
      '/home/project/package.json',
    );
  });

  /** Same rule as hasManifest: a dependency's manifest is not the project's. */
  it('ignores a package.json nested inside node_modules', () => {
    expect(
      findManifest(['/home/project/src/game.ts', '/home/project/node_modules/three/package.json']),
    ).toBeUndefined();
  });

  it('is undefined for a project with no manifest', () => {
    expect(findManifest(['/home/project/README.md'])).toBeUndefined();
  });
});

describe('devScriptFromManifest', () => {
  /** The Toolkit-starter convention: every generated project has a `dev` script. */
  it('returns "dev" when the manifest declares one', () => {
    expect(devScriptFromManifest('{"scripts":{"dev":"vite","build":"vite build"}}')).toBe('dev');
  });

  /** A mounted repo that used `start` instead of `dev` still auto-starts. */
  it('falls back to "start" when there is no "dev"', () => {
    expect(devScriptFromManifest('{"scripts":{"start":"vite"}}')).toBe('start');
  });

  it('prefers "dev" over "start" when both exist', () => {
    expect(devScriptFromManifest('{"scripts":{"start":"serve","dev":"vite"}}')).toBe('dev');
  });

  it('is undefined when there is no dev/start script — nothing to run', () => {
    expect(devScriptFromManifest('{"scripts":{"build":"vite build"}}')).toBeUndefined();
  });

  it('is undefined when there are no scripts at all', () => {
    expect(devScriptFromManifest('{"name":"game"}')).toBeUndefined();
  });

  /** A malformed manifest must never crash the mount — it degrades to "no dev server". */
  it('does not throw on invalid JSON', () => {
    expect(devScriptFromManifest('{ not json')).toBeUndefined();
  });

  it('is undefined for a missing manifest', () => {
    expect(devScriptFromManifest(undefined)).toBeUndefined();
  });

  /** A non-string script value (a common typo) is ignored, not stringified into a command. */
  it('ignores a non-string script value', () => {
    expect(devScriptFromManifest('{"scripts":{"dev":true}}')).toBeUndefined();
  });
});

describe('shouldStartDevServer', () => {
  /** The cold-mount case: a new device, files just arrived, nothing is running yet. */
  it('starts when there is a script and no server is running', () => {
    expect(shouldStartDevServer({ script: 'dev', runningPreviews: 0 })).toBe(true);
  });

  /**
   * The container is a page-level singleton, so a dev server from a previous project (or from the
   * creation artifact) is still up when the user switches projects. A second `npm run dev` would only
   * fight it for the port — the already-running server serves the newly-mounted files.
   */
  it('does NOT start a second server when one is already running', () => {
    expect(shouldStartDevServer({ script: 'dev', runningPreviews: 1 })).toBe(false);
  });

  it('never starts when there is no dev/start script to run', () => {
    expect(shouldStartDevServer({ script: undefined, runningPreviews: 0 })).toBe(false);
  });

  it('is guarded by the running check even with a script', () => {
    expect(shouldStartDevServer({ script: 'start', runningPreviews: 2 })).toBe(false);
  });
});
