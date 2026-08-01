/**
 * Carrying Vite's optimized dependencies across pods (`spec/sandbox-nodepod.md`).
 *
 * 🔴 **This is the 17.1 s cold first paint.** Two numbers were measured on the real AppTemplate and
 * both are real: **0.5 s** to first paint against an already-warm Vite, and **17.1 s** on the first
 * load of a fresh pod. The gap is almost entirely Vite's dependency optimization — Babylon plus the
 * Toolkit is a very large module graph — and Nodepod's own snapshot cache does not close it, because
 * it snapshots `node_modules` at the end of `npm install` and `node_modules/.vite/deps` does not
 * exist yet at that moment. On a warm boot the install is a no-op ("added 0 packages"), so it never
 * re-snapshots either. The optimized deps were therefore recomputed from scratch on every single
 * page load, forever.
 *
 * So we persist that one directory ourselves, keyed by the project's dependency set, and put it back
 * before the dev server starts.
 *
 * **Restoring a stale cache is safe by construction, and that is the whole reason this is allowed to
 * be approximate.** Vite writes `deps/_metadata.json` with a hash of its own inputs (lockfile, config,
 * the resolved dependency list) and re-optimizes whenever that hash does not match what it finds. Our
 * key is therefore an OPTIMIZATION, not a correctness boundary: get it wrong and Vite does exactly
 * what it does today. That is why the key can be a cheap synchronous hash of `package.json` rather
 * than a faithful reproduction of Vite's own — reproducing theirs would be a second implementation
 * of a rule we do not own, drifting silently the first time they change it.
 */

/** Where Vite keeps its caches, relative to the project root. */
export const VITE_CACHE_DIR = 'node_modules/.vite';

/**
 * The ONE directory that is captured and restored: Vite's optimized client deps.
 *
 * 🔴 Not `VITE_CACHE_DIR`, and the difference was a live-measured defect (2026-07-31). Vite optimizes
 * into `node_modules/.vite/deps_temp_<hash>/` and then renames that directory onto `deps/` — but the
 * temp directory was still present in the pod's VFS afterwards, so walking all of `.vite` captured a
 * byte-identical SECOND copy of every optimized module. Measured on the real starter: **38 files /
 * 7.40 MB stored where 19 files / 3.70 MB were needed** — double the IndexedDB write, double the read,
 * and a junk directory materialized into every restored pod, forever.
 *
 * The rule that prevents the whole family of this bug: **capture exactly what the sentinel attests
 * to.** {@link VITE_CACHE_SENTINEL} is written at the end of optimizing `deps/` and says nothing about
 * any sibling, so a sibling swept in alongside it is bytes with no completeness signal — which is the
 * precise hazard the sentinel exists to prevent, arriving through the back door. A future `deps_ssr`
 * would need its own sentinel, not a wider walk.
 */
export const VITE_CACHE_DEPS_DIR = `${VITE_CACHE_DIR}/deps`;

/**
 * The file Vite writes LAST, once optimization has actually finished.
 *
 * Its presence is the signal to capture. Capturing on "the dev server is up" instead would snapshot a
 * half-written directory — the server is ready long before the first request triggers optimization —
 * and a partial dep cache restored later is worse than none: Vite would find a metadata file, trust
 * it, and serve modules that are not there.
 */
export const VITE_CACHE_SENTINEL = `${VITE_CACHE_DEPS_DIR}/_metadata.json`;

/**
 * Skip persisting a dep cache larger than this.
 *
 * A ceiling exists because this writes to the user's browser storage on their machine, and an
 * unbounded write there is the same category of defect as an unbounded upload to our bucket
 * (`spec/spend-holes.md`) — it just bills a different person. A project whose optimized deps exceed
 * this simply keeps today's behaviour.
 */
export const VITE_CACHE_MAX_BYTES = 256 * 1024 * 1024;

const DB_NAME = 'btk-nodepod-vite';
const DB_VERSION = 1;
const STORE = 'deps';

/** A captured dep cache: project-relative path → bytes. */
export type ViteCacheFiles = Record<string, Uint8Array>;

/**
 * A cache key for one project's dependency set.
 *
 * Only `dependencies` and `devDependencies` are read, and their keys are SORTED — `package.json` is
 * rewritten by every `npm install` and its key order is not stable, so hashing the raw text would
 * miss the cache after an unrelated re-install. Anything unparseable returns `undefined`, which
 * disables the cache for that project rather than filing everything under one wrong key.
 *
 * `FORMAT` is part of the key so that changing what we capture invalidates every stored entry
 * without needing a migration — an old entry under a new format is simply never looked up.
 *
 * Format history: **1** captured all of `node_modules/.vite`, which swept in a byte-identical copy of
 * Vite's transient `deps_temp_<hash>/` (see {@link VITE_CACHE_DEPS_DIR}); **2** captures `deps/` only.
 * A v1 entry is twice the size it should be and restores a junk directory, so it is retired by never
 * being looked up rather than migrated.
 */
export function viteCacheKey(packageJsonText: string, format = 2): string | undefined {
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  /*
   * The two lists are TAGGED, not merged. Moving a package between them changes what Vite pre-bundles
   * (a devDependency is not part of the optimized client graph the same way), so collapsing them
   * would hand two genuinely different projects the same key.
   */
  const entries = [
    ...Object.entries(parsed.dependencies ?? {}).map(([name, range]) => `dep:${name}@${String(range)}`),
    ...Object.entries(parsed.devDependencies ?? {}).map(([name, range]) => `dev:${name}@${String(range)}`),
  ].sort();

  if (entries.length === 0) {
    return undefined;
  }

  return `v${format}-${fnv1a(entries.join('\n'))}`;
}

/**
 * FNV-1a, 32-bit, as hex.
 *
 * Deliberately not `crypto.subtle.digest`: that is async, and this is consulted on the path that
 * decides whether to start a dev server. A collision here costs one dependency optimization, which
 * is exactly what happens today — see the module comment on why the key is an optimization.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

/** Total bytes in a captured cache — the value the ceiling is checked against. */
export function totalBytes(files: ViteCacheFiles): number {
  let sum = 0;

  for (const bytes of Object.values(files)) {
    sum += bytes.byteLength;
  }

  return sum;
}

export interface ViteCacheStore {
  get(key: string): Promise<ViteCacheFiles | undefined>;
  put(key: string, files: ViteCacheFiles): Promise<void>;
}

/**
 * Open the browser-side store, or `undefined` where there is none.
 *
 * Every failure path returns `undefined` rather than throwing. This is a cache: a private window
 * with IndexedDB disabled, a quota refusal, a corrupted database — all of them mean "no speed-up",
 * and none of them may stop a project from starting.
 */
export function openViteCacheStore(): Promise<ViteCacheStore | undefined> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;

    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(undefined);
      return;
    }

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };

    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);

    request.onsuccess = () => {
      const db = request.result;

      resolve({
        get: (key) =>
          new Promise((done) => {
            try {
              const read = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
              read.onsuccess = () => done((read.result as ViteCacheFiles | undefined) ?? undefined);
              read.onerror = () => done(undefined);
            } catch {
              done(undefined);
            }
          }),

        put: (key, files) =>
          new Promise((done) => {
            try {
              const tx = db.transaction(STORE, 'readwrite');
              tx.objectStore(STORE).put(files, key);
              tx.oncomplete = () => done();

              // A quota refusal is the expected failure here, and it is not an error worth raising.
              tx.onerror = () => done();
              tx.onabort = () => done();
            } catch {
              done();
            }
          }),
      });
    };
  });
}

/**
 * The filesystem this module needs — declared here, never imported from the SDK.
 *
 * Same seam rule as `nodepod-provider.ts`: the vendor type stays behind two files, and declaring our
 * own means these functions are testable against a plain in-memory fake.
 */
export interface ViteCacheFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean } | { isDirectory: boolean }>;
}

function isDir(stat: { isDirectory(): boolean } | { isDirectory: boolean }): boolean {
  return typeof stat.isDirectory === 'function' ? stat.isDirectory() : Boolean(stat.isDirectory);
}

/** Does a path exist? A failed `stat` is the answer, not an error. */
export async function pathExists(fs: ViteCacheFs, absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read {@link VITE_CACHE_DEPS_DIR} out of the pod, as project-relative paths.
 *
 * Returns `undefined` when the sentinel is absent — i.e. when optimization has not finished. See
 * {@link VITE_CACHE_SENTINEL} for why a half-written directory must never be captured.
 */
export async function captureViteCache(fs: ViteCacheFs, workdir: string): Promise<ViteCacheFiles | undefined> {
  if (!(await pathExists(fs, `${workdir}/${VITE_CACHE_SENTINEL}`))) {
    return undefined;
  }

  const files: ViteCacheFiles = {};

  const walk = async (rel: string): Promise<void> => {
    let names: string[] = [];

    try {
      names = await fs.readdir(`${workdir}/${rel}`);
    } catch {
      return;
    }

    for (const name of names) {
      const child = `${rel}/${name}`;

      try {
        if (isDir(await fs.stat(`${workdir}/${child}`))) {
          await walk(child);
        } else {
          files[child] = await fs.readFile(`${workdir}/${child}`);
        }
      } catch {
        // A file that vanished mid-walk simply is not part of this capture.
      }
    }
  };

  await walk(VITE_CACHE_DEPS_DIR);

  return Object.keys(files).length > 0 ? files : undefined;
}

/**
 * Write a captured cache back into a pod. Returns how many files landed.
 *
 * 🔴 The sentinel is written LAST, for the same reason it is read first: if the write is interrupted
 * (a reload mid-restore), a directory with no `_metadata.json` makes Vite optimize from scratch —
 * correct, just slow. One with a metadata file and missing chunks makes Vite serve modules that do
 * not exist, which is a broken preview rather than a slow one.
 */
export async function restoreViteCache(fs: ViteCacheFs, workdir: string, files: ViteCacheFiles): Promise<number> {
  const sentinel = files[VITE_CACHE_SENTINEL];
  const paths = Object.keys(files).filter((path) => path !== VITE_CACHE_SENTINEL);
  const made = new Set<string>();
  let written = 0;

  const write = async (rel: string, bytes: Uint8Array) => {
    const abs = `${workdir}/${rel}`;
    const dir = abs.slice(0, abs.lastIndexOf('/'));

    if (!made.has(dir)) {
      made.add(dir);
      await fs.mkdir(dir, { recursive: true });
    }

    await fs.writeFile(abs, bytes);
    written += 1;
  };

  for (const path of paths) {
    await write(path, files[path]);
  }

  if (sentinel) {
    await write(VITE_CACHE_SENTINEL, sentinel);
  }

  return written;
}
