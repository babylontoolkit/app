import { afterEach, describe, expect, it, vi } from 'vitest';
import { introspectStoreAssetUrl } from './store-introspect';

/** Build a minimal but valid binary GLB wrapping the given glTF JSON. */
function makeGlb(gltf: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const pad = (4 - (json.length % 4)) % 4; // JSON chunk must be 4-byte aligned
  const jsonLen = json.length + pad;

  const total = 12 + 8 + jsonLen;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true); // version
  view.setUint32(8, total, true); // total length
  view.setUint32(12, jsonLen, true); // JSON chunk length
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  buf.set(json, 20);
  buf.fill(0x20, 20 + json.length, 20 + jsonLen); // pad with spaces

  return buf;
}

const CAR_GLTF = {
  nodes: [
    { name: 'CarBody', extras: { components: [{ klass: 'StandardCarController', properties: { topSpeed: 200 } }] } },
  ],
};

function mockFetchBytes(bytes: Uint8Array, ok = true) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }) as unknown as typeof fetch;
}

describe('introspectStoreAssetUrl', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('unwraps a binary GLB and reports its components', async () => {
    mockFetchBytes(makeGlb(CAR_GLTF));

    const result = await introspectStoreAssetUrl('https://repo.example/prefabs/car.glb');

    expect(result.classes).toContain('StandardCarController');
    expect(result.reference).toContain('StandardCarController');
    expect(result.reference).toContain('topSpeed=200');
  });

  it('unwraps a plain-text glTF', async () => {
    mockFetchBytes(new TextEncoder().encode(JSON.stringify(CAR_GLTF)));

    const result = await introspectStoreAssetUrl('https://repo.example/scenes/car.gltf');

    expect(result.classes).toContain('StandardCarController');
  });

  it('returns empty (never throws) on a 404', async () => {
    mockFetchBytes(new Uint8Array([1, 2, 3]), false);

    expect(await introspectStoreAssetUrl('https://repo.example/missing.glb')).toEqual({
      reference: null,
      classes: [],
    });
  });

  it('returns empty on garbage bytes that are neither GLB nor JSON', async () => {
    mockFetchBytes(new Uint8Array([9, 9, 9, 9, 9]));

    expect(await introspectStoreAssetUrl('https://repo.example/junk.bin')).toEqual({
      reference: null,
      classes: [],
    });
  });

  it('returns empty with no components rather than a spurious reference', async () => {
    mockFetchBytes(makeGlb({ nodes: [{ name: 'Empty' }] }));

    const result = await introspectStoreAssetUrl('https://repo.example/empty.glb');
    expect(result.reference).toBeNull();
    expect(result.classes).toEqual([]);
  });
});
