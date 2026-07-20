import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractTitle, extractMetaDescription, extractTextContent } from './fetch-url';

describe('HTML extraction (pure)', () => {
  it('pulls the title', () => {
    expect(extractTitle('<html><head><title> Hello World </title></head></html>')).toBe('Hello World');
    expect(extractTitle('<html><head></head></html>')).toBe('');
  });

  it('pulls the meta description in either attribute order', () => {
    expect(extractMetaDescription('<meta name="description" content="A game platform">')).toBe('A game platform');
    expect(extractMetaDescription('<meta content="Reversed order" name="description">')).toBe('Reversed order');
  });

  it('strips scripts, styles, and tags down to readable text', () => {
    const html = '<body><script>evil()</script><style>.a{}</style><h1>Title</h1><p>Body &amp; more</p></body>';
    const text = extractTextContent(html);
    expect(text).toContain('Title');
    expect(text).toContain('Body & more');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('.a{}');
  });
});

describe('scrapeUrl SSRF refusals (no network)', () => {
  // These must be refused at the string level BEFORE any fetch — assert fetch is never called.
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('refuses a non-URL / non-http scheme without fetching', async () => {
    const { scrapeUrl } = await import('./fetch-url');

    for (const bad of ['not a url', 'file:///etc/passwd', 'ftp://example.com', '']) {
      const result = await scrapeUrl(bad);
      expect(result.ok).toBe(false);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses cloud-metadata / private addresses without fetching', async () => {
    const { scrapeUrl } = await import('./fetch-url');

    for (const priv of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1/', 'http://10.0.0.5/']) {
      const result = await scrapeUrl(priv);
      expect(result.ok).toBe(false);

      if (!result.ok) {
        expect(result.status).toBe(400);
      }
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
