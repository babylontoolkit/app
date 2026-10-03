/**
 * Plan mode and MCP on the managed engine (`dispatch.ts`, `_specs/managed-only_plan.md` D1, D4, D5).
 *
 * Plan mode's read-only guarantee is a SERVER wall here: the agent keeps its whole tool list, so the
 * dispatcher is the only thing between a "read-only" turn and a write, a command, a media debit or an MCP
 * call. Each refusal below must happen before anything is relayed or debited, and the `_specs/` door must
 * stay open — closing it is the silent failure where bt-plan reports a plan written that does not exist.
 *
 * MCP runs through the same §4.14 relay as the legacy loop, resolved by (server, tool) EXACTLY.
 */
import { describe, expect, it, vi } from 'vitest';
import { deliverClientToolResult, MCP_RELAY_TIMEOUT_MS } from '~/lib/.server/agent/mcp-relay';
import type { McpLiveTool, McpToolCallEvent } from '~/lib/.server/agent/mcp-tools';
import {
  newWorkspaceTurnState,
  PLAN_ONLY_REFUSAL,
  WorkspaceOverlay,
  type WorkspaceToolCallEvent,
} from '~/lib/.server/agent/workspace-tools';
import type { PreviewToolCallEvent } from '~/lib/.server/agent/preview-tools';
import type { FileMap } from '~/lib/.server/llm/constants';
import {
  createManagedDispatcher,
  describeMcpTools,
  MCP_RESULT_MAX_CHARS,
  MCP_SCHEMA_MAX_CHARS,
  PLAN_REFUSED_TOOLS,
  resolveMcpCall,
} from './dispatch';
import { MANAGED_CUSTOM_TOOL_NAMES } from './tools';

const USER = 'user-1';

const FILES: FileMap = {
  '/home/project/src/a.ts': { type: 'file', content: 'export const kart = 1;\n', isBinary: false },
  '/home/project/_specs/kart_plan.md': { type: 'file', content: '- [ ] T1 build the kart\n', isBinary: false },
} as unknown as FileMap;

const MCP: McpLiveTool[] = [
  { name: 'search', server: 'docs', description: 'Search the docs', inputSchema: { type: 'object' } },
  { name: 'read_file', server: 'fs', description: 'Read a file' },
  { name: 'read_file', server: 'git', description: 'Read a file at a revision' },
];

interface SetupOptions {
  planMode?: boolean;
  mcp?: McpLiveTool[] | null;
  abortSignal?: AbortSignal;

  /** How the browser answers an MCP call. Default: echoes the call back as its result. */
  mcpBrowser?: (event: McpToolCallEvent, generationId: string) => void;
}

function setup(options: SetupOptions = {}) {
  const generationId = `gen_pm_${Math.random().toString(36).slice(2)}`;
  const workspace: WorkspaceToolCallEvent[] = [];
  const preview: PreviewToolCallEvent[] = [];
  const mcpCalls: McpToolCallEvent[] = [];
  const mediaEmit = vi.fn();
  const overlay = new WorkspaceOverlay(FILES);

  const answer = (toolCallId: string, result: unknown, error?: string) =>
    queueMicrotask(() => deliverClientToolResult({ generationId, toolCallId, userId: USER, result, error }));

  const dispatcher = createManagedDispatcher({
    generationId,
    userId: USER,
    abortSignal: options.abortSignal,
    files: FILES,
    overlay,
    state: newWorkspaceTurnState(),
    planMode: options.planMode,
    emitWorkspace: (event) => {
      workspace.push(event);
      answer(event.toolCallId, { ok: true });
    },
    emitPreview: (event) => {
      preview.push(event);
      answer(event.toolCallId, event.method === 'errors' ? [] : 42);
    },
    emitTodos: () => undefined,

    /* A media context whose provider would throw if anything reached it — a Plan refusal must not. */
    media: {
      userId: USER,
      projectId: 'p1',
      provider: { name: 'KIE' },
      emit: mediaEmit,
    } as never,
    mcp:
      options.mcp === null
        ? null
        : {
            tools: options.mcp ?? MCP,
            emit: (event) => {
              mcpCalls.push(event);
              (options.mcpBrowser ?? ((e) => answer(e.toolCallId, { echoed: e.args })))(event, generationId);
            },
          },
  });

  return { dispatcher, workspace, preview, mcpCalls, mediaEmit, overlay, generationId, answer };
}

const call = (id: string, name: string, input: Record<string, unknown> = {}) => ({ id, name, input });

describe('Plan mode on the managed engine — the server wall (D1)', () => {
  it('refuses a write outside _specs/ with the legacy sentence, and relays nothing', async () => {
    const t = setup({ planMode: true });
    const result = await t.dispatcher.dispatch(call('w1', 'project_write', { path: 'src/b.ts', content: 'x' }));

    expect(result).toMatchObject({ isError: true, content: [{ text: PLAN_ONLY_REFUSAL }] });
    expect(t.workspace).toEqual([]);
    expect(t.overlay.read('src/b.ts')).toBeUndefined();
  });

  it('refuses an edit outside _specs/ — and a traversal dressed as _specs/', async () => {
    const t = setup({ planMode: true });

    for (const path of ['src/a.ts', '_specs/../src/a.ts']) {
      const result = await t.dispatcher.dispatch(
        call(`e-${path}`, 'project_edit', { path, old_string: 'kart = 1', new_string: 'kart = 2' }),
      );

      expect(result, path).toMatchObject({ isError: true, content: [{ text: PLAN_ONLY_REFUSAL }] });
    }

    expect(t.workspace).toEqual([]);
    expect(t.overlay.read('src/a.ts')).toBe('export const kart = 1;\n');
  });

  it('keeps the _specs/ door OPEN for a write and an edit (bt-spec / bt-plan land their files)', async () => {
    const t = setup({ planMode: true });

    const wrote = await t.dispatcher.dispatch(
      call('w2', 'project_write', { path: '_specs/kart_spec.md', content: '# Kart' }),
    );
    const edited = await t.dispatcher.dispatch(
      call('e2', 'project_edit', { path: '_specs/kart_plan.md', old_string: '- [ ] T1', new_string: '- [x] T1' }),
    );

    expect(wrote?.isError).toBe(false);
    expect(edited?.isError).toBe(false);
    expect(t.workspace.map((e) => [e.toolCallId, e.op, (e.params as { path: string }).path])).toEqual([
      ['w2', 'write', '_specs/kart_spec.md'],
      ['e2', 'write', '_specs/kart_plan.md'],
    ]);
    expect(t.overlay.read('_specs/kart_plan.md')).toContain('- [x] T1');
  });

  it('refuses every command, check, eval, media render and MCP call before anything runs or is debited', async () => {
    const t = setup({ planMode: true });

    for (const name of PLAN_REFUSED_TOOLS) {
      const result = await t.dispatcher.dispatch(
        call(`r-${name}`, name, {
          command: 'npm run build',
          expression: '1',
          prompt: 'a kart',
          server: 'docs',
          tool: 'search',
        }),
      );

      expect(result, name).toMatchObject({ isError: true });
      expect(result?.content[0], name).toMatchObject({ text: expect.stringMatching(/^Plan mode is read-only/) });
    }

    expect(t.workspace).toEqual([]);
    expect(t.preview).toEqual([]);
    expect(t.mcpCalls).toEqual([]);
    expect(t.mediaEmit).not.toHaveBeenCalled();
  });

  it('the refused set covers every tool that can change the project or spend (none slipped through)', () => {
    const allowedOnPlan = new Set([
      'project_list',
      'project_read',
      'project_grep',
      'project_write', // _specs/ only, checked per path
      'project_edit', // _specs/ only, checked per path
      'update_todos',
      'capture_game_screenshot',
      'get_game_errors',
      'get_game_console',
      'mcp_list_tools',
    ]);

    // Every managed tool is either explicitly allowed on a Plan turn or refused — a NEW tool must pick a side.
    for (const name of MANAGED_CUSTOM_TOOL_NAMES) {
      expect(allowedOnPlan.has(name) || PLAN_REFUSED_TOOLS.has(name), name).toBe(true);
    }
  });

  it('still answers reads, the checklist and the read-only preview tools', async () => {
    const t = setup({ planMode: true });

    expect((await t.dispatcher.dispatch(call('rd', 'project_read', { path: 'src/a.ts' })))?.isError).toBe(false);
    expect(
      (await t.dispatcher.dispatch(call('td', 'update_todos', { items: [{ content: 'plan', status: 'in_progress' }] })))
        ?.isError,
    ).toBe(false);
    expect((await t.dispatcher.dispatch(call('ge', 'get_game_errors')))?.isError).toBe(false);
    expect(t.preview.map((e) => e.method)).toEqual(['errors']);
  });

  it('CONTROL: a Build turn writes anywhere in the project and may run commands', async () => {
    const t = setup({ planMode: false });

    expect(
      (await t.dispatcher.dispatch(call('bw', 'project_write', { path: 'src/b.ts', content: 'x' })))?.isError,
    ).toBe(false);
    expect(
      (await t.dispatcher.dispatch(call('br', 'project_run', { command: 'npm install three' })))?.content[0],
    ).not.toMatchObject({
      text: expect.stringMatching(/^Plan mode/),
    });
    expect(t.workspace.map((e) => e.op)).toEqual(['write', 'run']);
  });
});

describe('MCP on the managed engine (D4, D5)', () => {
  it('mcp_list_tools answers from the live list, schema capped and the cut announced', () => {
    const big = { type: 'object', description: 'x'.repeat(MCP_SCHEMA_MAX_CHARS * 2) };
    const text = describeMcpTools([{ name: 'big', server: 's', inputSchema: big }]);

    expect(text).toContain('server "s", tool "big"');
    expect(text).toContain('(schema truncated)');
    expect(text.length).toBeLessThan(MCP_SCHEMA_MAX_CHARS + 500);
    expect(describeMcpTools([])).toMatch(/no MCP tools/);
  });

  it('resolves (server, tool) EXACTLY — a name on another server is named, never run', () => {
    expect(resolveMcpCall(MCP, { server: 'git', tool: 'read_file', arguments: { path: 'a' } })).toEqual({
      tool: MCP[2],
      args: { path: 'a' },
    });

    const wrongServer = resolveMcpCall(MCP, { server: 'docs', tool: 'read_file' });

    expect(wrongServer).toMatchObject({ refusal: expect.stringContaining('It exists on server "fs", "git"') });

    // A name alone is never enough, even when only one server has it.
    expect(resolveMcpCall(MCP, { tool: 'search' })).toMatchObject({ refusal: expect.stringContaining('"server"') });
  });

  it('mcp_call relays to the browser with the EVENT id and returns the sandbox server answer', async () => {
    const t = setup();
    const result = await t.dispatcher.dispatch(
      call('m1', 'mcp_call', { server: 'docs', tool: 'search', arguments: { q: 'kart' } }),
    );

    expect(t.mcpCalls).toEqual([{ toolCallId: 'm1', toolName: 'search', server: 'docs', args: { q: 'kart' } }]);
    expect(result).toMatchObject({ isError: false, content: [{ text: JSON.stringify({ echoed: { q: 'kart' } }) }] });
  });

  it('a sandbox error comes back as an error result the agent can react to', async () => {
    const t = setup({
      mcpBrowser: (e, gid) =>
        queueMicrotask(() =>
          deliverClientToolResult({ generationId: gid, toolCallId: e.toolCallId, userId: USER, error: 'ENOENT' }),
        ),
    });
    const result = await t.dispatcher.dispatch(call('m2', 'mcp_call', { server: 'fs', tool: 'read_file' }));

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'The MCP tool "read_file" could not run: ENOENT' }],
    });
  });

  it('a relay TIMEOUT is answered to the agent (D5) — unlike a workspace timeout, it does not detach', async () => {
    vi.useFakeTimers();

    try {
      const t = setup({ mcpBrowser: () => undefined });
      const pending = t.dispatcher.dispatch(call('m3', 'mcp_call', { server: 'docs', tool: 'search' }));

      await vi.advanceTimersByTimeAsync(MCP_RELAY_TIMEOUT_MS + 10);

      expect(await pending).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining('could not run: The tool did not respond in time.') }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a detached request answers NOTHING (the session waits for a reopened tab)', async () => {
    const controller = new AbortController();
    const t = setup({ abortSignal: controller.signal, mcpBrowser: () => controller.abort() });

    expect(await t.dispatcher.dispatch(call('m4', 'mcp_call', { server: 'docs', tool: 'search' }))).toBeNull();
  });

  it('caps a huge result and says so', async () => {
    const t = setup({
      mcpBrowser: (e, gid) =>
        queueMicrotask(() =>
          deliverClientToolResult({
            generationId: gid,
            toolCallId: e.toolCallId,
            userId: USER,
            result: 'y'.repeat(MCP_RESULT_MAX_CHARS + 5000),
          }),
        ),
    });
    const result = await t.dispatcher.dispatch(call('m5', 'mcp_call', { server: 'docs', tool: 'search' }));
    const text = (result?.content[0] as { text: string }).text;

    expect(text).toContain('(result truncated:');
    expect(text.length).toBeLessThan(MCP_RESULT_MAX_CHARS + 200);
  });

  it('with no MCP tools on the turn, mcp_call refuses and nothing is relayed', async () => {
    const t = setup({ mcp: null });
    const result = await t.dispatcher.dispatch(call('m6', 'mcp_call', { server: 'docs', tool: 'search' }));

    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('no MCP tools') }] });
    expect(t.mcpCalls).toEqual([]);
  });
});
