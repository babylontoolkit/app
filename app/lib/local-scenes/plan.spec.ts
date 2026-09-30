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

  /*
   * A trimmed REAL Babylon Toolkit export (`lightprobeshowcase.gltf`, generator "Babylon Toolkit
   * (6000.5.10f1)"): only the fields that name files, plus a few that must NOT be read as files.
   */
  const TOOLKIT_SCENE = 'http://localhost:8888/scenes/lightprobeshowcase.gltf';
  const toolkitGltf = () => ({
    asset: { generator: 'Babylon Toolkit (6000.5.10f1)', version: '2.0' },
    buffers: [{ uri: 'lightprobeshowcase.bin', byteLength: 240392 }],
    images: [
      {
        uri: 'assets/lightprobeshowcase_lightmap-0_comp_light_rgbd_547bd04f6ba4741f1b99a9f6d6772f7c.png',
        name: 'LightProbeShowcase_Lightmap-0_comp_light',
      },
    ],
    nodes: [
      {
        name: 'Light Probe Group',
        extras: {
          metadata: {
            components: [
              {
                alias: 'script',
                klass: 'TOOLKIT.LightProbeNetwork',
                properties: { url: 'lightprobeshowcase.probe.bin', probecount: 449, space: 'unity-world' },
              },
            ],
          },
        },
      },
    ],
    scenes: [
      {
        extras: {
          metadata: {
            filename: 'LightProbeShowcase',
            script: 'babylontoolkit-2024',
            project: 'babylontoolkit-2024.js',
            renderpipeline: 'birp',
            mainlight: '08cbf77f-035a-49c4-906a-f43b3ba95516',
            skybox: {
              environment: {
                url: 'assets/procedural_skybox_ibl.env',
                info: { name: 'procedural_skybox_ibl.env' },
              },
            },
            lightprobes: { url: 'lightprobeshowcase.probe.bin', probecount: 449 },
          },
        },
      },
    ],
  });

  it('a real Toolkit scene: plans the env map, the light-probe .bin and the project script bundle from extras', () => {
    const plan = planSceneImport(TOOLKIT_SCENE, toolkitGltf());
    const base = 'public/scenes/lightprobeshowcase/';

    expect(plan.error).toBeUndefined();
    expect(plan.files).toEqual([
      { url: TOOLKIT_SCENE, dest: `${base}lightprobeshowcase.gltf` },
      { url: 'http://localhost:8888/scenes/lightprobeshowcase.bin', dest: `${base}lightprobeshowcase.bin` },
      {
        url: 'http://localhost:8888/scenes/assets/lightprobeshowcase_lightmap-0_comp_light_rgbd_547bd04f6ba4741f1b99a9f6d6772f7c.png',
        dest: `${base}assets/lightprobeshowcase_lightmap-0_comp_light_rgbd_547bd04f6ba4741f1b99a9f6d6772f7c.png`,
      },
      {
        url: 'http://localhost:8888/scenes/lightprobeshowcase.probe.bin',
        dest: `${base}lightprobeshowcase.probe.bin`,
        optional: true,
      },
      {
        url: 'http://localhost:8888/scenes/babylontoolkit-2024.js',
        dest: `${base}babylontoolkit-2024.js`,
        optional: true,
      },
      {
        url: 'http://localhost:8888/scenes/assets/procedural_skybox_ibl.env',
        dest: `${base}assets/procedural_skybox_ibl.env`,
        optional: true,
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('a non-file extras string is never fetched: class names, GUIDs, labels, bare names', () => {
    const plan = planSceneImport(TOOLKIT_SCENE, toolkitGltf());
    const urls = plan.files.map((f) => f.url);

    for (const notAFile of [
      'TOOLKIT.LightProbeNetwork',
      'babylontoolkit-2024',
      'birp',
      '08cbf77f',
      'LightProbeShowcase',
    ]) {
      expect(urls.some((url) => url.endsWith(`/${notAFile}`) || url.includes(notAFile + '?'))).toBe(false);
    }

    // The skybox's `info.name` is a LABEL — the real file is `assets/…`, not the scene folder root.
    expect(urls).not.toContain('http://localhost:8888/scenes/procedural_skybox_ibl.env');
  });

  it('extras references follow the same skip rules as buffers/images', () => {
    const plan = planSceneImport(SCENE, {
      scenes: [
        {
          extras: {
            metadata: {
              a: '../outside.env',
              b: '/rooted.bin',
              c: 'https://cdn.example.com/sky.env',
              d: 'ok/probe.bin',
              e: 'not a file at all',
            },
          },
        },
      ],
    });

    expect(plan.files.map((f) => f.dest)).toEqual([
      'public/scenes/Level01/Level01.gltf',
      'public/scenes/Level01/ok/probe.bin',
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'outside the scene folder',
      'outside the scene folder',
      'absolute URL — not copied',
    ]);
  });
});
