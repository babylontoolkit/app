/**
 * Unity Editor bridge connection (SPEC §4.17).
 *
 * The network sibling of `mcpBridge.ts`: where that store launches stdio servers INSIDE the
 * WebContainer, this one holds the browser's connection to the user's LOCAL Unity Editor — the
 * companion proxy on 127.0.0.1 in front of the Unity MCP server. Same downstream contract (tools in
 * an atom, a client-side executor, untrusted results §4.14), different transport, and deliberately a
 * SEPARATE atom: `syncMcpBridge` wholesale-overwrites `mcpToolsAtom` on every `.mcp.json` resync and
 * teardown, so co-writing that atom would silently drop the Unity tools mid-session.
 *
 * The connection is PER-MACHINE, not per-project — a pairing token for a port on this computer means
 * nothing on another device — so it persists in localStorage, never in the project's `.mcp.json`
 * (which travels with remixes and GitHub sync, §4.14).
 */
import { atom, computed } from 'nanostores';
import { isLoopbackHttpUrl } from '~/lib/mcp/loopback';
import { RemoteMcpClient } from '~/lib/mcp/remote-client';
import { UNITY_SERVER_NAME, type McpTool } from '~/lib/mcp/webcontainer-bridge';
import { mcpToolsAtom } from '~/lib/stores/mcpBridge';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('unity-bridge');

/*
 * The reserved server label Unity tools carry through the whole relay path (request body → relay
 * event → client execution). Defined in `webcontainer-bridge.ts` (the leaf) and re-exported here for
 * the connection UI; `McpBridge.launch` refuses `.mcp.json` servers that claim it.
 */
export { UNITY_SERVER_NAME };

const STORAGE_KEY = 'unity-bridge-connection';

export type UnityConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting'; port: number }
  | { status: 'connected'; port: number; toolCount: number }
  | { status: 'error'; port: number; message: string };

export const unityConnectionAtom = atom<UnityConnectionState>({ status: 'disconnected' });

/** Tools discovered from the connected Unity Editor bridge, tagged `server: 'unity'`. */
export const unityToolsAtom = atom<McpTool[]>([]);

/**
 * What the chat actually forwards to the generation: the WebContainer bridge's tools PLUS the Unity
 * Editor's. A computed merge — NEVER a co-write into `mcpToolsAtom`, which `syncMcpBridge` wholesale
 * `.set()`s on every `.mcp.json` resync/teardown and would silently clobber the Unity tools.
 */
export const combinedMcpToolsAtom = computed([mcpToolsAtom, unityToolsAtom], (mcp, unity) => [...mcp, ...unity]);

/** The minimal client surface the store needs — injectable so tests never open a socket. */
export interface UnityMcpClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export type UnityClientFactory = (options: { url: string; token?: string; server: string }) => UnityMcpClient;

const defaultFactory: UnityClientFactory = (options) => new RemoteMcpClient(options);

let _client: UnityMcpClient | undefined;

/** Guards overlapping connects (a double-clicked Connect button): only the newest attempt commits. */
let _connectEpoch = 0;

export interface PersistedUnityConnection {
  port: number;
  token?: string;
}

/**
 * Connect to the companion at `http://127.0.0.1:<port>/mcp`.
 *
 * The loopback rule runs BEFORE any fetch — this store must be unable to point the browser at a
 * non-loopback host no matter what the caller passes. On success the discovered tools land in
 * `unityToolsAtom` and the connection is persisted for the next session on this machine.
 */
export async function connectUnity(
  port: number,
  token?: string,
  factory: UnityClientFactory = defaultFactory,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/mcp`;

  if (!Number.isInteger(port) || !isLoopbackHttpUrl(url)) {
    unityConnectionAtom.set({ status: 'error', port, message: `Invalid port: ${port}` });
    return false;
  }

  // Adopting a new connection always drops the previous one first.
  await disconnectUnity();

  const epoch = ++_connectEpoch;

  unityConnectionAtom.set({ status: 'connecting', port });

  let client: UnityMcpClient | undefined;

  try {
    client = factory({ url, token, server: UNITY_SERVER_NAME });

    await client.initialize();

    const tools = await client.listTools();

    if (epoch !== _connectEpoch) {
      // A newer connect (or disconnect) superseded this attempt while it awaited — do not commit.
      await client.close().catch(() => undefined);
      return false;
    }

    _client = client;
    unityToolsAtom.set(tools);
    unityConnectionAtom.set({ status: 'connected', port, toolCount: tools.length });
    persistConnection({ port, token });

    logger.info(`Unity Editor bridge connected: ${tools.length} tool(s) on port ${port}.`);

    return true;
  } catch (error) {
    await client?.close().catch(() => undefined);

    if (epoch === _connectEpoch) {
      unityToolsAtom.set([]);
      unityConnectionAtom.set({ status: 'error', port, message: (error as Error).message });
    }

    return false;
  }
}

/** Execute a Unity tool call against the local editor. The result is UNTRUSTED input (§4.14). */
export async function callUnityTool(toolName: string, args: unknown): Promise<unknown> {
  if (!_client) {
    throw new Error('The Unity Exporter is not connected.');
  }

  return _client.callTool(toolName, args);
}

/** Drop the connection and, when the user asked for it explicitly, forget the pairing. */
export async function disconnectUnity(forgetPersisted = false): Promise<void> {
  // Also cancels any in-flight connect attempt (it checks the epoch before committing).
  _connectEpoch++;

  if (_client) {
    await _client.close().catch(() => undefined);
    _client = undefined;
  }

  unityToolsAtom.set([]);
  unityConnectionAtom.set({ status: 'disconnected' });

  if (forgetPersisted) {
    persistConnection(null);
  }
}

/** The saved pairing for this machine, if any — the UI prefills from it; nothing auto-connects. */
export function loadPersistedUnityConnection(): PersistedUnityConnection | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as PersistedUnityConnection) : null;

    return parsed && Number.isInteger(parsed.port) ? parsed : null;
  } catch {
    return null;
  }
}

function persistConnection(connection: PersistedUnityConnection | null): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    if (connection) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage full or blocked — the connection still works for this session.
  }
}
