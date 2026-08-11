/**
 * The open/close counter that decides whether a turn was cut off mid-write.
 *
 * A miscount is expensive in BOTH directions: too low and every healthy build looks truncated and buys
 * a second billed pass; too high and the Pac-Man failure (240 credits, no file, an artifact card with
 * no rows) is accepted as a success again. So the split-delta cases get the most attention — that is
 * the only genuinely subtle part, and a provider splits tags wherever it likes.
 */
import { describe, expect, it } from 'vitest';
import { ACTION_CLOSE_TAG, ACTION_OPEN_TAG, createTagCounter, isTruncatedAction } from './action-tags';

/** Feed a whole string one chunk at a time and return the final count. */
const countIn = (needle: string, chunks: string[]) => {
  const counter = createTagCounter(needle);
  chunks.forEach((chunk) => counter.push(chunk));

  return counter.count;
};

describe('createTagCounter', () => {
  it('counts a tag arriving whole', () => {
    expect(countIn(ACTION_OPEN_TAG, ['<boltAction type="file">hello</boltAction>'])).toBe(1);
  });

  it('counts several tags in one delta', () => {
    expect(countIn(ACTION_CLOSE_TAG, ['a</boltAction>b</boltAction>c'])).toBe(2);
  });

  /* 🔴 The reason the tail exists. */
  it('counts a tag split across two deltas', () => {
    expect(countIn(ACTION_OPEN_TAG, ['prose <boltAct', 'ion type="file">'])).toBe(1);
  });

  it('counts a tag split one character at a time', () => {
    expect(countIn(ACTION_CLOSE_TAG, ACTION_CLOSE_TAG.split(''))).toBe(1);
  });

  /* 🔴 The tail must not let an already-counted tag be seen twice at the boundary. */
  it('does not double-count a tag that lands exactly on a delta boundary', () => {
    expect(countIn(ACTION_CLOSE_TAG, ['x</boltAction>', 'y'])).toBe(1);
  });

  it('does not count a partial tag that never completes', () => {
    expect(countIn(ACTION_OPEN_TAG, ['trailing <boltAct'])).toBe(0);
  });

  it('ignores empty deltas', () => {
    expect(countIn(ACTION_OPEN_TAG, ['<boltAction', '', ' type="file">'])).toBe(1);
  });

  /* An open tag is a PREFIX of nothing else here, but the close tag contains the open tag's letters. */
  it('does not mistake a close tag for an open tag', () => {
    expect(countIn(ACTION_OPEN_TAG, ['</boltAction>'])).toBe(0);
  });

  /* CONTROL — the counter must be capable of returning zero, or every assertion above is trivial. */
  it('CONTROL: counts nothing in ordinary prose', () => {
    expect(countIn(ACTION_OPEN_TAG, ['Rebuilding the Pac-Man player properly.'])).toBe(0);
  });
});

describe('isTruncatedAction', () => {
  /* 🔴 The measured Pac-Man failure: one open, zero closes. */
  it('reports the measured failure as truncated', () => {
    expect(isTruncatedAction(1, 0)).toBe(true);
  });

  it('is not truncated when every action closed', () => {
    expect(isTruncatedAction(3, 3)).toBe(false);
  });

  it('is not truncated when nothing was written at all', () => {
    expect(isTruncatedAction(0, 0)).toBe(false);
  });

  /*
   * A stray close with no open is a parser oddity, not a truncation — rescuing on it would spend a
   * second pass on a turn whose files all landed.
   */
  it('does not treat an unmatched CLOSE as truncation', () => {
    expect(isTruncatedAction(1, 2)).toBe(false);
  });
});

/**
 * 🔴 The full shape of the failure, end to end: the exact tail of the real transcript.
 *
 * `gen_msn0zl5h_44wpni` ended on the literal text `>>>>>>> REPLACE` with no closing tags. This is that
 * stream, chunked the way a provider would send it.
 */
describe('the Pac-Man transcript, replayed', () => {
  const CHUNKS = [
    'Your reference image is the classic pie-wedge. Rebuilding it properly.\n\n',
    '<boltArtifact id="pacman" title="Authentic Pac-Man: upper/lower jaw wedge, black eyes">\n',
    '<boltAction type="edit" filePath="src/scripts/Game3dPacManMode.ts">\n',
    '<<<<<<< SEARCH\n      p.root.scaling.set(s, s * squash, s);\n=======\n',
    '            if (this.pacJawA) this.pacJawA.rotation.x = -open;\n',
    '>>>>>>> REPLACE',
  ];

  it('sees one open and zero closes, i.e. truncated', () => {
    const opens = createTagCounter(ACTION_OPEN_TAG);
    const closes = createTagCounter(ACTION_CLOSE_TAG);

    for (const chunk of CHUNKS) {
      opens.push(chunk);
      closes.push(chunk);
    }

    expect(opens.count).toBe(1);
    expect(closes.count).toBe(0);
    expect(isTruncatedAction(opens.count, closes.count)).toBe(true);
  });

  /* CONTROL — the same stream, properly closed, is NOT truncated. */
  it('CONTROL: the same artifact closed properly is healthy', () => {
    const opens = createTagCounter(ACTION_OPEN_TAG);
    const closes = createTagCounter(ACTION_CLOSE_TAG);

    for (const chunk of [...CHUNKS, '\n</boltAction>\n</boltArtifact>']) {
      opens.push(chunk);
      closes.push(chunk);
    }

    expect(isTruncatedAction(opens.count, closes.count)).toBe(false);
  });
});
