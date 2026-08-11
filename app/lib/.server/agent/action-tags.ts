/**
 * Counting `<boltAction>` opens and closes across a STREAM — the signal that says whether a turn
 * actually finished writing what it announced.
 *
 * ## Why this is its own module
 *
 * It decides whether a generation is rescued (a second billed pass) or accepted as a success, so it
 * spends the user's money in both directions. It shipped inline in `proxy.ts`, where nothing could
 * reach it: the proxy cannot be constructed in a unit test, and `execution-queue.ts` records what that
 * costs — "a behaviour no test can reach is how a one-line bug survives".
 *
 * ## The one hard part
 *
 * A provider may split a tag across two text deltas — `<boltAct` then `ion type="file">` — so a
 * containment test on each delta alone never sees it. Every counter therefore carries `needle.length - 1`
 * characters of the previous delta as a lookback tail. Get that wrong and the count is silently low,
 * which reads as "this turn was truncated" on a perfectly healthy build and buys a second pass nobody
 * needed, on every generation.
 */

/** A running count of one needle over a stream of deltas. */
export interface TagCounter {
  /** Feed the next text delta. */
  push(delta: string): void;

  /** How many complete, non-overlapping occurrences have been seen so far. */
  readonly count: number;
}

/**
 * Count occurrences of `needle` across deltas that may split it anywhere.
 *
 * Non-overlapping by design: the search resumes AFTER each hit, so `<boltAction<boltAction` is two and
 * a self-overlapping needle can never double-count.
 */
export function createTagCounter(needle: string): TagCounter {
  let tail = '';
  let total = 0;

  return {
    push(delta: string) {
      if (!delta) {
        return;
      }

      const window = tail + delta;
      let at = window.indexOf(needle);

      while (at !== -1) {
        total += 1;
        at = window.indexOf(needle, at + needle.length);
      }

      /*
       * Carry one character less than the needle: that is the longest PARTIAL match that could still
       * complete on the next delta. Carrying the full length would let an already-counted occurrence
       * sitting exactly at the boundary be counted a second time.
       */
      tail = window.slice(-(needle.length - 1));
    },

    get count() {
      return total;
    },
  };
}

export const ACTION_OPEN_TAG = '<boltAction';
export const ACTION_CLOSE_TAG = '</boltAction>';

/**
 * Did the stream stop mid-action?
 *
 * 🔴 More opens than closes means the action runner never executed the last one, so **no file was
 * written** — however much prose surrounded it. Measured live 2026-08-10 (`gen_msn0zl5h_44wpni`): one
 * open, zero closes, 240 credits, an artifact card with no rows under it.
 *
 * Deliberately `>` and not `!==`: a stray close with no open is a different (and harmless) parser
 * oddity, and treating it as truncation would rescue a turn that wrote its files.
 */
export function isTruncatedAction(opened: number, closed: number): boolean {
  return opened > closed;
}
