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
  currentSilentMs,
  formatArtifactProgress,
  SILENCE_WORTH_MENTIONING_MS,
  countArtifactProgress,
  SILENCE_RESTATES_ELAPSED_MS,
  elapsedFraction,
  isOverdue,
  formatTypical,
  deliveryNote,
  PROGRESS_CAP,
  DELIVERY_NOTE_AFTER_MS,
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

      // The fixture has always carried silentMs; it is now kept rather than dropped at this boundary.
      silentMs: 3000,
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

/*
 * The concrete-progress line (2026-08-01).
 *
 * WHY IT EXISTS. Reported: *"it just seems stuck to look at same progress bar for 5+ minutes"*, with
 * the artifact's file rows sometimes appearing one by one and sometimes all at once at the end. A
 * client-side chunk trace of a real generation settled where the time goes: our own heartbeat arrived
 * on the dot every 3000ms while real model text landed in three bursts (14.2s / 22.0s / 27.5s). The
 * pipeline was healthy; the PROVIDER was buffering. The panel could not say so — `silentMs` was on the
 * wire and dropped at the store boundary — so a five-minute wait rendered identically to a hang.
 */
describe('concrete progress', () => {
  const base = {
    generationId: 'g1',
    seq: 1,
    phase: 'generating' as const,
    kind: 'edit' as const,
    elapsedMs: 0,
    receivedAt: 0,
  };

  it('carries silentMs off the wire', () => {
    resetAgentStatus();
    updateAgentStatus(
      {
        type: 'agent-status',
        generationId: 'g1',
        seq: 1,
        phase: 'thinking',
        kind: 'edit',
        elapsedMs: 1000,
        silentMs: 900,
      },
      0,
    );
    expect(agentStatusStore.get()?.silentMs).toBe(900);
  });

  /* Absent must stay absent — an older server's missing measurement is not a confident zero. */
  it('leaves silentMs undefined when the server sent none', () => {
    resetAgentStatus();
    updateAgentStatus(
      { type: 'agent-status', generationId: 'g2', seq: 1, phase: 'thinking', kind: 'edit', elapsedMs: 1000 },
      0,
    );
    expect(agentStatusStore.get()?.silentMs).toBeUndefined();
    expect(currentSilentMs(agentStatusStore.get()!, 5000)).toBeUndefined();
  });

  it('extrapolates silence between heartbeats, like elapsed', () => {
    expect(currentSilentMs({ ...base, silentMs: 3000 }, 2000)).toBe(5000);
  });

  it('counts files without inventing a total', () => {
    expect(formatArtifactProgress({ written: 3, writing: 1 })).toBe('3 files written · 1 in progress');
    expect(formatArtifactProgress({ written: 1, writing: 0 })).toBe('1 file written');
    expect(formatArtifactProgress({ written: 0, writing: 2 })).toBe('2 in progress');
  });

  /* Nothing has landed yet: say nothing rather than "0 files written", which reads as a failure. */
  it('shows no line when nothing has landed', () => {
    expect(formatArtifactProgress({ written: 0, writing: 0 })).toBeUndefined();
    expect(describeAgentStatus({ ...base }, 0, { written: 0, writing: 0 }).progress).toBeUndefined();
  });

  it('reports a long silence, and stays quiet about a short one', () => {
    const quiet = describeAgentStatus({ ...base, elapsedMs: 300_000, silentMs: SILENCE_WORTH_MENTIONING_MS }, 0);
    expect(quiet.progress).toContain('nothing from the model for');

    /*
     * A heartbeat only fires after seconds of quiet, so SOME silence is normal whenever this panel is
     * up. Reporting it at 3s would put an alarming sentence on every ordinary turn and train the user
     * to ignore the one that matters.
     */
    expect(describeAgentStatus({ ...base, elapsedMs: 300_000, silentMs: 3000 }, 0).progress).toBeUndefined();
  });

  it('combines what landed with whether anything is arriving', () => {
    const d = describeAgentStatus({ ...base, elapsedMs: 300_000, silentMs: 40_000 }, 0, { written: 2, writing: 1 });
    expect(d.progress).toBe('2 files written · 1 in progress · nothing from the model for 40s');
  });

  /*
   * A retry already SAYS the model stopped responding, in its detail line. Repeating it as a silence
   * clause reads as two separate problems; the file count is the part the user still needs.
   */
  it('does not double-report silence during a retry', () => {
    const d = describeAgentStatus(
      { ...base, activity: 'retrying', attempt: 2, maxAttempts: 3, elapsedMs: 300_000, silentMs: 60_000 },
      0,
      {
        written: 4,
        writing: 0,
      },
    );
    expect(d.progress).toBe('4 files written');
    expect(d.detail).toContain('retrying');
  });

  /*
   * The existing sentences are untouched — this is an added line, not a rewrite.
   *
   * ⚠️ Both sides must share the SAME status, varying only the progress argument. An earlier edit
   * raised `elapsedMs` on one side alone, which changes the label by design and turned this into a
   * test of its own fixture rather than of the code.
   */
  it('leaves label and detail exactly as they were', () => {
    const status = { ...base, elapsedMs: 300_000, silentMs: 60_000 };
    const withProgress = describeAgentStatus(status, 0, { written: 9, writing: 0 });
    const without = describeAgentStatus(status, 0);
    expect(withProgress.label).toBe(without.label);
    expect(withProgress.detail).toBe(without.detail);
    expect(withProgress.progress).not.toBe(without.progress);
  });
});

describe('countArtifactProgress', () => {
  it('counts file and edit actions by status', () => {
    expect(
      countArtifactProgress([
        { type: 'file', status: 'complete' },
        { type: 'edit', status: 'complete' },
        { type: 'file', status: 'running' },
        { type: 'file', status: 'pending' },
      ]),
    ).toEqual({ written: 2, writing: 1 });
  });

  /*
   * 🔴 A dev server is `running` forever. Counting `start` would park a permanent "1 in progress"
   * under every panel for the rest of the session — the same long-lived-action trap that stopped the
   * game-ready celebration from ever firing.
   */
  it('ignores the dev server and shell commands', () => {
    expect(
      countArtifactProgress([
        { type: 'start', status: 'running' },
        { type: 'shell', status: 'complete' },
      ]),
    ).toEqual({ written: 0, writing: 0 });
  });

  it('is empty for no actions', () => {
    expect(countArtifactProgress([])).toEqual({ written: 0, writing: 0 });
  });
});

/*
 * 🔴 Observed live on the first drive: "Working on your changes — 15s" printed above "nothing from
 * the model for 15s". When NOTHING has arrived all turn the two numbers are identical, and showing
 * both reads as a rendering bug while spending the one line meant to carry new information.
 */
describe('a stall is only news once something has arrived', () => {
  const base = {
    generationId: 'g1',
    seq: 1,
    phase: 'generating' as const,
    kind: 'edit' as const,
    elapsedMs: 0,
    receivedAt: 0,
  };

  it('does not restate the elapsed time as a stall', () => {
    expect(describeAgentStatus({ ...base, elapsedMs: 60_000, silentMs: 60_000 }, 0).progress).toBeUndefined();
  });

  it('reports it once the silence is meaningfully shorter than the turn', () => {
    const d = describeAgentStatus(
      { ...base, elapsedMs: 60_000, silentMs: 60_000 - SILENCE_RESTATES_ELAPSED_MS - 1 },
      0,
    );
    expect(d.progress).toContain('nothing from the model for');
  });

  /* The file count is unaffected — it is never a restatement of anything in the label. */
  it('still counts files while the stall clause is suppressed', () => {
    const d = describeAgentStatus({ ...base, elapsedMs: 60_000, silentMs: 60_000 }, 0, { written: 3, writing: 0 });
    expect(d.progress).toBe('3 files written');
  });
});

/*
 * 🔴 FOUND LIVE, not by a unit test (2026-08-01). The count was wired to `firstArtifact`, which is the
 * CREATION bundle (`npm install` + `npm run dev`) — two shell actions, both correctly filtered out — so
 * on every build turn the file line silently never appeared. The pure counting function was right the
 * whole time; the defect was which actions reached it.
 *
 * These pin the half that can be tested purely: a count is only reported once text has actually
 * streamed this turn.
 */
describe('the count belongs to THIS turn', () => {
  const base = {
    generationId: 'g1',
    seq: 1,
    kind: 'edit' as const,
    elapsedMs: 300_000,
    receivedAt: 0,
  };

  it('reports nothing while still thinking, whatever the caller counted', () => {
    // `thinking` means no text has streamed — so any count in hand is the PREVIOUS turn's artifact.
    const d = describeAgentStatus({ ...base, phase: 'thinking' }, 0, { written: 8, writing: 0 });
    expect(d.progress).toBeUndefined();
  });

  it('reports it once text has streamed', () => {
    const d = describeAgentStatus({ ...base, phase: 'generating' }, 0, { written: 8, writing: 0 });
    expect(d.progress).toBe('8 files written');
  });

  it('applies the same rule during a retry', () => {
    const thinking = describeAgentStatus(
      { ...base, phase: 'thinking', activity: 'retrying', attempt: 2, maxAttempts: 3 },
      0,
      { written: 8, writing: 0 },
    );
    expect(thinking.progress).toBeUndefined();
  });
});

/**
 * The expectation bar and the delivery note (2026-08-03).
 *
 * Both exist because of one reported turn: 244 seconds of silence on a healthy generation, then 46KB
 * of artifact at once, and a user who *"almost quit like 3 times"*. The generation was fine — KIE
 * buffers the whole answer (`scripts/stream-probe.mjs`, 3/3 request shapes) — but the panel could only
 * show a label and a rising number, which is identical to what it shows when something has died.
 */
describe('the expectation bar', () => {
  const base = {
    generationId: 'g1',
    seq: 1,
    kind: 'creation' as const,
    phase: 'thinking' as const,
    elapsedMs: 0,
    receivedAt: 0,
    typicalMs: 300_000,
  };

  it('is a fraction of a typical turn of this kind', () => {
    expect(elapsedFraction({ ...base, elapsedMs: 150_000 }, 0)).toBeCloseTo(0.5);
  });

  it('NEVER fills, however long the turn runs', () => {
    /*
     * The whole point. A bar that hits 100% and keeps spinning tells the user the thing is stuck —
     * converting a slow-but-healthy turn into an apparent hang, which is the failure this panel exists
     * to prevent rather than to cause.
     *
     * ⚠️ Asserted against the LITERAL 1, never against `PROGRESS_CAP`. The first draft of this test
     * read `toBe(PROGRESS_CAP)`, which moves both sides of the comparison together: mutation-verified
     * on 2026-08-03, it passed with the cap raised to 1 — i.e. it went green on the exact regression
     * it is named for. A test whose expectation is defined by the value under test cannot fail.
     */
    expect(PROGRESS_CAP).toBeLessThan(1);
    expect(elapsedFraction({ ...base, elapsedMs: 300_000 }, 0)).toBeLessThan(1);
    expect(elapsedFraction({ ...base, elapsedMs: 9_000_000 }, 0)).toBeLessThan(1);

    // And it does saturate rather than growing without bound, so the bar stops moving at the ceiling.
    expect(elapsedFraction({ ...base, elapsedMs: 9_000_000 }, 0)).toBe(
      elapsedFraction({ ...base, elapsedMs: 300_000 }, 0),
    );
  });

  it('is absent when the server sent no baseline, rather than guessed', () => {
    // An older server. No honest bar is drawable, and a fake one is worse than none.
    expect(elapsedFraction({ ...base, typicalMs: undefined }, 0)).toBeUndefined();
    expect(describeAgentStatus({ ...base, typicalMs: undefined }, 0).fraction).toBeUndefined();
    expect(describeAgentStatus({ ...base, typicalMs: undefined }, 0).expectation).toBeUndefined();
  });

  it('captions with the baseline, and does not repeat the elapsed time already in the label', () => {
    const d = describeAgentStatus({ ...base, elapsedMs: 60_000 }, 0);
    expect(d.expectation).toBe('usually about 5m');
    expect(d.label).toContain('1m 0s');

    // The same number twice reads as a rendering bug — this file's own history records it.
    expect(d.expectation).not.toContain('1m 0s');
  });

  it('stops predicting once past the baseline and reports being connected instead', () => {
    const d = describeAgentStatus({ ...base, elapsedMs: 400_000 }, 0);
    expect(isOverdue({ ...base, elapsedMs: 400_000 }, 0)).toBe(true);
    expect(d.expectation).toBe('longer than usual — still connected');
    expect(d.fraction).toBe(PROGRESS_CAP);
  });

  it('formats a baseline coarsely — it is not a promise', () => {
    expect(formatTypical(300_000)).toBe('about 5m');
    expect(formatTypical(90_000)).toBe('about 90s');
  });

  it('drops a zero or negative baseline at ingest, because it is a divisor', () => {
    /*
     * A `0` from a future server would make every fraction `Infinity` and pin the bar full on the
     * first tick — the one rendering that is worse than having no bar at all.
     */
    resetAgentStatus();
    updateAgentStatus(part({ typicalMs: 0, kind: 'creation' }));
    expect(agentStatusStore.get()?.typicalMs).toBeUndefined();

    resetAgentStatus();
    updateAgentStatus(part({ typicalMs: Number.POSITIVE_INFINITY }));
    expect(agentStatusStore.get()?.typicalMs).toBeUndefined();
  });
});

describe('the delivery note', () => {
  const base = {
    generationId: 'g1',
    seq: 1,
    kind: 'creation' as const,
    phase: 'thinking' as const,
    elapsedMs: 60_000,
    receivedAt: 0,
    deliveryMode: 'batched' as const,
  };

  it('explains the silence on a provider measured to deliver in one batch', () => {
    const note = deliveryNote({ ...base, silentMs: 60_000 }, 0);
    expect(note).toContain('one batch');
    expect(note).toContain('Nothing is stuck');
  });

  it('says NOTHING on a streaming provider, where a long silence really might be a problem', () => {
    expect(deliveryNote({ ...base, deliveryMode: 'streamed', silentMs: 60_000 }, 0)).toBeUndefined();
  });

  it('says nothing when the server never told us how it delivers', () => {
    expect(deliveryNote({ ...base, deliveryMode: undefined, silentMs: 60_000 }, 0)).toBeUndefined();
  });

  it('waits for real silence, so a responsive turn carries no paragraph about waiting', () => {
    expect(deliveryNote({ ...base, silentMs: DELIVERY_NOTE_AFTER_MS - 1 }, 0)).toBeUndefined();
    expect(deliveryNote({ ...base, silentMs: DELIVERY_NOTE_AFTER_MS }, 0)).toBeDefined();
  });

  it('never claims to know how far along the turn is', () => {
    const note = deliveryNote({ ...base, silentMs: 200_000 }, 0) ?? '';
    expect(note).not.toMatch(/almost|nearly|soon|shortly/i);
  });

  it('suppresses the stall clause, so the symptom is not restated beside its explanation', () => {
    /*
     * On a batched provider "nothing from the model for 3m" is not news — it is how the transport
     * works. Printed next to the note it reads as two pieces of bad news, and the alarming one is the
     * line that reads first.
     */
    const batched = describeAgentStatus({ ...base, phase: 'generating', elapsedMs: 200_000, silentMs: 100_000 }, 0);
    expect(batched.progress).toBeUndefined();
    expect(batched.note).toBeDefined();

    // CONTROL: the identical status on a streaming provider still reports the stall, as it always has.
    const streamed = describeAgentStatus(
      { ...base, deliveryMode: 'streamed', phase: 'generating', elapsedMs: 200_000, silentMs: 100_000 },
      0,
    );
    expect(streamed.progress).toContain('nothing from the model');
  });

  it('is dropped during a retry, which has a truer story of its own', () => {
    const d = describeAgentStatus({ ...base, silentMs: 60_000, activity: 'retrying', attempt: 2, maxAttempts: 3 }, 0);
    expect(d.label).toContain('Reconnecting');
    expect(d.note).toBeUndefined();

    // A retry RESTARTS the work, so elapsed no longer measures progress through a typical turn.
    expect(d.fraction).toBeUndefined();
  });

  it('ignores an unrecognised delivery mode rather than passing it through', () => {
    resetAgentStatus();
    updateAgentStatus(part({ deliveryMode: 'telepathy' }));
    expect(agentStatusStore.get()?.deliveryMode).toBeUndefined();
  });

  it('carries a valid mode through ingest', () => {
    resetAgentStatus();
    updateAgentStatus(part({ deliveryMode: 'batched', typicalMs: 300_000 }));
    expect(agentStatusStore.get()?.deliveryMode).toBe('batched');
    expect(agentStatusStore.get()?.typicalMs).toBe(300_000);
  });
});
