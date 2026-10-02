/**
 * fal.ai's baked, media-only price list and its admin feed (`_specs/media-gateways_plan.md` T2).
 *
 * Media debits run BEFORE the spend, from an exact number, and `lookupMediaPrice` has no
 * most-expensive fallback — so a fal row that fails to resolve is a refused render, and a row that
 * resolves to the wrong variant is a wrong debit with nothing thrown. Every row in the plan's fal
 * table is therefore resolved here in its own unit and variants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_FAL_PRICES, FAL_PRICE_SOURCES } from './baked-fal-prices';
import { FAL_PRICING_BATCH, fetchFalMarketFeed } from './market-feed';
import { lookupMediaPrice, validateMarketPriceList } from './market-prices';
import { invalidateMarketPricesCache } from './market-price-store';
import { setObjectStore, type ObjectStore } from '~/lib/.server/storage';

vi.mock('~/lib/.server/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireAdmin: async () => ({ id: 'admin', isAdmin: true }),
}));

/** The plan's fal table — every id, in order. A row missing from the baked list fails here by name. */
const PLAN_IDS = [
  'fal-ai/nano-banana-2',
  'fal-ai/nano-banana-pro',
  'fal-ai/bytedance/seedream/v4.5/text-to-image',
  'fal-ai/bria/background/remove',
  'fal-ai/kling-video/v3/standard/text-to-video',
  'fal-ai/kling-video/v3/pro/text-to-video',
  'xai/grok-imagine-video/text-to-video',
  'fal-ai/veo3/fast',
  'fal-ai/veo3',
  'fal-ai/elevenlabs/sound-effects/v2',
  'fal-ai/elevenlabs/tts/multilingual-v2',
  'fal-ai/elevenlabs/tts/turbo-v2.5',
  'fal-ai/minimax-music/v2.6',
] as const;

const price = (query: Parameters<typeof lookupMediaPrice>[1]) => lookupMediaPrice(BAKED_FAL_PRICES, query)?.usd;

describe('the baked fal list', () => {
  it('validates as a media-only list', () => {
    const result = validateMarketPriceList(BAKED_FAL_PRICES, 'FAL');

    expect(result.ok, result.ok ? '' : (result as { errors: string[] }).errors.join('; ')).toBe(true);
  });

  it('carries exactly the plan table, and cites a source for every row', () => {
    expect(Object.keys(BAKED_FAL_PRICES.media).sort()).toEqual([...PLAN_IDS].sort());

    for (const id of PLAN_IDS) {
      expect(FAL_PRICE_SOURCES[id], `${id} has no recorded source`).toMatch(
        /^https:\/\/fal\.ai\/models\/.+\/llms\.txt/,
      );
    }

    expect(BAKED_FAL_PRICES.source).toMatch(/fal list price; account-specific discounts may apply/);
  });

  it('prices every fal row in the plan table', () => {
    /* Images + the cut-out: flat per request. */
    expect(price({ model: 'fal-ai/nano-banana-2', options: { resolution: '1K' } })).toBe(0.08);
    expect(price({ model: 'fal-ai/nano-banana-pro', options: { resolution: '1K' } })).toBe(0.15);
    expect(price({ model: 'fal-ai/nano-banana-pro', options: { resolution: '2K' } })).toBe(0.15);
    expect(price({ model: 'fal-ai/nano-banana-pro', options: { resolution: '4K' } })).toBe(0.3);
    expect(price({ model: 'fal-ai/bytedance/seedream/v4.5/text-to-image', options: {} })).toBe(0.04);
    expect(price({ model: 'fal-ai/bria/background/remove', options: {} })).toBe(0.018);

    /* Video: per second, by variant. */
    const video = (model: string, options: Record<string, string | boolean>, durationSeconds: number) =>
      price({ model, options, durationSeconds });

    expect(video('fal-ai/kling-video/v3/standard/text-to-video', { generate_audio: false }, 5)).toBeCloseTo(0.42, 9);
    expect(video('fal-ai/kling-video/v3/pro/text-to-video', { generate_audio: false }, 5)).toBeCloseTo(0.56, 9);
    expect(video('fal-ai/kling-video/v3/pro/text-to-video', { generate_audio: true }, 5)).toBeCloseTo(0.84, 9);
    expect(video('xai/grok-imagine-video/text-to-video', { resolution: '480p' }, 6)).toBeCloseTo(0.3, 9);
    expect(video('xai/grok-imagine-video/text-to-video', { resolution: '720p' }, 6)).toBeCloseTo(0.42, 9);
    expect(video('fal-ai/veo3/fast', { generate_audio: false }, 4)).toBeCloseTo(0.4, 9);
    expect(video('fal-ai/veo3/fast', { generate_audio: true }, 4)).toBeCloseTo(0.6, 9);
    expect(video('fal-ai/veo3', { generate_audio: false }, 8)).toBeCloseTo(1.6, 9);
    expect(video('fal-ai/veo3', { generate_audio: true }, 8)).toBeCloseTo(3.2, 9);

    /* Sound: a per-second effect, per-1k-character speech, a per-request song. */
    expect(price({ model: 'fal-ai/elevenlabs/sound-effects/v2', options: {}, durationSeconds: 3 })).toBeCloseTo(
      0.006,
      9,
    );
    expect(price({ model: 'fal-ai/elevenlabs/tts/multilingual-v2', options: {}, textChars: 1000 })).toBeCloseTo(0.1, 9);
    expect(price({ model: 'fal-ai/elevenlabs/tts/turbo-v2.5', options: {}, textChars: 60 })).toBeCloseTo(0.003, 9);
    expect(price({ model: 'fal-ai/minimax-music/v2.6', options: {} })).toBe(0.15);
  });

  it('a 4K nano-banana-2 costs twice the 1K row', () => {
    const k1 = price({ model: 'fal-ai/nano-banana-2', options: { resolution: '1K' } })!;

    expect(price({ model: 'fal-ai/nano-banana-2', options: { resolution: '4K' } })).toBeCloseTo(2 * k1, 9);
    expect(price({ model: 'fal-ai/nano-banana-2', options: { resolution: '2K' } })).toBeCloseTo(1.5 * k1, 9);
  });

  /*
   * ⚠️ The plan named this `kling v3 standard with audio costs 0.126/s` — the model page's number. fal's
   * pricing API, called with the platform key on 2026-10-01, reports $0.14/s for the model's default
   * (audio-on) configuration, and the higher number ships because a debit is taken BEFORE the render.
   */
  it('kling v3 standard with audio costs the measured 0.14/s (the model page says 0.126)', () => {
    expect(
      price({
        model: 'fal-ai/kling-video/v3/standard/text-to-video',
        options: { generate_audio: true },
        durationSeconds: 1,
      }),
    ).toBe(0.14);
  });

  it.each([
    ['a per-second video with no duration', { model: 'fal-ai/veo3/fast', options: { generate_audio: false } }],
    ['a sound effect with no duration', { model: 'fal-ai/elevenlabs/sound-effects/v2', options: {} }],
    ['speech with no characters', { model: 'fal-ai/elevenlabs/tts/multilingual-v2', options: {} }],
    ['a video whose audio switch is unstated', { model: 'fal-ai/veo3/fast', options: {}, durationSeconds: 4 }],
    ['an unpriced resolution', { model: 'fal-ai/nano-banana-2', options: { resolution: '8K' } }],
    ['a model the list does not carry', { model: 'fal-ai/flux-2-pro', options: {} }],
  ])('REFUSES %s — never guessed', (_label, query) => {
    expect(lookupMediaPrice(BAKED_FAL_PRICES, query)).toBeNull();
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * The admin feed
 * ------------------------------------------------------------------------------------------------
 */

describe('fetchFalMarketFeed', () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];

  beforeEach(() => {
    seen.length = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()) });

      const ids = (new URL(url).searchParams.get('endpoint_id') ?? '').split(',');

      return new Response(
        JSON.stringify({
          prices: ids.map((id) => ({ endpoint_id: id, unit_price: 0.08, unit: 'images', currency: 'USD' })),
          next_cursor: null,
          has_more: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchFalMarketFeed sends Key auth and batches endpoint ids', async () => {
    const endpointIds = Array.from({ length: 120 }, (_, i) => `fal-ai/model-${i}`);
    const feed = await fetchFalMarketFeed('test-fal-key', { endpointIds });

    expect(FAL_PRICING_BATCH).toBe(50);
    expect(seen).toHaveLength(3);

    for (const request of seen) {
      expect(request.url.startsWith('https://api.fal.ai/v1/models/pricing?endpoint_id=')).toBe(true);

      /* fal's scheme is `Key`, never `Bearer`. */
      expect(request.headers.authorization).toBe('Key test-fal-key');
    }

    /* Ids are joined with a literal comma and the slash survives — fal reads them as separate ids. */
    expect(seen[0].url).toContain('endpoint_id=fal-ai%2Fmodel-0,fal-ai%2Fmodel-1,');
    expect(new URL(seen[0].url).searchParams.get('endpoint_id')!.split(',')).toHaveLength(50);
    expect(new URL(seen[2].url).searchParams.get('endpoint_id')!.split(',')).toHaveLength(20);

    expect(feed.rows).toHaveLength(120);
    expect(feed.reportedTotal).toBe(120);
    expect(feed.rows[0]).toEqual({ endpointId: 'fal-ai/model-0', unitPrice: 0.08, unit: 'images', currency: 'USD' });
  });

  it('asks only about the ids the filter keeps', async () => {
    await fetchFalMarketFeed('k', { endpointIds: [...PLAN_IDS], filter: 'ELEVENLABS' });

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).searchParams.get('endpoint_id')!.split(',')).toEqual([
      'fal-ai/elevenlabs/sound-effects/v2',
      'fal-ai/elevenlabs/tts/multilingual-v2',
      'fal-ai/elevenlabs/tts/turbo-v2.5',
    ]);
  });

  it('throws on a non-OK status, naming it', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"nope"}', { status: 401 }));

    await expect(fetchFalMarketFeed('k', { endpointIds: ['fal-ai/veo3'] })).rejects.toThrow(/HTTP 401/);
  });

  it('throws on a body with no prices array rather than reading through it', async () => {
    vi.stubGlobal('fetch', async () => new Response('null', { status: 200 }));

    await expect(fetchFalMarketFeed('k', { endpointIds: ['fal-ai/veo3'] })).rejects.toThrow(/no prices array/);
  });
});

/*
 * ------------------------------------------------------------------------------------------------ *
 * The admin route's FAL dispatch
 * ------------------------------------------------------------------------------------------------
 */

describe('POST /api/admin/market-prices fetch-feed (FAL)', () => {
  /* An empty in-memory store, so `ensureMarketPrices` can never resolve the developer's real `.data/`. */
  const emptyStore: ObjectStore = {
    backend: 'filesystem',
    put: async () => undefined,
    get: async () => null,
    delete: async () => undefined,
    list: async () => [],
  };

  beforeEach(() => {
    setObjectStore(emptyStore);
    invalidateMarketPricesCache();
  });

  afterEach(() => {
    setObjectStore(undefined);
    invalidateMarketPricesCache();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function fetchFeed(context: unknown = {}) {
    const { action } = await import('~/routes/api.admin.market-prices');
    const request = new Request('http://localhost/api/admin/market-prices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'fetch-feed', provider: 'FAL' }),
    });

    return action({ request, context, params: {} } as never);
  }

  it('reports FAL_API_KEY as not configured when the key is missing — and never calls fal', async () => {
    /* `env()` falls back to process.env, and vitest loads `.env.local` (which carries a real key). */
    vi.stubEnv('FAL_API_KEY', '');

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{}');
    });

    const response = await fetchFeed();
    const body = (await response.json()) as { message?: string };

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(body.message).toMatch(/FAL_API_KEY/);
    expect(calls).toEqual([]);
  });

  it('reads the prices of the ACTIVE fal list ids with the platform key', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);

      return new Response(JSON.stringify({ prices: [] }), { status: 200 });
    });

    const response = await fetchFeed({ cloudflare: { env: { FAL_API_KEY: 'route-test-key' } } });
    const body = (await response.json()) as { ok?: boolean; feed?: { reportedTotal: number } };

    expect(body.ok).toBe(true);
    expect(body.feed?.reportedTotal).toBe(PLAN_IDS.length);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^https:\/\/api\.fal\.ai\/v1\/models\/pricing\?endpoint_id=.* Key route-test-key$/);
  });
});
