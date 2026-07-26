import { beforeEach, describe, expect, it } from 'vitest';
import {
  AMBER_HISTORY_CHARS,
  CHARS_PER_TOKEN,
  contextHealth,
  contextPanelOpen,
  contextStatsStore,
  historyWeight,
  RED_HISTORY_CHARS,
  resetContextStats,
  updateContextStats,
} from './context-stats';

describe('contextHealth', () => {
  it('is green for a young conversation', () => {
    expect(contextHealth({ historyMessages: 4, historyChars: 3_000, maxTurns: 30 })).toBe('green');
  });

  it('goes amber at half the server window', () => {
    expect(contextHealth({ historyMessages: 15, historyChars: 5_000, maxTurns: 30 })).toBe('amber');
  });

  it('goes red approaching the window — the point where the server starts forgetting', () => {
    expect(contextHealth({ historyMessages: 27, historyChars: 5_000, maxTurns: 30 })).toBe('red');
  });

  it('char backstop reddens a short-but-fat conversation', () => {
    expect(contextHealth({ historyMessages: 4, historyChars: AMBER_HISTORY_CHARS, maxTurns: 30 })).toBe('amber');
    expect(contextHealth({ historyMessages: 4, historyChars: RED_HISTORY_CHARS, maxTurns: 30 })).toBe('red');
  });

  it('a disabled window (maxTurns 0) falls back to the char rule alone', () => {
    expect(contextHealth({ historyMessages: 500, historyChars: 1_000, maxTurns: 0 })).toBe('green');
  });
});

/*
 * An image carries no characters and is re-sent uncached on every turn after the one it arrived on.
 * A chars-only rule therefore called it FREE and stayed green while the user paid for it forever —
 * the under-reporting direction, which is the one that costs money quietly (§4.2.8).
 */
describe('contextHealth counts attachments, which carry no characters', () => {
  it('reddens a short conversation that is dragging images along', () => {
    const chars = 2_000;
    expect(contextHealth({ historyMessages: 4, historyChars: chars, maxTurns: 30 })).toBe('green');

    // 8 images at the 1,600-token upper bound ≈ 51k char-equivalents: past the red threshold.
    expect(contextHealth({ historyMessages: 4, historyChars: chars, maxTurns: 30, attachmentTokens: 12_800 })).toBe(
      'red',
    );
  });

  it('an absent attachmentTokens behaves exactly as zero (older saved messages)', () => {
    const base = { historyMessages: 4, historyChars: 3_000, maxTurns: 30 };
    expect(contextHealth(base)).toBe(contextHealth({ ...base, attachmentTokens: 0 }));
  });

  it('historyWeight is chars plus attachment tokens in char-equivalents', () => {
    expect(historyWeight({ historyChars: 1_000, attachmentTokens: 100 })).toBe(1_000 + 100 * CHARS_PER_TOKEN);
  });
});

describe('updateContextStats', () => {
  beforeEach(() => resetContextStats());

  const annotations = [
    {
      type: 'usage',
      value: { promptTokens: 9_000, cacheReadTokens: 110_000, cacheCreationTokens: 0, completionTokens: 800 },
    },
    {
      type: 'agentMeta',
      value: { model: 'claude-opus-4-8', history: { messages: 12, chars: 18_000, maxTurns: 30 } },
    },
    { type: 'credits', value: { creditsCharged: 17, balanceAfter: 500 } },
  ];

  it('populates the store from the three server annotations', () => {
    updateContextStats(annotations);
    expect(contextStatsStore.get()).toEqual({
      historyMessages: 12,
      historyChars: 18_000,
      maxTurns: 30,
      promptTokens: 9_000,
      cacheReadTokens: 110_000,
      cacheCreationTokens: 0,
      completionTokens: 800,
      creditsCharged: 17,
      model: 'claude-opus-4-8',
      attachments: 0,
      attachmentTokens: 0,
    });
  });

  it('carries the attachment cost through to the store', () => {
    updateContextStats([
      {
        type: 'usage',
        value: { promptTokens: 9_000 },
      },
      {
        type: 'agentMeta',
        value: { history: { messages: 4, chars: 900, maxTurns: 30, attachments: 3, attachmentTokens: 4_800 } },
      },
    ]);

    const stats = contextStatsStore.get();
    expect(stats?.attachments).toBe(3);
    expect(stats?.attachmentTokens).toBe(4_800);
  });

  /* An older saved message predates these fields; absent must read as zero, never NaN. */
  it('defaults attachment fields to zero for a legacy annotation', () => {
    updateContextStats(annotations);

    const stats = contextStatsStore.get();
    expect(stats?.attachments).toBe(0);
    expect(stats?.attachmentTokens).toBe(0);
  });

  it('ignores messages with no usage or history annotation (a failed or legacy message)', () => {
    updateContextStats([{ type: 'credits', value: { creditsCharged: 0 } }]);
    expect(contextStatsStore.get()).toBeNull();
    updateContextStats(undefined);
    expect(contextStatsStore.get()).toBeNull();
  });

  it('keeps the previous history when a newer message carries only usage', () => {
    updateContextStats(annotations);
    updateContextStats([{ type: 'usage', value: { promptTokens: 1_000 } }]);

    const stats = contextStatsStore.get();
    expect(stats?.historyMessages).toBe(12);
    expect(stats?.promptTokens).toBe(1_000);
  });

  it('resetContextStats empties the store and closes the panel', () => {
    updateContextStats(annotations);
    contextPanelOpen.set(true);
    resetContextStats();
    expect(contextStatsStore.get()).toBeNull();
    expect(contextPanelOpen.get()).toBe(false);
  });
});
