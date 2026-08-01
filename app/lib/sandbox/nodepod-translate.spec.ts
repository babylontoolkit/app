/**
 * Pure-translation tests for the Nodepod adapter.
 *
 * The load-bearing one is "the OSC markers are parsed by the REAL parser": this adapter synthesises a
 * protocol that another module reads, and asserting my own format against my own constant would pass
 * with both halves wrong. `scanOscSignals` is imported from `~/utils/shell` for exactly that reason.
 */
import { describe, expect, it } from 'vitest';
import { MAP_EXCLUDE_GLOBS, isMapExcludedDir } from '~/lib/stores/files';
import { scanOscSignals } from '~/utils/shell';
import {
  classifyWatchEvent,
  createInputBuffer,
  flattenTree,
  isNodepodWatchExcluded,
  makeDirent,
  oscBegin,
  oscExit,
  oscPrompt,
  toPodPath,
  toRelPath,
} from './nodepod-translate';
import type { SandboxFileTree } from './types';

const WORKDIR = '/home/user/workspace';

describe('path translation', () => {
  it('rebases a relative path onto the workdir', () => {
    expect(toPodPath(WORKDIR, 'src/main.tsx')).toBe(`${WORKDIR}/src/main.tsx`);
  });

  /*
   * `refresh-walk.ts` calls `fs.readdir(relDir || '.')` for the project root. Both spellings must
   * land on the workdir itself — `${workdir}/.` or a trailing slash breaks the whole file map.
   */
  it.each(['', '.', './', '/'])('resolves the project root spelled %o to the workdir exactly', (input) => {
    expect(toPodPath(WORKDIR, input)).toBe(WORKDIR);
  });

  it('strips a leading ./ rather than embedding it', () => {
    expect(toPodPath(WORKDIR, './package.json')).toBe(`${WORKDIR}/package.json`);
  });

  it('round-trips through toRelPath', () => {
    expect(toRelPath(WORKDIR, toPodPath(WORKDIR, 'src/a/b.ts'))).toBe('src/a/b.ts');
    expect(toRelPath(WORKDIR, WORKDIR)).toBe('');
  });

  it('leaves a path outside the workdir visible instead of truncating it', () => {
    expect(toRelPath(WORKDIR, '/etc/passwd')).toBe('/etc/passwd');
  });

  /* A sibling directory sharing a prefix must not be mistaken for a child. */
  it('does not rebase a sibling whose name merely starts with the workdir', () => {
    expect(toRelPath(WORKDIR, `${WORKDIR}-backup/x.ts`)).toBe(`${WORKDIR}-backup/x.ts`);
  });
});

describe('dirents', () => {
  it('answers isFile/isDirectory as exact opposites', () => {
    const dir = makeDirent('src', true);
    const file = makeDirent('main.tsx', false);

    expect([dir.isDirectory(), dir.isFile()]).toEqual([true, false]);
    expect([file.isDirectory(), file.isFile()]).toEqual([false, true]);
    expect(dir.name).toBe('src');
  });
});

describe('flattenTree', () => {
  it('flattens nested directories to workdir-relative paths', () => {
    const tree: SandboxFileTree = {
      'package.json': { file: { contents: '{}' } },
      src: {
        directory: {
          'main.tsx': { file: { contents: 'x' } },
          lib: { directory: { 'a.ts': { file: { contents: 'y' } } } },
        },
      },
    };

    expect(
      flattenTree(tree)
        .map((f) => f.path)
        .sort(),
    ).toEqual(['package.json', 'src/lib/a.ts', 'src/main.tsx']);
  });

  /*
   * The inherited WebContainer `mount` decodes binaries through TextDecoder('latin1') and destroys
   * them. Nodepod takes Uint8Array natively, so the bytes must arrive by reference, untouched.
   */
  it('passes binary contents through by reference without decoding', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x1b, 0x07]);
    const flat = flattenTree({ 'havok.wasm': { file: { contents: bytes } } });

    expect(flat[0].contents).toBe(bytes);
  });

  it('returns nothing for an empty tree', () => {
    expect(flattenTree({})).toEqual([]);
  });
});

describe('classifyWatchEvent', () => {
  const FRESH = { knownFile: false, knownDir: false };
  const SEEN_FILE = { knownFile: true, knownDir: false };
  const SEEN_DIR = { knownFile: false, knownDir: true };
  const exists = (isDirectory: boolean) => ({ exists: true, isDirectory });
  const GONE = { exists: false, isDirectory: false };

  /*
   * 🔴 THE REGRESSION THIS FILE EXISTS FOR. This mapping used to answer `update_directory` for
   * `rename`, on the stated grounds of refusing to guess. `FilesStore.#processEventBuffer` has no
   * case for that type, so every event fell through its switch: 54 files on disk and an EMPTY file
   * map, a blank workbench tree, a partial model context, and a working copy refused as empty —
   * with nothing thrown. Observed live 2026-07-31.
   *
   * Every event must therefore land on a type `FilesStore` actually handles. Asserted as a set
   * membership rather than case by case, so a future type added to the seam cannot quietly
   * reintroduce one the store ignores.
   */
  const HANDLED_BY_FILES_STORE = ['change', 'add_file', 'remove_file', 'add_dir', 'remove_dir'];

  it.each([
    ['rename', exists(false), FRESH],
    ['rename', exists(true), FRESH],
    ['rename', GONE, SEEN_FILE],
    ['rename', GONE, SEEN_DIR],
    ['change', exists(false), SEEN_FILE],
    ['change', exists(false), FRESH],
    ['change', exists(true), SEEN_DIR],
  ] as const)('%s always yields a type FilesStore handles', (event, state, memory) => {
    expect(HANDLED_BY_FILES_STORE).toContain(classifyWatchEvent(event, state, memory));
  });

  it('reports a newly created file as add_file', () => {
    expect(classifyWatchEvent('rename', exists(false), FRESH)).toBe('add_file');
  });

  /*
   * `add_file` increments FilesStore's size counter and `change` does not, so re-reporting a known
   * file as an add inflates the count that drives the mount-visible check.
   */
  it('reports a modification to a known file as change, not a second add', () => {
    expect(classifyWatchEvent('change', exists(false), SEEN_FILE)).toBe('change');
  });

  /* A `change` for a path never seen is still the first time it enters the map. */
  it('treats a change on an unseen path as an add', () => {
    expect(classifyWatchEvent('change', exists(false), FRESH)).toBe('add_file');
  });

  it('reports a directory as add_dir', () => {
    expect(classifyWatchEvent('rename', exists(true), FRESH)).toBe('add_dir');
  });

  /*
   * 🔴 The two deletes are NOT interchangeable: `remove_dir` also drops every descendant key while
   * `remove_file` drops one. Answering `remove_file` for a directory leaves the whole subtree in the
   * map as ghosts that the ZIP export, the GitHub sync and the model all still see.
   */
  it('distinguishes a removed directory from a removed file, using what it saw before', () => {
    expect(classifyWatchEvent('rename', GONE, SEEN_DIR)).toBe('remove_dir');
    expect(classifyWatchEvent('rename', GONE, SEEN_FILE)).toBe('remove_file');
  });

  /* A path we never recorded has no descendant keys to strip, so the narrow delete is correct. */
  it('falls back to remove_file for a vanished path it never saw', () => {
    expect(classifyWatchEvent('rename', GONE, FRESH)).toBe('remove_file');
  });
});

describe('isNodepodWatchExcluded', () => {
  /*
   * 🔴 Nodepod's `fs.watch` takes NO exclude option, so this filter is the only thing between the
   * file map and `node_modules`. MEASURED on the real starter: `npm install` writes 306 packages,
   * and unfiltered every one costs a stat, a full readFile and a store write on the UI thread.
   */
  it('excludes node_modules at the root and at any depth', () => {
    expect(isNodepodWatchExcluded('node_modules/react/index.js', MAP_EXCLUDE_GLOBS)).toBe(true);
    expect(isNodepodWatchExcluded('packages/app/node_modules/react/index.js', MAP_EXCLUDE_GLOBS)).toBe(true);
  });

  it.each(MAP_EXCLUDE_GLOBS)('excludes a path under %s', (glob) => {
    const name = glob.replace(/^\*\*\//, '');

    expect(isNodepodWatchExcluded(`${name}/some/file.js`, MAP_EXCLUDE_GLOBS)).toBe(true);
  });

  it('keeps ordinary project files', () => {
    for (const path of ['src/scripts/BlankCanvasMode.ts', 'package.json', 'public/babylon.png', 'src/pages/Home.tsx']) {
      expect(isNodepodWatchExcluded(path, MAP_EXCLUDE_GLOBS)).toBe(false);
    }
  });

  /*
   * Segment matching, not substring matching: a file whose NAME merely contains an excluded word is
   * an ordinary project file. `dist` is the dangerous one — `src/distortion.ts` is real game code.
   */
  it('matches whole path segments only', () => {
    expect(isNodepodWatchExcluded('src/distortion.ts', MAP_EXCLUDE_GLOBS)).toBe(false);
    expect(isNodepodWatchExcluded('src/my-node_modules-notes.md', MAP_EXCLUDE_GLOBS)).toBe(false);
    expect(isNodepodWatchExcluded('.github/workflows/ci.yml', MAP_EXCLUDE_GLOBS)).toBe(false);
  });

  /*
   * 🔴 The equivalence that makes segment matching CORRECT rather than merely convenient:
   * `MAP_EXCLUDE_GLOBS` is documented as "the watcher's spelling of `MAP_EXCLUDED_DIRS`", a set of
   * directory names excluded at any depth. Asserted against the other spelling so the two cannot
   * drift — the same reason `files-exclusions.spec.ts` pins the imported value rather than a copy.
   */
  it('agrees with isMapExcludedDir, the walk’s spelling of the same rule', () => {
    for (const glob of MAP_EXCLUDE_GLOBS) {
      const name = glob.replace(/^\*\*\//, '');

      expect(isMapExcludedDir(name)).toBe(true);
      expect(isNodepodWatchExcluded(`a/${name}/b.ts`, MAP_EXCLUDE_GLOBS)).toBe(true);
    }
  });

  /* No excludes configured must mean no filtering, not "exclude everything". */
  it('excludes nothing when given no globs', () => {
    expect(isNodepodWatchExcluded('node_modules/react/index.js')).toBe(false);
    expect(isNodepodWatchExcluded('node_modules/react/index.js', [])).toBe(false);
  });
});

describe('the synthesised OSC protocol is understood by the REAL shell parser', () => {
  it('reports the exit code the adapter emitted', () => {
    const { signals } = scanOscSignals(oscExit(0));

    expect(signals).toEqual([{ code: 'exit', exitCode: 0 }]);
  });

  it.each([0, 1, 2, 127, 130, 255])('round-trips exit code %i', (code) => {
    const { signals } = scanOscSignals(oscExit(code));

    expect(signals[0]).toEqual({ code: 'exit', exitCode: code });
  });

  it('emits begin and prompt as codes with no exit code', () => {
    expect(scanOscSignals(oscBegin()).signals).toEqual([{ code: 'begin' }]);
    expect(scanOscSignals(oscPrompt()).signals).toEqual([{ code: 'prompt' }]);
  });

  /*
   * The measured bash form writes exit and prompt in ONE chunk, and `executeCommand` waits for both.
   * A parser reading only the first match hangs every shell action — pinned here from the emitting
   * side too, so the adapter cannot start splitting them and quietly rely on luck.
   */
  it('parses a begin/exit/prompt burst arriving as a single chunk, in order', () => {
    const { signals, rest } = scanOscSignals(`${oscBegin()}some output\n${oscExit(3)}${oscPrompt()}`);

    expect(signals).toEqual([{ code: 'begin' }, { code: 'exit', exitCode: 3 }, { code: 'prompt' }]);
    expect(rest).toBe('');
  });

  /* An exit code must never be swallowed by surrounding program output. */
  it('finds the markers when wrapped in ordinary output', () => {
    const { signals } = scanOscSignals(`added 306 packages\n${oscExit(0)}${oscPrompt()}$ `);

    expect(signals.map((s) => s.code)).toEqual(['exit', 'prompt']);
  });
});

describe('createInputBuffer', () => {
  const cmd = (line: string) => ({ type: 'command', line });

  it('emits a command only once its newline arrives', () => {
    const buf = createInputBuffer();

    expect(buf.push('npm ')).toEqual([]);
    expect(buf.push('install')).toEqual([]);
    expect(buf.push('\n')).toEqual([cmd('npm install')]);
  });

  it('handles a carriage return from xterm Enter', () => {
    expect(createInputBuffer().push('ls\r')).toEqual([cmd('ls')]);
  });

  /* CRLF is ONE terminator; consuming it as two executes a spurious empty command per Enter. */
  it('treats CRLF as a single terminator', () => {
    expect(createInputBuffer().push('ls\r\n')).toEqual([cmd('ls')]);
  });

  /* A PTY splits writes anywhere, so the CR/LF pair can straddle two pushes. */
  it('treats CRLF as one terminator even when split across chunks', () => {
    const buf = createInputBuffer();

    expect(buf.push('ls\r')).toEqual([cmd('ls')]);
    expect(buf.push('\n')).toEqual([]);
  });

  it('splits multiple commands in one chunk and keeps the partial tail', () => {
    const buf = createInputBuffer();

    expect(buf.push('a\nb\nc')).toEqual([cmd('a'), cmd('b')]);
    expect(buf.pending()).toBe('c');
    expect(buf.push('\n')).toEqual([cmd('c')]);
  });

  it('preserves an intentionally blank line', () => {
    expect(createInputBuffer().push('\n')).toEqual([cmd('')]);
  });

  /*
   * 🔴 THE DEFECT THAT BROKE THE FIRST REAL PROJECT (live, 2026-07-31).
   *
   * `BoltShell.executeCommand` writes `'\x03'` before EVERY command and then waits for a prompt.
   * The first version of this buffer knew nothing about control characters, so `\x03` — which
   * carries no newline — sat in the buffer and was glued onto the next line. The command became
   * `"\x03npm install"`; `String.trim()` does not strip `\x03` because it is not whitespace; the
   * first word was `"\x03npm"`. Nodepod correctly reported no such command, and because `\x03` does
   * not render, the terminal showed exactly `npm: command not found`. Install failed, the dev server
   * never started, and the one character that explained it was invisible.
   */
  it('reports Ctrl-C as an interrupt and never as part of a command', () => {
    const buf = createInputBuffer();

    expect(buf.push('\x03')).toEqual([{ type: 'interrupt' }]);
    expect(buf.pending()).toBe('');
    expect(buf.push('npm install\n')).toEqual([cmd('npm install')]);
  });

  /* The exact byte sequence `executeCommand` writes, as one chunk: interrupt first, then the command. */
  it('handles the real executeCommand sequence in one chunk, in order', () => {
    expect(createInputBuffer().push('\x03npm install\n')).toEqual([{ type: 'interrupt' }, cmd('npm install')]);
  });

  /* Ctrl-C abandons the half-typed line, exactly as a real shell does. */
  it('discards a partially typed line on interrupt', () => {
    const buf = createInputBuffer();

    buf.push('rm -rf /');
    expect(buf.push('\x03')).toEqual([{ type: 'interrupt' }]);
    expect(buf.pending()).toBe('');
    expect(buf.push('\n')).toEqual([cmd('')]);
  });

  /*
   * Nodepod has no shell, so line editing is this module's job — there is no `jsh` underneath to
   * interpret a backspace. Without this a user who corrects a typo sends the DEL byte as part of
   * the command.
   */
  it('applies backspace instead of sending the control byte as text', () => {
    expect(createInputBuffer().push('npm installx\x7f\n')).toEqual([cmd('npm install')]);
    expect(createInputBuffer().push('npm i\x7f\x7fnstall\n')).toEqual([cmd('npmnstall')]);
    expect(createInputBuffer().push('ls\bs\n')).toEqual([cmd('ls')]);
  });

  it('ignores a backspace on an empty buffer rather than underflowing', () => {
    const buf = createInputBuffer();

    expect(buf.push('\x7f\x7f')).toEqual([]);
    expect(buf.pending()).toBe('');
  });
});
