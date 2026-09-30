/**
 * Unity Bridge long-operation classification.
 *
 * 🔴 Bridge operations are NOT billed per operation (D53, owner 2026-09-29): the model turn that drives
 * Unity/Blender is billed like any generation, and running a command on the user's machine costs nothing
 * extra. What survives here is only the question "is this a LONG operation?", which decides timeouts.
 * Do not re-add price classes — there is no bridge ledger reason for them to debit.
 *
 * Spec: `_specs/unity-bridge-local-gltf_spec.md` B4/B6/B7.
 *
 * The Desktop Agent carries a CommonJS port of the long-op rule in `lib/bridge/policy.js` (D3) — change
 * both, and both test tables, together.
 */
import type { BridgeOperation } from './protocol';

export const LONG_COMMANDS = new Set([
  'bt_export_level',
  'bt_export_prefab',
  'bt_export_animation',
  'bt_build_project',
  'bake_lighting',
  'bake_navmesh',
  'bake_navmesh_surfaces',
  'bake_occlusion_culling',
  'run_tests',
]);
export const LONG_CLI = new Set(['test', 'build', 'recompile']);

function batchNames(params: Record<string, unknown> | undefined): string[] {
  const commands = params?.commands;

  if (!Array.isArray(commands)) {
    return [];
  }

  return commands
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

export function isLongOperation(op: BridgeOperation): boolean {
  switch (op.kind) {
    case 'unity.command':
      if (LONG_COMMANDS.has(op.name)) {
        return true;
      }

      return op.name === 'batch' && batchNames(op.params).some((name) => LONG_COMMANDS.has(name));
    case 'unity.cli':
      return Array.isArray(op.args) && typeof op.args[0] === 'string' && LONG_CLI.has(op.args[0]);
    case 'blender.script':
      return op.timeoutSeconds > 120;
    case 'unity.project':
      // open/create launch or build a Unity project and wait for the editor — minutes, not seconds.
      return op.action === 'open' || op.action === 'create';
    default:
      return false;
  }
}
