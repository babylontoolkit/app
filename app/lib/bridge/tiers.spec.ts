/**
 * The tier table (D14). These cases are copied VERBATIM as data into the Desktop Agent's
 * `tests/bridge-policy.test.js` (D3) — change both together.
 */
import { describe, expect, it } from 'vitest';
import type { BridgeOperation } from './protocol';
import { classifyOperation } from './tiers';

const command = (name: string, params: Record<string, unknown> = {}): BridgeOperation => ({
  kind: 'unity.command',
  name,
  params,
});
const cli = (...args: string[]): BridgeOperation => ({ kind: 'unity.cli', args });

describe('classifyOperation', () => {
  it('unity.command bt_export_level → allowed', () => {
    expect(classifyOperation(command('bt_export_level')).tier).toBe('allowed');
  });

  it('set_transform → allowed', () => {
    expect(classifyOperation(command('set_transform')).tier).toBe('allowed');
  });

  it('run_script → scripts', () => {
    expect(classifyOperation(command('run_script')).tier).toBe('scripts');
  });

  it('set_import_settings → consent', () => {
    expect(classifyOperation(command('set_import_settings')).tier).toBe('consent');
  });

  it('delete_foo → consent', () => {
    expect(classifyOperation(command('delete_foo')).tier).toBe('consent');
  });

  it('unknown_thing → consent with reason', () => {
    const decision = classifyOperation(command('unknown_thing'));
    expect(decision.tier).toBe('consent');
    expect(decision.reason).toBe('unrecognised command — asking first');
  });

  it('batch of [create_gameobject, delete_gameobject] → consent', () => {
    const op = command('batch', { commands: [{ name: 'create_gameobject' }, { name: 'delete_gameobject' }] });
    expect(classifyOperation(op).tier).toBe('consent');
  });

  it('batch of allowed commands → allowed (control)', () => {
    const op = command('batch', { commands: [{ name: 'create_gameobject' }, { name: 'set_transform' }] });
    expect(classifyOperation(op).tier).toBe('allowed');
  });

  it('batch without commands → consent', () => {
    expect(classifyOperation(command('batch')).tier).toBe('consent');
    expect(classifyOperation(command('batch', { commands: [{ nope: 1 }] })).tier).toBe('consent');
  });

  it("unity.cli ['license','return'] → consent", () => {
    expect(classifyOperation(cli('license', 'return')).tier).toBe('consent');
  });

  it("unity.cli ['editors'] → allowed", () => {
    expect(classifyOperation(cli('editors')).tier).toBe('allowed');
  });

  it("unity.cli ['projects','new','--help'] → allowed", () => {
    expect(classifyOperation(cli('projects', 'new', '--help')).tier).toBe('allowed');
  });

  it("unity.cli ['license','return','-h'] → allowed", () => {
    expect(classifyOperation(cli('license', 'return', '-h')).tier).toBe('allowed');
  });

  it("unity.cli ['shell','--help'] → refused", () => {
    expect(classifyOperation(cli('shell', '--help')).tier).toBe('refused');
  });

  it("['status'] → allowed", () => {
    expect(classifyOperation(cli('status')).tier).toBe('allowed');
  });

  it("['projects','info'] → allowed", () => {
    expect(classifyOperation(cli('projects', 'info')).tier).toBe('allowed');
  });

  it("['projects','clean'] → consent", () => {
    expect(classifyOperation(cli('projects', 'clean')).tier).toBe('consent');
  });

  it('[\'shell\'] → refused, reason mentions "not available"', () => {
    const decision = classifyOperation(cli('shell'));
    expect(decision.tier).toBe('refused');
    expect(decision.reason).toContain('not available');
  });

  it("['open'] → refused, reason mentions unity_editor", () => {
    const decision = classifyOperation(cli('open'));
    expect(decision.tier).toBe('refused');
    expect(decision.reason).toContain('unity_editor');
  });

  it('[] → refused', () => {
    expect(classifyOperation(cli()).tier).toBe('refused');
  });

  it('blender.script → scripts', () => {
    const op: BridgeOperation = { kind: 'blender.script', source: 'x', inputs: [], outputs: [], timeoutSeconds: 60 };
    expect(classifyOperation(op).tier).toBe('scripts');
  });

  it('unity.editor close → allowed', () => {
    expect(classifyOperation({ kind: 'unity.editor', action: 'close' }).tier).toBe('allowed');
  });

  it('unity.project list → allowed', () => {
    expect(classifyOperation({ kind: 'unity.project', action: 'list' }).tier).toBe('allowed');
  });

  it('unity.project open → allowed', () => {
    expect(classifyOperation({ kind: 'unity.project', action: 'open', name: 'My Game' }).tier).toBe('allowed');
  });

  it('unity.project create → allowed', () => {
    expect(classifyOperation({ kind: 'unity.project', action: 'create', name: 'My Game' }).tier).toBe('allowed');
  });
});
