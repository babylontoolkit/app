import { beforeEach, describe, expect, it } from 'vitest';
import {
  AMBER_HISTORY_CHARS,
  contextHealth,
  contextPanelOpen,
  contextStatsStore,
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
    });
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
