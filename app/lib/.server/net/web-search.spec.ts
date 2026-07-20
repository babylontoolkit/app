import { describe, it, expect } from 'vitest';
import { resolveDuckDuckGoHref, parseDuckDuckGoHtml, getSearchProvider } from './web-search';

describe('getSearchProvider selection', () => {
  it('prefers SerpApi above everything when its key is set', () => {
    expect(
      getSearchProvider({ SERPAPI_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'b', SEARXNG_URL: 'https://s.test' }).name,
    ).toBe('serpapi');
  });

  it('uses Brave when no SerpApi key but a Brave key is set', () => {
    expect(getSearchProvider({ BRAVE_SEARCH_API_KEY: 'k', SEARXNG_URL: 'https://s.test' }).name).toBe('brave');
  });

  it('uses SearXNG when only an instance URL is set', () => {
    expect(getSearchProvider({ SEARXNG_URL: 'https://s.test' }).name).toBe('searxng');
  });

  it('falls back to the no-key DuckDuckGo scrape when nothing is configured', () => {
    expect(getSearchProvider({}).name).toBe('duckduckgo');
  });
});

describe('resolveDuckDuckGoHref', () => {
  it('decodes the uddg redirect param to the real target', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1&rut=abc';
    expect(resolveDuckDuckGoHref(href)).toBe('https://example.com/docs?a=1');
  });

  it('promotes a protocol-relative absolute URL to https', () => {
    expect(resolveDuckDuckGoHref('//example.com/page')).toBe('https://example.com/page');
  });

  it('keeps an absolute http/https URL as-is', () => {
    expect(resolveDuckDuckGoHref('https://docs.unity3d.com/x')).toBe('https://docs.unity3d.com/x');
  });

  it('drops an internal DDG link with no target', () => {
    expect(resolveDuckDuckGoHref('//duckduckgo.com/y.js?ad=1')).toBeNull();
    expect(resolveDuckDuckGoHref('')).toBeNull();
    expect(resolveDuckDuckGoHref('not a url')).toBeNull();
  });
});

describe('parseDuckDuckGoHtml', () => {
  const html = `
    <div class="result results_links">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.unity3d.com%2Fcc">CharacterController.Move</a>
      <a class="result__snippet" href="x">Moves the controller with a given motion, honoring collisions.</a>
    </div>
    <div class="result results_links">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fforum.unity.com%2Ft%2Fmove">How do I move a <b>character</b>?</a>
      <a class="result__snippet" href="y">Use CharacterController.Move in Update, multiply by Time.deltaTime.</a>
    </div>`;

  it('parses results into title/url/snippet, stripping tags', () => {
    const results = parseDuckDuckGoHtml(html, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'CharacterController.Move',
      url: 'https://docs.unity3d.com/cc',
      snippet: 'Moves the controller with a given motion, honoring collisions.',
    });
    expect(results[1].title).toContain('How do I move a character'); // <b> tags stripped
    expect(results[1].title).not.toContain('<b>');
    expect(results[1].url).toBe('https://forum.unity.com/t/move');
  });

  it('respects the limit', () => {
    expect(parseDuckDuckGoHtml(html, 1)).toHaveLength(1);
  });

  it('returns nothing for empty/garbage HTML', () => {
    expect(parseDuckDuckGoHtml('<html><body>no results</body></html>', 10)).toEqual([]);
  });
});
