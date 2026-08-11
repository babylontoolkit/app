/**
 * HOW A TRANSPARENCY REQUEST IS REALIZED PER GATEWAY (SPEC §4.16, T8).
 *
 * Every assertion here stands in front of a failure that costs money or ships the wrong pixels while
 * reporting success — the §4.16 failure that already shipped once (a logo with a grey box baked in,
 * over a navy hero, where a dark box does not announce itself).
 *
 * Three properties, and each one fails silently in a different direction:
 *
 *  1. **KIE is byte-identical to the pre-T8 behaviour** (render jpg, deliver png, second priced stage,
 *     flat-backdrop directive). This is the AC7 control: the whole point of extracting the intent half
 *     was that the incumbent gateway must not move.
 *  2. **Comet SUBSTITUTES the capable model.** `gpt-image-1.5` is the only thing on that gateway that
 *     emits alpha; a transparent request for `gemini-3-pro-image` that runs on `gemini-3-pro-image`
 *     produces a flat opaque image and bills for it. The substitution must be visible (it is the quote's
 *     `model`, so the ledger names what ran) and it must be REAL — an assertion that only checks the
 *     returned model when the requested one was already capable passes for `() => input.model`.
 *  3. **An unservable transparency is REFUSED, never downgraded.** Downgrading delivers exactly the
 *     thing the user paid extra not to get, and says "done" while doing it.
 *
 * ⚠️ Pure module, no env, no network — deliberately. The realization decision is the one thing that
 * must be identical in a unit test and in production, so nothing in it may depend on configuration.
 */
import { describe, expect, it } from 'vitest';
import {
  imageModelCapability,
  isRefusal,
  nativeAlphaModelFor,
  realizeImageDelivery,
  supportsTransparency,
  type ImageDelivery,
  type ImageDeliveryRefusal,
  type RealizeInput,
} from './image-capabilities';

/** A realization request with the two gateway facts spelled out at every call site. */
function realize(overrides: Partial<RealizeInput> = {}): ImageDelivery | ImageDeliveryRefusal {
  return realizeImageDelivery({
    provider: 'KIE',
    model: 'nano-banana-2',
    wantsAlpha: false,
    explicitFormat: 'jpg',
    cutoutAvailable: true,
    ...overrides,
  });
}

/** Narrowing helper — a refusal reaching an assertion about a delivery must say so, not read `undefined`. */
function delivery(result: ImageDelivery | ImageDeliveryRefusal): ImageDelivery {
  if (isRefusal(result)) {
    throw new Error(`expected a delivery, got a refusal: ${result.refused}`);
  }

  return result;
}

describe('nativeAlphaModelFor — which model on this gateway can actually do alpha', () => {
  it('has NOTHING on KIE — that empty table is a measurement, not a stub', () => {
    /*
     * Nano Banana (the whole line), Flux and Seedream are all flat RGB and KIE exposes no transparency
     * parameter. Answering with a model here would send `background: "transparent"` to a gateway that
     * ignores it and call the opaque result a success.
     */
    expect(nativeAlphaModelFor('KIE')).toBeNull();
    expect(nativeAlphaModelFor('KIE', 'nano-banana-2')).toBeNull();
  });

  it('answers gpt-image-1.5 on Comet, whatever was preferred', () => {
    expect(nativeAlphaModelFor('Comet')).toBe('gpt-image-1.5');
    expect(nativeAlphaModelFor('Comet', 'gemini-3-pro-image')).toBe('gpt-image-1.5');
  });

  it('keeps a preferred model that is ITSELF capable — no pointless substitution', () => {
    expect(nativeAlphaModelFor('Comet', 'gpt-image-1.5')).toBe('gpt-image-1.5');
  });

  it('treats an UNKNOWN model as incapable — the safe direction', () => {
    /*
     * Absent from the table means "we have never measured this", and the two ways of being wrong are
     * not symmetrical: optimistically assuming alpha ships an opaque image against a paid-for
     * transparent request (silent), while pessimistically assuming none costs a substitution or a
     * second stage (visible on the quote).
     */
    expect(nativeAlphaModelFor('Comet', 'gpt-image-9')).toBe('gpt-image-1.5');
    expect(imageModelCapability('Comet', 'gpt-image-9')).toBeUndefined();
  });

  it('records the two models that were PROBED and refused, rather than omitting them', () => {
    // "We know this one cannot" and "we have never heard of this one" are different facts.
    expect(imageModelCapability('Comet', 'gpt-image-1')).toEqual({ nativeAlpha: false });
    expect(imageModelCapability('Comet', 'gpt-image-2')).toEqual({ nativeAlpha: false });
    expect(imageModelCapability('Comet', 'gpt-image-1.5')).toEqual({ nativeAlpha: true });
  });
});

describe('supportsTransparency — whether the panel may offer the control at all', () => {
  it('is true on KIE via the cut-out pass, and true on Comet via a native model', () => {
    /*
     * Two different mechanisms, one answer — which is exactly why the panel asks this question rather
     * than asking "does the model have alpha". Offering a control the gateway will refuse invites a
     * user to pay for something that cannot happen.
     */
    expect(supportsTransparency('KIE')).toBe(true);
    expect(supportsTransparency('Comet')).toBe(true);
  });

  it('answers Comet from the TABLE, not from a constant (control)', () => {
    /*
     * ⚠️ The assertion above is `true` for both gateways, so it passes for `() => true` — vacuous on
     * its own, and now load-bearing, since the Media panel uses it to decide whether the Background
     * control renders at all. This pins the MECHANISM: Comet's answer is true because a capable model
     * is in the table, and it is that model. Flip `gpt-image-1.5`'s `nativeAlpha` and this fails while
     * KIE's (cut-out-based) answer stays true.
     */
    expect(nativeAlphaModelFor('Comet')).toBe('gpt-image-1.5');
    expect(supportsTransparency('Comet')).toBe(nativeAlphaModelFor('Comet') !== null);

    // ...and KIE's true comes from somewhere else entirely — it has no native-alpha model at all.
    expect(nativeAlphaModelFor('KIE')).toBeNull();
    expect(supportsTransparency('KIE')).toBe(true);
  });
});

describe('realizeImageDelivery — opaque requests', () => {
  it('passes an explicit jpg straight through, on both gateways', () => {
    for (const provider of ['KIE', 'Comet'] as const) {
      expect(realize({ provider, model: 'm', explicitFormat: 'jpg' })).toEqual({
        model: 'm',
        cutout: false,
        renderFormat: 'jpg',
        finalFormat: 'jpg',
        cutoutPrompt: false,
      });
    }
  });

  it('passes an explicit png straight through — an opaque png is a legitimate ask', () => {
    /*
     * `toEqual`, not `toMatchObject`: `background` must be ABSENT. A stray `background: 'transparent'`
     * on an opaque request would ask a native-alpha model to cut its own backdrop out.
     */
    expect(realize({ provider: 'Comet', model: 'gpt-image-1.5', explicitFormat: 'png' })).toEqual({
      model: 'gpt-image-1.5',
      cutout: false,
      renderFormat: 'png',
      finalFormat: 'png',
      cutoutPrompt: false,
    });
  });

  it('never substitutes a model for an OPAQUE request, even on a gateway that has a capable one', () => {
    // The substitution exists to buy alpha. Applying it to an opaque render would silently re-price it.
    expect(delivery(realize({ provider: 'Comet', model: 'gemini-3-pro-image' })).model).toBe('gemini-3-pro-image');
  });
});

describe('realizeImageDelivery — KIE, the AC7 control', () => {
  it('is byte-identical to the pre-T8 cut-out behaviour', () => {
    /*
     * jpg IN, png OUT, a second priced stage, and the flat-backdrop directive. The render is jpg on
     * purpose — the alpha comes from stage 2 regardless, and Recraft caps its INPUT at 5MB, which a 2K
     * PNG (measured 4-6MB) blows.
     */
    expect(realize({ provider: 'KIE', model: 'nano-banana-2', wantsAlpha: true })).toEqual({
      model: 'nano-banana-2',
      cutout: true,
      renderFormat: 'jpg',
      finalFormat: 'png',
      cutoutPrompt: true,
    });
  });

  it('never sets `background` on KIE — no model there reads it', () => {
    expect(delivery(realize({ provider: 'KIE', wantsAlpha: true })).background).toBeUndefined();
  });

  it('keeps the REQUESTED model — KIE has nothing to substitute to', () => {
    expect(delivery(realize({ provider: 'KIE', model: 'flux-2-pro', wantsAlpha: true })).model).toBe('flux-2-pro');
  });
});

describe('realizeImageDelivery — Comet, one call and real alpha', () => {
  it('resolves ANY requested model to the capable one, and bills no second stage', () => {
    /*
     * 🔴 The requested model is deliberately NOT `gpt-image-1.5`. An assertion that only ever asks
     * about a model which was already capable passes for `model: input.model` — i.e. for the exact
     * defect where a transparent request runs on a flat-RGB model and reports success.
     */
    expect(realize({ provider: 'Comet', model: 'gemini-3-pro-image', wantsAlpha: true })).toEqual({
      model: 'gpt-image-1.5',
      cutout: false,
      background: 'transparent',
      renderFormat: 'png',
      finalFormat: 'png',
      cutoutPrompt: false,
    });
  });

  it.each(['gpt-image-1', 'gpt-image-2', 'gemini-3-pro-image', 'gpt-image-9'])(
    'substitutes for %s — every model without measured alpha resolves to the one with it',
    (model) => {
      expect(delivery(realize({ provider: 'Comet', model, wantsAlpha: true })).model).toBe('gpt-image-1.5');
    },
  );

  it('leaves an already-capable model alone (the substitution CONTROL)', () => {
    // Pairs with the case above: together they prove the resolution is a lookup, not a constant.
    expect(delivery(realize({ provider: 'Comet', model: 'gpt-image-1.5', wantsAlpha: true })).model).toBe(
      'gpt-image-1.5',
    );
  });

  it('does NOT append the flat-backdrop directive to a native-alpha render', () => {
    /*
     * 🔴 The single most destructive thing this table prevents. That directive commands a flat OPAQUE
     * backdrop for a background remover's benefit; sent to a model that was about to produce a
     * genuinely empty one it destroys exactly what was paid for — and the result looks like a
     * perfectly good render.
     */
    expect(delivery(realize({ provider: 'Comet', model: 'gpt-image-1.5', wantsAlpha: true })).cutoutPrompt).toBe(false);
  });

  it('ignores an explicit jpg when alpha is owed — a container cannot carry it', () => {
    const result = delivery(realize({ provider: 'Comet', wantsAlpha: true, explicitFormat: 'jpg' }));

    expect(result.renderFormat).toBe('png');
    expect(result.finalFormat).toBe('png');
  });

  it('prefers the native model even when a cut-out pass is also available', () => {
    /*
     * The cheaper answer AND the better one: one call, no second debit, and no remover guessing at
     * edges. A realization that reached for the cut-out first would bill two stages for alpha the
     * gateway hands over for free.
     */
    const result = delivery(
      realize({ provider: 'Comet', model: 'gpt-image-1', wantsAlpha: true, cutoutAvailable: true }),
    );

    expect(result.cutout).toBe(false);
    expect(result.background).toBe('transparent');
  });
});

describe('realizeImageDelivery — a transparency that cannot be served is REFUSED', () => {
  it('refuses when the gateway has neither native alpha nor a priced cut-out', () => {
    /*
     * 🔴 THE MUTATION TARGET. Falling through to an opaque render here delivers precisely the thing
     * the user paid extra not to get and calls it a success — the failure this whole module exists to
     * make impossible.
     */
    const result = realize({ provider: 'KIE', wantsAlpha: true, cutoutAvailable: false });

    expect(isRefusal(result)).toBe(true);
    expect((result as ImageDeliveryRefusal).refused).toMatch(/KIE/);
  });

  it('says what to do instead, naming the opt-out the caller can actually type', () => {
    const result = realize({ provider: 'KIE', wantsAlpha: true, cutoutAvailable: false }) as ImageDeliveryRefusal;

    // A refusal that names no remedy gets read as the feature being broken (`build-failure.ts`).
    expect(result.refused).toMatch(/transparent: false/);
  });

  it('does NOT refuse the same request when the cut-out IS available (the control)', () => {
    // Without this, the refusal test passes for a function that refuses every transparent request.
    expect(isRefusal(realize({ provider: 'KIE', wantsAlpha: true, cutoutAvailable: true }))).toBe(false);
  });

  it('never refuses an OPAQUE request, cut-out available or not', () => {
    expect(isRefusal(realize({ provider: 'KIE', wantsAlpha: false, cutoutAvailable: false }))).toBe(false);
  });
});

describe('isRefusal', () => {
  it('discriminates the two shapes', () => {
    expect(isRefusal({ refused: 'no' })).toBe(true);
    expect(isRefusal({ model: 'm', cutout: false, renderFormat: 'jpg', finalFormat: 'jpg', cutoutPrompt: false })).toBe(
      false,
    );
  });
});
