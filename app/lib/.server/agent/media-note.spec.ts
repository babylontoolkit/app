/**
 * The media protocol note (§4.16).
 *
 * Each assertion here stands for a live failure: an unbatched generate round exhausting the tool loop
 * (a forced continuation the user pays twice for), and `<boltArtifact>` emitted as a tool call (the
 * "the artifact doesn't come back when we generate images from chat" report).
 */
import { describe, expect, it } from 'vitest';
import { mediaProtocolNote } from './media-note';

const base = { hasMediaTools: true, isFirstBuildTurn: false };

describe('mediaProtocolNote', () => {
  it('is absent when the turn has no media tools — never advertise a capability that is not offered', () => {
    expect(mediaProtocolNote({ ...base, hasMediaTools: false })).toBeNull();
  });

  /* Creation carries its own richer, art-directed copy; two copies pay twice and can disagree. */
  it('is absent on a first build turn', () => {
    expect(mediaProtocolNote({ ...base, isFirstBuildTurn: true })).toBeNull();
  });

  it('is present on an ordinary or /slash media turn — the case that had NO protocol at all', () => {
    expect(mediaProtocolNote(base)).toBeTruthy();
  });

  it('tells the model that artifacts are text, not tools', () => {
    const note = mediaProtocolNote(base) ?? '';
    expect(note).toMatch(/NEVER call them as tools/);
    expect(note).toContain('<boltArtifact>');
  });

  /*
   * 🔴 REPLACED (2026-08-08). This test used to assert /ONE parallel round/ and /BEFORE writing any
   * files/. That instruction, and the `MAX_MEDIA_ROUNDS` cap enforcing it, refused three images a live
   * design had asked for. The owner asked for one at a time; the note now says so, and the ceiling
   * that bounds the turn is `MEDIA_IMAGE_ROUNDS` in tool-policy.ts — a step cap, never a refusal.
   */
  it('asks for ONE image per call and promises no round budget', () => {
    const note = mediaProtocolNote({ hasMediaTools: true, isFirstBuildTurn: false })!;

    expect(note).toMatch(/ONE image per call/);
    expect(note).toMatch(/no round budget/);
  });

  it('no longer tells the model to batch its calls into one round', () => {
    const note = mediaProtocolNote({ hasMediaTools: true, isFirstBuildTurn: false })!;

    expect(note).not.toMatch(/ONE parallel round/i);
    expect(note).not.toMatch(/BEFORE writing any files/i);
    expect(note).not.toMatch(/very few tool rounds/i);
  });

  it('carves out the generated paths from the never-invent-an-asset-path rule', () => {
    expect(mediaProtocolNote(base) ?? '').toContain('/assets/generated/');
  });

  it('requires a styled fallback, since the code ships before the bytes do', () => {
    expect(mediaProtocolNote(base) ?? '').toMatch(/never a blank box/);
  });

  /*
   * Measured on a live creation: four 2K photographic images defaulted to png and shipped ~30MB into
   * the game (10.4 / 7.9 / 6.7 / 5.5 MB). Format is NOT priced — only resolution is — so jpg is a
   * free ~10x saving, which makes this a page-weight defect with no tradeoff to argue about.
   */
  it('steers photographic art to jpg and reserves png for transparency', () => {
    const note = mediaProtocolNote(base) ?? '';
    expect(note).toMatch(/output_format/);
    expect(note).toMatch(/jpg/);
    expect(note).toMatch(/transparency/);
  });

  it('tells the model not to wait on a render — the loop must never park (§4.2.8)', () => {
    expect(mediaProtocolNote(base) ?? '').toMatch(/Do NOT wait for it, poll for it/);
  });
});
