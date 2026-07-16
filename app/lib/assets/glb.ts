/**
 * GLB container parsing (SPEC §4.9).
 *
 * A `.glb` is a binary wrapper around the same glTF JSON that a `.gltf` file holds as text, plus the
 * geometry/texture buffers. Asset introspection (`introspect.ts`) only needs the JSON chunk — the
 * component descriptors never live in the binary buffers — so this extracts it without pulling in a
 * glTF library.
 *
 * It doubles as the STRUCTURAL VALIDATION for an uploaded GLB (§4.9 "glTF structural validation"): the
 * header magic, version, and chunk framing must all be well-formed, and the declared length must fit
 * the bytes. A file that claims to be a GLB but is not parses to an error, which the upload route turns
 * into a rejection — we never store a "model" that is actually something else wearing a `.glb` name.
 *
 * Format (glTF 2.0 binary): 12-byte header [magic 'glTF'(0x46546C67) | version u32 | total length u32],
 * then chunks, each [chunk length u32 | chunk type u32 | data]. The first chunk is JSON (0x4E4F534A).
 */

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

export class InvalidGlbError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(`Not a valid GLB file: ${message}`);
    this.name = 'InvalidGlbError';
  }
}

/** Extract and parse the JSON chunk of a GLB. Throws `InvalidGlbError` on any structural problem. */
export function glbToJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) {
    throw new InvalidGlbError('too small to contain a header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new InvalidGlbError('bad magic (not "glTF")');
  }

  const version = view.getUint32(4, true);

  if (version !== 2) {
    throw new InvalidGlbError(`unsupported version ${version}`);
  }

  const totalLength = view.getUint32(8, true);

  // The file must be AT LEAST as long as it claims — a shorter buffer means a truncated/lying file.
  if (totalLength > bytes.byteLength) {
    throw new InvalidGlbError('declared length exceeds the file');
  }

  const jsonChunkLength = view.getUint32(HEADER_BYTES, true);
  const jsonChunkType = view.getUint32(HEADER_BYTES + 4, true);

  if (jsonChunkType !== CHUNK_JSON) {
    throw new InvalidGlbError('first chunk is not JSON');
  }

  const start = HEADER_BYTES + CHUNK_HEADER_BYTES;
  const end = start + jsonChunkLength;

  if (end > bytes.byteLength) {
    throw new InvalidGlbError('JSON chunk runs past the end of the file');
  }

  const jsonBytes = bytes.subarray(start, end);

  try {
    return JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new InvalidGlbError('JSON chunk is not valid JSON');
  }
}

/** True if the bytes begin with the GLB magic — a cheap sniff before a full parse. */
export function looksLikeGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) {
    return false;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return view.getUint32(0, true) === GLB_MAGIC;
}
