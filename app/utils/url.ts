/**
 * URL validation utilities with SSRF protection.
 *
 * Used by the server-side URL fetcher (`/api/web-search`, the chat "Fetch URL content" button). A
 * server that fetches a client-supplied URL is an SSRF primitive unless it refuses to reach anything
 * but the public internet: without this, a caller points it at `169.254.169.254` (cloud metadata), a
 * private `10.x`/`192.168.x` service, or a loopback admin port and reads the response straight back
 * through the "web content" the route returns.
 *
 * This is a BLOCK-LIST. Its honest limits, and where each is closed:
 *  - **Numeric IPv4 encodings are already normalized for us.** The WHATWG `URL` parser rewrites
 *    decimal / hex / octal / short-form addresses to dotted-decimal before we ever see `hostname`
 *    (verified: `http://2130706433/`, `http://0x7f000001/`, `http://0177.0.0.1/`, `http://127.1/`
 *    all → `127.0.0.1`), so the IPv4 rules below catch them.
 *  - **IPv6 is classified here** — loopback, unspecified, ULA, link-local, multicast, and
 *    IPv4-mapped/compatible embeddings — because a literal like `[::ffff:7f00:1]` (= 127.0.0.1) or
 *    `[fc00::1]` would otherwise sail past a name-only block-list.
 *  - **DNS is NOT resolved here** (this module is client-importable; `node:dns` is not). A public
 *    hostname that resolves to a private IP (DNS rebinding) passes this string check — the fetch route
 *    closes that with a resolved-IP guard plus per-hop redirect re-validation.
 */

/** Blocked by exact name — resolve to loopback but are not IP literals we can range-check. */
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '[::1]', '::1', 'ip6-localhost', 'ip6-loopback']);

export function isValidUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse a dotted-quad IPv4 literal into its four octets, or null if `host` is not one. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (!m) {
    return null;
  }

  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];

  return octets.some((o) => o > 255) ? null : octets;
}

/** True for any IPv4 range that must never be reached from a server-side fetch. */
function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) {
    return true;
  } // 0.0.0.0/8 "this host"

  if (a === 10) {
    return true;
  } // 10.0.0.0/8

  if (a === 127) {
    return true;
  } // 127.0.0.0/8 loopback

  if (a === 169 && b === 254) {
    return true;
  } // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)

  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  } // 172.16.0.0/12

  if (a === 192 && b === 168) {
    return true;
  } // 192.168.0.0/16

  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  } // 100.64.0.0/10 CGNAT

  return false;
}

/**
 * Expand a (bracket-stripped) IPv6 hostname to its 16 bytes, or null if it is not valid IPv6.
 * Handles `::` compression and an embedded dotted-IPv4 tail (`::ffff:127.0.0.1`).
 */
function expandIpv6(host: string): number[] | null {
  if (!host.includes(':')) {
    return null;
  }

  const halves = host.split('::');

  if (halves.length > 2) {
    return null;
  }

  const toHextets = (segment: string): number[] | null => {
    if (segment === '') {
      return [];
    }

    const out: number[] = [];

    for (const group of segment.split(':')) {
      if (group.includes('.')) {
        const oct = ipv4Octets(group);

        if (!oct) {
          return null;
        }

        out.push((oct[0] << 8) | oct[1], (oct[2] << 8) | oct[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
          return null;
        }

        out.push(parseInt(group, 16));
      }
    }

    return out;
  };

  const head = toHextets(halves[0]);
  const tail = halves.length === 2 ? toHextets(halves[1]) : [];

  if (head === null || tail === null) {
    return null;
  }

  let hextets: number[];

  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;

    if (fill < 0) {
      return null;
    }

    hextets = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    hextets = head;
  }

  if (hextets.length !== 8) {
    return null;
  }

  const bytes: number[] = [];

  for (const h of hextets) {
    bytes.push((h >> 8) & 0xff, h & 0xff);
  }

  return bytes;
}

/** True for any IPv6 range that must never be reached from a server-side fetch. */
function isPrivateIpv6(bytes: number[]): boolean {
  const [b0, b1] = bytes;

  if (bytes.every((x) => x === 0)) {
    return true;
  } // :: unspecified

  if (bytes.slice(0, 15).every((x) => x === 0) && bytes[15] === 1) {
    return true;
  } // ::1 loopback

  if ((b0 & 0xfe) === 0xfc) {
    return true;
  } // fc00::/7 unique-local

  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) {
    return true;
  } // fe80::/10 link-local

  if (b0 === 0xff) {
    return true;
  } // ff00::/8 multicast

  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96) — classify the embedded IPv4.
  const first10Zero = bytes.slice(0, 10).every((x) => x === 0);

  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }

  if (first10Zero && bytes[10] === 0 && bytes[11] === 0) {
    return isPrivateIpv4([bytes[12], bytes[13], bytes[14], bytes[15]]);
  }

  return false;
}

/**
 * Classify a raw IP address string (v4 or v6, brackets optional) as private/unsafe.
 * Used by the fetch route to vet DNS-resolved addresses. Unknown formats are treated as unsafe.
 */
export function isPrivateIpAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '').toLowerCase();

  const octets = ipv4Octets(host);

  if (octets) {
    return isPrivateIpv4(octets);
  }

  const bytes = expandIpv6(host);

  if (bytes) {
    return isPrivateIpv6(bytes);
  }

  return true;
}

export function isAllowedUrl(input: string): boolean {
  if (!isValidUrl(input)) {
    return false;
  }

  const hostname = new URL(input).hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return false;
  }

  // IPv6 literal — the URL parser keeps the brackets on `hostname`.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const bytes = expandIpv6(hostname.slice(1, -1));

    // A bracketed host the URL parser accepted but we cannot expand is refused, fail-closed.
    return bytes ? !isPrivateIpv6(bytes) : false;
  }

  // IPv4 literal (already normalized from any numeric encoding by the URL parser).
  const octets = ipv4Octets(hostname);

  if (octets) {
    return !isPrivateIpv4(octets);
  }

  // A DNS name. Allowed at the string level; the route resolves it and re-checks the IP.
  return true;
}
