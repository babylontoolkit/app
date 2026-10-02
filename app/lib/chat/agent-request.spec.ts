/**
 * One agent turn in flight per tab (`agent-request.ts`).
 *
 * A request the page stopped showing, left connected, is what kept a project locked with no Stop
 * button to press. These pin that starting a turn closes the previous one, that `useChat`'s own Stop
 * still reaches the request, and that the abort is a reasonless `AbortError` — the only rejection
 * `useChat` treats as a quiet cancel rather than an error alert and a retry.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_TAB_ID, createAgentRequestTracker } from './agent-request';

function recordingFetch() {
  const signals: AbortSignal[] = [];
  const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!);
    return new Response('ok');
  });

  return { base: base as unknown as typeof fetch, signals };
}

describe('createAgentRequestTracker', () => {
  it('aborts the previous request when the next one starts', async () => {
    const { base, signals } = recordingFetch();
    const tracker = createAgentRequestTracker(base);

    await tracker.fetch('/api/agent', { method: 'POST' });
    await tracker.fetch('/api/agent', { method: 'POST' });

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('CONTROL: a single request is left running', async () => {
    const { base, signals } = recordingFetch();
    const tracker = createAgentRequestTracker(base);

    await tracker.fetch('/api/agent', { method: 'POST' });

    expect(signals[0].aborted).toBe(false);
  });

  it('forwards useChat’s own Stop to the request', async () => {
    const { base, signals } = recordingFetch();
    const tracker = createAgentRequestTracker(base);
    const outer = new AbortController();

    await tracker.fetch('/api/agent', { method: 'POST', signal: outer.signal });
    outer.abort();

    expect(signals[0].aborted).toBe(true);
  });

  it('abort() reaches the current request even after useChat lost its handle', async () => {
    const { base, signals } = recordingFetch();
    const tracker = createAgentRequestTracker(base);

    await tracker.fetch('/api/agent', { method: 'POST' });
    tracker.abort();

    expect(signals[0].aborted).toBe(true);
    expect(() => tracker.abort()).not.toThrow();
  });

  it('aborts with an AbortError, so useChat treats the old turn as cancelled rather than failed', async () => {
    const { base, signals } = recordingFetch();
    const tracker = createAgentRequestTracker(base);

    await tracker.fetch('/api/agent', { method: 'POST' });
    await tracker.fetch('/api/agent', { method: 'POST' });

    expect((signals[0].reason as Error).name).toBe('AbortError');
  });

  it('has a tab id short enough for the server to accept', () => {
    expect(AGENT_TAB_ID.length).toBeGreaterThan(0);
    expect(AGENT_TAB_ID.length).toBeLessThanOrEqual(64);
  });
});
