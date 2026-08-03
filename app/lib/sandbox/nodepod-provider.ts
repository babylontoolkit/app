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
  buildSearchRegExp,
  classifyWatchEvent,
  createLineEditor,
  findTextMatches,
  flattenTree,
  formatShellPrompt,
  isNodepodWatchExcluded,
  isSearchCandidate,
  looksBinary,
  makeDirent,
  oscBegin,
  oscExit,
  oscPrompt,
  toPodPath,
  toRelPath,
  toTerminalNewlines,
} from './nodepod-translate';
import {
  VITE_CACHE_MAX_BYTES,
  VITE_CACHE_SENTINEL,
  captureViteCache,
  openViteCacheStore,
  pathExists,
  restoreViteCache,
  totalBytes,
  viteCacheKey,
} from './nodepod-vite-cache';
import type { ViteCacheFs, ViteCacheStore } from './nodepod-vite-cache';
import type {
  SandboxCapabilities,
  SandboxDirent,
  SandboxFileSystem,
  SandboxFileTree,
  SandboxProcess,
  SandboxProvider,
  SandboxShell,
  SandboxSpawnOptions,
  SandboxTextSearchOptions,
  SandboxTextSearchProgress,
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

  /**
   * Nodepod's own process table — how the interactive terminal gets a PERSISTENT shell.
   *
   * 🔴 Optional on purpose, and the provider degrades to one-shot `spawn` without it. `spawn()`
   * creates a fresh Web Worker per call (~1 s, and a whole VFS snapshot), and each worker starts at
   * the directory it was given — so a terminal built on it pays a second per `ls` and forgets `cd`
   * the moment the command ends. `processManager.spawn({ command: 'shell' })` is what
   * `Nodepod.createTerminal` itself uses: one worker for the session, `exec({ persistent: true })`
   * per command, and a `cwd-change` event when the shell moves. Declaring it optional means a
   * version of the SDK that stops exposing it degrades to a slower terminal rather than to none.
   */
  readonly processManager?: NodepodProcessManager;
}

export interface NodepodProcessManager {
  spawn(config: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }): NodepodProcessHandle;

  /** Recursively kills descendants and releases the ports they held. */
  kill(pid: number, signal?: string): boolean;
}

/** One entry in Nodepod's process table. Only the parts the terminal needs are declared. */
export interface NodepodProcessHandle {
  readonly pid: number;
  readonly state: 'starting' | 'running' | 'exited';
  on(event: string, handler: (...values: never[]) => void): unknown;
  removeListener(event: string, handler: (...values: never[]) => void): unknown;
  exec(message: {
    type: 'exec';
    filePath: string;
    args: string[];
    cwd: string;
    isShell: true;
    shellCommand: string;
    persistent: true;
  }): void;
  sendStdin(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface NodepodProc {
  readonly completion: Promise<{ exitCode: number }>;
  write(data: string): void;
  kill(): void;
  on(event: 'output' | 'error' | 'exit', handler: (value: never) => void): unknown;
}

/**
 * `watch: true` — Nodepod's VFS emits real change events, so `FilesStore` uses the incremental path.
 * `textSearch: true` — implemented over the VFS by this adapter (see {@link SandboxProvider.textSearch}).
 * `clearPort: false` — the runtime dies with the tab, so no previous session's server can hold a port
 * (the flag exists for resumed microVMs; claiming it here would add a pointless round trip per mount).
 */
export const NODEPOD_CAPABILITIES: SandboxCapabilities = {
  terminal: true,
  textSearch: true,
  watch: true,
  clearPort: false,

  /*
   * Nodepod runs Node in the browser. A compiled `.node` addon cannot be loaded at all, which is
   * exactly how a cloned Vite 8 repo fails: install fine, start fine, then `Cannot find native
   * binding` from rolldown with no preview. Unlike WebContainer there is no vendor fallback here —
   * rolldown's auto-downloader checks `process.versions.webcontainer` — so the install has to name
   * the WASM binding itself. See `~/utils/rolldown-wasm`.
   */
  nativeAddons: false,
};

/**
 * How many files one search may read before it gives up.
 *
 * A ceiling rather than a timeout because the walk is synchronous-ish work on the UI thread and the
 * honest failure is "this project is too big to scan on every keystroke", not "this took a while".
 * The starter is ~90 files; a project that exceeds this has something unexpected in it.
 */
export const SEARCH_FILE_LIMIT = 5000;

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
 * The interactive shell.
 *
 * 🔴 **The whole command line goes to Nodepod as ONE string, and that is the entire reason pipes,
 * `&&`, redirects, globs and quoting work.** Nodepod runs a real shell interpreter in the process
 * worker — a tokenizer, a parser, pipelines, `&&`/`||`/`;`, `>`/`>>`/`<`/`2>&1`, glob and `$VAR`
 * expansion, command substitution, aliases, and builtins (`ls cat grep find sed head tail sort uniq
 * wc which xargs cd echo touch` plus `npm`/`pnpm`/`yarn`/`bun`/`node`/`git`). Its `spawn(cmd, args)`
 * shell-QUOTES every argument before handing the line to that interpreter, so the first version of
 * this adapter — which split on whitespace and passed the words as `args` — turned
 * `npm install && npm run dev` into six quoted literals and `echo "hello world"` into two. The
 * interpreter was there the whole time; we were escaping it out of the request. Passing the line
 * with NO args is the documented path to it (`args?.length ? quoted : cmd`), and it is why this
 * function has no parser of its own: writing a second one is how the two halves drift.
 *
 * The worker is PERSISTENT (`processManager.spawn({ command: 'shell' })` + `exec({ persistent: true })`
 * — what Nodepod's own terminal does) so `cd` survives between commands and no one pays a ~1 s
 * worker boot to run `ls`. Without a process manager it degrades to one-shot spawns: still a full
 * shell per command, just slower and with no `cd` memory.
 *
 * Commands are serialised through a single chain so a second command cannot start before the first
 * has emitted its exit marker; interleaved markers would let `executeCommand` match the wrong one.
 * A callback that throws still emits an exit marker — a shell that goes silent on a failed command
 * hangs every later action forever, which is the `execution-queue` poisoning lesson in another skin.
 */
function createShellProcess(
  client: NodepodClient,
  workdir: string,
  size?: { cols: number; rows: number },
  beforeCommand?: () => Promise<void>,
) {
  const out = createOutputStream();
  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => (resolveExit = resolve));

  let alive = true;
  let cwd = workdir;
  let cols = size?.cols ?? 80;
  let rows = size?.rows ?? 15;

  /*
   * `running` is read through a thunk rather than passed by value: the editor outlives every command,
   * so it needs the answer at the moment a key arrives, not the answer at construction time (which is
   * always `false`). Declared below — safe because nothing calls this before the shell is built.
   */
  const editor = createLineEditor(
    () => formatShellPrompt(cwd, workdir),
    () => running,
  );

  /**
   * Is a command executing right now?
   *
   * 🔴 It decides where a keystroke goes. While a command runs, input belongs to ITS stdin — an
   * `npm init` asking a question, a dev server reading a keypress — and the line editor must not
   * swallow it. Idle, the same bytes are a command being typed. Nodepod's own terminal makes the
   * same split (`getSendStdin` returns null unless something is running).
   */
  let running = false;

  /** The persistent shell worker, or undefined when there is none (yet, or after a kill). */
  let handle: NodepodProcessHandle | undefined;
  let handleReady: Promise<NodepodProcessHandle> | undefined;

  /** One-shot fallback process, so an interrupt can reach it when there is no process manager. */
  let oneShot: NodepodProc | undefined;

  let queue: Promise<void> = Promise.resolve();

  const write = (text: string) => out.push(text);

  /** The visible prompt AND the marker `executeCommand` waits for — never one without the other. */
  const writePrompt = () => {
    write(formatShellPrompt(cwd, workdir));
    write(oscPrompt());
  };

  // Ready immediately: with no `readyOsc`, first output is the readiness signal.
  writePrompt();

  const startWorker = (): Promise<NodepodProcessHandle> => {
    const manager = client.processManager!;
    const started = manager.spawn({ command: 'shell', args: [], cwd });
    handle = started;

    started.on('cwd-change', ((next: string) => {
      cwd = next;
    }) as never);

    started.on('exit', (() => {
      // The worker died; the next command spawns a fresh one rather than hanging against a corpse.
      if (handle === started) {
        handle = undefined;
        handleReady = undefined;
      }
    }) as never);

    return new Promise<NodepodProcessHandle>((resolve) => {
      const ready = () => {
        /*
         * Seed the size BEFORE the first exec, or an interactive program reads the worker's 80x24
         * default and draws itself to the wrong width on the one screen the user is looking at.
         */
        try {
          started.resize(cols, rows);
        } catch {
          // A runtime without resize support must not stop the shell from starting.
        }

        resolve(started);
      };

      if (started.state === 'running') {
        ready();
      } else {
        started.on('ready', ready as never);
      }
    });
  };

  const ensureWorker = (): Promise<NodepodProcessHandle> => {
    if (!handle || handle.state === 'exited') {
      handleReady = startWorker();
    }

    return handleReady!;
  };

  /** Run one line on the persistent worker. Resolves with its exit code. */
  const runPersistent = async (line: string): Promise<number> => {
    const worker = await ensureWorker();

    return new Promise<number>((resolve) => {
      let streamed = false;

      const onStdout = ((chunk: string) => {
        streamed = true;
        write(toTerminalNewlines(chunk));
      }) as never;

      const onStderr = ((chunk: string) => {
        streamed = true;
        write(toTerminalNewlines(chunk));
      }) as never;

      const settle = (code: number, stdout?: string, stderr?: string) => {
        worker.removeListener('stdout', onStdout);
        worker.removeListener('stderr', onStderr);
        worker.removeListener('shell-done', onDone);
        worker.removeListener('exit', onExit);

        /*
         * `shell-done` carries the full stdout/stderr as well as streaming it. Writing both would
         * double every command's output; Nodepod's terminal guards it the same way.
         */
        if (!streamed) {
          write(toTerminalNewlines(String(stdout ?? '')));
          write(toTerminalNewlines(String(stderr ?? '')));
        }

        resolve(code);
      };

      const onDone = ((code: number, stdout: string, stderr: string) => settle(code, stdout, stderr)) as never;
      const onExit = ((code: number, stdout: string, stderr: string) => settle(code ?? 1, stdout, stderr)) as never;

      worker.on('stdout', onStdout);
      worker.on('stderr', onStderr);
      worker.on('shell-done', onDone);
      worker.on('exit', onExit);

      worker.exec({
        type: 'exec',
        filePath: '',
        args: [],
        cwd,
        isShell: true,
        shellCommand: line,
        persistent: true,
      });
    });
  };

  /**
   * Run one line without a process manager: a fresh worker per command.
   *
   * Still the FULL shell — the line is passed as the command with no args, which is what routes it
   * through the interpreter. What is lost is only the worker reuse and the `cd` memory.
   */
  const runOneShot = async (line: string): Promise<number> => {
    const proc = await client.spawn(line, [], { cwd });
    oneShot = proc;

    proc.on('output', ((chunk: string) => write(toTerminalNewlines(chunk))) as never);
    proc.on('error', ((chunk: string) => write(toTerminalNewlines(chunk))) as never);

    try {
      return (await proc.completion).exitCode;
    } finally {
      oneShot = undefined;
    }
  };

  const run = async (line: string) => {
    const command = line.trim();

    if (!alive) {
      return;
    }

    if (command === '') {
      writePrompt();
      return;
    }

    write(oscBegin());

    let code = 0;
    running = true;

    try {
      /*
       * Before every command until it fires once — the only point at which `node_modules` is known
       * to exist and the dev server is known not to have started. See `ensureViteCacheRestored`.
       */
      await beforeCommand?.();

      code = client.processManager ? await runPersistent(command) : await runOneShot(command);
    } catch (error) {
      write(toTerminalNewlines(`${String((error as Error)?.message ?? error)}\n`));
      code = 1;
    } finally {
      running = false;
      write(oscExit(code));
      writePrompt();
    }
  };

  /**
   * Ctrl-C: stop whatever is running and hand back a prompt.
   *
   * 🔴 The prompt is not optional. `executeCommand` writes the interrupt and then BLOCKS on
   * `waitTillOscCode('prompt')` before it will send the command — so a shell that swallows `\x03`
   * silently never runs another command for the life of the tab.
   *
   * 🔴 And it runs OUT OF BAND, never through `queue`. The queue serialises commands, so a queued
   * interrupt would not fire until the command it is meant to interrupt had already finished —
   * which is not an interrupt, and would hang `executeCommand` behind a dev server that never exits.
   *
   * 🔴 An IDLE interrupt must not kill the worker. `executeCommand` sends `\x03` before EVERY
   * command, and killing the shell each time would respawn a worker per command and throw away the
   * `cd` this design exists to keep — turning the persistent shell back into the one-shot one, at
   * exactly the moment nothing needed interrupting.
   */
  const interrupt = (echoed: boolean) => {
    if (!alive) {
      return;
    }

    if (running) {
      if (handle && client.processManager) {
        client.processManager.kill(handle.pid, 'SIGINT');
      }

      oneShot?.kill();
    }

    if (echoed) {
      writePrompt();
      return;
    }

    /*
     * 🔴 Nothing was interrupted, so the editor printed no `^C` and no line break — the shell is still
     * sitting on the prompt it drew before. Drawing another one appends it to that same line and the
     * user reads `~ $ ~ $ npm install`.
     *
     * The OSC still fires, and that is not optional: `executeCommand` BLOCKS on
     * `waitTillOscCode('prompt')` before sending its command, so a shell that stays quiet here never
     * runs another command for the life of the tab. Signal without redraw is exactly the distinction.
     */
    write(oscPrompt());
  };

  return {
    exit,
    output: out.stream,
    input: new WritableStream<string>({
      write(chunk) {
        if (!alive) {
          return;
        }

        /*
         * A running command owns stdin — but NOT the interrupt, which is the one key that must be
         * able to reach past it. Scanning for `\x03` first is why Ctrl-C works on a dev server.
         */
        if (running && !chunk.includes('\x03')) {
          handle?.sendStdin(chunk);
          oneShot?.write(chunk);

          return;
        }

        const { echo, actions } = editor.push(chunk);

        if (echo !== '') {
          write(echo);
        }

        for (const event of actions) {
          if (event.type === 'interrupt') {
            interrupt(event.echoed);
          } else {
            queue = queue.then(() => run(event.line));
          }
        }
      },
    }),
    kill() {
      alive = false;

      if (handle && client.processManager) {
        client.processManager.kill(handle.pid, 'SIGKILL');
      }

      oneShot?.kill();
      out.close();
      resolveExit(0);
    },
    resize(dimensions: { cols: number; rows: number }) {
      cols = dimensions.cols;
      rows = dimensions.rows;

      try {
        handle?.resize(dimensions.cols, dimensions.rows);
      } catch {
        // A resize that the runtime cannot honour is cosmetic; it must never break the terminal.
      }
    },
  } satisfies SandboxProcess;
}

export interface NodepodProviderOptions {
  workdir: string;

  /** Registers a dev-server listener with the boot module, which owns Nodepod's `onServerReady`. */
  onServerReady(listener: (port: number, url: string) => void): () => void;

  /**
   * Where Vite's optimized dependencies are kept between pods — see `nodepod-vite-cache.ts`.
   *
   * Injectable so the behaviour can be driven by tests without IndexedDB. The default opens the real
   * browser store, which itself answers `undefined` outside a browser, so this is inert in Node.
   */
  openViteCache?: () => Promise<ViteCacheStore | undefined>;

  /** How long to keep watching for Vite to finish optimizing, once a server is up. */
  viteCaptureTimeoutMs?: number;

  /** Poll interval for the same. */
  viteCapturePollMs?: number;
}

/** Defaults for the dep-cache capture watch. Optimization of the real starter took ~17 s. */
export const VITE_CAPTURE_TIMEOUT_MS = 180_000;
export const VITE_CAPTURE_POLL_MS = 1_000;

export function createNodepodProvider(client: NodepodClient, options: NodepodProviderOptions): SandboxProvider {
  const { workdir } = options;
  const abs = (relPath: string) => toPodPath(workdir, relPath);

  /*
   * ---------------------------------------------------------------------------------------------
   * Vite's optimized dependencies, carried across pods — the 17.1 s cold first paint.
   * ---------------------------------------------------------------------------------------------
   */
  const openViteCache = options.openViteCache ?? openViteCacheStore;
  const captureTimeoutMs = options.viteCaptureTimeoutMs ?? VITE_CAPTURE_TIMEOUT_MS;
  const capturePollMs = options.viteCapturePollMs ?? VITE_CAPTURE_POLL_MS;

  /** The pod's fs, in the shape the cache module declares. */
  const cacheFs: ViteCacheFs = {
    readFile: (path) => client.fs.readFile(path),
    writeFile: (path, data) => client.fs.writeFile(path, data),
    mkdir: (path, opts) => client.fs.mkdir(path, opts),
    readdir: (path) => client.fs.readdir(path),
    stat: (path) => client.fs.stat(path),
  };

  const cacheKey = async (): Promise<string | undefined> => {
    try {
      return viteCacheKey(await client.fs.readFile(abs('package.json'), 'utf8'));
    } catch {
      // No package.json yet — the mount has not happened. Nothing to key on, and nothing to restore.
      return undefined;
    }
  };

  /**
   * Put a previously optimized dep cache back, at most once per pod.
   *
   * 🔴 **The timing is the whole trick, and it is why this is not simply done at boot.** The cache
   * only helps if it is in place BEFORE Vite starts, and `node_modules` only exists AFTER
   * `npm install` has run — so there is no single moment at boot when both are true. Instead this is
   * checked before each command until it fires: the install spawn finds no `node_modules` and does
   * nothing, and the `npm run dev` that follows finds one and restores. No command sniffing, no
   * guessing at what the agent is about to run.
   *
   * It is skipped when the pod ALREADY has optimized deps — that is a warm pod whose own cache is
   * newer than ours, and overwriting it would be the `bootRestoredFilesystem` mistake in miniature.
   */
  let restoreAttempted = false;

  const ensureViteCacheRestored = async (): Promise<void> => {
    if (restoreAttempted) {
      return;
    }

    try {
      if (!(await pathExists(cacheFs, abs('node_modules')))) {
        return;
      }

      restoreAttempted = true;

      if (await pathExists(cacheFs, abs(VITE_CACHE_SENTINEL))) {
        return;
      }

      const key = await cacheKey();
      const store = key ? await openViteCache() : undefined;
      const files = key && store ? await store.get(key) : undefined;

      if (files) {
        await restoreViteCache(cacheFs, workdir, files);
      }
    } catch {
      /*
       * A cache must never be able to stop a project from starting. Every branch above is an
       * optimization whose worst case is the behaviour we already had.
       */
    }
  };

  /**
   * Capture the dep cache once Vite has finished optimizing.
   *
   * Watches for the sentinel rather than firing on server-ready: the dev server is up long before
   * the first request triggers optimization, so capturing then would store a half-written directory.
   */
  let captureStarted = false;

  const captureViteCacheWhenReady = () => {
    if (captureStarted) {
      return;
    }

    captureStarted = true;

    void (async () => {
      const deadline = Date.now() + captureTimeoutMs;

      try {
        while (Date.now() < deadline) {
          if (await pathExists(cacheFs, abs(VITE_CACHE_SENTINEL))) {
            const key = await cacheKey();
            const store = key ? await openViteCache() : undefined;

            if (!store || !key) {
              return;
            }

            const files = await captureViteCache(cacheFs, workdir);

            if (files && totalBytes(files) <= VITE_CACHE_MAX_BYTES) {
              await store.put(key, files);
            }

            return;
          }

          await new Promise((resolve) => setTimeout(resolve, capturePollMs));
        }
      } catch {
        // As above: no speed-up next time is the whole cost.
      }
    })();
  };

  options.onServerReady(() => captureViteCacheWhenReady());

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
        return createShellProcess(client, workdir, spawnOptions.terminal, ensureViteCacheRestored);
      }

      await ensureViteCacheRestored();

      const env = spawnOptions.env
        ? Object.fromEntries(Object.entries(spawnOptions.env).map(([k, v]) => [k, String(v)]))
        : undefined;

      return adaptProcess(
        await client.spawn(command, args, { cwd: spawnOptions.cwd ? abs(spawnOptions.cwd) : workdir, env }),
      );
    },

    /**
     * Bridge Nodepod's `fs.watch` (coarse, content-free, unfiltered) onto `watchPaths`.
     *
     * Three impedance mismatches, each of which failed SILENTLY in the first version:
     *
     *   - the event vocabulary is Node's `'rename' | 'change'`, and `rename` means created OR
     *     deleted. Mapping it to `update_directory` — which `FilesStore` has no case for — dropped
     *     every event and left the map empty (see {@link classifyWatchEvent});
     *   - the events carry no content, and `FilesStore` builds its entry from `buffer`, so an
     *     unenriched event records the file as EMPTY — the CodeSandbox adapter's `startWatch` carries
     *     the same warning for the same reason;
     *   - Nodepod's watcher takes no excludes, so `options.exclude` must be applied HERE or
     *     `node_modules` floods the map (see {@link isNodepodWatchExcluded}).
     *
     * Classification is serialised through one chain because it is async and ORDER IS MEANING: a
     * recursive delete arrives children-first (MEASURED), and `add_dir` must precede the files inside
     * it. Concurrent `stat`/`readFile` would interleave those and leave ghosts in the map.
     */
    watchPaths(watchOptions: SandboxWatchOptions, callback: (events: SandboxWatchEvent[]) => void) {
      let disposed = false;
      const knownFiles = new Set<string>();
      const knownDirs = new Set<string>();
      let chain: Promise<void> = Promise.resolve();

      const classify = async (nodepodEvent: string, relPath: string) => {
        const path = abs(relPath);

        let state = { exists: false, isDirectory: false };

        try {
          state = { exists: true, isDirectory: isDirectory(await client.fs.stat(path)) };
        } catch {
          /* ENOENT — the path is gone. That is the answer, not an error. */
        }

        const type = classifyWatchEvent(nodepodEvent, state, {
          knownFile: knownFiles.has(path),
          knownDir: knownDirs.has(path),
        });

        let buffer: Uint8Array | undefined;

        if (watchOptions.includeContent && (type === 'add_file' || type === 'change')) {
          try {
            buffer = await client.fs.readFile(path);
          } catch {
            /*
             * Deleted between the stat and the read. Reporting it with no buffer would record an
             * EMPTY file — the exact corruption this enrichment exists to prevent — so drop the
             * event and let the removal that is already on its way speak for it.
             */
            return;
          }
        }

        switch (type) {
          case 'add_dir':
            knownDirs.add(path);
            break;
          case 'add_file':
          case 'change':
            knownFiles.add(path);
            break;
          default:
            knownFiles.delete(path);
            knownDirs.delete(path);
        }

        if (!disposed) {
          callback([{ type, path, buffer }]);
        }
      };

      const handle = client.fs.watch(workdir, { recursive: true }, (event, filename) => {
        if (!filename || disposed) {
          return;
        }

        const relPath = filename.startsWith('/') ? toRelPath(workdir, filename) : filename;

        if (isNodepodWatchExcluded(relPath, watchOptions.exclude)) {
          return;
        }

        chain = chain.then(() => classify(event, relPath)).catch(() => {});
      });

      return () => {
        disposed = true;
        handle.close();
      };
    },

    /**
     * Project-wide text search, walked over the VFS.
     *
     * 🔴 **Implemented here rather than shelled out to the runtime's `grep -r`, for three reasons
     * that each produce a wrong answer rather than a slow one.** (1) Nodepod's `grep` writes ANSI
     * colour codes unconditionally — no `--color=never` — so every result would have to be
     * un-highlighted before its columns could be read, and the columns are what the panel uses to
     * position the match. (2) Its recursive walk honours no excludes, so it would descend
     * `node_modules`: tens of thousands of files, in memory, on every debounced keystroke. (3) A
     * shell round trip returns TEXT, and the seam's contract is structured ranges — parsing
     * `path:line:content` back apart breaks on any path or match containing a colon. The VFS is in
     * this tab's memory; reading it directly is both the simplest and the fastest option.
     *
     * Results stream through `onProgress` per file so the panel fills in as the walk proceeds, which
     * is the contract WebContainer's `internal.textSearch` already had.
     */
    async textSearch(query: string, searchOptions: SandboxTextSearchOptions, onProgress: SandboxTextSearchProgress) {
      const regex = buildSearchRegExp(query, searchOptions);

      if (!regex) {
        return;
      }

      let filesRead = 0;
      let resultsLeft = searchOptions.resultLimit > 0 ? searchOptions.resultLimit : Infinity;

      const walk = async (relDir: string): Promise<void> => {
        if (resultsLeft <= 0 || filesRead >= SEARCH_FILE_LIMIT) {
          return;
        }

        let entries: string[] = [];

        try {
          entries = await client.fs.readdir(abs(relDir));
        } catch {
          // A directory that vanished mid-walk is not an error; there is simply nothing in it.
          return;
        }

        for (const name of entries) {
          if (resultsLeft <= 0 || filesRead >= SEARCH_FILE_LIMIT) {
            return;
          }

          const rel = relDir ? `${relDir}/${name}` : name;

          let directory = false;

          try {
            directory = isDirectory(await client.fs.stat(abs(rel)));
          } catch {
            continue;
          }

          if (directory) {
            /*
             * The exclude globs are applied to the DIRECTORY too, not only to files. Checking them
             * only at the leaf still reads every file in `node_modules` before discarding it, which
             * is the entire cost this search is trying not to pay.
             */
            if (isSearchCandidate(`${rel}/`, { includes: [], excludes: searchOptions.excludes })) {
              await walk(rel);
            }

            continue;
          }

          if (!isSearchCandidate(rel, searchOptions)) {
            continue;
          }

          let bytes: Uint8Array;

          try {
            bytes = await client.fs.readFile(abs(rel));
          } catch {
            continue;
          }

          filesRead += 1;

          if (looksBinary(bytes)) {
            continue;
          }

          const matches = findTextMatches(new TextDecoder().decode(bytes), regex, resultsLeft);

          if (matches.length > 0) {
            resultsLeft -= matches.length;

            // Absolute: `Search.tsx` hands the path straight to `workbenchStore.setSelectedFile`.
            onProgress(abs(rel), matches);
          }
        }
      };

      await walk('');
    },

    onServerReady: options.onServerReady,

    onPort(listener) {
      // Nodepod reports readiness only; a close event has no source, so never invent one.
      return options.onServerReady((port, url) => listener(port, 'open', url));
    },

    teardown: () => client.teardown(),
  };
}
