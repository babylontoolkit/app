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
  SHELL_HISTORY_LIMIT,
  buildSearchRegExp,
  classifyWatchEvent,
  createLineEditor,
  findTextMatches,
  flattenTree,
  formatShellPrompt,
  globToRegExp,
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

describe('createLineEditor', () => {
  const cmd = (line: string) => ({ type: 'command', line });
  const PROMPT = '$ ';
  const editor = () => createLineEditor(() => PROMPT);

  /** The actions half — most rules below are about WHAT RAN, not what was drawn. */
  const run = (input: string, on = editor()) => on.push(input).actions;

  it('emits a command only once its newline arrives', () => {
    const on = editor();

    expect(run('npm ', on)).toEqual([]);
    expect(run('install', on)).toEqual([]);
    expect(run('\n', on)).toEqual([cmd('npm install')]);
  });

  it('handles a carriage return from xterm Enter', () => {
    expect(run('ls\r')).toEqual([cmd('ls')]);
  });

  /* CRLF is ONE terminator; consuming it as two executes a spurious empty command per Enter. */
  it('treats CRLF as a single terminator', () => {
    expect(run('ls\r\n')).toEqual([cmd('ls')]);
  });

  /* A PTY splits writes anywhere, so the CR/LF pair can straddle two pushes. */
  it('treats CRLF as one terminator even when split across chunks', () => {
    const on = editor();

    expect(run('ls\r', on)).toEqual([cmd('ls')]);
    expect(run('\n', on)).toEqual([]);
  });

  it('splits multiple commands in one chunk and keeps the partial tail', () => {
    const on = editor();

    expect(run('a\nb\nc', on)).toEqual([cmd('a'), cmd('b')]);
    expect(on.pending()).toBe('c');
    expect(run('\n', on)).toEqual([cmd('c')]);
  });

  it('preserves an intentionally blank line', () => {
    expect(run('\n')).toEqual([cmd('')]);
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
    const on = editor();

    expect(run('\x03', on)).toEqual([{ type: 'interrupt' }]);
    expect(on.pending()).toBe('');
    expect(run('npm install\n', on)).toEqual([cmd('npm install')]);
  });

  /* The exact byte sequence `executeCommand` writes, as one chunk: interrupt first, then the command. */
  it('handles the real executeCommand sequence in one chunk, in order', () => {
    expect(run('\x03npm install\n')).toEqual([{ type: 'interrupt' }, cmd('npm install')]);
  });

  /* Ctrl-C abandons the half-typed line, exactly as a real shell does. */
  it('discards a partially typed line on interrupt', () => {
    const on = editor();

    run('rm -rf /', on);
    expect(run('\x03', on)).toEqual([{ type: 'interrupt' }]);
    expect(on.pending()).toBe('');
    expect(run('\n', on)).toEqual([cmd('')]);
  });

  /*
   * Nodepod has no shell, so line editing is this module's job — there is no `jsh` underneath to
   * interpret a backspace. Without this a user who corrects a typo sends the DEL byte as part of
   * the command.
   */
  it('applies backspace instead of sending the control byte as text', () => {
    expect(run('npm installx\x7f\n')).toEqual([cmd('npm install')]);
    expect(run('npm i\x7f\x7fnstall\n')).toEqual([cmd('npmnstall')]);
    expect(run('ls\bs\n')).toEqual([cmd('ls')]);
  });

  it('ignores a backspace on an empty buffer rather than underflowing', () => {
    const on = editor();

    expect(run('\x7f\x7f', on)).toEqual([]);
    expect(on.pending()).toBe('');
  });

  /*
   * 🔴 THE ECHO IS THE FEATURE.
   *
   * WebContainer's `jsh` and a real PTY both echo what you type; Nodepod has neither, so without
   * these bytes the workbench terminal accepts keystrokes and displays NOTHING until Enter. Nothing
   * throws — the terminal just looks broken, which is precisely how it was reported.
   */
  describe('echo', () => {
    it('echoes printable characters as they are typed', () => {
      expect(editor().push('npm').echo).toBe('npm');
    });

    it('erases the character on backspace at the end of the line', () => {
      const on = editor();
      on.push('ls');

      expect(on.push('\x7f').echo).toBe('\b \b');
    });

    it('echoes CRLF on Enter so output starts on its own row', () => {
      expect(editor().push('ls\r').echo).toBe('ls\r\n');
    });

    it('shows ^C for an interrupt, as a real terminal does', () => {
      expect(editor().push('\x03').echo).toBe('^C\r\n');
    });

    /* A control character with no editing meaning must not be drawn — it would corrupt the line. */
    it('never echoes an unhandled control character', () => {
      expect(editor().push('\x00\x1c\x1f').echo).toBe('');
    });

    /* The redraw repaints the whole row: return to column 0, erase, prompt, buffer. */
    it('repaints the line when an edit lands mid-buffer', () => {
      const on = editor();
      on.push('ls');
      on.push('\x1b[D');

      expect(on.push('x').echo).toBe(`\r\x1b[K${PROMPT}lxs\x1b[1D`);
      expect(on.pending()).toBe('lxs');
    });
  });

  describe('cursor movement', () => {
    it('inserts at the cursor after moving left', () => {
      const on = editor();
      on.push('ls -a');
      on.push('\x1b[D\x1b[D\x1b[D');

      expect(run('X', on)).toEqual([]);
      expect(on.pending()).toBe('lsX -a');
    });

    it('refuses to move past either end', () => {
      const on = editor();
      on.push('ab');

      expect(on.push('\x1b[C').echo).toBe('');
      on.push('\x1b[D\x1b[D');
      expect(on.push('\x1b[D').echo).toBe('');
    });

    it('deletes forward with the Delete key', () => {
      const on = editor();
      on.push('abc');
      on.push('\x1b[D\x1b[D');
      on.push('\x1b[3~');

      expect(on.pending()).toBe('ac');
    });

    it('moves to the start and end of the line', () => {
      const on = editor();
      on.push('bc');
      on.push('\x1b[H');
      on.push('a');
      on.push('\x1b[F');
      on.push('d');

      expect(on.pending()).toBe('abcd');
    });

    /* Ctrl-U kills the line, Ctrl-K kills to the end — both leave a valid buffer, never a stale one. */
    it('kills the line and kills to end of line', () => {
      const on = editor();
      on.push('hello world');
      on.push('\x15');
      expect(on.pending()).toBe('');

      on.push('abcdef');
      on.push('\x1b[D\x1b[D\x1b[D');
      on.push('\x0b');
      expect(on.pending()).toBe('abc');
    });

    /*
     * An escape sequence can straddle a chunk boundary exactly like an OSC one — a PTY splits writes
     * wherever it likes. Losing the tail would leak `[A` into the command as literal text.
     */
    it('parses an escape sequence split across chunks', () => {
      const on = editor();
      on.push('ab');
      on.push('\x1b');
      on.push('[');
      on.push('D');
      on.push('X');

      expect(on.pending()).toBe('aXb');
    });

    /* An unknown sequence is swallowed whole, never partly echoed as text. */
    it('swallows an unrecognised escape sequence', () => {
      const on = editor();
      on.push('\x1b[99;99R');

      expect(on.pending()).toBe('');
    });
  });

  describe('history', () => {
    it('recalls the previous command with the up arrow', () => {
      const on = editor();
      on.push('npm run dev\n');
      on.push('\x1b[A');

      expect(on.pending()).toBe('npm run dev');
      expect(run('\n', on)).toEqual([cmd('npm run dev')]);
    });

    it('walks back through several commands and forward again', () => {
      const on = editor();
      on.push('one\n');
      on.push('two\n');

      on.push('\x1b[A');
      expect(on.pending()).toBe('two');
      on.push('\x1b[A');
      expect(on.pending()).toBe('one');
      on.push('\x1b[B');
      expect(on.pending()).toBe('two');
    });

    /* Walking past the newest entry restores what was being typed, not an empty line. */
    it('restores the in-progress draft when walking forward off the end', () => {
      const on = editor();
      on.push('old\n');
      on.push('half-typed');
      on.push('\x1b[A');
      expect(on.pending()).toBe('old');

      on.push('\x1b[B');
      expect(on.pending()).toBe('half-typed');
    });

    it('does not record blank lines or immediate repeats', () => {
      const on = editor();
      on.push('\n');
      on.push('   \n');
      on.push('ls\n');
      on.push('ls\n');

      on.push('\x1b[A');
      expect(on.pending()).toBe('ls');
      on.push('\x1b[A');
      expect(on.pending()).toBe('ls');
    });

    it('bounds the history rather than growing for the life of the tab', () => {
      const on = editor();

      for (let i = 0; i < SHELL_HISTORY_LIMIT + 25; i++) {
        on.push(`cmd${i}\n`);
      }

      // Walk all the way back: the oldest surviving entry is the limit-th from the end.
      for (let i = 0; i < SHELL_HISTORY_LIMIT + 25; i++) {
        on.push('\x1b[A');
      }

      expect(on.pending()).toBe(`cmd${25}`);
    });
  });
});

describe('formatShellPrompt', () => {
  it('renders the project root as ~ and never as its absolute path', () => {
    const prompt = formatShellPrompt('/home/project', '/home/project');

    expect(prompt).toContain('~');
    expect(prompt).not.toContain('/home/project');
    expect(prompt.endsWith('$ ')).toBe(true);
  });

  it('renders a subdirectory relative to the project root', () => {
    expect(formatShellPrompt('/home/project/src/scripts', '/home/project')).toContain('~/src/scripts');
  });
});

describe('toTerminalNewlines', () => {
  /* xterm treats \n as "down one row" only, so raw Unix output staircases across the screen. */
  it('turns a bare newline into CRLF', () => {
    expect(toTerminalNewlines('a\nb\n')).toBe('a\r\nb\r\n');
  });

  it('leaves an already-correct CRLF alone rather than doubling the CR', () => {
    expect(toTerminalNewlines('a\r\nb')).toBe('a\r\nb');
  });

  /* A lone CR is a progress bar overwriting its own line — rewriting it would break npm's spinner. */
  it('leaves a lone carriage return alone', () => {
    expect(toTerminalNewlines('50%\r75%\r')).toBe('50%\r75%\r');
  });
});

describe('globToRegExp / isSearchCandidate', () => {
  it('matches the exclude globs the workbench actually sends', () => {
    const excludes = ['**/node_modules/**', '**/package-lock.json', '**/.git/**', '**/dist/**', '**/*.lock'];
    const options = { includes: ['**/*.*'], excludes };

    expect(isSearchCandidate('src/scripts/RacerMode.ts', options)).toBe(true);
    expect(isSearchCandidate('node_modules/three/build/three.js', options)).toBe(false);
    expect(isSearchCandidate('package-lock.json', options)).toBe(false);
    expect(isSearchCandidate('pnpm-lock.lock', options)).toBe(false);
    expect(isSearchCandidate('dist/assets/index.js', options)).toBe(false);
  });

  /*
   * 🔴 `**\/x/**` must match the directory `x` itself, not only things under it — the provider tests
   * a trailing-slash form before descending, and a pattern that missed it would walk node_modules
   * and only then discard every file it had already read.
   */
  it('matches the excluded directory itself, so the walk can prune it', () => {
    const options = { includes: [], excludes: ['**/node_modules/**'] };

    expect(isSearchCandidate('node_modules/', options)).toBe(false);
    expect(isSearchCandidate('src/', options)).toBe(true);
  });

  /*
   * 🔴 An empty include list means NO RESTRICTION, never "allow nothing" — the inverted reading
   * returns zero results and is indistinguishable from a project with no matches.
   */
  it('treats an empty include list as no restriction', () => {
    expect(isSearchCandidate('anything.ts', { includes: [], excludes: [] })).toBe(true);
  });

  it('keeps * inside one segment and ** across segments', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
    expect(globToRegExp('**/*.ts').test('src/deep/a.ts')).toBe(true);

    // `**/` spans ZERO segments too, or a root-level file never matches its own include.
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true);
    expect(globToRegExp('a+b.ts').test('aaab_ts')).toBe(false);
  });
});

describe('buildSearchRegExp / findTextMatches', () => {
  const plain = { isRegex: false, caseSensitive: false, isWordMatch: false };

  it('treats a plain query literally, including regex metacharacters', () => {
    const regex = buildSearchRegExp('a.b', plain)!;

    expect(regex.test('a.b')).toBe(true);
    expect(new RegExp(regex.source, regex.flags).test('axb')).toBe(false);
  });

  it('honours case sensitivity and whole-word matching', () => {
    expect(buildSearchRegExp('Game', { ...plain, caseSensitive: true })!.flags).not.toContain('i');
    expect(new RegExp(buildSearchRegExp('cat', { ...plain, isWordMatch: true })!.source).test('concat')).toBe(false);
  });

  /*
   * A search box is half-typed most of the time it is read. An invalid pattern must mean "no
   * matches yet", never a thrown error out of a debounced keystroke.
   */
  it('returns undefined for an unparseable regex instead of throwing', () => {
    expect(buildSearchRegExp('(', { ...plain, isRegex: true })).toBeUndefined();
    expect(buildSearchRegExp('', plain)).toBeUndefined();
  });

  it('reports 1-based lines and columns, one entry per match', () => {
    const matches = findTextMatches('alpha\nbeta gamma beta\n', buildSearchRegExp('beta', plain)!, 100);

    expect(matches).toHaveLength(2);
    expect(matches[0].ranges[0]).toEqual({
      startLineNumber: 2,
      endLineNumber: 2,
      startColumn: 1,
      endColumn: 5,
    });
    expect(matches[1].ranges[0].startColumn).toBe(12);

    // The preview is the line itself, which is what makes the panel's line arithmetic exact.
    expect(matches[0].preview.text).toBe('beta gamma beta');
    expect(matches[0].preview.matches[0].startLineNumber).toBe(2);
  });

  it('stops at the result limit', () => {
    expect(findTextMatches('x\nx\nx\nx\n', buildSearchRegExp('x', plain)!, 2)).toHaveLength(2);
  });

  /* A zero-width match never advances lastIndex — the loop has to, or the search hangs the tab. */
  it('terminates on a zero-width pattern', () => {
    const matches = findTextMatches('ab', buildSearchRegExp('x*', { ...plain, isRegex: true })!, 10);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThanOrEqual(10);
  });
});

describe('looksBinary', () => {
  it('detects a NUL byte in the leading window', () => {
    expect(looksBinary(new Uint8Array([0x00, 0x61, 0x73, 0x6d]))).toBe(true);
  });

  it('passes ordinary source text', () => {
    expect(looksBinary(new TextEncoder().encode('export const x = 1;\n'))).toBe(false);
  });
});
