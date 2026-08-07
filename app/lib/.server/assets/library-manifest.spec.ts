/**
 * Asset library manifest — validation + the compact index (SPEC §4.4d).
 *
 * Two silent failure modes drive every test here: a garbage manifest reaching the model's context
 * (nothing throws, every generation just gets worse), and a library the model is TOLD about but
 * cannot see (which is how invented asset paths end up in shipped game code).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_INDEX_CHAR_BUDGET,
  buildAssetLibraryIndex,
  validateAssetLibraryManifest,
  type AssetLibraryManifest,
} from './library-manifest';

function manifest(overrides: Partial<AssetLibraryManifest> = {}): AssetLibraryManifest {
  return {
    version: 1,
    baseUrl: 'https://repo.babylontoolkit.com/',
    packs: [
      {
        id: 'synty-military',
        title: 'Polygon Military',
        kind: 'characters',
        description: 'Soldiers, weapons, emplacements.',
        assets: [
          { path: 'packs/military/Soldier_01.gltf', name: 'Soldier_01', tags: ['character'] },
          { path: 'packs/military/Tank_01.gltf', name: 'Tank_01' },
        ],
      },
      {
        id: 'synty-city',
        title: 'Polygon City',
        kind: 'level',
        assets: [{ path: 'packs/city/CityBlock_A.gltf', name: 'CityBlock_A', sceneUrl: 'scenes/city.json' }],
      },
    ],
    ...overrides,
  };
}

describe('validateAssetLibraryManifest', () => {
  it('accepts a well-formed manifest and preserves unknown exporter fields untouched', () => {
    const candidate = manifest();
    (candidate.packs[0].assets[0] as Record<string, unknown>).components = [{ object: 'Root', script: 'BT.Rigidbody' }];
    (candidate as Record<string, unknown>).exporterVersion = '2.4.1';

    const result = validateAssetLibraryManifest(candidate);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect((result.manifest as Record<string, unknown>).exporterVersion).toBe('2.4.1');
      expect(result.manifest.packs[0].assets[0].components).toEqual([{ object: 'Root', script: 'BT.Rigidbody' }]);
    }
  });

  it('reports EVERY error at once — an admin fixing an export needs the full list', () => {
    const result = validateAssetLibraryManifest({
      version: 'one',
      baseUrl: 'http://insecure.example.com/',
      packs: [
        { id: '', title: '', assets: [{ path: '', name: '' }] },
        { id: 'dup', title: 'A', assets: [{ path: 'ok/a.gltf', name: 'a' }] },
        { id: 'dup', title: 'B', assets: [{ path: 'ok/b.gltf', name: 'b' }] },
      ],
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
      expect(result.errors.join('\n')).toContain('duplicates pack id');
      expect(result.errors.join('\n')).toContain('`version` must be a number');
      expect(result.errors.join('\n')).toContain('https');
    }
  });

  /*
   * The path-traversal wall: an absolute path, a scheme, or a `..` segment escapes `baseUrl`, and the
   * model ships whatever the index says verbatim into game code.
   */
  it.each([
    ['/absolute/soldier.gltf', 'leading slash'],
    ['https://evil.example.com/soldier.gltf', 'embedded scheme'],
    ['packs/../../../etc/passwd', 'traversal'],
  ])('refuses asset path %s (%s)', (path) => {
    const candidate = manifest();
    candidate.packs[0].assets[0].path = path;

    const result = validateAssetLibraryManifest(candidate);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('must be relative to baseUrl');
    }
  });

  it('refuses an empty pack and an empty manifest — exporter bugs surface at promote time', () => {
    const emptyPack = validateAssetLibraryManifest(manifest({ packs: [{ id: 'x', title: 'X', assets: [] }] }));
    expect(emptyPack.ok).toBe(false);

    const noPacks = validateAssetLibraryManifest(manifest({ packs: [] }));
    expect(noPacks.ok).toBe(false);

    if (!noPacks.ok) {
      expect(noPacks.errors.join('\n')).toContain('unpin instead');
    }
  });

  it('refuses non-object candidates outright', () => {
    for (const candidate of [null, [], 'manifest', 42]) {
      expect(validateAssetLibraryManifest(candidate).ok).toBe(false);
    }
  });

  /*
   * Structured optionals are validated WHEN PRESENT. A nameless prefab is the model instantiating
   * nothing silently; a spawn at a non-numeric position is a spawn at NaN.
   */
  it('refuses a prefab without a name, a node without a name, and a malformed spawn point', () => {
    const candidate = manifest();
    candidate.packs[0].assets[0].prefabs = [{ name: 'Barrel_Rusty' }, { kind: 'prop' } as never];
    candidate.packs[0].assets[0].nodes = [{ name: '' } as never];
    candidate.packs[0].assets[1].spawnPoints = [{ name: 'Spawn', position: [1, 'two', 3] } as never];

    const result = validateAssetLibraryManifest(candidate);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('prefabs[1] is missing a non-empty `name`');
      expect(result.errors.join('\n')).toContain('nodes[0] is missing a non-empty `name`');
      expect(result.errors.join('\n')).toContain('`position` must be [x, y, z] numbers');
    }
  });

  it('applies the path-traversal wall to sceneUrl too', () => {
    const candidate = manifest();
    candidate.packs[1].assets[0].sceneUrl = 'https://evil.example.com/scene.json';

    const result = validateAssetLibraryManifest(candidate);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('sceneUrl');
    }
  });
});

/*
 * 🔴 THE STARTER MANIFEST IS EXECUTABLE DOCUMENTATION. `_specs/asset-library_manifest-schema.md` is
 * the Unity exporter's target, `_specs/asset-library_example-assets.json` is its worked example, and
 * this block is what stops the three from drifting: the example must always validate, and its rich
 * detail (nodes, prefabs, spawn points, animations) must survive validation untouched. An example
 * the validator refuses would teach the exporter a schema the platform rejects.
 */
describe('the starter example manifest (_specs/asset-library_example-assets.json)', () => {
  const example = JSON.parse(
    readFileSync(join(__dirname, '../../../../_specs/asset-library_example-assets.json'), 'utf-8'),
  ) as unknown;

  it('validates clean — the schema doc, the example, and the validator agree', () => {
    const result = validateAssetLibraryManifest(example);

    if (!result.ok) {
      throw new Error(`The example manifest must validate:\n${result.errors.join('\n')}`);
    }

    // The rich exporter detail survives untouched (unknown-fields-pass-through).
    const level = result.manifest.packs[0].assets[0];
    expect(level.spawnPoints?.length).toBeGreaterThan(0);
    expect(level.navMesh).toBe(true);

    const container = result.manifest.packs.find((pack) => pack.id === 'synty-apocalypse-props')?.assets[0];
    expect(container?.prefabs?.map((prefab) => prefab.name)).toContain('Barrel_Explosive');
  });

  it('builds an index within budget that carries the container prefab names', () => {
    const checked = validateAssetLibraryManifest(example);
    expect(checked.ok).toBe(true);

    if (checked.ok) {
      const index = buildAssetLibraryIndex(checked.manifest);

      expect(index).toBeDefined();
      expect(index!.length).toBeLessThanOrEqual(ASSET_INDEX_CHAR_BUDGET);

      // The model instantiates BY name — a container whose names don't travel is opaque.
      expect(index).toContain('instantiate by name');
      expect(index).toContain('Barrel_Explosive');
      expect(index).toContain('Tree_Pine_Large');
    }
  });
});

describe('buildAssetLibraryIndex', () => {
  it('emits NO block when there is no manifest — never advertise a library the model cannot see', () => {
    expect(buildAssetLibraryIndex(undefined)).toBeUndefined();
    expect(buildAssetLibraryIndex(null)).toBeUndefined();
    expect(buildAssetLibraryIndex(manifest({ packs: [] }) as AssetLibraryManifest)).toBeUndefined();
  });

  it('carries every pack, the ALWAYS-PREFER rule, and exact asset paths', () => {
    const index = buildAssetLibraryIndex(manifest());

    expect(index).toBeDefined();
    expect(index).toContain('Polygon Military');
    expect(index).toContain('Polygon City');
    expect(index).toContain('packs/military/Soldier_01.gltf');

    // The owner's rule (2026-08-07): the library is the FIRST stop, primitives the LAST resort.
    expect(index).toContain('ALWAYS PREFER THIS LIBRARY');
    expect(index).toContain('LAST resort');
    expect(index).toContain('never invent or guess a library path');
  });

  /*
   * Byte-identity: the index rides in the CACHED prompt prefix, so the same manifest must always
   * produce the same bytes regardless of pack order in the source (the sorted-skills-index rule —
   * an unstable prefix busts the cache on every generation).
   */
  it('is deterministic across pack orderings', () => {
    const a = manifest();
    const b = manifest({ packs: [...manifest().packs].reverse() });

    expect(buildAssetLibraryIndex(a)).toBe(buildAssetLibraryIndex(b));
  });

  it('caps a pack with many assets and says how many more exist rather than lying', () => {
    const many = manifest({
      packs: [
        {
          id: 'big',
          title: 'Big Pack',
          assets: Array.from({ length: 120 }, (_, i) => ({ path: `big/Asset_${i}.gltf`, name: `Asset_${i}` })),
        },
      ],
    });

    const index = buildAssetLibraryIndex(many);

    expect(index).toBeDefined();
    expect(index).toContain('…and 80 more in this pack');
  });

  it('holds the hard char budget even for a pathological manifest, keeping every pack header', () => {
    const huge = manifest({
      packs: Array.from({ length: 40 }, (_, p) => ({
        id: `pack-${String(p).padStart(2, '0')}`,
        title: `Pack ${p}`,
        assets: Array.from({ length: 40 }, (_, i) => ({
          path: `pack${p}/SomeVeryLongAssetFileName_${i}.gltf`,
          name: `Asset_${i}`,
        })),
      })),
    });

    const index = buildAssetLibraryIndex(huge);

    expect(index).toBeDefined();
    expect(index!.length).toBeLessThanOrEqual(ASSET_INDEX_CHAR_BUDGET);

    // Awareness of WHAT EXISTS survives the cut — the per-asset names are what get summarized.
    expect(index).toContain('pack-00');
  });
});
