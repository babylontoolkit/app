import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScrapeResult } from '~/lib/.server/net/fetch-url';

const scrapeUrl = vi.fn<(url: string) => Promise<ScrapeResult>>();

vi.mock('~/lib/.server/net/fetch-url', () => ({ scrapeUrl }));

const { createWebFetchTool } = await import('./web-fetch-tool');

const exec = (args: { url?: string }) =>
  (createWebFetchTool().web_fetch as any).execute(args, { toolCallId: 'c1', messages: [] });

describe('web_fetch tool', () => {
  beforeEach(() => scrapeUrl.mockReset());

  it('asks for a url instead of throwing when none is given (a bad arg must be recoverable)', async () => {
    const result = await exec({});
    expect(result).toContain('needs a "url"');
    expect(scrapeUrl).not.toHaveBeenCalled();
  });

  it('returns the fetched text with title/description on success', async () => {
    scrapeUrl.mockResolvedValue({
      ok: true,
      title: 'Babylon Toolkit',
      description: 'Game platform',
      content: 'Build web games.',
      sourceUrl: 'https://www.babylontoolkit.com',
    });

    const result = await exec({ url: 'https://www.babylontoolkit.com' });

    expect(result).toContain('Fetched https://www.babylontoolkit.com');
    expect(result).toContain('Title: Babylon Toolkit');
    expect(result).toContain('Description: Game platform');
    expect(result).toContain('Build web games.');
  });

  it('returns a friendly, non-throwing message when the fetch is refused', async () => {
    scrapeUrl.mockResolvedValue({ ok: false, status: 400, error: 'URL resolves to a private address.' });

    // Must RESOLVE (not reject): a thrown error would kill the paid generation.
    const result = await exec({ url: 'http://169.254.169.254/latest/meta-data' });

    expect(result).toContain('Could not fetch');
    expect(result).toContain('private address');
  });

  it('handles a page with no readable text', async () => {
    scrapeUrl.mockResolvedValue({ ok: true, title: '', description: '', content: '', sourceUrl: 'https://x.test' });

    const result = await exec({ url: 'https://x.test' });
    expect(result).toContain('(no readable text content)');
  });
});
