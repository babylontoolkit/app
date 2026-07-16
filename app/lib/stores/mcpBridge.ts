/**
 * MCP bridge lifecycle (SPEC §4.14).
 *
 * Owns the per-project `McpBridge`: launches the declared stdio servers inside the WebContainer when a
 * project with a `.mcp.json` becomes active, exposes the discovered tools (for display and for telling
 * the agent what is available), and tears the servers down when the project changes.
 *
 * `mcpToolsAtom` is what the chat forwards to the generation and what the MCP settings surface can
 * show. `callMcpTool` is the client-tool executor the generation calls when the model uses an MCP tool
 * — the result is relayed back as UNTRUSTED input (§4.14); the platform never executes these itself.
 */
import { atom } from 'nanostores';
import { webcontainer } from '~/lib/webcontainer';
import { workbenchStore } from '~/lib/stores/workbench';
import { McpBridge, type McpTool } from '~/lib/mcp/webcontainer-bridge';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('mcp-bridge-store');

/** Tool metadata the generation forwards to the server so the agent knows what it can call. */
export const mcpToolsAtom = atom<McpTool[]>([]);

let _bridge: McpBridge | undefined;

/** The `.mcp.json` text the current bridge was launched from — so we only relaunch on a real change. */
let _launchedFrom: string | null = null;

/** Read `.mcp.json` out of the tracked project files, wherever the workdir prefix put it. */
function readMcpJson(): string | null {
  const files = workbenchStore.files.get();

  for (const [path, dirent] of Object.entries(files)) {
    if (dirent?.type === 'file' && /(^|\/)\.mcp\.json$/.test(path)) {
      return dirent.content ?? null;
    }
  }

  return null;
}

/**
 * Ensure the bridge matches the project's current `.mcp.json`.
 *
 * Idempotent and cheap when nothing changed (compares the config text). Called on project ready and
 * whenever the files change; relaunches only when `.mcp.json` actually differs.
 */
export async function syncMcpBridge(): Promise<void> {
  const mcpJson = readMcpJson();

  if (mcpJson === _launchedFrom) {
    return;
  }

  _launchedFrom = mcpJson;

  // Tear down whatever was running before adopting the new config.
  await teardownMcpBridge(false);

  if (!mcpJson) {
    return;
  }

  try {
    const container = await webcontainer;
    _bridge = await McpBridge.launch(container, mcpJson);
    mcpToolsAtom.set(_bridge.tools);

    if (_bridge.tools.length > 0) {
      logger.info(`MCP bridge ready: ${_bridge.tools.length} tool(s) from the project's servers.`);
    }
  } catch (error) {
    logger.warn(`Could not launch the MCP bridge: ${(error as Error).message}`);
  }
}

/**
 * Execute an MCP tool call in the WebContainer. The result is untrusted (§4.14).
 *
 * `server` comes from the relay event and pins the call to the server the model's tool was built from —
 * without it, two servers exposing the same tool name resolve to whichever launched first.
 */
export async function callMcpTool(toolName: string, args: unknown, server?: string): Promise<unknown> {
  if (!_bridge) {
    throw new Error('No MCP servers are running for this project.');
  }

  return _bridge.callTool(toolName, args, server);
}

export async function teardownMcpBridge(resetConfig = true): Promise<void> {
  if (_bridge) {
    await _bridge.stopAll().catch(() => undefined);
    _bridge = undefined;
  }

  mcpToolsAtom.set([]);

  if (resetConfig) {
    _launchedFrom = null;
  }
}
