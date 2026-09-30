import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_PROTOCOL_ARTIFACT, WORKSPACE_PROTOCOL_TOOLS, workspaceProtocolFor } from './workspace-protocol';

/*
 * The Workspace Protocol (tool-loop plan D17, T7): HOW the model changes the project lives in code, one
 * system block right after the base prompt, and neither variant may carry partial-delivery priming.
 */

const PRIMING = [/one prompt from done/i, /Be concise in prose/i, /hard length limit/i, /another pass/i];

describe('WORKSPACE_PROTOCOL_TOOLS', () => {
  it.each(['read_file', 'write_file', 'edit_file', 'run_command', 'check_game', 'update_todos'])('names %s', (tool) => {
    expect(WORKSPACE_PROTOCOL_TOOLS).toContain(`\`${tool}\``);
  });

  it('states that it supersedes any instruction to emit artifact markup', () => {
    expect(WORKSPACE_PROTOCOL_TOOLS).toMatch(/supersedes any instruction/);
  });

  it('asks for one short sentence of narration before each group of tool calls (D20)', () => {
    expect(WORKSPACE_PROTOCOL_TOOLS).toMatch(/Before each group of tool calls, write ONE short sentence/);
  });

  it('makes the todo checklist unmissable: update_todos BEFORE the first write on a multi-file change, then ticked (D20b)', () => {
    expect(WORKSPACE_PROTOCOL_TOOLS).toMatch(
      /1\. Plan: on any change that touches more than one file, call `update_todos` with your list BEFORE your first write_file\/edit_file/,
    );
    expect(WORKSPACE_PROTOCOL_TOOLS).toMatch(/`in_progress`.*`completed`/s);
  });

  it('offers only allow-listed commands (npm uninstall is not one)', () => {
    expect(WORKSPACE_PROTOCOL_TOOLS).not.toMatch(/npm uninstall/);
    expect(WORKSPACE_PROTOCOL_TOOLS).toContain('`npm install <pkg>`, `npm run <script>`');
  });

  it('never tells the model it may leave work for later — except to forbid it', () => {
    expect(WORKSPACE_PROTOCOL_TOOLS).not.toMatch(/one prompt from done|Be concise in prose|hard length limit/i);
    expect(WORKSPACE_PROTOCOL_TOOLS).toMatch(/Never say you "need another pass"/);
  });
});

describe('WORKSPACE_PROTOCOL_ARTIFACT', () => {
  it('still documents the <boltArtifact> protocol (kill switch, D16)', () => {
    expect(WORKSPACE_PROTOCOL_ARTIFACT).toContain('<boltArtifact');
    expect(WORKSPACE_PROTOCOL_ARTIFACT).toContain('type="edit"');
    expect(WORKSPACE_PROTOCOL_ARTIFACT).toContain('## Rules');
  });

  it('drops the old rule 12 and ends at rule 11', () => {
    for (const pattern of PRIMING) {
      expect(WORKSPACE_PROTOCOL_ARTIFACT).not.toMatch(pattern);
    }

    expect(WORKSPACE_PROTOCOL_ARTIFACT).toMatch(/\n11\. /);
    expect(WORKSPACE_PROTOCOL_ARTIFACT).not.toMatch(/\n12\. /);
  });
});

describe('workspaceProtocolFor', () => {
  it('picks the variant by the tool-loop switch', () => {
    expect(workspaceProtocolFor(true)).toBe(WORKSPACE_PROTOCOL_TOOLS);
    expect(workspaceProtocolFor(false)).toBe(WORKSPACE_PROTOCOL_ARTIFACT);
  });
});

describe('baked sections carry no partial-delivery priming', () => {
  it('20-hard-constraints.md has no "one prompt from done" and no "hard length limit"', () => {
    const text = readFileSync('app/lib/.server/prompt/sections/20-hard-constraints.md', 'utf8');

    expect(text).not.toMatch(/one prompt from done/i);
    expect(text).not.toMatch(/hard length limit/i);
    expect(text).toMatch(/## BUILD ORDER — design, then the game, then the front end/);
  });

  it('10-action-protocol.md is a pointer to the protocol block', () => {
    const text = readFileSync('app/lib/.server/prompt/sections/10-action-protocol.md', 'utf8');

    expect(text).toMatch(/^# How You Change Files/);
    expect(text).toMatch(/Workspace Protocol block/);
    expect(text).not.toContain('<boltArtifact');
  });
});

describe('proxy wiring', () => {
  /*
   * 🔴 The protocol block must carry NO `providerOptions`: 3 system breakpoints + 1 fetch-level tail is
   * the whole four-breakpoint budget (cache-breakpoints.spec.ts). Read out of proxy.ts, never re-typed.
   */
  const source = readFileSync('app/lib/.server/agent/proxy.ts', 'utf8');
  const push = source.match(/system\.push\(\{[^}]*workspaceProtocolFor\(toolLoop\)[^}]*\}\)/);

  it('pushes the protocol block, chosen by the tool-loop switch', () => {
    expect(push, 'proxy.ts must push workspaceProtocolFor(toolLoop) as a system block').not.toBeNull();
  });

  it('pushes it with no providerOptions (no cache breakpoint of its own)', () => {
    expect(push![0]).not.toMatch(/providerOptions/);
  });

  it('pushes it right after the base system block', () => {
    const baseAt = source.search(
      /const system: CoreMessage\[\] = \[\{ role: 'system', content: promptVersion\.content/,
    );
    const firstPushAfterBase = source.indexOf('system.push(', baseAt);

    expect(baseAt).toBeGreaterThan(-1);
    expect(firstPushAfterBase).toBe(source.indexOf(push![0]));
  });
});
