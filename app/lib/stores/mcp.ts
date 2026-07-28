import { create } from 'zustand';
import type { MCPConfig, MCPServerTools } from '~/lib/services/mcpService';

const MCP_SETTINGS_KEY = 'mcp_settings';
const isBrowser = typeof window !== 'undefined';

/**
 * Is this the fail-closed server-side-MCP guard, rather than a failure?
 *
 * `mcp/server-guard.ts` answers 404 for `/api/mcp-*` unless `SERVER_SIDE_MCP_ENABLED=true`, because
 * upstream's config route spawns a child process per stdio server and was reachable unauthenticated
 * (SPEC §4.14, §5). MCP runs in the user's sandbox instead, so this 404 is the normal state.
 *
 * Narrow on purpose: only a 404 is the wall. A 500, a timeout or a JSON syntax error is a real problem
 * and must keep surfacing — going quiet on those reproduces, one level down, the noise bug this fixes.
 */
function isServerMcpDisabled(error: unknown): boolean {
  return /\b404\b/.test(error instanceof Error ? error.message : String(error ?? ''));
}

type MCPSettings = {
  mcpConfig: MCPConfig;
  maxLLMSteps: number;
};

const defaultSettings = {
  maxLLMSteps: 5,
  mcpConfig: {
    mcpServers: {},
  },
} satisfies MCPSettings;

type Store = {
  isInitialized: boolean;
  settings: MCPSettings;
  serverTools: MCPServerTools;
  error: string | null;
  isUpdatingConfig: boolean;
};

type Actions = {
  initialize: () => Promise<void>;
  updateSettings: (settings: MCPSettings) => Promise<void>;
  checkServersAvailabilities: () => Promise<void>;
};

export const useMCPStore = create<Store & Actions>((set, get) => ({
  isInitialized: false,
  settings: defaultSettings,
  serverTools: {},
  error: null,
  isUpdatingConfig: false,
  initialize: async () => {
    if (get().isInitialized) {
      return;
    }

    if (isBrowser) {
      const savedConfig = localStorage.getItem(MCP_SETTINGS_KEY);

      if (savedConfig) {
        try {
          const settings = JSON.parse(savedConfig) as MCPSettings;
          const serverTools = await updateServerConfig(settings.mcpConfig);
          set(() => ({ settings, serverTools }));
        } catch (error) {
          /*
           * 🔴 A 404 here is OUR OWN WALL, not a failure.
           *
           * `updateServerConfig` posts to `/api/mcp-update-config`, which `mcp/server-guard.ts` refuses
           * with a 404 unless `SERVER_SIDE_MCP_ENABLED=true` — the fail-closed fix for upstream's
           * unauthenticated RCE (SPEC §4.14, §5). MCP runs in the user's sandbox, so that route being
           * shut is the DESIGNED state on every page load.
           *
           * It was reported as `Error parsing saved mcp config` — doubly wrong: nothing failed to parse
           * (the parse succeeded; the network call after it did not), and nothing failed at all. Two
           * red console lines on every single page load, describing a security control working.
           *
           * A real parse failure or a real transport failure still surfaces — only the closed door is
           * quiet, and it says what it actually means.
           */
          if (isServerMcpDisabled(error)) {
            console.debug('Server-side MCP is disabled — MCP servers run in the sandbox (SPEC §4.14).');
          } else {
            console.error('Failed to apply saved mcp config:', error);
            set(() => ({
              error: `Failed to apply saved mcp config: ${error instanceof Error ? error.message : String(error)}`,
            }));
          }
        }
      } else {
        localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(defaultSettings));
      }
    }

    set(() => ({ isInitialized: true }));
  },
  updateSettings: async (newSettings: MCPSettings) => {
    if (get().isUpdatingConfig) {
      return;
    }

    try {
      set(() => ({ isUpdatingConfig: true }));

      const serverTools = await updateServerConfig(newSettings.mcpConfig);

      if (isBrowser) {
        localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(newSettings));
      }

      set(() => ({ settings: newSettings, serverTools }));
    } catch (error) {
      throw error;
    } finally {
      set(() => ({ isUpdatingConfig: false }));
    }
  },
  checkServersAvailabilities: async () => {
    const response = await fetch('/api/mcp-check', {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
    }

    const serverTools = (await response.json()) as MCPServerTools;

    set(() => ({ serverTools }));
  },
}));

async function updateServerConfig(config: MCPConfig) {
  const response = await fetch('/api/mcp-update-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as MCPServerTools;

  return data;
}
