import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchOutcome } from '~/lib/.server/net/web-search';

const webSearch = vi.fn<(query: string, limit?: number) => Promise<SearchOutcome>>();
const append = vi.fn();

vi.mock('~/lib/.server/net/web-search', async (orig) => ({
  ...(await orig<typeof import('~/lib/.server/net/web-search')>()),
  webSearch,
}));

vi.mock('~/lib/.server/billing/ledger', () => ({ getLedger: () => ({ append }) }));

vi.mock('~/lib/.server/billing/market-price-store', () => ({
  ensureMarketPrices: async () => undefined,
  activeMarketPrices: () => ({ search: { creditsPerSearch: 10 } }),
}));

const { createWebSearchTool } = await import('./web-search-tool');

const exec = (tool: any, args: { query?: string; limit?: number }) =>
  tool.web_search.execute(args, { toolCallId: 'c1', messages: [] });

const okOutcome = (billable: boolean): SearchOutcome => ({
  ok: true,
  provider: billable ? 'serpapi' : 'duckduckgo',
  billable,
  results: [{ title: 'CharacterController.Move', url: 'https://docs.unity3d.com/cc', snippet: 'Moves it.' }],
});

describe('web_search tool — behavior', () => {
  beforeEach(() => {
    webSearch.mockReset();
    append.mockReset();
  });

  it('asks for a query instead of throwing when none is given', async () => {
    const result = await exec(createWebSearchTool(), {});
    expect(result).toContain('needs a "query"');
    expect(webSearch).not.toHaveBeenCalled();
  });

  it('formats results as a numbered list and points at web_fetch', async () => {
    webSearch.mockResolvedValue(okOutcome(true));

    const result = await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });
    expect(result).toContain('1. CharacterController.Move');
    expect(result).toContain('web_fetch');
  });

  it('returns a friendly, non-throwing message on backend failure', async () => {
    webSearch.mockResolvedValue({ ok: false, error: 'Search timed out.' });

    const result = await exec(createWebSearchTool({ userId: 'u1' }), { query: 'x' });
    expect(result).toContain('Web search failed');
    expect(append).not.toHaveBeenCalled();
  });

  it('handles zero results without throwing', async () => {
    webSearch.mockResolvedValue({ ok: true, provider: 'serpapi', billable: true, results: [] });

    const result = await exec(createWebSearchTool({ userId: 'u1' }), { query: 'asdkjh' });
    expect(result).toContain('No results found');
  });
});

describe('web_search tool — billing', () => {
  beforeEach(() => {
    webSearch.mockReset();
    append.mockReset();
  });

  it('debits the flat search credits (reason=search, negative) on a billable search', async () => {
    webSearch.mockResolvedValue(okOutcome(true));
    await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', delta: -10, reason: 'search' }));
  });

  it('does NOT debit a free-provider search (DuckDuckGo/SearXNG)', async () => {
    webSearch.mockResolvedValue(okOutcome(false));
    await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });
    expect(append).not.toHaveBeenCalled();
  });

  it('does NOT debit when there is no billing context', async () => {
    webSearch.mockResolvedValue(okOutcome(true));
    await exec(createWebSearchTool(), { query: 'unity move' });
    expect(append).not.toHaveBeenCalled();
  });

  it('never throws into the tool if the debit fails — research still returns', async () => {
    webSearch.mockResolvedValue(okOutcome(true));
    append.mockRejectedValue(new Error('ledger down'));

    const result = await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });
    expect(result).toContain('CharacterController.Move'); // results still delivered
  });
});
