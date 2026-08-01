/**
 * `SandboxProvider` adapter for Nodepod — the browser-side runtime (SPEC §8, `spec/sandbox-nodepod.md`).
 *
 * Nodepod runs the real Node toolchain in Web Workers over a Rust/Wasm VFS, with previews served by a
 * same-origin Service Worker. Live-proven 2026-07-31 running the real AppTemplate: Vite 8.2.0 ready in
 * 1,244 ms, Babylon + Toolkit + Havok rendering, 66 ms edit→HMR.
 *
 * 🔴 **This module and `nodepod-boot.ts` are the ONLY places allowed to touch the Nodepod SDK.**
 * `sandbox-seam.spec.ts` enforces that as a default-deny source scan with a control. Feature code
 * imports `~/lib/sandbox` and nothing else.
 *
 * The client is injected rather than imported so the adapter is unit-testable without booting a real
 * runtime, and so the interface below documents exactly what we depend on — the CodeSandbox precedent.
 */
import {
  createLineBuffer,
  flattenTree,
  makeDirent,
  oscBegin,
  oscExit,
  oscPrompt,
  toPodPath,
  toRelPath,
  toWatchEventType,
} from './nodepod-translate';
import type {
  SandboxCapabilities,
  SandboxDirent,
  SandboxFileSystem,
  SandboxFileTree,
  SandboxProcess,
  SandboxProvider,
  SandboxShell,
  SandboxSpawnOptions,
  SandboxWatchEvent,
  SandboxWatchOptions,
} from './types';

/**
 * The subset of Nodepod we use, declared here rather than imported from the SDK.
 *
 * Declaring our own types is a seam rule (`spec/sandbox-seam.md`): a shared type module that imports
 * the vendor makes the default-deny scan impossible, and it means the next provider is written
 * against a specification instead of a competitor's `.d.ts`.
 */
export interface NodepodClient {
  readonly fs: {
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<{ isDirectory(): boolean } | { isDirectory: boolean }>;
    rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
    watch(
      path: string,
      options: { recursive?: boolean },
      cb: (event: string, filename: string | null) => void,
    ): { close(): void };
  };
  spawn(cmd: string, args?: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<NodepodProc>;
  port(num: number): string | null;
  teardown(): void;
}

export interface NodepodProc {
  readonly completion: Promise<{ exitCode: number }>;
  write(data: string): void;
  kill(): void;
  on(event: 'output' | 'error' | 'exit', handler: (value: never) => void): unknown;
}

/**
 * `watch: true` — Nodepod's VFS emits real change events, so `FilesStore` uses the incremental path.
 * `textSearch: false` — no ripgrep; `Search.tsx` already degrades on the flag rather than probing.
 * `clearPort: false` — the runtime dies with the tab, so no previous session's server can hold a port
 * (the flag exists for resumed microVMs; claiming it here would add a pointless round trip per mount).
 */
export const NODEPOD_CAPABILITIES: SandboxCapabilities = {
  terminal: true,
  textSearch: false,
  watch: true,
  clearPort: false,
};

/**
 * Sentinel for the interactive shell.
 *
 * 🔴 Not a binary. Nodepod's shell is a JavaScript interpreter, not bash, so there is no `/bin/jsh`
 * and no rc file to teach the OSC protocol to. `spawn()` recognises this name and builds the
 * adapter-driven shell below. Naming it explicitly beats letting `shell.command` be an arbitrary
 * string that happens not to exist — WebContainer's `/bin/jsh` leaking onto a Linux box printed
 * `No such file or directory`, which named nothing useful.
 */
export const NODEPOD_SHELL_COMMAND = '<nodepod-shell>';

const NODEPOD_SHELL: SandboxShell = {
  command: NODEPOD_SHELL_COMMAND,
  args: [],

  /*
   * No `readyOsc`: the adapter writes a prompt marker as soon as the shell exists, so "ready on first
   * output" is immediately true. `beginOsc` IS set — the adapter emits `begin` before running each
   * command, which is what lets `executeCommand` ignore any exit marker left over from a previous one.
   */
  beginOsc: 'begin',
};

/** Nodepod's stat is shape-tolerant across versions; both forms appear in the wild. */
function isDirectory(stat: { isDirectory(): boolean } | { isDirectory: boolean }): boolean {
  return typeof stat.isDirectory === 'function' ? stat.isDirectory() : Boolean(stat.isDirectory);
}

interface Emitter {
  stream: ReadableStream<string>;
  push(chunk: string): void;
  close(): void;
}

/** A `ReadableStream<string>` fed imperatively, with chunks buffered until a reader attaches. */
function createOutputStream(): Emitter {
  let controller: ReadableStreamDefaultController<string> | undefined;
  const pending: string[] = [];
  let closed = false;

  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;

      for (const chunk of pending) {
        c.enqueue(chunk);
      }

      pending.length = 0;

      if (closed) {
        c.close();
      }
    },
  });

  return {
    stream,
    push(chunk) {
      if (closed) {
        return;
      }

      if (controller) {
        controller.enqueue(chunk);
      } else {
        pending.push(chunk);
      }
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;

      try {
        controller?.close();
      } catch {
        // Already closed by a cancelled reader; nothing to do.
      }
    },
  };
}

/** Wrap one Nodepod process as a {@link SandboxProcess}. */
function adaptProcess(proc: NodepodProc): SandboxProcess {
  const out = createOutputStream();

  proc.on('output', ((chunk: string) => out.push(chunk)) as never);
  proc.on('error', ((chunk: string) => out.push(chunk)) as never);

  const exit = proc.completion.then(
    (r) => {
      out.close();
      return r.exitCode;
    },
    () => {
      out.close();
      return 1;
    },
  );

  return {
    exit,
    output: out.stream,
    input: new WritableStream<string>({ write: (chunk) => void proc.write(chunk) }),
    kill: () => proc.kill(),
    resize: () => {
      /* Nodepod sizes its terminal at creation; nothing to renegotiate. */
    },
  };
}

/**
 * The interactive shell, synthesised.
 *
 * Reads command lines from `input`, runs each through Nodepod, and wraps it in the OSC markers
 * `shell.ts` waits for. **The reading side stays `shell.ts`'s** — see `OSC_EXIT_SHAPE`.
 *
 * Commands are serialised through a single chain so a second command cannot start before the first
 * has emitted its exit marker; interleaved markers would let `executeCommand` match the wrong one.
 * A callback that throws still emits an exit marker — a shell that goes silent on a failed command
 * hangs every later action forever, which is the `execution-queue` poisoning lesson in another skin.
 */
function createShellProcess(client: NodepodClient, workdir: string): SandboxProcess {
  const out = createOutputStream();
  const lines = createLineBuffer();
  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => (resolveExit = resolve));

  let alive = true;
  let current: NodepodProc | undefined;
  let queue: Promise<void> = Promise.resolve();

  // Ready immediately: with no `readyOsc`, first output is the readiness signal.
  out.push(oscPrompt());

  const run = async (line: string) => {
    const command = line.trim();

    if (!alive) {
      return;
    }

    if (command === '') {
      out.push(oscPrompt());
      return;
    }

    out.push(oscBegin());

    let code = 0;

    try {
      const [cmd, ...args] = command.split(/\s+/);
      const proc = await client.spawn(cmd, args, { cwd: workdir });
      current = proc;
      proc.on('output', ((chunk: string) => out.push(chunk)) as never);
      proc.on('error', ((chunk: string) => out.push(chunk)) as never);
      code = (await proc.completion).exitCode;
    } catch (error) {
      out.push(`${String((error as Error)?.message ?? error)}\n`);
      code = 1;
    } finally {
      current = undefined;
      out.push(oscExit(code));
      out.push(oscPrompt());
    }
  };

  return {
    exit,
    output: out.stream,
    input: new WritableStream<string>({
      write(chunk) {
        for (const line of lines.push(chunk)) {
          queue = queue.then(() => run(line));
        }
      },
    }),
    kill() {
      alive = false;
      current?.kill();
      out.close();
      resolveExit(0);
    },
    resize: () => {},
  };
}

export interface NodepodProviderOptions {
  workdir: string;

  /** Registers a dev-server listener with the boot module, which owns Nodepod's `onServerReady`. */
  onServerReady(listener: (port: number, url: string) => void): () => void;
}

export function createNodepodProvider(client: NodepodClient, options: NodepodProviderOptions): SandboxProvider {
  const { workdir } = options;
  const abs = (relPath: string) => toPodPath(workdir, relPath);

  const fs: SandboxFileSystem = {
    readFile: ((path: string, encoding?: BufferEncoding | null) =>
      encoding
        ? client.fs.readFile(abs(path), encoding as 'utf8')
        : client.fs.readFile(abs(path))) as SandboxFileSystem['readFile'],

    writeFile: (path, data) => client.fs.writeFile(abs(path), data),

    /*
     * 🔴 Nodepod returns `string[]`; the seam's `withFileTypes` overload returns dirents, and
     * `refresh-walk.ts` recurses on `isDirectory()`. Without the stat pass the walk sees a flat
     * project and the model is shown a handful of root files. The N+1 stat is cheap here — the VFS
     * is in memory, not a network round trip as on CodeSandbox.
     */
    readdir: (async (path: string, opts?: unknown) => {
      const names = await client.fs.readdir(abs(path));

      if (!opts || typeof opts !== 'object' || !(opts as { withFileTypes?: boolean }).withFileTypes) {
        return names;
      }

      return Promise.all(
        names.map(async (name): Promise<SandboxDirent> => {
          try {
            return makeDirent(name, isDirectory(await client.fs.stat(abs(path ? `${path}/${name}` : name))));
          } catch {
            // A file deleted between listing and stat is a file, not a directory: never recurse into it.
            return makeDirent(name, false);
          }
        }),
      );
    }) as SandboxFileSystem['readdir'],

    mkdir: (async (path: string, opts?: { recursive?: boolean }) => {
      await client.fs.mkdir(abs(path), opts);

      // The seam's recursive overload returns the created path; the non-recursive one returns void.
      return opts?.recursive ? path : undefined;
    }) as SandboxFileSystem['mkdir'],

    rm: (path, opts) => client.fs.rm(abs(path), opts),
  };

  return {
    capabilities: NODEPOD_CAPABILITIES,

    /*
     * Always false. Nodepod's VFS starts empty on every page load — the snapshot cache restores
     * `node_modules`, never the user's source — so the client-held working copy IS the project and
     * restoring it is the only way to have one. Answering true here would make a mount skip the
     * restore and silently lose the user's work.
     */
    bootRestoredFilesystem: false,

    shell: NODEPOD_SHELL,
    workdir,
    fs,

    async mount(tree: SandboxFileTree, mountOptions?: { mountPoint?: string }) {
      const prefix = mountOptions?.mountPoint ? toRelPath(workdir, mountOptions.mountPoint) : '';

      for (const entry of flattenTree(tree, prefix)) {
        const full = abs(entry.path);
        const dir = full.slice(0, full.lastIndexOf('/'));

        if (dir && dir !== workdir) {
          await client.fs.mkdir(dir, { recursive: true });
        }

        await client.fs.writeFile(full, entry.contents);
      }
    },

    async spawn(command: string, args: string[] = [], spawnOptions: SandboxSpawnOptions = {}) {
      if (command === NODEPOD_SHELL_COMMAND) {
        return createShellProcess(client, workdir);
      }

      const env = spawnOptions.env
        ? Object.fromEntries(Object.entries(spawnOptions.env).map(([k, v]) => [k, String(v)]))
        : undefined;

      return adaptProcess(
        await client.spawn(command, args, { cwd: spawnOptions.cwd ? abs(spawnOptions.cwd) : workdir, env }),
      );
    },

    watchPaths(_watchOptions: SandboxWatchOptions, callback: (events: SandboxWatchEvent[]) => void) {
      const handle = client.fs.watch(workdir, { recursive: true }, (event, filename) => {
        if (!filename) {
          return;
        }

        callback([{ type: toWatchEventType(event), path: filename.startsWith('/') ? filename : abs(filename) }]);
      });

      return () => handle.close();
    },

    onServerReady: options.onServerReady,

    onPort(listener) {
      // Nodepod reports readiness only; a close event has no source, so never invent one.
      return options.onServerReady((port, url) => listener(port, 'open', url));
    },

    teardown: () => client.teardown(),
  };
}
