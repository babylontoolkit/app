/**
 * The `SandboxProvider` seam (SPEC §1.3.5, §8, `spec/sandbox-seam.md`).
 *
 * The sandbox is the one piece of this platform we do not own: WebContainers is proprietary
 * (StackBlitz), and `spec/licensing.md` makes a commercial plan a hard Phase-3 gate — no plan, no
 * external users. §8 has always named the escape hatch (E2B / Firecracker / any server container),
 * and §1.3 principle 5 has always forbidden deepening WebContainer coupling. What did NOT exist
 * until now is the interface those rules were written to protect: the standing rule kept the
 * coupling from growing, but every store still held a `Promise<WebContainer>`.
 *
 * This file is that interface. It is deliberately NOT a re-export of WebContainer's types — it
 * declares its own, so that:
 *
 *   - a second provider can be written against a spec instead of against a competitor's `.d.ts`;
 *   - `sandbox-seam.spec.ts` can enforce "nothing outside the provider imports `@webcontainer/api`"
 *     as a DEFAULT-DENY source scan, which is impossible if the shared type module imports it;
 *   - the WebContainer-flavoured corners (`internal.watchPaths`, `internal.textSearch`) are named
 *     for what they DO rather than for where StackBlitz happened to put them.
 *
 * Every shape here is plain data or a plain stream — nothing in this file requires a browser, a
 * WASM runtime, or a local filesystem, which is the property that makes a server provider possible
 * at all.
 *
 * ⚠️ **Paths are workdir-relative, exactly as they are today.** Every `fs` method takes a path
 * relative to {@link SandboxProvider.workdir}; callers rebase with `path.relative(workdir, abs)`.
 * A provider that resolved absolute host paths instead would silently escape the project directory.
 *
 * ⚠️ **`fs` is not free on every provider.** WebContainer's filesystem is in-process, so today's
 * call sites treat a read as ~free and do them in loops (`FilesStore.refreshFiles` walks the whole
 * tree). A server provider puts a network round trip behind each one. That is a real design
 * consequence of the swap, not a bug in this interface — see `spec/sandbox-seam.md`.
 */

/** A directory entry, as returned by {@link SandboxFileSystem.readdir} with `withFileTypes: true`. */
export interface SandboxDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * The filesystem subset the platform actually uses — measured against the codebase, not copied
 * from WebContainer's `FileSystemAPI` (which also exposes `rename`/`watch`; nothing calls them).
 *
 * The overload pairs are load-bearing and must be preserved by any provider: `readFile` without an
 * encoding returns BYTES (that is how `spec/binary-files.md`'s byte-identity contract is honoured),
 * and `readdir` with `withFileTypes` returns dirents rather than names.
 */
export interface SandboxFileSystem {
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  readFile(path: string, encoding: BufferEncoding): Promise<string>;

  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: string | { encoding?: string | null } | null,
  ): Promise<void>;

  readdir(
    path: string,
    options?: { encoding?: BufferEncoding | null; withFileTypes?: false } | BufferEncoding | null,
  ): Promise<string[]>;
  readdir(path: string, options: { encoding?: BufferEncoding | null; withFileTypes: true }): Promise<SandboxDirent[]>;

  mkdir(path: string, options?: { recursive?: false }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string>;

  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
}

/** A running process. Mirrors the shape the terminal, the build action and the MCP bridge consume. */
export interface SandboxProcess {
  /** Resolves with the exit code once the process terminates. */
  exit: Promise<number>;

  /** Writable end of the attached pseudoterminal. */
  input: WritableStream<string>;

  /** Combined stdout+stderr of the process and its descendants. */
  output: ReadableStream<string>;

  kill(): void;

  resize(dimensions: { cols: number; rows: number }): void;
}

export interface SandboxSpawnOptions {
  /** Working directory, relative to {@link SandboxProvider.workdir}. */
  cwd?: string;
  env?: Record<string, string | number | boolean>;

  /** When false, {@link SandboxProcess.output} never produces chunks. */
  output?: boolean;

  /** Attaching a terminal size makes the process interactive. */
  terminal?: { cols: number; rows: number };
}

export interface SandboxFileNode {
  file: { contents: string | Uint8Array };
}

export interface SandboxDirectoryNode {
  directory: SandboxFileTree;
}

/**
 * A nested tree for {@link SandboxProvider.mount}.
 *
 * 🔴 **TEXT ONLY on the WebContainer provider** — `mount` decodes binary bodies through a browser
 * `TextDecoder('latin1')` (= windows-1252) and destroys every PNG and `.wasm` it is given. The rule
 * and its unit-test blind spot are documented at length in `~/lib/registry/mount-tree.ts`; binaries
 * go through `fs.writeFile(path, Uint8Array)` instead. `contents` stays `string | Uint8Array` here
 * because the restriction is a property of one provider, not of the seam.
 */
export type SandboxFileTree = Record<string, SandboxFileNode | SandboxDirectoryNode>;

export interface SandboxWatchEvent {
  type: 'change' | 'add_file' | 'remove_file' | 'add_dir' | 'remove_dir' | 'update_directory';

  /** Absolute path inside the sandbox (i.e. prefixed with {@link SandboxProvider.workdir}). */
  path: string;

  /** Present when the watch was created with `includeContent`. Absent for directory events. */
  buffer?: Uint8Array;
}

export interface SandboxWatchOptions {
  include?: string[];
  exclude?: string[];
  includeContent?: boolean;
}

export interface SandboxTextSearchOptions {
  folders: string[];
  includes: string[];
  excludes: string[];
  homeDir?: string;
  gitignore: boolean;
  requireGit: boolean;
  globalIgnoreFiles: boolean;
  isRegex: boolean;
  caseSensitive: boolean;
  isWordMatch: boolean;
  ignoreSymlinks: boolean;
  resultLimit: number;
}

export interface SandboxTextSearchRange {
  startLineNumber: number;
  endLineNumber: number;
  startColumn: number;
  endColumn: number;
}

export interface SandboxTextSearchMatch {
  preview: { text: string; matches: SandboxTextSearchRange[] };
  ranges: SandboxTextSearchRange[];
}

export type SandboxTextSearchProgress = (path: string, matches: SandboxTextSearchMatch[]) => void;

/**
 * What this provider can actually do, so the UI degrades instead of throwing
 * (`spec/sandbox-seam.md` — "capability flags so UI degrades gracefully").
 *
 * These are the three things a server-container provider plausibly cannot offer on day one: an
 * interactive PTY over the wire, a ripgrep-class project search, and cheap incremental file events.
 * A caller reads the flag; it must never feature-detect by probing for a method, which is how
 * `Search.tsx` used to do it (`typeof instance.internal?.textSearch !== 'function'`) — that reads
 * as defensive coding rather than as a documented contract, and it cannot be tested.
 */
export interface SandboxCapabilities {
  /** An interactive shell can be attached to a terminal (`spawn` with `terminal` options). */
  readonly terminal: boolean;

  /** {@link SandboxProvider.textSearch} is implemented. */
  readonly textSearch: boolean;

  /**
   * {@link SandboxProvider.watchPaths} delivers incremental change events. When false, callers must
   * fall back to `FilesStore.refreshFiles()` polling — the file map is never allowed to be stale.
   */
  readonly watch: boolean;
}

/**
 * How to start an interactive shell in this runtime.
 *
 * 🔴 **The shell binary is a property of the PROVIDER, and hardcoding it breaks the terminal with an
 * error that names nothing useful.** `/bin/jsh` is WebContainer's OWN shell — it does not exist on a
 * real Linux box, so a server provider's terminal opened and printed
 * `bash: /bin/jsh: No such file or directory` (MEASURED live on CodeSandbox). Same class as the
 * workdir: a value that only ever had one possible answer, until it had two.
 *
 * `readyOsc` exists because the two runtimes signal readiness differently. WebContainer's jsh emits
 * an OSC escape (`\x1b]654;interactive\x07`) that `shell.ts` waits for before sending a command; a
 * real PTY emits no such marker and is ready as soon as it speaks. Encoding that as an OPTIONAL
 * marker rather than as a hardcoded regex means the fallback ("ready on first output") is a
 * documented behaviour instead of an infinite wait.
 */
export interface SandboxShell {
  /** The program to spawn — e.g. `/bin/jsh` on WebContainer, `bash` on a real container. */
  readonly command: string;

  readonly args: readonly string[];

  /**
   * The OSC payload this shell emits when it becomes interactive, if it emits one.
   *
   * Absent means the shell has no readiness marker, and callers must fall back to treating first
   * output as ready. Waiting for a marker that will never arrive hangs the terminal forever with no
   * error — the failure this field exists to make impossible.
   */
  readonly readyOsc?: string;

  /**
   * Environment for the shell process — used to make a shell speak the OSC protocol `BoltShell`
   * parses. Absent when the shell already does (WebContainer's `jsh --osc`).
   *
   * 🔴 **Without this, every agent-run shell action HANGS — silently, forever.** `executeCommand`
   * writes a command and then waits for `\x1b]654;exit=…\x07`; a plain bash never sends it, so the
   * promise never settles, nothing throws, and the UI sits on "installing its dependencies…"
   * indefinitely (MEASURED live on CodeSandbox). That covers `npm install` on mount and every
   * `<boltAction type="shell">` the model emits — i.e. the product.
   *
   * Teaching bash to emit the same markers is deliberately preferred over rewriting the parser: the
   * parser is shared, already handles the interleaving, and a second implementation of "did the
   * command finish and what did it return" is the two-writers drift this codebase keeps
   * rediscovering. Delivering it through the ENVIRONMENT rather than as a typed command keeps it
   * out of the user's visible terminal.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The runtime a user's project lives in.
 *
 * One instance per builder session. Obtain it from `~/lib/sandbox` — never construct a provider in
 * feature code, and never import a concrete provider module outside that entry point.
 */
export interface SandboxProvider {
  readonly capabilities: SandboxCapabilities;

  /**
   * Did THIS session's boot bring back the filesystem from a previous session?
   *
   * 🔴 **This is the fact that decides whether a mount may restore a client-held copy over the
   * sandbox.** WebContainer is always `false` — its FS is empty on every page load, so the working
   * copy / local checkpoint IS the project and restoring it is the only way to have one. A
   * server-backed provider that resumed warm answers `true`: the disk is exactly as the last session
   * left it and is NEWER than anything the client holds, so writing a client copy over it is data
   * loss wearing recovery's clothes (MEASURED live on CodeSandbox — a stale working copy reverted a
   * generated `Home.css` to the starter's, silently, on reopen). `spec/sandbox-codesandbox.md` §1:
   * the working copy stays a recovery buffer and never becomes the primary wake mechanism.
   */
  readonly bootRestoredFilesystem: boolean;

  /** How to open an interactive shell here. See {@link SandboxShell}. */
  readonly shell: SandboxShell;

  /** Absolute path of the project root inside the sandbox (e.g. `/home/project`). */
  readonly workdir: string;

  readonly fs: SandboxFileSystem;

  /**
   * Atomically materialise a tree of files. Atomicity matters: the starter used to arrive as ~64
   * sequential writes that raced a cold boot, so `npm install` ran against an empty directory
   * (SPEC §4.4). A provider that cannot apply the tree atomically must not pretend it can.
   */
  mount(tree: SandboxFileTree, options?: { mountPoint?: string }): Promise<void>;

  spawn(command: string, args?: string[], options?: SandboxSpawnOptions): Promise<SandboxProcess>;

  /** Subscribe to file changes. Returns an unsubscribe function. */
  watchPaths(options: SandboxWatchOptions, callback: (events: SandboxWatchEvent[]) => void): () => void;

  /** Fires when a dev server inside the sandbox becomes reachable. Returns an unsubscribe function. */
  onServerReady(listener: (port: number, url: string) => void): () => void;

  /** Fires when a port opens or closes. Returns an unsubscribe function. */
  onPort(listener: (port: number, type: 'open' | 'close', url: string) => void): () => void;

  /** Present only when {@link SandboxCapabilities.textSearch} is true. */
  textSearch?(query: string, options: SandboxTextSearchOptions, onProgress: SandboxTextSearchProgress): Promise<void>;

  /**
   * Destroy the sandbox. Unused by app code today (a WebContainer dies with the tab), but part of
   * the seam contract because a server provider bills for the lifetime of what it does not reap —
   * lifecycle/hibernation is step 3 of the swap plan in `spec/sandbox-seam.md`.
   */
  teardown(): void;
}
