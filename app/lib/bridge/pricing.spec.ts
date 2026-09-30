import { describe, expect, it } from 'vitest';
import * as pricing from './pricing';
import { isLongOperation } from './pricing';
import type { BridgeOperation } from './protocol';

const blender = (timeoutSeconds: number): BridgeOperation => ({
  kind: 'blender.script',
  source: 'x',
  inputs: [],
  outputs: [],
  timeoutSeconds,
});

describe('bridge long-operation classification', () => {
  it('list / devserver.status / editor status are not long', () => {
    expect(isLongOperation({ kind: 'unity.list' })).toBe(false);
    expect(isLongOperation({ kind: 'devserver.status' })).toBe(false);
    expect(isLongOperation({ kind: 'unity.editor', action: 'status' })).toBe(false);
  });

  it('unity.command set_transform is not long', () => {
    expect(isLongOperation({ kind: 'unity.command', name: 'set_transform', params: {} })).toBe(false);
  });

  it('unity.script is not long', () => {
    expect(isLongOperation({ kind: 'unity.script', source: 'x', entry: 'A.B' })).toBe(false);
  });

  it('bt_export_level is long', () => {
    expect(isLongOperation({ kind: 'unity.command', name: 'bt_export_level', params: {} })).toBe(true);
  });

  it('batch containing bake_lighting is long; a batch of short commands is not', () => {
    const op: BridgeOperation = {
      kind: 'unity.command',
      name: 'batch',
      params: { commands: [{ name: 'set_transform' }, { name: 'bake_lighting' }] },
    };
    expect(isLongOperation(op)).toBe(true);
    expect(
      isLongOperation({ kind: 'unity.command', name: 'batch', params: { commands: [{ name: 'set_transform' }] } }),
    ).toBe(false);
  });

  it("unity.cli ['test'] is long; ['status'] is not", () => {
    expect(isLongOperation({ kind: 'unity.cli', args: ['test'] })).toBe(true);
    expect(isLongOperation({ kind: 'unity.cli', args: ['status'] })).toBe(false);
  });

  it('blender.script timeout 60 is not long, timeout 600 is', () => {
    expect(isLongOperation(blender(60))).toBe(false);
    expect(isLongOperation(blender(600))).toBe(true);
  });

  it('unity.project open/create are long; list is not', () => {
    expect(isLongOperation({ kind: 'unity.project', action: 'open', name: 'A' })).toBe(true);
    expect(isLongOperation({ kind: 'unity.project', action: 'create', name: 'A' })).toBe(true);
    expect(isLongOperation({ kind: 'unity.project', action: 'list' })).toBe(false);
  });

  it('carries no per-operation price (D53 — bridge operations are not billed separately)', () => {
    expect(Object.keys(pricing).sort()).toEqual(['LONG_CLI', 'LONG_COMMANDS', 'isLongOperation']);
  });
});
