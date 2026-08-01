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
 * Nodepod's `fs.watch` event names mapped onto the seam's vocabulary.
 *
 * Nodepod reports the coarse Node `'rename' | 'change'` pair, which cannot distinguish an add from a
 * remove. `'rename'` therefore becomes `'update_directory'` — the seam's "something in here moved,
 * re-read it" event — rather than guessing `add_file`/`remove_file`. Guessing wrong in the delete
 * direction would drop a live file out of the map; `update_directory` costs a re-read and is always
 * true.
 */
export function toWatchEventType(nodepodEvent: string): SandboxWatchEvent['type'] {
  return nodepodEvent === 'change' ? 'change' : 'update_directory';
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

/**
 * Splits a raw terminal input stream into complete command lines.
 *
 * `BoltShell.executeCommand` writes `"<command>\n"`, but a human typing into the same terminal sends
 * one keystroke per write and may use `\r` (xterm's Enter). Both must produce exactly one command,
 * and a write that ends mid-line must NOT execute — buffering is the whole job.
 *
 * Returns the completed commands and keeps the partial tail for the next call.
 */
export function createLineBuffer() {
  let buffer = '';

  return {
    /** Feed a chunk; get back the command lines it completed. */
    push(chunk: string): string[] {
      buffer += chunk;

      const lines: string[] = [];

      for (;;) {
        const at = buffer.search(/[\r\n]/);

        if (at === -1) {
          break;
        }

        const line = buffer.slice(0, at);

        // Consume a CRLF pair as ONE terminator, or a blank line is executed for every Enter.
        const skip = buffer[at] === '\r' && buffer[at + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(at + skip);

        lines.push(line);
      }

      return lines;
    },

    pending: () => buffer,
  };
}
