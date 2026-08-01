/**
 * Adapter tests for the Nodepod provider, driven through an in-memory fake client.
 *
 * The fake implements {@link NodepodClient} for real — no `as any` on the client itself — so a
 * signature drift in the adapter is a type error rather than a green test. The two properties worth
 * the most here are the ones that fail SILENTLY in production: binary byte-identity through
 * mount→readFile, and the shell always emitting a completion marker (a shell that goes quiet hangs
 * every later agent action forever, with nothing thrown).
 */
import { describe, expect, it } from 'vitest';
import { MAP_EXCLUDE_GLOBS } from '~/lib/stores/files';
import { scanOscSignals } from '~/utils/shell';
import { NODEPOD_CAPABILITIES, NODEPOD_SHELL_COMMAND, createNodepodProvider } from './nodepod-provider';
import { VITE_CACHE_SENTINEL, viteCacheKey } from './nodepod-vite-cache';
import type { NodepodClient, NodepodProc, NodepodProcessHandle } from './nodepod-provider';
import type { SandboxFileTree, SandboxWatchEvent } from './types';

const WORKDIR = '/home/user/workspace';

interface FakeSpawn {
  output?: string;
  exitCode?: number;
  throws?: boolean;

  /** A process that never exits on its own — a dev server. Only `kill()` ends it. */
  neverExits?: boolean;
}

/**
 * A fake Nodepod, optionally including the process manager the persistent shell uses.
 *
 * `withProcessManager: false` is not a shortcut — it is the DEGRADED path the adapter is required to
 * take when the SDK does not expose one, and both branches must run the same commands.
 */
function createFakeClient(spawns: Record<string, FakeSpawn> = {}, withProcessManager = false) {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>([WORKDIR]);
  const spawnCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const killed: string[] = [];

  /** Every line the PERSISTENT shell worker was asked to execute, with the cwd it ran in. */
  const execCalls: Array<{ shellCommand: string; cwd: string }> = [];
  const workers: Array<{ pid: number; cwd: string; resized: Array<[number, number]>; stdin: string[] }> = [];
  const killHooks = new Map<number, () => void>();
  const killedPids = new Set<number>();
  let watcher: ((event: string, filename: string | null) => void) | undefined;
  const closed = { watch: false, pod: false };

  const client: NodepodClient = {
    fs: {
      async writeFile(path, data) {
        files.set(path, data);
      },
      readFile: (async (path: string, encoding?: 'utf-8' | 'utf8') => {
        if (!files.has(path)) {
          throw new Error(`ENOENT: ${path}`);
        }

        const value = files.get(path)!;

        if (encoding) {
          return typeof value === 'string' ? value : new TextDecoder().decode(value);
        }

        return typeof value === 'string' ? new TextEncoder().encode(value) : value;
      }) as NodepodClient['fs']['readFile'],
      async mkdir(path) {
        dirs.add(path);
      },
      async readdir(path) {
        const prefix = path.endsWith('/') ? path : `${path}/`;
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
      async rm(path) {
        files.delete(path);
        dirs.delete(path);
      },
      watch(_path, _options, cb) {
        watcher = cb;
        return {
          close() {
            closed.watch = true;
            watcher = undefined;
          },
        };
      },
    },

    async spawn(cmd, args = [], opts) {
      spawnCalls.push({ cmd, args, cwd: opts?.cwd });

      const plan = spawns[cmd];

      if (plan?.throws) {
        throw new Error(`command not found: ${cmd}`);
      }

      const handlers: Record<string, Array<(v: unknown) => void>> = {};

      let endRun: (r: { exitCode: number }) => void = () => {};
      const completion = plan?.neverExits
        ? new Promise<{ exitCode: number }>((resolve) => (endRun = resolve))
        : Promise.resolve({ exitCode: plan?.exitCode ?? 0 });

      const proc: NodepodProc = {
        completion,
        write: () => {},
        kill: () => {
          killed.push(cmd);
          endRun({ exitCode: 130 });
        },
        on(event, handler) {
          (handlers[event] ??= []).push(handler as (v: unknown) => void);

          if (event === 'output' && plan?.output) {
            queueMicrotask(() => handler(plan.output as never));
          }

          return proc;
        },
      };

      return proc;
    },

    port: (num) => `http://localhost/__virtual__/pod/${num}`,
    teardown() {
      closed.pod = true;
    },

    processManager: withProcessManager
      ? {
          spawn(config) {
            const pid = workers.length + 1;
            const record = {
              pid,
              cwd: config.cwd ?? WORKDIR,
              resized: [] as Array<[number, number]>,
              stdin: [] as string[],
            };
            workers.push(record);

            const listeners: Record<string, Array<(...v: never[]) => void>> = {};
            const emit = (event: string, ...values: unknown[]) => {
              for (const fn of [...(listeners[event] ?? [])]) {
                (fn as (...v: unknown[]) => void)(...values);
              }
            };

            let running: { plan: FakeSpawn; command: string } | undefined;

            const handle: NodepodProcessHandle = {
              pid,
              get state() {
                return killedPids.has(pid) ? ('exited' as const) : ('running' as const);
              },
              on(event, handler) {
                (listeners[event] ??= []).push(handler);
                return handle;
              },
              removeListener(event, handler) {
                listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== handler);
                return handle;
              },
              exec(message) {
                execCalls.push({ shellCommand: message.shellCommand, cwd: message.cwd });

                const plan = spawns[message.shellCommand];

                /* A `cd` is what the real shell reports back through `cwd-change`. */
                const cd = /^cd\s+(\S+)$/.exec(message.shellCommand);

                if (cd) {
                  record.cwd = cd[1].startsWith('/') ? cd[1] : `${record.cwd}/${cd[1]}`;
                  queueMicrotask(() => {
                    emit('cwd-change', record.cwd);
                    emit('shell-done', 0, '', '');
                  });

                  return;
                }

                if (plan?.neverExits) {
                  running = { plan, command: message.shellCommand };

                  if (plan.output) {
                    queueMicrotask(() => emit('stdout', plan.output));
                  }

                  return;
                }

                queueMicrotask(() => {
                  if (plan?.output) {
                    emit('stdout', plan.output);
                  }

                  emit('shell-done', plan?.exitCode ?? 0, plan?.output ?? '', '');
                });
              },
              sendStdin(data) {
                record.stdin.push(data);
              },
              resize(cols, rows) {
                record.resized.push([cols, rows]);
              },
            };

            killHooks.set(pid, () => {
              killed.push(running?.command ?? 'shell');
              running = undefined;
              emit('shell-done', 130, '', '');
            });

            return handle;
          },

          kill(pid) {
            killHooks.get(pid)?.();
            return true;
          },
        }
      : undefined,
  };

  return {
    client,
    files,
    dirs,
    spawnCalls,
    execCalls,
    workers,
    killed,
    closed,
    fire: (e: string, f: string | null) => watcher?.(e, f),
  };
}

const noServers = () => () => {};

function makeProvider(spawns?: Record<string, FakeSpawn>, withProcessManager = false) {
  const fake = createFakeClient(spawns, withProcessManager);
  return { fake, provider: createNodepodProvider(fake.client, { workdir: WORKDIR, onServerReady: noServers }) };
}

/** Drain a process's output until `predicate` is satisfied, then return everything seen. */
async function readUntil(stream: ReadableStream<string>, predicate: (seen: string) => boolean, limit = 200) {
  const reader = stream.getReader();
  let seen = '';

  for (let i = 0; i < limit; i++) {
    if (predicate(seen)) {
      break;
    }

    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    seen += value ?? '';
  }

  reader.releaseLock();

  return seen;
}

describe('capabilities are pinned exactly', () => {
  it('declares terminal, textSearch and watch, and declines clearPort', () => {
    expect(NODEPOD_CAPABILITIES).toEqual({ terminal: true, textSearch: true, watch: true, clearPort: false });
  });

  /*
   * A declared capability must be BACKED BY A METHOD and a declined one must have none — the flag is
   * the contract `Search.tsx` reads instead of probing, so the two disagreeing means either a panel
   * that says "unavailable" over a working search or one that calls a method that isn't there.
   */
  it('backs what it declares and omits what it declines', () => {
    const { provider } = makeProvider();

    expect(typeof provider.textSearch).toBe('function');
    expect(provider.clearPort).toBeUndefined();
    expect(provider.refreshPreviewUrl).toBeUndefined();
  });

  /*
   * Nodepod's VFS is empty on every page load — the snapshot cache restores node_modules, never the
   * user's source. Answering true would make a mount skip restoring the working copy, i.e. lose work.
   */
  it('reports bootRestoredFilesystem false', () => {
    expect(makeProvider().provider.bootRestoredFilesystem).toBe(false);
  });
});

describe('the Vite dep cache (the cold first paint)', () => {
  const PKG = JSON.stringify({ dependencies: { '@babylonjs/core': '9.16.0' } });

  /** A store that records what it was asked for and what it was handed. */
  function fakeStore(seed?: Record<string, Record<string, Uint8Array>>) {
    const entries = new Map(Object.entries(seed ?? {}));
    const gets: string[] = [];
    const puts: string[] = [];

    return {
      gets,
      puts,
      entries,
      open: async () => ({
        async get(key: string) {
          gets.push(key);
          return entries.get(key);
        },
        async put(key: string, files: Record<string, Uint8Array>) {
          puts.push(key);
          entries.set(key, files);
        },
      }),
    };
  }

  function make(seedStore?: Record<string, Record<string, Uint8Array>>) {
    const store = fakeStore(seedStore);
    const fake = createFakeClient({ 'npm run dev': {}, 'npm install': {} }, true);
    let fireServerReady: () => void = () => {};

    const provider = createNodepodProvider(fake.client, {
      workdir: WORKDIR,
      onServerReady(listener) {
        fireServerReady = () => listener(5173, 'http://localhost/preview');

        return () => {};
      },
      openViteCache: store.open,

      /* Short, but not a 1 ms spin: a hot poll here adds scheduler pressure to every other spec. */
      viteCapturePollMs: 5,
      viteCaptureTimeoutMs: 500,
    });

    return { store, fake, provider, fireServerReady: () => fireServerReady() };
  }

  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  const write = async (proc: { input: WritableStream<string> }, text: string) => {
    const w = proc.input.getWriter();
    await w.write(text);
    w.releaseLock();
  };

  /*
   * 🔴 THE TIMING IS THE WHOLE FEATURE. The cache only helps if it is in place before Vite starts,
   * and `node_modules` only exists after the install — so there is no single moment at boot when
   * both are true. Checking before each command until it fires is what makes `npm install` a no-op
   * and the `npm run dev` after it a restore, with no sniffing at what the command actually is.
   */
  it('does nothing while node_modules is absent, and restores once it appears', async () => {
    const key = viteCacheKey(PKG)!;
    const { store, fake, provider } = make({
      [key]: { [VITE_CACHE_SENTINEL]: new TextEncoder().encode('{"hash":"abc"}') },
    });

    fake.files.set(`${WORKDIR}/package.json`, PKG);

    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'npm install\n');
    await settle();

    expect(store.gets).toEqual([]);

    // The install has now produced node_modules, exactly as it does in the real pod.
    fake.dirs.add(`${WORKDIR}/node_modules`);

    await write(shell, 'npm run dev\n');
    await settle();

    expect(store.gets).toEqual([key]);
    expect(fake.files.has(`${WORKDIR}/${VITE_CACHE_SENTINEL}`)).toBe(true);
  });

  /*
   * A warm pod that already has optimized deps is NEWER than anything we stored. Overwriting it is
   * the `bootRestoredFilesystem` mistake in miniature — a stale copy written over live state.
   */
  it('never overwrites a pod that already has optimized deps', async () => {
    const key = viteCacheKey(PKG)!;
    const { store, fake, provider } = make({ [key]: { [VITE_CACHE_SENTINEL]: new TextEncoder().encode('stale') } });

    fake.files.set(`${WORKDIR}/package.json`, PKG);
    fake.dirs.add(`${WORKDIR}/node_modules`);
    fake.files.set(`${WORKDIR}/${VITE_CACHE_SENTINEL}`, 'fresh');

    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);
    await write(shell, 'npm run dev\n');
    await settle();

    expect(store.gets).toEqual([]);
    expect(fake.files.get(`${WORKDIR}/${VITE_CACHE_SENTINEL}`)).toBe('fresh');
  });

  /* Attempted at most once per pod: after that it is a boolean, not two stats per command. */
  it('attempts the restore only once', async () => {
    const key = viteCacheKey(PKG)!;
    const { store, fake, provider } = make({ [key]: {} });

    fake.files.set(`${WORKDIR}/package.json`, PKG);
    fake.dirs.add(`${WORKDIR}/node_modules`);

    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);
    await write(shell, 'npm run dev\n');
    await settle();
    await write(shell, 'npm run dev\n');
    await settle();

    expect(store.gets).toEqual([key]);
  });

  /*
   * 🔴 Capture waits for the sentinel, NOT for the server. The dev server is up long before the
   * first request triggers optimization, so storing on server-ready would persist a half-written
   * directory — which Vite would then trust on the next boot and serve modules that are not there.
   */
  it('captures only once Vite has finished optimizing', async () => {
    const { store, fake, provider, fireServerReady } = make();

    fake.files.set(`${WORKDIR}/package.json`, PKG);
    void provider;

    fireServerReady();
    await settle(30);

    expect(store.puts).toEqual([]);

    fake.files.set(`${WORKDIR}/${VITE_CACHE_SENTINEL}`, '{"hash":"abc"}');
    fake.files.set(`${WORKDIR}/node_modules/.vite/deps/babylon.js`, 'optimized');
    await settle(60);

    expect(store.puts).toEqual([viteCacheKey(PKG)]);
    expect(Object.keys(store.entries.get(viteCacheKey(PKG)!)!)).toContain(VITE_CACHE_SENTINEL);
  });

  /* A cache must never be able to stop a project from starting. */
  it('runs the command anyway when the store is unavailable', async () => {
    const fake = createFakeClient({ 'npm run dev': {} }, true);
    const provider = createNodepodProvider(fake.client, {
      workdir: WORKDIR,
      onServerReady: noServers,
      openViteCache: async () => {
        throw new Error('IndexedDB is disabled in this context');
      },
    });

    fake.files.set(`${WORKDIR}/package.json`, PKG);
    fake.dirs.add(`${WORKDIR}/node_modules`);

    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);
    await write(shell, 'npm run dev\n');
    await settle();

    expect(fake.execCalls.map((c) => c.shellCommand)).toEqual(['npm run dev']);
  });
});

describe('textSearch', () => {
  const OPTIONS = {
    folders: [WORKDIR],
    homeDir: WORKDIR,
    includes: ['**/*.*'],
    excludes: ['**/node_modules/**', '**/package-lock.json', '**/dist/**', '**/*.lock'],
    gitignore: true,
    requireGit: false,
    globalIgnoreFiles: true,
    isRegex: false,
    caseSensitive: false,
    isWordMatch: false,
    ignoreSymlinks: false,
    resultLimit: 500,
  };

  /** Run a search and collect what the panel would receive. */
  async function search(query: string, files: Record<string, string | Uint8Array>, overrides = {}) {
    const { provider, fake } = makeProvider();

    for (const [path, contents] of Object.entries(files)) {
      fake.files.set(`${WORKDIR}/${path}`, contents);
    }

    const hits: Array<{ path: string; line: number; column: number; preview: string }> = [];

    await provider.textSearch!(query, { ...OPTIONS, ...overrides }, (path, matches) => {
      for (const match of matches) {
        hits.push({
          path,
          line: match.ranges[0].startLineNumber,
          column: match.ranges[0].startColumn,
          preview: match.preview.text,
        });
      }
    });

    return hits;
  }

  it('finds a match and reports it at an absolute path with 1-based coordinates', async () => {
    const hits = await search('GameManager', {
      'src/scripts/RacerMode.ts': 'import x from "y";\nGameManager.NavigateTo("/play");\n',
    });

    expect(hits).toEqual([
      {
        path: `${WORKDIR}/src/scripts/RacerMode.ts`,
        line: 2,
        column: 1,
        preview: 'GameManager.NavigateTo("/play");',
      },
    ]);
  });

  it('searches nested directories', async () => {
    const hits = await search('needle', { 'a/b/c/deep.ts': 'const needle = 1;\n' });

    expect(hits.map((h) => h.path)).toEqual([`${WORKDIR}/a/b/c/deep.ts`]);
  });

  /*
   * 🔴 The excluded directory must be PRUNED, not filtered at the leaf. `node_modules` is tens of
   * thousands of files in this tab's memory, and the search runs on every debounced keystroke —
   * reading them all and then discarding them is the entire cost this is meant to avoid.
   */
  it('never descends into an excluded directory', async () => {
    const hits = await search('needle', {
      'node_modules/pkg/index.js': 'needle',
      'dist/bundle.js': 'needle',
      'src/ok.ts': 'needle',
    });

    expect(hits.map((h) => h.path)).toEqual([`${WORKDIR}/src/ok.ts`]);
  });

  /* Decoding `havok.wasm` to UTF-8 and regexing 2 MB of it can never produce a useful result. */
  it('skips binary files', async () => {
    const hits = await search('needle', {
      'public/havok.wasm': new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]),
      'src/ok.ts': 'needle',
    });

    expect(hits.map((h) => h.path)).toEqual([`${WORKDIR}/src/ok.ts`]);
  });

  it('honours the result limit across files', async () => {
    const hits = await search('x', { 'a.ts': 'x\nx\nx\n', 'b.ts': 'x\nx\nx\n' }, { resultLimit: 4 });

    expect(hits).toHaveLength(4);
  });

  /* A half-typed regex is the normal state of a search box, not an error to throw out of a keystroke. */
  it('returns nothing for an unparseable regex rather than rejecting', async () => {
    await expect(search('(', { 'a.ts': 'anything' }, { isRegex: true })).resolves.toEqual([]);
  });
});

describe('mount and byte-identity', () => {
  it('round-trips binary bytes exactly through mount → readFile', async () => {
    const { provider } = makeProvider();
    const bytes = new Uint8Array([0x00, 0xff, 0x1b, 0x07, 0x80, 0x0a, 0x0d]);
    const tree: SandboxFileTree = { public: { directory: { 'havok.wasm': { file: { contents: bytes } } } } };

    await provider.mount(tree);

    const read = await provider.fs.readFile('public/havok.wasm');

    expect(read).toBeInstanceOf(Uint8Array);
    expect([...read]).toEqual([...bytes]);
  });

  it('creates parent directories for nested files', async () => {
    const { provider, fake } = makeProvider();

    await provider.mount({ src: { directory: { deep: { directory: { 'a.ts': { file: { contents: 'x' } } } } } } });

    expect(fake.dirs.has(`${WORKDIR}/src/deep`)).toBe(true);
    expect(await provider.fs.readFile('src/deep/a.ts', 'utf8')).toBe('x');
  });

  it('writes paths under the workdir, never at the filesystem root', async () => {
    const { provider, fake } = makeProvider();

    await provider.mount({ 'package.json': { file: { contents: '{}' } } });

    expect([...fake.files.keys()]).toEqual([`${WORKDIR}/package.json`]);
  });
});

describe('readdir', () => {
  it('returns plain names without withFileTypes', async () => {
    const { provider } = makeProvider();
    await provider.mount({
      'a.ts': { file: { contents: '' } },
      src: { directory: { 'b.ts': { file: { contents: '' } } } },
    });

    expect(await provider.fs.readdir('')).toEqual(['a.ts', 'src']);
  });

  /* refresh-walk recurses on isDirectory(); getting this wrong shows the model a flat project. */
  it('synthesises dirents that distinguish files from directories', async () => {
    const { provider } = makeProvider();
    await provider.mount({
      'a.ts': { file: { contents: '' } },
      src: { directory: { 'b.ts': { file: { contents: '' } } } },
    });

    const entries = await provider.fs.readdir('', { withFileTypes: true });
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.isDirectory()]));

    expect(byName).toEqual({ 'a.ts': false, src: true });
  });

  it.each(['', '.'])('lists the project root spelled %o', async (spelling) => {
    const { provider } = makeProvider();
    await provider.mount({ 'a.ts': { file: { contents: '' } } });

    expect(await provider.fs.readdir(spelling)).toEqual(['a.ts']);
  });

  it('treats an entry that vanishes between listing and stat as a file, never a directory', async () => {
    const { provider, fake } = makeProvider();
    await provider.mount({ 'gone.ts': { file: { contents: '' } } });
    fake.client.fs.stat = () => Promise.reject(new Error('ENOENT'));

    const [entry] = await provider.fs.readdir('', { withFileTypes: true });

    expect([entry.isDirectory(), entry.isFile()]).toEqual([false, true]);
  });
});

describe('spawn', () => {
  it('runs in the workdir and streams output, resolving the real exit code', async () => {
    const { provider, fake } = makeProvider({ npm: { output: 'added 306 packages\n', exitCode: 0 } });
    const proc = await provider.spawn('npm', ['install']);

    expect(await readUntil(proc.output, (s) => s.includes('306'))).toContain('added 306 packages');
    expect(await proc.exit).toBe(0);
    expect(fake.spawnCalls[0]).toEqual({ cmd: 'npm', args: ['install'], cwd: WORKDIR });
  });

  it('propagates a non-zero exit code', async () => {
    const { provider } = makeProvider({ npm: { exitCode: 7 } });

    expect(await (await provider.spawn('npm', ['run', 'nope'])).exit).toBe(7);
  });

  it('rebases a relative cwd onto the workdir', async () => {
    const { provider, fake } = makeProvider({ npm: {} });
    await provider.spawn('npm', [], { cwd: 'packages/app' });

    expect(fake.spawnCalls[0].cwd).toBe(`${WORKDIR}/packages/app`);
  });
});

describe('the interactive shell', () => {
  const write = async (proc: { input: WritableStream<string> }, text: string) => {
    const w = proc.input.getWriter();
    await w.write(text);
    w.releaseLock();
  };

  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('is ready immediately (emits a prompt with no readyOsc declared)', async () => {
    const { provider } = makeProvider();
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, [], { terminal: { cols: 80, rows: 24 } });

    expect(scanOscSignals(await readUntil(shell.output, (s) => s.includes(';prompt'))).signals).toEqual([
      { code: 'prompt' },
    ]);
  });

  /*
   * 🔴 THE DEFECT THIS FILE EXISTS FOR (found by reading Nodepod's own source, 2026-07-31).
   *
   * Nodepod runs a REAL shell interpreter — pipes, `&&`, redirects, globs, quoting, `$VAR`. Its
   * `spawn(cmd, args)` reaches it by joining `cmd` and `args` into one line, SHELL-QUOTING each
   * argument first; only when `args` is empty is `cmd` passed through verbatim. The first adapter
   * split the command on whitespace and handed the words over as `args`, so every operator was
   * quoted into a literal: `npm install && npm run dev` became six quoted words, and
   * `echo "hello world"` became two. The interpreter was there the whole time and we were escaping
   * the request out of it.
   *
   * Asserted on the ONE STRING the runtime receives, in both the persistent and the degraded path,
   * because that string is the entire difference between a shell and an argv splitter.
   */
  describe('the whole command line reaches the shell interpreter, unsplit', () => {
    const OPERATOR_LINES = [
      'npm install && npm run dev',
      'cat package.json | grep name',
      'echo "hello world" > out.txt',
      'grep -r GameManager src/ 2>&1',
      'ls src/*.ts',
      'echo $HOME',
    ];

    it.each(OPERATOR_LINES)('passes %j through untouched on the persistent shell', async (line) => {
      const { provider, fake } = makeProvider({}, true);
      const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

      await write(shell, `${line}\n`);
      await settle();

      expect(fake.execCalls.map((c) => c.shellCommand)).toEqual([line]);
    });

    it.each(OPERATOR_LINES)('passes %j through untouched without a process manager', async (line) => {
      const { provider, fake } = makeProvider({}, false);
      const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

      await write(shell, `${line}\n`);
      await settle();

      /*
       * ⚠️ `args` MUST be empty. A non-empty args array is what makes Nodepod quote the pieces, so
       * asserting only on `cmd` would pass for an implementation that still destroys the line.
       */
      expect(fake.spawnCalls).toEqual([{ cmd: line, args: [], cwd: WORKDIR }]);
    });
  });

  it('wraps a command in begin → output → exit → prompt, with the real exit code', async () => {
    const { provider } = makeProvider({ 'npm install': { output: 'installing\n', exitCode: 0 } }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'npm install\n');

    // Count prompts, don't test for presence: the READY prompt is already there before the command.
    const seen = await readUntil(shell.output, (s) => (s.match(/;prompt/g) ?? []).length === 2);
    const codes = scanOscSignals(seen).signals.map((s) => s.code);

    expect(codes).toEqual(['prompt', 'begin', 'exit', 'prompt']);
    expect(scanOscSignals(seen).signals.find((s) => s.code === 'exit')).toEqual({ code: 'exit', exitCode: 0 });
    expect(seen).toContain('installing');
  });

  it('reports a failing command as a non-zero exit rather than silence', async () => {
    const { provider } = makeProvider({ 'npm run broken': { exitCode: 1 } }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'npm run broken\n');

    const seen = await readUntil(shell.output, (s) => s.includes('exit='));

    expect(scanOscSignals(seen).signals.find((s) => s.code === 'exit')).toEqual({ code: 'exit', exitCode: 1 });
  });

  /*
   * 🔴 The whole point. If spawn REJECTS and no exit marker follows, `executeCommand` waits forever,
   * nothing throws, and every later shell action in the tab is dead — the execution-queue poisoning
   * failure in another skin.
   */
  it('still emits an exit marker when the command cannot start at all', async () => {
    const { provider } = makeProvider({ 'frobnicate --now': { throws: true } });
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'frobnicate --now\n');

    const seen = await readUntil(shell.output, (s) => s.includes('exit='));
    const exit = scanOscSignals(seen).signals.find((s) => s.code === 'exit');

    expect(exit).toEqual({ code: 'exit', exitCode: 1 });
    expect(seen).toContain('command not found');
  });

  it('serialises two commands so their markers cannot interleave', async () => {
    const { provider } = makeProvider({ a: { exitCode: 0 }, b: { exitCode: 2 } }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'a\nb\n');

    const seen = await readUntil(shell.output, (s) => (s.match(/;prompt/g) ?? []).length === 3);
    const codes = scanOscSignals(seen).signals.map((s) => s.code);

    expect(codes).toEqual(['prompt', 'begin', 'exit', 'prompt', 'begin', 'exit', 'prompt']);
    expect(
      scanOscSignals(seen)
        .signals.filter((s) => s.code === 'exit')
        .map((s) => s.exitCode),
    ).toEqual([0, 2]);
  });

  it('does not execute a command until its newline arrives', async () => {
    const { provider, fake } = makeProvider({ npm: {} });
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'npm inst');
    await settle();

    expect(fake.spawnCalls).toEqual([]);
  });

  it('answers a bare Enter with a prompt and runs nothing', async () => {
    const { provider, fake } = makeProvider();
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, '\n');
    await settle();

    expect(fake.spawnCalls).toEqual([]);
  });

  /*
   * 🔴 THE LIVE FAILURE (2026-07-31). `BoltShell.executeCommand` writes `'\x03'` before EVERY
   * command. Without control-character handling it was buffered and glued onto the next line, so
   * the command ran as `"\x03npm"` — reported by the runtime as `npm: command not found`, with the
   * offending character invisible in the terminal. Install failed and the dev server never started.
   */
  it('runs the real command after the interrupt executeCommand always sends first', async () => {
    const { provider, fake } = makeProvider({ 'npm install': {} }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, '\x03');
    await write(shell, 'npm install\n');
    await settle();

    expect(fake.execCalls.map((c) => c.shellCommand)).toEqual(['npm install']);
  });

  /*
   * `executeCommand` BLOCKS on `waitTillOscCode('prompt')` immediately after writing the interrupt,
   * so a shell that swallows Ctrl-C silently never runs another command for the life of the tab.
   */
  it('answers an interrupt with a prompt so executeCommand can proceed', async () => {
    const { provider } = makeProvider();
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);
    const seen = readUntil(shell.output, (s) => (s.match(/;prompt/g) ?? []).length >= 2);

    await write(shell, '\x03');

    expect(((await seen).match(/;prompt/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  /*
   * An interrupt must reach a RUNNING process. Routing it through the command queue would delay it
   * until that process had already exited — which is not an interrupt, and would hang the shell
   * behind a dev server that never returns.
   */
  it('kills a running process instead of queueing behind it', async () => {
    const { provider, fake } = makeProvider({ 'npm run dev': { neverExits: true } }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'npm run dev\n');
    await settle();

    expect(fake.killed).toEqual([]);

    await write(shell, '\x03');
    await settle();

    expect(fake.killed).toEqual(['npm run dev']);
  });

  /*
   * 🔴 An IDLE interrupt must NOT kill the shell worker.
   *
   * `executeCommand` writes `\x03` before every single command. Killing on each one would respawn a
   * worker per command — a ~1 s boot each time — and throw away the `cd` the persistent shell exists
   * to keep, silently converting it back into the one-shot shell it replaced.
   */
  it('leaves the shell worker alone when nothing is running', async () => {
    const { provider, fake } = makeProvider({ ls: {} }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'ls\n');
    await settle();

    await write(shell, '\x03');
    await write(shell, 'ls\n');
    await settle();

    expect(fake.killed).toEqual([]);
    expect(fake.workers).toHaveLength(1);
  });

  /* One worker for the session — the reason `ls` does not cost a second. */
  it('reuses one shell worker across commands', async () => {
    const { provider, fake } = makeProvider({ a: {}, b: {}, c: {} }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'a\nb\nc\n');
    await settle();

    expect(fake.execCalls.map((c) => c.shellCommand)).toEqual(['a', 'b', 'c']);
    expect(fake.workers).toHaveLength(1);
  });

  /* `cd` is the one command whose whole purpose is to outlive itself. */
  it('remembers the working directory after a cd', async () => {
    const { provider, fake } = makeProvider({ ls: {} }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'cd src\n');
    await settle();
    await write(shell, 'ls\n');
    await settle();

    expect(fake.execCalls.at(-1)).toEqual({ shellCommand: 'ls', cwd: `${WORKDIR}/src` });
  });

  it('shows the new directory in the prompt after a cd', async () => {
    const { provider } = makeProvider({}, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'cd src\n');

    expect(await readUntil(shell.output, (s) => s.includes('~/src'))).toContain('~/src');
  });

  /*
   * 🔴 The terminal ECHOES. Without this a human types blind: keystrokes are accepted and nothing
   * is drawn until Enter. Nothing throws — it just looks broken, which is how it was reported.
   */
  it('echoes typed characters back to the terminal', async () => {
    const { provider } = makeProvider();
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);
    const seen = readUntil(shell.output, (s) => s.includes('npm'));

    await write(shell, 'n');
    await write(shell, 'p');
    await write(shell, 'm');

    expect(await seen).toContain('npm');
  });

  /*
   * While a command runs, keystrokes belong to ITS stdin — an installer asking a question, a dev
   * server reading a key. Line-editing them instead would swallow the answer and hang the prompt.
   */
  it('routes input to the running process stdin, but never the interrupt', async () => {
    const { provider, fake } = makeProvider({ 'npm init': { neverExits: true } }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'npm init\n');
    await settle();

    await write(shell, 'my-game\n');
    await settle();

    expect(fake.workers[0].stdin).toEqual(['my-game\n']);

    await write(shell, '\x03');
    await settle();

    expect(fake.killed).toEqual(['npm init']);
  });

  /* A TUI that reads 80x24 when the pane is 200 wide draws itself wrong on the only screen there is. */
  it('seeds and forwards the terminal size', async () => {
    const { provider, fake } = makeProvider({ ls: {} }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, [], { terminal: { cols: 120, rows: 40 } });

    await write(shell, 'ls\n');
    await settle();

    expect(fake.workers[0].resized[0]).toEqual([120, 40]);

    shell.resize({ cols: 200, rows: 50 });
    expect(fake.workers[0].resized.at(-1)).toEqual([200, 50]);
  });

  /*
   * xterm reads `\n` as "down one row" and not as "return to column 0", so raw Unix output
   * staircases across the screen. Nodepod's own terminal makes the same substitution.
   */
  it('converts bare newlines in output to CRLF', async () => {
    const { provider } = makeProvider({ ls: { output: 'a\nb\n' } }, true);
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'ls\n');

    expect(await readUntil(shell.output, (s) => s.includes('exit='))).toContain('a\r\nb\r\n');
  });
});

describe('watch and lifecycle', () => {
  /** Classification is async (it stats and reads); let the chain drain before asserting. */
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it('emits absolute paths and unsubscribes cleanly', async () => {
    const { provider, fake } = makeProvider();
    await provider.fs.writeFile('src/main.tsx', 'export default 1;');

    const seen: SandboxWatchEvent[] = [];
    const stop = provider.watchPaths({}, (events) => seen.push(...events));

    fake.fire('change', 'src/main.tsx');
    await settle();

    expect(seen[0].path).toBe(`${WORKDIR}/src/main.tsx`);

    stop();
    expect(fake.closed.watch).toBe(true);
  });

  /*
   * 🔴 THE LIVE REGRESSION (2026-07-31). `rename` used to map to `update_directory`, a type
   * `FilesStore.#processEventBuffer` has NO case for — so every event was silently discarded and the
   * file map stayed empty behind a fully populated VFS. Asserted as membership of the set the store
   * actually handles, so no future mapping can quietly reintroduce an ignored type.
   */
  it('never emits an event type FilesStore would silently drop', async () => {
    const { provider, fake } = makeProvider();
    await provider.fs.writeFile('src/main.tsx', 'x');
    await provider.fs.mkdir('src/deep', { recursive: true });

    const seen: SandboxWatchEvent[] = [];
    provider.watchPaths({ includeContent: true }, (e) => seen.push(...e));

    fake.fire('rename', 'src/main.tsx');
    fake.fire('change', 'src/main.tsx');
    fake.fire('rename', 'src/deep');
    fake.fire('rename', 'src/gone.ts');
    await settle();

    expect(seen.length).toBe(4);

    for (const event of seen) {
      expect(['change', 'add_file', 'remove_file', 'add_dir', 'remove_dir']).toContain(event.type);
    }
  });

  it('classifies a create, a modify, a directory and a delete from the filesystem', async () => {
    const { provider, fake } = makeProvider();
    await provider.fs.writeFile('src/main.tsx', 'x');
    await provider.fs.mkdir('src/deep', { recursive: true });

    const seen: SandboxWatchEvent[] = [];
    provider.watchPaths({ includeContent: true }, (e) => seen.push(...e));

    fake.fire('rename', 'src/main.tsx');
    await settle();
    expect(seen.at(-1)!.type).toBe('add_file');

    fake.fire('change', 'src/main.tsx');
    await settle();
    expect(seen.at(-1)!.type).toBe('change');

    fake.fire('rename', 'src/deep');
    await settle();
    expect(seen.at(-1)!.type).toBe('add_dir');

    await provider.fs.rm('src/main.tsx');
    fake.fire('rename', 'src/main.tsx');
    await settle();
    expect(seen.at(-1)!.type).toBe('remove_file');
  });

  /*
   * 🔴 `FilesStore` builds its entry from `buffer`, so an unenriched event records the file as
   * EMPTY — a generation's output would appear as a tree full of blank files. The CodeSandbox
   * adapter carries the same warning; this is the Nodepod half of it.
   */
  it('enriches file events with their real bytes when includeContent is set', async () => {
    const { provider, fake } = makeProvider();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await provider.fs.writeFile('public/logo.png', bytes);

    const seen: SandboxWatchEvent[] = [];
    provider.watchPaths({ includeContent: true }, (e) => seen.push(...e));

    fake.fire('rename', 'public/logo.png');
    await settle();

    expect(seen[0].type).toBe('add_file');
    expect(Array.from(seen[0].buffer!)).toEqual(Array.from(bytes));
  });

  it('sends no buffer for a directory', async () => {
    const { provider, fake } = makeProvider();
    await provider.fs.mkdir('src/deep', { recursive: true });

    const seen: SandboxWatchEvent[] = [];
    provider.watchPaths({ includeContent: true }, (e) => seen.push(...e));

    fake.fire('rename', 'src/deep');
    await settle();

    expect(seen[0]).toEqual({ type: 'add_dir', path: `${WORKDIR}/src/deep`, buffer: undefined });
  });

  /*
   * 🔴 Nodepod's watcher takes NO excludes, so this filter is the only thing between the file map and
   * `node_modules`. Unfiltered, `npm install`'s 306 packages each cost a stat, a full readFile and a
   * store write on the UI thread.
   */
  it('applies the exclude globs the runtime cannot', async () => {
    const { provider, fake } = makeProvider();
    await provider.fs.writeFile('node_modules/react/index.js', 'x');
    await provider.fs.writeFile('src/main.tsx', 'x');

    const seen: SandboxWatchEvent[] = [];
    provider.watchPaths({ includeContent: true, exclude: MAP_EXCLUDE_GLOBS }, (e) => seen.push(...e));

    fake.fire('rename', 'node_modules/react/index.js');
    fake.fire('rename', 'src/main.tsx');
    await settle();

    expect(seen.map((e) => e.path)).toEqual([`${WORKDIR}/src/main.tsx`]);
  });

  it('ignores an event with no filename instead of emitting the workdir', async () => {
    const { provider, fake } = makeProvider();
    const seen: unknown[] = [];
    provider.watchPaths({}, (e) => seen.push(...e));

    fake.fire('change', null);
    await settle();

    expect(seen).toEqual([]);
  });

  /* An unsubscribe must silence events already in flight, not just future ones. */
  it('emits nothing after unsubscribing', async () => {
    const { provider, fake } = makeProvider();
    await provider.fs.writeFile('src/main.tsx', 'x');

    const seen: unknown[] = [];
    const stop = provider.watchPaths({ includeContent: true }, (e) => seen.push(...e));

    fake.fire('rename', 'src/main.tsx');
    stop();
    await settle();

    expect(seen).toEqual([]);
  });

  it('reports a server ready as an open port, and never invents a close', () => {
    const fake = createFakeClient();
    let emit: ((port: number, url: string) => void) | undefined;
    const provider = createNodepodProvider(fake.client, {
      workdir: WORKDIR,
      onServerReady: (l) => {
        emit = l;

        return () => {};
      },
    });

    const events: Array<[number, string, string]> = [];
    provider.onPort((port, type, url) => events.push([port, type, url]));
    emit?.(5173, 'http://localhost/__virtual__/pod/5173');

    expect(events).toEqual([[5173, 'open', 'http://localhost/__virtual__/pod/5173']]);
  });

  it('tears the pod down', () => {
    const { provider, fake } = makeProvider();
    provider.teardown();

    expect(fake.closed.pod).toBe(true);
  });
});
