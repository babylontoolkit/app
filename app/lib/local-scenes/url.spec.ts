import { describe, expect, it } from 'vitest';
import { isLocalDevUrl, sceneNameFromUrl } from './url';

describe('isLocalDevUrl', () => {
  it('http://localhost:8888/a.gltf with pageOrigin http://localhost:5173 → true', () => {
    expect(isLocalDevUrl('http://localhost:8888/a.gltf', 'http://localhost:5173')).toBe(true);
  });

  it('http://localhost:5173/a with same origin → false', () => {
    expect(isLocalDevUrl('http://localhost:5173/a', 'http://localhost:5173')).toBe(false);
  });

  it('https://repo.babylontoolkit.com/a → false', () => {
    expect(isLocalDevUrl('https://repo.babylontoolkit.com/a')).toBe(false);
  });

  it('accepts every loopback spelling and refuses what does not parse', () => {
    for (const host of ['127.0.0.1:8888', '0.0.0.0:8888', '[::1]:8888']) {
      expect(isLocalDevUrl(`http://${host}/s.glb`)).toBe(true);
    }

    expect(isLocalDevUrl('not a url')).toBe(false);
    expect(isLocalDevUrl('file://localhost/x.gltf')).toBe(false);
  });
});

describe('sceneNameFromUrl', () => {
  it("sceneNameFromUrl('http://localhost:8888/scenes/Level 01.gz.gltf') → 'Level-01'", () => {
    expect(sceneNameFromUrl('http://localhost:8888/scenes/Level 01.gz.gltf')).toBe('Level-01');
  });

  it('strips every scene extension', () => {
    expect(sceneNameFromUrl('http://localhost:8888/a/Track.glb')).toBe('Track');
    expect(sceneNameFromUrl('http://localhost:8888/a/Track.gz.glb')).toBe('Track');
    expect(sceneNameFromUrl('http://localhost:8888/a/Track.gltf')).toBe('Track');
  });
});
