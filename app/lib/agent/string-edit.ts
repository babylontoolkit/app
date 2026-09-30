/**
 * `applyStringEdit` — the pure half of the `edit_file` tool (tool-loop plan D3/D4).
 *
 * Claude Code's `Edit` semantics: replace a LITERAL `old_string` with `new_string`, exactly once unless
 * `replace_all`. Every failure is a sentence the model can act on — the tool returns it as the tool
 * result, never throws (a throw kills a paid generation after the tokens are spent).
 *
 * Client-safe and dependency-free. CRLF is deliberately NOT normalised: the model must copy the text
 * it read, and silently matching across line-ending styles would write a file whose endings changed
 * under the user.
 */
export type StringEditResult = { ok: true; content: string; replacements: number } | { ok: false; error: string };

export function applyStringEdit(
  source: string,
  input: { old_string: string; new_string: string; replace_all?: boolean },
): StringEditResult {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = input;

  if (oldString === '') {
    return { ok: false, error: 'old_string is empty — use write_file to create or replace a whole file.' };
  }

  if (oldString === newString) {
    return { ok: false, error: 'old_string and new_string are identical — nothing to change.' };
  }

  const occurrences = countOccurrences(source, oldString);

  if (occurrences === 0) {
    return {
      ok: false,
      error:
        'old_string was not found in the file. Re-read it with read_file and copy the text exactly, including whitespace.',
    };
  }

  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string occurs ${occurrences} times — add surrounding lines to make it unique, or pass replace_all: true.`,
    };
  }

  /*
   * `split/join` and `indexOf` + slices, never `String.replace(string, string)`: the latter interprets
   * `$&`, `$1`, `$$` in the REPLACEMENT, so a new_string containing `$` (template literals, jQuery-ish
   * code, prices) would be silently rewritten.
   */
  if (replaceAll) {
    return { ok: true, content: source.split(oldString).join(newString), replacements: occurrences };
  }

  const at = source.indexOf(oldString);

  return {
    ok: true,
    content: source.slice(0, at) + newString + source.slice(at + oldString.length),
    replacements: 1,
  };
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let from = 0;

  for (;;) {
    const at = source.indexOf(needle, from);

    if (at === -1) {
      return count;
    }

    count++;
    from = at + needle.length;
  }
}
