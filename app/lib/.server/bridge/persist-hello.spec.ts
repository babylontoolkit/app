import { describe, expect, it } from 'vitest';
import { BRIDGE_LAST_SEEN_WRITE_MS, type BridgeHello } from '~/lib/bridge/protocol';
import { canonicalJson, shouldPersistHello } from './persist-hello';

const hello: BridgeHello = {
  protocol: 1,
  helperVersion: '1.2.0',
  os: 'darwin',
  unityProjects: [
    { key: 'k1', name: 'Kart', unityVersion: '6000.0.1f1' },
    { key: 'k2', name: 'Maze' },
  ],
  devServer: { running: true, origin: 'http://localhost:8888', scenes: ['a', 'b'] },
  scriptsDisabledLocally: false,
};

/** The same content with every object's keys reordered — what a jsonb round trip hands back. */
const reordered = {
  scriptsDisabledLocally: false,
  unityProjects: [
    { unityVersion: '6000.0.1f1', name: 'Kart', key: 'k1' },
    { name: 'Maze', key: 'k2' },
  ],
  devServer: { scenes: ['a', 'b'], origin: 'http://localhost:8888', running: true },
  os: 'darwin',
  helperVersion: '1.2.0',
  protocol: 1,
} as BridgeHello;

const NOW = Date.parse('2026-09-29T12:00:00.000Z');

describe('shouldPersistHello', () => {
  it('same content with reordered keys + a recent write → no write within the throttle window', () => {
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(hello)); // the fixture really is reordered
    expect(shouldPersistHello(reordered, hello, NOW - 5_000, NOW)).toBe(false);
    expect(shouldPersistHello(reordered, hello, NOW - (BRIDGE_LAST_SEEN_WRITE_MS - 1), NOW)).toBe(false);
  });

  it('a genuinely different hello → write', () => {
    expect(shouldPersistHello(reordered, { ...hello, helperVersion: '1.3.0' }, NOW - 5_000, NOW)).toBe(true);
  });

  it('array order is meaningful — a reordered unityProjects list is a change', () => {
    const swapped = { ...hello, unityProjects: [...hello.unityProjects].reverse() };
    expect(shouldPersistHello(hello, swapped, NOW - 5_000, NOW)).toBe(true);
  });

  it('CONTROL — elapsed ≥ BRIDGE_LAST_SEEN_WRITE_MS → write', () => {
    expect(shouldPersistHello(reordered, hello, NOW - BRIDGE_LAST_SEEN_WRITE_MS, NOW)).toBe(true);
  });

  it('never written (no stored capabilities or no lastSeenAt) → write', () => {
    expect(shouldPersistHello(undefined, hello, 0, NOW)).toBe(true);
    expect(shouldPersistHello(hello, hello, Number.NaN, NOW)).toBe(true);
  });

  it('canonicalJson sorts keys at every depth and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
  });
});
