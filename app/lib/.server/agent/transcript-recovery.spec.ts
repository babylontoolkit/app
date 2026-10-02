/**
 * Data-loss tests. A wrong `null` here loses a paid generation's record; a wrong write downgrades a
 * richer client-saved transcript. Both are silent, which is why the decision is a pure function.
 */
import { describe, expect, it } from 'vitest';
import {
  managedAssistantId,
  planManagedTranscript,
  planTranscriptRecovery,
  type RecoveryPlanInput,
} from './transcript-recovery';

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

describe('planManagedTranscript — the managed engine’s per-request record (T10)', () => {
  const NOW = '2026-10-01T12:00:00.000Z';
  const reply = (content: string, turn = 'sevt_7') => ({
    id: managedAssistantId(turn),
    role: 'assistant',
    content,
    annotations: [{ type: 'agentMeta', value: { engine: 'managed' } }],
  });
  const request = [
    { id: 'u1', role: 'user', content: 'make a racer' },
    { id: 'a1', role: 'assistant', content: 'Built it.' },
    { id: 'u2', role: 'user', content: 'add drift' },
  ];
  const base = {
    serverChatId: 'chat-1',
    requestMessages: request,
    userMessage: { id: 'u2', content: 'add drift' },
    didWork: true,
    now: NOW,
  };

  it('nothing stored yet: the request history + this turn’s user message + the reply', () => {
    const plan = planManagedTranscript({ ...base, existing: null, assistant: reply('Drift added.') });

    expect(plan?.messages).toEqual([
      { id: 'u1', role: 'user', content: 'make a racer' },
      { id: 'a1', role: 'assistant', content: 'Built it.' },
      { id: 'u2', role: 'user', content: 'add drift' },
      reply('Drift added.'),
    ]);
  });

  it('a history rebuilt from the request carries NO file bodies (tags kept)', () => {
    const plan = planManagedTranscript({
      ...base,
      existing: null,
      requestMessages: [
        {
          id: 'a0',
          role: 'assistant',
          content: '<boltAction type="file" filePath="src/a.ts">SECRET_BODY_42</boltAction>',
        },
        ...request,
      ],
      assistant: reply('ok'),
    });

    const stored = JSON.stringify(plan?.messages);

    expect(stored).not.toContain('SECRET_BODY_42');
    expect(stored).toContain('filePath=\\"src/a.ts\\"');
  });

  it('IDEMPOTENT per turn: a resume REPLACES the detached request’s partial reply — one reply, never two', () => {
    const first = planManagedTranscript({ ...base, existing: null, assistant: reply('Starting.') })!;
    const resumed = planManagedTranscript({
      ...base,
      existing: first,

      /* A reload drops the partial reply and re-posts the turn — but the reply id is the SESSION's turn id. */
      userMessage: { id: 'u2', content: 'add drift' },
      assistant: reply('Starting.\n\nDone — drift added.'),
    })!;

    expect(resumed.messages).toHaveLength(first.messages.length);
    expect(resumed.messages.filter((m) => (m as { role: string }).role === 'assistant')).toHaveLength(2);
    expect(resumed.messages.at(-1)).toEqual(reply('Starting.\n\nDone — drift added.'));

    /* Same reply, again: nothing to write. */
    expect(
      planManagedTranscript({ ...base, existing: resumed, assistant: reply('Starting.\n\nDone — drift added.') }),
    ).toBeNull();
  });

  it('NEVER SHRINKS: a shorter reply never replaces a longer stored one', () => {
    const stored = planManagedTranscript({ ...base, existing: null, assistant: reply('A long and complete answer.') })!;

    expect(planManagedTranscript({ ...base, existing: stored, assistant: reply('A long') })).toBeNull();
  });

  it('a turn the CLIENT already saved is left alone (its user message is stored with a reply after it)', () => {
    const clientSaved = {
      serverChatId: 'chat-1',
      createdAt: NOW,
      updatedAt: NOW,
      messages: [...request, { id: 'client-reply', role: 'assistant', content: 'Drift added (rich).' }],
    };

    expect(planManagedTranscript({ ...base, existing: clientSaved, assistant: reply('Drift added.') })).toBeNull();
  });

  it('appends to the stored chat (keeping the client’s richer earlier messages) when the client did not save', () => {
    const stored = {
      serverChatId: 'chat-1',
      title: 'Racer',
      createdAt: NOW,
      updatedAt: NOW,
      messages: [
        { id: 'u1', role: 'user', content: 'make a racer', annotations: ['rich'] },
        { id: 'a1', role: 'assistant', content: 'Built it.', annotations: ['rich'] },
      ],
    };
    const plan = planManagedTranscript({ ...base, existing: stored, assistant: reply('Drift added.') })!;

    expect(plan.title).toBe('Racer');
    expect(plan.messages.slice(0, 2)).toEqual(stored.messages);
    expect(plan.messages.slice(2)).toEqual([{ id: 'u2', role: 'user', content: 'add drift' }, reply('Drift added.')]);
  });

  it('no chat id → nothing', () => {
    expect(
      planManagedTranscript({ ...base, serverChatId: undefined, existing: null, assistant: reply('x') }),
    ).toBeNull();
  });

  it('an EMPTY reply is never stored as a message — the user’s words still are', () => {
    const plan = planManagedTranscript({ ...base, didWork: false, existing: null, assistant: reply('   ') })!;

    expect(plan.messages.map((m) => (m as { id: string }).id)).toEqual(['u1', 'a1', 'u2']);
    expect(plan.messages.some((m) => !(m as { content: string }).content.trim())).toBe(false);

    /* Already stored up to the user message: an empty reply writes nothing at all. */
    expect(planManagedTranscript({ ...base, existing: plan, assistant: reply('') })).toBeNull();

    /* CONTROL: a reply with words is appended after it. */
    expect(planManagedTranscript({ ...base, existing: plan, assistant: reply('Done.') })!.messages.at(-1)).toEqual(
      reply('Done.'),
    );
  });

  it('an empty reply never REPLACES a stored one', () => {
    const stored = planManagedTranscript({ ...base, existing: null, assistant: reply('Partial.') })!;

    expect(planManagedTranscript({ ...base, existing: stored, assistant: reply('') })).toBeNull();
  });
});
