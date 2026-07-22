/**
 * Data-loss tests. A wrong `null` here loses a paid generation's record; a wrong write downgrades a
 * richer client-saved transcript. Both are silent, which is why the decision is a pure function.
 */
import { describe, expect, it } from 'vitest';
import { planTranscriptRecovery, type RecoveryPlanInput } from './transcript-recovery';

const base: RecoveryPlanInput = {
  serverChatId: 'f4129a71-1c19-4b92-955f-a597b5aeb60c',
  existing: null,
  requestMessages: [
    { role: 'user', content: 'make a racer' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: '/bt-landing redesign the landing page' },
  ],
  assistantText: 'Here is the redesign…',
  title: 'Arcade Racing',
  now: '2026-07-22T00:00:00.000Z',
};

describe('planTranscriptRecovery', () => {
  /* The measured loss: finish=stop, 427 credits charged, tab died, nothing stored. */
  it('writes the turn when the client never saved it', () => {
    const plan = planTranscriptRecovery(base);
    expect(plan).not.toBeNull();
    expect(plan!.messages).toHaveLength(4);
    expect(plan!.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Here is the redesign…' });
  });

  /*
   * A stored message with no `id` is not renderable by the client, so a recovered chat would re-open
   * broken — no better than the missing transcript it replaced.
   */
  it('gives every stored message an id', () => {
    const plan = planTranscriptRecovery(base)!;
    expect(plan.messages.every((m) => Boolean((m as { id?: string }).id))).toBe(true);
  });

  it("keeps the client's own message ids when it supplied them", () => {
    const plan = planTranscriptRecovery({
      ...base,
      requestMessages: [{ id: 'msg-abc', role: 'user', content: 'hello' }],
    })!;
    expect((plan.messages[0] as { id: string }).id).toBe('msg-abc');
  });

  /* Synthetic ids come from position, never a clock or random source, so recovery is idempotent. */
  it('is deterministic — the same turn recovers to byte-identical output', () => {
    const a = planTranscriptRecovery(base)!;
    const b = planTranscriptRecovery(base)!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keys the object on the SERVER chat id (§4.5.6)', () => {
    expect(planTranscriptRecovery(base)!.serverChatId).toBe('f4129a71-1c19-4b92-955f-a597b5aeb60c');
  });

  /*
   * Minting an id here would create a second chat the client never adopts — the §4.5.6 duplicate. The
   * first turn of a brand-new chat is deliberately uncovered rather than covered wrongly.
   */
  it('does nothing without a server chat id', () => {
    expect(planTranscriptRecovery({ ...base, serverChatId: undefined })).toBeNull();
  });

  it('does nothing when the model produced no text — a failure refunds, it is not a record', () => {
    expect(planTranscriptRecovery({ ...base, assistantText: '' })).toBeNull();
    expect(planTranscriptRecovery({ ...base, assistantText: '   \n ' })).toBeNull();
  });

  /*
   * 🔴 The one that matters most. The client's copy carries annotations, the NO_REPLAY mark, tool
   * invocations and artifact structure; this module reconstructs none of that. Overwriting a saved
   * transcript with this plainer one is a silent downgrade.
   */
  it('never shrinks a conversation the client already saved', () => {
    const existing = {
      serverChatId: base.serverChatId!,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      messages: [{}, {}, {}, {}],
    };
    expect(planTranscriptRecovery({ ...base, existing })).toBeNull();
  });

  it('also declines when the stored copy is LONGER — the race loser must not clobber the winner', () => {
    const existing = {
      serverChatId: base.serverChatId!,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      messages: [{}, {}, {}, {}, {}, {}],
    };
    expect(planTranscriptRecovery({ ...base, existing })).toBeNull();
  });

  it('does write when the stored copy is stale — the turn is genuinely missing', () => {
    const existing = {
      serverChatId: base.serverChatId!,
      title: 'Arcade Racing',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      messages: [{}, {}],
    };
    const plan = planTranscriptRecovery({ ...base, existing });
    expect(plan).not.toBeNull();
    expect(plan!.messages).toHaveLength(4);
  });

  /* A recovered chat must not appear to have been created today, or the sidebar reorders itself. */
  it('preserves the original createdAt and title when recovering an existing chat', () => {
    const existing = {
      serverChatId: base.serverChatId!,
      title: 'The Real Title',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      messages: [{}],
    };
    const plan = planTranscriptRecovery({ ...base, existing })!;
    expect(plan.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(plan.title).toBe('The Real Title');
    expect(plan.updatedAt).toBe(base.now);
  });

  /* System notes and tool scaffolding are ours, not the conversation — they must not be stored. */
  it('keeps only user and assistant turns', () => {
    const plan = planTranscriptRecovery({
      ...base,
      requestMessages: [
        { role: 'system', content: 'platform instructions' },
        { role: 'user', content: 'hello' },
      ],
    })!;
    expect(plan.messages).toMatchObject([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Here is the redesign…' },
    ]);
  });
});
