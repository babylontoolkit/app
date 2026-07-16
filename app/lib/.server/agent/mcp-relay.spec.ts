import { describe, expect, it, vi } from 'vitest';
import {
  awaitClientToolResult,
  deliverClientToolResult,
  cancelGenerationToolCalls,
  pendingCountForTests,
} from './mcp-relay';

/**
 * The relay is the seam that lets the model call a tool running in the USER'S sandbox without the
 * platform executing it (§4.14) — and without fragmenting the single-generation billing model. These
 * tests pin the three things that keep it safe: it delivers, it enforces ownership, and it never leaks a
 * pending promise (timeout / abort / generation-end all settle).
 */
describe('mcp-relay', () => {
  it('delivers a client result to the awaiting tool call', async () => {
    const promise = awaitClientToolResult({ generationId: 'g1', toolCallId: 'c1', userId: 'u1' });
    expect(pendingCountForTests('g1')).toBe(1);

    const delivered = deliverClientToolResult({
      generationId: 'g1',
      toolCallId: 'c1',
      userId: 'u1',
      result: { ok: true },
    });

    expect(delivered).toBe(true);
    await expect(promise).resolves.toEqual({ result: { ok: true } });
    expect(pendingCountForTests('g1')).toBe(0);
  });

  it('feeds a client error back as a tool_result rather than rejecting', async () => {
    const promise = awaitClientToolResult({ generationId: 'g2', toolCallId: 'c1', userId: 'u1' });
    deliverClientToolResult({ generationId: 'g2', toolCallId: 'c1', userId: 'u1', error: 'no server' });

    await expect(promise).resolves.toEqual({ error: 'no server' });
  });

  it('refuses a result from a user who does not own the generation', async () => {
    const promise = awaitClientToolResult({ generationId: 'g3', toolCallId: 'c1', userId: 'owner' });

    const delivered = deliverClientToolResult({
      generationId: 'g3',
      toolCallId: 'c1',
      userId: 'attacker',
      result: { evil: true },
    });

    expect(delivered).toBe(false);
    expect(pendingCountForTests('g3')).toBe(1); // still waiting — the injection did nothing

    // The rightful owner can still deliver.
    deliverClientToolResult({ generationId: 'g3', toolCallId: 'c1', userId: 'owner', result: 'good' });
    await expect(promise).resolves.toEqual({ result: 'good' });
  });

  it('returns false for an unknown or already-settled call', () => {
    expect(deliverClientToolResult({ generationId: 'nope', toolCallId: 'x', userId: 'u1' })).toBe(false);
  });

  it('settles (never hangs) on timeout', async () => {
    vi.useFakeTimers();

    try {
      const promise = awaitClientToolResult({ generationId: 'g4', toolCallId: 'c1', userId: 'u1', timeoutMs: 1000 });
      vi.advanceTimersByTime(1001);
      await expect(promise).resolves.toEqual({ error: 'The tool did not respond in time.' });
      expect(pendingCountForTests('g4')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles every pending call when the generation ends', async () => {
    const a = awaitClientToolResult({ generationId: 'g5', toolCallId: 'c1', userId: 'u1' });
    const b = awaitClientToolResult({ generationId: 'g5', toolCallId: 'c2', userId: 'u1' });
    expect(pendingCountForTests('g5')).toBe(2);

    cancelGenerationToolCalls('g5');

    await expect(a).resolves.toEqual({ error: 'The generation ended before the tool responded.' });
    await expect(b).resolves.toEqual({ error: 'The generation ended before the tool responded.' });
    expect(pendingCountForTests('g5')).toBe(0);
  });

  it('settles on abort', async () => {
    const controller = new AbortController();
    const promise = awaitClientToolResult({
      generationId: 'g6',
      toolCallId: 'c1',
      userId: 'u1',
      abortSignal: controller.signal,
    });

    controller.abort();
    await expect(promise).resolves.toEqual({ error: 'The generation was stopped.' });
  });
});
