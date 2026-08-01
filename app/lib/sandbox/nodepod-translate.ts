/**
 * Pure translation between the `SandboxProvider` seam and Nodepod's API.
 *
 * Everything here is a pure function or a small state machine over plain data — no Nodepod import, no
 * browser API — because the CodeSandbox split proved the point: the parts that silently corrupt a
 * project (path rebasing, tree flattening, the shell's completion protocol) are exactly the parts a
 * unit test can reach, and the parts that need a live runtime are exactly the parts that cannot hide a
 * logic bug. Keep new logic on this side of the line.
 */
import type { SandboxDirent, SandboxFileTree, SandboxWatchEvent } from './types';

/**
 * Seam paths are workdir-RELATIVE (`types.ts` header); Nodepod's VFS takes absolute paths.
 *
 * 🔴 `''` and `'.'` must both resolve to the workdir itself. `refresh-walk.ts` calls
 * `fs.readdir(relDir || '.')` for the project root, so a translation that produced `${workdir}/.`
 * or `${workdir}/` would either miss the root listing or return a duplicated path prefix on every
 * entry — and the whole file map is built from that walk.
 */
export function toPodPath(workdir: string, relPath: string): string {
  const trimmed = relPath.replace(/^\.\/+/, '').replace(/^\/+/, '');

  if (trimmed === '' || trimmed === '.') {
    return workdir;
  }

  return `${workdir}/${trimmed}`;
}

/**
 * Absolute pod path back to the workdir-relative form the seam speaks.
 *
 * Returns the input unchanged when it does not live under the workdir: a caller that receives a path
 * it cannot rebase should see the real value in its logs, not a silently truncated one.
 */
export function toRelPath(workdir: string, absPath: string): string {
  if (absPath === workdir) {
    return '';
  }

  return absPath.startsWith(`${workdir}/`) ? absPath.slice(workdir.length + 1) : absPath;
}

/**
 * A {@link SandboxDirent} from a name plus a directory flag.
 *
 * Nodepod's `readdir` returns `string[]` only, so the provider stats each entry and calls this. The
 * seam's overload pair is load-bearing (`types.ts`): `walkSandboxTree` recurses on `isDirectory()`,
 * so a dirent that answered `false` for everything would make the walk see a flat project and the
 * model would be shown a handful of root files — the `waitForMountVisible` failure, from a different
 * direction.
 */
export function makeDirent(name: string, isDirectory: boolean): SandboxDirent {
  return {
    name,
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
  };
}

export interface FlatFile {
  /** Workdir-relative path. */
  path: string;
  contents: string | Uint8Array;
}

/**
 * Flatten a nested {@link SandboxFileTree} into writes.
 *
 * ⚠️ `contents` is passed through by REFERENCE and is never decoded. WebContainer's own `mount`
 * destroys binaries by running them through `TextDecoder('latin1')` (`mount-tree.ts`), which is the
 * single worst inherited defect in this codebase; Nodepod's `files`/`writeFile` accept `Uint8Array`
 * natively, so the correct implementation here is to touch the bytes as little as possible.
 */
export function flattenTree(tree: SandboxFileTree, prefix = ''): FlatFile[] {
  const out: FlatFile[] = [];

  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;

    if ('directory' in node) {
      out.push(...flattenTree(node.directory, path));
    } else {
      out.push({ path, contents: node.file.contents });
    }
  }

  return out;
}

/**
 * Whether a watched path lies inside a directory the file map excludes.
 *
 * 🔴 **Nodepod's `fs.watch` takes no exclude option, so this filter is the ONLY thing standing
 * between the file map and `node_modules`.** CodeSandbox hands `options.exclude` to its watcher and
 * the runtime does the filtering; here the adapter must. Without it, `npm install` — 306 packages,
 * tens of thousands of files, MEASURED on the real starter — fires one event per file, and every one
 * costs a `stat`, a full `readFile` and a store write, on the UI thread. That is the
 * §4.16 working-copy freeze in a new disguise, and it would arrive as "the tab dies during install".
 *
 * Matching is by path SEGMENT rather than by glob engine, which is exact rather than approximate
 * here: `MAP_EXCLUDE_GLOBS` is documented as "the watcher's spelling of `MAP_EXCLUDED_DIRS`", and
 * that list is a set of directory NAMES excluded at any depth. `**\/x` and a bare `x` therefore mean
 * the same thing, and `isNodepodWatchExcluded` is tested to agree with `isMapExcludedDir` on every
 * entry — the equivalence is asserted, not assumed.
 */
export function isNodepodWatchExcluded(relPath: string, excludeGlobs: readonly string[] = []): boolean {
  if (excludeGlobs.length === 0) {
    return false;
  }

  const names = new Set(excludeGlobs.map((glob) => glob.replace(/^\*\*\//, '').replace(/\/+$/, '')));

  return relPath.split('/').some((segment) => segment !== '' && names.has(segment));
}

/** What the adapter learned about a path AFTER the event, by asking the filesystem. */
export interface WatchPathState {
  /** Does the path exist now? `false` means the event was a deletion. */
  exists: boolean;

  /** Only meaningful when {@link exists}. */
  isDirectory: boolean;
}

/** What the adapter already believed about this path, so an add can be told from a modify. */
export interface WatchPathMemory {
  knownFile: boolean;
  knownDir: boolean;
}

/**
 * Decide the seam event for one Nodepod watch event.
 *
 * 🔴 **This replaces a mapping that silently discarded every event.** Nodepod reports the coarse Node
 * pair `'rename' | 'change'`, where `rename` means "created OR deleted" (MEASURED: creating and
 * deleting the same file both emit `rename`). The first version mapped it to `update_directory` on
 * the stated grounds of refusing to guess — reasonable-sounding, and wrong, because
 * `FilesStore.#processEventBuffer` has **no case** for `update_directory`. Every event fell through
 * the switch and the file map stayed EMPTY: 54 files on disk, a blank workbench tree, the model
 * handed a partial context (`Mount not visible in the file store after 15000ms`), and the working
 * copy refused as empty. Nothing threw. Observed live 2026-07-31.
 *
 * The lesson is the general one: **when the consumer has no handler for the honest answer, honesty
 * is silence.** The fix is not to guess harder but to ASK — the adapter stats the path and reads its
 * bytes, and this function decides from facts. `exists` is the answer to "was this a delete", and the
 * memory of what the path used to be is the answer to "was this an add or a modify".
 *
 * Pure so the whole decision table is testable without a runtime; the IO lives in the provider.
 */
export function classifyWatchEvent(
  nodepodEvent: string,
  state: WatchPathState,
  memory: WatchPathMemory,
): SandboxWatchEvent['type'] {
  if (!state.exists) {
    /*
     * A vanished path is a delete, and WHICH delete matters: `remove_dir` also drops every descendant
     * key, `remove_file` drops one. Getting it backwards on a directory leaves the whole subtree in
     * the map as ghosts that the ZIP export, the GitHub sync and the model all still see. We answer
     * from memory rather than from the name because a deleted path cannot be stat'ed — and a
     * directory we never saw created is one we have no keys for anyway, so `remove_file` is the safe
     * residual.
     */
    return memory.knownDir ? 'remove_dir' : 'remove_file';
  }

  if (state.isDirectory) {
    return 'add_dir';
  }

  /*
   * `add_file` increments `FilesStore`'s size counter and `change` does not, so re-reporting an
   * existing file as an add inflates the count that drives "N files" in the UI and the mount-visible
   * check. A `change` event on a path we have never seen is still an add — that is the ordinary
   * shape of a write-then-modify that arrives faster than we classify it.
   */
  return memory.knownFile ? 'change' : 'add_file';
}

/*
 * ---------------------------------------------------------------------------------------------
 * The OSC completion protocol
 * ---------------------------------------------------------------------------------------------
 */

/** `shell.ts`'s escape prefix. Duplicated deliberately — see {@link OSC_EXIT_SHAPE}. */
const OSC_PREFIX = '\x1b]654;';

/**
 * 🔴 **Nodepod has no bash, so these markers are SYNTHESISED by the adapter — but the parser stays
 * `shell.ts`'s.**
 *
 * WebContainer's jsh emits this protocol natively and CodeSandbox is taught it through a `.bashrc`
 * (`OSC_BASHRC`). Nodepod's shell is a JavaScript interpreter with built-in commands, so there is no
 * rc file and no `PROMPT_COMMAND` to hook — the adapter must emit the markers around each command it
 * runs. What it must NOT do is also re-implement the reading side: `executeCommand` waits on
 * `scanOscSignals`, which already handles chunk-straddling sequences and the interleaving of
 * `exit`+`prompt` in one write. A second "did the command finish and what did it return" is the
 * two-writers drift this codebase keeps rediscovering.
 *
 * The shape is pinned by `shell.ts`'s `OSC_PATTERN`: `([^\x07=]+)=?((-?\d+):(\d+))?` — so the exit
 * code is the SECOND number. The first is ignored by the parser and is `0` here, matching the
 * measured bash form `\x1b]654;exit=0:0\x07`. Emitting `exit=<code>` with one number would parse as
 * a signal with NO exit code and hang every shell action, silently.
 */
export const OSC_EXIT_SHAPE = 'exit=0:<code>';

export const oscBegin = () => `${OSC_PREFIX}begin\x07`;
export const oscExit = (code: number) => `${OSC_PREFIX}exit=0:${code}\x07`;
export const oscPrompt = () => `${OSC_PREFIX}prompt\x07`;

/** ETX — what Ctrl-C sends, and what `BoltShell.executeCommand` writes before EVERY command. */
export const SHELL_INTERRUPT = '\x03';

/** DEL and BS: xterm sends one of these per backspace keystroke. */
const BACKSPACE = /[\x7f\b]/;

/** One thing the shell must do, in the order the bytes arrived. */
export type ShellInput = { type: 'interrupt' } | { type: 'command'; line: string };

/**
 * Splits a raw terminal input stream into the actions a shell must take.
 *
 * 🔴 **A real shell is a LINE EDITOR, and Nodepod has no shell — so this is it.** WebContainer ships
 * `jsh` and CodeSandbox has bash; both interpret control characters themselves. Here the adapter
 * owns that job, and the first version did not know control characters existed.
 *
 * That cost the product: `BoltShell.executeCommand` writes `'\x03'` and waits for a prompt before
 * every single command (`shell.ts` — it is how a previous command is interrupted). `\x03` carries no
 * newline, so it sat in the buffer and was glued onto whatever came next: the command became
 * `"\x03npm install"`, `String.trim()` does not strip `\x03` (it is not whitespace), and the first
 * word was `"\x03npm"`. Nodepod correctly reported no such command — and because `\x03` does not
 * render, the terminal showed exactly `npm: command not found`. Observed live 2026-07-31 on the very
 * first project: install failed, the dev server never started, and the one character that explained
 * it was invisible in the only place a human would look.
 *
 * `BoltShell.executeCommand` writes `"<command>\n"`, but a human typing into the same terminal sends
 * one keystroke per write and may use `\r` (xterm's Enter). Both must produce exactly one command,
 * and a write that ends mid-line must NOT execute — buffering is the rest of the job.
 */
export function createInputBuffer() {
  let buffer = '';

  /*
   * CRLF is ONE terminator. Iterating character by character makes that the caller's problem again —
   * `\r` would submit the line and `\n` would immediately submit an empty one, executing a blank
   * command for every Enter a human presses. The latch survives ACROSS pushes because a PTY splits
   * writes wherever it likes, so `\r` and `\n` can land in different chunks.
   */
  let afterCarriageReturn = false;

  return {
    /** Feed a chunk; get back what it completed, in arrival order. */
    push(chunk: string): ShellInput[] {
      const out: ShellInput[] = [];

      for (const char of chunk) {
        const skipLineFeed = afterCarriageReturn && char === '\n';
        afterCarriageReturn = false;

        if (skipLineFeed) {
          continue;
        }

        if (char === SHELL_INTERRUPT) {
          /*
           * Ctrl-C abandons the half-typed line, exactly as a real shell does. Dropping the buffer is
           * the part that matters: keeping it is what glued the control character to the next
           * command. Ordering is preserved by emitting into the same list — `executeCommand` writes
           * the interrupt and the command in separate writes, but a caller that batched them must
           * still see the interrupt first.
           */
          buffer = '';
          out.push({ type: 'interrupt' });
          continue;
        }

        if (BACKSPACE.test(char)) {
          buffer = buffer.slice(0, -1);
          continue;
        }

        if (char === '\n' || char === '\r') {
          afterCarriageReturn = char === '\r';
          out.push({ type: 'command', line: buffer });
          buffer = '';

          continue;
        }

        buffer += char;
      }

      return out;
    },

    pending: () => buffer,
  };
}
