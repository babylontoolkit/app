import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpRelayTools, type McpToolCallEvent } from './mcp-tools';
import { deliverClientToolResult, type AwaitToolResultInput } from './mcp-relay';

/*
 * The relay stays REAL — every test below (and the six above) depends on `execute` actually blocking on
 * the registry and resolving when a result is delivered. We only wrap `awaitClientToolResult` so its
 * input is observable: `timeoutMs` is decided in `mcp-tools.ts` but consumed in `mcp-relay.ts`, so the
 * hand-off between them is the only place the per-server window can be pinned.
 */
const relayCalls = vi.hoisted(() => [] as AwaitToolResultInput[]);

vi.mock('./mcp-relay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcp-relay')>();

  return {
    ...actual,
    awaitClientToolResult: (input: AwaitToolResultInput) => {
      relayCalls.push(input);
      return actual.awaitClientToolResult(input);
    },
  };
});

beforeEach(() => {
  relayCalls.length = 0;
});

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

  /*
   * EVERY server gets the relay default — there is no per-server timeout special case any more.
   *
   * There used to be one: the Unity Editor bridge (§4.17, removed 2026-08-30) was given a 180s window
   * because a script edit triggers a domain reload and an asset import chews through a model. Asserted
   * as an ABSENCE because a per-server window is exactly the kind of thing that gets reintroduced for
   * one slow server and then silently applies to none of the others — and because a hardcoded
   * `timeoutMs` here would be a second writer of a number that lives in `mcp-relay.ts`.
   */
  describe('relay timeout window', () => {
    async function runOnce(tools: Record<string, unknown>, key: string, generationId: string, toolCallId: string) {
      const execPromise = (tools[key] as any).execute({}, { toolCallId, messages: [] });
      await Promise.resolve();

      // Settle it — an unresolved timer would outlive the test.
      deliverClientToolResult({ generationId, toolCallId, userId: 'u1', result: 'ok' });
      await execPromise;
    }

    it('leaves every server on the relay default, whatever it is named', async () => {
      const tools = createMcpRelayTools(
        [
          { name: 'read_file', server: 'docs' },
          { name: 'refresh_assets', server: 'unity' },
        ],
        { generationId: 'gen-mixed', userId: 'u1', emit: () => undefined },
      );

      await runOnce(tools, 'read_file', 'gen-mixed', 'call-m1');
      await runOnce(tools, 'refresh_assets', 'gen-mixed', 'call-m2');

      /*
       * `undefined`, not a copy of `MCP_RELAY_TIMEOUT_MS`: the default lives in `mcp-relay.ts` and
       * re-stating it here would be a second writer of the same number. `unity` is included precisely
       * because it used to be special — it is now an ordinary server name with no meaning at all.
       */
      expect(relayCalls.map((c) => [c.toolCallId, c.timeoutMs])).toEqual([
        ['call-m1', undefined],
        ['call-m2', undefined],
      ]);
    });
  });
});
