/**
 * The session-event reducer (`events.ts`, managed-agents-engine T5): each event type → the chunk, tool
 * call or terminal it means. Pure — no client, no stores.
 */
import { describe, expect, it } from 'vitest';
import { createEventReducer } from './events';

const message = (id: string, text: string) => ({ type: 'agent.message', id, content: [{ type: 'text', text }] });
const idle = (id: string, type: string, explanation?: string) => ({
  type: 'session.status_idle',
  id,
  stop_reason: { type },
  stop_details: explanation ? { type: 'refusal', explanation, category: null } : null,
});

describe('createEventReducer', () => {
  it('agent.message → a text chunk; consecutive messages are separate paragraphs', () => {
    const r = createEventReducer();

    expect(r.apply(message('m1', 'Reading the project.')).chunks).toEqual([
      { type: 'text', value: 'Reading the project.' },
    ]);
    expect(r.apply(message('m2', 'Writing the kart.')).chunks).toEqual([
      { type: 'text', value: '\n\nWriting the kart.' },
    ]);
    expect(r.producedText).toBe(true);
  });

  it('streams message deltas, then the whole message adds only what the deltas did not show', () => {
    const r = createEventReducer();

    r.apply({ type: 'event_start', event: { id: 'm1', type: 'agent.message' } });
    expect(
      r.apply({
        type: 'event_delta',
        event_id: 'm1',
        delta: { type: 'content_delta', content: { type: 'text', text: 'Hel' } },
      }).chunks,
    ).toEqual([{ type: 'text', value: 'Hel' }]);
    expect(r.apply(message('m1', 'Hello')).chunks).toEqual([{ type: 'text', value: 'lo' }]);

    /* CONTROL: a whole message whose deltas already showed it all adds nothing (no double text). */
    r.apply({ type: 'event_start', event: { id: 'm2', type: 'agent.message' } });
    r.apply({
      type: 'event_delta',
      event_id: 'm2',
      delta: { type: 'content_delta', content: { type: 'text', text: 'Done.' } },
    });
    expect(r.apply(message('m2', 'Done.')).chunks).toEqual([]);
  });

  it('thinking deltas go to the REASONING channel, never to text', () => {
    const r = createEventReducer();

    r.apply({ type: 'event_start', event: { id: 't1', type: 'agent.thinking' } });

    const out = r.apply({
      type: 'event_delta',
      event_id: 't1',
      delta: { type: 'content_delta', content: { type: 'text', text: 'plan' } },
    });

    expect(out.chunks).toEqual([{ type: 'reasoning', value: 'plan' }]);
    expect(r.producedText).toBe(false);
  });

  it('a delta whose event_start was never seen is dropped (never guessed onto the text channel)', () => {
    const r = createEventReducer();

    expect(
      r.apply({
        type: 'event_delta',
        event_id: 'tX',
        delta: { type: 'content_delta', content: { type: 'text', text: 'secret' } },
      }).chunks,
    ).toEqual([]);
  });

  it('agent.custom_tool_use → a tool call with the event id', () => {
    const r = createEventReducer();
    const out = r.apply({
      type: 'agent.custom_tool_use',
      id: 'sevt_9',
      name: 'project_write',
      input: { path: 'a.ts', content: 'x' },
    });

    expect(out.toolCall).toEqual({ id: 'sevt_9', name: 'project_write', input: { path: 'a.ts', content: 'x' } });
  });

  it('dedupes by event id — a replayed event yields nothing the second time', () => {
    const r = createEventReducer();

    expect(r.apply(message('m1', 'Once')).chunks).toHaveLength(1);
    expect(r.apply(message('m1', 'Once')).chunks).toEqual([]);
    expect(r.apply({ type: 'agent.custom_tool_use', id: 'c1', name: 'check_game', input: {} }).toolCall).toBeDefined();
    expect(
      r.apply({ type: 'agent.custom_tool_use', id: 'c1', name: 'check_game', input: {} }).toolCall,
    ).toBeUndefined();
  });

  it('span.model_request_end counts a model request', () => {
    const r = createEventReducer();

    expect(r.apply({ type: 'span.model_request_end', id: 's1', model_usage: {} }).modelRequest).toBe(true);
    expect(r.modelRequests).toBe(1);
  });

  it('end_turn ends the turn only after this turn showed activity (a stale idle cannot end it)', () => {
    const fresh = createEventReducer();

    expect(fresh.apply(idle('i0', 'end_turn')).terminal).toBeUndefined();
    fresh.apply({ type: 'session.status_running', id: 'r1' });
    expect(fresh.apply(idle('i1', 'end_turn')).terminal).toEqual({ kind: 'end_turn' });

    /* A resume whose replay already holds the turn starts "active". */
    expect(createEventReducer({ seenActivity: true }).apply(idle('i2', 'end_turn')).terminal).toEqual({
      kind: 'end_turn',
    });
  });

  it('requires_action is never terminal; budget_reached pauses; retries/refusal/terminated fail', () => {
    const r = createEventReducer({ seenActivity: true });

    expect(r.apply(idle('a', 'requires_action')).terminal).toBeUndefined();
    expect(r.apply(idle('b', 'budget_reached')).terminal).toEqual({ kind: 'budget' });
    expect(r.apply(idle('c', 'retries_exhausted')).terminal).toMatchObject({
      kind: 'failed',
      reason: 'retries_exhausted',
    });
    expect(r.apply(idle('d', 'refusal', 'nope')).terminal).toMatchObject({
      kind: 'failed',
      reason: 'refusal',
      message: expect.stringContaining('nope'),
    });
    expect(r.apply({ type: 'session.status_terminated', id: 'e' }).terminal).toMatchObject({
      kind: 'failed',
      reason: 'terminated',
    });
  });

  it('session.error: retrying is NOT terminal, terminal/exhausted are failures', () => {
    const r = createEventReducer();
    const err = (id: string, retry: string) => ({
      type: 'session.error',
      id,
      error: { type: 'model_overloaded_error', message: 'busy', retry_status: { type: retry } },
    });

    expect(r.apply(err('x1', 'retrying')).terminal).toBeUndefined();
    expect(r.apply(err('x2', 'terminal')).terminal).toMatchObject({ kind: 'failed', message: 'busy' });
    expect(r.apply(err('x3', 'exhausted')).terminal).toMatchObject({ kind: 'failed' });
  });
});
