/**
 * Project-scoped MCP configuration (SPEC §4.14).
 *
 * MCP is a **project file, not a platform setting**: a Claude Code-compatible `.mcp.json` at the
 * project root, shipped by the AppTemplate template and carried through snapshots, remixes and GitHub
 * sync automatically. This module is the server's read-only understanding of that file — it PARSES and
 * VALIDATES it, so the agent context can tell the model which tools exist and the runtime can decide
 * what it is allowed to launch. It never executes anything (that is the WebContainer's job, §4.14; the
 * server-side execution path is fail-closed, see `server-guard.ts`).
 *
 * The one rule with teeth here is the **command allow-rule**. Even though the WebContainer is isolated,
 * §4.14 requires that a stdio server's `command` resolve INSIDE the project tree — `node_modules/.bin/*`
 * or a project script — never an absolute or system path. `.mcp.json` travels with remixed and imported
 * projects, so it is third-party content; a config that says `command: /usr/bin/curl` (or `../../…`) is
 * refused rather than launched. The blast radius stays the user's own sandbox and its own npm deps.
 */

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];

  /** Env var NAMES only — values live in the project `.env`, never here (§4.14 secrets). */
  envKeys: string[];
  transport: 'stdio' | 'sse' | 'streamable-http';

  /** For sse / streamable-http servers. */
  url?: string;
}

export interface McpConfigResult {
  servers: McpServerSpec[];

  /** Servers rejected by the allow-rule, with why — surfaced to the user, never silently dropped. */
  rejected: Array<{ name: string; reason: string }>;
}

/** A command that resolves inside the project tree. Anything else is refused (§4.14). */
export function isProjectTreeCommand(command: string): boolean {
  if (!command || typeof command !== 'string') {
    return false;
  }

  // Absolute POSIX path, Windows drive, or home-relative — all escape the project tree.
  if (command.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(command) || command.startsWith('~')) {
    return false;
  }

  // Any parent-traversal segment escapes the tree regardless of where it appears.
  if (command.split(/[\\/]/).includes('..')) {
    return false;
  }

  /*
   * The two allowed shapes: a project-local binary, or a bare `node`/`npx`-style launcher that the
   * WebContainer resolves against the project's own node_modules.
   */
  const projectLocal = command.startsWith('node_modules/.bin/') || command.startsWith('./');
  const bareLauncher = /^[a-z0-9_-]+$/i.test(command);

  return projectLocal || bareLauncher;
}

interface RawServer {
  type?: string;
  command?: string;
  args?: unknown;
  env?: Record<string, unknown>;
  url?: string;
  headers?: Record<string, unknown>;
}

/**
 * Parse a project's `.mcp.json` text into validated server specs.
 *
 * Tolerant of a missing or malformed file — a project without MCP is the common case, not an error.
 * Returns both the accepted servers and the rejected ones (with reasons) so the caller can tell the
 * user "this server was ignored because its command points outside the project" rather than have it
 * vanish.
 */
export function parseMcpConfig(jsonText: string | undefined | null): McpConfigResult {
  const empty: McpConfigResult = { servers: [], rejected: [] };

  if (!jsonText || !jsonText.trim()) {
    return empty;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { servers: [], rejected: [{ name: '(file)', reason: '.mcp.json is not valid JSON' }] };
  }

  const mcpServers = (parsed as { mcpServers?: Record<string, RawServer> })?.mcpServers;

  if (!mcpServers || typeof mcpServers !== 'object') {
    return empty;
  }

  const servers: McpServerSpec[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || typeof raw !== 'object') {
      rejected.push({ name, reason: 'not an object' });
      continue;
    }

    const transport = normaliseTransport(raw);

    if (transport === 'stdio') {
      const command = typeof raw.command === 'string' ? raw.command : '';

      if (!command) {
        rejected.push({ name, reason: 'stdio server has no command' });
        continue;
      }

      // The allow-rule. A command outside the project tree is refused, not launched (§4.14).
      if (!isProjectTreeCommand(command)) {
        rejected.push({ name, reason: `command "${command}" must resolve inside the project tree` });
        continue;
      }

      servers.push({
        name,
        command,
        args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
        envKeys: raw.env && typeof raw.env === 'object' ? Object.keys(raw.env) : [],
        transport: 'stdio',
      });
    } else {
      /*
       * sse / streamable-http — network transports, REFUSED outright.
       *
       * The only network MCP endpoint this platform ever spoke to was the Unity Editor bridge
       * companion on the user's own loopback interface (§4.17), and that is removed. With no client
       * left to connect one, accepting a URL server would park dead config in the project that reads
       * as support — and `.mcp.json` travels with remixes and imports, so a URL in it is third-party
       * content that would otherwise turn the user's browser into a relay against an arbitrary host.
       * Refused BY NAME, because "we do not support network MCP transports" is a product boundary and
       * a server that silently never starts is a bug report.
       */
      rejected.push({
        name,
        reason: `${transport} servers are not supported — only stdio servers run in the sandbox`,
      });
      continue;
    }
  }

  return { servers, rejected };
}

function normaliseTransport(raw: RawServer): 'stdio' | 'sse' | 'streamable-http' {
  if (raw.type === 'sse') {
    return 'sse';
  }

  if (raw.type === 'streamable-http') {
    return 'streamable-http';
  }

  // Claude Code's default: a server with a `command` is stdio; one with only a `url` is inferred.
  if (!raw.command && raw.url) {
    return 'streamable-http';
  }

  return 'stdio';
}
