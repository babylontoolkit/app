import { describe, expect, it } from 'vitest';
import { cutoutRenderPrompt, resolveImageDelivery, resolveImageOutputFormat } from './output-format';

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
