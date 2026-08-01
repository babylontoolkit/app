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
import { scanOscSignals } from '~/utils/shell';
import { NODEPOD_CAPABILITIES, NODEPOD_SHELL_COMMAND, createNodepodProvider } from './nodepod-provider';
import type { NodepodClient, NodepodProc } from './nodepod-provider';
import type { SandboxFileTree } from './types';

const WORKDIR = '/home/user/workspace';

interface FakeSpawn {
  output?: string;
  exitCode?: number;
  throws?: boolean;
}

function createFakeClient(spawns: Record<string, FakeSpawn> = {}) {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>([WORKDIR]);
  const spawnCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
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
      const proc: NodepodProc = {
        completion: Promise.resolve({ exitCode: plan?.exitCode ?? 0 }),
        write: () => {},
        kill: () => {},
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
  };

  return { client, files, dirs, spawnCalls, closed, fire: (e: string, f: string | null) => watcher?.(e, f) };
}

const noServers = () => () => {};

function makeProvider(spawns?: Record<string, FakeSpawn>) {
  const fake = createFakeClient(spawns);
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
  it('declares terminal+watch, and declines textSearch and clearPort', () => {
    expect(NODEPOD_CAPABILITIES).toEqual({ terminal: true, textSearch: false, watch: true, clearPort: false });
  });

  /* Declining a capability must mean the method is ABSENT, never a silent no-op (types.ts). */
  it('omits the methods it declines', () => {
    const { provider } = makeProvider();

    expect(provider.textSearch).toBeUndefined();
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

describe('the synthesised interactive shell', () => {
  const write = async (proc: { input: WritableStream<string> }, text: string) => {
    const w = proc.input.getWriter();
    await w.write(text);
    w.releaseLock();
  };

  it('is ready immediately (emits a prompt with no readyOsc declared)', async () => {
    const { provider } = makeProvider();
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, [], { terminal: { cols: 80, rows: 24 } });

    expect(scanOscSignals(await readUntil(shell.output, (s) => s.length > 0)).signals).toEqual([{ code: 'prompt' }]);
  });

  it('wraps a command in begin → output → exit → prompt, with the real exit code', async () => {
    const { provider } = makeProvider({ npm: { output: 'installing\n', exitCode: 0 } });
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
    const { provider } = makeProvider({ npm: { exitCode: 1 } });
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
    const { provider } = makeProvider({ frobnicate: { throws: true } });
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, 'frobnicate --now\n');

    const seen = await readUntil(shell.output, (s) => s.includes('exit='));
    const exit = scanOscSignals(seen).signals.find((s) => s.code === 'exit');

    expect(exit).toEqual({ code: 'exit', exitCode: 1 });
    expect(seen).toContain('command not found');
  });

  it('serialises two commands so their markers cannot interleave', async () => {
    const { provider } = makeProvider({ a: { exitCode: 0 }, b: { exitCode: 2 } });
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
    await new Promise((r) => setTimeout(r, 5));

    expect(fake.spawnCalls).toEqual([]);
  });

  it('answers a bare Enter with a prompt and runs nothing', async () => {
    const { provider, fake } = makeProvider();
    const shell = await provider.spawn(NODEPOD_SHELL_COMMAND, []);

    await write(shell, '\n');
    await new Promise((r) => setTimeout(r, 5));

    expect(fake.spawnCalls).toEqual([]);
  });
});

describe('watch and lifecycle', () => {
  it('emits absolute paths and unsubscribes cleanly', () => {
    const { provider, fake } = makeProvider();
    const seen: unknown[] = [];
    const stop = provider.watchPaths({}, (events) => seen.push(...events));

    fake.fire('change', 'src/main.tsx');
    expect(seen).toEqual([{ type: 'change', path: `${WORKDIR}/src/main.tsx` }]);

    fake.fire('rename', 'src/new.ts');
    expect(seen[1]).toEqual({ type: 'update_directory', path: `${WORKDIR}/src/new.ts` });

    stop();
    expect(fake.closed.watch).toBe(true);
  });

  it('ignores an event with no filename instead of emitting the workdir', () => {
    const { provider, fake } = makeProvider();
    const seen: unknown[] = [];
    provider.watchPaths({}, (e) => seen.push(...e));

    fake.fire('change', null);

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
