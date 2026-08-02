/**
 * The URL a generated asset is referenced by, and why it must not be root-absolute.
 *
 * FOUND LIVE 2026-08-01 on a real published game: the CSS hero image loaded 200 while all four `<img>`
 * tiles written from `Home.tsx` 404'd — in the SAME build. Generated media lands in `public/`, Vite
 * copies it to the build ROOT, and a share is served under `/play/<id>/`, so `/assets/generated/x.png`
 * points at the app origin's root and misses.
 *
 * It survived because it is correct everywhere anyone looks: in dev the app IS at the origin root, and
 * in CSS the bundler rewrites `url()` for you. Only a JS/JSX string literal — which no bundler can
 * rewrite, because it cannot know a string is a URL — carries the broken path into the shipped bundle.
 */
import { describe, expect, it } from 'vitest';
import { mediaReferenceUrl } from './media-tools';
import { mediaProtocolNote } from './media-note';

describe('mediaReferenceUrl — what the model is told to write into project code', () => {
  it('strips the public/ prefix and returns a document-relative URL', () => {
    expect(mediaReferenceUrl('public/assets/generated/hero-car-abc123.png')).toBe(
      './assets/generated/hero-car-abc123.png',
    );
  });

  it.each([
    ['public/assets/generated/track-neon-downtown.jpg'],
    ['public/assets/generated/clip-xyz.mp4'],
    ['public/assets/generated/logo-cutout.png'],
  ])('never returns a root-absolute URL for %s', (destPath) => {
    const url = mediaReferenceUrl(destPath);

    /*
     * The whole defect in one assertion. A root-absolute URL resolves against the ORIGIN, so it can
     * only ever be right for a game served at the root — which a published share never is.
     */
    expect(url.startsWith('/'), `root-absolute URL 404s under /play/<id>/: ${url}`).toBe(false);
    expect(url.startsWith('./')).toBe(true);
  });

  it('leaves a path that is already public-relative alone rather than doubling the prefix', () => {
    expect(mediaReferenceUrl('assets/generated/x.png')).toBe('./assets/generated/x.png');
  });
});

describe('the media note teaches the same URL shape the tool returns', () => {
  const note = mediaProtocolNote({ hasMediaTools: true, isFirstBuildTurn: false })!;

  it('is present when media tools are offered', () => {
    expect(note).toBeTruthy();
  });

  /*
   * 🔴 The tool's return value and the prose that explains it are two writers of ONE rule. When they
   * disagree the model follows whichever it read last, and the failure is a 404 on somebody's public
   * game — so the note must never advertise the root-absolute form the fix removed.
   */
  it('shows the relative form and never the root-absolute one', () => {
    expect(note).toContain('./assets/generated/');
    expect(note).not.toMatch(/[^.]\/assets\/generated\/…/);
  });

  it('says WHY, so the model does not "tidy" the ./ away', () => {
    expect(note).toMatch(/prefix|\/play\//);
  });
});
