/**
 * Loopback-only URL rule for network MCP servers (SPEC §4.14, §4.17).
 *
 * `.mcp.json` travels with remixed and imported projects, so a network server's `url` is untrusted
 * third-party content — a non-loopback URL would point the user's browser at an arbitrary host. The
 * ONLY endpoint the platform will talk to is the user's OWN machine (the Unity Editor bridge
 * companion on 127.0.0.1), and `http:` only by design: the companion terminates plain HTTP on
 * loopback, so an `https:` loopback URL is a misconfiguration, not a stricter variant.
 */
import { describe, expect, it } from 'vitest';
import { isLoopbackHttpUrl } from '~/lib/mcp/loopback';

describe('isLoopbackHttpUrl', () => {
  it.each([
    ['http://127.0.0.1:8080/mcp', 'IPv4 loopback with port'],
    ['http://localhost:8080/mcp', 'localhost with port'],
    ['http://[::1]:8080/mcp', 'IPv6 loopback with port'],
    ['http://127.0.0.1/mcp', 'no port (scheme default 80)'],
    ['http://localhost:1', 'lowest valid port'],
    ['http://localhost:65535', 'highest valid port'],

    /*
     * The rule reads the WHATWG-PARSED hostname, so every shorthand that a browser would resolve to
     * loopback normalises to `127.0.0.1` before the comparison and is genuinely loopback. These are
     * pinned because the safety argument DEPENDS on that normalisation: a rule written against the
     * raw string instead would reject these while a `fetch` of the same URL still hit the editor.
     */
    ['http://127.1:8080', 'IPv4 shorthand — parses to 127.0.0.1'],
    ['http://2130706433:8080', 'integer form — parses to 127.0.0.1'],
    ['http://0177.0.0.1:8080', 'octal form — parses to 127.0.0.1'],
  ])('ACCEPTS %s (%s)', (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(true);
  });

  it.each([
    ['https://127.0.0.1:8080/mcp', 'https — companion terminates plain http'],
    ['http://192.168.1.10:8080', 'private LAN address, not loopback'],
    ['http://10.0.0.1:8080', 'private LAN address, not loopback'],
    ['http://mcp.example.com/mcp', 'public host'],
    ['http://evil.localhost:8080', 'localhost SUBDOMAIN — not loopback-guaranteed cross-platform'],
    ['http://127.0.0.1.evil.com:8080', 'loopback-looking PREFIX on an attacker domain'],
    ['http://localhost.evil.com:8080', 'localhost-looking prefix on an attacker domain'],
    ['http://[::2]:8080', 'non-loopback IPv6'],
    ['ftp://127.0.0.1', 'non-http scheme'],
    ['http://localhost:99999', 'port out of range (new URL throws)'],
    ['not a url', 'not parseable'],
    ['', 'empty'],
  ])('REJECTS %s (%s)', (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(false);
  });
});
