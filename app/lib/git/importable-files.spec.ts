/**
 * What a clone may QUOTE into its import artifact (T1, `_specs/server-side-git-clone_plan.md`).
 *
 * 🔴 **THE BYTES ARE ALREADY ON DISK.** `gitClone` writes every file into the sandbox before this
 * function runs, so nothing here can lose a file — it can only decide what the artifact says. That
 * asymmetry is the whole reason these rules are safe, and it is also why getting them backwards
 * CORRUPTS files rather than merely omitting them: an artifact quoting a mangled body is replayed by
 * the action runner, which writes that body back **over the correct bytes** (§1.3 principle 10).
 *
 * `GitCloneButton` shipped exactly that defect. It decoded with a **non-fatal** `TextDecoder`, gated
 * only on a text-EXTENSION allow-list containing `.svg`, `.json`, `.xml` and `.md` — so a gzipped
 * `.svg`, or a `.json` carrying invalid UTF-8, was silently U+FFFD-replaced and then written back
 * lossy. It also dropped anything over 100KB.
 *
 * The properties pinned below, each of which fails SILENTLY if it regresses:
 *
 *   - a `.png`, a `.wasm` and an **invalid-UTF-8 `.svg`** are all omitted, and NONE of them is
 *     mutated on the way past;
 *   - a valid-UTF-8 `.svg` IS still included — the fix is "ask the bytes", not "distrust the
 *     extension", and a blanket exclusion would be a different, quieter regression;
 *   - a text file over 100KB survives, because the size caps are gone;
 *   - and the **CONTROL**: the same bytes decoded non-fatally yield U+FFFD. Without it, a test
 *     asserting "excluded" cannot tell a fatal decoder from a non-fatal one that happened to be
 *     paired with a wider extension list — which is precisely how the original defect survived
 *     review. The distinction is invisible unless something demonstrates it.
 */
import { describe, expect, it } from 'vitest';
import { selectImportableFiles, type ClonedFileEntry } from './importable-files';

/**
 * A gzip member's opening bytes. `0x8b` is a continuation byte with no lead, so this is invalid
 * UTF-8 by construction — and it is realistic: `.svg.gz` content served under an `.svg` name is the
 * exact shape that broke the old allow-list.
 */
const GZIP_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);

/** A PNG signature — invalid UTF-8 too, but excluded on its extension before any decode. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);

/** A WebAssembly module header (`\0asm` + version 1). */
const WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff]);

/** A lone UTF-16 BOM read as UTF-8: two continuation-shaped bytes, no lead. */
const LONE_CONTINUATION = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);

const bytes = (data: Uint8Array): ClonedFileEntry => ({ data });
const text = (data: string): ClonedFileEntry => ({ data });

const utf8 = (value: string) => new TextEncoder().encode(value);

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8"/></svg>';

/**
 * 🔴 THE CONTROL.
 *
 * Every "it was excluded" assertion in this file is only meaningful if these bytes would otherwise
 * have been ACCEPTED and quietly mangled. This proves both halves against the real platform
 * decoder: non-fatal succeeds and hands back replacement characters; fatal throws. If a future
 * refactor drops `{ fatal: true }`, the exclusion tests below start failing — because this test
 * establishes that the input is decodable-but-wrong rather than simply undecodable.
 */
describe('CONTROL — a non-fatal decoder would silently mangle these bytes', () => {
  it.each([
    ['gzip header', GZIP_BYTES],
    ['lone continuation bytes', LONE_CONTINUATION],
    ['png signature', PNG_BYTES],
    ['wasm header', WASM_BYTES],
  ])('%s: non-fatal yields U+FFFD, fatal refuses', (_label, input) => {
    const mangled = new TextDecoder('utf-8').decode(input);

    expect(mangled).toContain('�');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(input)).toThrow();
  });

  /*
   * And the reason mangling is not merely cosmetic: the replacement is LOSSY, so nothing downstream
   * can recover the original bytes from the quoted text. Re-encoding the mangled string produces a
   * different byte sequence — which is what the action runner would write back to disk.
   */
  it('the mangled text cannot round-trip back to the original bytes', () => {
    const mangled = new TextDecoder('utf-8').decode(GZIP_BYTES);
    const reencoded = utf8(mangled);

    expect(Array.from(reencoded)).not.toEqual(Array.from(GZIP_BYTES));
  });
});

describe('a binary file is omitted from the artifact and never mutated', () => {
  const clone: Record<string, ClonedFileEntry> = {
    'public/logo.png': bytes(PNG_BYTES),
    'public/havok.wasm': bytes(WASM_BYTES),
    'public/icons/sprite.svg': bytes(GZIP_BYTES),
    'src/main.ts': text('export const go = () => 1;\n'),
  };

  it('omits a .png, a .wasm, and an .svg whose bytes are not valid UTF-8', () => {
    const { files, excluded } = selectImportableFiles(clone);

    expect(files.map((file) => file.path)).toEqual(['src/main.ts']);
    expect(excluded).toEqual(['public/havok.wasm', 'public/icons/sprite.svg', 'public/logo.png']);
  });

  /*
   * The bytes are the project's only copy on the way through here. A selector that trimmed, decoded
   * in place, or otherwise touched the input would corrupt files that were perfectly fine on disk.
   */
  it('mutates none of them', () => {
    const before = Object.fromEntries(
      Object.entries(clone).map(([path, entry]) => [
        path,
        typeof entry.data === 'string' ? entry.data : Array.from(entry.data),
      ]),
    );

    selectImportableFiles(clone);

    for (const [path, entry] of Object.entries(clone)) {
      expect(typeof entry.data === 'string' ? entry.data : Array.from(entry.data)).toEqual(before[path]);
    }
  });

  /*
   * ⚠️ THE ONE THAT PROVES THE FIX IS THE RIGHT SHAPE. "Exclude every .svg" would pass the test
   * above and be wrong: SVGs are ordinary text and a project's icons belong in the artifact. The
   * question is about the BYTES, and an extension is only ever a guess about them.
   */
  it('still includes an .svg that really is valid UTF-8', () => {
    const { files, excluded } = selectImportableFiles({
      'public/icons/ok.svg': bytes(utf8(VALID_SVG)),
      'public/icons/bad.svg': bytes(GZIP_BYTES),
    });

    expect(files).toEqual([{ path: 'public/icons/ok.svg', content: VALID_SVG }]);
    expect(excluded).toEqual(['public/icons/bad.svg']);
  });

  /* Same rule, the other extension the old allow-list waved through. */
  it('excludes a .json whose bytes are not valid UTF-8, and keeps one that is', () => {
    const { files, excluded } = selectImportableFiles({
      'package.json': bytes(utf8('{"name":"game"}')),
      'data/blob.json': bytes(LONE_CONTINUATION),
    });

    expect(files).toEqual([{ path: 'package.json', content: '{"name":"game"}' }]);
    expect(excluded).toEqual(['data/blob.json']);
  });

  /*
   * A `fatal` TextDecoder is stateless between `decode()` calls, but only while nothing makes it
   * streaming. If it ever does, one bad file poisons the next — so prove a throw does not disturb
   * the files after it.
   */
  it('a refused file does not poison the ones that follow it', () => {
    const { files } = selectImportableFiles({
      'a.txt': bytes(utf8('first')),
      'b.svg': bytes(GZIP_BYTES),
      'c.txt': bytes(utf8('third')),
    });

    expect(files).toEqual([
      { path: 'a.txt', content: 'first' },
      { path: 'c.txt', content: 'third' },
    ]);
  });
});

/**
 * The size caps are GONE. `GitCloneButton` dropped any file over 100KB and stopped entirely at
 * 500KB total — a cap that bought nothing (the artifact never delivered the bytes) and cost a
 * truthful record of the import. A big source file is exactly the one a user asks about first.
 */
describe('there are no size caps', () => {
  it('includes a text file well over the old 100KB limit', () => {
    const big = 'x'.repeat(300 * 1024);

    const { files, excluded } = selectImportableFiles({ 'src/huge.ts': text(big) });

    expect(excluded).toEqual([]);
    expect(files).toEqual([{ path: 'src/huge.ts', content: big }]);
  });

  it('does not stop after the old 500KB total, either', () => {
    const chunk = 'y'.repeat(200 * 1024);

    const { files } = selectImportableFiles({
      'a.ts': text(chunk),
      'b.ts': text(chunk),
      'c.ts': text(chunk),
      'd.ts': text(chunk),
    });

    expect(files.map((file) => file.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });
});

describe('ignored paths are separated from unquotable ones', () => {
  /*
   * 🔴 `ignored` and `excluded` are TWO LISTS because they are two different facts, and the caller
   * shows only one of them. "We could not quote this file" is worth telling a user; "node_modules was
   * not interesting" is not — and the import message is model-visible text on every later turn
   * (§4.2.8), so naming `.git/objects/pack/*.pack` in it costs tokens forever and says nothing. The
   * inline code this replaced filtered ignored paths out BEFORE building its list, so they were never
   * named; folding them together would have been a silent regression dressed as extra honesty.
   */
  it('drops node_modules and .git into `ignored`, never into `excluded`', () => {
    const { files, excluded, ignored } = selectImportableFiles({
      'node_modules/react/index.js': text('module.exports = {};'),
      '.git/HEAD': text('ref: refs/heads/main'),
      'dist/bundle.js': text('console.log(1)'),
      '.DS_Store': text('junk'),
      'debug.log': text('noise'),
      'src/main.ts': text('export {};'),
    });

    expect(files.map((file) => file.path)).toEqual(['src/main.ts']);
    expect(ignored).toEqual(['.DS_Store', '.git/HEAD', 'debug.log', 'dist/bundle.js', 'node_modules/react/index.js']);
    expect(excluded).toEqual([]);
  });

  /* The split only means something if a real binary still lands in `excluded` beside them. */
  it('keeps a binary in `excluded` while ignored noise goes elsewhere', () => {
    const { excluded, ignored } = selectImportableFiles({
      'node_modules/x/y.js': text('1'),
      'public/logo.png': bytes(PNG_BYTES),
    });

    expect(excluded).toEqual(['public/logo.png']);
    expect(ignored).toEqual(['node_modules/x/y.js']);
  });

  /*
   * Upstream keeps the lockfile deliberately (`npm install` is much faster with it). It is OPAQUE
   * rather than ignored — the distinction lives in `~/lib/context/opaque-files`, and re-adding it to
   * IGNORE_PATTERNS here would slow every import while looking like tidying.
   */
  it('keeps package-lock.json, which is opaque rather than ignored', () => {
    const { files } = selectImportableFiles({ 'package-lock.json': text('{}') });

    expect(files.map((file) => file.path)).toEqual(['package-lock.json']);
  });
});

describe('the shape of the result', () => {
  /*
   * A string entry was already decoded upstream; re-encoding it to run it past the decoder would be
   * a second chance to be lossy for no gain.
   */
  it('passes a string entry through byte-for-byte', () => {
    const content = 'const emoji = "🎮";\n// ünïcödé\n';

    const { files } = selectImportableFiles({ 'src/main.ts': { data: content, encoding: 'utf8' } });

    expect(files).toEqual([{ path: 'src/main.ts', content }]);
  });

  /* An empty clone is not an error, and must not produce phantom entries. */
  it('handles an empty map', () => {
    expect(selectImportableFiles({})).toEqual({ files: [], excluded: [], ignored: [] });
  });

  /*
   * Ordering is SORTED, not insertion order. `gitClone`'s map arrives in whatever order the objects
   * were walked, so an unsorted artifact would differ run to run for an identical repo — churn in a
   * body that reaches the model and is paid for on every later turn (§4.2.8).
   */
  it('orders both lists deterministically, whatever order the clone walked', () => {
    const forwards = selectImportableFiles({
      'src/z.ts': text('z'),
      'src/a.ts': text('a'),
      'node_modules/z/index.js': text('z'),
      'node_modules/a/index.js': text('a'),
    });

    const backwards = selectImportableFiles({
      'node_modules/a/index.js': text('a'),
      'node_modules/z/index.js': text('z'),
      'src/a.ts': text('a'),
      'src/z.ts': text('z'),
    });

    expect(forwards.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(forwards.ignored).toEqual(['node_modules/a/index.js', 'node_modules/z/index.js']);
    expect(backwards).toEqual(forwards);
  });

  /*
   * Neither list may swallow a path: a file the artifact does not quote must still be REPORTED, or
   * the import quietly under-describes what arrived. Every input path lands in exactly one list.
   */
  it('accounts for every input path exactly once', () => {
    const clone: Record<string, ClonedFileEntry> = {
      'src/main.ts': text('export {};'),
      'public/logo.png': bytes(PNG_BYTES),
      'public/icons/bad.svg': bytes(GZIP_BYTES),
      'node_modules/react/index.js': text('x'),
      'README.md': bytes(utf8('# hi')),
    };

    const { files, excluded, ignored } = selectImportableFiles(clone);
    const seen = [...files.map((file) => file.path), ...excluded, ...ignored].sort();

    expect(seen).toEqual(Object.keys(clone).sort());

    // And the three lists are disjoint — a path in two of them would still satisfy the count above.
    expect(new Set(seen).size).toBe(seen.length);
  });
});
