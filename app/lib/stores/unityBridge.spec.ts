import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpTool } from '~/lib/mcp/webcontainer-bridge';
import { callMcpTool, mcpToolsAtom } from '~/lib/stores/mcpBridge';
import {
  UNITY_SERVER_NAME,
  callUnityTool,
  combinedMcpToolsAtom,
  connectUnity,
  disconnectUnity,
  loadPersistedUnityConnection,
  unityConnectionAtom,
  unityToolsAtom,
  type UnityClientFactory,
  type UnityMcpClient,
} from './unityBridge';

/**
 * The Unity bridge store is the ONLY thing standing between the connect dialog and a browser fetch,
 * so the loopback/port gate must run BEFORE the client factory is ever invoked — a URL built from a
 * bad port that reaches fetch is the client-side SSRF hole `~/lib/mcp/loopback.ts` exists to close.
 * The atoms are equally load-bearing: `syncMcpBridge` wholesale-overwrites `mcpToolsAtom`, which is
 * exactly why Unity tools live in their OWN atom — a regression that co-writes or half-clears these
 * atoms silently drops Unity tools mid-session with nothing thrown. Every test injects a fake
 * factory; no test may open a socket.
 */

interface FakeClientScript {
  initializeError?: Error;
  listToolsError?: Error;
  tools?: McpTool[];
  callResult?: unknown;
}

interface FakeClient extends UnityMcpClient {
  calls: string[];
  callArgs: Array<{ name: string; args: unknown }>;
}

function makeFakeClient(script: FakeClientScript = {}): FakeClient {
  const client: FakeClient = {
    calls: [],
    callArgs: [],
    async initialize() {
      client.calls.push('initialize');

      if (script.initializeError) {
        throw script.initializeError;
      }
    },
    async listTools() {
      client.calls.push('listTools');

      if (script.listToolsError) {
        throw script.listToolsError;
      }

      return script.tools ?? [];
    },
    async callTool(name, args) {
      client.calls.push('callTool');
      client.callArgs.push({ name, args });

      return script.callResult;
    },
    async close() {
      client.calls.push('close');
    },
  };

  return client;
}

/** Records every factory invocation's options and hands back the next scripted client. */
function makeFakeFactory(...scripts: FakeClientScript[]) {
  const options: Array<Parameters<UnityClientFactory>[0]> = [];
  const clients: FakeClient[] = [];
  const factory: UnityClientFactory = (opts) => {
    options.push(opts);

    const client = makeFakeClient(scripts[clients.length] ?? {});
    clients.push(client);

    return client;
  };

  return { factory, options, clients };
}

const unityTools: McpTool[] = [
  { name: 'read_scene', description: 'Read the open scene', server: UNITY_SERVER_NAME },
  { name: 'import_asset', server: UNITY_SERVER_NAME },
];

describe('unityBridge store', () => {
  let storage: Map<string, string>;

  beforeEach(async () => {
    storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });

    // Module-level client + atoms persist across tests — always start from a clean disconnect.
    await disconnectUnity(true);
  });

  afterEach(async () => {
    await disconnectUnity(true);
    vi.unstubAllGlobals();
  });

  describe('connectUnity happy path', () => {
    it('builds the loopback URL, handshakes in order, publishes tools + state, and persists', async () => {
      const { factory, options, clients } = makeFakeFactory({ tools: unityTools });

      const ok = await connectUnity(8080, 'tok', factory);

      expect(ok).toBe(true);
      expect(options).toEqual([{ url: 'http://127.0.0.1:8080/mcp', token: 'tok', server: UNITY_SERVER_NAME }]);

      // initialize must complete before tools/list — the MCP handshake order is a protocol rule.
      expect(clients[0].calls).toEqual(['initialize', 'listTools']);

      expect(unityToolsAtom.get()).toEqual(unityTools);
      unityToolsAtom.get().forEach((tool) => expect(tool.server).toBe(UNITY_SERVER_NAME));
      expect(unityConnectionAtom.get()).toEqual({ status: 'connected', port: 8080, toolCount: 2 });

      expect(JSON.parse(storage.get('unity-bridge-connection')!)).toEqual({ port: 8080, token: 'tok' });
    });
  });

  describe('the loopback/port gate runs BEFORE the factory', () => {
    it.each([
      ['out-of-range port', 99999],
      ['NaN port', Number.NaN],
      ['fractional port', 8.5],
    ])('refuses %s without constructing a client', async (_label, port) => {
      const { factory, options } = makeFakeFactory({ tools: unityTools });

      const ok = await connectUnity(port, undefined, factory);

      expect(ok).toBe(false);

      // The whole point: nothing fetchable was ever built for a bad port.
      expect(options).toHaveLength(0);
      expect(unityConnectionAtom.get()).toMatchObject({ status: 'error' });
      expect(unityToolsAtom.get()).toEqual([]);
    });
  });

  describe('handshake failure', () => {
    it('closes the client, clears tools, surfaces the error message, and returns false', async () => {
      const { factory, clients } = makeFakeFactory({ initializeError: new Error('pairing token rejected') });

      const ok = await connectUnity(8080, 'bad-token', factory);

      expect(ok).toBe(false);
      expect(clients[0].calls).toContain('close');
      expect(unityToolsAtom.get()).toEqual([]);
      expect(unityConnectionAtom.get()).toEqual({
        status: 'error',
        port: 8080,
        message: 'pairing token rejected',
      });
    });

    it('a listTools failure after a good initialize is still a failed connect', async () => {
      const { factory, clients } = makeFakeFactory({ listToolsError: new Error('tools/list timed out') });

      const ok = await connectUnity(8080, undefined, factory);

      expect(ok).toBe(false);
      expect(clients[0].calls).toContain('close');
      expect(unityConnectionAtom.get()).toMatchObject({ status: 'error', message: 'tools/list timed out' });
    });
  });

  describe('callUnityTool', () => {
    it('throws when not connected', async () => {
      await expect(callUnityTool('read_scene', {})).rejects.toThrow('not connected');
    });

    it('delegates name + args to the connected client and returns its result', async () => {
      const { factory, clients } = makeFakeFactory({ tools: unityTools, callResult: { isError: false, text: 'ok' } });

      await connectUnity(8080, 'tok', factory);

      const result = await callUnityTool('read_scene', { path: 'Assets/Main.unity' });

      expect(result).toEqual({ isError: false, text: 'ok' });
      expect(clients[0].callArgs).toEqual([{ name: 'read_scene', args: { path: 'Assets/Main.unity' } }]);
    });

    it('throws again after a disconnect — a closed client must not be reachable', async () => {
      const { factory } = makeFakeFactory({ tools: unityTools });

      await connectUnity(8080, 'tok', factory);
      await disconnectUnity();

      await expect(callUnityTool('read_scene', {})).rejects.toThrow('not connected');
    });
  });

  describe('disconnectUnity', () => {
    it('closes the client and resets both atoms', async () => {
      const { factory, clients } = makeFakeFactory({ tools: unityTools });

      await connectUnity(8080, 'tok', factory);
      await disconnectUnity();

      expect(clients[0].calls).toContain('close');
      expect(unityToolsAtom.get()).toEqual([]);
      expect(unityConnectionAtom.get()).toEqual({ status: 'disconnected' });
    });

    it('keeps the persisted pairing by default', async () => {
      const { factory } = makeFakeFactory({ tools: unityTools });

      await connectUnity(8080, 'tok', factory);
      await disconnectUnity();

      expect(storage.has('unity-bridge-connection')).toBe(true);
    });

    it('forgets the persisted pairing only when asked', async () => {
      const { factory } = makeFakeFactory({ tools: unityTools });

      await connectUnity(8080, 'tok', factory);
      await disconnectUnity(true);

      expect(storage.has('unity-bridge-connection')).toBe(false);
    });
  });

  describe('persistence round-trip', () => {
    it('a successful connect is readable back as {port, token}', async () => {
      const { factory } = makeFakeFactory({ tools: unityTools });

      await connectUnity(9152, 'pair-me', factory);

      expect(loadPersistedUnityConnection()).toEqual({ port: 9152, token: 'pair-me' });
    });

    it('returns null on garbage or shape-invalid storage', () => {
      storage.set('unity-bridge-connection', 'not json {{{');
      expect(loadPersistedUnityConnection()).toBeNull();

      storage.set('unity-bridge-connection', JSON.stringify({ port: 'eight thousand' }));
      expect(loadPersistedUnityConnection()).toBeNull();

      storage.set('unity-bridge-connection', JSON.stringify(null));
      expect(loadPersistedUnityConnection()).toBeNull();
    });

    it('returns null when localStorage does not exist at all (SSR guard)', () => {
      vi.stubGlobal('localStorage', undefined);

      expect(loadPersistedUnityConnection()).toBeNull();
    });
  });

  describe('reconnect replaces the previous connection', () => {
    it('closes the first client and the atoms reflect only the second connection', async () => {
      const secondTools: McpTool[] = [{ name: 'compile_scripts', server: UNITY_SERVER_NAME }];
      const { factory, options, clients } = makeFakeFactory({ tools: unityTools }, { tools: secondTools });

      await connectUnity(8080, 'tok-a', factory);

      const ok = await connectUnity(9090, 'tok-b', factory);

      expect(ok).toBe(true);
      expect(clients[0].calls).toContain('close');
      expect(options[1]).toEqual({ url: 'http://127.0.0.1:9090/mcp', token: 'tok-b', server: UNITY_SERVER_NAME });

      expect(unityToolsAtom.get()).toEqual(secondTools);
      expect(unityConnectionAtom.get()).toEqual({ status: 'connected', port: 9090, toolCount: 1 });
      expect(loadPersistedUnityConnection()).toEqual({ port: 9090, token: 'tok-b' });

      // The replaced client must no longer receive calls.
      const result = await callUnityTool('compile_scripts', {});

      expect(result).toBeUndefined();
      expect(clients[0].callArgs).toEqual([]);
      expect(clients[1].callArgs).toEqual([{ name: 'compile_scripts', args: {} }]);
    });
  });

  describe('a failed connect persists nothing', () => {
    it('leaves localStorage empty when initialize rejects — a dead pairing must not prefill next session', async () => {
      const { factory } = makeFakeFactory({ initializeError: new Error('pairing token rejected') });

      const ok = await connectUnity(8080, 'bad-token', factory);

      expect(ok).toBe(false);
      expect(storage.has('unity-bridge-connection')).toBe(false);
    });
  });

  describe('a synchronously-throwing factory', () => {
    it('resolves false with an error state instead of rejecting or sticking in connecting', async () => {
      const factory: UnityClientFactory = () => {
        throw new Error('constructor blew up');
      };

      /*
       * Must not reject — the connect dialog awaits this boolean, and an unhandled rejection
       * would leave the atom stuck showing 'connecting' forever.
       */
      const ok = await connectUnity(8080, 'tok', factory);

      expect(ok).toBe(false);
      expect(unityConnectionAtom.get()).toEqual({ status: 'error', port: 8080, message: 'constructor blew up' });
      expect(unityToolsAtom.get()).toEqual([]);
      expect(storage.has('unity-bridge-connection')).toBe(false);
    });
  });

  describe('combined tool merge + routing through mcpBridge', () => {
    /*
     * These pin the two seams the Unity bridge shares with the WebContainer MCP store: the computed
     * merge (`combinedMcpToolsAtom`) and the `server === 'unity'` branch in `callMcpTool`. The tests
     * write `mcpToolsAtom` directly — exactly what `syncMcpBridge` does on every resync/teardown —
     * because the clobber that motivates the separate atom IS a wholesale `.set()` on that atom.
     */
    const webcontainerTools: McpTool[] = [
      { name: 'read_file', description: 'read_file on fs', server: 'fs' },
      { name: 'search', server: 'docs' },
    ];

    beforeEach(() => {
      mcpToolsAtom.set([]);
    });

    afterEach(() => {
      // `mcpToolsAtom` is module-level shared state — never leak WebContainer tools into other tests.
      mcpToolsAtom.set([]);
    });

    it('combinedMcpToolsAtom concatenates WebContainer tools with Unity tools, Unity tagged server:"unity"', async () => {
      mcpToolsAtom.set(webcontainerTools);

      const { factory } = makeFakeFactory({ tools: unityTools });

      await connectUnity(8080, 'tok', factory);

      expect(combinedMcpToolsAtom.get()).toEqual([...webcontainerTools, ...unityTools]);
      combinedMcpToolsAtom
        .get()
        .slice(webcontainerTools.length)
        .forEach((tool) => expect(tool.server).toBe(UNITY_SERVER_NAME));
    });

    it('CLOBBER PIN: Unity tools survive syncMcpBridge-style wholesale writes to mcpToolsAtom', async () => {
      const { factory } = makeFakeFactory({ tools: unityTools });

      await connectUnity(8080, 'tok', factory);

      mcpToolsAtom.set(webcontainerTools);
      expect(combinedMcpToolsAtom.get()).toEqual([...webcontainerTools, ...unityTools]);

      // Teardown wholesale-clears the WebContainer atom (`teardownMcpBridge` → `.set([])`)...
      mcpToolsAtom.set([]);
      expect(combinedMcpToolsAtom.get()).toEqual(unityTools);

      // ...and a `.mcp.json` resync wholesale-replaces it. Unity tools must ride through BOTH writes.
      const resyncedTools: McpTool[] = [{ name: 'query', server: 'db' }];

      mcpToolsAtom.set(resyncedTools);
      expect(combinedMcpToolsAtom.get()).toEqual([...resyncedTools, ...unityTools]);
    });

    it('callMcpTool routes server:"unity" to the Unity client and never touches the WebContainer bridge', async () => {
      const { factory, clients } = makeFakeFactory({ tools: unityTools, callResult: { isError: false, text: 'ok' } });

      await connectUnity(8080, 'tok', factory);

      /*
       * No WebContainer bridge is running in this suite, so had this call fallen through to the
       * bridge path it would throw 'No MCP servers are running'. Resolving via the fake Unity
       * client is the proof it took the Unity branch.
       */
      const result = await callMcpTool('read_scene', { path: 'Assets/Main.unity' }, UNITY_SERVER_NAME);

      expect(result).toEqual({ isError: false, text: 'ok' });
      expect(clients[0].callArgs).toEqual([{ name: 'read_scene', args: { path: 'Assets/Main.unity' } }]);
    });

    it('the branch is an exact match: any other server name still requires the WebContainer bridge', async () => {
      const { factory } = makeFakeFactory({ tools: unityTools });

      await connectUnity(8080, 'tok', factory);

      // 'unity-editor', 'other-server', … must NOT prefix-match into the Unity branch.
      await expect(callMcpTool('read_scene', {}, 'other-server')).rejects.toThrow('No MCP servers are running');
      await expect(callMcpTool('read_scene', {}, 'unity-editor')).rejects.toThrow('No MCP servers are running');
    });

    it('the Unity branch with Unity NOT connected rejects with the store error, not the bridge error', async () => {
      await expect(callMcpTool('read_scene', {}, UNITY_SERVER_NAME)).rejects.toThrow(
        'The Unity Exporter is not connected.',
      );

      // Specifically NOT the WebContainer bridge's 'No MCP servers are running' — the branch was taken.
      await expect(callMcpTool('read_scene', {}, UNITY_SERVER_NAME)).rejects.not.toThrow('No MCP servers');
    });
  });

  describe('concurrent connects — the epoch guard', () => {
    /** A client whose listTools parks on a promise the test controls. */
    function makeParkedClient(callResult: unknown = undefined) {
      const calls: string[] = [];
      const callArgs: Array<{ name: string; args: unknown }> = [];

      let resolveTools!: (tools: McpTool[]) => void;

      const toolsPromise = new Promise<McpTool[]>((resolve) => {
        resolveTools = resolve;
      });

      const client: UnityMcpClient = {
        async initialize() {
          calls.push('initialize');
        },
        listTools() {
          calls.push('listTools');
          return toolsPromise;
        },
        async callTool(name, args) {
          calls.push('callTool');
          callArgs.push({ name, args });

          return callResult;
        },
        async close() {
          calls.push('close');
        },
      };

      return { client, calls, callArgs, resolveTools };
    }

    /** Flush microtasks until the parked client has reached listTools (everything is promise-based). */
    async function waitForParked(calls: string[]) {
      for (let i = 0; i < 20 && !calls.includes('listTools'); i++) {
        await Promise.resolve();
      }

      expect(calls).toContain('listTools');
    }

    it('a newer connect supersedes a parked one: only B commits, A is closed uncommitted', async () => {
      const parkedA = makeParkedClient('from-a');
      const factoryA: UnityClientFactory = () => parkedA.client;

      const secondTools: McpTool[] = [{ name: 'compile_scripts', server: UNITY_SERVER_NAME }];
      const { factory: factoryB, clients: clientsB } = makeFakeFactory({ tools: secondTools, callResult: 'from-b' });

      const promiseA = connectUnity(8080, 'tok-a', factoryA);

      await waitForParked(parkedA.calls);

      // While A is parked mid-listTools, B connects to completion on another port.
      const okB = await connectUnity(9090, 'tok-b', factoryB);

      expect(okB).toBe(true);

      // Now A's handshake finally comes back — too late; it must not clobber B.
      parkedA.resolveTools(unityTools);

      const okA = await promiseA;

      expect(okA).toBe(false);
      expect(parkedA.calls).toContain('close');

      expect(unityToolsAtom.get()).toEqual(secondTools);
      expect(unityConnectionAtom.get()).toEqual({ status: 'connected', port: 9090, toolCount: 1 });
      expect(loadPersistedUnityConnection()).toEqual({ port: 9090, token: 'tok-b' });

      const result = await callUnityTool('compile_scripts', {});

      expect(result).toBe('from-b');
      expect(parkedA.callArgs).toEqual([]);
      expect(clientsB[0].callArgs).toEqual([{ name: 'compile_scripts', args: {} }]);
    });

    it('a disconnect issued while a connect is parked cancels it — no commit, state stays disconnected', async () => {
      const parked = makeParkedClient();
      const factory: UnityClientFactory = () => parked.client;

      const promise = connectUnity(8080, 'tok', factory);

      await waitForParked(parked.calls);
      await disconnectUnity();

      parked.resolveTools(unityTools);

      const ok = await promise;

      expect(ok).toBe(false);
      expect(parked.calls).toContain('close');
      expect(unityConnectionAtom.get()).toEqual({ status: 'disconnected' });
      expect(unityToolsAtom.get()).toEqual([]);
      expect(storage.has('unity-bridge-connection')).toBe(false);

      await expect(callUnityTool('read_scene', {})).rejects.toThrow('not connected');
    });
  });
});
