/**
 * `walkSandboxTree` — the re-scan behind `FilesStore.refreshFiles`.
 *
 * The property that matters is CONCURRENCY: on a server sandbox provider every `fs` call is a
 * network round trip, and the serial walk this replaced measured ~17 seconds for a 75-file project
 * — the whole of the blank screen a project open showed. A regression back to serial reads throws
 * nothing and fails no behavioural test; only wall clock suffers. So the pool is asserted directly:
 * reads must overlap (> 1 in flight) and must stay bounded (never more than the limit in flight).
 */
import { describe, expect, it } from 'vitest';
import { walkSandboxTree, type WalkFs } from './refresh-walk';

interface FakeTree {
  [dir: string]: Array<{ name: string; dir?: boolean }>;
}

function fakeFs(
  tree: FakeTree,
  opts: { readDelayMs?: number; failPaths?: Set<string>; onRead?: (relPath: string) => void } = {},
) {
  let inFlight = 0;
  let maxInFlight = 0;
  const readdirCalls: string[] = [];

  const fs: WalkFs = {
    async readdir(dirPath: string) {
      readdirCalls.push(dirPath);

      const entries = tree[dirPath] ?? [];

      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.dir === true,
        isFile: () => entry.dir !== true,
      }));
    },
    async readFile(relPath: string) {
      opts.onRead?.(relPath);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, opts.readDelayMs ?? 5));
      inFlight--;

      if (opts.failPaths?.has(relPath)) {
        throw new Error(`cannot read ${relPath}`);
      }

      return new TextEncoder().encode(`bytes:${relPath}`);
    },
  };

  return { fs, stats: { readdirCalls, maxInFlight: () => maxInFlight } };
}

const noExclusions = { exclude: () => false };

describe('walkSandboxTree', () => {
  it('reads files concurrently, bounded by the concurrency limit', async () => {
    const { fs, stats } = fakeFs({
      '.': Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.ts` })),
    });

    const result = await walkSandboxTree(fs, { ...noExclusions, concurrency: 4 });

    expect(result.files).toHaveLength(12);

    // Parallel — the serial walk this replaced would report 1.
    expect(stats.maxInFlight()).toBeGreaterThan(1);

    // Bounded — a pool that ignores its limit floods the provider socket.
    expect(stats.maxInFlight()).toBeLessThanOrEqual(4);
  });

  it('collects folders and files from nested directories', async () => {
    const { fs } = fakeFs({
      '.': [{ name: 'src', dir: true }, { name: 'index.html' }],
      src: [{ name: 'pages', dir: true }, { name: 'main.ts' }],
      'src/pages': [{ name: 'Home.tsx' }],
    });

    const result = await walkSandboxTree(fs, { ...noExclusions, concurrency: 2 });

    expect(result.folders.sort()).toEqual(['src', 'src/pages']);
    expect(result.files.map((f) => f.relPath).sort()).toEqual(['index.html', 'src/main.ts', 'src/pages/Home.tsx']);
    expect(new TextDecoder().decode(result.files.find((f) => f.relPath === 'src/main.ts')?.buffer)).toBe(
      'bytes:src/main.ts',
    );
  });

  it('never lists or enters excluded names (node_modules stays a mystery)', async () => {
    const { fs, stats } = fakeFs({
      '.': [{ name: 'node_modules', dir: true }, { name: 'ok.ts' }],
      node_modules: [{ name: 'left-pad', dir: true }],
    });

    const result = await walkSandboxTree(fs, { exclude: (name) => name === 'node_modules' });

    expect(result.folders).toEqual([]);
    expect(result.files.map((f) => f.relPath)).toEqual(['ok.ts']);

    // The excluded directory is pruned BEFORE the recursion, so its readdir never happens.
    expect(stats.readdirCalls).toEqual(['.']);
  });

  it('prunes a skipped directory including its whole subtree', async () => {
    const { fs, stats } = fakeFs({
      '.': [{ name: 'deleted-dir', dir: true }, { name: 'kept.ts' }],
      'deleted-dir': [{ name: 'inner.ts' }],
    });

    const result = await walkSandboxTree(fs, {
      ...noExclusions,
      skip: (relPath) => relPath === 'deleted-dir',
    });

    expect(result.folders).toEqual([]);
    expect(result.files.map((f) => f.relPath)).toEqual(['kept.ts']);
    expect(stats.readdirCalls).not.toContain('deleted-dir');
  });

  it('a failed read becomes an error entry without aborting the other reads', async () => {
    const { fs } = fakeFs(
      { '.': [{ name: 'good.ts' }, { name: 'bad.ts' }, { name: 'also-good.ts' }] },
      { failPaths: new Set(['bad.ts']) },
    );

    const result = await walkSandboxTree(fs, { ...noExclusions, concurrency: 2 });

    const bad = result.files.find((f) => f.relPath === 'bad.ts');
    expect(bad?.buffer).toBeUndefined();
    expect(String(bad?.error)).toContain('cannot read bad.ts');
    expect(result.files.filter((f) => f.buffer)).toHaveLength(2);
  });

  it('reports progress after each read, ending at (total, total)', async () => {
    const { fs } = fakeFs({ '.': [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    const seen: Array<[number, number]> = [];

    await walkSandboxTree(fs, {
      ...noExclusions,
      concurrency: 2,
      onFileRead: (done, total) => seen.push([done, total]),
    });

    expect(seen.map(([done]) => done)).toEqual([1, 2, 3]);
    expect(seen.every(([, total]) => total === 3)).toBe(true);
  });

  it('an empty tree resolves without spawning workers', async () => {
    const { fs } = fakeFs({ '.': [] });

    const result = await walkSandboxTree(fs, noExclusions);

    expect(result).toEqual({ folders: [], files: [] });
  });
});
