/**
 * The WebContainer MCP bridge (SPEC §4.14).
 *
 * These drive `McpBridge` against FAKE stdio servers that speak real newline-delimited JSON-RPC, so the
 * transport is exercised for real: `initialize` → `tools/list` → `tools/call`, response framing, and —
 * the part that actually bit — which SERVER a call is routed to.
 *
 * Tool names are unique per server, NOT across servers. Two servers exposing `read_file` is ordinary
 * (a filesystem server and a docs server), and resolving a call by name alone runs it against whichever
 * launched first: a different process, different files, different credentials. Nothing throws; the model
 * just gets the wrong answer.
 */
import { describe, expect, it } from 'vitest';
import { McpBridge, UNITY_SERVER_NAME } from './webcontainer-bridge';

/** A stdio MCP server: JSON-RPC in on stdin, JSON-RPC out on stdout, one line per message. */
class FakeServer {
  readonly calls: Array<{ name: string; args: unknown }> = [];
  killed = false;

  private _controller!: ReadableStreamDefaultController<string>;

  readonly output = new ReadableStream<string>({
    start: (controller) => {
      this._controller = controller;
    },
  });

  readonly input = new WritableStream<string>({
    write: (chunk) => this._handle(chunk),
  });

  constructor(
    readonly name: string,
    private readonly _toolNames: string[],
  ) {}

  kill() {
    this.killed = true;
  }

  private _handle(chunk: string): void {
    for (const line of chunk.split('\n').filter((l) => l.trim())) {
      const message = JSON.parse(line) as { id?: number; method: string; params?: any };

      if (message.method === 'initialize') {
        this._reply(message.id!, { protocolVersion: '2024-11-05', capabilities: {} });
      } else if (message.method === 'tools/list') {
        this._reply(message.id!, {
          tools: this._toolNames.map((n) => ({
            name: n,
            description: `${n} on ${this.name}`,
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          })),
        });
      } else if (message.method === 'tools/call') {
        this.calls.push({ name: message.params.name, args: message.params.arguments });
        this._reply(message.id!, { servedBy: this.name });
      }
    }
  }

  private _reply(id: number, result: unknown): void {
    this._controller.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
}

function fakeContainer(servers: Record<string, FakeServer>) {
  return {
    spawn: async (command: string, args: string[]) => {
      const server = servers[args[0] ?? command];

      if (!server) {
        throw new Error(`no fake server for ${command} ${args.join(' ')}`);
      }

      return server;
    },
  } as any;
}

const config = (names: string[]) =>
  JSON.stringify({
    mcpServers: Object.fromEntries(names.map((n) => [n, { command: 'node', args: [n] }])),
  });

describe('McpBridge over stdio', () => {
  it('lists tools from every launched server, tagged with their owner', async () => {
    const servers = { fs: new FakeServer('fs', ['read_file']), docs: new FakeServer('docs', ['read_file', 'search']) };
    const bridge = await McpBridge.launch(fakeContainer(servers), config(['fs', 'docs']));

    expect(bridge.tools).toEqual([
      { name: 'read_file', description: 'read_file on fs', inputSchema: expect.any(Object), server: 'fs' },
      { name: 'read_file', description: 'read_file on docs', inputSchema: expect.any(Object), server: 'docs' },
      { name: 'search', description: 'search on docs', inputSchema: expect.any(Object), server: 'docs' },
    ]);
  });

  it('routes a call to the named server, not the first one with a matching tool name', async () => {
    const servers = { fs: new FakeServer('fs', ['read_file']), docs: new FakeServer('docs', ['read_file']) };
    const bridge = await McpBridge.launch(fakeContainer(servers), config(['fs', 'docs']));

    await expect(bridge.callTool('read_file', { path: 'a.md' }, 'docs')).resolves.toEqual({ servedBy: 'docs' });

    // The whole point: `fs` — which also has a `read_file` and was launched first — was never touched.
    expect(servers.docs.calls).toEqual([{ name: 'read_file', args: { path: 'a.md' } }]);
    expect(servers.fs.calls).toEqual([]);
  });

  it('refuses a call for a tool that server does not expose', async () => {
    const servers = { fs: new FakeServer('fs', ['read_file']) };
    const bridge = await McpBridge.launch(fakeContainer(servers), config(['fs']));

    await expect(bridge.callTool('read_file', {}, 'docs')).rejects.toThrow(/Unknown MCP tool/);
  });

  it('skips a server that fails to start without taking the others down', async () => {
    const servers = { docs: new FakeServer('docs', ['search']) };

    // `broken` has no fake process, so `spawn` throws — the bridge must still bring `docs` up.
    const bridge = await McpBridge.launch(fakeContainer(servers), config(['broken', 'docs']));

    expect(bridge.tools.map((t) => t.server)).toEqual(['docs']);
  });

  it('never launches a server whose command escapes the project tree (§4.14)', async () => {
    const servers = { evil: new FakeServer('evil', ['pwn']) };
    const bridge = await McpBridge.launch(
      fakeContainer(servers),
      JSON.stringify({ mcpServers: { evil: { command: '/usr/bin/curl', args: ['evil'] } } }),
    );

    expect(bridge.tools).toEqual([]);
  });

  it(`refuses a .mcp.json server named "${UNITY_SERVER_NAME}" (reserved, §4.17) while a sibling still launches`, async () => {
    // Record every spawn so we can prove the reserved server never reached the container at all.
    const servers = { unity: new FakeServer('unity', ['pwn']), docs: new FakeServer('docs', ['search']) };
    const spawned: string[] = [];
    const container = {
      spawn: async (command: string, args: string[]) => {
        spawned.push(args[0] ?? command);

        const server = servers[(args[0] ?? command) as keyof typeof servers];

        if (!server) {
          throw new Error(`no fake server for ${command} ${args.join(' ')}`);
        }

        return server;
      },
    } as any;

    const bridge = await McpBridge.launch(container, config([UNITY_SERVER_NAME, 'docs']));

    // The reserved name is skipped BEFORE the transport/spawn check — no process, no tools, no calls.
    expect(spawned).toEqual(['docs']);
    expect(servers.unity.calls).toEqual([]);
    expect(bridge.tools.map((t) => t.server)).toEqual(['docs']);
    expect(bridge.tools.some((t) => t.server === UNITY_SERVER_NAME)).toBe(false);
  });

  it('kills every process on teardown', async () => {
    const servers = { fs: new FakeServer('fs', ['read_file']) };
    const bridge = await McpBridge.launch(fakeContainer(servers), config(['fs']));

    await bridge.stopAll();

    expect(servers.fs.killed).toBe(true);
    expect(bridge.tools).toEqual([]);
  });
});
