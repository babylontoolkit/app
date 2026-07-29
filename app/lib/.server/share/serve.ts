/**
 * Serving a published build (SPEC §4.8, §5, spec/hosting.md).
 *
 * In production the play bucket sits behind CloudFront on its OWN origin (`PLAY_URL`,
 * e.g. `play.babylontoolkit.com`) and these bytes are served directly by the CDN — this module is not
 * on the hot path there. It IS the path in local development, and it is the reference implementation of
 * two rules that the CDN config must also honour:
 *
 * 1. **The origin boundary (§5).** A shared build is user code. Served on the app's own origin, its
 *    JavaScript can read the app session cookie and every `localStorage` key we own. So the game is
 *    always embedded in an iframe pointed at the play origin, and only when `PLAY_URL` is set is that a
 *    genuinely different origin. `resolvePlayOrigin` makes the "are we actually isolated?" question a
 *    value the wrapper can act on, and local dev is explicitly NOT the security boundary (documented,
 *    and asserted in tests) — production MUST set `PLAY_URL`.
 * 2. **Path safety.** The request path is attacker-controlled. `buildContentKey` re-derives the object
 *    key the same rejecting way the publish path does, so `/play/:id/../../snapshots/x` cannot walk out
 *    of the share's prefix and read another project's private snapshot.
 */
import { buildPrefix } from './publish';
import { env } from '~/lib/.server/env';

/** A build path that tries to escape its share prefix. 404, not 403 — do not confirm the layout. */
export class UnsafeContentPathError extends Error {
  readonly statusCode = 404;
  readonly isRetryable = false;

  constructor() {
    super('Not found.');
    this.name = 'NotFoundError';
  }
}

/**
 * Resolve a request path under `/play/:shareId/...` to an object key inside that share's prefix.
 *
 * Rejects the same shapes `buildObjectKey` rejects on the way in — absolute paths, `..`, backslashes,
 * null bytes — and defaults a bare directory request to `index.html`, the way a static host would.
 */
export function buildContentKey(shareId: string, requestPath: string): string {
  /*
   * A bare directory request → index.html (as a static host would). A path that ARRIVES absolute is
   * rejected, not relativised: routing never produces one, so an absolute path here is a probe.
   */
  const resolved = requestPath === '' ? 'index.html' : requestPath;

  if (resolved.startsWith('/') || /^[a-zA-Z]:/.test(resolved) || resolved.includes('\\') || resolved.includes('\0')) {
    throw new UnsafeContentPathError();
  }

  const segments = resolved.split('/');

  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new UnsafeContentPathError();
  }

  return `${buildPrefix(shareId)}/${segments.join('/')}`;
}

export type PlayRequestMode = 'asset' | 'game-document' | 'wrapper';

/**
 * What a `/play/:shareId/<rest>` request actually wants (T17b).
 *
 * Three answers, and the distinction is load-bearing because the game is a BrowserRouter SPA served
 * under a prefix:
 *
 * - **asset** — the path has an extension: serve the build file's bytes. Unchanged.
 * - **game-document** — the request is the IFRAME loading the game (`?embed=1`, set by the wrapper's
 *   own markup, or a `sec-fetch-dest: iframe` in-game full-reload navigation): serve `index.html`'s
 *   bytes whatever the path, so the game's client-side routes (`/play/<id>/play`) resolve inside the
 *   game instead of 404ing. This is SPA fallback scoped to the iframe.
 * - **wrapper** — a person at a top-level URL: the shell page (badge + iframe).
 *
 * `embed` must win over everything extensionless or the wrapper recurses: the iframe's directory URL
 * has no extension, and serving it the wrapper would put a wrapper inside the wrapper forever. A
 * browser that sends neither signal (no `sec-fetch-dest`) degrades to the wrapper on in-game reloads —
 * nested chrome, but a game that still boots — never to a 404.
 */
export function resolvePlayRequest(
  rest: string,
  signals: { embed: boolean; secFetchDest: string | null },
): PlayRequestMode {
  if (/\.[a-z0-9]+$/i.test(rest)) {
    return 'asset';
  }

  if (signals.embed || signals.secFetchDest === 'iframe') {
    return 'game-document';
  }

  return 'wrapper';
}

export interface PlayOrigin {
  /** Absolute origin the game iframe is served from. Empty string means same-origin (local dev only). */
  origin: string;

  /** True when the game runs on a genuinely separate origin and cannot touch app cookies (§5). */
  isolated: boolean;
}

export function resolvePlayOrigin(context?: unknown): PlayOrigin {
  const playUrl = env(context, 'PLAY_URL')?.trim();

  if (playUrl) {
    return { origin: playUrl.replace(/\/+$/, ''), isolated: true };
  }

  return { origin: '', isolated: false };
}

/**
 * FAIL CLOSED in production without a separate play origin (§5).
 *
 * Serving a shared build same-origin lets the user's game JavaScript read the app session cookie and
 * every `localStorage` key we own. Local dev accepts that (it is explicitly not the security boundary,
 * documented above and asserted in tests); PRODUCTION must not. Mirrors `assertNotLocalInProduction`:
 * rather than a config comment nobody reads, the play PATH refuses to serve until `PLAY_URL` points at
 * a genuinely separate origin. It is a TARGETED refusal — only `/play` is affected, not the whole app —
 * because a same-origin game is a cross-site hole, not a mere misconfiguration.
 *
 * `false` → do not serve; return the refusal. `true` → isolated (prod) or local dev.
 */
export function isPlayServableInProduction(context?: unknown): boolean {
  const isProduction = (env(context, 'NODE_ENV') ?? process.env.NODE_ENV) === 'production';

  if (!isProduction) {
    return true;
  }

  return resolvePlayOrigin(context).isolated;
}

/**
 * Cache policy for a build asset.
 *
 * Vite fingerprints its `assets/*` (content hash in the name), so those are immutable forever. The
 * entry HTML is not fingerprinted and must revalidate, or a re-publish would never reach a returning
 * player. Splitting the two is the difference between "instant reload" and "stuck on the old version".
 */
export function cacheControlFor(path: string): string {
  if (/\/assets\/|\.[0-9a-f]{8,}\./.test(path)) {
    return 'public, max-age=31536000, immutable';
  }

  return 'public, max-age=0, must-revalidate';
}
