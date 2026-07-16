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

    expect(emitted).toEqual([{ toolCallId: 'call-1', toolName: 'echo', args: { text: 'hi' } }]);

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
});
