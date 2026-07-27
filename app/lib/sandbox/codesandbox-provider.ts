/**
 * The CodeSandbox implementation of {@link SandboxProvider} (SPEC §8, `spec/sandbox-codesandbox.md`).
 *
 * The second provider — the thing that turns §8's escape hatch from a paragraph into a fact, and the
 * reason `spec/licensing.md`'s StackBlitz gate stops being able to block a launch.
 *
 * Like `webcontainer-provider.ts`, this is the ONLY module allowed to import its vendor, and
 * `sandbox-seam.spec.ts` enforces that as a default-deny source scan for BOTH vendors. Everything
 * that can be a pure function lives in `codesandbox-translate.ts` and is tested there; what is left
 * here is the part that genuinely needs a live client.
 *
 * ## It takes a connected client, never an API key
 *
 * `CODESANDBOX_API_KEY` is a platform secret and never reaches a browser (§5). The server creates or
 * resumes the sandbox and mints a scoped `SandboxSession`; the browser calls `connectToSandbox` with
 * that session and hands the resulting `SandboxClient` here. This module therefore knows nothing
 * about credentials, which is also what makes it testable with a double.
 *
 * ## The four places this provider differs from WebContainer, all measured
 *
 * 1. **`fs` is a network round trip.** WebContainer's filesystem is in-process; this one is not, and
 *    `FilesStore.refreshFiles()` walks the whole tree. The free plan allows 3,600 requests/hour, so
 *    this is a budget, not a free call — see the note on {@link createCodeSandboxProvider}.
 * 2. **Watch events carry no content and no file/directory flag**, so this adapter fetches what
 *    WebContainer supplied for free. That is the single biggest source of extra requests.
 * 3. **`mount` is genuinely byte-safe here.** WebContainer's `mount` destroys binaries through a
 *    `TextDecoder('latin1')`; `batchWrite` takes `Uint8Array` directly, so the out-of-band binary
 *    dance that `~/lib/registry/mount-tree.ts` describes is not needed on this provider.
 * 4. **`textSearch` does not exist.** Declared `false` rather than shimmed with `grep`, because a
 *    capability flag is a contract and a slow lie is worse than an honest "not supported".
 */
import type { SandboxClient } from '@codesandbox/sdk/browser';
import { brand } from '~/config/brand';
import {
  flattenMountTree,
  needsContent,
  resolveInWorkdir,
  toShellCommand,
  toWorkspaceRelative,
  translateWatchEvent,
  type CodeSandboxWatchEvent,
} from './codesandbox-translate';
import type {
  SandboxCapabilities,
  SandboxDirent,
  SandboxFileSystem,
  SandboxFileTree,
  SandboxProcess,
  SandboxProvider,
  SandboxSpawnOptions,
  SandboxWatchEvent,
  SandboxWatchOptions,
} from './types';

/**
 * What a server-backed microVM can and cannot do.
 *
 * `terminal` is true — CodeSandbox gives a real PTY, which is strictly better than WebContainer's
 * `/bin/jsh` shim. `watch` is true because incremental events DO arrive; the missing content is
 * refilled by this adapter rather than being a reason to make callers poll. `textSearch` is false:
 * there is no ripgrep-class API, and `Search.tsx` already reads the flag instead of probing.
 */
export const CODESANDBOX_CAPABILITIES: SandboxCapabilities = {
  terminal: true,
  textSearch: false,
  watch: true,
};

/**
 * The bash snippet that makes a plain shell speak `BoltShell`'s OSC protocol.
 *
 * `$?` is captured into `__bolt_c` FIRST — the `printf` that reports the status would otherwise
 * overwrite the very status being reported. Escapes are `\033`/`\007` so BASH's printf produces the
 * control bytes; a JavaScript `\x1b` here would be substituted a step too early.
 */
const OSC_BASHRC = `
# --- ${brand.productName}: OSC protocol for the agent's shell (do not edit) ---
__bolt_osc() {
  __bolt_c=$?
  printf "\\033]654;exit=0:%s\\007" "$__bolt_c"
  printf "\\033]654;prompt\\007"
}
PROMPT_COMMAND=__bolt_osc
# --- end ---
`;

const OSC_BASHRC_MARKER = '__bolt_osc()';

/** The shells `terminals.create` can start natively — anything else has to be typed into one. */
const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish', 'ksh', 'dash'] as const;

type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

/** `'bash'` and `'/bin/bash'` are the same request; a leading path must not defeat the match. */
function asSupportedShell(command: string): SupportedShell | undefined {
  const name = command.split('/').pop() ?? command;

  return SUPPORTED_SHELLS.find((shell) => shell === name);
}

export interface CodeSandboxProviderOptions {
  /**
   * Called by {@link SandboxProvider.teardown}. Reaping is a SERVER concern — only the server holds
   * the API key that can hibernate or delete a VM — so this provider cannot reap itself, and a
   * no-op default would silently bill for every sandbox the app thought it had torn down.
   */
  onTeardown?: () => void;

  /**
   * Turn `(port, host)` into a URL an iframe can render.
   *
   * 🔴 A project sandbox is PRIVATE, so `https://<host>` alone answers **401** — the preview needs a
   * `?preview_token=` minted by the server (`codesandbox-boot.mintPreviewUrl`). Injected rather than
   * imported so this module stays testable with a double and free of route knowledge. Absent (tests),
   * the bare host URL is used.
   */
  previewUrl?: (port: number, host: string) => Promise<string>;

  /**
   * Whether the boot that produced `client` brought back the previous session's filesystem —
   * `bootupPreservedFilesystem(bootupType)`, supplied by the boot module because only it sees the
   * session response. Defaults to `false`, the direction that at worst re-restores a copy rather
   * than trusting a disk that might be template state.
   */
  bootRestoredFilesystem?: boolean;
}

export function createCodeSandboxProvider(
  client: SandboxClient,
  options: CodeSandboxProviderOptions = {},
): SandboxProvider {
  /*
   * MEASURED `/project/workspace`, NOT `/home/project`. `WORK_DIR` is a client constant baked into
   * prompts and opaque-file rules, so the two disagree until that constant is derived from the
   * provider — flagged in `spec/sandbox-codesandbox.md` §5c. A getter for the same reason the
   * WebContainer adapter uses one: snapshotting it is correct today and wrong for any provider whose
   * sandbox moves.
   */
  const workdir = () => client.workspacePath;

  const abs = (path: string) => resolveInWorkdir(workdir(), path);

  async function readFile(path: string, encoding?: null): Promise<Uint8Array>;
  async function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  async function readFile(path: string, encoding?: BufferEncoding | null): Promise<Uint8Array | string> {
    /*
     * The overload pair is the binary contract (`spec/binary-files.md`): no encoding means BYTES.
     * `readFile` returns a `Uint8Array` straight from the SDK — unlike Cloudflare's provider there is
     * no base64 hop in either direction, so byte identity holds without an encoding step to get wrong.
     */
    return encoding ? client.fs.readTextFile(abs(path)) : client.fs.readFile(abs(path));
  }

  async function readdir(
    path: string,
    options?: { encoding?: BufferEncoding | null; withFileTypes?: false } | BufferEncoding | null,
  ): Promise<string[]>;
  async function readdir(
    path: string,
    options: { encoding?: BufferEncoding | null; withFileTypes: true },
  ): Promise<SandboxDirent[]>;
  async function readdir(path: string, options?: unknown): Promise<string[] | SandboxDirent[]> {
    const entries = await client.fs.readdir(abs(path));

    if (typeof options === 'object' && options !== null && (options as { withFileTypes?: boolean }).withFileTypes) {
      return entries.map((entry) => ({
        name: entry.name,
        isFile: () => entry.type === 'file',
        isDirectory: () => entry.type === 'directory',
      }));
    }

    return entries.map((entry) => entry.name);
  }

  async function mkdir(path: string, options?: { recursive?: false }): Promise<void>;
  async function mkdir(path: string, options: { recursive: true }): Promise<string>;
  async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void | string> {
    await client.fs.mkdir(abs(path), options?.recursive ?? false);

    // The overload contract mirrors `node:fs`: the recursive form answers with the path it created.
    return options?.recursive ? path : undefined;
  }

  const fs: SandboxFileSystem = {
    readFile,
    readdir,
    mkdir,

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      if (typeof data === 'string') {
        await client.fs.writeTextFile(abs(path), data);
        return;
      }

      await client.fs.writeFile(abs(path), data);
    },

    async rm(path: string, opts?: { force?: boolean; recursive?: boolean }): Promise<void> {
      try {
        await client.fs.remove(abs(path), opts?.recursive ?? false);
      } catch (error) {
        // `force` means "absent is fine" — the same contract `node:fs` gives, and callers rely on it.
        if (!opts?.force) {
          throw error;
        }
      }
    },
  };

  return {
    capabilities: CODESANDBOX_CAPABILITIES,

    // See CodeSandboxProviderOptions — the boot module answers this from the session's bootupType.
    bootRestoredFilesystem: options.bootRestoredFilesystem ?? false,

    /**
     * A real PTY running plain `bash`, taught to speak the OSC protocol through `PROMPT_COMMAND`.
     *
     * bash runs `PROMPT_COMMAND` immediately before drawing each prompt — i.e. exactly once per
     * finished command — which is the same moment `jsh --osc` emits its markers. `$?` is captured
     * into `__bolt_c` FIRST, because the `printf` that reports it would otherwise overwrite the very
     * status being reported.
     *
     * The `exit=0:%s` shape matches the parser's regex, which reads the SECOND number as the exit
     * code (`/\x1b\]654;([^\x07=]+)=?((-?\d+):(\d+))?\x07/` → group 4). The leading `0` is jsh's
     * process field and is not read.
     *
     * 🔴 **It is installed through `~/.bashrc`, NOT through `env`, because the SDK cannot carry an
     * environment value containing a SPACE.** MEASURED by bisection: `PROMPT_COMMAND=true` starts
     * fine, `PROMPT_COMMAND='printf hi'` makes the shell die before `open()` with
     * `Shell with id … is not active` — an error naming a session rather than the cause. That is the
     * same unquoted-interpolation defect this adapter's own `spawn` had, one layer down and not ours
     * to fix, so the rc file routes around it: `fs.writeFile` involves no shell at all.
     *
     * `readyOsc` is deliberately ABSENT: bash sends no readiness escape, and waiting for one would
     * hang the terminal forever with no error. Omitting it selects the "ready on first output" path.
     */
    shell: { command: 'bash', args: [] },

    get workdir(): string {
      return workdir();
    },

    fs,

    async mount(tree: SandboxFileTree, mountOptions?: { mountPoint?: string }): Promise<void> {
      const root = mountOptions?.mountPoint ?? '';
      const files = flattenMountTree(tree).map((entry) => ({
        /*
         * 🔴 RELATIVE, not absolute. MEASURED: `batchWrite` with absolute paths fails with
         * "Unzip command failed with exit code 1" — it zips the entries and extracts against the
         * workspace root, so a leading `/project/workspace/` becomes a bogus zip entry. Every OTHER
         * fs method on this client takes an absolute path, which is exactly why this is easy to
         * get wrong and why it is pinned by a test.
         */
        path: toWorkspaceRelative(workdir(), root ? `${root}/${entry.path}` : entry.path),
        content: entry.content,
      }));

      if (files.length === 0) {
        /*
         * A tree of nothing but empty directories flattens to no entries, and `batchWrite([])` would
         * upload an empty archive. Mount is supposed to be atomic; doing nothing is the honest
         * outcome for a tree with no files in it.
         */
        return;
      }

      await client.fs.batchWrite(files);
    },

    async spawn(command: string, args: string[] = [], spawnOptions?: SandboxSpawnOptions): Promise<SandboxProcess> {
      /*
       * QUOTED, not joined. The seam is argv-shaped; `commands.run` takes a bash command line. A
       * plain join re-splits any argument containing a space and executes anything after a `;`.
       */
      const line = toShellCommand(command, args);
      const cwd = spawnOptions?.cwd ? abs(spawnOptions.cwd) : workdir();
      const env = spawnOptions?.env
        ? Object.fromEntries(Object.entries(spawnOptions.env).map(([k, v]) => [k, String(v)]))
        : undefined;

      /*
       * When the caller is asking for the interactive SHELL ITSELF (`spawn('bash')` from
       * `shell.ts`), let the SDK start it natively instead of typing its name into another shell.
       * `args` must be empty for that to be the same thing.
       */
      const native = args.length === 0 ? asSupportedShell(command) : undefined;

      return spawnOptions?.terminal
        ? spawnInteractive(client, line, { cwd, env }, spawnOptions.terminal, native)
        : spawnBackground(client, line, { cwd, env }, spawnOptions?.output !== false);
    },

    watchPaths(watchOptions: SandboxWatchOptions, callback: (events: SandboxWatchEvent[]) => void): () => void {
      return startWatch(client, workdir, watchOptions, callback);
    },

    onServerReady(listener: (port: number, url: string) => void): () => void {
      /*
       * MEASURED: the port event is the dev server becoming reachable, and `port.host` is already the
       * public preview hostname. Crossing this with `onPort` is the mutation the WebContainer
       * adapter's test guards against — it produces a preview that never appears, silently.
       *
       * The URL goes through `previewUrl` because the bare host 401s on a private sandbox — see
       * {@link CodeSandboxProviderOptions.previewUrl}.
       */
      const announce = (port: number, host: string) =>
        void toPreviewUrl(options, port, host).then((url) => listener(port, url));

      const disposable = client.ports.onDidPortOpen((port) => announce(port.port, port.host));

      /*
       * 🔴 Replay ports that are ALREADY open, because `onDidPortOpen` only reports transitions. A
       * reload while the dev server is still running — the most common way a builder tab comes back —
       * would otherwise register this listener after the only open event it will ever get, and the
       * workbench shows "No preview available" over a perfectly healthy server. WebContainer never
       * had this case (its runtime dies with the tab), which is exactly why nothing upstream handles it.
       */
      const cancelReplay = replayOpenPorts(client, announce);

      return () => {
        cancelReplay();
        disposable.dispose();
      };
    },

    onPort(listener: (port: number, type: 'open' | 'close', url: string) => void): () => void {
      const announce = (port: number, host: string) =>
        void toPreviewUrl(options, port, host).then((url) => listener(port, 'open', url));

      const open = client.ports.onDidPortOpen((port) => announce(port.port, port.host));

      /*
       * 🔴 The same already-open replay as `onServerReady`, and it is THIS one that fills the preview
       * list: `PreviewsStore.onPort` is what pushes entries into `previews` — `onServerReady` only
       * broadcasts. Replaying into one and not the other left the store empty after a reload while
       * the dev server was still running (MEASURED live), which renders as "No preview available".
       */
      const cancelReplay = replayOpenPorts(client, announce);

      /*
       * The close event carries only the port NUMBER, so there is no host to rebuild a URL from. An
       * empty string is honest: every caller uses the URL to show a preview, and there is nothing to
       * show for a port that just closed.
       */
      const close = client.ports.onDidPortClose((port) => listener(port, 'close', ''));

      return () => {
        cancelReplay();
        open.dispose();
        close.dispose();
      };
    },

    teardown(): void {
      /*
       * Deliberately NOT a no-op fallback. A server sandbox bills for whatever it does not reap, and
       * a provider that silently swallowed teardown would leak a VM per builder session with nothing
       * to show for it.
       */
      options.onTeardown?.();
    },
  };
}

/**
 * How long after registration the port list is asked a SECOND time.
 *
 * MEASURED live: immediately after `connectToSandbox` resolves, `ports.getAll()` answers `[]` even
 * while the VM has a dev server listening — the SDK's port state syncs asynchronously after the
 * socket opens. `PreviewsStore` registers its listener in that window, so a single replay at
 * registration time silently missed the running server and the workbench said "No preview
 * available" over a healthy port. The re-check runs once, after the state has had time to arrive.
 */
const PORT_REPLAY_RECHECK_MS = 3_000;

/**
 * Announce every already-open port, now and once more after the SDK's state sync settles.
 *
 * Deduped by port so a port present in both sweeps is announced once — the listener treats an
 * announcement as "a server became reachable", and PreviewsStore keys by port, so a duplicate is
 * harmless but noisy.
 */
function replayOpenPorts(client: SandboxClient, announce: (port: number, host: string) => void): () => void {
  const announced = new Set<number>();
  let cancelled = false;

  const sweep = () =>
    void client.ports
      .getAll()
      .then((open) => {
        if (cancelled) {
          return;
        }

        for (const port of open) {
          if (!announced.has(port.port)) {
            announced.add(port.port);
            announce(port.port, port.host);
          }
        }
      })
      .catch(() => {
        /* Enumeration is best-effort; a transition event will still arrive for a new server. */
      });

  sweep();

  const timer = setTimeout(sweep, PORT_REPLAY_RECHECK_MS);

  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/** The iframe-renderable URL for a port — minted when the option is present, bare host otherwise. */
async function toPreviewUrl(options: CodeSandboxProviderOptions, port: number, host: string): Promise<string> {
  if (!options.previewUrl) {
    return `https://${host}`;
  }

  try {
    return await options.previewUrl(port, host);
  } catch {
    return `https://${host}`;
  }
}

/**
 * A non-interactive process, via `commands.runBackground`.
 *
 * `Command` has no exit-code accessor and `waitUntilComplete()` resolves with OUTPUT, so the code is
 * recovered from the `CommandError` it throws on failure. `0`/`1` is a real narrowing of fidelity
 * versus WebContainer — callers that branch on a specific non-zero code would need more, and none do
 * today (they check `exit === 0`).
 */
async function spawnBackground(
  client: SandboxClient,
  line: string,
  opts: { cwd: string; env?: Record<string, string> },
  wantOutput: boolean,
): Promise<SandboxProcess> {
  const command = await client.commands.runBackground(line, opts);

  let push: ((chunk: string) => void) | undefined;
  let close: (() => void) | undefined;

  const output = new ReadableStream<string>({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk);

      close = () => {
        try {
          controller.close();
        } catch {
          // Already closed — a second close throws and there is nothing to report.
        }
      };
    },
  });

  if (wantOutput) {
    command.onOutput((chunk) => push?.(chunk));
  }

  const exit = command
    .waitUntilComplete()
    .then(() => 0)
    .catch((error: unknown) => (error as { exitCode?: number })?.exitCode ?? 1)
    .then((code) => {
      close?.();
      return code;
    });

  return {
    exit,
    output,

    /* No stdin on a background command — writes are dropped rather than silently buffered forever. */
    input: new WritableStream<string>(),

    kill: () => void command.kill(),

    /* Nothing to resize: a background command has no terminal attached. */
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    resize: () => {},
  };
}

/**
 * An interactive process, via a real PTY (`terminals.create`).
 *
 * This is the path `shell.ts` needs. It is genuinely better than WebContainer's — a real terminal
 * rather than `/bin/jsh` with OSC-sequence parsing — but the shim in `shell.ts` is written against
 * those escape sequences today, so switching providers means simplifying it, not deleting it.
 */
async function spawnInteractive(
  client: SandboxClient,
  line: string,
  opts: { cwd: string; env?: Record<string, string> },
  dimensions: { cols: number; rows: number },
  shellName?: SupportedShell,
): Promise<SandboxProcess> {
  /*
   * 🔴 `terminals.create(name)` IS the shell — do not then `run` that same shell inside it.
   *
   * The first version created a bash terminal and immediately ran `bash` in it. The nested shell
   * exited straight away and every subsequent call failed with
   * `Shell with id … is not active` — an error that names a session, not the mistake. So when the
   * caller asked for a shell the SDK can start natively, start it natively and run nothing;
   * anything else gets a bash terminal with the command typed into it.
   */
  await ensureOscBashrc(client);

  const terminal = await client.terminals.create(shellName ?? 'bash', opts);

  let size = dimensions;
  let push: ((chunk: string) => void) | undefined;

  const output = new ReadableStream<string>({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk);
    },
  });

  terminal.onOutput((chunk) => push?.(chunk));

  // `open` both attaches at the requested size and replays what the shell has already printed.
  const backlog = await terminal.open(size);

  if (backlog) {
    push?.(backlog);
  }

  if (!shellName) {
    await terminal.run(line, size);
  }

  const input = new WritableStream<string>({
    write: async (chunk) => {
      await terminal.write(chunk, size);
    },
  });

  return {
    /*
     * A PTY does not report an exit code — the shell outlives any single command. This never
     * resolving matches WebContainer's interactive shell, whose process also lives until killed.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    exit: new Promise<number>(() => {}),
    input,
    output,
    kill: () => void terminal.kill(),

    /*
     * The SDK carries size on each write rather than exposing a resize call, so a resize between
     * keystrokes is recorded and applied on the next one. Storing it is what makes that work; a
     * no-op here would leave the PTY at its original size forever.
     */
    resize: (next) => {
      size = next;
    },
  };
}

/**
 * Make sure `~/.bashrc` installs the OSC hook, exactly once.
 *
 * Idempotent via a marker rather than by overwriting: `.bashrc` belongs to the sandbox image and may
 * carry setup the project needs, so appending is the only safe edit. Appending WITHOUT the marker
 * check would grow the file by one block per terminal opened.
 *
 * Best-effort: a failure here costs the OSC protocol (agent shell actions stop reporting completion),
 * which is bad — but throwing would cost the terminal entirely, which is worse, and the user can
 * still see and drive the shell by hand. Logged rather than swallowed.
 */
async function ensureOscBashrc(client: SandboxClient): Promise<void> {
  const path = '/root/.bashrc';

  try {
    let current = '';

    try {
      current = await client.fs.readTextFile(path);
    } catch {
      // No `.bashrc` yet — creating one is fine.
    }

    if (current.includes(OSC_BASHRC_MARKER)) {
      return;
    }

    await client.fs.writeTextFile(path, `${current}${OSC_BASHRC}`);
  } catch (error) {
    console.warn('[codesandbox] could not install the OSC shell hook:', (error as Error)?.message);
  }
}

/**
 * Bridge `fs.watch` (async, content-free) onto `watchPaths` (sync-returning, content-carrying).
 *
 * Two impedance mismatches at once, and both fail quietly if fudged:
 *
 *   - the seam returns an unsubscribe function SYNCHRONOUSLY while `fs.watch` is a promise, so a
 *     caller that unsubscribes immediately must still cancel the watcher that has not arrived yet.
 *     `disposed` is the latch for exactly that;
 *   - the events carry no content, and `FilesStore` builds its entry from `buffer`, so an
 *     unenriched `change` event records the file as EMPTY. The read below is what stops a
 *     generation's output from appearing as a tree full of blank files.
 */
function startWatch(
  client: SandboxClient,
  workdir: () => string,
  options: SandboxWatchOptions,
  callback: (events: SandboxWatchEvent[]) => void,
): () => void {
  let disposed = false;
  let watcher: { dispose(): void } | undefined;

  void (async () => {
    try {
      const created = await client.fs.watch(workdir(), {
        recursive: true,
        excludes: options.exclude,
      });

      if (disposed) {
        created.dispose();
        return;
      }

      watcher = created;

      created.onEvent(async (event: CodeSandboxWatchEvent) => {
        const enriched = new Map<string, { isDirectory: boolean; buffer?: Uint8Array }>();

        if (options.includeContent && needsContent(event)) {
          await Promise.all(
            event.paths.map(async (path) => {
              try {
                enriched.set(path, { isDirectory: false, buffer: await client.fs.readFile(path) });
              } catch {
                /*
                 * A read fails for two reasons that look identical from here: the path is a
                 * directory, or it was deleted between the event and the read. Both are reported as
                 * a directory event, which `FilesStore` treats as structural rather than writing an
                 * empty file entry — the failure direction that loses content.
                 */
                enriched.set(path, { isDirectory: true });
              }
            }),
          );
        }

        if (!disposed) {
          callback(translateWatchEvent(event, (path) => enriched.get(path)));
        }
      });
    } catch {
      /* A watch that cannot start must not take the session down; callers fall back to refreshFiles(). */
    }
  })();

  return () => {
    disposed = true;
    watcher?.dispose();
  };
}
