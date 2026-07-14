/**
 * Search/replace edit blocks — the diff format for `<boltAction type="edit">` (SPEC §4.2.8).
 *
 * ## Why this exists
 *
 * `type="file"` rewrites a file wholesale, so changing one line of a 10,500-character stylesheet costs
 * 10,500 characters of OUTPUT — the most expensive tokens we buy (5x input, and they decode serially at
 * ~110 tok/s, so they are most of the wall clock too). On a creation turn that is unavoidable: the file
 * is genuinely new. On every turn after, it is pure waste — the user asks to change the button colour
 * and pays to have the whole page retyped.
 *
 * An edit block sends only what changed.
 *
 * ## The format, and why THIS format
 *
 *   <<<<<<< SEARCH
 *   .cta { background: #e11; }
 *   =======
 *   .cta { background: #16a; }
 *   >>>>>>> REPLACE
 *
 * Not a unified diff. `@@ -41,7 +41,9 @@` requires the model to count lines and hold an offset in its
 * head, and it is wrong often enough that the repair turns cost more than the diff saved. A search
 * block carries its own context: the anchor IS the content, so there is nothing to miscount.
 *
 * ## The safety property
 *
 * A mis-applied edit is worse than an expensive one — it silently corrupts a file the user did not ask
 * to change, and the failure surfaces later as a mystery. So:
 *
 *   - a SEARCH that matches NOTHING is an error (never "close enough", never fuzzy)
 *   - a SEARCH that matches MORE THAN ONCE is an error (ambiguous — the model must add context)
 *   - blocks apply ALL-OR-NOTHING, to an in-memory copy; the file on disk is written only if every
 *     block landed. A half-applied artifact is never on disk, even for an instant.
 *
 * All three failures throw `EditBlockError`, whose message is written to be read by the MODEL — it is
 * fed back as a repair turn, and it says exactly what to do (re-emit as `type="file"`).
 */

/** One search/replace pair. `search` must appear exactly once in the file. */
export interface EditBlock {
  search: string;
  replace: string;
}

/** A malformed, unmatched, or ambiguous edit. The message is model-facing — keep it actionable. */
export class EditBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditBlockError';
  }
}

const SEARCH_MARKER = /^<{5,9} SEARCH\s*$/;
const DIVIDER_MARKER = /^={5,9}\s*$/;
const REPLACE_MARKER = /^>{5,9} REPLACE\s*$/;

/**
 * Parse the body of an `edit` action into blocks.
 *
 * Deliberately a line-state machine rather than a regex: a regex over the whole body cannot tell you
 * WHICH marker was missing, and "malformed edit block" is a useless thing to hand back to a model that
 * has to fix it.
 */
export function parseEditBlocks(content: string): EditBlock[] {
  const lines = content.split('\n');
  const blocks: EditBlock[] = [];

  let state: 'outside' | 'search' | 'replace' = 'outside';
  let search: string[] = [];
  let replace: string[] = [];

  for (const line of lines) {
    if (SEARCH_MARKER.test(line)) {
      if (state !== 'outside') {
        throw new EditBlockError('Found `<<<<<<< SEARCH` inside an unclosed edit block. Blocks cannot nest.');
      }

      state = 'search';
      search = [];
      replace = [];

      continue;
    }

    if (DIVIDER_MARKER.test(line) && state === 'search') {
      state = 'replace';
      continue;
    }

    if (REPLACE_MARKER.test(line)) {
      if (state !== 'replace') {
        throw new EditBlockError(
          'Found `>>>>>>> REPLACE` without a preceding `=======` divider. Every block is: `<<<<<<< SEARCH`, the old text, `=======`, the new text, `>>>>>>> REPLACE`.',
        );
      }

      blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
      state = 'outside';

      continue;
    }

    if (state === 'search') {
      search.push(line);
    } else if (state === 'replace') {
      replace.push(line);
    }

    /*
     * Anything outside a block is silently dropped. Models like to narrate ("Now updating the header:")
     * between blocks, and rejecting that would fail the edit over prose that changes nothing.
     */
  }

  if (state !== 'outside') {
    throw new EditBlockError('An edit block was left unclosed — it is missing its `>>>>>>> REPLACE` line.');
  }

  if (blocks.length === 0) {
    throw new EditBlockError(
      'An `edit` action contained no search/replace blocks. Use `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`, or emit the file with `type="file"` instead.',
    );
  }

  return blocks;
}

/** How many times `needle` occurs in `haystack` (non-overlapping). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}

/** Shorten a search block for an error message — the model needs to recognise it, not re-read it. */
function excerpt(text: string, maxLines = 4): string {
  const lines = text.split('\n');

  if (lines.length <= maxLines) {
    return text;
  }

  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines)`;
}

/**
 * Apply every block to `source`, in order, and return the new content.
 *
 * Blocks compose: each one matches against the result of the previous, so an edit may legitimately
 * rewrite text that an earlier block in the same action introduced.
 *
 * Throws — never returns partial work. The caller writes to disk only on a clean return.
 */
export function applyEditBlocks(source: string, blocks: EditBlock[], filePath: string): string {
  let result = source;

  for (const [index, block] of blocks.entries()) {
    const position = `Block ${index + 1} of ${blocks.length} for ${filePath}`;

    /*
     * An empty SEARCH matches at every position — it would insert at offset 0 and look like it worked.
     * There is no such thing as an "append" block; use `type="file"` to write a new file.
     */
    if (block.search === '') {
      throw new EditBlockError(`${position} has an empty SEARCH section. There is nothing to find.`);
    }

    const occurrences = countOccurrences(result, block.search);

    if (occurrences === 0) {
      throw new EditBlockError(
        `${position} did not match. The SEARCH text must be copied from the file EXACTLY — every ` +
          `character of indentation, every brace, no re-typing from memory. Not found:\n\n` +
          `${excerpt(block.search)}\n\n` +
          `Re-read the file in the project context and try again, or emit the whole file with ` +
          `\`type="file"\` if it has changed too much to patch.`,
      );
    }

    if (occurrences > 1) {
      throw new EditBlockError(
        `${position} matched ${occurrences} places, so it is ambiguous and was NOT applied. Include ` +
          `more surrounding lines so the SEARCH text is unique. Matched:\n\n${excerpt(block.search)}`,
      );
    }

    result = result.replace(block.search, () => block.replace);
  }

  return result;
}
