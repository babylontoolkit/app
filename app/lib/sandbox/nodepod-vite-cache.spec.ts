/**
 * The dep cache that closes Nodepod's 17.1 s cold first paint (`spec/sandbox-nodepod.md`).
 *
 * The properties worth pinning are the ones whose failure is INVISIBLE: a key that misses after an
 * ordinary re-install (no speed-up, no error, nobody notices), and a restore that writes the
 * sentinel before the chunks it points at (a broken preview rather than a slow one).
 */
import { describe, expect, it } from 'vitest';
import {
  VITE_CACHE_DIR,
  VITE_CACHE_SENTINEL,
  captureViteCache,
  pathExists,
  restoreViteCache,
  totalBytes,
  viteCacheKey,
} from './nodepod-vite-cache';
import type { ViteCacheFiles, ViteCacheFs } from './nodepod-vite-cache';

const WORKDIR = '/home/project';

/** An in-memory pod filesystem, recording the ORDER of writes — that order is a real invariant. */
function fakeFs(seed: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>([WORKDIR]);
  const writes: string[] = [];

  for (const [path, value] of Object.entries(seed)) {
    files.set(path, typeof value === 'string' ? new TextEncoder().encode(value) : value);
  }

  const fs: ViteCacheFs = {
    async readFile(path) {
      const found = files.get(path);

      if (!found) {
        throw new Error(`ENOENT: ${path}`);
      }

      return found;
    },
    async writeFile(path, data) {
      writes.push(path);
      files.set(path, data);
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async readdir(path) {
      const prefix = `${path}/`;
      const names = new Set<string>();

      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix) && key !== path) {
          names.add(key.slice(prefix.length).split('/')[0]);
        }
      }

      return [...names].sort();
    },
    async stat(path) {
      if (files.has(path)) {
        return { isDirectory: () => false };
      }

      if (dirs.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`))) {
        return { isDirectory: () => true };
      }

      throw new Error(`ENOENT: ${path}`);
    },
  };

  return { fs, files, writes };
}

describe('viteCacheKey', () => {
  const pkg = (deps: object, dev: object = {}) =>
    JSON.stringify({ name: 'game', dependencies: deps, devDependencies: dev });

  it('is stable for the same dependency set', () => {
    expect(viteCacheKey(pkg({ a: '1.0.0' }))).toBe(viteCacheKey(pkg({ a: '1.0.0' })));
  });

  /*
   * 🔴 `npm install` rewrites `package.json` and its key order is not stable. Hashing the raw text
   * would miss the cache after any unrelated re-install — a silent loss of the whole speed-up, with
   * nothing to observe but a slow page.
   */
  it('ignores key order and unrelated fields', () => {
    const one = JSON.stringify({ name: 'game', version: '1.0.0', dependencies: { a: '1', b: '2' } });
    const two = JSON.stringify({ dependencies: { b: '2', a: '1' }, name: 'game', version: '9.9.9' });

    expect(viteCacheKey(one)).toBe(viteCacheKey(two));
  });

  it('changes when a dependency or its range changes', () => {
    expect(viteCacheKey(pkg({ a: '1.0.0' }))).not.toBe(viteCacheKey(pkg({ a: '2.0.0' })));
    expect(viteCacheKey(pkg({ a: '1.0.0' }))).not.toBe(viteCacheKey(pkg({ a: '1.0.0', b: '1.0.0' })));
  });

  it('separates dev dependencies from runtime ones', () => {
    expect(viteCacheKey(pkg({ a: '1' }, { b: '2' }))).not.toBe(viteCacheKey(pkg({ a: '1', b: '2' })));
  });

  /* A format bump must invalidate every stored entry without needing a migration. */
  it('changes with the format version', () => {
    expect(viteCacheKey(pkg({ a: '1' }), 1)).not.toBe(viteCacheKey(pkg({ a: '1' }), 2));
  });

  /* No key means the cache is disabled for this project — never one shared wrong key. */
  it('returns undefined for unusable input', () => {
    expect(viteCacheKey('not json')).toBeUndefined();
    expect(viteCacheKey('{}')).toBeUndefined();
    expect(viteCacheKey('null')).toBeUndefined();
  });
});

describe('captureViteCache', () => {
  /*
   * 🔴 The dev server is ready LONG before the first request triggers optimization, so "a server is
   * up" is not the signal. Capturing then stores a half-written directory, and a partial cache
   * restored later is worse than none: Vite trusts the metadata and serves modules that are absent.
   */
  it('captures nothing until the sentinel Vite writes last exists', async () => {
    const { fs } = fakeFs({ [`${WORKDIR}/${VITE_CACHE_DIR}/deps/chunk.js`]: 'half written' });

    expect(await captureViteCache(fs, WORKDIR)).toBeUndefined();
  });

  it('captures every file under the cache directory once the sentinel is there', async () => {
    const { fs } = fakeFs({
      [`${WORKDIR}/${VITE_CACHE_SENTINEL}`]: '{"hash":"abc"}',
      [`${WORKDIR}/${VITE_CACHE_DIR}/deps/babylon.js`]: 'x'.repeat(10),
      [`${WORKDIR}/${VITE_CACHE_DIR}/deps/nested/more.js`]: 'y',
      [`${WORKDIR}/src/main.ts`]: 'not part of the cache',
    });

    const captured = (await captureViteCache(fs, WORKDIR))!;

    expect(Object.keys(captured).sort()).toEqual([
      VITE_CACHE_SENTINEL,
      `${VITE_CACHE_DIR}/deps/babylon.js`,
      `${VITE_CACHE_DIR}/deps/nested/more.js`,
    ]);
    expect(totalBytes(captured)).toBe(10 + 1 + '{"hash":"abc"}'.length);
  });
});

describe('restoreViteCache', () => {
  const captured = (): ViteCacheFiles => ({
    [`${VITE_CACHE_DIR}/deps/a.js`]: new TextEncoder().encode('alpha'),
    [`${VITE_CACHE_DIR}/deps/b/c.js`]: new TextEncoder().encode('beta'),
    [VITE_CACHE_SENTINEL]: new TextEncoder().encode('{"hash":"abc"}'),
  });

  it('writes every file back byte-identically', async () => {
    const { fs, files } = fakeFs();

    expect(await restoreViteCache(fs, WORKDIR, captured())).toBe(3);
    expect(new TextDecoder().decode(files.get(`${WORKDIR}/${VITE_CACHE_DIR}/deps/b/c.js`))).toBe('beta');
  });

  /*
   * 🔴 A restore interrupted halfway must leave a directory Vite REBUILDS, never one it trusts.
   * Sentinel-last means the worst case is slow; sentinel-first means a preview that 404s its own
   * modules with nothing explaining why.
   */
  it('writes the sentinel last', async () => {
    const { fs, writes } = fakeFs();

    await restoreViteCache(fs, WORKDIR, captured());

    expect(writes.at(-1)).toBe(`${WORKDIR}/${VITE_CACHE_SENTINEL}`);
    expect(writes).toHaveLength(3);
  });

  it('round-trips a capture', async () => {
    const source = fakeFs({
      [`${WORKDIR}/${VITE_CACHE_SENTINEL}`]: '{"hash":"abc"}',
      [`${WORKDIR}/${VITE_CACHE_DIR}/deps/babylon.js`]: new Uint8Array([0, 255, 27, 7]),
    });

    const target = fakeFs();
    await restoreViteCache(target.fs, WORKDIR, (await captureViteCache(source.fs, WORKDIR))!);

    expect([...target.files.get(`${WORKDIR}/${VITE_CACHE_DIR}/deps/babylon.js`)!]).toEqual([0, 255, 27, 7]);
    expect(await captureViteCache(target.fs, WORKDIR)).toBeDefined();
  });
});

describe('pathExists', () => {
  it('answers from a failed stat rather than treating it as an error', async () => {
    const { fs } = fakeFs({ [`${WORKDIR}/package.json`]: '{}' });

    expect(await pathExists(fs, `${WORKDIR}/package.json`)).toBe(true);
    expect(await pathExists(fs, `${WORKDIR}/nope`)).toBe(false);
  });
});
