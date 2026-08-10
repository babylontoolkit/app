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
  clearPortScript,
  flattenMountTree,
  isMissingPathError,
  needsContent,
  normalizeWatchEventPaths,
  readFileErrorEnvelope,
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
  SandboxPreviewUrl,
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
 * `clearPort` is true because it is this provider that NEEDS it: a resumed/forked VM wakes with the
 * previous session's dev server still bound to its port (see `clearPortScript`).
 */
export const CODESANDBOX_CAPABILITIES: SandboxCapabilities = {
  terminal: true,
  textSearch: false,
  watch: true,
  clearPort: true,

  /** A real Linux microVM: `.node` addons load normally, so rolldown finds its native binding. */
  nativeAddons: true,

  /*
   * Not implemented here. The vendor serves previews from its own host and exposes no hook to inject
   * a script into the served document, so the dev-tools channel (`lib/preview/protocol.ts`) has no way
   * in — the game-side half has to be IN the page before the game's own code runs. Declared false so
   * the panel says "not supported on this provider" rather than silently reporting a healthy game.
   */
  previewScript: false,
};

/**
 * Upper bound on {@link SandboxProvider.clearPort}. The script self-bounds at ~6s (its TERM-wait
 * loop plus the KILL grace); this covers the wire hanging UNDER it — a Pitcher call that never
 * answers must not hang project creation, whose worst case without the clear was the collision
 * this exists to prevent.
 */
const CLEAR_PORT_TIMEOUT_MS = 10_000;

/**
 * The bash snippet that makes a plain shell speak `BoltShell`'s OSC protocol.
 *
 * `$?` is captured into `__bolt_c` FIRST — the `printf` that reports the status would otherwise
 * overwrite the very status being reported. Escapes are `\033`/`\007` so BASH's printf produces the
 * control bytes; a JavaScript `\x1b` here would be substituted a step too early.
 *
 * 🔴 **`PS0` is the half that makes the protocol ATTRIBUTABLE, and removing it kills `npm install`
 * on every creation (MEASURED live, 2026-07-27).** `PROMPT_COMMAND` fires on EVERY prompt draw —
 * including the initial one at attach, which jsh never marks — so a fresh bash buffers one or two
 * `exit`+`prompt` pairs that nothing consumes. `executeCommand`'s exit-wait then resolves against
 * the PREVIOUS command's markers: the creation's `npm install` "completed" instantly with a stale
 * exit 0, the chain moved on to `npm run dev`, whose leading interrupt **killed the still-running
 * install** — and the start action then "failed" (stale 130) over a dev server that was actually
 * up. `PS0` is expanded by bash after READING a command and before RUNNING it — never on a prompt
 * redraw — so it is an in-band "command started" marker: `shell.ts` ignores every exit marker that
 * arrives before it (`beginOsc`). In-band beats arrival-time gating because a stale marker can be
 * in flight across the network at the moment the command is typed.
 *
 * `BROWSER=true` (the no-op binary): the starter's dev script asks vite to open a browser, and
 * inside a headless VM that spawns `xdg-open`, which does not exist — every `npm run dev` printed
 * `Error: spawn xdg-open ENOENT` into the user's terminal over a perfectly healthy server.
 */
const OSC_BASHRC = `
# --- ${brand.productName}: OSC protocol for the agent's shell v2 (do not edit) ---
__bolt_osc() {
  __bolt_c=$?
  printf "\\033]654;exit=0:%s\\007" "$__bolt_c"
  printf "\\033]654;prompt\\007"
}
PROMPT_COMMAND=__bolt_osc
PS0='\\e]654;begin\\a'
export BROWSER=true
# --- end ---
`;

/**
 * VERSIONED: the presence check must name something only the CURRENT block contains, because the
 * sandboxes this matters most on are the ones that already carry an older block — a v1 marker would
 * skip the append exactly where the fix is needed. Old blocks are left in place (appending is the
 * only safe edit to a file the image owns); bash takes the LAST assignment, so the newest block wins.
 */
const OSC_BASHRC_MARKER = "PS0='\\e]654;begin";

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
   * the API key that can hibernate or delete a VM — so this provider cannot reap itself.
   *
   * ⚠️ **Nothing injects this today, and nothing calls `teardown()` either** — the seam's composition
   * in `~/lib/sandbox/index.ts` omits it, so `teardown()` is genuinely a no-op on this provider. That
   * is stated here rather than implied away: an earlier version of this comment claimed a no-op
   * "would silently bill", which reads as a guarantee that the hook is wired. It is not — a false
   * claim in a comment is how the shell-strip defect survived review.
   *
   * What actually stops an abandoned VM from billing forever is server-side and does not need this
   * hook: `hibernationTimeoutSeconds` is set at every creation (the VM puts itself to sleep), and a
   * project delete reaps the VM outright (`DELETE /api/projects/:id` → `deleteSandbox`). Wiring a
   * client-triggered reap would need its own authenticated route; until one exists, leaving the hook
   * un-injected is the honest state, not an oversight.
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
   * Re-mint (or return the still-fresh) URL for a port already seen open — backs
   * {@link SandboxProvider.refreshPreviewUrl}.
   *
   * Absent (tests, or a boot that predates it) the provider reports no `refreshPreviewUrl` at all,
   * which the store reads as "these URLs do not expire" and schedules nothing. That is the same
   * shape as the WebContainer answer, so an unwired option degrades to today's behaviour rather
   * than to a timer firing against a function that cannot mint.
   */
  previewUrlForPort?: (port: number) => Promise<SandboxPreviewUrl | undefined>;

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

  /**
   * Does the shell this session actually talks to emit the `begin` marker?
   *
   * 🔴 **Decided by the FIRST terminal spawn and never changed** — because `.bashrc` is read when a
   * shell STARTS, so the hook is a fact about a running process, not about the disk. Letting a later
   * spawn's success flip this to `true` would re-arm the waits of the bash that is ALREADY running
   * without one: every subsequent shell action on it waits forever for a marker that process will
   * never emit. That is the exact "a warning becomes a permanent silent hang" failure this degrade
   * exists to prevent, walking back in through the door marked recovery.
   *
   * The rc write itself stays idempotent and keeps running for later terminals — only the CLAIM is
   * frozen, and it is frozen in the safe direction: at worst this session runs unarmed (pre-hook jsh
   * semantics, where a stale marker can mis-report a status) rather than hanging.
   */
  let oscHookInstalled = false;
  let oscHookDecided = false;

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
        /*
         * `force` means "absent is fine" — the same contract `node:fs` gives, and callers rely on it.
         * It does NOT mean "any failure is fine": swallowing a permission or connection error reports
         * a delete that did not happen, so the map drops the entry while the disk keeps the file and
         * the divergence resurfaces in an export or a push. See `isMissingPathError`.
         */
        if (!opts?.force || !isMissingPathError(error)) {
          throw error;
        }
      }
    },
  };

  /*
   * Present ONLY when the boot supplied a minter. The seam reads the METHOD's presence as "these URLs
   * expire" (`SandboxProvider.refreshPreviewUrl`), so declaring it unconditionally would tell the
   * store to keep asking a provider that can never answer — the honest shape is the same one
   * WebContainer has: absent.
   */
  const refreshPreviewUrl = options.previewUrlForPort
    ? { refreshPreviewUrl: (port: number) => options.previewUrlForPort!(port) }
    : {};

  return {
    capabilities: CODESANDBOX_CAPABILITIES,

    // See CodeSandboxProviderOptions — the boot module answers this from the session's bootupType.
    bootRestoredFilesystem: options.bootRestoredFilesystem ?? false,

    ...refreshPreviewUrl,

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
     *
     * `beginOsc` names the PS0 marker from `OSC_BASHRC` — see its doc for the stale-marker kill it
     * exists to prevent. It must match what the rc block emits, which the provider spec pins.
     *
     * 🔴 **A GETTER, because declaring it is a claim about the RUNNING SHELL.** The rc install is
     * best-effort (a non-root image, a transient fs error), and a shell that promises a `begin`
     * marker it will never emit makes every `waitTillOscCode` wait forever — one logged warning
     * turning into "every shell action hangs", permanently and silently.
     *
     * The value is whatever the FIRST terminal spawn established and is then frozen — see
     * `oscHookDecided`, which is the authoritative statement of the rule. A later successful install
     * therefore does NOT flip this to `'begin'`: `.bashrc` is read at shell start, so the bash already
     * running is still unhooked. `undefined` means pre-hook (jsh) semantics: stale markers become
     * possible again, and a command that finishes is still seen to finish.
     */
    shell: {
      command: 'bash',
      args: [],

      get beginOsc(): string | undefined {
        return oscHookInstalled ? 'begin' : undefined;
      },
    },

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

      if (!spawnOptions?.terminal) {
        return spawnBackground(client, line, { cwd, env }, spawnOptions?.output !== false);
      }

      /*
       * The rc install runs HERE rather than inside `spawnInteractive` so its answer is recorded:
       * `shell.beginOsc` is a claim about the shell we are about to start, and a shell that promises
       * a marker bash will never emit hangs every wait forever. The FIRST spawn decides for the
       * session — see `oscHookDecided`; a later spawn re-runs the (idempotent) install for its own
       * shell but must never re-arm the one already running unhooked.
       */
      const installed = await ensureOscBashrc(client);

      if (!oscHookDecided) {
        oscHookInstalled = installed;
        oscHookDecided = true;
      }

      return spawnInteractive(client, line, { cwd, env }, spawnOptions.terminal, native);
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

    async clearPort(port: number): Promise<void> {
      /*
       * Through `commands.runBackground` like any other spawn — the script does the killing and the
       * bounded wait-for-release (see `clearPortScript` for why both halves exist). The race is the
       * provider's deadline promise from the seam contract: resolve, never hang the caller, even if
       * the wire does.
       */
      const process = await spawnBackground(
        client,
        toShellCommand('sh', ['-c', clearPortScript(port)]),
        { cwd: workdir() },
        false,
      );

      await Promise.race([process.exit, new Promise((resolve) => setTimeout(resolve, CLEAR_PORT_TIMEOUT_MS))]);
    },

    teardown(): void {
      /*
       * A no-op unless a caller injects `onTeardown` — see that option's doc comment for why that is
       * the current, deliberate state and what reaps a VM instead (provider-side hibernation timeout;
       * `deleteSandbox` on project delete).
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

  /*
   * `open()` subscribes this client to the command's shell and returns whatever it has already
   * printed. `onOutput` alone misses everything emitted between `runBackground` resolving and the
   * listener being attached — small for `echo`, and exactly the first lines of a build, which is where
   * a build error lives.
   *
   * ⚠️ Best-effort ON PURPOSE, and the failure is normal: a command that finished in that same window
   * answers `Shell with id … is not active` (MEASURED). `waitUntilComplete()` still resolves correctly
   * for it, so an open() failure must never become a failed build.
   *
   * ⚠️ This is NOT what fixed the hanging Share — measured 2026-07-31, `runBackground` +
   * `waitUntilComplete` settles fine without it on a warm VM. The hang (no output, `RUNNING` forever,
   * reproduced twice on a freshly-resumed VM) is vendor-side and is handled where it does damage, by
   * `build-stall.ts`. Do not read this call as a guarantee that a background command will ever finish.
   */
  const buffered = await Promise.resolve(command.open?.()).catch(() => undefined);

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
    /*
     * Whatever the command printed before we subscribed comes back from `open()`. Replaying it first
     * keeps the build log complete — a failed build's error message is usually in the first bytes,
     * and reporting "the project failed to build" with an empty log is the failure this whole path
     * exists to explain.
     */
    if (buffered) {
      push?.(buffered);
    }

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
 * The shell's home directory, asked for ONCE per connected client.
 *
 * The rc path used to be hardcoded `/root/.bashrc`. That is right for today's image and silently
 * wrong for any image whose terminal user is not root: the append lands in a file bash never reads,
 * the hook is never installed, and — before this change — the provider still declared `beginOsc`, so
 * every shell action waited forever for a marker that could not arrive.
 */
const homeDirs = new WeakMap<SandboxClient, Promise<{ path: string; resolved: boolean }>>();

function shellHomeDir(client: SandboxClient): Promise<{ path: string; resolved: boolean }> {
  let pending = homeDirs.get(client);

  if (!pending) {
    /*
     * Every failure mode lands on `/root`: a rejected command, an empty answer, and — the reason for
     * the try — an SDK or a test double with no `commands.run` at all, which throws SYNCHRONOUSLY and
     * would otherwise escape a `.catch()`. Asking where HOME is must never be the thing that stops a
     * terminal from opening.
     *
     * 🔴 But `resolved` is reported separately, because a GUESSED home is not a known one. On an
     * image whose shell user is not root, writing the hook to `/root/.bashrc` "succeeds" against a
     * file bash never reads — and declaring `beginOsc` off that success is the promise-a-marker hang
     * all over again. An unresolved home therefore installs anyway (harmless, possibly right) and
     * declines to make the claim.
     */
    const fallback = { path: '/root', resolved: false };

    try {
      pending = client.commands
        .run('printf %s "$HOME"')
        .then((out) => (out.trim() ? { path: out.trim(), resolved: true } : fallback))
        .catch(() => fallback);
    } catch {
      pending = Promise.resolve(fallback);
    }

    homeDirs.set(client, pending);
  }

  return pending;
}

/**
 * Make sure `~/.bashrc` installs the CURRENT OSC hook, exactly once per version.
 *
 * Idempotent via a VERSIONED marker rather than by overwriting: `.bashrc` belongs to the sandbox
 * image and may carry setup the project needs, so appending is the only safe edit. The marker names
 * something only the newest block contains (`OSC_BASHRC_MARKER`), because the sandboxes that most
 * need an upgraded block are precisely the ones that already carry an old one — a version-blind
 * marker would skip the append exactly there. Old blocks stay behind; bash takes the last
 * assignment, so the newest wins. Appending WITHOUT the check would grow the file per terminal.
 *
 * Best-effort: a failure here costs the OSC protocol (agent shell actions stop reporting completion),
 * which is bad — but throwing would cost the terminal entirely, which is worse, and the user can
 * still see and drive the shell by hand. Logged rather than swallowed.
 *
 * 🔴 **It ANSWERS, and the answer is load-bearing.** A `void` return plus a warn was the whole bug:
 * the provider declared `beginOsc` unconditionally, so a failed install turned "the OSC hook is
 * missing" into "every shell action waits forever for a `begin` marker bash will never emit" — a
 * logged warning converting into a silent, permanent hang. The caller degrades on `false` to the
 * pre-hook semantics (no arming), which is strictly worse than arming and strictly better than
 * hanging.
 */
async function ensureOscBashrc(client: SandboxClient): Promise<boolean> {
  const home = await shellHomeDir(client);
  const path = `${home.path}/.bashrc`;

  try {
    let current = '';

    try {
      current = await client.fs.readTextFile(path);
    } catch {
      // No `.bashrc` yet — creating one is fine.
    }

    if (current.includes(OSC_BASHRC_MARKER)) {
      return home.resolved;
    }

    await client.fs.writeTextFile(path, `${current}${OSC_BASHRC}`);

    /*
     * A write that landed in a GUESSED home is not evidence the shell will read it — see
     * `shellHomeDir`. The block is installed either way; only the claim is withheld.
     */
    return home.resolved;
  } catch (error) {
    console.warn('[codesandbox] could not install the OSC shell hook:', (error as Error)?.message);

    return false;
  }
}

/**
 * Is this watched path a file (and what are its bytes), or a directory?
 *
 * 🔴 **A read that SUCCEEDS is not proof of a file on this provider** — see
 * {@link readFileErrorEnvelope}. `client.fs.readFile` on a directory resolves with the SDK's error
 * envelope as content, so the previous version of this code (a bare `try`/`catch` around the read)
 * recorded every directory a generation created as a 117-byte JSON file. That broke GitHub sync
 * outright: git refuses a tree holding a blob at `public/assets` alongside `public/assets/generated/…`,
 * so the repo was created and not one file landed (`GitRPC::BadObjectState`, live 2026-07-30).
 *
 * The fast path is unchanged and still ONE round trip — `fs` is a network call here and the 3,600/hr
 * budget is real, so an unconditional `stat` on every add/change would double the cost of a
 * generation's writes. `stat` runs only when the bytes LOOK like an envelope, which is a directory
 * event or (vanishingly) a real file whose whole content is that JSON. Confirming rather than
 * trusting the sniff is what keeps the second case's content.
 *
 * A `stat` that throws falls back to `isDirectory: true`, preserving the original safe direction: a
 * path we cannot classify is reported as structural, which `FilesStore` handles without writing an
 * empty file entry — the failure direction that loses content.
 */
async function classifyWatchPath(
  client: SandboxClient,
  path: string,
): Promise<{ isDirectory: boolean; buffer?: Uint8Array }> {
  let buffer: Uint8Array;

  try {
    buffer = await client.fs.readFile(path);
  } catch {
    /*
     * The throwing (agent) client's answer, and also a path deleted between the event and the read.
     * Both are reported as a directory event for the reason above.
     */
    return { isDirectory: true };
  }

  if (readFileErrorEnvelope(buffer) === null) {
    return { isDirectory: false, buffer };
  }

  try {
    return (await client.fs.stat(path)).type === 'directory' ? { isDirectory: true } : { isDirectory: false, buffer };
  } catch {
    return { isDirectory: true };
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

      created.onEvent(async (raw: CodeSandboxWatchEvent) => {
        /*
         * Normalize FIRST, so the enrichment read below and the map key produced by
         * `translateWatchEvent` are the same string by construction — see `normalizeWatchEventPaths`
         * for what a relative path would silently do to the file map.
         */
        const event = normalizeWatchEventPaths(workdir(), raw);
        const enriched = new Map<string, { isDirectory: boolean; buffer?: Uint8Array }>();

        if (options.includeContent && needsContent(event)) {
          await Promise.all(
            event.paths.map(async (path) => {
              enriched.set(path, await classifyWatchPath(client, path));
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
