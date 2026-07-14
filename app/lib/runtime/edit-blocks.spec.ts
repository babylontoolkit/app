/**
 * The edit-block format (§4.2.8) — the diff path that keeps follow-up turns cheap.
 *
 * Two things are being protected here, and they pull in opposite directions:
 *
 *   MONEY — an edit must be able to change one line without re-emitting the file. That is the whole
 *   point; a regression here is silent and just makes every turn cost what a creation costs.
 *
 *   CORRECTNESS — an edit must NEVER land in the wrong place. A mis-applied patch corrupts a file the
 *   user did not ask to touch, and they find out much later. So the tests below are mostly about
 *   REFUSING to apply: no match, two matches, half a match. Cheap is worthless if it is also wrong.
 */
import { describe, expect, it } from 'vitest';
import { EditBlockError, applyEditBlocks, parseEditBlocks } from './edit-blocks';

const CSS = `.hero {
  color: red;
}

.cta {
  color: red;
}
`;

describe('parseEditBlocks', () => {
  it('parses a single block', () => {
    const blocks = parseEditBlocks(`<<<<<<< SEARCH
  color: red;
=======
  color: blue;
>>>>>>> REPLACE`);

    expect(blocks).toEqual([{ search: '  color: red;', replace: '  color: blue;' }]);
  });

  it('parses several blocks, and ignores prose between them', () => {
    const blocks = parseEditBlocks(`<<<<<<< SEARCH
a
=======
A
>>>>>>> REPLACE

Now the second one:

<<<<<<< SEARCH
b
=======
B
>>>>>>> REPLACE`);

    expect(blocks).toEqual([
      { search: 'a', replace: 'A' },
      { search: 'b', replace: 'B' },
    ]);
  });

  /** Deleting a run of lines is a legitimate edit: search for them, replace with nothing. */
  it('allows an empty REPLACE section (a deletion)', () => {
    const blocks = parseEditBlocks(`<<<<<<< SEARCH
dead code
=======
>>>>>>> REPLACE`);

    expect(blocks).toEqual([{ search: 'dead code', replace: '' }]);
  });

  it('rejects an unclosed block rather than guessing where it ended', () => {
    expect(() =>
      parseEditBlocks(`<<<<<<< SEARCH
a
=======
A`),
    ).toThrow(/unclosed/i);
  });

  it('rejects a REPLACE marker with no divider before it', () => {
    expect(() =>
      parseEditBlocks(`<<<<<<< SEARCH
a
>>>>>>> REPLACE`),
    ).toThrow(/divider/i);
  });

  it('rejects an action with no blocks at all', () => {
    expect(() => parseEditBlocks('just some prose')).toThrow(/no search\/replace blocks/i);
  });
});

describe('applyEditBlocks', () => {
  it('applies a unique match', () => {
    const blocks = [{ search: '.hero {\n  color: red;\n}', replace: '.hero {\n  color: blue;\n}' }];

    expect(applyEditBlocks(CSS, blocks, 'Home.css')).toContain('.hero {\n  color: blue;\n}');
  });

  it('applies blocks in order, each against the previous result', () => {
    const blocks = [
      { search: '.hero {\n  color: red;\n}', replace: '.hero {\n  color: blue;\n}' },
      { search: '.hero {\n  color: blue;\n}', replace: '.hero {\n  color: green;\n}' },
    ];

    expect(applyEditBlocks(CSS, blocks, 'Home.css')).toContain('color: green');
  });

  /**
   * The single most important test in the file. `  color: red;` appears in BOTH rules. A patcher that
   * takes the first match would silently recolour `.hero` when the user asked about `.cta` — a wrong
   * edit that compiles, ships, and is found by eye three turns later.
   */
  it('refuses an ambiguous match instead of taking the first one', () => {
    const blocks = [{ search: '  color: red;', replace: '  color: blue;' }];

    expect(() => applyEditBlocks(CSS, blocks, 'Home.css')).toThrow(EditBlockError);
    expect(() => applyEditBlocks(CSS, blocks, 'Home.css')).toThrow(/matched 2 places/i);
  });

  /** No fuzzy matching, ever. Close-enough is how a patch lands in the wrong place. */
  it('refuses a near-miss (whitespace differs) rather than fuzzy-matching', () => {
    const blocks = [{ search: '.hero {\n    color: red;\n}', replace: 'x' }];

    expect(() => applyEditBlocks(CSS, blocks, 'Home.css')).toThrow(/did not match/i);
  });

  it('refuses an empty SEARCH, which would otherwise match at offset 0', () => {
    expect(() => applyEditBlocks(CSS, [{ search: '', replace: 'x' }], 'Home.css')).toThrow(/empty SEARCH/i);
  });

  /**
   * All-or-nothing. Block 1 is valid and block 2 is not; the caller must get NOTHING back, so a
   * half-patched file never reaches disk. `applyEditBlocks` works on a copy for exactly this reason.
   */
  it('applies nothing at all when a later block fails', () => {
    const blocks = [
      { search: '.hero {\n  color: red;\n}', replace: '.hero {\n  color: blue;\n}' },
      { search: 'this text is not in the file', replace: 'x' },
    ];

    expect(() => applyEditBlocks(CSS, blocks, 'Home.css')).toThrow(/did not match/i);
    expect(CSS).toContain('.hero {\n  color: red;\n}');
  });

  /**
   * `String.replace` treats `$&`, `$1`, `` $` `` etc. in the REPLACEMENT as capture references. A CSS
   * or TS file can absolutely contain a literal `$&`, and it would be substituted into itself —
   * corruption that no test of "does it patch" would ever catch. The replacer must be a function.
   */
  it('treats `$&` in the replacement as literal text, not a capture reference', () => {
    const source = 'const cost = 0;\n';
    const blocks = [{ search: 'const cost = 0;', replace: "const label = '$& total';" }];

    expect(applyEditBlocks(source, blocks, 'x.ts')).toBe("const label = '$& total';\n");
  });

  it('names the file and the block number, so a failure is actionable', () => {
    const blocks = [
      { search: '.hero {\n  color: red;\n}', replace: 'x' },
      { search: 'nope', replace: 'y' },
    ];

    expect(() => applyEditBlocks(CSS, blocks, 'src/pages/Home.css')).toThrow(/Block 2 of 2 for src\/pages\/Home\.css/);
  });
});
