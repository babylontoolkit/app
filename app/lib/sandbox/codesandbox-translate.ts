/**
 * Pure translation between the `SandboxProvider` seam and CodeSandbox's SDK shapes.
 *
 * Everything here is a pure function with no SDK import, for the reason this codebase keeps
 * rediscovering: the parts of an adapter that fail SILENTLY are the parts that translate. A wrong
 * path prefix writes outside the project, a wrong event name leaves the file tree frozen while the
 * user watches the agent "do nothing", and a mount that drops binary contents corrupts a `.wasm`
 * without throwing. None of those produce an error anywhere, so each one is pinned by a test.
 *
 * The three real shape mismatches, measured live against `@codesandbox/sdk@2.4.2`:
 *
 *   1. **Paths.** The seam is workdir-RELATIVE (`FilesStore` passes `relativePath` / `relDir || '.'`);
 *      CodeSandbox's `fs.*` methods are ABSOLUTE. So every call rebases — and rebasing is exactly
 *      where a `..` escapes the project, hence {@link resolveInWorkdir} refuses traversal outright
 *      rather than normalising it away.
 *   2. **`batchWrite` is the odd one out — it takes RELATIVE paths.** MEASURED: absolute paths fail
 *      with `Unzip command failed with exit code 1`, because the SDK zips the entries and extracts
 *      against the workspace root, so a leading `/project/workspace/` becomes a bogus zip entry.
 *      Nothing in `BatchWriteFile` says so; its `path` is just `string`.
 *   3. **Watch events carry no content and no file/directory distinction.** CodeSandbox gives
 *      `{paths, type: 'add' | 'change' | 'remove'}`; the seam (and `FilesStore.#processEventBuffer`)
 *      wants `add_file` / `add_dir` / `remove_file` / `remove_dir` / `change` plus a `buffer`. What
 *      can be recovered by reading the file is recovered in the adapter; what cannot is documented
 *      in {@link translateWatchEvent} rather than guessed at.
 */
import type { SandboxFileTree, SandboxWatchEvent } from './types';

/** One entry as `FileSystem.batchWrite` wants it: a workspace-RELATIVE path. */
export interface CodeSandboxBatchFile {
  path: string;
  content: string | Uint8Array;
}

/** The subset of CodeSandbox's `WatchEvent` this module translates. */
export interface CodeSandboxWatchEvent {
  paths: string[];
  type: 'add' | 'change' | 'remove';
}

/**
 * Turn a seam path into an absolute path inside the sandbox.
 *
 * 🔴 **Traversal is REFUSED, never normalised.** `join('/project/workspace', '../../etc/passwd')`
 * silently produces a valid path outside the project, and every `fs` method in the seam takes a path
 * that ultimately originates from a file map the model can write to. Refusing is the only safe
 * answer: a legitimate caller never needs `..`, so the check costs nothing and closes the hole.
 *
 * `.` and `''` mean the workdir itself — `FilesStore.refreshFiles` walks with `readdir(relDir || '.')`.
 */
export function resolveInWorkdir(workdir: string, relativePath: string): string {
  const clean = stripLeadingSlashes(relativePath.trim());

  if (clean === '' || clean === '.') {
    return workdir;
  }

  assertNoTraversal(clean);

  return `${stripTrailingSlashes(workdir)}/${clean}`;
}

/**
 * Turn a seam path into the workspace-RELATIVE form `batchWrite` requires.
 *
 * Deliberately a separate function from {@link resolveInWorkdir} rather than a flag on it: the two
 * produce different strings for the same input, and the whole reason this needed measuring is that
 * one SDK method disagrees with all the others. A boolean parameter would make the call sites read
 * identically and the difference invisible.
 */
export function toWorkspaceRelative(workdir: string, path: string): string {
  const clean = stripLeadingSlashes(path.trim());
  const prefix = `${stripLeadingSlashes(stripTrailingSlashes(workdir))}/`;

  /*
   * A caller may hand us either form — the mount tree is built from seam-relative paths, but a
   * `mountPoint` or an already-absolute path arrives with the workdir on the front. Strip it once
   * rather than letting `/project/workspace/project/workspace/...` through.
   */
  const relative = clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;

  assertNoTraversal(relative);

  return relative;
}

/**
 * Flatten a {@link SandboxFileTree} into `batchWrite` entries.
 *
 * 🔴 **`Uint8Array` contents pass through untouched.** This is the whole binary contract
 * (`spec/binary-files.md`): the WebContainer provider's `mount` decodes binary bodies through a
 * `TextDecoder('latin1')` and destroys every PNG and `.wasm` it is given, which is why the platform
 * writes binaries out-of-band there. CodeSandbox's `batchWrite` accepts bytes directly, so this
 * provider has no such defect — and a "helpful" `String(content)` here would silently reintroduce it.
 *
 * Empty directories are dropped: `batchWrite` creates parent directories as a side effect of the
 * files inside them, and there is no entry shape that means "directory". A tree of nothing but empty
 * directories therefore yields no entries, which the caller must handle (see `mount`).
 */
export function flattenMountTree(tree: SandboxFileTree, prefix = ''): CodeSandboxBatchFile[] {
  const out: CodeSandboxBatchFile[] = [];

  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;

    if ('file' in node) {
      out.push({ path, content: node.file.contents });
    } else if ('directory' in node) {
      out.push(...flattenMountTree(node.directory, path));
    }
  }

  return out;
}

/**
 * Translate one CodeSandbox watch event into seam events — one per path.
 *
 * ⚠️ **`isDirectory` is supplied by the CALLER, because only the caller can find out.** CodeSandbox's
 * event says `add`/`change`/`remove` and nothing else, so the adapter resolves the distinction by
 * reading the path (a read that fails as a directory tells us what it is) and passes the answer in.
 * Doing the lookup here would make this module impure and untestable, and defaulting it to `false`
 * inside would bury a wrong answer where nobody looks.
 *
 * 🔴 **A `remove` cannot be classified at all** — the path is already gone, so nothing can be read.
 * It is reported as `remove_file`, which is right for the overwhelming majority of removals and wrong
 * for a deleted directory, whose children then linger in the file map until the next
 * `refreshFiles()`. That is a real, bounded limitation of this provider and it is written down here
 * rather than papered over, because the alternative — reporting every removal as `remove_dir` — makes
 * `FilesStore` prefix-sweep on every deleted file and corrupts `#size` instead.
 */
export function translateWatchEvent(
  event: CodeSandboxWatchEvent,
  classify: (path: string) => { isDirectory: boolean; buffer?: Uint8Array } | undefined,
): SandboxWatchEvent[] {
  return event.paths.map((path) => {
    const info = classify(path);

    if (event.type === 'remove') {
      return { type: 'remove_file' as const, path };
    }

    if (info?.isDirectory) {
      return { type: event.type === 'add' ? ('add_dir' as const) : ('update_directory' as const), path };
    }

    return {
      type: event.type === 'add' ? ('add_file' as const) : ('change' as const),
      path,
      buffer: info?.buffer,
    };
  });
}

/**
 * Does this watch event need file contents fetched before it can be delivered?
 *
 * `FilesStore` builds its entry straight from `buffer` (`fileEntryFromBuffer`), so an `add_file` or
 * `change` delivered without one produces an entry claiming the file is empty. WebContainer supplies
 * the bytes in the event; CodeSandbox does not. Naming the predicate keeps the adapter from fetching
 * on removals, which would be one wasted round trip per deleted file against a 3,600/hour budget.
 */
export function needsContent(event: CodeSandboxWatchEvent): boolean {
  return event.type === 'add' || event.type === 'change';
}

/**
 * Build a shell command line from an argv-style `(command, args)` pair.
 *
 * 🔴 **This exists because CodeSandbox has no argv API and the naive join is a live defect.**
 * The seam's `spawn(command, args)` is argv-shaped — WebContainer passes it to the process directly,
 * with no shell in between — but `commands.run` takes a COMMAND LINE that bash parses. MEASURED
 * against a real sandbox: the array form (`run(['node','-e','…'])`) fails with exit code 2, and a
 * plain `[command, ...args].join(' ')` sent `node -e console.log("x", 6*7)` to bash, which answered
 * `syntax error near unexpected token '('`.
 *
 * Two consequences, and the second is the serious one:
 *
 *   - **Correctness**: any argument containing a space, quote, parenthesis or `$` is re-split or
 *     expanded by the shell. A filename with a space is enough to break it.
 *   - **Safety**: an unquoted argument containing `;`, `&&` or a backtick becomes a SEPARATE
 *     command. Arguments here come from file paths and action-runner input, so an unquoted join is
 *     a shell-injection shape — the same class the §4.2.5 allow-list exists to prevent, arriving
 *     through a different door.
 *
 * Single quotes are used because inside them bash expands NOTHING; the only character needing care
 * is the single quote itself, closed and re-opened as `'\''`. Every token is quoted, including the
 * command, so a program path containing a space works too.
 */
export function toShellCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * Did this bootup type bring back the PREVIOUS session's filesystem?
 *
 * 🔴 This answer decides whether the mount path may restore a client-held copy over the sandbox.
 * `RESUME` (woke from a hibernation snapshot) and `RUNNING` (was never asleep) mean the disk — and
 * possibly a running dev server — are exactly as the last session left them, so a restore is DATA
 * LOSS, not recovery (MEASURED live: a stale working copy reverted a generated `Home.css` to the
 * starter's, two hours after the generation wrote it). `FORK` is a brand-new VM holding template
 * state, and `CLEAN` means the snapshot expired and setup re-ran — both genuinely need refilling.
 */
export function bootupPreservedFilesystem(bootupType: string): boolean {
  return bootupType === 'RESUME' || bootupType === 'RUNNING';
}

export class SandboxPathError extends Error {
  constructor(path: string) {
    super(`Refusing a sandbox path that escapes the project directory: ${path}`);
    this.name = 'SandboxPathError';
  }
}

function assertNoTraversal(path: string): void {
  if (path.split('/').some((segment) => segment === '..')) {
    throw new SandboxPathError(path);
  }
}

function stripLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
