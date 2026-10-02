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
  FAL_IMAGE_MODELS,
  FAL_VIDEO_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  mediaKindsFor,
  modelsForProvider,
  withBackgroundField,
} from './MediaPanel';
import { hasCutoutPass, imageModelCapability, nativeAlphaModelFor } from '~/lib/media/image-capabilities';
import { SOUND_MODELS, soundKindForModel } from '~/lib/media/provider-defaults';
import { validatePanelSoundRequest } from '~/lib/media/sound-request';

const backgroundField = (model: Parameters<typeof withBackgroundField>[0], provider: 'KIE' | 'FAL' | null) =>
  withBackgroundField(model, provider).fields.find((f) => f.key === 'transparent');

const byId = (models: typeof IMAGE_MODELS, id: string) => models.find((m) => m.id === id)!;

describe('the Background control is DERIVED from the capability table', () => {
  /*
   * CONTROL, and the one that would have caught the verifier's mutation: at least one model on each
   * gateway must actually GET the control. Every "is absent" assertion below is satisfied by a
   * function that returns the model untouched, so without this the whole file passes for a product
   * with no transparency at all.
   */
  it('offers it on KIE and on fal — the product HAS transparency (control)', () => {
    expect(backgroundField(byId(IMAGE_MODELS, 'nano-banana-2'), 'KIE')).toBeDefined();
    expect(backgroundField(byId(FAL_IMAGE_MODELS, 'fal-ai/nano-banana-2'), 'FAL')).toBeDefined();
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

  it('has no native-alpha model on either gateway — every offer is a cut-out pass', () => {
    /*
     * Comet's `gpt-image-1.5` was the only native-alpha model, and Comet is no longer a media gateway
     * (2026-10-01). Both live gateways add alpha with a priced second stage, so the label must never
     * promise "no extra cost".
     */
    for (const provider of ['KIE', 'FAL'] as const) {
      expect(nativeAlphaModelFor(provider), `${provider} has a native-alpha model`).toBeNull();
      expect(hasCutoutPass(provider)).toBe(true);
    }

    for (const [model, provider] of [
      [byId(IMAGE_MODELS, 'nano-banana-2'), 'KIE'],
      [byId(FAL_IMAGE_MODELS, 'fal-ai/nano-banana-2'), 'FAL'],
    ] as const) {
      expect(
        backgroundField(model, provider)!
          .choices.map((c) => c.label)
          .join('|'),
      ).not.toMatch(/no extra cost/);
    }
  });

  it('offers nothing at all before the session has answered', () => {
    /*
     * `media.provider` is null until `/api/me` responds. Drawing a Background control then would offer
     * a capability whose gateway is unknown — and the default must be off, never a guess at KIE.
     */
    for (const model of [...IMAGE_MODELS, ...FAL_IMAGE_MODELS]) {
      expect(backgroundField(model, null), `${model.id} must not be offered transparency yet`).toBeUndefined();
    }
  });

  it('is idempotent, and adds nothing else', () => {
    // It runs on every render through `useMemo`; a second pass must not stack a duplicate control.
    const once = withBackgroundField(byId(FAL_IMAGE_MODELS, 'fal-ai/nano-banana-2'), 'FAL');
    const twice = withBackgroundField(once, 'FAL');

    expect(twice.fields.filter((f) => f.key === 'transparent')).toHaveLength(1);
    expect(twice.fields.map((f) => f.key)).toEqual(once.fields.map((f) => f.key));

    // ...and it never mutates the shared module-level array it was handed.
    expect(byId(FAL_IMAGE_MODELS, 'fal-ai/nano-banana-2').fields.some((f) => f.key === 'transparent')).toBe(false);
  });
});

describe('the model lists are per gateway', () => {
  it('share no ids — a fal deploy must not offer models KIE serves, or the reverse', () => {
    // A list shown on the wrong gateway is a list every quote refuses.
    const kie = new Set(IMAGE_MODELS.map((m) => m.id));

    expect(FAL_IMAGE_MODELS.length).toBeGreaterThan(0);
    expect(FAL_IMAGE_MODELS.filter((m) => kie.has(m.id))).toEqual([]);
  });
});

/**
 * 🔴 `modelsForProvider` — THREE GATEWAY STATES, NOT TWO (2026-08-11).
 *
 * The mapping was a two-branch ternary, which treated "not the other gateway" as "therefore KIE". But a deployment can serve NO media at all — `LLM_PROVIDER=Anthropic`
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
const GATEWAYS = ['KIE', 'FAL'] as const;
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
   * Mutation that kills it: swapping either branch of either ternary (the provider inverted, or
   * `kind === 'video'` inverted). Each of the four assertions names a different cell, so no single
   * branch flip leaves all four green.
   */
  it('maps each gateway onto its OWN catalogue, for each kind', () => {
    expect(ids(modelsForProvider('image', 'KIE'))).toEqual(ids(IMAGE_MODELS));
    expect(ids(modelsForProvider('video', 'KIE'))).toEqual(ids(VIDEO_MODELS));
    expect(ids(modelsForProvider('image', 'FAL'))).toEqual(ids(FAL_IMAGE_MODELS));
    expect(ids(modelsForProvider('video', 'FAL'))).toEqual(ids(FAL_VIDEO_MODELS));
  });

  /**
   * fal (media-gateways T3): its own catalogue, never KIE's — the ternaries this replaced sent any
   * gateway they had not heard of down the KIE branch, offering models every fal quote would refuse.
   * Every fal image model gets the Background control (fal transparency is the Bria cut-out pass),
   * the cut-out itself is never offered as a model. (Its Sound tab is covered below — T7.)
   */
  it('offers fal its own catalogue — Background on every image, no cut-out model', () => {
    const image = modelsForProvider('image', 'FAL');

    expect(ids(image)).toContain('fal-ai/nano-banana-2');
    expect(ids(image)).not.toContain('fal-ai/bria/background/remove');
    expect(ids(image).every((id) => id.startsWith('fal-ai/'))).toBe(true);

    for (const model of image) {
      expect(
        model.fields.some((f) => f.key === 'transparent'),
        `${model.id} has no Background control`,
      ).toBe(true);
    }

    expect(ids(modelsForProvider('video', 'FAL'))).toEqual([
      'fal-ai/kling-video/v3/standard/text-to-video',
      'fal-ai/kling-video/v3/pro/text-to-video',
      'xai/grok-imagine-video/text-to-video',
      'fal-ai/veo3/fast',
      'fal-ai/veo3',
    ]);
  });

  /**
   * The catalogues are disjoint, which is what makes the assertions above meaningful: if the two lists
   * shared their ids, "returns the fal list" and "returns the KIE list" would be the same claim and a
   * broken mapping would satisfy both. fal ids are model PATHS (`fal-ai/…`, `xai/…`), so this holds for
   * video too — `veo3` on KIE is `fal-ai/veo3` on fal.
   */
  it('offers disjoint catalogues, so "the fal list" and "the KIE list" are different claims', () => {
    for (const kind of KINDS) {
      const kie = new Set(ids(modelsForProvider(kind, 'KIE')));
      const fal = ids(modelsForProvider(kind, 'FAL'));

      expect(
        fal.filter((id) => kie.has(id)),
        kind,
      ).toEqual([]);
    }
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

    // fal: the same derivation through its own cut-out pass, and its raw constant is bare too.
    expect(hasBackground(modelsForProvider('image', 'FAL'), 'fal-ai/nano-banana-2')).toBe(true);
    expect(hasBackground(FAL_IMAGE_MODELS, 'fal-ai/nano-banana-2'), 'the raw constant must not carry the control').toBe(
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
   * would keep the control after an operator switched the deployment to fal.
   */
  it('leaves the shared catalogues unmodified across repeated calls', () => {
    const before = IMAGE_MODELS.map((m) => m.fields.length);

    modelsForProvider('image', 'KIE');
    modelsForProvider('image', 'KIE');
    modelsForProvider('image', 'FAL');

    expect(IMAGE_MODELS.map((m) => m.fields.length)).toEqual(before);
    expect(FAL_IMAGE_MODELS.some((m) => m.fields.some((f) => f.key === 'transparent'))).toBe(false);
  });
});

/**
 * Sound (§4.16, `_specs/media-gateways_plan.md` T7). The tab is built from the per-gateway sound
 * catalogue (`SOUND_MODELS`), so it is present wherever that catalogue is set and its controls come
 * from the catalogue's data — never from a gateway name.
 *
 * Note the panel's kind is `'audio'`, not `'sound'`: the task record, the wire and the price list all
 * say audio, and only the TAB LABEL says Sound. One vocabulary, one spelling.
 */
const fieldsOf = (provider: 'KIE' | 'FAL') =>
  new Map(modelsForProvider('audio', provider).map((m) => [m.id, m.fields]));

describe('the Sound tab is per gateway', () => {
  it('shows the Sound tab on FAL with ElevenLabs voices and fal image/video models', () => {
    const sound = modelsForProvider('audio', 'FAL');
    const fal = SOUND_MODELS.FAL;

    expect(mediaKindsFor(sound)).toEqual(['image', 'video', 'audio']);

    // Every fal sound id, from the catalogue — and no KIE id.
    expect(ids(sound)).toEqual([fal.effect, fal.music, ...fal.speech]);
    expect(ids(sound).every((id) => id.startsWith('fal-ai/'))).toBe(true);

    // Speech offers exactly the ElevenLabs voice names, Rachel (the default) first.
    const voice = fieldsOf('FAL')
      .get(fal.speech[0])!
      .find((f) => f.key === 'voice')!;

    expect(voice.choices.map((c) => c.value)).toEqual(fal.voices);
    expect(voice.default).toBe('Rachel');

    // Effects get a length, defaulting to the one the quote and debit resolve to (5 s), capped at 22.
    const length = fieldsOf('FAL')
      .get(fal.effect)!
      .find((f) => f.key === 'duration')!;

    expect(length.default).toBe(String(fal.effectSeconds!.default));
    expect(Math.max(...length.choices.map((c) => Number(c.value)))).toBe(22);

    // Music: instrumental, plus lyrics shown only with vocals.
    const music = fieldsOf('FAL').get(fal.music)!;

    expect(music.map((f) => f.key)).toEqual(['instrumental', 'lyrics']);
    expect(music.find((f) => f.key === 'lyrics')).toMatchObject({
      input: 'text',
      showWhen: { key: 'instrumental', value: 'false' },
    });

    // ...and the Image / Video tabs on the same gateway are fal's own.
    expect(ids(modelsForProvider('image', 'FAL')).every((id) => id.startsWith('fal-ai/'))).toBe(true);
    expect(ids(modelsForProvider('video', 'FAL'))).toEqual(ids(FAL_VIDEO_MODELS));
  });

  it("still shows KIE's sound fields on KIE", () => {
    const kie = SOUND_MODELS.KIE;
    const sound = modelsForProvider('audio', 'KIE');

    expect(mediaKindsFor(sound)).toEqual(['image', 'video', 'audio']);
    expect(ids(sound)).toEqual([
      'suno/generate-sounds',
      'suno/generate-music',
      'elevenlabs/text-to-speech-multilingual-v2',
      'elevenlabs/text-to-speech-turbo-2-5',
    ]);

    // Exactly the controls the KIE-only tab had: loop on effects, vocals on music, nothing on speech.
    const byId = new Map(sound.map((m) => [m.id, m.fields.map((f) => f.key)]));

    expect(byId.get(kie.effect)).toEqual(['loop']);
    expect(byId.get(kie.music)).toEqual(['instrumental']);
    expect(byId.get(kie.speech[0])).toEqual([]);
    expect(sound.map((m) => m.label)).toEqual([
      'Sound effect (default)',
      'Music track',
      'Speech — multilingual v2',
      'Speech — turbo 2.5 (cheaper)',
    ]);
  });

  /*
   * CONTROL, with a stub table: the tab must be able to VANISH. Both assertions above pass for a
   * panel that always draws a Sound tab, which is the bug this replaced in the other direction (a tab
   * every quote refuses).
   */
  it('hides the Sound tab when the gateway has no sound models', () => {
    const stub = { KIE: SOUND_MODELS.KIE, FAL: null };

    expect(modelsForProvider('audio', 'FAL', stub)).toEqual([]);
    expect(mediaKindsFor(modelsForProvider('audio', 'FAL', stub))).toEqual(['image', 'video']);
    expect(mediaKindsFor(modelsForProvider('audio', 'KIE', stub))).toEqual(['image', 'video', 'audio']);
    expect(modelsForProvider('audio', null)).toEqual([]);
  });

  /* Every sound model the panel offers must be one the agent tool would also accept. */
  it('offers only models the shared validator recognises, on both gateways', () => {
    for (const provider of GATEWAYS) {
      for (const spec of modelsForProvider('audio', provider)) {
        expect(soundKindForModel(spec.id), `${provider}/${spec.id} is not a sound model`).not.toBeNull();
      }
    }
  });

  /*
   * Every DEFAULT the panel would send passes the route's validator on its own gateway — a default
   * that the route refuses is a tab whose first Generate always fails.
   */
  it("the panel's default request for every sound model passes the gateway's validator", () => {
    for (const provider of GATEWAYS) {
      for (const spec of modelsForProvider('audio', provider)) {
        const options: Record<string, string | boolean> = {};
        let durationSeconds: number | undefined;

        for (const field of spec.fields) {
          if (field.input === 'text' || field.showWhen) {
            continue;
          }

          if (field.key === 'duration') {
            durationSeconds = Number(field.default);
          } else if (field.key === 'loop' || field.key === 'instrumental') {
            options[field.key] = field.default === 'true';
          } else {
            options[field.key] = field.default;
          }
        }

        const result = validatePanelSoundRequest(
          { model: spec.id, prompt: 'upbeat arcade coin pickup chime', options, durationSeconds },
          provider,
        );

        expect(result, `${provider}/${spec.id}`).toMatchObject({ ok: true });
      }
    }
  });
});
