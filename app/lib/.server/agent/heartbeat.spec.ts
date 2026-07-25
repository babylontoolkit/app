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
