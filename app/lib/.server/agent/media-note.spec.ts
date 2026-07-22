/**
 * The media protocol note (§4.16).
 *
 * Each assertion here stands for a live failure: an unbatched generate round exhausting the tool loop
 * (a forced continuation the user pays twice for), and `<boltArtifact>` emitted as a tool call (the
 * "the artifact doesn't come back when we generate images from chat" report).
 */
import { describe, expect, it } from 'vitest';
import { mediaProtocolNote } from './media-note';

const base = { hasMediaTools: true, isCreationTurn: false };

describe('mediaProtocolNote', () => {
  it('is absent when the turn has no media tools — never advertise a capability that is not offered', () => {
    expect(mediaProtocolNote({ ...base, hasMediaTools: false })).toBeNull();
  });

  /* Creation carries its own richer, art-directed copy; two copies pay twice and can disagree. */
  it('is absent on a creation turn', () => {
    expect(mediaProtocolNote({ ...base, isCreationTurn: true })).toBeNull();
  });

  it('is present on an ordinary or /slash media turn — the case that had NO protocol at all', () => {
    expect(mediaProtocolNote(base)).toBeTruthy();
  });

  it('tells the model that artifacts are text, not tools', () => {
    const note = mediaProtocolNote(base) ?? '';
    expect(note).toMatch(/NEVER call them as tools/);
    expect(note).toContain('<boltArtifact>');
  });

  it('tells the model to batch every generate call into ONE round before writing files', () => {
    const note = mediaProtocolNote(base) ?? '';
    expect(note).toMatch(/ONE parallel round/);
    expect(note).toMatch(/BEFORE writing any files/);
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
