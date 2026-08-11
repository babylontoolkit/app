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
      value: {
        model: 'claude-opus-4-8',
        provider: 'KIE',
        history: { messages: 12, chars: 18_000, maxTurns: 30 },
      },
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
      provider: 'KIE',
      attachments: 0,
      attachmentTokens: 0,

      /* The annotation above carries no `savings`, and absent means SAY NOTHING — never zero. */
      savings: null,
    });
  });

  it('carries the GATEWAY that served the turn, not just the model', () => {
    /*
     * `AUTO_MODEL_SELECT` picks a gateway per turn from a preference ladder, and the same model bills
     * materially differently on each — so `model` alone cannot explain a price change between two
     * turns that look identical. `/context` renders this directly under the model for that reason.
     *
     * Mutation that kills it: dropping `provider` from the `updateContextStats` mapping, which would
     * leave the report silently showing the previous turn's gateway (or nothing) forever.
     */
    const turn = (provider: string) => [
      /*
       * `usage` is required: `updateContextStats` ignores an annotation set with no usage AND no
       * history, because that is not a finished turn. A real turn always carries it.
       */
      { type: 'usage', value: { promptTokens: 9_000 } },
      { type: 'agentMeta', value: { model: 'claude-sonnet-5', provider } },
    ];

    updateContextStats(turn('Comet'));
    expect(contextStatsStore.get()?.provider).toBe('Comet');

    // ...and it follows the turn rather than sticking, or a failover would be invisible in the report.
    updateContextStats(turn('Anthropic'));
    expect(contextStatsStore.get()?.provider).toBe('Anthropic');
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

  /**
   * WHAT THE GATEWAY SAVED, VALIDATED BEFORE IT IS RENDERED BESIDE A MONEY NUMBER.
   *
   * This value crosses the wire and is PERSISTED with the message, so a conversation saved by an older
   * build carries no `savings` at all and a partially-written one can carry a `savedCredits` with no
   * `percent`. `NaN%` printed next to a credit charge is worse than printing nothing — and "nothing"
   * is already the designed-for state, so every rejection below degrades to the state the panel
   * already knows how to draw.
   */
  describe('savings', () => {
    const withSavings = (savings: unknown) => [
      // `updateContextStats` returns early with no usage AND no history — a real turn always has usage.
      { type: 'usage', value: { promptTokens: 9_000 } },
      { type: 'agentMeta', value: { model: 'claude-sonnet-5', provider: 'Comet' } },
      { type: 'credits', value: { creditsCharged: 17, savings } },
    ];

    it('carries a well-formed savings annotation through verbatim', () => {
      updateContextStats(withSavings({ basis: 'saved', referenceCredits: 400, savedCredits: 300, percent: 75 }));

      expect(contextStatsStore.get()?.savings).toEqual({
        basis: 'saved',
        referenceCredits: 400,
        savedCredits: 300,
        percent: 75,
      });
    });

    it('accepts full_price — "no discount available" is a real answer, not a malformed one', () => {
      updateContextStats(withSavings({ basis: 'full_price', referenceCredits: 400, savedCredits: 0, percent: 0 }));

      expect(contextStatsStore.get()?.savings?.basis).toBe('full_price');
    });

    it.each([
      ['absent', undefined],
      ['null', null],
      ['a string', '75%'],
      ['a number', 75],
      ['missing percent (a partially-written value)', { basis: 'saved', referenceCredits: 400, savedCredits: 300 }],
      ['a non-finite number', { basis: 'saved', referenceCredits: 400, savedCredits: 300, percent: Number.NaN }],
      [
        'an infinite number',
        { basis: 'saved', referenceCredits: 0, savedCredits: 300, percent: Number.POSITIVE_INFINITY },
      ],
      ['a numeric string', { basis: 'saved', referenceCredits: '400', savedCredits: 300, percent: 75 }],
      ['an unknown basis', { basis: 'discounted', referenceCredits: 400, savedCredits: 300, percent: 75 }],
      ['no basis at all', { referenceCredits: 400, savedCredits: 300, percent: 75 }],
    ])('rejects %s → null, rather than rendering it', (_label, raw) => {
      updateContextStats(withSavings(raw));

      expect(contextStatsStore.get()?.savings).toBeNull();
    });

    /*
     * 🔴 IT MUST NOT STICK, unlike `model` and `provider` directly above it in the same mapping.
     * Those describe a stable CONFIGURATION, so carrying the last known value forward is honest. A
     * saving describes ONE CHARGE — carry it forward and the next turn (a refunded failure, a model
     * Anthropic cannot price, an unmetered turn) inherits a real discount it did not earn, on the one
     * panel a user opens to understand a price.
     */
    it('does NOT carry forward to a turn that reported none', () => {
      updateContextStats(withSavings({ basis: 'saved', referenceCredits: 400, savedCredits: 300, percent: 75 }));
      expect(contextStatsStore.get()?.savings?.savedCredits).toBe(300);

      updateContextStats([{ type: 'usage', value: { promptTokens: 1_000 } }]);
      expect(contextStatsStore.get()?.savings).toBeNull();

      /*
       * The CONTROL, and it is what makes this a test about `savings` rather than about the store
       * simply being replaced: `model` and `provider` — the two fields directly above `savings` in the
       * same mapping, with the same "absent this turn" input — DID carry forward.
       */
      expect(contextStatsStore.get()?.promptTokens).toBe(1_000);
      expect(contextStatsStore.get()?.model).toBe('claude-sonnet-5');
      expect(contextStatsStore.get()?.provider).toBe('Comet');
    });
  });

  it('resetContextStats empties the store and closes the panel', () => {
    updateContextStats(annotations);
    contextPanelOpen.set(true);
    resetContextStats();
    expect(contextStatsStore.get()).toBeNull();
    expect(contextPanelOpen.get()).toBe(false);
  });
});
