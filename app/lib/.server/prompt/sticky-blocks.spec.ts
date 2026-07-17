/**
 * The block set is part of the CACHED PREFIX, so this file is a money path (SPEC §4.2.8, §4.6).
 *
 * A regression here throws nothing, breaks no feature, and produces correct output. It just makes
 * every edit cost 10x. That is the same category as `opaque-files.spec.ts` — and unlike most of the
 * waste taxonomy, this one was MEASURED live before it was fixed (see `selectStickyBlocks`):
 *
 *   edit 2: blocks=[]                -> +92,385 cached,       0 written ->  12 credits
 *   edit 3: blocks=[racing-system]   -> +0 cached,       114,274 written -> 160 credits
 *
 * Same trivial edit. 13x, decided by the user's choice of words.
 */
import { describe, expect, it } from 'vitest';
import { ON_DEMAND_BLOCKS, selectOnDemandBlocks, selectStickyBlocks } from './sources';

/** A word that routes a given block, taken from the real table rather than invented. */
function keywordFor(id: string): string {
  const block = ON_DEMAND_BLOCKS.find((b) => b.id === id);

  if (!block) {
    throw new Error(`no block ${id}`);
  }

  return block.keywords[0];
}

const ids = (blocks: Array<{ id: string }>) => blocks.map((b) => b.id);

describe('the sticky block router', () => {
  it('keeps a block that an EARLIER message needed', () => {
    const racing = keywordFor('racing-system');

    // turn 1 asks for racing; turn 2 is an unrelated tweak that routes nothing on its own.
    expect(selectOnDemandBlocks('make the boost pad glow'), 'precondition').toEqual([]);

    const sticky = selectStickyBlocks([`build a ${racing} game`, 'make the boost pad glow']);
    expect(ids(sticky)).toContain('racing-system');
  });

  /**
   * 🔴 THE REGRESSION THIS WHOLE FIX EXISTS TO PREVENT.
   *
   * Per-message routing meant rewording an edit changed the prefix. Both of these are the same edit.
   */
  it('routes two phrasings of the same edit IDENTICALLY', () => {
    const brief = 'build a kart racing game with lap times';

    const plain = selectStickyBlocks([brief, 'make the boost pad glow dimmer']);
    const wordy = selectStickyBlocks([
      brief,
      'make the boost pad on the racing track glow brighter for kart lap timing',
    ]);

    expect(ids(plain)).toEqual(ids(wordy));
  });

  /**
   * 🔴 THE HALF THAT IS EASY TO MISS AND SILENTLY UNDOES THE OTHER HALF.
   *
   * `selectOnDemandBlocks` filters `ON_DEMAND_BLOCKS` in DECLARATION order. So a block matched for the
   * first time on turn 2, which happens to be declared EARLY, would be inserted at the FRONT — shifting
   * every block behind it and invalidating the prefix, which is exactly the bug being fixed. "Append-
   * only" has to be true at the byte level, not just as a set.
   *
   * Built from the real table so it cannot drift: pick two blocks and introduce them in REVERSE
   * declaration order.
   */
  it('appends a newly-needed block at the END, never inserting by declaration order', () => {
    const [first, second] = ON_DEMAND_BLOCKS;
    const early = keywordFor(first.id);
    const late = keywordFor(second.id);

    // Mention the LATER-declared block first, so declaration order and first-seen order disagree.
    const turn1 = selectStickyBlocks([late]);
    const turn2 = selectStickyBlocks([late, early]);

    expect(ids(turn1), 'precondition: turn 1 routed exactly one block').toEqual([second.id]);
    expect(ids(turn2), `${first.id} was inserted ahead of ${second.id} — the prefix shifted`).toEqual([
      second.id,
      first.id,
    ]);
  });

  /**
   * The property that makes caching pay, stated directly: every turn's list must be a PREFIX of the
   * next turn's. Not merely a subset — a subset can still have shifted, and a shifted block is a cache
   * miss for everything behind it.
   */
  it('every turn is a byte-prefix of the next, as the conversation grows', () => {
    const messages = [
      'build a kart racing game with lap times',
      'make the boost pad glow dimmer',
      'add HAVOK physics to the crates',
      'wire up the SceneController and a custom overlay HUD',
      'change the title text to hello',
    ];

    let previous: string[] = [];

    for (let i = 1; i <= messages.length; i++) {
      const current = ids(selectStickyBlocks(messages.slice(0, i)));

      expect(current.slice(0, previous.length), `turn ${i} is not a prefix of turn ${i - 1}`).toEqual(previous);
      expect(current.length, `turn ${i} LOST a block — the set must only grow`).toBeGreaterThanOrEqual(previous.length);

      previous = current;
    }
  });

  it('never repeats a block that two messages both ask for', () => {
    const racing = keywordFor('racing-system');
    const sticky = selectStickyBlocks([`a ${racing} game`, `more ${racing} please`, `${racing} again`]);

    expect(ids(sticky)).toEqual([...new Set(ids(sticky))]);
  });

  it('routes nothing for a conversation that needs nothing', () => {
    expect(selectStickyBlocks(['change the title text to hello', 'make it blue'])).toEqual([]);
    expect(selectStickyBlocks([])).toEqual([]);
  });
});
