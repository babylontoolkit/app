/**
 * Restoring a conversation without re-running it (SPEC §4.5.4b).
 *
 * The mark this module applies is the only thing standing between a restored history and the parser
 * writing its months-old file bodies over the project that just came out of the user's repository. So
 * the tests are about the mark surviving, being complete, and never being lost.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from 'ai';
import { hasRestorableHistory, markAsTranscript } from './transcript';
import { isTranscriptMessage, NO_REPLAY } from '~/lib/hooks/useMessageParser';

const message = (over: Partial<Message> = {}): Message =>
  ({ id: 'm1', role: 'assistant', content: 'hi', ...over }) as Message;

describe('marking a restored conversation', () => {
  it('marks every message — one unmarked assistant message is one file overwritten', () => {
    const marked = markAsTranscript([
      message({ id: 'a', role: 'user', content: 'make a racer' }),
      message({ id: 'b', role: 'assistant', content: '<boltAction type="file">…</boltAction>' }),
      message({ id: 'c', role: 'assistant', content: 'done' }),
    ]);

    expect(marked.every(isTranscriptMessage)).toBe(true);
  });

  /** The reader of the mark is the parser. If these two ever disagree, the protection silently lapses. */
  it('uses the mark the parser actually reads', () => {
    expect(markAsTranscript([message()])[0].annotations).toContain(NO_REPLAY);
    expect(isTranscriptMessage(message({ annotations: [NO_REPLAY] }))).toBe(true);
  });

  it('does not consider an ordinary message a transcript', () => {
    expect(isTranscriptMessage(message())).toBe(false);
    expect(isTranscriptMessage(message({ annotations: [] }))).toBe(false);
    expect(isTranscriptMessage(message({ annotations: ['no-store'] }))).toBe(false);
  });

  /**
   * `chatSummary` and `no-store` drive other behaviour. Dropping them here would be a second bug
   * wearing this one's clothes.
   */
  it('keeps the annotations the message already had', () => {
    const summary = { type: 'chatSummary', summary: 'a racing game', chatId: 'x' };
    const marked = markAsTranscript([message({ annotations: ['no-store', summary] as Message['annotations'] })]);

    expect(marked[0].annotations).toContain('no-store');
    expect(marked[0].annotations).toContainEqual(summary);
    expect(marked[0].annotations).toContain(NO_REPLAY);
  });

  it('is idempotent — a re-mount must not stack marks', () => {
    const once = markAsTranscript([message()]);
    const twice = markAsTranscript(once);

    expect(twice[0].annotations).toEqual([NO_REPLAY]);
    expect(twice[0]).toBe(once[0]);
  });

  it('does not mutate the messages it was given', () => {
    const original = message();
    markAsTranscript([original]);

    expect(original.annotations).toBeUndefined();
  });

  it('keeps the id, role and content exactly — this is a record of what happened', () => {
    const original = message({ id: 'm42', role: 'user', content: 'add boost pads' });
    const [marked] = markAsTranscript([original]);

    expect(marked.id).toBe('m42');
    expect(marked.role).toBe('user');
    expect(marked.content).toBe('add boost pads');
  });
});

describe('deciding whether to restore at all', () => {
  it('restores a real conversation', () => {
    expect(hasRestorableHistory([message()])).toBe(true);
  });

  /** A brand-new project. Restoring `[]` over what is on screen would be a regression as a feature. */
  it('does not restore an empty history', () => {
    expect(hasRestorableHistory([])).toBe(false);
  });

  it('survives a server that answers with nothing at all', () => {
    expect(hasRestorableHistory(undefined)).toBe(false);
    expect(hasRestorableHistory(null)).toBe(false);
    expect(hasRestorableHistory({ messages: [] })).toBe(false);
  });
});
