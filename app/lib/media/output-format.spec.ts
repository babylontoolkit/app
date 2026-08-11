import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cutoutRenderPrompt,
  resolveImageDelivery,
  resolveImageIntent,
  resolveImageOutputFormat,
  type ImageDeliveryHints,
} from './output-format';

describe('resolveImageOutputFormat', () => {
  it('honours an explicit format', () => {
    expect(resolveImageOutputFormat('png')).toBe('png');
    expect(resolveImageOutputFormat('jpg')).toBe('jpg');
  });

  it('normalises case and whitespace', () => {
    expect(resolveImageOutputFormat('  PNG ')).toBe('png');
    expect(resolveImageOutputFormat('JPG')).toBe('jpg');
  });

  it('defaults to jpg, and treats an unsupported format as unspecified', () => {
    expect(resolveImageOutputFormat(undefined)).toBe('jpg');
    expect(resolveImageOutputFormat('')).toBe('jpg');
    expect(resolveImageOutputFormat('webp')).toBe('jpg');
  });
});

describe('resolveImageDelivery', () => {
  it('defaults to an opaque jpg', () => {
    expect(resolveImageDelivery({ prompt: 'a race car on an asphalt track' })).toEqual({
      cutout: false,
      renderFormat: 'jpg',
      finalFormat: 'jpg',
    });
  });

  it('renders a cut-out as jpg and delivers it as png', () => {
    /*
     * The render is jpg on purpose: the cut-out provider caps its INPUT at 5MB and a 2K PNG measured
     * 4-6MB. The alpha comes from stage 2 either way, so a PNG stage-1 buys nothing but a failure.
     */
    expect(resolveImageDelivery({ transparent: true, prompt: 'a wordmark' })).toEqual({
      cutout: true,
      renderFormat: 'jpg',
      finalFormat: 'png',
    });
  });

  it('accepts the string form a <select> produces', () => {
    expect(resolveImageDelivery({ transparent: 'true' }).cutout).toBe(true);
    expect(resolveImageDelivery({ transparent: 'false' }).cutout).toBe(false);
  });

  it('lets a stated transparent:false beat every hint — a stated no is not a maybe', () => {
    // Otherwise a photographic hero whose brief mentions the logo would be charged for a cut-out.
    expect(resolveImageDelivery({ transparent: false, fileName: 'team-logo', prompt: 'a logo' }).cutout).toBe(false);
  });

  it('reads an explicit png as a request for transparency', () => {
    /*
     * The tools and the creation brief have told the model for months that png means transparency.
     * Honouring it as INTENT is what makes that instruction true — before the cut-out pass it bought
     * a bigger file containing the same opaque picture.
     */
    expect(resolveImageDelivery({ explicitFormat: 'png' })).toEqual({
      cutout: true,
      renderFormat: 'jpg',
      finalFormat: 'png',
    });
  });

  it('never reads an explicit jpg as transparency, whatever the prompt says', () => {
    // jpg is the format that cannot carry alpha; treating it as a transparency request reads it backwards.
    expect(resolveImageDelivery({ explicitFormat: 'jpg', fileName: 'hero-logo' }).cutout).toBe(false);
  });

  it('falls back to name/prompt hints when nothing is stated', () => {
    expect(resolveImageDelivery({ fileName: 'street-logo-wordmark' }).cutout).toBe(true);
    expect(resolveImageDelivery({ fileName: 'team-emblem' }).cutout).toBe(true);
    expect(resolveImageDelivery({ prompt: 'a cut-out character sprite' }).cutout).toBe(true);
    expect(resolveImageDelivery({ prompt: 'a game icon' }).cutout).toBe(true);
    expect(resolveImageDelivery({ prompt: 'a crest on a transparent background' }).cutout).toBe(true);
  });

  it('does NOT treat "silhouette" as a transparency hint', () => {
    /*
     * Regression: a live 2K photographic hero read "distant mesa silhouettes" and matched the old
     * hint list. Under the old rule that cost ~10MB of PNG; under this one it would spend credits on
     * a cut-out nobody asked for. Style words are not transparency words.
     */
    const hero = 'a muscle car at sunset, distant mesa silhouettes on the horizon';
    expect(resolveImageDelivery({ prompt: hero }).cutout).toBe(false);
  });

  it('does not fire on an incidental mention of a background', () => {
    expect(resolveImageDelivery({ prompt: 'a garage interior with tools in the background' }).cutout).toBe(false);
  });
});

/**
 * The INTENT half, extracted in T8 (SPEC §4.16).
 *
 * `ImageDelivery.cutout` used to mean two things at once — *the user wants alpha* and *run a second
 * priced stage* — which was correct only while KIE was the only gateway, because there those ARE the
 * same fact. On Comet `gpt-image-1.5` produces real alpha in one call, so they come apart.
 *
 * 🔴 **This block is the AC7 control.** The precedence rules below are what the tools, the creation
 * brief and months of user habit have been trained against; the extraction was allowed to move where
 * the decision is REALIZED, and forbidden from moving what the caller ASKED FOR. So every case is
 * asserted against `resolveImageDelivery`'s own answer rather than against a fresh literal — a
 * hand-copied expectation can drift with the code it is supposed to pin.
 */
describe('resolveImageIntent — the provider-independent half (AC7)', () => {
  /* Every hint shape the delivery tests above cover, plus the empty case. */
  const CASES: Array<[string, ImageDeliveryHints]> = [
    ['nothing at all', {}],
    ['a photographic prompt', { prompt: 'a race car on an asphalt track' }],
    ['a stated transparent', { transparent: true, prompt: 'a wordmark' }],
    ['the string form a <select> produces', { transparent: 'true' }],
    ['the string form of false', { transparent: 'false' }],
    ['a stated false against a logo prompt', { transparent: false, fileName: 'team-logo', prompt: 'a logo' }],
    ['an explicit png', { explicitFormat: 'png' }],
    ['an explicit jpg against a logo name', { explicitFormat: 'jpg', fileName: 'hero-logo' }],
    ['a wordmark file name', { fileName: 'street-logo-wordmark' }],
    ['an emblem file name', { fileName: 'team-emblem' }],
    ['a sprite prompt', { prompt: 'a cut-out character sprite' }],
    ['an icon prompt', { prompt: 'a game icon' }],
    ['a transparent-background prompt', { prompt: 'a crest on a transparent background' }],
    ['the silhouette regression', { prompt: 'a muscle car at sunset, distant mesa silhouettes on the horizon' }],
    ['an incidental background mention', { prompt: 'a garage interior with tools in the background' }],
    ['an unsupported format', { explicitFormat: 'webp', prompt: 'a hero' }],
  ];

  it.each(CASES)('decides %s exactly as the shipped delivery decision does', (_label, hints) => {
    /*
     * On KIE — the gateway these rules were written against — "wants alpha" and "runs a cut-out" are
     * the same fact, so this equality IS the no-behaviour-change proof. If the extraction changed any
     * answer, one of these sixteen rows fails and names which input moved.
     */
    expect(resolveImageIntent(hints).wantsAlpha).toBe(resolveImageDelivery(hints).cutout);
  });

  it('is not vacuous — the table contains both answers (control)', () => {
    /*
     * ⚠️ Without this, the block above passes for a `resolveImageIntent` that always returns false and
     * a `resolveImageDelivery` that always returns `cutout: false` — two broken functions agreeing.
     */
    const answers = CASES.map(([, hints]) => resolveImageIntent(hints).wantsAlpha);

    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  it('states the precedence: an explicit false beats every hint', () => {
    expect(resolveImageIntent({ transparent: false, fileName: 'team-logo', prompt: 'a logo' }).wantsAlpha).toBe(false);
  });

  it('reads an explicit png as intent, and an explicit jpg as its opposite', () => {
    expect(resolveImageIntent({ explicitFormat: 'png' }).wantsAlpha).toBe(true);
    expect(resolveImageIntent({ explicitFormat: 'jpg', prompt: 'a logo' }).wantsAlpha).toBe(false);
  });

  it('falls back to hints only when nothing is stated', () => {
    expect(resolveImageIntent({ prompt: 'a team emblem' }).wantsAlpha).toBe(true);
    expect(resolveImageIntent({ prompt: 'a garage interior' }).wantsAlpha).toBe(false);
  });

  it('carries the caller format UNCHANGED by the alpha answer', () => {
    /*
     * The intent does not get to pick png for a transparent request — that is a REALIZATION decision
     * and it differs per gateway (KIE renders jpg and cuts out; Comet renders png with real alpha).
     * Folding it in here is how the two halves would silently re-fuse.
     */
    expect(resolveImageIntent({ transparent: true })).toEqual({ wantsAlpha: true, format: 'jpg' });
    expect(resolveImageIntent({ transparent: true, explicitFormat: 'png' })).toEqual({
      wantsAlpha: true,
      format: 'png',
    });
    expect(resolveImageIntent({ explicitFormat: 'webp' }).format).toBe('jpg');
  });

  it('is a pure function of its hints — same input, same answer, no hidden state', () => {
    const hints: ImageDeliveryHints = { prompt: 'a team badge' };
    const first = resolveImageIntent(hints);

    resolveImageIntent({ transparent: false });
    resolveImageIntent({ explicitFormat: 'png' });

    expect(resolveImageIntent(hints)).toEqual(first);
  });

  /**
   * 🔴 Provider-independence, asserted structurally rather than by hoping.
   *
   * The intent module answers "must this art sit over other content?" — a question about the REQUEST.
   * The moment a gateway name appears in it, the same user request starts meaning different things on
   * different providers and the split that T8 exists to make has been quietly undone. A behavioural
   * test cannot see that (the function takes no provider to vary), so this reads the source.
   */
  describe('names no gateway (the split is structural)', () => {
    const SOURCE = readFileSync(join(process.cwd(), 'app/lib/media/output-format.ts'), 'utf-8');
    const GATEWAY_WORDS = /\b(comet|kie|gpt-image|nativeAlpha\w*|imageModelCapability|realizeImageDelivery)\b/i;

    it('the scanner read a real, non-empty file (control)', () => {
      /*
       * ⚠️ A scan that silently matches nothing reports a clean bill of health forever — this repo has
       * hit that trap twice. Prove the file was read AND that the needle can fire.
       */
      expect(SOURCE.length).toBeGreaterThan(2000);
      expect(GATEWAY_WORDS.test('const m = nativeAlphaModelFor(provider)')).toBe(true);
      expect(GATEWAY_WORDS.test('resolveImageIntent(hints)')).toBe(false);
    });

    it('contains no gateway-specific machinery', () => {
      const offending = SOURCE.split('\n')
        .map((line, index) => [index + 1, line] as const)

        // Prose is allowed to explain the other half; only CODE may not reach for it.
        .filter(([, line]) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .filter(([, line]) => GATEWAY_WORDS.test(line));

      expect(offending.map(([n, line]) => `${n}: ${line.trim()}`)).toEqual([]);
    });

    it('and the realization module IS where those live (control)', () => {
      // Proves the needle matches the real shipped code one file over, so the rule above is meaningful.
      const realization = readFileSync(join(process.cwd(), 'app/lib/media/image-capabilities.ts'), 'utf-8');

      expect(GATEWAY_WORDS.test(realization)).toBe(true);
    });
  });
});

describe('cutoutRenderPrompt', () => {
  it('keeps the caller art direction and appends the backdrop directive', () => {
    const out = cutoutRenderPrompt('A chunky racing wordmark in coral and teal');

    expect(out).toContain('A chunky racing wordmark in coral and teal');
    expect(out.toLowerCase()).toContain('flat, solid, uniform');
  });

  it('forbids the painted checkerboard by name', () => {
    /*
     * This is the whole reason the directive exists: asked for "transparent background" the model
     * paints the editor checkerboard into the artwork, and a background remover then has to guess
     * which checks are art (the logo that triggered this genuinely contains a checkered flag).
     */
    const out = cutoutRenderPrompt('a logo').toLowerCase();

    expect(out).toContain('checkerboard');
    expect(out).toMatch(/never draw/);
  });
});
