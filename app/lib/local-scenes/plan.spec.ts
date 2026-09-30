import { describe, expect, it } from 'vitest';
import { planSceneImport } from './plan';

const SCENE = 'http://localhost:8888/scenes/Level01.gltf';

describe('planSceneImport', () => {
  it('copies the scene + in-root relative URIs, skips the rest with a reason', () => {
    const plan = planSceneImport(SCENE, {
      buffers: [{ uri: 'Level01.bin' }],
      images: [
        { uri: 'tex/a%20b.png' },
        { uri: 'data:image/png;base64,AA' },
        { uri: '../x.png' },
        { uri: 'https://cdn/x.png' },
      ],
    });

    expect(plan.name).toBe('Level01');
    expect(plan.files).toEqual([
      { url: SCENE, dest: 'public/scenes/Level01/Level01.gltf' },
      { url: 'http://localhost:8888/scenes/Level01.bin', dest: 'public/scenes/Level01/Level01.bin' },
      { url: 'http://localhost:8888/scenes/tex/a%20b.png', dest: 'public/scenes/Level01/tex/a b.png' },
    ]);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(
      ['absolute URL — not copied', 'embedded data URI', 'outside the scene folder'].sort(),
    );
  });

  it('a .glb url with null JSON → exactly one file', () => {
    const plan = planSceneImport('http://localhost:8888/scenes/Track.glb', null);

    expect(plan.files).toEqual([
      { url: 'http://localhost:8888/scenes/Track.glb', dest: 'public/scenes/Track/Track.glb' },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('never writes outside the scene folder (encoded traversal, leading slash) and de-duplicates', () => {
    const plan = planSceneImport(SCENE, {
      buffers: [{ uri: 'a.bin' }, { uri: 'a.bin' }],
      images: [{ uri: '%2E%2E/evil.png' }, { uri: '/abs.png' }, { uri: 'sub/..%2F..%2Fx.png' }],
    });

    expect(plan.files.map((f) => f.dest)).toEqual([
      'public/scenes/Level01/Level01.gltf',
      'public/scenes/Level01/a.bin',
    ]);
    expect(plan.skipped.every((s) => s.reason === 'outside the scene folder')).toBe(true);
    expect(plan.skipped).toHaveLength(3);

    for (const file of plan.files) {
      expect(file.dest.startsWith('public/scenes/Level01/')).toBe(true);
    }
  });

  /* 🔴 The scene URL's OWN basename is decoded after splitting — `%2F` must not become a separator. */
  it('refuses a scene whose basename decodes to a traversal: ..%2F..%2Fsrc%2Fapp.tsx', () => {
    const plan = planSceneImport('http://localhost:8888/..%2F..%2Fsrc%2Fapp.tsx', null);

    expect(plan.files).toEqual([]);
    expect(plan.error).toContain('not a plain file name');
  });

  it('refuses a backslash traversal: %2e%2e%5Cx.glb', () => {
    const plan = planSceneImport('http://localhost:8888/scenes/%2e%2e%5Cx.glb', null);

    expect(plan.files).toEqual([]);
    expect(plan.error).toBeTruthy();
  });

  it('refuses a NUL in the basename', () => {
    expect(planSceneImport('http://localhost:8888/scenes/a%00.glb', null).files).toEqual([]);
  });

  /* CONTROL — a normal percent-encoded name still imports, decoded. */
  it('CONTROL: Level%2001.glb still imports as "Level 01.glb"', () => {
    const plan = planSceneImport('http://localhost:8888/scenes/Level%2001.glb', null);

    expect(plan.error).toBeUndefined();
    expect(plan.files).toEqual([
      { url: 'http://localhost:8888/scenes/Level%2001.glb', dest: 'public/scenes/Level-01/Level 01.glb' },
    ]);
  });

  it('normalises ./ and backslash separators in referenced URIs, and keeps every dest inside the folder', () => {
    const plan = planSceneImport(SCENE, {
      buffers: [{ uri: './Level01.bin' }],
      images: [{ uri: 'tex%5Ca.png' }, { uri: '%5C..%5Cx.png' }, { uri: 'a%00b.png' }],
    });

    expect(plan.files.map((f) => f.dest)).toEqual([
      'public/scenes/Level01/Level01.gltf',
      'public/scenes/Level01/Level01.bin',
      'public/scenes/Level01/tex/a.png',
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['outside the scene folder', 'outside the scene folder']);
  });

  it('never fetches a URI that carries a scheme without :// (it would resolve off the scene origin)', () => {
    const plan = planSceneImport(SCENE, {
      images: [{ uri: 'https:evil.com/x.png' }, { uri: 'file:x.png' }, { uri: 'C:%5Cx.png' }, { uri: 'ok.png' }],
    });

    expect(plan.files.map((f) => f.url)).toEqual([SCENE, 'http://localhost:8888/scenes/ok.png']);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'absolute URL — not copied',
      'absolute URL — not copied',
      'absolute URL — not copied',
    ]);

    for (const file of plan.files) {
      expect(new URL(file.url).origin).toBe('http://localhost:8888');
    }
  });
});
