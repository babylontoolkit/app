/**
 * The managed agent's custom tool DEFINITIONS (`_specs/managed-agents-engine_plan.md` D3, T3).
 *
 * Two properties carry this file. (1) The argument names are the legacy executes' names — the T5
 * dispatcher passes `input` straight through, and a renamed argument reaches an execute that never reads
 * it (an empty write, not an error). So the managed schemas are compared against the REAL legacy zod
 * shapes, built by the real factories, rather than against a list re-typed here. (2) The array is hashed
 * for provisioning, so its serialization must be stable.
 */
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { createWorkspaceTools } from '~/lib/.server/agent/workspace-tools';
import { createPreviewTools } from '~/lib/.server/agent/preview-tools';
import { createMediaTools } from '~/lib/.server/agent/media-tools';
import { createFileTools } from '~/lib/.server/agent/file-tools';
import { MANAGED_BUILTIN_TOOLSET, MANAGED_CUSTOM_TOOLS, MANAGED_CUSTOM_TOOL_NAMES } from './tools';

const FIXED_NAMES = [
  'project_list',
  'project_read',
  'project_write',
  'project_edit',
  'project_grep',
  'project_run',
  'check_game',
  'update_todos',
  'evaluate_in_game',
  'capture_game_screenshot',
  'get_game_errors',
  'get_game_console',
  'generate_image',
  'generate_video',
  'generate_sound',
  'mcp_list_tools',
  'mcp_call',
];

function props(name: string): Record<string, unknown> {
  const def = MANAGED_CUSTOM_TOOLS.find((t) => t.name === name);

  if (!def) {
    throw new Error(`no managed tool ${name}`);
  }

  return (def.input_schema.properties ?? {}) as Record<string, unknown>;
}

function legacyKeys(tools: Record<string, unknown>, name: string): string[] {
  const t = tools[name] as { parameters: z.ZodObject<z.ZodRawShape> } | undefined;

  if (!t) {
    throw new Error(`no legacy tool ${name}`);
  }

  return Object.keys(t.parameters.shape);
}

describe('managed custom tools', () => {
  it('are exactly the fixed names, in a fixed order', () => {
    expect([...MANAGED_CUSTOM_TOOL_NAMES]).toEqual(FIXED_NAMES);
    expect(MANAGED_CUSTOM_TOOLS.map((t) => t.name)).toEqual(FIXED_NAMES);
  });

  it('are all custom tools with an object schema whose required args exist', () => {
    for (const def of MANAGED_CUSTOM_TOOLS) {
      expect(def.type).toBe('custom');
      expect(def.input_schema.type).toBe('object');
      expect(def.description.length).toBeGreaterThan(20);

      for (const req of def.input_schema.required ?? []) {
        expect(Object.keys(def.input_schema.properties ?? {})).toContain(req);
      }
    }
  });

  it('serialize identically across a fresh module load (the array is hashed)', async () => {
    const first = JSON.stringify(MANAGED_CUSTOM_TOOLS);
    vi.resetModules();

    const again = await import('./tools');

    expect(JSON.stringify(again.MANAGED_CUSTOM_TOOLS)).toBe(first);
    expect(Object.isFrozen(MANAGED_CUSTOM_TOOLS)).toBe(true);
  });

  it('carry the legacy argument names the dispatcher will pass through', () => {
    expect(Object.keys(props('project_write'))).toEqual(['path', 'content']);
    expect(Object.keys(props('project_edit'))).toEqual(['path', 'old_string', 'new_string', 'replace_all']);
    expect(Object.keys(props('project_run'))).toEqual(['command']);
    expect(Object.keys(props('update_todos'))).toEqual(['items']);
    expect(Object.keys(props('evaluate_in_game'))).toEqual(['expression']);
    expect(Object.keys(props('project_read'))).toContain('path');
  });

  it('every managed argument is accepted by the real legacy execute it maps to', () => {
    const workspace = createWorkspaceTools({ overlay: {}, state: {} } as never);
    const preview = createPreviewTools({} as never);
    const media = createMediaTools({ provider: { name: 'KIE' } } as never);
    const files = createFileTools({} as never) as Record<string, unknown>;

    const mapping: Array<[string, Record<string, unknown>, string, string[]]> = [
      // [managed, legacy factory output, legacy name, managed-only args the dispatcher handles itself]
      ['project_write', workspace, 'write_file', []],
      ['project_edit', workspace, 'edit_file', []],
      ['project_run', workspace, 'run_command', []],
      ['check_game', workspace, 'check_game', []],
      ['update_todos', workspace, 'update_todos', []],
      ['project_read', files, 'read_file', ['offset', 'limit']],
      ['evaluate_in_game', preview, 'evaluate_in_game', []],
      ['capture_game_screenshot', preview, 'capture_game_screenshot', []],
      ['get_game_errors', preview, 'get_game_errors', []],
      ['get_game_console', preview, 'get_game_console', []],
      ['generate_image', media, 'generate_image', []],
      ['generate_video', media, 'generate_video', []],
      ['generate_sound', media, 'generate_sound', []],
    ];

    for (const [managed, factory, legacy, extras] of mapping) {
      const accepted = legacyKeys(factory, legacy);

      for (const arg of Object.keys(props(managed))) {
        if (extras.includes(arg)) {
          continue;
        }

        expect(accepted, `${managed}.${arg} → ${legacy}`).toContain(arg);
      }
    }

    // CONTROL: the comparison can fail — a name the legacy write_file does not read is rejected.
    expect(legacyKeys(workspace, 'write_file')).not.toContain('text');
  });

  it('give MCP two constant tools whose call names the server AND the tool (never a name alone)', () => {
    expect(Object.keys(props('mcp_list_tools'))).toEqual([]);
    expect(Object.keys(props('mcp_call'))).toEqual(['server', 'tool', 'arguments']);
    expect(MANAGED_CUSTOM_TOOLS.find((t) => t.name === 'mcp_call')?.input_schema.required).toEqual(['server', 'tool']);
  });

  it('leave only read/glob/grep enabled in the built-in toolset', () => {
    expect(MANAGED_BUILTIN_TOOLSET.default_config).toEqual({ enabled: false });
    expect(MANAGED_BUILTIN_TOOLSET.configs.map((c) => c.name)).toEqual(['read', 'glob', 'grep']);
    expect(MANAGED_BUILTIN_TOOLSET.configs.every((c) => c.enabled)).toBe(true);
  });
});
