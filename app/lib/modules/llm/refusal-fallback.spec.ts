/**
 * Pins the refusal-fallback wrapper (see refusal-fallback.ts for why it exists at all).
 *
 * The properties that matter, each failing silently if lost:
 *  - only a model WITH a table entry gets `fallbacks` + the beta header (adding the param for an
 *    un-entitled model risks a hard 400 on every request);
 *  - the beta header APPENDS to an existing `anthropic-beta` (overwriting drops the SDK's own betas);
 *  - the stream filter drops the `fallback` content block's start AND its stop, passes everything
 *    else byte-identical, and buffers only a partial event's tail (the streaming contract);
 *  - a refusal that survives the chain produces user copy that does NOT match the retry ladder's
 *    `/returned an empty response/i` (a same-model auto-retry of a refusal only repeats it).
 */
import { describe, expect, it } from 'vitest';
import {
  createFallbackBlockFilter,
  describeRefusal,
  refusalFallbackFetch,
  refusalFallbackModelFor,
  SERVER_SIDE_FALLBACK_BETA,
  type FallbackHandoff,
} from './refusal-fallback';

const EVENT = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;

const FALLBACK_START = EVENT({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-5' } },
});
const FALLBACK_STOP = EVENT({ type: 'content_block_stop', index: 0 });
const TEXT_START = EVENT({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
const TEXT_DELTA = EVENT({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } });
const TEXT_STOP = EVENT({ type: 'content_block_stop', index: 1 });

function collectFilter() {
  const handoffs: FallbackHandoff[] = [];
  const filter = createFallbackBlockFilter((h) => handoffs.push(h));

  return { filter, handoffs };
}

describe('refusalFallbackModelFor', () => {
  it('maps fable-5 to opus-5 and nothing else', () => {
    expect(refusalFallbackModelFor('claude-fable-5')).toBe('claude-opus-5');
    expect(refusalFallbackModelFor('claude-opus-5')).toBeUndefined();
    expect(refusalFallbackModelFor('claude-sonnet-5')).toBeUndefined();
  });
});

describe('createFallbackBlockFilter', () => {
  it('drops the fallback block start/stop pair and records the handoff', () => {
    const { filter, handoffs } = collectFilter();

    const out = filter.push(FALLBACK_START + FALLBACK_STOP + TEXT_START + TEXT_DELTA + TEXT_STOP);

    expect(out).toBe(TEXT_START + TEXT_DELTA + TEXT_STOP);
    expect(handoffs).toEqual([{ from: 'claude-fable-5', to: 'claude-opus-5' }]);
  });

  it('passes non-fallback events byte-identical on a SINGLE push (streaming contract)', () => {
    const { filter } = collectFilter();

    expect(filter.push(TEXT_DELTA)).toBe(TEXT_DELTA);
  });

  it('does not drop an ordinary content_block_stop that shares no dropped index', () => {
    const { filter } = collectFilter();

    // Fallback at index 0 dropped; the text block's stop at index 1 must survive.
    filter.push(FALLBACK_START + FALLBACK_STOP);
    expect(filter.push(TEXT_STOP)).toBe(TEXT_STOP);
  });

  it('handles an event split across two pushes (partial tail buffered, then released whole)', () => {
    const { filter } = collectFilter();
    const split = Math.floor(TEXT_DELTA.length / 2);

    expect(filter.push(TEXT_DELTA.slice(0, split))).toBe('');
    expect(filter.push(TEXT_DELTA.slice(split))).toBe(TEXT_DELTA);
  });

  it('drops a fallback event even when IT is split across pushes', () => {
    const { filter, handoffs } = collectFilter();
    const split = Math.floor(FALLBACK_START.length / 2);

    expect(filter.push(FALLBACK_START.slice(0, split))).toBe('');
    expect(filter.push(FALLBACK_START.slice(split))).toBe('');
    expect(handoffs).toHaveLength(1);
  });

  it('flush releases a buffered partial tail verbatim', () => {
    const { filter } = collectFilter();
    const partial = 'event: message_stop\ndata: {"type":"message_stop"}';

    filter.push(partial);
    expect(filter.flush()).toBe(partial);
  });
});

describe('refusalFallbackFetch', () => {
  const request = (body: object) => ({
    body: JSON.stringify(body),
    headers: { 'anthropic-beta': 'output-128k' } as Record<string, string>,
    method: 'POST',
  });

  function captureFetch(response = new Response('{}', { headers: { 'content-type': 'application/json' } })) {
    const seen: { init?: RequestInit } = {};

    const baseFetch = (async (_input: unknown, init?: RequestInit) => {
      seen.init = init;

      return response;
    }) as unknown as typeof fetch;

    return { seen, baseFetch };
  }

  it('adds fallbacks + APPENDS the beta header for a table model', async () => {
    const { seen, baseFetch } = captureFetch();

    await refusalFallbackFetch('claude-fable-5', baseFetch)('https://x/', request({ model: 'claude-fable-5' }));

    const body = JSON.parse(seen.init?.body as string);
    expect(body.fallbacks).toEqual([{ model: 'claude-opus-5' }]);

    const headers = new Headers(seen.init?.headers);
    expect(headers.get('anthropic-beta')).toBe(`output-128k,${SERVER_SIDE_FALLBACK_BETA}`);
  });

  it('is a byte-identical passthrough for a model with no table entry', async () => {
    const { seen, baseFetch } = captureFetch();
    const init = request({ model: 'claude-sonnet-5' });

    await refusalFallbackFetch('claude-sonnet-5', baseFetch)('https://x/', init);

    // The wrapper returns baseFetch itself — the init object must be the very one passed in.
    expect(seen.init).toBe(init);
  });

  it('strips fallback blocks from an event-stream response', async () => {
    const stream = new Response(FALLBACK_START + FALLBACK_STOP + TEXT_DELTA, {
      headers: { 'content-type': 'text/event-stream' },
    });
    const { baseFetch } = captureFetch(stream);

    const response = await refusalFallbackFetch('claude-fable-5', baseFetch)(
      'https://x/',
      request({ model: 'claude-fable-5' }),
    );

    expect(await response.text()).toBe(TEXT_DELTA);
  });

  it('leaves a non-stream response body untouched', async () => {
    const { baseFetch } = captureFetch(
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    );

    const response = await refusalFallbackFetch('claude-fable-5', baseFetch)(
      'https://x/',
      request({ model: 'claude-fable-5' }),
    );

    expect(await response.text()).toBe('{"ok":true}');
  });
});

describe('describeRefusal', () => {
  it('names the category and shows the explanation', () => {
    const message = describeRefusal({
      stopReason: 'refusal',
      detail: '{"type":"refusal","category":"reasoning_extraction","explanation":"Blocked."}',
    });

    expect(message).toContain('category: reasoning_extraction');
    expect(message).toContain('Blocked.');
  });

  it('never matches the retry ladder pattern for empty responses', () => {
    for (const detail of [undefined, '{"category":null,"explanation":null}', 'not json']) {
      expect(describeRefusal({ stopReason: 'refusal', detail })).not.toMatch(/returned an empty response/i);
    }
  });
});
