import { describe, expect, it } from 'vitest';
import { createMcpRelayTools, type McpToolCallEvent } from './mcp-tools';
import { deliverClientToolResult } from './mcp-relay';

/**
 * These tests drive an MCP relay tool the way `streamText` would: call its `execute`, observe that it
 * EMITS the call to the client (rather than running anything server-side, §5), then deliver a result
 * through the relay and confirm `execute` resolves with it. This is the seam that lets the model call a
 * sandbox tool inside one generation.
 */
describe('createMcpRelayTools', () => {
  it('builds one tool per live tool, with sandbox-safe keys', () => {
    const tools = createMcpRelayTools(
      [
        { name: 'search-web', description: 'search', server: 's1' },
        { name: 'weird name!', description: '', server: 's2' },
      ],
      { generationId: 'g1', userId: 'u1', emit: () => undefined },
    );

    expect(Object.keys(tools)).toEqual(['search-web', 'weird_name_']);
  });

  it('emits the tool-call to the client and resolves with the delivered result', async () => {
    const emitted: McpToolCallEvent[] = [];
    const tools = createMcpRelayTools([{ name: 'echo', description: 'echoes', server: 's1' }], {
      generationId: 'gen-x',
      userId: 'u1',
      emit: (e) => emitted.push(e),
    });

    // Kick off execute the way the AI SDK would — do not await yet.
    const execPromise = (tools.echo as any).execute({ text: 'hi' }, { toolCallId: 'call-1', messages: [] });

    // Give the microtask that emits a chance to run.
    await Promise.resolve();

    expect(emitted).toEqual([{ toolCallId: 'call-1', toolName: 'echo', server: 's1', args: { text: 'hi' } }]);

    // The client runs it in its sandbox and posts the result back.
    const delivered = deliverClientToolResult({
      generationId: 'gen-x',
      toolCallId: 'call-1',
      userId: 'u1',
      result: { echoed: 'hi' },
    });
    expect(delivered).toBe(true);

    await expect(execPromise).resolves.toEqual({ echoed: 'hi' });
  });

  it('returns a friendly tool_result string when the client reports an error', async () => {
    const tools = createMcpRelayTools([{ name: 'boom', server: 's1' }], {
      generationId: 'gen-y',
      userId: 'u1',
      emit: () => undefined,
    });

    const execPromise = (tools.boom as any).execute({}, { toolCallId: 'call-2', messages: [] });
    await Promise.resolve();

    deliverClientToolResult({ generationId: 'gen-y', toolCallId: 'call-2', userId: 'u1', error: 'no server running' });

    await expect(execPromise).resolves.toBe('The MCP tool "boom" could not run: no server running');
  });

  /*
   * The tool set is a Record. A duplicate key does not error — it overwrites, and the model is simply
   * never told the shadowed tool exists. Two servers exposing `read_file` is the ordinary case, not an
   * exotic one, so every declared tool must survive with its OWN identity.
   */
  it('keeps every tool reachable when names collide across servers', () => {
    const tools = createMcpRelayTools(
      [
        { name: 'read_file', server: 'fs' },
        { name: 'read_file', server: 'docs' },
        { name: 'read file', server: 'other' },
      ],
      { generationId: 'g1', userId: 'u1', emit: () => undefined },
    );

    expect(Object.keys(tools)).toHaveLength(3);
    expect(Object.keys(tools)).toEqual(['read_file', 'docs_read_file', 'other_read_file']);
  });

  it('routes a colliding tool-call to the server that owns it, under its real name', async () => {
    const emitted: McpToolCallEvent[] = [];
    const tools = createMcpRelayTools(
      [
        { name: 'read_file', server: 'fs' },
        { name: 'read_file', server: 'docs' },
      ],
      { generationId: 'gen-dup', userId: 'u1', emit: (e) => emitted.push(e) },
    );

    void (tools.docs_read_file as any).execute({ path: 'a.md' }, { toolCallId: 'call-3', messages: [] });
    await Promise.resolve();

    // The client must be told "docs", not "fs" — and the tool's REAL name, not our mangled key.
    expect(emitted).toEqual([{ toolCallId: 'call-3', toolName: 'read_file', server: 'docs', args: { path: 'a.md' } }]);

    deliverClientToolResult({ generationId: 'gen-dup', toolCallId: 'call-3', userId: 'u1', result: 'ok' });
  });

  it("shows the model each tool's input schema, capped", () => {
    const tools = createMcpRelayTools(
      [
        { name: 'sized', server: 's1', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'huge', server: 's1', inputSchema: { type: 'object', blob: 'x'.repeat(50_000) } },
      ],
      { generationId: 'g1', userId: 'u1', emit: () => undefined },
    );

    expect((tools.sized as any).description).toContain('"properties":{"path":{"type":"string"}}');

    // A third-party server must not be able to spend our context budget without limit (§4.2.8, §4.14).
    expect((tools.huge as any).description.length).toBeLessThan(2000);
  });
});
