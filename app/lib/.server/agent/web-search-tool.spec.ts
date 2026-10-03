import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchOutcome } from '~/lib/.server/net/web-search';

const webSearch = vi.fn<(query: string, limit?: number, provider?: unknown) => Promise<SearchOutcome>>();
const append = vi.fn();
const alert = vi.fn();

/*
 * The backend is resolved BEFORE the call (the toll is debited first), so billability is the PROVIDER's —
 * mocked, never read from `process.env` (vitest loads `.env.local`, and a developer's real SERPAPI key would
 * decide these assertions: the `env()` trap).
 */
const backend = vi.hoisted(() => ({ billable: true }));

vi.mock('~/lib/.server/net/web-search', async (orig) => ({
  ...(await orig<typeof import('~/lib/.server/net/web-search')>()),
  webSearch,
  getSearchProvider: () => ({ name: backend.billable ? 'serpapi' : 'duckduckgo', billable: backend.billable }),
}));

vi.mock('~/lib/.server/monitoring', () => ({ getMonitor: () => ({ alert }) }));

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

beforeEach(() => {
  backend.billable = true;
  alert.mockReset();
  vi.stubEnv('BILLING_ENFORCED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    backend.billable = false;
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

  /*
   * 🔴 no-unbilled-usage D9: the toll lands BEFORE the vendor is paid. It used to debit after the vendor
   * returned and only LOG a failed debit — a ledger hiccup meant a paid search nobody was charged for.
   */
  it('debits BEFORE the vendor call', async () => {
    const order: string[] = [];

    append.mockImplementation(async () => void order.push('debit'));
    webSearch.mockImplementation(async () => {
      order.push('vendor');
      return okOutcome(true);
    });

    await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });

    expect(order).toEqual(['debit', 'vendor']);
  });

  it('runs the search on the backend it billed for — the resolved provider is handed down', async () => {
    webSearch.mockResolvedValue(okOutcome(true));
    await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });

    expect(webSearch.mock.calls[0][2]).toMatchObject({ name: 'serpapi', billable: true });
  });

  it('enforced: a debit that cannot land ALERTS and the vendor is NOT called', async () => {
    append.mockRejectedValue(new Error('ledger down'));

    const result = await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });

    expect(webSearch, 'never spend we cannot bill').not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(result).toContain('unavailable');
  });

  /* CONTROL — unmetered mode is unchanged: a failed debit never blocks research. */
  it('CONTROL unmetered: a failed debit still returns the research, uncharged', async () => {
    vi.stubEnv('BILLING_ENFORCED', 'false');
    webSearch.mockResolvedValue(okOutcome(true));
    append.mockRejectedValue(new Error('ledger down'));

    const result = await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });
    expect(result).toContain('CharacterController.Move');
    expect(alert).not.toHaveBeenCalled();
  });

  it('refunds the toll on a DEFINITE vendor failure', async () => {
    webSearch.mockResolvedValue({ ok: false, error: 'SerpApi returned 401' });

    await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0][0]).toMatchObject({ delta: -10, reason: 'search' });
    expect(append.mock.calls[1][0]).toMatchObject({ delta: 10, reason: 'refund' });
  });

  it('keeps the toll on a timeout — the vendor may have served (and billed) it', async () => {
    webSearch.mockResolvedValue({ ok: false, error: 'Search timed out.', maybeCharged: true });

    await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({ delta: -10, reason: 'search' });
  });

  it('does NOT debit a free-provider search (DuckDuckGo/SearXNG)', async () => {
    backend.billable = false;
    webSearch.mockResolvedValue(okOutcome(false));
    await exec(createWebSearchTool({ userId: 'u1' }), { query: 'unity move' });
    expect(append).not.toHaveBeenCalled();
  });

  it('does NOT debit when there is no billing context', async () => {
    webSearch.mockResolvedValue(okOutcome(true));
    await exec(createWebSearchTool(), { query: 'unity move' });
    expect(append).not.toHaveBeenCalled();
  });
});
