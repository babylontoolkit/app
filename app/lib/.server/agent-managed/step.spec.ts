/**
 * The managed turn's step label (`step.ts`) — what the status panel says during a silence.
 *
 * Measured 2026-10-02: 101 s and 122 s of thinking and 64 s composing a 21 KB write, each shown as one
 * unchanging "Working on your changes". Every label below is an OBSERVATION of a session event; the
 * CONTROLS pin that events which say nothing new never move the step or reset its clock.
 */
import { describe, expect, it } from 'vitest';
import { createStepTracker, labelForToolCall, stepLabelForEvent } from './step';

describe('a session event names the step it starts', () => {
  it.each([
    [{ type: 'span.model_request_start' }, 'Working out the next step'],
    [{ type: 'event_start', event: { type: 'agent.thinking', id: 'e1' } }, 'Thinking'],
    [{ type: 'event_start', event: { type: 'agent.message', id: 'e2' } }, 'Writing a reply'],
    [{ type: 'agent.thinking' }, 'Preparing the next change'],
    [
      { type: 'agent.custom_tool_use', name: 'project_write', input: { path: 'src/scripts/Kart.ts' } },
      'Writing src/scripts/Kart.ts',
    ],
    [{ type: 'agent.custom_tool_use', name: 'check_game', input: {} }, 'Checking the game — type-check and play test'],
    [{ type: 'agent.tool_use', name: 'read' }, 'Reading the Toolkit docs'],
    [{ type: 'user.custom_tool_result' }, 'Working out the next step'],
  ])('%j → %s', (event, label) => {
    expect(stepLabelForEvent(event)).toBe(label);
  });

  it.each([
    { type: 'span.model_request_end' },
    { type: 'session.usage' },
    { type: 'event_delta' },
    { type: 'agent.message' },
  ])('CONTROL: %j says nothing new', (event) => {
    expect(stepLabelForEvent(event)).toBeNull();
  });

  it('a project path is shortened, never printed whole', () => {
    expect(labelForToolCall('project_edit', { path: `/home/project/src/${'a/'.repeat(60)}x.ts` })!.length).toBeLessThan(
      80,
    );
    expect(labelForToolCall('project_read', { path: '/home/project/src/main.ts' })).toBe('Reading src/main.ts');
  });

  it('the checklist is not a step (it would hide the real one)', () => {
    expect(labelForToolCall('update_todos', { todos: [] })).toBeNull();
  });
});

describe('the tracker', () => {
  it('moves to each new step with its own clock', () => {
    const tracker = createStepTracker();

    tracker.observe({ type: 'span.model_request_start' }, 1000);
    tracker.observe({ type: 'event_start', event: { type: 'agent.thinking' } }, 2000);
    expect(tracker.current()).toEqual({ label: 'Thinking', since: 2000 });

    tracker.observe({ type: 'agent.custom_tool_use', name: 'project_write', input: { path: 'src/a.ts' } }, 90_000);
    expect(tracker.current()).toEqual({ label: 'Writing src/a.ts', since: 90_000 });
  });

  it('CONTROL: an event that says nothing new keeps the step and its clock', () => {
    const tracker = createStepTracker();

    tracker.observe({ type: 'event_start', event: { type: 'agent.thinking' } }, 1000);
    tracker.observe({ type: 'session.usage' }, 50_000);
    tracker.observe({ type: 'event_start', event: { type: 'agent.thinking' } }, 60_000);

    expect(tracker.current()).toEqual({ label: 'Thinking', since: 1000 });
  });
});
