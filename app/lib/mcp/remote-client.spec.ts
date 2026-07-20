/**
 * The remote (streamable-HTTP) MCP client — the BROWSER half of the Unity Editor bridge.
 *
 * These drive `RemoteMcpClient` against a FAKE fetch that records every `(url, init)` and returns
 * scripted `Response`s, so the wire contract is exercised for real: the handshake order, the
 * `Mcp-Session-Id` capture/echo, the Bearer pairing token, and SSE-framed response bodies.
 *
 * Why this matters: this client talks to the user's local companion proxy, and every defect here is
 * SILENT at the platform level — a missing session header makes the server treat each request as a
 * new session (tools/list "works" once and never again), a dropped Bearer token turns into a 401 the
 * user reads as "Unity won't connect", and an unparsed SSE frame kills every Unity generation with a
 * body that was a perfectly valid response. None of that throws anywhere we can see; the wire shape
 * is the contract, so the wire shape is what these tests pin.
 */
import { describe, expect, it, vi } from 'vitest';
import { RemoteMcpClient } from './remote-client';

const URL = 'http://127.0.0.1:8080/mcp';

type RecordedCall = { url: string; init: RequestInit };

/** JSON-RPC response body for the request with the given id. */
function rpcResult(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/**
 * A scripted fetch: pops the next Response off the queue per call and records `(url, init)`.
 * When the queue runs dry it answers 202 with an empty body (the usual notification reply).
 */
function fakeFetch(responses: Response[]) {
  const calls: RecordedCall[] = [];

  const impl = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses.shift() ?? new Response('', { status: 202 });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: RecordedCall): any {
  return JSON.parse(String(call.init.body));
}

/** Standard successful handshake responses: initialize result (with optional session id), then 202. */
function handshakeResponses(sessionId?: string): Response[] {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  return [
    new Response(rpcResult(1, { protocolVersion: '2024-11-05', capabilities: {} }), { status: 200, headers }),
    new Response('', { status: 202 }),
  ];
}

describe('RemoteMcpClient', () => {
  describe('handshake', () => {
    it('issues exactly [initialize, notifications/initialized] in order, both POST to the configured url', async () => {
      const { impl, calls } = fakeFetch(handshakeResponses());
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.initialize();

      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.url)).toEqual([URL, URL]);
      expect(calls.map((c) => c.init.method)).toEqual(['POST', 'POST']);

      const first = bodyOf(calls[0]);
      expect(first.jsonrpc).toBe('2.0');
      expect(first.method).toBe('initialize');
      expect(first.id).toBeDefined();
      expect(first.params.protocolVersion).toBeTruthy();

      const second = bodyOf(calls[1]);
      expect(second.method).toBe('notifications/initialized');

      // A notification has no id — a server that sees one will try to answer it.
      expect(second.id).toBeUndefined();
    });

    it('captures Mcp-Session-Id from the initialize response and echoes it on every later request', async () => {
      const { impl, calls } = fakeFetch([
        ...handshakeResponses('abc-123'),
        new Response(rpcResult(2, { tools: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        new Response(rpcResult(3, { ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.initialize();
      await client.listTools();
      await client.callTool('compile', {});

      // The initialize request itself has no session yet.
      expect(headersOf(calls[0])['mcp-session-id']).toBeUndefined();

      // notifications/initialized and everything after carry the captured id.
      for (const call of calls.slice(1)) {
        expect(headersOf(call)['mcp-session-id']).toBe('abc-123');
      }
    });
  });

  describe('headers', () => {
    it('carries authorization: Bearer <token> on EVERY request when a token is configured', async () => {
      const { impl, calls } = fakeFetch([
        ...handshakeResponses('sess-1'),
        new Response(rpcResult(2, { tools: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        new Response(rpcResult(3, {}), { status: 200, headers: { 'content-type': 'application/json' } }),
        new Response('', { status: 200 }),
      ]);
      const client = new RemoteMcpClient({ url: URL, token: 'secret', server: 'unity', fetchImpl: impl });

      await client.initialize();
      await client.listTools();
      await client.callTool('compile', {});
      await client.close();

      expect(calls).toHaveLength(5); // initialize, initialized, list, call, DELETE

      for (const call of calls) {
        expect(headersOf(call).authorization).toBe('Bearer secret');
      }
    });

    it('sends no authorization header when no token is configured', async () => {
      const { impl, calls } = fakeFetch(handshakeResponses());
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.initialize();

      for (const call of calls) {
        expect(headersOf(call).authorization).toBeUndefined();
      }
    });

    it('sends content-type and the dual accept header on requests', async () => {
      const { impl, calls } = fakeFetch(handshakeResponses());
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.initialize();

      const headers = headersOf(calls[0]);
      expect(headers['content-type']).toBe('application/json');
      expect(headers.accept).toContain('application/json');
      expect(headers.accept).toContain('text/event-stream');
    });
  });

  describe('listTools', () => {
    it('maps the tools/list result to McpTool[] stamped with the configured server label', async () => {
      const { impl } = fakeFetch([
        new Response(
          rpcResult(1, {
            tools: [
              { name: 'compile', description: 'Compile scripts', inputSchema: { type: 'object' } },
              { name: 'import_asset' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity-editor', fetchImpl: impl });

      const tools = await client.listTools();

      expect(tools).toEqual([
        {
          name: 'compile',
          description: 'Compile scripts',
          inputSchema: { type: 'object' },
          server: 'unity-editor',
        },
        { name: 'import_asset', description: undefined, inputSchema: undefined, server: 'unity-editor' },
      ]);
    });

    it('returns [] when the result has no tools array', async () => {
      const { impl } = fakeFetch([
        new Response(rpcResult(1, {}), { status: 200, headers: { 'content-type': 'application/json' } }),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      expect(await client.listTools()).toEqual([]);
    });
  });

  describe('callTool', () => {
    it('returns the JSON-RPC result verbatim and sends name + arguments', async () => {
      const { impl, calls } = fakeFetch([
        new Response(rpcResult(1, { content: [{ type: 'text', text: 'compiled' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      const result = await client.callTool('compile', { target: 'scripts' });

      expect(result).toEqual({ content: [{ type: 'text', text: 'compiled' }] });

      const body = bodyOf(calls[0]);
      expect(body.method).toBe('tools/call');
      expect(body.params).toEqual({ name: 'compile', arguments: { target: 'scripts' } });
    });

    it('defaults arguments to {} when args are nullish', async () => {
      const { impl, calls } = fakeFetch([
        new Response(rpcResult(1, {}), { status: 200, headers: { 'content-type': 'application/json' } }),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.callTool('compile', undefined);

      expect(bodyOf(calls[0]).params.arguments).toEqual({});
    });
  });

  describe('failure paths', () => {
    it('rejects with the JSON-RPC error message', async () => {
      const { impl } = fakeFetch([
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Unity refused' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await expect(client.callTool('compile', {})).rejects.toThrow(/Unity refused/);
    });

    it('rejects naming the status on a non-2xx response', async () => {
      const { impl } = fakeFetch([new Response('oops', { status: 500 })]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await expect(client.callTool('compile', {})).rejects.toThrow(/500/);
    });

    it('propagates a network-level fetch rejection', async () => {
      const impl = vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await expect(client.callTool('compile', {})).rejects.toThrow('fetch failed');
    });

    it('rejects on an empty body for a request (a notification-style reply to a call is a failure)', async () => {
      const { impl } = fakeFetch([new Response('', { status: 200 })]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await expect(client.callTool('compile', {})).rejects.toThrow(/no response/);
    });
  });

  describe('SSE-framed responses', () => {
    it('parses a single-event text/event-stream body to the result', async () => {
      const body = `event: message\ndata: ${rpcResult(1, { tools: [{ name: 'compile' }] })}\n\n`;
      const { impl } = fakeFetch([
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      const tools = await client.listTools();

      expect(tools).toEqual([{ name: 'compile', description: undefined, inputSchema: undefined, server: 'unity' }]);
    });

    it('prefers the event whose id matches the request when a multi-event body arrives', async () => {
      // First event answers a DIFFERENT id (e.g. a server-initiated message); ours is second.
      const body =
        `event: message\ndata: ${rpcResult(99, { wrong: true })}\n\n` +
        `event: message\ndata: ${rpcResult(1, { right: true })}\n\n`;
      const { impl } = fakeFetch([
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      expect(await client.callTool('compile', {})).toEqual({ right: true });
    });
  });

  describe('close', () => {
    it('sends DELETE with the session header', async () => {
      const { impl, calls } = fakeFetch([...handshakeResponses('sess-9'), new Response('', { status: 200 })]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.initialize();
      await client.close();

      const del = calls[2];
      expect(del.init.method).toBe('DELETE');
      expect(headersOf(del)['mcp-session-id']).toBe('sess-9');
    });

    it('does not throw when the DELETE rejects — the companion may already be gone', async () => {
      let deleteCalls = 0;
      const responses = handshakeResponses('sess-9');
      const impl = vi.fn(async (_url: any, init?: any) => {
        if (init?.method === 'DELETE') {
          deleteCalls++;
          throw new TypeError('fetch failed');
        }

        return responses.shift() ?? new Response('', { status: 202 });
      }) as unknown as typeof fetch;
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.initialize();
      await expect(client.close()).resolves.toBeUndefined();
      expect(deleteCalls).toBe(1);
    });

    it('does not fetch at all when no session was ever established', async () => {
      const { impl } = fakeFetch([]);
      const client = new RemoteMcpClient({ url: URL, server: 'unity', fetchImpl: impl });

      await client.close();

      expect(impl).not.toHaveBeenCalled();
    });
  });
});
