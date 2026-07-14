/**
 * Asset introspection (SPEC §4.9).
 *
 * "The agent knows what it just got": a Unity-Exporter prefab carries its component descriptors in the
 * glTF, and scanning them is what lets the agent write logic against the asset's REAL components rather
 * than an invented API. The scanner must be tolerant (exporter versions and third-party creators vary)
 * and must never throw on a malformed asset — a bad file yields fewer components, not an exception.
 */
import { describe, expect, it } from 'vitest';
import { introspectGltf, renderComponentReference } from './introspect';

/** A car prefab shaped like the Exporter's output: per-node extras with a components array. */
const carGltf = {
  nodes: [
    {
      name: 'CarBody',
      extras: {
        components: [
          { klass: 'StandardCarController', properties: { topSpeed: 200, driveType: 'AWD' } },
          { klass: 'RigidbodyPhysics', properties: { mass: 1500 } },
        ],
      },
    },
    { name: 'FrontLeftWheel', extras: { metadata: { klass: 'WheelCollider', properties: { radius: 0.34 } } } },
  ],
};

describe('scanning a prefab', () => {
  it('finds every component, its node, and its tuned properties', () => {
    const result = introspectGltf(carGltf);

    expect(result.classes).toEqual(['StandardCarController', 'RigidbodyPhysics', 'WheelCollider']);
    expect(result.nodes).toEqual(['CarBody', 'FrontLeftWheel']);

    const controller = result.components.find((c) => c.klass === 'StandardCarController');
    expect(controller?.node).toBe('CarBody');
    expect(controller?.properties).toMatchObject({ topSpeed: 200, driveType: 'AWD' });
  });

  it('reads the CVTOOLS_unity_metadata extension at the document level', () => {
    const gltf = { extensions: { CVTOOLS_unity_metadata: { components: [{ type: 'SceneController' }] } } };

    expect(introspectGltf(gltf).classes).toContain('SceneController');
  });

  it('accepts alternative class keys (type / alias / name)', () => {
    const gltf = { nodes: [{ name: 'n', extras: { components: [{ alias: 'AudioSource' }] } }] };

    expect(introspectGltf(gltf).classes).toEqual(['AudioSource']);
  });

  it('never throws on a malformed or empty asset', () => {
    expect(introspectGltf(null).components).toEqual([]);
    expect(introspectGltf({}).components).toEqual([]);
    expect(introspectGltf({ nodes: 'not-an-array' }).components).toEqual([]);
    expect(introspectGltf({ nodes: [null, 42, { extras: 'nope' }] }).components).toEqual([]);
  });
});

describe('the component reference note', () => {
  it('renders a compact reference the agent can write against', () => {
    const note = renderComponentReference('car.glb', introspectGltf(carGltf));

    expect(note).toContain('Asset Component Reference: car.glb');
    expect(note).toContain('StandardCarController');
    expect(note).toContain('topSpeed=200');
    expect(note).toMatch(/do not re-invent/i);
  });

  it('is null for an asset with no components — no empty note on every turn', () => {
    expect(renderComponentReference('plain.glb', introspectGltf({ nodes: [{ name: 'Mesh' }] }))).toBeNull();
  });
});
