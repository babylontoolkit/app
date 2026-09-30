/**
 * Unity Bridge pricing classes (D11). Prices themselves are config (`BRIDGE_*_CREDITS`); this module only
 * decides which class an operation falls in and multiplies.
 *
 * Spec: `_specs/unity-bridge-local-gltf_spec.md` B4/B6/B7.
 *
 * The Desktop Agent carries a CommonJS port of tiers/validate in `lib/bridge/policy.js` (D3) — change
 * both, and both test tables, together.
 */
import type { BridgeOperation } from './protocol';

export type BridgePriceClass = 'free' | 'command' | 'script' | 'job';

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

export interface BridgePrices {
  command: number;
  script: number;
  job: number;
}

export const DEFAULT_BRIDGE_PRICES: BridgePrices = { command: 1, script: 2, job: 4 };

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
    default:
      return false;
  }
}

export function priceClassOf(op: BridgeOperation): BridgePriceClass {
  if (op.kind === 'unity.list' || op.kind === 'devserver.status') {
    return 'free';
  }

  if (op.kind === 'unity.editor' && op.action === 'status') {
    return 'free';
  }

  /*
   * A long Blender script is priced as a job; checked before the script class so the timeout decides.
   */
  if (isLongOperation(op)) {
    return 'job';
  }

  if (op.kind === 'unity.script' || op.kind === 'blender.script') {
    return 'script';
  }

  return 'command';
}

/** free → 0. */
export function creditsFor(op: BridgeOperation, prices: BridgePrices): number {
  const priceClass = priceClassOf(op);

  if (priceClass === 'free') {
    return 0;
  }

  return prices[priceClass];
}
