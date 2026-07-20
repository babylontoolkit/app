/**
 * Minimal streamable-HTTP MCP client — the BROWSER half of the Unity Editor bridge (SPEC §4.17).
 *
 * This is the network sibling of `webcontainer-bridge.ts`'s stdio connection: same three-call MCP
 * surface (`initialize` → `notifications/initialized` → `tools/list`, then `tools/call` on demand),
 * but spoken over fetch to a LOOPBACK URL — the companion proxy in front of the user's local Unity
 * MCP server. It runs in the browser only; the platform server can never make this connection
 * (`~/lib/.server/net/ssrf.ts` refuses private addresses by design).
 *
 * Deliberately hand-rolled rather than the MCP SDK transport: the SDK's client is only referenced by
 * the dead upstream server-side path (`mcpService.ts`, fail-closed behind `server-guard.ts`), and it
 * drags in resumption/auth machinery we don't need. What we need is exactly: JSON-RPC over POST, the
 * `Mcp-Session-Id` header captured from `initialize` and echoed on every later request, a Bearer
 * pairing token, and tolerance for servers that frame a POST response as a single-message SSE body
 * instead of plain JSON. Everything the server returns is UNTRUSTED data (§4.14).
 */
import type { McpTool } from './webcontainer-bridge';

const PROTOCOL_VERSION = '2024-11-05';

/** Handshake and list calls are quick; a hung companion must not wedge the connect dialog. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Tool calls drive real editor work (script compiles, asset imports) — match the relay's ceiling. */
const CALL_TIMEOUT_MS = 180_000;

export interface RemoteMcpClientOptions {
  /** Loopback endpoint, e.g. `http://127.0.0.1:8080/mcp`. The caller validates loopback-ness. */
  url: string;

  /** Pairing token printed by the companion. Sent as `Authorization: Bearer …`, never in the URL. */
  token?: string;

  /** The `server` label stamped onto discovered tools (routing key downstream). */
  server: string;

  /** Injected for tests; defaults to the global fetch bound to the window. */
  fetchImpl?: typeof fetch;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export class RemoteMcpClient {
  private readonly _fetch: typeof fetch;
  private _sessionId?: string;
  private _nextId = 1;

  constructor(private readonly _options: RemoteMcpClientOptions) {
    this._fetch = _options.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** `initialize` → capture `Mcp-Session-Id` → `notifications/initialized`. Must run before the rest. */
  async initialize(): Promise<void> {
    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'babylon-toolkit-app-builder', version: '1.0.0' },
    });

    await this._notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const listed = (await this._request('tools/list', {})) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    };

    return (listed?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      server: this._options.server,
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this._request('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
  }

  /** Best-effort session termination (streamable-HTTP DELETE). Never throws — closing is not a failure. */
  async close(): Promise<void> {
    if (!this._sessionId) {
      return;
    }

    try {
      await this._fetch(this._options.url, { method: 'DELETE', headers: this._headers() });
    } catch {
      // The companion may already be gone; there is nothing to recover.
    }

    this._sessionId = undefined;
  }

  private _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    if (this._options.token) {
      headers.authorization = `Bearer ${this._options.token}`;
    }

    if (this._sessionId) {
      headers['mcp-session-id'] = this._sessionId;
    }

    return headers;
  }

  private async _request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = this._nextId++;
    const response = await this._post({ jsonrpc: '2.0', id, method, params }, timeoutMs);

    // The session id is minted on `initialize`; capture it whenever the server sends one.
    const sessionId = response.headers.get('mcp-session-id');

    if (sessionId) {
      this._sessionId = sessionId;
    }

    if (!response.ok) {
      throw new Error(`MCP endpoint returned HTTP ${response.status} for "${method}"`);
    }

    const message = await this._parseBody(response, id);

    if (!message) {
      throw new Error(`MCP endpoint returned no response for "${method}"`);
    }

    if (message.error) {
      throw new Error(message.error.message || `MCP "${method}" failed`);
    }

    return message.result;
  }

  private async _notify(method: string): Promise<void> {
    // Notifications have no id and expect no body (202 Accepted is the usual reply).
    const response = await this._post({ jsonrpc: '2.0', method, params: {} }, REQUEST_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error(`MCP endpoint returned HTTP ${response.status} for "${method}"`);
    }
  }

  private async _post(body: JsonRpcMessage | Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await this._fetch(this._options.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A streamable-HTTP server may answer a POST as `application/json` OR as a `text/event-stream`
   * body carrying the response message as SSE `data:` lines. Both decode to the same JSON-RPC
   * message; prefer the one whose id matches ours.
   */
  private async _parseBody(response: Response, id: number): Promise<JsonRpcMessage | undefined> {
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (!text.trim()) {
      return undefined;
    }

    if (!contentType.includes('text/event-stream')) {
      try {
        return JSON.parse(text) as JsonRpcMessage;
      } catch {
        throw new Error('MCP endpoint returned a non-JSON response body');
      }
    }

    const messages: JsonRpcMessage[] = [];

    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');

      if (!data) {
        continue;
      }

      try {
        messages.push(JSON.parse(data) as JsonRpcMessage);
      } catch {
        // Non-JSON SSE noise (comments, keep-alives) — ignore.
      }
    }

    return messages.find((m) => m.id === id) ?? messages[0];
  }
}
