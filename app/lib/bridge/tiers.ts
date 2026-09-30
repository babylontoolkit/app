/**
 * Unity Bridge tier classifier — decides `allowed | scripts | consent | refused` for an operation (D14).
 *
 * Spec: `_specs/unity-bridge-local-gltf_spec.md` B4/B6/B7.
 *
 * The Desktop Agent carries a CommonJS port of tiers/validate in `lib/bridge/policy.js` (D3) — change
 * both, and both test tables, together.
 *
 * Anything unknown is `consent` — the default-deny direction.
 */
import type { BridgeOperation } from './protocol';

export type BridgeTier = 'allowed' | 'scripts' | 'consent' | 'refused';

export interface TierDecision {
  tier: BridgeTier;
  reason?: string;
}

export const SCRIPT_COMMANDS = new Set(['run_script', 'eval', 'eval_file']);
export const CONSENT_COMMANDS = new Set([
  'set_import_settings',
  'delete_gameobject',
  'delete_asset',
  'move_asset',
  'rename_asset',
  'package_remove',
  'package_resolve',
  'set_player_settings',
  'set_quality_settings',
  'set_physics_settings',
  'set_tags_layers',
  'set_lighting_settings',
  'set_navmesh_settings',
  'set_build_settings',
  'build_player',
]);
export const CONSENT_COMMAND_PATTERN = /^(delete|remove|move|rename|clear|reset|uninstall)_/;
export const ALLOWED_COMMAND_PATTERN =
  /^(get|find|list|search|create|add|set|instantiate|open|save|import|bake|capture|screenshot|console|editor|package_add|package_status|wait_for|recompile|run_tests|bt_|select|apply|assign|attach|duplicate|load|play|stop|pause|refresh|describe|inspect)/;

export const REFUSED_CLI: Record<string, string> = {
  command: 'use the unity_command tool',
  cmd: 'use the unity_command tool',
  open: 'use the unity_editor tool',
  close: 'use the unity_editor tool',
  run: 'not available through the Unity Bridge',
  shell: 'not available through the Unity Bridge',
  mcp: 'not available through the Unity Bridge',
  skill: 'not available through the Unity Bridge',
  job: 'use the bridge_job tool',
};

/** first arg → allowed second args ('*' = any). */
export const ALLOWED_CLI: Record<string, string[] | '*'> = {
  status: '*',
  logs: '*',
  recompile: '*',
  test: '*',
  templates: '*',
  releases: '*',
  doctor: '*',
  docs: '*',
  list: '*',
  editors: ['list', 'path', 'running'],
  projects: ['info', 'verify'],
  vcs: ['diff', 'blame', 'status'],
  assets: ['export'],
  pipeline: ['list', 'list-versions', 'status'],
};

export const CONSENT_CLI = new Set([
  'license',
  'auth',
  'install',
  'uninstall',
  'install-modules',
  'self-update',
  'build',
  'projects',
  'vcs',
  'assets',
  'pipeline',
]); // reached only when not ALLOWED above

const RANK: Record<'allowed' | 'scripts' | 'consent', number> = { allowed: 0, scripts: 1, consent: 2 };

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function classifyCommandName(name: string): TierDecision {
  if (SCRIPT_COMMANDS.has(name)) {
    return { tier: 'scripts' };
  }

  if (CONSENT_COMMANDS.has(name) || CONSENT_COMMAND_PATTERN.test(name)) {
    return { tier: 'consent' };
  }

  if (ALLOWED_COMMAND_PATTERN.test(name)) {
    return { tier: 'allowed' };
  }

  return { tier: 'consent', reason: 'unrecognised command — asking first' };
}

function classifyCommand(name: string, params: Record<string, unknown> | undefined): TierDecision {
  if (name === 'batch') {
    const commands = params?.commands;

    if (!Array.isArray(commands)) {
      return { tier: 'consent', reason: 'a batch without a commands list — asking first' };
    }

    let highest: TierDecision = { tier: 'allowed' };

    for (const entry of commands) {
      const innerName = entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined;

      if (typeof innerName !== 'string') {
        return { tier: 'consent', reason: 'a batch entry without a command name — asking first' };
      }

      // A nested batch is never unwrapped: it is classified by its name alone (unrecognised → consent).
      const inner = innerName === 'batch' ? { tier: 'consent' as const } : classifyCommandName(innerName);
      const innerRank = RANK[inner.tier as keyof typeof RANK];

      if (innerRank > RANK[highest.tier as keyof typeof RANK]) {
        highest = inner;
      }
    }

    return highest;
  }

  return classifyCommandName(name);
}

function classifyCli(args: string[]): TierDecision {
  if (!Array.isArray(args) || args.length === 0) {
    return { tier: 'refused', reason: 'an empty Unity CLI command' };
  }

  const [first, second] = args;

  if (hasOwn(REFUSED_CLI, first)) {
    return { tier: 'refused', reason: REFUSED_CLI[first] };
  }

  if (hasOwn(ALLOWED_CLI, first)) {
    const allowed = ALLOWED_CLI[first];

    if (allowed === '*' || (typeof second === 'string' && allowed.includes(second))) {
      return { tier: 'allowed' };
    }
  }

  if (CONSENT_CLI.has(first)) {
    return { tier: 'consent' };
  }

  return { tier: 'consent' };
}

export function classifyOperation(op: BridgeOperation): TierDecision {
  switch (op.kind) {
    case 'unity.command':
      return classifyCommand(op.name, op.params);
    case 'unity.cli':
      return classifyCli(op.args);
    case 'unity.script':
    case 'blender.script':
      return { tier: 'scripts' };
    case 'unity.list':
    case 'unity.capture':
    case 'unity.editor':
    case 'devserver.start':
    case 'devserver.status':
      return { tier: 'allowed' };
    default:
      return { tier: 'consent', reason: 'unrecognised operation — asking first' };
  }
}
