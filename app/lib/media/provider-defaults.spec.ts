/**
 * THE DEFAULT MEDIA MODEL IS A PROPERTY OF THE GATEWAY (SPEC §4.16, T9).
 *
 * ## The defect these tests stand in front of
 *
 * `generate_image`, `generate_video` and `generate_google_video` carried three inlined default model
 * ids — `nano-banana-2`, `kling-3.0/video`, `veo3_fast` — every one of them a **KIE** model. Nothing
 * said so, because while KIE was the only gateway "a default model" and "a KIE model" were the same
 * string. On Comet none of them is in the price list, so `lookupMediaPrice` returns null and
 * `startMediaTask` refuses — correctly, before any debit — and the turn spends a whole tool round
 * rediscovering the catalogue. Measured on the first live Comet media turn (`gen_mso6s0gd_frqrfh`):
 * step 0 made three calls, all refused, 8.2s and 31,098 cache-write tokens for zero tasks.
 *
 * It SELF-HEALS (the refusal names the available models), which is exactly why it would never be
 * reported: the art arrives, the ledger is right, and the only trace is a turn that cost about twice
 * what it should have. §4.2.8's silent-failure shape — nothing throws and the bill goes up.
 *
 * ## The one assertion that makes this class of bug unshippable
 *
 * **Every default in the table is priced in that provider's OWN baked price list**, checked against
 * the REAL lists (`baked-market-prices.ts`, `baked-comet-prices.ts`) through the REAL resolver
 * (`findMediaModel`, which is what `quoteMediaRequest` calls), iterating `providersWithDefaults()`.
 *
 * ⚠️ **What would make this file vacuous, and how each is prevented:**
 *
 *  - *Checking the table against a copy of itself.* A default asserted to equal a literal declared in
 *    this spec proves only that it was typed consistently. So the price-list block never names an id
 *    at all — it takes whatever the table says and demands the price list answer for it.
 *  - *A resolver that says yes to everything.* `findMediaModel` returning a truthy row for any string
 *    would pass every case above, so there is a CONTROL asserting a fabricated id resolves to null on
 *    both lists.
 *  - *A table collapsed to one row.* "Both gateways have defaults" is true for a table where Comet is
 *    a copy of KIE — which is the original defect. So the per-gateway block asserts the ids DIFFER and
 *    asserts the literals, and the fallback block asserts the fallback returns KIE's row *and* that a
 *    recognised provider does not.
 *  - *An empty iteration.* Every parameterised block derives from `providersWithDefaults()`; a control
 *    pins that it is non-empty and equals `MEDIA_PROVIDERS`.
 *
 * Pure module, no env, no network, no `.data`: the defaults must be identical in a unit test and in
 * production, so nothing in them may depend on configuration.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_PROVIDERS } from '~/lib/.server/agent/config';
import { BAKED_MARKET_PRICES } from '~/lib/.server/billing/baked-market-prices';
import { BAKED_COMET_PRICES } from '~/lib/.server/billing/baked-comet-prices';
import { findMediaModel, type MarketPriceList } from '~/lib/.server/billing/market-prices';
import { activeMarketPrices, invalidateMarketPricesCache } from '~/lib/.server/billing/market-price-store';
import { nativeAlphaModelFor, type ImageProviderName } from './image-capabilities';
import {
  isGoogleVideoModel,
  mediaModelDefaults,
  providersWithDefaults,
  type MediaModelDefaults,
} from './provider-defaults';

/**
 * Which baked list prices which gateway.
 *
 * ⚠️ Declared here AND pinned to production below (`activeMarketPrices` with a cold cache returns the
 * baked list by reference). A spec that invents its own mapping can prove a Comet default is priced
 * by checking it against KIE's list — the exact confusion under test, one level up.
 */
const BAKED_BY_PROVIDER: Record<ImageProviderName, MarketPriceList> = {
  KIE: BAKED_MARKET_PRICES,
  Comet: BAKED_COMET_PRICES,
};

/** The three slots and the media `kind` each one MUST resolve to. */
const SLOTS: { slot: keyof Pick<MediaModelDefaults, 'image' | 'video' | 'googleVideo'>; kind: 'image' | 'video' }[] = [
  { slot: 'image', kind: 'image' },
  { slot: 'video', kind: 'video' },
  { slot: 'googleVideo', kind: 'video' },
];

beforeAll(() => {
  /*
   * `activeMarketPrices` answers from a module cache when one has been loaded. Nothing here loads one,
   * but clearing it makes the "the spec's mapping is production's mapping" assertion below a statement
   * about the baked tables rather than about whatever a neighbouring import happened to warm.
   */
  invalidateMarketPricesCache();
});

/*
 * ================================================================================================
 * 1. EVERY DEFAULT IS PRICED ON ITS OWN GATEWAY — the invariant the live defect violated
 * ================================================================================================
 */
describe('every default model is priced in that gateway’s own baked price list', () => {
  it('CONTROL — the spec’s provider→list mapping is production’s mapping', () => {
    /*
     * `market-price-store.ts` owns `BAKED_BY_PROVIDER` privately, so this is the only way to prove the
     * local copy above is not quietly pointing both gateways at the same list. Reference equality: a
     * structural match would pass for two tables that happen to agree today.
     */
    for (const provider of providersWithDefaults()) {
      expect(activeMarketPrices(provider), `${provider} maps to the wrong baked list`).toBe(
        BAKED_BY_PROVIDER[provider],
      );
    }

    // ...and the two lists are genuinely different documents, or "priced on its own gateway" means nothing.
    expect(BAKED_MARKET_PRICES).not.toBe(BAKED_COMET_PRICES);
  });

  for (const provider of providersWithDefaults()) {
    for (const { slot, kind } of SLOTS) {
      it(`${provider}: the ${slot} default resolves to a priced ${kind} row`, () => {
        /*
         * 🔴 THE ASSERTION. The id is READ from the table and handed to the resolver the money path
         * uses — this spec never names a model, so it cannot be satisfied by a consistently-typed
         * table. Restore any of the three KIE literals into the Comet row and this fails on that row,
         * which is precisely the live failure (`lookupMediaPrice` → null → `MediaRefusedError`).
         */
        const model = mediaModelDefaults(provider)[slot];

        /*
         * `video` may legitimately be null: a gateway whose only video models are Google Veo has NO
         * general-purpose video default, because `generate_video` may never resolve to Veo (owner
         * rule). "No default" is a state to skip pricing for, not a hole — the tool refuses instead,
         * and `the Google video rule` block below is what pins that it really is null where it must be.
         */
        if (model === null) {
          expect(slot, 'only the video slot may be absent — an image gateway with no image is broken').toBe('video');
          return;
        }

        const found = findMediaModel(BAKED_BY_PROVIDER[provider], model);

        expect(found, `${provider}'s ${slot} default "${model}" is not in ${provider}'s price list`).not.toBeNull();

        /*
         * And the RIGHT kind. An id that exists but prices the wrong thing is worse than a missing
         * one: `quoteMediaRequest` branches on `pricing.kind`, so an image default naming a video row
         * would price and DEBIT a video's worth of credits for a picture.
         */
        expect(
          found!.pricing.kind,
          `${provider}'s ${slot} default "${model}" is priced as a ${found!.pricing.kind}`,
        ).toBe(kind);
      });
    }
  }

  it('CONTROL — the resolver really can say no', () => {
    /*
     * Without this, every assertion above passes for a `findMediaModel` that returns a truthy row for
     * any string — i.e. for a price lookup that has stopped working, which reads as a clean bill of
     * health while every default is unpriceable in production.
     */
    for (const provider of providersWithDefaults()) {
      expect(findMediaModel(BAKED_BY_PROVIDER[provider], 'no-such-model-9')).toBeNull();
    }
  });

  it('CONTROL — a KIE default is NOT priced on Comet (the live defect, reproduced)', () => {
    /*
     * The measured failure in one line. If this ever starts passing, either Comet has adopted KIE's
     * slugs (fine, and then the whole table can collapse) or the mapping above has drifted — and
     * either way the block at the top of this file has stopped meaning anything.
     */
    expect(findMediaModel(BAKED_COMET_PRICES, 'nano-banana-2')).toBeNull();
    expect(findMediaModel(BAKED_COMET_PRICES, 'kling-3.0/video')).toBeNull();
    expect(findMediaModel(BAKED_COMET_PRICES, 'veo3_fast')).toBeNull();

    // ...and they ARE priced on KIE, so the null above is about the gateway, not about the ids.
    expect(findMediaModel(BAKED_MARKET_PRICES, 'nano-banana-2')).not.toBeNull();
    expect(findMediaModel(BAKED_MARKET_PRICES, 'kling-3.0/video')).not.toBeNull();
    expect(findMediaModel(BAKED_MARKET_PRICES, 'veo3_fast')).not.toBeNull();
  });
});

/*
 * ================================================================================================
 * 2. THE TABLE IS PER GATEWAY — a collapsed table IS the bug
 * ================================================================================================
 */
describe('the gateways have different defaults', () => {
  it('names different image and video models on each gateway', () => {
    const kie = mediaModelDefaults('KIE');
    const comet = mediaModelDefaults('Comet');

    /*
     * The whole point of T9. Collapse the table to one row — the state the code was in before the fix
     * — and all three of these fail, whichever row survives.
     */
    expect(kie.image).not.toBe(comet.image);
    expect(kie.video).not.toBe(comet.video);
    expect(kie.googleVideo).not.toBe(comet.googleVideo);
  });

  it('pins the literal ids, because the literal IS the fact', () => {
    /*
     * Literals rather than relations: "KIE's image default is not Comet's" stays true if both are
     * changed to nonsense together. These are the exact strings the wire will carry, and block 1 is
     * what proves each one is priced.
     */
    expect(mediaModelDefaults('KIE')).toEqual({
      image: 'nano-banana-2',
      video: 'kling-3.0/video',
      googleVideo: 'veo3_fast',
      videoAlternatives: ' Also: kling-2.6, bytedance/seedance-2, …',
      videoModeHint: 'kling-3.0 tier: std (720p), pro (1080p) or 4K. Default std.',
      videoResolutionHint: 'For seedance/grok models: 480p, 720p, 1080p, 4K.',
    });

    expect(mediaModelDefaults('Comet')).toEqual({
      image: 'gemini-3-pro-image',

      /*
       * NULL, and it is the whole owner rule in one field: every video model Comet prices is Google
       * Veo, and `generate_video` may never fall back to Veo. Putting either Veo id here is the exact
       * regression this block exists to catch.
       */
      video: null,
      googleVideo: 'veo3-fast',
      videoAlternatives: ' Also: veo3 (higher quality, ~4x the price).',

      /*
       * EMPTY, and that is the assertion. Comet serves no `kling-3.0*` model, so `mode` is never even
       * added to the payload, and its video rows price on `{}` — describing either knob would put
       * prose in the cached prefix for a control that cannot act. `toEqual` on the whole row is what
       * makes this hold: a new field added without a Comet answer fails here rather than silently
       * shipping KIE's wording as a default.
       */
      videoModeHint: '',
      videoResolutionHint: '',
    });
  });

  it('spells Veo differently on each gateway — one character, and it is the whole defect', () => {
    /*
     * The SAME model, two slugs: KIE wants `veo3_fast`, Comet `veo3-fast`. No type can tell you which
     * spelling a gateway wants, and the two look identical at a glance — so this is asserted on its
     * own rather than left inside the object comparison above, where a reviewer's eye slides past it.
     */
    expect(mediaModelDefaults('KIE').googleVideo).toBe('veo3_fast');
    expect(mediaModelDefaults('Comet').googleVideo).toBe('veo3-fast');
    expect(mediaModelDefaults('KIE').googleVideo).not.toBe(mediaModelDefaults('Comet').googleVideo);
  });

  it('never lets the general video slot equal the Google one', () => {
    /*
     * 🔴 REPLACES a test that asserted the OPPOSITE. It read "gives Comet the same model for the
     * general and the Google-specific video slot" and called the duplication deliberate — reasoning
     * that Veo was Comet's only video surface, so the general tool may as well point at it. That is
     * exactly the fallback the owner banned: `generate_google_video` exists so Veo is chosen on
     * purpose, and a general tool resolving to it spends the most expensive video on the catalogue
     * without anyone asking. The catalogue fact was right; the conclusion drawn from it was wrong.
     *
     * A gateway with no non-Google video has `video: null` — the slots are never EQUAL, on any
     * gateway, because a null and an id cannot be.
     */
    for (const provider of providersWithDefaults()) {
      const { video, googleVideo } = mediaModelDefaults(provider);

      expect(video, `${provider} points its general video slot at the Google model`).not.toBe(googleVideo);
    }
  });
});

/*
 * ================================================================================================
 * 3. COMET'S IMAGE DEFAULT IS THE CHEAP OPAQUE WORKHORSE, NOT THE ALPHA MODEL
 * ================================================================================================
 */
describe('Comet’s image default is not the transparency model', () => {
  it('is gemini-3-pro-image, never gpt-image-1.5', () => {
    /*
     * `gpt-image-1.5` exists on this gateway for ONE reason — it is the only model that emits a real
     * alpha channel — and a transparent request already resolves to it inside `realizeImageDelivery`.
     * Making it the default would charge every ordinary background for a capability nobody asked for,
     * silently, with the render still arriving and the ledger still correct.
     */
    expect(mediaModelDefaults('Comet').image).toBe('gemini-3-pro-image');
    expect(mediaModelDefaults('Comet').image).not.toBe('gpt-image-1.5');
  });

  it('routes transparency to gpt-image-1.5 WITHOUT it being the default (the control)', () => {
    /*
     * The pair that makes the assertion above safe rather than merely restrictive: alpha is still
     * reachable. Without this, "the default is not gpt-image-1.5" would also pass for a build where
     * the alpha capability had been deleted outright.
     */
    expect(nativeAlphaModelFor('Comet')).toBe('gpt-image-1.5');
    expect(nativeAlphaModelFor('Comet', mediaModelDefaults('Comet').image)).toBe('gpt-image-1.5');
  });

  it('costs materially less than the alpha model at the same ordinary 16:9 render', () => {
    /*
     * The price is the reason, so the price is asserted — with LITERALS from the baked list, because a
     * purely relational "cheaper than" comparison passes for two rows that were both repriced. $0.017
     * (the whole gemini row) against $0.062 for gpt-image-1.5 at medium/16:9, which is what an
     * ordinary background would have billed: ~3.6x, on every image, forever.
     */
    const gemini = findMediaModel(BAKED_COMET_PRICES, 'gemini-3-pro-image')!;
    const gptImage = findMediaModel(BAKED_COMET_PRICES, 'gpt-image-1.5')!;

    const geminiUsd = gemini.pricing.variants[0].usd;
    const gptMedium16x9 = gptImage.pricing.variants.find(
      (variant) => variant.options.quality === 'medium' && variant.options.aspectRatio === '16:9',
    )!;

    expect(geminiUsd).toBe(0.017);
    expect(gptMedium16x9.usd).toBe(0.062);
    expect(geminiUsd).toBeLessThan(gptMedium16x9.usd);
  });
});

/*
 * ================================================================================================
 * 4. AN UNRECOGNISED PROVIDER FALLS BACK — it must never throw
 * ================================================================================================
 */
describe('an unrecognised provider gets KIE’s row rather than an exception', () => {
  it('does not throw, and answers with KIE’s table', () => {
    /*
     * 🔴 This is called from inside a tool's `execute`, where a throw kills a generation the user has
     * already paid for (the zod-schema lesson: validate in `execute`, never in a way that can take the
     * turn down). A wrong-but-priced default is refused before any debit and names the alternatives; a
     * throw is not.
     */
    expect(() => mediaModelDefaults('Nonsense')).not.toThrow();
    expect(mediaModelDefaults('Nonsense')).toEqual(mediaModelDefaults('KIE'));
    expect(mediaModelDefaults('')).toEqual(mediaModelDefaults('KIE'));
  });

  it('CONTROL — a RECOGNISED provider does not take the fallback', () => {
    /*
     * Without this, "unknown → KIE" passes for a function that returns KIE's row for every input,
     * including 'Comet' — which is the original defect with a fallback bolted on top of it.
     */
    expect(mediaModelDefaults('Comet')).not.toEqual(mediaModelDefaults('KIE'));
  });

  it('matches EXACTLY — a lowercased provider name is not a provider name', () => {
    /*
     * ⚠️ Documenting a real edge, not blessing one. The only production caller passes
     * `MediaProvider.name`, which is the typed `MediaProviderName` enum, so exact matching is correct
     * today. If a caller ever hands this a raw env string it must normalise first: the failure is a
     * Comet deploy silently serving KIE defaults again, which is this whole file's subject.
     */
    expect(mediaModelDefaults('comet')).toEqual(mediaModelDefaults('KIE'));
    expect(mediaModelDefaults('COMET')).toEqual(mediaModelDefaults('KIE'));
  });
});

/*
 * ================================================================================================
 * 5. NO GATEWAY MAY BE ADDED WITHOUT DEFAULTS
 * ================================================================================================
 */
describe('the table covers every media gateway', () => {
  it('CONTROL — the list every block above iterates is real', () => {
    // An assertion over an empty list is green by vacuity; every `for` in this file derives from here.
    expect(providersWithDefaults().length).toBeGreaterThanOrEqual(2);
    expect([...providersWithDefaults()].sort()).toEqual(['Comet', 'KIE']);
  });

  it('mirrors MEDIA_PROVIDERS exactly', () => {
    /*
     * A gateway in `MEDIA_PROVIDERS` with no row here silently takes the KIE fallback — i.e. the new
     * gateway ships with another gateway's model ids, which is the T9 defect arriving through the one
     * door the fix left open. The reverse (a row here for a provider that does not exist) is dead
     * weight that will be trusted by the next reader.
     *
     * The typed assignment is itself half the test: `ImageProviderName` is a hand-written mirror of
     * the server enum (the capability/defaults modules are CLIENT-SAFE and may not import `.server`),
     * so a name added to one union and not the other is a compile error right here.
     */
    const mirrored: ImageProviderName[] = [...MEDIA_PROVIDERS];

    expect([...providersWithDefaults()].sort()).toEqual([...mirrored].sort());
  });

  it('gives every gateway three non-empty ids and a well-formed alternatives clause', () => {
    for (const provider of providersWithDefaults()) {
      const defaults = mediaModelDefaults(provider);

      for (const { slot } of SLOTS) {
        const value = defaults[slot];

        // `video` may be null (no non-Google default); an EMPTY STRING is never right for any slot.
        if (slot === 'video' && value === null) {
          continue;
        }

        expect(value, `${provider}.${slot} is empty`).toBeTruthy();
        expect(value!.trim(), `${provider}.${slot} carries stray whitespace`).toBe(value);
      }

      /*
       * The clause is concatenated straight onto "Default <model>." in the tool schema, so it either
       * is empty or begins with a space. Drop the space and the cached prompt reads
       * "Default veo3-fast.Also: veo3 …" on every turn of every conversation.
       */
      expect(defaults.videoAlternatives === '' || defaults.videoAlternatives.startsWith(' ')).toBe(true);
    }
  });
});

/*
 * ================================================================================================
 * 6. THE ALTERNATIVES CLAUSE RIDES IN THE CACHED PROMPT — no foreign model ids in it
 * ================================================================================================
 */
describe('no gateway advertises another gateway’s models', () => {
  /** Model ids priced ONLY on some other gateway — the ones that are refused if the agent names them. */
  function foreignModelIds(provider: ImageProviderName): string[] {
    const own = new Set(Object.keys(BAKED_BY_PROVIDER[provider].media));

    return providersWithDefaults()
      .filter((other) => other !== provider)
      .flatMap((other) => Object.keys(BAKED_BY_PROVIDER[other].media))
      .filter((id) => !own.has(id));
  }

  function foreignIdsMentionedIn(text: string, provider: ImageProviderName): string[] {
    return foreignModelIds(provider).filter((id) => text.includes(id));
  }

  for (const provider of providersWithDefaults()) {
    it(`${provider}: the alternatives clause names nothing this gateway cannot price`, () => {
      /*
       * This string is INTERPOLATED INTO THE TOOL SCHEMA, which sits in the cached prefix — so a
       * foreign id here does not merely fail once, it teaches the agent a model that will be refused,
       * on every turn, buying back exactly the wasted round the defaults just removed.
       */
      const mentioned = foreignIdsMentionedIn(mediaModelDefaults(provider).videoAlternatives, provider);

      expect(mentioned, `${provider} advertises ${mentioned.join(', ')}`).toEqual([]);
    });
  }

  it('CONTROL — the scanner really detects a foreign id', () => {
    /*
     * 🔴 A source/text scan that silently matches nothing reports a clean bill of health forever. Plant
     * one of each gateway's exclusive ids in a fake clause and require the scanner to find it — and
     * require it NOT to fire on a clause naming a model the gateway does price.
     */
    expect(foreignIdsMentionedIn(' Also: kling-2.6 (cheaper).', 'Comet')).toContain('kling-2.6');
    expect(foreignIdsMentionedIn(' Also: gemini-3-pro-image (cheaper).', 'KIE')).toContain('gemini-3-pro-image');

    expect(foreignIdsMentionedIn(' Also: kling-2.6 (cheaper).', 'KIE')).toEqual([]);
    expect(foreignIdsMentionedIn(' Also: gemini-3-pro-image (cheaper).', 'Comet')).toEqual([]);
  });

  it('CONTROL — each gateway really has exclusive ids to be caught by', () => {
    // If the two catalogues ever became identical, every assertion in this block would pass vacuously.
    for (const provider of providersWithDefaults()) {
      expect(foreignModelIds(provider).length, `${provider} has no foreign ids to detect`).toBeGreaterThan(0);
    }
  });
});

/*
 * ================================================================================================
 * 7. THIS MODULE SHIPS IN THE CLIENT BUNDLE
 *
 * Its header claims to be client-safe so the Media panel can render the same defaults the agent gets
 * rather than holding a second opinion about them. A convenience import from `.server` added later —
 * for a price, say — would drag server-only code (and whatever secrets its transitive imports read)
 * into the browser bundle. Nothing but a source scan notices: every unit test above passes either way.
 * ================================================================================================
 */
describe('provider-defaults.ts imports nothing from ~/lib/.server', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('./provider-defaults.ts', import.meta.url)), 'utf8');

  /** Any `import`/`export … from` or dynamic `import()` whose specifier reaches into `.server`. */
  function serverImportsIn(source: string): string[] {
    const matches = source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]*\.server[^'"]*)['"]/g);

    return [...matches].map((match) => match[1]);
  }

  it('the source contains no .server import specifier', () => {
    expect(serverImportsIn(SOURCE)).toEqual([]);
  });

  it('CONTROL — the file was really read, and is the file under test', () => {
    expect(SOURCE.length).toBeGreaterThan(1_000);
    expect(SOURCE).toContain('mediaModelDefaults');
    expect(SOURCE).toContain('providersWithDefaults');
  });

  it('CONTROL — the scanner really detects a .server import when one is present', () => {
    const samples = [
      "import { BAKED_MARKET_PRICES } from '~/lib/.server/billing/baked-market-prices';",
      "export { x } from '../.server/env';",
      "const m = await import('~/lib/.server/billing/market-prices');",
    ];

    for (const sample of samples) {
      expect(serverImportsIn(sample), sample).toHaveLength(1);
    }

    expect(serverImportsIn("import type { ImageProviderName } from './image-capabilities';")).toEqual([]);
  });
});

/*
 * ================================================================================================
 * 8. THE GOOGLE VIDEO RULE — `generate_video` NEVER produces Veo, on any gateway (owner, 2026-08-11)
 * ================================================================================================
 *
 * Veo is the most expensive video on either catalogue, and `generate_google_video` exists so that it
 * is chosen deliberately. Two doors had to be shut: the DEFAULT drifting onto Veo, and a Veo id being
 * named on the general tool. This block pins both halves of the data side; `media-tools.spec.ts` pins
 * that `execute` actually refuses.
 *
 * ⚠️ The regression this replaced was WORSE than the bug it was fixing. `generate_video` used to
 * default to `kling-3.0/video`, which Comet cannot price — so an unqualified call was already refused,
 * for free. Pointing it at `veo3-fast` to save a wasted tool round turned that free refusal into an
 * automatic 128-credit Veo render. Removing a refusal is not a saving when its replacement spends.
 */
describe('generate_video never falls back to Google Veo', () => {
  it('no gateway has a Veo model as its general video default', () => {
    /*
     * 🔴 THE RULE. Mutation that kills it: `Comet.video = 'veo3-fast'` — the state this shipped in for
     * one live drive, which billed 128 credits of Veo from a tool that had asked for "a video".
     */
    for (const provider of providersWithDefaults()) {
      const { video } = mediaModelDefaults(provider);

      expect(video === null || !isGoogleVideoModel(video), `${provider}.video is the Google model "${video}"`).toBe(
        true,
      );
    }
  });

  it('CONTROL — the predicate really does recognise the Veo ids in the price lists', () => {
    /*
     * Without this, a predicate that returns `false` for everything satisfies the rule above while
     * permitting exactly what it bans. The ids are read from the REAL baked lists, both spellings.
     */
    expect(isGoogleVideoModel('veo3-fast')).toBe(true); // Comet
    expect(isGoogleVideoModel('veo3_fast')).toBe(true); // KIE — one character apart
    expect(isGoogleVideoModel('veo3')).toBe(true);
    expect(isGoogleVideoModel('veo3_lite')).toBe(true);

    // ...and every gateway's declared Google model is caught by it.
    for (const provider of providersWithDefaults()) {
      expect(isGoogleVideoModel(mediaModelDefaults(provider).googleVideo)).toBe(true);
    }
  });

  it('CONTROL — it does not swallow the non-Google video models', () => {
    /*
     * The other direction, and the one that turns a wall into a blockade: a predicate matching too
     * much would refuse Kling and Seedance on the general tool, i.e. leave KIE with no video at all.
     */
    for (const id of ['kling-3.0/video', 'kling-2.6', 'bytedance/seedance-2', 'grok-imagine-video-1-5-preview']) {
      expect(isGoogleVideoModel(id), `"${id}" is not a Google model`).toBe(false);
    }
  });

  it('is null on Comet specifically, because every video model it prices is Veo', () => {
    /*
     * Not a style choice — a fact about the catalogue. `baked-comet-prices.ts` prices `veo3-fast` and
     * `veo3` and nothing else in `kind: 'video'`, so there is nothing else this could point at. If
     * Comet ever lists a non-Google video model, THAT is what goes here.
     */
    expect(mediaModelDefaults('Comet').video).toBeNull();

    const cometVideo = Object.entries(BAKED_COMET_PRICES.media ?? {})
      .filter(([, row]) => row.kind === 'video')
      .map(([id]) => id);

    expect(cometVideo.length).toBeGreaterThan(0);
    expect(
      cometVideo.every((id) => isGoogleVideoModel(id)),
      `Comet now serves non-Google video: ${cometVideo}`,
    ).toBe(true);
  });

  it('KIE keeps a real, non-Google default — the rule is not "no video"', () => {
    /*
     * CONTROL for the whole block. Setting every `video` to null would satisfy every assertion above
     * while removing general video generation from the product.
     */
    const kie = mediaModelDefaults('KIE').video;

    expect(kie).toBe('kling-3.0/video');
    expect(isGoogleVideoModel(kie!)).toBe(false);
    expect(findMediaModel(BAKED_MARKET_PRICES, kie!)).not.toBeNull();
  });
});
