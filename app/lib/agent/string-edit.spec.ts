import { describe, expect, it } from 'vitest';
import { applyStringEdit } from './string-edit';

describe('applyStringEdit — refusals are exact sentences', () => {
  it('refuses an empty old_string', () => {
    expect(applyStringEdit('abc', { old_string: '', new_string: 'x' })).toEqual({
      ok: false,
      error: 'old_string is empty — use write_file to create or replace a whole file.',
    });
  });

  it('refuses identical strings', () => {
    expect(applyStringEdit('abc', { old_string: 'b', new_string: 'b' })).toEqual({
      ok: false,
      error: 'old_string and new_string are identical — nothing to change.',
    });
  });

  it('refuses a string that is not present', () => {
    expect(applyStringEdit('abc', { old_string: 'zz', new_string: 'y' })).toEqual({
      ok: false,
      error:
        'old_string was not found in the file. Re-read it with read_file and copy the text exactly, including whitespace.',
    });
  });

  it('refuses an ambiguous match without replace_all, naming the count', () => {
    expect(applyStringEdit('a b a b a', { old_string: 'a', new_string: 'x' })).toEqual({
      ok: false,
      error: 'old_string occurs 3 times — add surrounding lines to make it unique, or pass replace_all: true.',
    });
  });
});

describe('applyStringEdit — replacements', () => {
  it('replaces a unique occurrence', () => {
    expect(applyStringEdit('const a = 1;\nconst b = 2;', { old_string: 'b = 2', new_string: 'b = 3' })).toEqual({
      ok: true,
      content: 'const a = 1;\nconst b = 3;',
      replacements: 1,
    });
  });

  it('replace_all replaces every occurrence and returns the count', () => {
    expect(applyStringEdit('a b a b a', { old_string: 'a', new_string: 'x', replace_all: true })).toEqual({
      ok: true,
      content: 'x b x b x',
      replacements: 3,
    });
  });

  it('replace_all on a single occurrence counts 1', () => {
    const r = applyStringEdit('one two', { old_string: 'two', new_string: '2', replace_all: true });
    expect(r).toEqual({ ok: true, content: 'one 2', replacements: 1 });
  });

  /* `$&` / `$1` in the replacement must stay literal — String.replace would expand them. */
  it('treats $ patterns in new_string literally', () => {
    const r = applyStringEdit('price', { old_string: 'price', new_string: '`$${cost}` $& $1' });
    expect(r).toEqual({ ok: true, content: '`$${cost}` $& $1', replacements: 1 });
  });

  it('does not normalise CRLF — a LF old_string does not match CRLF text', () => {
    const r = applyStringEdit('a\r\nb', { old_string: 'a\nb', new_string: 'c' });
    expect(r.ok).toBe(false);
  });

  it('non-overlapping count: "aa" in "aaa" occurs once', () => {
    expect(applyStringEdit('aaa', { old_string: 'aa', new_string: 'b' })).toEqual({
      ok: true,
      content: 'ba',
      replacements: 1,
    });
  });
});
