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
      kind: 'edit',
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
    expect(thinking.label).toBe('Working on your changes — 1m 12s');

    // The label carries the state; the detail is owner-tunable copy — pin only that it exists.
    expect(thinking.detail.length).toBeGreaterThan(0);

    updateAgentStatus(part({ seq: 2, phase: 'generating', elapsedMs: 120_000 }), 5000);

    const generating = describeAgentStatus(agentStatusStore.get()!, 5000);
    expect(generating.label).toBe('Working on your changes — 2m 0s');
  });

  /**
   * The reported failure this copy exists for: *"2-3 min of empty is a killer… thinking about what???"*
   * A creation is the longest wait in the product, and it must NAME ITSELF rather than say "Thinking".
   */
  it('names the turn — a creation says it is building the project', () => {
    updateAgentStatus(part({ kind: 'creation', elapsedMs: 130_000 }), 1000);

    const status = describeAgentStatus(agentStatusStore.get()!, 1000);
    expect(status.label).toBe('Building your project — 2m 10s');
    expect(status.detail).toMatch(/landing page/i);
  });

  it('distinguishes a repair and a plan turn from an ordinary edit', () => {
    updateAgentStatus(part({ kind: 'repair' }), 1000);
    expect(describeAgentStatus(agentStatusStore.get()!, 1000).label).toMatch(/^Fixing a build error/);

    updateAgentStatus(part({ seq: 2, kind: 'plan' }), 1000);
    expect(describeAgentStatus(agentStatusStore.get()!, 1000).label).toMatch(/^Planning/);
  });

  /**
   * A kind this client does not know (an older server, a future turn type) must degrade to the VAGUEST
   * true sentence, never to a wrong one — the same "degrade to off, never invent" rule as
   * `premiumSessionHint`. Claiming "Building your project" on a turn that is not one is worse than
   * saying nothing specific.
   */
  it('falls back to the least-claiming copy for a missing or unknown kind', () => {
    updateAgentStatus(part({ kind: undefined }), 1000);
    expect(agentStatusStore.get()?.kind).toBe('edit');

    updateAgentStatus(part({ seq: 2, kind: 'teleporting' }), 1000);
    expect(agentStatusStore.get()?.kind).toBe('edit');
  });
});

/**
 * The retry activity (2026-07-28; server: `agent/heartbeat.ts`).
 *
 * Measured live: a 387s creation spent two stalled provider attempts showing "Thinking", and the user
 * concluded they were *"burning credits for nothing"*. The retries bill ZERO by construction
 * (`shouldRetryGeneration` gates on `outTokens === 0`), so the panel was wrong about the one thing the
 * user cannot check for themselves. These pin that the copy says it — and that an activity this client
 * does not understand degrades to the vaguer true sentence rather than to a wrong specific one.
 */
describe('retry activity', () => {
  beforeEach(() => resetAgentStatus());

  it('ingests the retry fields', () => {
    updateAgentStatus(part({ activity: 'retrying', attempt: 2, maxAttempts: 3 }), 1000);

    expect(agentStatusStore.get()).toMatchObject({ activity: 'retrying', attempt: 2, maxAttempts: 3 });
  });

  it('an ordinary part carries no activity KEY — absence is the normal case', () => {
    updateAgentStatus(part(), 1000);

    expect(Object.keys(agentStatusStore.get()!)).not.toContain('activity');
  });

  /**
   * 🔴 An unknown activity is DROPPED, and the rest of the part is still ingested. Both halves matter:
   * passing a future activity string through would make `describeAgentStatus` fall out of its `retrying`
   * branch into the phase copy anyway (fine) — but a client that instead REJECTED the whole part would
   * blank the liveness panel during exactly the stall it exists to cover, which is the failure mode
   * `phase` already has and the reason activity was added as a separate optional field.
   */
  it('DROPS an unrecognised activity while still ingesting the rest of the part', () => {
    updateAgentStatus(part({ activity: 'exploding', attempt: 2, maxAttempts: 3, elapsedMs: 42_000 }), 1000);

    const status = agentStatusStore.get()!;
    expect(status).not.toBeNull();
    expect(Object.keys(status)).not.toContain('activity');
    expect(status.elapsedMs).toBe(42_000);

    // …and the panel falls back to the phase/kind sentence, which is still true.
    expect(describeAgentStatus(status, 1000).label).toMatch(/^Working on your changes/);
  });

  it('the retry copy OUTRANKS the phase sentence and states the not-charged fact', () => {
    updateAgentStatus(
      part({ kind: 'creation', activity: 'retrying', attempt: 2, maxAttempts: 3, elapsedMs: 130_000 }),
      1000,
    );

    const { label, detail } = describeAgentStatus(agentStatusStore.get()!, 1000);

    expect(label).toBe('Reconnecting to the model — 2m 10s');
    expect(detail).toMatch(/2 of 3/);

    // The fact the user cannot otherwise know and had assumed the opposite of.
    expect(detail).toMatch(/not charged/i);

    /*
     * CONTROL: the SAME part without the activity gets the creation phase copy. Without this, the
     * assertions above pass for a `describeAgentStatus` that ignores `activity` and simply never says
     * "Building your project".
     */
    updateAgentStatus(part({ seq: 2, kind: 'creation', elapsedMs: 130_000 }), 1000);
    expect(describeAgentStatus(agentStatusStore.get()!, 1000).label).toBe('Building your project — 2m 10s');
  });

  it('degrades gracefully when attempt/maxAttempts are absent', () => {
    updateAgentStatus(part({ activity: 'retrying' }), 1000);

    const { label, detail } = describeAgentStatus(agentStatusStore.get()!, 1000);

    expect(label).toMatch(/^Reconnecting to the model/);
    expect(detail).toMatch(/not charged/i);

    // No dangling "attempt  of  " — a half-known count is simply not narrated.
    expect(detail).not.toMatch(/\sof\s/);
    expect(detail).not.toMatch(/undefined|NaN/);
  });
});
