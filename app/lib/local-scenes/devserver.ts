/**
 * Is the user's local Unity dev server reachable from this page? (D27)
 *
 * Four answers, decided only from what a browser can observe:
 *
 * - a CORS fetch resolves → `running` (whatever the status — an answer is an answer);
 * - it throws but an opaque `no-cors` fetch resolves → `old-exporter` (reachable, but it sends no CORS
 *   headers, which newer exporter versions do);
 * - both throw and Chrome's local-network permission reads `denied` → `blocked`;
 * - otherwise → `not-running`.
 *
 * Every probe is in its own try: this runs on an error path, and a probe that throws must degrade the
 * diagnosis rather than replace it with a second error.
 */

export type DevServerState = 'running' | 'not-running' | 'blocked' | 'old-exporter';

const PERMISSION_NAMES = ['loopback-network', 'local-network-access'];

export async function checkDevServer(
  origin: string,
  deps?: { fetch?: typeof fetch; permissions?: Permissions },
): Promise<DevServerState> {
  const doFetch = deps?.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  const permissions =
    deps?.permissions ??
    (typeof navigator !== 'undefined' ? (navigator.permissions as Permissions | undefined) : undefined);
  const target = origin.replace(/\/+$/, '') + '/';

  if (doFetch) {
    try {
      await doFetch(target, { mode: 'cors', cache: 'no-store' });
      return 'running';
    } catch {
      /* fall through to the opaque probe */
    }

    try {
      await doFetch(target, { mode: 'no-cors', cache: 'no-store' });
      return 'old-exporter';
    } catch {
      /* fall through to the permission check */
    }
  }

  if (permissions) {
    for (const name of PERMISSION_NAMES) {
      try {
        const status = await permissions.query({ name: name as PermissionName });

        if (status && status.state === 'denied') {
          return 'blocked';
        }
      } catch {
        /* An unknown permission name throws in browsers that do not have it. */
      }
    }
  }

  return 'not-running';
}
