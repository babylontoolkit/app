/**
 * Loopback-only URL rule for network MCP servers (SPEC §4.14 / §4.17).
 *
 * The ONLY network MCP endpoint the platform will talk to from the browser is the user's OWN
 * machine — the Unity Editor bridge companion on 127.0.0.1. Everything else is refused before a
 * single byte is fetched: `.mcp.json` travels with remixed and imported projects, so a URL in it is
 * third-party content, and a non-loopback URL would turn the user's browser into a relay against an
 * arbitrary host (the client-side sibling of the server's SSRF rule in `~/lib/.server/net/ssrf.ts`,
 * which bans exactly the addresses this rule REQUIRES — the two lists are complements, never shared).
 *
 * `http:` only, deliberately: loopback is exempt from mixed-content blocking in supported browsers,
 * and the companion terminates plain HTTP on 127.0.0.1 — an `https:` loopback URL is a
 * misconfiguration, not a stricter variant.
 */
export function isLoopbackHttpUrl(raw: string): boolean {
  if (!raw || typeof raw !== 'string') {
    return false;
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    // Not parseable as a URL at all (also rejects out-of-range ports — `new URL` throws on them).
    return false;
  }

  if (url.protocol !== 'http:') {
    return false;
  }

  /*
   * WHATWG URL lower-cases the hostname and keeps IPv6 hosts bracketed. `localhost` subdomains
   * (`evil.localhost`) are NOT loopback-guaranteed cross-platform, so only the exact names pass.
   */
  const host = url.hostname;
  const isLoopbackHost = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

  if (!isLoopbackHost) {
    return false;
  }

  // An explicit port must be a real one; empty means the scheme default (80), which is fine.
  if (url.port !== '') {
    const port = Number(url.port);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return false;
    }
  }

  return true;
}
