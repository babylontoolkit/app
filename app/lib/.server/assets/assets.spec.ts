/**
 * User asset uploads (SPEC §4.9, §5).
 *
 * Uploads are the classic untrusted-input surface: they are stored, referenced by the agent, and (for
 * shared games) served publicly. The validator is the gate, and every branch matters — a type slip
 * stores an executable as a "texture", a missing size cap is unbounded S3 spend on our bill, a GLB
 * that is not a GLB becomes a "model" the agent scaffolds against.
 */
import { describe, expect, it } from 'vitest';
import { glbToJson, InvalidGlbError, looksLikeGlb } from './glb';
import { DEFAULT_ASSET_LIMITS, validateAssetUpload } from './validate';

/** Build a minimal valid GLB carrying a given glTF JSON object. */
function makeGlb(json: object): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = jsonBytes.byteLength + ((4 - (jsonBytes.byteLength % 4)) % 4);
  const total = 12 + 8 + padded;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint32(0, 0x46546c67, true); // magic
  view.setUint32(4, 2, true); // version
  view.setUint32(8, total, true); // length
  view.setUint32(12, padded, true); // chunk length
  view.setUint32(16, 0x4e4f534a, true); // chunk type JSON
  buf.set(jsonBytes, 20);
  buf.fill(0x20, 20 + jsonBytes.byteLength); // pad with spaces

  return buf;
}

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('GLB parsing / structural validation', () => {
  it('extracts the JSON chunk from a well-formed GLB', () => {
    const glb = makeGlb({ asset: { version: '2.0' }, nodes: [{ name: 'Car' }] });

    expect(glbToJson(glb)).toMatchObject({ nodes: [{ name: 'Car' }] });
  });

  it('sniffs the GLB magic', () => {
    expect(looksLikeGlb(makeGlb({}))).toBe(true);
    expect(looksLikeGlb(png())).toBe(false);
  });

  it.each([
    [new Uint8Array(4), 'too small'],
    [
      new Uint8Array([0x00, 0x00, 0x00, 0x00, 2, 0, 0, 0, 40, 0, 0, 0, 8, 0, 0, 0, 0x4a, 0x53, 0x4f, 0x4e]),
      'bad magic',
    ],
  ])('rejects a malformed GLB (%s)', (bytes) => {
    expect(() => glbToJson(bytes)).toThrow(InvalidGlbError);
  });
});

describe('upload validation', () => {
  const base = { currentUserBytes: 0 };

  it('accepts a valid GLB as a model', () => {
    const result = validateAssetUpload({ filename: 'car.glb', bytes: makeGlb({}), ...base });

    expect(result).toMatchObject({ ok: true, kind: 'model', extension: 'glb' });
  });

  it('accepts a real PNG as a texture', () => {
    expect(validateAssetUpload({ filename: 'road.png', bytes: png(), ...base })).toMatchObject({
      ok: true,
      kind: 'texture',
    });
  });

  it('REJECTS an unknown type (allow-list, not deny-list)', () => {
    const result = validateAssetUpload({ filename: 'evil.exe', bytes: new Uint8Array([1, 2, 3]), ...base });

    expect(result).toMatchObject({ ok: false, code: 'type' });
  });

  it('REJECTS a .png whose bytes are not a PNG (content/extension mismatch)', () => {
    const result = validateAssetUpload({ filename: 'fake.png', bytes: new Uint8Array([0, 1, 2, 3, 4]), ...base });

    expect(result).toMatchObject({ ok: false, code: 'structure' });
  });

  it('REJECTS a file over the per-file cap', () => {
    const big = new Uint8Array(DEFAULT_ASSET_LIMITS.maxFileBytes + 1);
    big.set([0x89, 0x50, 0x4e, 0x47]);

    expect(validateAssetUpload({ filename: 'huge.png', bytes: big, ...base })).toMatchObject({
      ok: false,
      code: 'file-too-large',
    });
  });

  it('REJECTS an upload that would blow the per-user quota', () => {
    const result = validateAssetUpload({
      filename: 'road.png',
      bytes: png(),
      currentUserBytes: DEFAULT_ASSET_LIMITS.maxUserBytes,
    });

    expect(result).toMatchObject({ ok: false, code: 'quota' });
  });

  it('REJECTS an empty file', () => {
    expect(validateAssetUpload({ filename: 'x.glb', bytes: new Uint8Array(0), ...base })).toMatchObject({
      ok: false,
      code: 'empty',
    });
  });
});
