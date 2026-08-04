/**
 * Generation liveness heartbeat (SPEC §4.2a) — the "never show dead dots" guarantee.
 *
 * The property under test: while the model stream is SILENT, `agent-status` parts flow on a timer;
 * the moment real content streams, they stop; and the wrapper never withholds or alters a chunk.
 * A regression here costs $0 and throws nothing — the user just stares at an anonymous spinner for
 * minutes of billed thinking, which is exactly the state this module was built to kill.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createHeartbeat,
  withGenerationHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_QUIET_MS,
  type AgentStatusPart,
} from './heartbeat';
import type { AgentChunk } from './proxy';

describe('createHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits statuses on the interval while the stream is silent', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);

    expect(writes.length).toBe(3);
    expect(writes[0]).toMatchObject({ type: 'agent-status', generationId: 'gen-1', phase: 'thinking', seq: 1 });
    expect(writes[2].seq).toBe(3);

    // elapsedMs is the server's clock, monotonically growing.
    expect(writes[2].elapsedMs).toBeGreaterThan(writes[0].elapsedMs);

    hb.stop();
  });

  it('stays quiet while activity keeps arriving', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s));

    // Touch activity more often than the quiet threshold — content is flowing.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(HEARTBEAT_QUIET_MS - 500);
      hb.activity('text');
    }

    expect(writes).toEqual([]);
    hb.stop();
  });

  it('phase is thinking before the first text and generating after', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(writes[0].phase).toBe('thinking');

    // Reasoning is NOT text: real thinking streaming keeps later silences labelled as thinking.
    hb.activity('reasoning');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(writes.at(-1)?.phase).toBe('thinking');

    hb.activity('text');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(writes.at(-1)?.phase).toBe('generating');

    hb.stop();
  });

  it('reports how long the stream had been silent', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s));

    hb.activity('text');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);

    const last = writes.at(-1)!;
    expect(last.silentMs).toBeGreaterThanOrEqual(HEARTBEAT_QUIET_MS);
    expect(last.silentMs).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS * 2);

    hb.stop();
  });

  it('stop() ends emission permanently', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(writes.length).toBe(1);

    hb.stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
    expect(writes.length).toBe(1);
  });

  it('a throwing writer never propagates — the status channel cannot break the generation', () => {
    const hb = createHeartbeat('gen-1', () => {
      throw new Error('client went away');
    });

    expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)).not.toThrow();
    hb.stop();
  });
});

/**
 * The retry activity (2026-07-28).
 *
 * A stalled provider being retried rendered as "Thinking — 4m", so four minutes of UNBILLED recovery
 * looked like four minutes of billed reasoning — measured live on a 387s creation whose step 1 ran 239s
 * for 553 chars, and read by the user as *"burning credits for nothing"*. The property that makes naming
 * it safe is that it is SELF-CLEARING: it is reported only while the retry began at-or-after the last
 * real content, so a later genuine long think can never inherit the label from a flag nobody cleared.
 */
describe('createHeartbeat — retry activity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a retry in flight, with the attempt count', () => {
    const writes: AgentStatusPart[] = [];
    const activity = vi.fn(() => ({ activity: 'retrying' as const, attempt: 2, maxAttempts: 3, since: Date.now() }));
    const hb = createHeartbeat('gen-1', (s) => writes.push(s), { activity });

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(writes[0]).toMatchObject({ activity: 'retrying', attempt: 2, maxAttempts: 3 });

    // Pulled at tick time, never pushed — the heartbeat stays a passive reader of proxy facts.
    expect(activity).toHaveBeenCalled();

    hb.stop();
  });

  it('a null getter result leaves the part byte-identical to an ordinary heartbeat', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s), { activity: () => null });

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(Object.keys(writes[0])).not.toContain('activity');
    expect(Object.keys(writes[0])).not.toContain('attempt');
    expect(Object.keys(writes[0])).not.toContain('maxAttempts');

    hb.stop();
  });

  /**
   * 🔴 THE SELF-CLEARING PROPERTY — the whole reason this is a `since` comparison rather than a boolean.
   *
   * A retry that began BEFORE the last real content is over: that attempt already streamed something, so
   * the silence being narrated now is a fresh think, not the stalled connection. Reporting it anyway would
   * pin "Reconnecting to the model" over minutes of genuinely billed reasoning — the same lie as the bug
   * this feature fixes, pointing the other way, and this time in our favour rather than the user's.
   *
   * Mutation-verified: relaxing the guard (`pending.since >= lastActivityAt` → reporting whenever a
   * snapshot exists) fails this test.
   */
  it('SELF-CLEARING: a retry older than the last content is NOT reported', () => {
    const writes: AgentStatusPart[] = [];

    // The retry was decided at t=0…
    const since = Date.now();
    const hb = createHeartbeat('gen-1', (s) => writes.push(s), {
      activity: () => ({ activity: 'retrying' as const, attempt: 2, maxAttempts: 3, since }),
    });

    // …and while it is still the newest fact, it is reported.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(writes.at(-1)?.activity).toBe('retrying');

    /*
     * …then the retried attempt streams real content. The getter still returns the SAME stale snapshot
     * (nothing clears it — that is the design), so only the `since` comparison can stop it.
     */
    vi.advanceTimersByTime(1000);
    hb.activity('text');

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);

    const last = writes.at(-1)!;
    expect(last.activity).toBeUndefined();
    expect(Object.keys(last)).not.toContain('activity');

    // CONTROL: the heartbeat is still running and still emitting — it stopped the LABEL, not the panel.
    expect(last.phase).toBe('generating');
    expect(writes.length).toBeGreaterThan(1);

    hb.stop();
  });

  it('a SECOND retry decided after that content is reported again', () => {
    // Proves the test above pins a comparison, not "activity is reported at most once".
    const writes: AgentStatusPart[] = [];
    let snapshot = { activity: 'retrying' as const, attempt: 2, maxAttempts: 3, since: Date.now() };
    const hb = createHeartbeat('gen-1', (s) => writes.push(s), { activity: () => snapshot });

    vi.advanceTimersByTime(1000);
    hb.activity('text');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(writes.at(-1)?.activity).toBeUndefined();

    snapshot = { ...snapshot, attempt: 3, since: Date.now() };
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);

    expect(writes.at(-1)).toMatchObject({ activity: 'retrying', attempt: 3, maxAttempts: 3 });

    hb.stop();
  });

  it('NO getter: the part carries no activity KEYS at all (older wire shape, byte-identical)', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    /*
     * Key ABSENCE, not an undefined value: this part is JSON-serialised onto the SSE wire, and an
     * explicit `activity: undefined` would be a different object here yet identical after a round trip —
     * so asserting `toBeUndefined()` alone cannot tell the two apart, and the conditional-spread rule
     * this pins would be free to rot.
     */
    expect(Object.keys(writes[0]).sort()).toEqual([
      'elapsedMs',
      'generationId',
      'kind',
      'phase',
      'seq',
      'silentMs',
      'type',
    ]);

    hb.stop();
  });

  it('a throwing activity getter cannot break the generation', () => {
    const hb = createHeartbeat('gen-1', () => undefined, {
      activity: () => {
        throw new Error('proxy state exploded');
      },
    });

    expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)).not.toThrow();
    hb.stop();
  });
});

describe('withGenerationHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));

    return { promise, open };
  }

  it('passes every chunk through byte-identical and emits heartbeats only during the silent gap', async () => {
    const writes: AgentStatusPart[] = [];
    const midStream = gate();

    async function* source(): AsyncGenerator<AgentChunk> {
      yield { type: 'text', value: 'hello ' };
      await midStream.promise;
      yield { type: 'text', value: 'world' };
    }

    const received: AgentChunk[] = [];
    const consume = (async () => {
      for await (const chunk of withGenerationHeartbeat(source(), 'gen-1', (s) => writes.push(s))) {
        received.push(chunk);
      }
    })();

    // A long provider silence mid-generation → heartbeats flow.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[0].phase).toBe('generating'); // text already streamed before the gap

    midStream.open();
    await vi.runAllTimersAsync();
    await consume;

    expect(received).toEqual([
      { type: 'text', value: 'hello ' },
      { type: 'text', value: 'world' },
    ]);

    // Source ended → heartbeat stopped with it.
    const after = writes.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    expect(writes.length).toBe(after);
  });

  /** A source that yields when pushed — lets a test interleave chunks with the fake clock. */
  function pushSource() {
    const queue: AgentChunk[] = [];
    let notify: (() => void) | null = null;
    let done = false;

    return {
      push(chunk: AgentChunk) {
        queue.push(chunk);
        notify?.();
        notify = null;
      },
      end() {
        done = true;
        notify?.();
        notify = null;
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<AgentChunk> {
        for (;;) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }

          if (done) {
            return;
          }

          await new Promise<void>((resolve) => (notify = resolve));
        }
      },
    };
  }

  it('a steady drip of EMPTY chunks does not reset the quiet clock — KIE streams empty thinking deltas', async () => {
    /*
     * Measured live (2026-07-24): KIE's adapter emits thinking blocks whose text is EMPTY while
     * billing the thinking tokens. If empty deltas counted as activity, a drip of them (arriving
     * more often than the quiet threshold) would suppress the heartbeat during the exact silence it
     * exists to cover. The drip cadence here (1.5s) is deliberately FASTER than HEARTBEAT_QUIET_MS,
     * so this test fails if `withGenerationHeartbeat` ever counts an empty chunk as activity.
     */
    const writes: AgentStatusPart[] = [];
    const source = pushSource();

    const consume = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of withGenerationHeartbeat(source, 'gen-1', (s) => writes.push(s))) {
        // drain
      }
    })();

    for (let i = 0; i < 4; i++) {
      source.push({ type: 'reasoning', value: '' });
      await vi.advanceTimersByTimeAsync(1500);
    }

    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0].phase).toBe('thinking');

    source.end();
    await vi.runAllTimersAsync();
    await consume;
  });

  it('CONTROL: the same drip of NON-empty chunks suppresses the heartbeat', async () => {
    // Proves the previous test's emptiness check is what fires the heartbeat — not the drip itself.
    const writes: AgentStatusPart[] = [];
    const source = pushSource();

    const consume = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of withGenerationHeartbeat(source, 'gen-1', (s) => writes.push(s))) {
        // drain
      }
    })();

    for (let i = 0; i < 4; i++) {
      source.push({ type: 'reasoning', value: 'planning the track layout…' });
      await vi.advanceTimersByTimeAsync(1500);
    }

    expect(writes).toEqual([]);

    source.end();
    await vi.runAllTimersAsync();
    await consume;
  });

  it('stops the heartbeat when the source throws', async () => {
    const writes: AgentStatusPart[] = [];

    async function* source(): AsyncGenerator<AgentChunk> {
      throw new Error('provider died');
    }

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of withGenerationHeartbeat(source(), 'gen-1', (s) => writes.push(s))) {
        // drain
      }
    }).rejects.toThrow('provider died');

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    expect(writes).toEqual([]);
  });
});

/**
 * The expectation fields (2026-08-03; `delivery.ts`).
 *
 * They exist because a healthy 244-second turn and a dead one looked identical on screen. They are
 * optional on the wire, and the two tests that matter most are the ones proving an ABSENT option
 * leaves the part byte-identical to the shape older clients already parse — the same rule the retry
 * fields are held to directly above.
 */
describe('createHeartbeat — expectation fields', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries the delivery mode and the baseline when the route supplies them', () => {
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s), { deliveryMode: 'batched', typicalMs: 300_000 });

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(writes[0]).toMatchObject({ deliveryMode: 'batched', typicalMs: 300_000 });

    hb.stop();
  });

  it('omits the KEYS entirely when not supplied, rather than sending undefined', () => {
    /*
     * `JSONValue` refuses `undefined`, and the client's "we were not told" degradation depends on the
     * key genuinely being absent — a present-but-undefined field would serialise to a wire shape the
     * route's own `writeData` cast quietly permits and nothing downstream expects.
     */
    const writes: AgentStatusPart[] = [];
    const hb = createHeartbeat('gen-1', (s) => writes.push(s));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect('deliveryMode' in writes[0]).toBe(false);
    expect('typicalMs' in writes[0]).toBe(false);
    expect(JSON.parse(JSON.stringify(writes[0]))).toEqual(writes[0]);

    hb.stop();
  });
});
