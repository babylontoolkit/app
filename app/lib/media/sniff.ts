/**
 * What the bytes ACTUALLY are (SPEC §4.16).
 *
 * The provider's word is not evidence. Measured 2026-07-23: every nano-banana-2 result served from
 * KIE's `/ggc/…` backend is JPEG bytes behind a `.png` URL, whatever `output_format` asked for — so
 * the platform had been writing JPEGs into projects named `.png` since media generation shipped. That
 * violates the §4.16 rule that the job's format and `deriveDestPath`'s extension must agree, and it is
 * the kind of mismatch that never throws: browsers sniff, so the image renders fine and only a build
 * step, an asset pipeline, or a human reading the file tree ever notices.
 *
 * The cut-out pipeline makes the common case correct by construction (cut-out art renders as jpg and
 * comes back from Recraft as a real PNG), but "correct by construction" is exactly what the format
 * request was, so this checks rather than assumes.
 *
 * Pure — the route feeds it the first chunk of the stream and re-emits it, so nothing is buffered.
 */

export type SniffedImageType = 'png' | 'jpg' | 'gif' | 'webp' | 'mp4' | 'unknown';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) {
    return false;
  }

  return magic.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) {
    return '';
  }

  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** Identify a render from its leading bytes. Needs ~16 bytes; fewer simply reads as `unknown`. */
export function sniffImageType(bytes: Uint8Array): SniffedImageType {
  if (startsWith(bytes, PNG_MAGIC)) {
    return 'png';
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'jpg';
  }

  if (ascii(bytes, 0, 3) === 'GIF') {
    return 'gif';
  }

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'webp';
  }

  // ISO-BMFF: the `ftyp` box at offset 4 covers mp4/m4v/mov-family containers.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    return 'mp4';
  }

  return 'unknown';
}

const CONTENT_TYPES: Record<Exclude<SniffedImageType, 'unknown'>, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

/** The Content-Type the BYTES justify, or null when they are unrecognised (caller keeps its default). */
export function contentTypeForBytes(bytes: Uint8Array): string | null {
  const sniffed = sniffImageType(bytes);

  return sniffed === 'unknown' ? null : CONTENT_TYPES[sniffed];
}

/**
 * Does the delivered file match the extension it is being written under?
 *
 * `null` means "no opinion" — unknown bytes, or an extension we do not police. Only a CONFIDENT
 * mismatch is reported, because a false alarm on every render trains the operator to ignore the alarm.
 */
export function extensionMismatch(destPath: string, bytes: Uint8Array): { expected: string; actual: string } | null {
  const sniffed = sniffImageType(bytes);

  if (sniffed === 'unknown') {
    return null;
  }

  const ext = destPath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

  if (!ext) {
    return null;
  }

  const normalised = ext === 'jpeg' ? 'jpg' : ext;

  if (normalised !== 'png' && normalised !== 'jpg' && normalised !== 'gif' && normalised !== 'webp') {
    return null;
  }

  return normalised === sniffed ? null : { expected: normalised, actual: sniffed };
}
