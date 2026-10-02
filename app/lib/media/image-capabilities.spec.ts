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
 *  2. **No live gateway has a native-alpha model** (Comet's `gpt-image-1.5` was the only one, and Comet
 *     stopped being a media gateway on 2026-10-01). KIE and fal both reach alpha through a priced
 *     cut-out pass on the REQUESTED model.
 *  3. **An unservable transparency is REFUSED, never downgraded.** Downgrading delivers exactly the
 *     thing the user paid extra not to get, and says "done" while doing it.
 *
 * ⚠️ Pure module, no env, no network — deliberately. The realization decision is the one thing that
 * must be identical in a unit test and in production, so nothing in it may depend on configuration.
 */
import { describe, expect, it } from 'vitest';
import {
  CUTOUT_MODEL_BY_PROVIDER,
  cutoutModelFor,
  hasCutoutPass,
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

  it('has NOTHING on fal either — its native-alpha model is deliberately unused', () => {
    expect(nativeAlphaModelFor('FAL')).toBeNull();
    expect(nativeAlphaModelFor('FAL', 'fal-ai/nano-banana-2')).toBeNull();
  });

  it('treats an UNKNOWN model as incapable — the safe direction', () => {
    /*
     * Absent from the table means "we have never measured this", and the two ways of being wrong are
     * not symmetrical: optimistically assuming alpha ships an opaque image against a paid-for
     * transparent request (silent), while pessimistically assuming none costs a second stage (visible
     * on the quote).
     */
    expect(imageModelCapability('KIE', 'gpt-image-1.5')).toBeUndefined();
    expect(imageModelCapability('FAL', 'gpt-image-9')).toBeUndefined();
  });
});

describe('supportsTransparency — whether the panel may offer the control at all', () => {
  it('is true on KIE and on fal, both via the cut-out pass (the mechanism, not just the answer)', () => {
    /*
     * ⚠️ `true` for both passes for `() => true`, so the mechanism is pinned too: neither gateway has a
     * native-alpha model, so each `true` must come from its cut-out.
     */
    for (const provider of ['KIE', 'FAL'] as const) {
      expect(supportsTransparency(provider)).toBe(true);
      expect(nativeAlphaModelFor(provider)).toBeNull();
      expect(hasCutoutPass(provider)).toBe(true);
    }
  });
});

describe('the cut-out pass is per gateway (media-gateways T4)', () => {
  it('FAL supports transparency through a cut-out pass', () => {
    /*
     * fal has a native-alpha model in its catalogue and it is deliberately NOT used — so fal's `true`
     * must come from the cut-out, never from the capability table. Asserting the mechanism, not just
     * the answer: `() => true` passes the first line and fails the next two.
     */
    expect(supportsTransparency('FAL')).toBe(true);
    expect(nativeAlphaModelFor('FAL')).toBeNull();
    expect(hasCutoutPass('FAL')).toBe(true);
    expect(cutoutModelFor('FAL')).toBe('fal-ai/bria/background/remove');

    // Realized exactly like KIE: same requested model, a second stage, jpg render → png file.
    expect(realize({ provider: 'FAL', model: 'fal-ai/nano-banana-2', wantsAlpha: true })).toEqual({
      model: 'fal-ai/nano-banana-2',
      cutout: true,
      renderFormat: 'jpg',
      finalFormat: 'png',
      cutoutPrompt: true,
    });
  });

  it('keeps KIE on Recraft — byte-identical to before T4', () => {
    expect(cutoutModelFor('KIE')).toBe('recraft/remove-background');
    expect(hasCutoutPass('KIE')).toBe(true);
  });

  it('every gateway answers — a missing row is a compile error, and no two share a cut-out id', () => {
    expect(Object.keys(CUTOUT_MODEL_BY_PROVIDER).sort()).toEqual(['FAL', 'KIE']);

    const ids = Object.values(CUTOUT_MODEL_BY_PROVIDER).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('realizeImageDelivery — opaque requests', () => {
  it('passes an explicit jpg straight through, on both gateways', () => {
    for (const provider of ['KIE', 'FAL'] as const) {
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
    // `toEqual`, not `toMatchObject`: `background` must be ABSENT on an opaque request.
    expect(realize({ provider: 'FAL', model: 'fal-ai/nano-banana-2', explicitFormat: 'png' })).toEqual({
      model: 'fal-ai/nano-banana-2',
      cutout: false,
      renderFormat: 'png',
      finalFormat: 'png',
      cutoutPrompt: false,
    });
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
