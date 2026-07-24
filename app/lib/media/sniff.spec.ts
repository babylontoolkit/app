import { describe, expect, it } from 'vitest';
import { contentTypeForBytes, extensionMismatch, sniffImageType } from './sniff';

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const gif = () => new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)));
const webp = () => new Uint8Array([...'RIFF____WEBPVP8 '].map((c) => c.charCodeAt(0)));
const mp4 = () => new Uint8Array([0, 0, 0, 0x20, ...[...'ftypisom'].map((c) => c.charCodeAt(0))]);

describe('sniffImageType', () => {
  it('identifies the formats the media pipeline can deliver', () => {
    expect(sniffImageType(png())).toBe('png');
    expect(sniffImageType(jpg())).toBe('jpg');
    expect(sniffImageType(gif())).toBe('gif');
    expect(sniffImageType(webp())).toBe('webp');
    expect(sniffImageType(mp4())).toBe('mp4');
  });

  it('reads too-short and unrecognised input as unknown rather than guessing', () => {
    expect(sniffImageType(new Uint8Array())).toBe('unknown');
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBe('unknown');
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe('unknown');
  });
});

describe('contentTypeForBytes', () => {
  it('types the response from the bytes', () => {
    expect(contentTypeForBytes(png())).toBe('image/png');
    expect(contentTypeForBytes(jpg())).toBe('image/jpeg');
  });

  it('has no opinion on unrecognised bytes, so the caller keeps its own default', () => {
    expect(contentTypeForBytes(new Uint8Array([9, 9, 9, 9]))).toBeNull();
  });
});

describe('extensionMismatch', () => {
  it('catches the measured failure: JPEG bytes written under a .png path', () => {
    /*
     * Every nano-banana-2 result from KIE's /ggc/ backend is JPEG behind a .png URL, whatever
     * output_format asked for. Browsers sniff, so this renders fine and nothing ever throws — which
     * is exactly why it needs to be reported rather than discovered by an asset pipeline later.
     */
    expect(extensionMismatch('public/assets/generated/logo-abc.png', jpg())).toEqual({
      expected: 'png',
      actual: 'jpg',
    });
  });

  it('is silent when they agree, including the .jpeg spelling', () => {
    expect(extensionMismatch('a/b/c.png', png())).toBeNull();
    expect(extensionMismatch('a/b/c.jpg', jpg())).toBeNull();
    expect(extensionMismatch('a/b/c.jpeg', jpg())).toBeNull();
  });

  it('declines to judge what it cannot read', () => {
    expect(extensionMismatch('a/b/c.png', new Uint8Array([1, 2, 3]))).toBeNull();
    expect(extensionMismatch('a/b/c', png())).toBeNull();
    expect(extensionMismatch('a/b/c.mp4', mp4())).toBeNull();
  });
});
