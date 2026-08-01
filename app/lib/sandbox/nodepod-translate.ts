/**
 * Pure translation between the `SandboxProvider` seam and Nodepod's API.
 *
 * Everything here is a pure function or a small state machine over plain data — no Nodepod import, no
 * browser API — because the CodeSandbox split proved the point: the parts that silently corrupt a
 * project (path rebasing, tree flattening, the shell's completion protocol) are exactly the parts a
 * unit test can reach, and the parts that need a live runtime are exactly the parts that cannot hide a
 * logic bug. Keep new logic on this side of the line.
 */
import type {
  SandboxDirent,
  SandboxFileTree,
  SandboxTextSearchMatch,
  SandboxTextSearchOptions,
  SandboxWatchEvent,
} from './types';

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
 * How many commands the line editor remembers for ↑/↓.
 *
 * Bounded because the editor lives for the life of the tab and a terminal is a place people paste
 * things: an unbounded history is an unbounded string array holding every command ever typed.
 */
export const SHELL_HISTORY_LIMIT = 200;

/** Erase from the cursor to the end of the line — the redraw's other half. */
const ERASE_TO_END = '\x1b[K';

/**
 * The visible prompt, from the shell's current working directory.
 *
 * The workdir renders as `~` because that is what it IS to the user — the project root, and the only
 * directory they have. Showing `/home/project` instead spends a third of the line on a path that is
 * identical in every project and can never change.
 */
export function formatShellPrompt(cwd: string, workdir: string): string {
  const rel = toRelPath(workdir, cwd);

  return `\x1b[36m~${rel ? `/${rel}` : ''}\x1b[0m $ `;
}

/** What one chunk of terminal input produced: bytes to echo, and actions to run. */
export interface LineEditorResult {
  echo: string;
  actions: ShellInput[];
}

/**
 * A line editor for the interactive terminal.
 *
 * 🔴 **Without this the terminal does not echo, so a human types BLIND.** WebContainer ships `jsh`
 * and CodeSandbox has a real PTY; both echo keystrokes, redraw on backspace, and print a prompt,
 * because that is the terminal's job and not the shell's. Nodepod has neither, so the adapter owns
 * it — and the first version owned only the *parsing* half: it consumed every keystroke, emitted
 * nothing back, and produced output only once Enter was pressed. Typing `npm run dev` showed an
 * empty line the whole way. Nothing threw; the terminal simply looked broken, which is exactly the
 * report we got.
 *
 * It is a state machine over plain strings — no xterm, no runtime — so every editing rule below is
 * pinned by tests rather than discovered by a person pressing a key.
 *
 * Deliberately NOT implemented: cursor movement across a WRAPPED line. The redraw is
 * `\r` + erase + prompt + buffer, which addresses one screen row; a line longer than the terminal is
 * wide will smear on edit. A correct version needs the column count and multi-row cursor arithmetic,
 * and getting that subtly wrong corrupts the display of a line the user cannot then see to fix.
 * Appending — the overwhelmingly common case — echoes the single character and never redraws, so it
 * is unaffected by the limitation.
 */
export function createLineEditor(getPrompt: () => string) {
  let buffer = '';
  let cursor = 0;
  const history: string[] = [];
  let historyIndex = -1;
  let draft = '';

  /*
   * CRLF is ONE terminator. Iterating character by character makes that the caller's problem again —
   * `\r` would submit the line and `\n` would immediately submit an empty one, executing a blank
   * command for every Enter a human presses. The latch survives ACROSS pushes because a PTY splits
   * writes wherever it likes, so `\r` and `\n` can land in different chunks.
   */
  let afterCarriageReturn = false;

  /** Bytes of an escape sequence seen so far, `''` when not in one. Survives across pushes. */
  let escape = '';

  const redraw = () => {
    const back = buffer.length - cursor;

    return `\r${ERASE_TO_END}${getPrompt()}${buffer}${back > 0 ? `\x1b[${back}D` : ''}`;
  };

  const recall = (line: string) => {
    buffer = line;
    cursor = line.length;

    return redraw();
  };

  /** One completed escape sequence. Returns the bytes to echo. */
  const applyEscape = (sequence: string): string => {
    switch (sequence) {
      case '\x1b[A': {
        if (historyIndex === -1) {
          if (history.length === 0) {
            return '';
          }

          draft = buffer;
          historyIndex = history.length - 1;
        } else if (historyIndex > 0) {
          historyIndex -= 1;
        } else {
          return '';
        }

        return recall(history[historyIndex]);
      }

      case '\x1b[B': {
        if (historyIndex === -1) {
          return '';
        }

        if (historyIndex < history.length - 1) {
          historyIndex += 1;
          return recall(history[historyIndex]);
        }

        historyIndex = -1;

        return recall(draft);
      }

      case '\x1b[C':
        if (cursor >= buffer.length) {
          return '';
        }

        cursor += 1;

        return '\x1b[C';

      case '\x1b[D':
        if (cursor === 0) {
          return '';
        }

        cursor -= 1;

        return '\x1b[D';

      case '\x1b[3~':
        if (cursor >= buffer.length) {
          return '';
        }

        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);

        return redraw();

      case '\x1b[H':
      case '\x1b[1~':
        cursor = 0;
        return redraw();

      case '\x1b[F':
      case '\x1b[4~':
        cursor = buffer.length;
        return redraw();

      default:
        // An unrecognised sequence is swallowed, never echoed: printing it would corrupt the line.
        return '';
    }
  };

  return {
    /** Feed a chunk; get back what to echo and what it completed, in arrival order. */
    push(chunk: string): LineEditorResult {
      const actions: ShellInput[] = [];
      let echo = '';

      for (const char of chunk) {
        if (escape !== '') {
          escape += char;

          /*
           * A CSI sequence ends at its final byte (`@`–`~`); everything before is parameters. Anything
           * that is not a CSI introducer after ESC is a two-byte sequence we do not handle — end it
           * immediately rather than swallowing the rest of the line looking for a terminator.
           */
          const isCsi = escape.startsWith('\x1b[');

          if (!isCsi) {
            escape = '';
            continue;
          }

          if (escape.length > 2 && /[@-~]/.test(char)) {
            echo += applyEscape(escape);
            escape = '';
          } else if (escape.length > 16) {
            // Not a real sequence; stop buffering rather than growing without bound.
            escape = '';
          }

          continue;
        }

        const skipLineFeed = afterCarriageReturn && char === '\n';
        afterCarriageReturn = false;

        if (skipLineFeed) {
          continue;
        }

        if (char === '\x1b') {
          escape = '\x1b';
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
          cursor = 0;
          historyIndex = -1;
          echo += '^C\r\n';
          actions.push({ type: 'interrupt' });

          continue;
        }

        if (BACKSPACE.test(char)) {
          if (cursor === 0) {
            continue;
          }

          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor -= 1;

          /*
           * At the end of the line the cheap sequence is exact and avoids repainting: back up, write a
           * space over the character, back up again. Mid-line it would leave the tail unshifted.
           */
          echo += cursor === buffer.length ? '\b \b' : redraw();

          continue;
        }

        if (char === '\x15') {
          // Ctrl-U — kill the whole line.
          buffer = '';
          cursor = 0;
          echo += redraw();

          continue;
        }

        if (char === '\x0b') {
          // Ctrl-K — kill to end of line.
          buffer = buffer.slice(0, cursor);
          echo += redraw();

          continue;
        }

        if (char === '\x01') {
          cursor = 0;
          echo += redraw();

          continue;
        }

        if (char === '\x05') {
          cursor = buffer.length;
          echo += redraw();

          continue;
        }

        if (char === '\x0c') {
          // Ctrl-L — clear the screen and repaint the line where it now sits.
          echo += `\x1b[2J\x1b[H${getPrompt()}${buffer}`;

          if (buffer.length - cursor > 0) {
            echo += `\x1b[${buffer.length - cursor}D`;
          }

          continue;
        }

        if (char === '\n' || char === '\r') {
          afterCarriageReturn = char === '\r';

          const line = buffer;

          if (line.trim() !== '' && history[history.length - 1] !== line) {
            history.push(line);

            if (history.length > SHELL_HISTORY_LIMIT) {
              history.shift();
            }
          }

          historyIndex = -1;
          draft = '';
          buffer = '';
          cursor = 0;
          echo += '\r\n';
          actions.push({ type: 'command', line });

          continue;
        }

        if (char < ' ') {
          // Any other control character is not printable and has no editing meaning here.
          continue;
        }

        if (cursor === buffer.length) {
          buffer += char;
          cursor += 1;
          echo += char;
        } else {
          buffer = buffer.slice(0, cursor) + char + buffer.slice(cursor);
          cursor += 1;
          echo += redraw();
        }
      }

      return { echo, actions };
    },

    pending: () => buffer,
  };
}

/*
 * ---------------------------------------------------------------------------------------------
 * Project-wide text search
 * ---------------------------------------------------------------------------------------------
 */

/**
 * One glob from `SandboxTextSearchOptions.includes` / `.excludes`, as a regular expression.
 *
 * The patterns the workbench actually sends are `**\/node_modules/**`, `**\/*.lock`,
 * `**\/package-lock.json` and `**\/*.*` — so this supports `**` (any number of segments, including
 * none), `*` (anything within one segment) and `?`. Everything else is escaped to a literal.
 *
 * Written here rather than deep-imported from Nodepod's `shell-helpers`: the seam rule is that the
 * SDK is reachable from two files only, and a glob matcher is a pure function whose failure mode —
 * silently searching `node_modules`, which is ~50k files in memory — is worth pinning ourselves.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];

    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans zero or more whole segments; a bare `**` spans anything at all.
        i += 1;

        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }

      continue;
    }

    out += char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${out}$`);
}

/**
 * Should this workdir-relative path be read and scanned?
 *
 * 🔴 **Excludes are checked FIRST and win.** The workbench sends `includes: ['**\/*.*']` — which
 * every file under `node_modules` also matches — so an include-first order would search the whole
 * dependency tree on every keystroke's debounce. Include-anything (`[]`) means "no restriction",
 * never "nothing": an empty list read as an empty allow-list returns no results at all, which looks
 * exactly like a working search over a project with no matches.
 */
export function isSearchCandidate(relPath: string, options: Pick<SandboxTextSearchOptions, 'includes' | 'excludes'>) {
  if (options.excludes?.some((glob) => globToRegExp(glob).test(relPath))) {
    return false;
  }

  return !options.includes?.length || options.includes.some((glob) => globToRegExp(glob).test(relPath));
}

/** The regex one search runs, honouring the workbench's regex/case/word toggles. */
export function buildSearchRegExp(
  query: string,
  options: Pick<SandboxTextSearchOptions, 'isRegex' | 'caseSensitive' | 'isWordMatch'>,
): RegExp | undefined {
  if (query === '') {
    return undefined;
  }

  const body = options.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wrapped = options.isWordMatch ? `\\b(?:${body})\\b` : body;

  try {
    return new RegExp(wrapped, options.caseSensitive ? 'g' : 'gi');
  } catch {
    /*
     * A half-typed regex (`(`, `[a-`) is the NORMAL state of a search box, not an error worth
     * throwing from — the panel searches on every debounce while the user is still typing. No
     * pattern means no matches, and the next keystroke tries again.
     */
    return undefined;
  }
}

/**
 * Every match in one file's text, shaped the way `Search.tsx` reads it.
 *
 * One entry PER MATCHING LINE with the line as its own preview. The panel computes
 * `range.startLineNumber - preview.matches[0].startLineNumber` to index into `preview.text.split('\n')`,
 * so a single-line preview makes that index 0 and the arithmetic exact. Batching several lines into
 * one preview is expressible but pointless here and gets the offset wrong the moment a match is not
 * on the preview's first line.
 *
 * Columns are 1-based to match the workbench's editor, and `resultLimit` is honoured per file — a
 * minified bundle that matched on every line would otherwise build a million-entry array before the
 * caller ever saw the first result.
 */
export function findTextMatches(text: string, regex: RegExp, resultLimit: number): SandboxTextSearchMatch[] {
  const out: SandboxTextSearchMatch[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length && out.length < resultLimit; i++) {
    const line = lines[i];

    // A fresh scanner per line: a shared global regex carries `lastIndex` and would skip matches.
    const scanner = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);

    let match: RegExpExecArray | null;

    while ((match = scanner.exec(line)) !== null && out.length < resultLimit) {
      const range = {
        startLineNumber: i + 1,
        endLineNumber: i + 1,
        startColumn: match.index + 1,
        endColumn: match.index + match[0].length + 1,
      };

      out.push({ preview: { text: line, matches: [range] }, ranges: [range] });

      // A zero-width match (`a*`, `^`) never advances `lastIndex`, so the loop would never end.
      if (match[0] === '') {
        scanner.lastIndex += 1;
      }
    }
  }

  return out;
}

/**
 * Is this file worth reading as text at all?
 *
 * A search walks whatever is in the project, and a project contains `havok.wasm`, PNGs and glTF
 * binaries. Decoding a 2 MB binary to UTF-8 and regexing it costs real time on the UI thread and can
 * never produce a useful result — and the NUL byte is the same signal `file(1)` uses.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);

  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Convert a process's output to what a terminal emulator needs.
 *
 * xterm treats `\n` as "down one row" and NOT as "back to column 0", so raw Unix output staircases
 * down the screen — every line starting where the last one ended. Nodepod's own terminal does exactly
 * this substitution before writing (`NodepodTerminal._writeOutput`); the adapter has to, because it
 * writes to the workbench's xterm rather than to theirs.
 *
 * Only bare `\n` is rewritten — a `\r\n` already correct must not become `\r\r\n`, and a lone `\r`
 * (progress bars, npm's spinner) is left exactly alone because overwriting the current line is what
 * it is FOR.
 */
export function toTerminalNewlines(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}
