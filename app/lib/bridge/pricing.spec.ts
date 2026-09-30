import { describe, expect, it } from 'vitest';
import { creditsFor, DEFAULT_BRIDGE_PRICES, priceClassOf } from './pricing';
import type { BridgeOperation } from './protocol';

const P = DEFAULT_BRIDGE_PRICES;
const blender = (timeoutSeconds: number): BridgeOperation => ({
  kind: 'blender.script',
  source: 'x',
  inputs: [],
  outputs: [],
  timeoutSeconds,
});

describe('bridge pricing', () => {
  it('list / devserver.status / editor status → free (0)', () => {
    expect(creditsFor({ kind: 'unity.list' }, P)).toBe(0);
    expect(creditsFor({ kind: 'devserver.status' }, P)).toBe(0);
    expect(creditsFor({ kind: 'unity.editor', action: 'status' }, P)).toBe(0);
    expect(priceClassOf({ kind: 'unity.list' })).toBe('free');
  });

  it('unity.command set_transform → 1', () => {
    expect(creditsFor({ kind: 'unity.command', name: 'set_transform', params: {} }, P)).toBe(1);
  });

  it('unity.script → 2', () => {
    expect(creditsFor({ kind: 'unity.script', source: 'x', entry: 'A.B' }, P)).toBe(2);
  });

  it('bt_export_level → 4', () => {
    expect(creditsFor({ kind: 'unity.command', name: 'bt_export_level', params: {} }, P)).toBe(4);
  });

  it('batch containing bake_lighting → 4', () => {
    const op: BridgeOperation = {
      kind: 'unity.command',
      name: 'batch',
      params: { commands: [{ name: 'set_transform' }, { name: 'bake_lighting' }] },
    };
    expect(creditsFor(op, P)).toBe(4);
  });

  it("unity.cli ['test'] → 4", () => {
    expect(creditsFor({ kind: 'unity.cli', args: ['test'] }, P)).toBe(4);
  });

  it('blender.script timeout 60 → 2, timeout 600 → 4', () => {
    expect(creditsFor(blender(60), P)).toBe(2);
    expect(creditsFor(blender(600), P)).toBe(4);
  });

  it('prices {command:0,…} → 0', () => {
    expect(
      creditsFor({ kind: 'unity.command', name: 'set_transform', params: {} }, { command: 0, script: 2, job: 4 }),
    ).toBe(0);
  });
});
