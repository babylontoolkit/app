/**
 * Pure-translation tests for the Nodepod adapter.
 *
 * The load-bearing one is "the OSC markers are parsed by the REAL parser": this adapter synthesises a
 * protocol that another module reads, and asserting my own format against my own constant would pass
 * with both halves wrong. `scanOscSignals` is imported from `~/utils/shell` for exactly that reason.
 */
import { describe, expect, it } from 'vitest';
import { scanOscSignals } from '~/utils/shell';
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

describe('watch event mapping', () => {
  it("maps 'change' to change", () => {
    expect(toWatchEventType('change')).toBe('change');
  });

  /* 'rename' cannot distinguish add from remove; guessing 'remove_file' would drop live files. */
  it("maps 'rename' to update_directory rather than guessing add/remove", () => {
    expect(toWatchEventType('rename')).toBe('update_directory');
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

describe('createLineBuffer', () => {
  it('emits a command only once its newline arrives', () => {
    const buf = createLineBuffer();

    expect(buf.push('npm ')).toEqual([]);
    expect(buf.push('install')).toEqual([]);
    expect(buf.push('\n')).toEqual(['npm install']);
  });

  it('handles a carriage return from xterm Enter', () => {
    expect(createLineBuffer().push('ls\r')).toEqual(['ls']);
  });

  /* CRLF is ONE terminator; consuming it as two executes a spurious empty command per Enter. */
  it('treats CRLF as a single terminator', () => {
    expect(createLineBuffer().push('ls\r\n')).toEqual(['ls']);
  });

  it('splits multiple commands in one chunk and keeps the partial tail', () => {
    const buf = createLineBuffer();

    expect(buf.push('a\nb\nc')).toEqual(['a', 'b']);
    expect(buf.pending()).toBe('c');
    expect(buf.push('\n')).toEqual(['c']);
  });

  it('preserves an intentionally blank line', () => {
    expect(createLineBuffer().push('\n')).toEqual(['']);
  });
});
