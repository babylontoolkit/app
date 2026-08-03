/**
 * The stable/mutable file-context split (SPEC §4.2.8, 2026-07-30 restructure).
 *
 * Every wrong answer here is a silent money bug, in one of two directions:
 *
 *   - a MUTABLE file classified stable puts per-turn churn into the big shared entry, so the entry
 *     that exists to stop the 82%-cache-write pathology rewrites every turn and RESTORES it;
 *   - a STABLE file classified mutable merely rides in the small entry — the cheap direction, which
 *     is why the default is mutable and stability requires being NAMED.
 */
import { describe, expect, it } from 'vitest';
import { isStableContextPath, splitFilesForContext } from './stable-zones';
import type { FileMap } from '~/lib/stores/files';

const file = (content = 'x'): { type: 'file'; content: string; isBinary: false } => ({
  type: 'file',
  content,
  isBinary: false,
});

describe('what is stable — the named starter zones', () => {
  it.each([
    'src/babylon/globals.ts',
    'src/babylon/classes/RacerMode.ts',
    'src/babylon/system/platform.tsx',
    'src/routing/router.tsx',
    'public/scripts/havok.js',
    'src/app.tsx',
    'src/main.tsx',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'public/babylon.png',
    'public/spinner.png',
  ])('%s is stable', (path) => {
    expect(isStableContextPath(path)).toBe(true);
  });

  it('accepts workdir-absolute paths — the map keys carry the sandbox root', () => {
    expect(isStableContextPath('/project/workspace/src/babylon/globals.ts')).toBe(true);
    expect(isStableContextPath('/home/project/src/babylon/globals.ts')).toBe(true);
    expect(isStableContextPath('/project/workspace/src/scripts/RaceMode.ts')).toBe(false);
  });
});

describe('what is mutable — everything else, BY DEFAULT', () => {
  it.each([
    // The game's own code — the whole point of the split is that ONLY this rewrites per turn.
    'src/scripts/RaceMode.ts',
    'src/pages/Home.tsx',
    'src/chrome/SplashScreen.tsx',
    'src/components/Hud.tsx',

    // Generated media lands mid-turn (§4.16) — stable-listing this would rewrite the big entry per render.
    'public/assets/generated/hero-ms744j.jpg',

    // Changes on every `npm install` the model runs.
    'package.json',
    'package-lock.json',

    // The user's own documents.
    'SPEC.md',
    'README.md',
    '_specs/racing_spec.md',

    // Branding redesigns replace these (§4.4c) — deliberately NOT stable.
    'public/favicon.ico',
    'public/icons.svg',

    // CLAUDE.md is lifted out before the split, but if it ever reaches it, it must be mutable.
    'CLAUDE.md',
  ])('%s is mutable', (path) => {
    expect(isStableContextPath(path)).toBe(false);
  });

  /**
   * The CONTROL for the default direction. A path nobody anticipated — a new root file, a new
   * directory — must land MUTABLE: mis-classifying churn into the stable entry silently restores
   * the every-turn rewrite this module exists to remove.
   */
  it('defaults an unknown path to mutable', () => {
    expect(isStableContextPath('totally/new/thing.ts')).toBe(false);
    expect(isStableContextPath('src/newzone/file.ts')).toBe(false);
    expect(isStableContextPath('babylon.config.ts')).toBe(false);
  });

  it('does not confuse a PREFIX for a zone', () => {
    // `src/babylonics/` starts with the string but is not inside `src/babylon/`.
    expect(isStableContextPath('src/babylonics/x.ts')).toBe(false);

    // The zone's own folder entry rides with the zone (createFilesContext skips folders anyway).
    expect(isStableContextPath('src/babylon')).toBe(true);
  });
});

describe('the split', () => {
  it('puts every entry in exactly one half, folders included', () => {
    const files: FileMap = {
      '/project/workspace/src/babylon': { type: 'folder' },
      '/project/workspace/src/babylon/globals.ts': file('framework'),
      '/project/workspace/src/scripts': { type: 'folder' },
      '/project/workspace/src/scripts/RaceMode.ts': file('game'),
      '/project/workspace/package.json': file('{}'),
    };

    const { stable, mutable } = splitFilesForContext(files);

    expect(Object.keys(stable).sort()).toEqual([
      '/project/workspace/src/babylon',
      '/project/workspace/src/babylon/globals.ts',
    ]);
    expect(Object.keys(mutable).sort()).toEqual([
      '/project/workspace/package.json',
      '/project/workspace/src/scripts',
      '/project/workspace/src/scripts/RaceMode.ts',
    ]);

    // Nothing lost, nothing duplicated.
    expect(Object.keys(stable).length + Object.keys(mutable).length).toBe(Object.keys(files).length);
  });

  it('an imported project with no framework zones yields an empty stable half', () => {
    const { stable, mutable } = splitFilesForContext({
      '/project/workspace/src/whatever.ts': file(),
    });

    expect(Object.keys(stable)).toEqual([]);
    expect(Object.keys(mutable)).toHaveLength(1);
  });
});

/**
 * 🔴 THE CROSS-PROJECT PROPERTY — the reason the stable block sits AHEAD of the per-conversation
 * blocks. Two different projects on the same template pin must produce BYTE-IDENTICAL stable
 * blocks, whatever order their file watchers happened to discover files in, or the shared cache
 * entry silently never matches and the whole restructure buys nothing.
 */
describe('cross-project byte identity of the stable block', () => {
  it('same starter files, different projects, different key order → identical stable context', async () => {
    const { createFilesContext } = await import('~/lib/.server/llm/utils');

    const starter: Array<[string, ReturnType<typeof file>]> = [
      ['/project/workspace/src/babylon/globals.ts', file('export default GM;')],
      ['/project/workspace/src/babylon/classes/DemoMode.ts', file('class DemoMode {}')],
      ['/project/workspace/src/routing/router.tsx', file('routes')],
      ['/project/workspace/vite.config.ts', file('config')],
    ];

    // Project A discovered files in one order, project B in another, and B has different GAME code.
    const projectA: FileMap = Object.fromEntries([
      ...starter,
      ['/project/workspace/src/scripts/KartMode.ts', file('kart')],
    ]);
    const projectB: FileMap = Object.fromEntries([
      ['/project/workspace/src/scripts/ZombieMode.ts', file('zombies')],
      ...[...starter].reverse(),
    ]);

    const a = splitFilesForContext(projectA);
    const b = splitFilesForContext(projectB);

    expect(createFilesContext(a.stable, true)).toBe(createFilesContext(b.stable, true));
    expect(createFilesContext(a.mutable, true)).not.toBe(createFilesContext(b.mutable, true));
  });
});
