/**
 * Client half of the generation liveness heartbeat (SPEC §4.2a).
 *
 * The dangerous regression is the replay one: `useChat` re-presents the whole data array on every
 * chunk, and re-ingesting an old heartbeat refreshes `receivedAt` — a stale status then looks
 * forever fresh and the "Thinking" panel squats on top of a streaming answer. The `(generationId,
 * seq)` gate is what prevents that, so it gets the most attention here.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  agentStatusStore,
  updateAgentStatus,
  resetAgentStatus,
  currentElapsedMs,
  isStatusFresh,
  formatElapsed,
  describeAgentStatus,
  STATUS_STALE_MS,
} from './agent-status';

function part(overrides: Record<string, unknown> = {}) {
  return {
    type: 'agent-status',
    generationId: 'gen-1',
    seq: 1,
    phase: 'thinking',
    elapsedMs: 5000,
    silentMs: 3000,
    ...overrides,
  };
}

describe('updateAgentStatus', () => {
  beforeEach(() => resetAgentStatus());

  it('ingests a valid part', () => {
    updateAgentStatus(part(), 1000);

    expect(agentStatusStore.get()).toEqual({
      generationId: 'gen-1',
      seq: 1,
      phase: 'thinking',
      elapsedMs: 5000,
      receivedAt: 1000,
    });
  });

  it('REPLAY GATE: an already-seen or older seq never refreshes receivedAt', () => {
    updateAgentStatus(part({ seq: 3 }), 1000);

    // The useChat data array replays the same parts on every chunk — hours later, same seq.
    updateAgentStatus(part({ seq: 3 }), 500_000);
    updateAgentStatus(part({ seq: 2 }), 500_000);

    expect(agentStatusStore.get()?.receivedAt).toBe(1000);
  });

  it('a newer seq of the same generation moves forward', () => {
    updateAgentStatus(part({ seq: 1, phase: 'thinking' }), 1000);
    updateAgentStatus(part({ seq: 2, phase: 'generating', elapsedMs: 9000 }), 4000);

    expect(agentStatusStore.get()).toMatchObject({ seq: 2, phase: 'generating', elapsedMs: 9000, receivedAt: 4000 });
  });

  it('a new generation always wins, even at seq 1', () => {
    updateAgentStatus(part({ seq: 9 }), 1000);
    updateAgentStatus(part({ generationId: 'gen-2', seq: 1, elapsedMs: 100 }), 2000);

    expect(agentStatusStore.get()).toMatchObject({ generationId: 'gen-2', seq: 1 });
  });

  it('ignores everything that is not a well-formed agent-status part', () => {
    updateAgentStatus(null);
    updateAgentStatus('agent-status');
    updateAgentStatus({ type: 'media-task', taskId: 't1' });
    updateAgentStatus(part({ phase: 'exploding' }));
    updateAgentStatus(part({ seq: 'one' }));
    updateAgentStatus(part({ elapsedMs: undefined }));

    expect(agentStatusStore.get()).toBeNull();
  });
});

describe('freshness and display', () => {
  beforeEach(() => resetAgentStatus());

  it('currentElapsedMs adds the time since the part arrived', () => {
    updateAgentStatus(part({ elapsedMs: 60_000 }), 10_000);

    expect(currentElapsedMs(agentStatusStore.get()!, 14_000)).toBe(64_000);

    // A clock that went backwards never shrinks the display.
    expect(currentElapsedMs(agentStatusStore.get()!, 9_000)).toBe(60_000);
  });

  it('freshness expires: no heartbeat means content is flowing and the panel must yield', () => {
    updateAgentStatus(part(), 1000);

    const status = agentStatusStore.get()!;
    expect(isStatusFresh(status, 1000 + STATUS_STALE_MS - 1)).toBe(true);
    expect(isStatusFresh(status, 1000 + STATUS_STALE_MS)).toBe(false);
  });

  it('formats elapsed time coarsely', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(47_400)).toBe('47s');
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(600_000)).toBe('10m 0s');
    expect(formatElapsed(-5)).toBe('0s');
  });

  it('describes both phases with a live elapsed count', () => {
    updateAgentStatus(part({ elapsedMs: 70_000 }), 1000);

    const thinking = describeAgentStatus(agentStatusStore.get()!, 3000);
    expect(thinking.label).toBe('Thinking — 1m 12s');

    // The label carries the state; the detail is owner-tunable copy — pin only that it exists.
    expect(thinking.detail.length).toBeGreaterThan(0);

    updateAgentStatus(part({ seq: 2, phase: 'generating', elapsedMs: 120_000 }), 5000);

    const generating = describeAgentStatus(agentStatusStore.get()!, 5000);
    expect(generating.label).toBe('Still working — 2m 0s');
  });
});
