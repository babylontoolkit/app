/**
 * The MCP tool bridge — servers run in the USER's WebContainer (SPEC §4.14, §5).
 *
 * This is the piece that makes §4.14 architecturally different from upstream: MCP stdio servers are
 * spawned INSIDE the user's WebContainer (their sandbox, their compute, their `.env` keys), never on
 * platform infrastructure. Upstream spawns them on the server — the RCE closed by `server-guard.ts`.
 * Here, the process is the user's, the blast radius is the user's own tab, and the command allow-rule
 * (`isProjectTreeCommand`) keeps it inside the project tree even so.
 *
 * The transport is MCP over stdio: newline-delimited JSON-RPC 2.0. We write requests to the process's
 * stdin and read responses off its stdout, matching by id. `initialize` → `tools/list` → `tools/call`
 * is the whole surface we need; the generation loop calls `callTool` when the model uses an MCP tool
 * and relays the result back (the client-tool path — the server never executes these).
 *
 * Everything third-party here is UNTRUSTED (§4.14): tool descriptions and results are data to the
 * model, never instructions, and the file/shell action allow-lists still apply to whatever the model
 * does with them.
 */
import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { parseMcpConfig, type McpServerSpec } from './project-config';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('mcp-bridge');

const PROTOCOL_VERSION = '2024-11-05';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;

  /** Which server exposes it — for display and for routing a call back to the right process. */
  server: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** One launched stdio server: its process plus the JSON-RPC plumbing to talk to it. */
class McpServerConnection {
  private _nextId = 1;
  private readonly _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _buffer = '';
  private _writer?: WritableStreamDefaultWriter<string>;

  constructor(
    readonly spec: McpServerSpec,
    private readonly _process: WebContainerProcess,
  ) {}

  async start(): Promise<McpTool[]> {
    this._writer = this._process.input.getWriter();

    // Read stdout forever, dispatching complete JSON lines to pending requests.
    this._process.output
      .pipeTo(
        new WritableStream({
          write: (chunk) => this._onData(chunk),
        }),
      )
      .catch(() => undefined);

    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'babylon-toolkit-app-builder', version: '1.0.0' },
    });

    await this._notify('notifications/initialized');

    const listed = (await this._request('tools/list', {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    };

    return (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      server: this.spec.name,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this._request('tools/call', { name, arguments: args ?? {} });
  }

  async stop(): Promise<void> {
    try {
      await this._writer?.close();
    } catch {
      // already closing
    }

    this._process.kill();
  }

  private _onData(chunk: string): void {
    this._buffer += chunk;

    let newline: number;

    while ((newline = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, newline).trim();
      this._buffer = this._buffer.slice(newline + 1);

      if (!line) {
        continue;
      }

      let message: JsonRpcResponse;

      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Not a JSON-RPC line (server stderr noise, banners) — ignore.
        continue;
      }

      if (typeof message.id === 'number') {
        const pending = this._pending.get(message.id);

        if (pending) {
          this._pending.delete(message.id);

          if (message.error) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message.result);
          }
        }
      }
    }
  }

  private async _request(method: string, params: unknown): Promise<unknown> {
    const id = this._nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    const result = new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });

      // A stuck server must not hang the generation forever.
      setTimeout(() => {
        if (this._pending.delete(id)) {
          reject(new Error(`MCP request "${method}" to "${this.spec.name}" timed out`));
        }
      }, 30_000);
    });

    await this._writer?.write(payload);

    return result;
  }

  private async _notify(method: string): Promise<void> {
    await this._writer?.write(JSON.stringify({ jsonrpc: '2.0', method, params: {} }) + '\n');
  }
}

/**
 * The bridge for one project: launch every declared+allowed stdio server, aggregate their tools, and
 * route calls back to the owning server.
 */
export class McpBridge {
  private readonly _connections = new Map<string, McpServerConnection>();
  private _tools: McpTool[] = [];

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  get tools(): McpTool[] {
    return this._tools;
  }

  /**
   * Launch the servers a project's `.mcp.json` declares.
   *
   * Only stdio servers with a project-tree command are launched (the allow-rule already filtered the
   * parse). A server that fails to start is logged and skipped — one broken MCP server must not take
   * down the others or the generation.
   */
  static async launch(container: WebContainer, mcpJson: string | null): Promise<McpBridge> {
    const bridge = new McpBridge();
    const { servers } = parseMcpConfig(mcpJson);

    for (const spec of servers) {
      if (spec.transport !== 'stdio') {
        // sse / streamable-http are network transports; they need no local process. Not launched here.
        continue;
      }

      try {
        const process = await container.spawn(spec.command, spec.args, { env: {} });
        const connection = new McpServerConnection(spec, process);
        const tools = await connection.start();

        bridge._connections.set(spec.name, connection);
        bridge._tools.push(...tools);

        logger.info(`Launched MCP server "${spec.name}" (${tools.length} tools) in the WebContainer.`);
      } catch (error) {
        logger.warn(`MCP server "${spec.name}" failed to start: ${(error as Error).message}`);
      }
    }

    return bridge;
  }

  /**
   * Execute a tool call against the server that owns it. Result is UNTRUSTED input (§4.14).
   *
   * `server` disambiguates: tool names are unique per server, NOT across servers, so two servers can both
   * expose `read_file`. Matching on the name alone silently runs the call against whichever was launched
   * first — a different process, with different files and different credentials. The relay always names
   * the server the model's tool was built from; it is optional only for callers that predate it.
   */
  async callTool(toolName: string, args: unknown, server?: string): Promise<unknown> {
    const tool = server
      ? this._tools.find((t) => t.name === toolName && t.server === server)
      : this._tools.find((t) => t.name === toolName);

    if (!tool) {
      throw new Error(`Unknown MCP tool: ${toolName}${server ? ` on server "${server}"` : ''}`);
    }

    const connection = this._connections.get(tool.server);

    if (!connection) {
      throw new Error(`MCP server "${tool.server}" is not running.`);
    }

    return connection.callTool(toolName, args);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this._connections.values()].map((c) => c.stop()));
    this._connections.clear();
    this._tools = [];
  }
}
