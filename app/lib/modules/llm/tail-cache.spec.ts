/**
 * The rolling tail breakpoint (tool-loop plan D13). A fifth `cache_control` is an HTTP 400 on every
 * generation, and a missing tail breakpoint silently re-bills the whole tool loop at the full input
 * rate on every step — both are pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import { addTailCacheBreakpoint, countCacheControls, tailCacheFetch, withTailCache } from './tail-cache';

const CC = { type: 'ephemeral' };
const sys = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'text', text: `s${i}`, cache_control: CC }));

describe('addTailCacheBreakpoint', () => {
  it('adds cache_control to the last text block of the last message', () => {
    const body = {
      system: sys(1),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'text', text: 'continue' },
          ],
        },
      ],
    };
    const out = addTailCacheBreakpoint(body) as any;

    expect(out.messages[1].content[1]).toEqual({ type: 'text', text: 'continue', cache_control: CC });
    expect(out.messages[1].content[0].cache_control).toBeUndefined();
    expect(out.messages[0].content[0].cache_control).toBeUndefined();
    expect(countCacheControls(out)).toBe(2);
  });

  it('marks a trailing tool_result block (the usual tool-loop tail)', () => {
    const out = addTailCacheBreakpoint({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }],
    }) as any;

    expect(out.messages[0].content[0].cache_control).toEqual(CC);
  });

  it('string content becomes a block', () => {
    const out = addTailCacheBreakpoint({ messages: [{ role: 'user', content: 'hello' }] }) as any;

    expect(out.messages[0].content).toEqual([{ type: 'text', text: 'hello', cache_control: CC }]);
  });

  it('is skipped when 4 markers are already present', () => {
    const body = {
      system: sys(3),
      tools: [{ name: 'x', cache_control: CC }],
      messages: [{ role: 'user', content: 'hi' }],
    };

    expect(addTailCacheBreakpoint(body)).toBe(body);
  });

  it('skips a trailing thinking block and marks the previous block', () => {
    const out = addTailCacheBreakpoint({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'plan' },
            { type: 'redacted_thinking', data: 'x' },
            { type: 'thinking', thinking: 'hmm', signature: 's' },
          ],
        },
      ],
    }) as any;

    expect(out.messages[0].content[0].cache_control).toEqual(CC);
    expect(out.messages[0].content[1].cache_control).toBeUndefined();
    expect(out.messages[0].content[2].cache_control).toBeUndefined();
  });

  it('never marks an empty text block (API 400)', () => {
    const out = addTailCacheBreakpoint({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'real' },
            { type: 'text', text: '' },
          ],
        },
      ],
    }) as any;

    expect(out.messages[0].content[0].cache_control).toEqual(CC);
    expect(out.messages[0].content[1].cache_control).toBeUndefined();
  });

  it('returns the body unchanged when no block is eligible', () => {
    const body = { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }] };

    expect(addTailCacheBreakpoint(body)).toBe(body);
  });

  it('no messages → unchanged', () => {
    const empty = { messages: [] };
    const none = { system: sys(1) };

    expect(addTailCacheBreakpoint(empty)).toBe(empty);
    expect(addTailCacheBreakpoint(none)).toBe(none);
  });

  it('does not mutate its input', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    const snapshot = JSON.stringify(body);

    const out = addTailCacheBreakpoint(body);

    expect(JSON.stringify(body)).toBe(snapshot);
    expect(out).not.toBe(body);
  });

  it('CONTROL: 3 system markers + the tail → exactly 4', () => {
    const out = addTailCacheBreakpoint({ system: sys(3), messages: [{ role: 'user', content: 'go' }] });

    expect(countCacheControls(out)).toBe(4);
  });
});

describe('countCacheControls', () => {
  it('counts system, tools and message blocks', () => {
    expect(
      countCacheControls({
        system: sys(2),
        tools: [{ name: 'a', cache_control: CC }, { name: 'b' }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'x', cache_control: CC }] },
          { role: 'user', content: 'y' },
        ],
      }),
    ).toBe(4);
    expect(countCacheControls(null)).toBe(0);
    expect(countCacheControls({})).toBe(0);
  });
});

describe('tailCacheFetch', () => {
  const ok = (_input?: unknown, _init?: unknown) => Promise.resolve(new Response('{}'));

  it('passes a non-JSON body through with the identical init', async () => {
    const base = vi.fn(ok);
    const init = { method: 'POST', body: 'not json' };

    await tailCacheFetch(base as unknown as typeof fetch)('https://x', init);

    expect(base.mock.calls[0][1]).toBe(init);
  });

  it('passes a non-string body through with the identical init', async () => {
    const base = vi.fn(ok);
    const init = { method: 'POST', body: new Uint8Array([1]) };

    await tailCacheFetch(base as unknown as typeof fetch)('https://x', init as RequestInit);

    expect(base.mock.calls[0][1]).toBe(init);
  });

  it('rewrites a Messages body with the tail breakpoint', async () => {
    const base = vi.fn(ok);

    await tailCacheFetch(base as unknown as typeof fetch)('https://x', {
      method: 'POST',
      body: JSON.stringify({ system: sys(3), messages: [{ role: 'user', content: 'go' }] }),
    });

    const sent = JSON.parse(String((base.mock.calls[0][1] as RequestInit).body));
    expect(sent.messages[0].content).toEqual([{ type: 'text', text: 'go', cache_control: CC }]);
    expect(countCacheControls(sent)).toBe(4);
  });

  it('leaves the init identical when there is nothing to add', async () => {
    const base = vi.fn(ok);
    const init = {
      method: 'POST',
      body: JSON.stringify({ system: sys(4), messages: [{ role: 'user', content: 'go' }] }),
    };

    await tailCacheFetch(base as unknown as typeof fetch)('https://x', init);

    expect(base.mock.calls[0][1]).toBe(init);
  });
});

describe('withTailCache', () => {
  it('is the identity when the tool loop is off', () => {
    const base = vi.fn() as unknown as typeof fetch;

    expect(withTailCache(base, false)).toBe(base);
    expect(withTailCache(base, undefined)).toBe(base);
  });

  it('wraps when the tool loop is on', () => {
    const base = vi.fn() as unknown as typeof fetch;

    expect(withTailCache(base, true)).not.toBe(base);
  });
});
