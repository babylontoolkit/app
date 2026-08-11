/**
 * THE MEDIA PANEL'S FIELD DERIVATION (SPEC §4.16, FR7).
 *
 * ## Why this file exists
 *
 * The independent verifier's mutation was a single early `return model` from `withBackgroundField` —
 * which deletes the Background control from every model on every gateway, i.e. **removes transparency
 * from the product** — and the suite stayed green at 1113 tests. There was no `MediaPanel` spec of any
 * kind, so the provider-aware model lists, the derived field and the remount guard were all
 * unverified. That is the shape this repo keeps recording: the stores were right, the routes were
 * right, and every defect lived in the wiring nothing exercised.
 *
 * ## What is under test, and what deliberately is not
 *
 * The FIELD DERIVATION is pure and is tested directly. Rendering the panel is not: it would need the
 * session store, `trackMediaTask`, a fetch double and a DOM, to assert something the derivation
 * already decides. What matters is that the control offered is the one the capability table permits,
 * because offering one the quote refuses invites a user to pay for something that cannot happen.
 *
 * ⚠️ Every assertion here is about the OFFER. Whether a transparent request can actually be SERVED is
 * the quote's job and is covered in `media.spec.ts` — including the case these two can legitimately
 * disagree on (an operator promoting a price list with the cut-out row removed), which the panel
 * cannot see without shipping the price list to the browser.
 */
import { describe, expect, it } from 'vitest';
import {
  COMET_IMAGE_MODELS,
  COMET_VIDEO_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  modelsForProvider,
  withBackgroundField,
} from './MediaPanel';
import { hasCutoutPass, imageModelCapability, nativeAlphaModelFor } from '~/lib/media/image-capabilities';

const backgroundField = (model: Parameters<typeof withBackgroundField>[0], provider: 'KIE' | 'Comet' | null) =>
  withBackgroundField(model, provider).fields.find((f) => f.key === 'transparent');

const byId = (models: typeof IMAGE_MODELS, id: string) => models.find((m) => m.id === id)!;

describe('the Background control is DERIVED from the capability table', () => {
  /*
   * CONTROL, and the one that would have caught the verifier's mutation: at least one model on each
   * gateway must actually GET the control. Every "is absent" assertion below is satisfied by a
   * function that returns the model untouched, so without this the whole file passes for a product
   * with no transparency at all.
   */
  it('offers it on KIE and on Comet — the product HAS transparency (control)', () => {
    expect(backgroundField(byId(IMAGE_MODELS, 'nano-banana-2'), 'KIE')).toBeDefined();
    expect(backgroundField(byId(COMET_IMAGE_MODELS, 'gpt-image-1.5'), 'Comet')).toBeDefined();
  });

  it('offers it on EVERY KIE image model — there the alpha comes from the cut-out pass, not the model', () => {
    /*
     * No KIE image model emits alpha (`imageModelCapability('KIE', …)` is undefined for all of them),
     * so the control is offered because the GATEWAY can add it. Asserting the whole list rather than
     * one model is what stops the rule silently narrowing to whichever model someone tested.
     */
    for (const model of IMAGE_MODELS) {
      expect(
        imageModelCapability('KIE', model.id)?.nativeAlpha ?? false,
        `${model.id} should have no native alpha`,
      ).toBe(false);
      expect(backgroundField(model, 'KIE'), `${model.id} should still be offered transparency`).toBeDefined();
    }

    expect(hasCutoutPass('KIE')).toBe(true);
  });

  it('offers it on Comet ONLY where the table says the model has native alpha', () => {
    /*
     * 🔴 The asymmetry that makes this a table and not a flag. Comet has no cut-out pass, so a model
     * without native alpha has no route to transparency at all — and offering the control there would
     * be an invitation to a refusal.
     */
    expect(hasCutoutPass('Comet')).toBe(false);
    expect(nativeAlphaModelFor('Comet')).toBe('gpt-image-1.5');

    expect(backgroundField(byId(COMET_IMAGE_MODELS, 'gpt-image-1.5'), 'Comet')).toBeDefined();
    expect(backgroundField(byId(COMET_IMAGE_MODELS, 'gemini-3-pro-image'), 'Comet')).toBeUndefined();
  });

  it('follows the TABLE, not the model id — the two cannot desynchronise', () => {
    /*
     * The defect this replaced: the field was hand-attached to `gpt-image-1.5` in the model array and
     * merely AGREED with the table. Driving the SAME model against a gateway whose table does not mark
     * it capable is what proves the derivation actually consults the table — a test that only ever
     * asks about `gpt-image-1.5` on Comet passes for a hardcoded id check.
     */
    const gptOnComet = byId(COMET_IMAGE_MODELS, 'gpt-image-1.5');

    expect(imageModelCapability('KIE', 'gpt-image-1.5')).toBeUndefined();
    expect(backgroundField(gptOnComet, 'Comet')).toBeDefined();

    // On KIE the same model would be offered it for the OTHER reason (the cut-out), so check the label.
    expect(
      backgroundField(gptOnComet, 'Comet')!
        .choices.map((c) => c.label)
        .join('|'),
    ).toMatch(/no extra cost/);
    expect(
      backgroundField(byId(IMAGE_MODELS, 'nano-banana-2'), 'KIE')!
        .choices.map((c) => c.label)
        .join('|'),
    ).not.toMatch(/no extra cost/);
  });

  it('offers nothing at all before the session has answered', () => {
    /*
     * `media.provider` is null until `/api/me` responds. Drawing a Background control then would offer
     * a capability whose gateway is unknown — and the default must be off, never a guess at KIE.
     */
    for (const model of [...IMAGE_MODELS, ...COMET_IMAGE_MODELS]) {
      expect(backgroundField(model, null), `${model.id} must not be offered transparency yet`).toBeUndefined();
    }
  });

  it('is idempotent, and adds nothing else', () => {
    // It runs on every render through `useMemo`; a second pass must not stack a duplicate control.
    const once = withBackgroundField(byId(COMET_IMAGE_MODELS, 'gpt-image-1.5'), 'Comet');
    const twice = withBackgroundField(once, 'Comet');

    expect(twice.fields.filter((f) => f.key === 'transparent')).toHaveLength(1);
    expect(twice.fields.map((f) => f.key)).toEqual(once.fields.map((f) => f.key));

    // ...and it never mutates the shared module-level array it was handed.
    expect(byId(COMET_IMAGE_MODELS, 'gpt-image-1.5').fields.some((f) => f.key === 'transparent')).toBe(false);
  });
});

describe('the model lists are per gateway', () => {
  it('share no ids — a Comet deploy must not offer models KIE serves, or the reverse', () => {
    /*
     * Comet's flat-priced image models answer 503 and KIE's models are not on Comet at all, so a list
     * shown on the wrong gateway is six models every quote refuses. Disjointness is the cheap proxy
     * for "these are genuinely different catalogues".
     */
    const kie = new Set(IMAGE_MODELS.map((m) => m.id));

    expect(COMET_IMAGE_MODELS.length).toBeGreaterThan(0);
    expect(COMET_IMAGE_MODELS.filter((m) => kie.has(m.id))).toEqual([]);
  });

  it('offers Comet only the two PROBED aspect ratios', () => {
    /*
     * `gpt-image-1.5` is token-priced on `(size, quality)`, so an unprobed aspect has no price row and
     * would be refused after the user chose it. The panel does not offer what the list cannot price.
     */
    const aspects = byId(COMET_IMAGE_MODELS, 'gpt-image-1.5').fields.find((f) => f.key === 'aspectRatio');

    expect(new Set(aspects?.choices.map((c) => c.value))).toEqual(new Set(['1:1', '16:9']));
  });
});

/**
 * 🔴 `modelsForProvider` — THREE GATEWAY STATES, NOT TWO (2026-08-11).
 *
 * The mapping was a ternary, `provider === 'Comet' ? COMET_IMAGE_MODELS : IMAGE_MODELS`, which treats
 * "not Comet" as "therefore KIE". But a deployment can serve NO media at all — `LLM_PROVIDER=Anthropic`
 * with no `MEDIA_PROVIDER` makes `getMediaProvider` return null and `/api/me` reports `provider: null` —
 * and that third state took the `else`. A box with no gateway drew KIE's catalogue: nano-banana-2,
 * kling-3.0, six models nothing could serve, and the user found out only when the quote came back
 * refused.
 *
 * It is the same shape as the T9 tool-defaults defect one layer up, which is why it is worth a named
 * describe rather than a line in the block above: a two-branch conditional over a three-state input
 * cannot express "none", so it silently answers with whichever branch someone wrote second.
 */
const ids = (models: typeof IMAGE_MODELS) => models.map((m) => m.id);

/** The gateways that can actually serve a render — `null` is the absence of one, never a third gateway. */
const GATEWAYS = ['KIE', 'Comet'] as const;
const KINDS = ['image', 'video'] as const;

describe('modelsForProvider — the catalogue for a gateway', () => {
  /**
   * 🔴 THE REGRESSION TEST. `null` is "no media gateway on this deployment", and it must produce NOTHING
   * to choose from — the panel renders its unavailable card off exactly this emptiness.
   *
   * Mutation that kills it: restoring the ternary (dropping the `if (!provider) return []` guard), which
   * sends null down the KIE branch and hands the panel six unserveable models. Both kinds are asserted
   * because the guard is one statement covering both — a fix applied to only the image path would leave
   * the video tab offering Kling on a box with no gateway.
   */
  it('returns NOTHING when there is no gateway — the defect this replaced', () => {
    expect(modelsForProvider('image', null)).toEqual([]);
    expect(modelsForProvider('video', null)).toEqual([]);
  });

  /**
   * 🔴 THE CONTROL, and the file is worthless without it: every real gateway must return a NON-EMPTY
   * list for both kinds.
   *
   * Every "is empty" assertion above is satisfied by a function that returns `[]` for everything — i.e.
   * by a product with no media generation at all, which is the cheerful way this fix goes green while
   * breaking the feature it was protecting. Driven over the declared gateway union rather than a list
   * someone enumerated, so a third gateway is covered the day it is added.
   */
  it('CONTROL — every real gateway offers models for both kinds', () => {
    for (const provider of GATEWAYS) {
      for (const kind of KINDS) {
        expect(modelsForProvider(kind, provider).length, `${provider}/${kind} must offer something`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The mapping itself, asserted against the CONSTANTS rather than against ids typed out here — a spec
   * holding its own copy of the catalogue asserts that someone updated both lists, not that the function
   * returns this one.
   *
   * Mutation that kills it: swapping either branch of either ternary (`provider === 'Comet'` inverted,
   * or `kind === 'video'` inverted). Each of the four assertions names a different cell, so no single
   * branch flip leaves all four green.
   */
  it('maps each gateway onto its OWN catalogue, for each kind', () => {
    expect(ids(modelsForProvider('image', 'KIE'))).toEqual(ids(IMAGE_MODELS));
    expect(ids(modelsForProvider('image', 'Comet'))).toEqual(ids(COMET_IMAGE_MODELS));
    expect(ids(modelsForProvider('video', 'KIE'))).toEqual(ids(VIDEO_MODELS));
    expect(ids(modelsForProvider('video', 'Comet'))).toEqual(ids(COMET_VIDEO_MODELS));
  });

  /**
   * The IMAGE catalogues are disjoint, which is what makes the assertions above meaningful: if the two
   * lists shared their ids, "returns the Comet list" and "returns the KIE list" would be the same claim
   * and a broken mapping would satisfy both.
   *
   * ⚠️ Deliberately IMAGE only. The video catalogues are NOT disjoint — both price a model called
   * `veo3`, at different rates on different gateways — so asserting disjointness there would be a false
   * statement about the product. The overlap is pinned as a literal below instead of being papered over.
   */
  it('offers disjoint IMAGE catalogues, so "the Comet list" and "the KIE list" are different claims', () => {
    const kie = new Set(ids(modelsForProvider('image', 'KIE')));
    const comet = ids(modelsForProvider('image', 'Comet'));

    expect(comet.filter((id) => kie.has(id))).toEqual([]);
  });

  /**
   * The VIDEO catalogues overlap on exactly one id, and that is intended: `veo3` exists on both
   * gateways under the same name, priced separately in each one's rows.
   *
   * Pinned as a literal because the overlap is the reason the disjointness test above is scoped to
   * images, and a silent second collision would quietly weaken that reasoning. It also proves the two
   * video lists are genuinely different rather than one list reached by two names — the failure mode
   * the disjointness check exists to rule out for images.
   */
  it('shares exactly one video id between gateways — `veo3`, priced per gateway', () => {
    const kie = new Set(ids(modelsForProvider('video', 'KIE')));
    const shared = ids(modelsForProvider('video', 'Comet')).filter((id) => kie.has(id));

    expect(shared).toEqual(['veo3']);
    expect(ids(modelsForProvider('video', 'Comet'))).not.toEqual(ids(modelsForProvider('video', 'KIE')));
  });

  /**
   * 🔴 THE IMAGE LISTS GO THROUGH `withBackgroundField` — the derivation is not bypassed on the way out.
   *
   * Mutation that kills it: dropping the `.map((m) => withBackgroundField(m, provider))`, i.e. returning
   * the raw constant. That would delete the Background control from the panel on every gateway —
   * transparency removed from the product, exactly the mutation the top of this file records as having
   * survived a green 1113-test suite once already.
   *
   * The load-bearing half is the second assertion in each pair: the raw constants must NOT already carry
   * the field. Without that, the test passes for a function that bypasses the derivation and simply
   * returns arrays someone had hand-attached the control to — which is the defect `withBackgroundField`
   * was extracted to prevent.
   */
  it('derives the Background control onto the image lists, rather than returning the raw constants', () => {
    const hasBackground = (models: typeof IMAGE_MODELS, id: string) =>
      models.find((m) => m.id === id)!.fields.some((f) => f.key === 'transparent');

    // KIE: the cut-out pass gives EVERY image model a route to alpha.
    for (const model of modelsForProvider('image', 'KIE')) {
      expect(
        model.fields.some((f) => f.key === 'transparent'),
        `${model.id} should be offered transparency via the cut-out pass`,
      ).toBe(true);
    }

    expect(hasBackground(IMAGE_MODELS, 'nano-banana-2'), 'the raw constant must not carry the control').toBe(false);

    // Comet: per-model, so the derivation has to have consulted the table and not just appended a field.
    expect(hasBackground(modelsForProvider('image', 'Comet'), 'gpt-image-1.5')).toBe(true);
    expect(hasBackground(modelsForProvider('image', 'Comet'), 'gemini-3-pro-image')).toBe(false);
    expect(hasBackground(COMET_IMAGE_MODELS, 'gpt-image-1.5'), 'the raw constant must not carry the control').toBe(
      false,
    );
  });

  /**
   * Background is an IMAGE question, and the video lists come back untouched.
   *
   * Mutation that kills it: applying the `withBackgroundField` map to the video branch as well, which
   * would offer a transparency dropdown on a Kling clip — a control no video model on either gateway
   * can honour, and a quote refusal after the user chose it.
   */
  it('never puts a Background control on a video model', () => {
    for (const provider of GATEWAYS) {
      for (const model of modelsForProvider('video', provider)) {
        expect(
          model.fields.some((f) => f.key === 'transparent'),
          `${provider}/${model.id} must not offer transparency`,
        ).toBe(false);
      }
    }
  });

  /**
   * It must not mutate the module-level catalogues it maps over — `useMemo` re-runs it on every render
   * of a mounted panel, and `withBackgroundField` appends a field.
   *
   * Mutation that kills it: making `withBackgroundField` push onto `model.fields` in place. The field
   * would then stack once per render, and — because the arrays are module-level — the KIE catalogue
   * would keep the control after an operator switched the deployment to Comet.
   */
  it('leaves the shared catalogues unmodified across repeated calls', () => {
    const before = IMAGE_MODELS.map((m) => m.fields.length);

    modelsForProvider('image', 'KIE');
    modelsForProvider('image', 'KIE');
    modelsForProvider('image', 'Comet');

    expect(IMAGE_MODELS.map((m) => m.fields.length)).toEqual(before);
    expect(COMET_IMAGE_MODELS.some((m) => m.fields.some((f) => f.key === 'transparent'))).toBe(false);
  });
});
