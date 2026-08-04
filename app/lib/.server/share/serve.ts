/**
 * Serving a published build (SPEC §4.8, §5, spec/hosting.md).
 *
 * A published project is addressed two ways, and `SHARE_DOMAIN` decides which:
 *
 * - **unset (local dev)** — `http://localhost:5173/app/<shareId>`, bytes out of `.data/storage`. One
 *   machine, no S3, no DNS. This is not a degraded mode; it is the right answer for a single developer.
 * - **set (deployed)** — `https://arcade-racer-k7m2p9qx4nrt.codewrx.app`, bytes out of the S3 bucket.
 *
 * Three rules this module owns:
 *
 * 1. **The origin boundary (§5).** A shared build is user code. Served on the app's own origin, its
 *    JavaScript can read the app session cookie and every `localStorage` key we own. `SHARE_DOMAIN` is
 *    a separate REGISTRABLE domain from the app's, so the game cannot reach app cookies — and because
 *    every project gets its OWN label under it, one published game cannot read another's `localStorage`
 *    or `IndexedDB` either, which a single flat play origin could not offer. Local dev is explicitly
 *    NOT the security boundary (documented, asserted in tests) — production MUST set `SHARE_DOMAIN`.
 * 2. **The URL is minted here or nowhere.** `shareUrl` is the only constructor of a share link, because
 *    the client provably cannot build one (see its doc comment).
 * 3. **Path safety.** The request path is attacker-controlled. `buildContentKey` re-derives the object
 *    key the same rejecting way the publish path does, so `<host>/../../snapshots/x` cannot walk out of
 *    the share's prefix and read another project's private snapshot.
 */
import { buildPrefix } from './publish';
import { env, NotConfiguredError } from '~/lib/.server/env';
import {
  normalizeShareDomain,
  shareHostLabel,
  shareIdFromHost,
  SHARE_ROUTE_PREFIX,
  type ShareTarget,
} from '~/lib/share-host';

/*
 * Re-exported so the server's callers have one import site, while the RULE lives in the dependency-free
 * module that `vite.config.ts` and `functions/[[path]].ts` also read. Three copies of a host-parsing
 * rule is three chances for one of them to resolve a different project.
 */
export { shareHostLabel, shareIdFromHost, type ShareTarget };

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
 * Resolve a request path under a share host (or `/app/:shareId/…`) to an object key inside that share's prefix.
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
 * What a share request actually wants (T17b).
 *
 * Three answers, and the distinction is load-bearing because the game is a BrowserRouter SPA served
 * under a prefix:
 *
 * - **asset** — the path has an extension: serve the build file's bytes. Unchanged.
 * - **game-document** — the request is the IFRAME loading the game (`?embed=1`, set by the wrapper's
 *   own markup, or a `sec-fetch-dest: iframe` in-game full-reload navigation): serve `index.html`'s
 *   bytes whatever the path, so the game's client-side routes resolve inside the game instead of
 *   404ing. This is SPA fallback scoped to the iframe.
 *
 *   ⚠️ The game's OWN gameplay route is `/play` (SPEC §4.4c's play contract: `navigate('/play', …)`).
 *   That is exactly why the platform route serving shares is `/app/:shareId` and not `/play/:shareId` —
 *   the old shape nested one meaning of "play" inside the other (`/play/<id>/play`).
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

/**
 * The wildcard base a published project's vanity host hangs off — `codewrx.app` — or `undefined`.
 *
 * 🔴 **THIS ONE VALUE IS THE WHOLE DEV/PROD SPLIT, AND THAT IS DELIBERATE.** Unset means "one machine,
 * no S3, everything under `.data/storage`" and every share URL is the same-origin `/app/<shareId>` the
 * local server already serves. Set means "deployed": builds live in the bucket and a share is reachable
 * at `<slug>-<shareId>.<domain>`. Making it one question keeps the branch OUT of every UI component —
 * `ShareDialog` renders whatever string the server hands it and has no idea which mode it is in, which
 * is the property that stops the next component from string-building a URL again.
 */
export function resolveShareDomain(context?: unknown): string | undefined {
  /*
   * `PLAY_URL` is RETIRED, and refused loudly rather than ignored — the house rule for a retired env
   * var (`rates.ts`'s `refuseRetiredPriceEnv`). It named a single flat origin; a share now lives on
   * its own label under a wildcard domain, so the old value cannot be reinterpreted into the new
   * shape. Silently ignoring it would leave an operator looking at a variable they set, believing
   * shares are isolated, while production fails closed and refuses to serve them at all.
   */
  if (env(context, 'PLAY_URL')?.trim()) {
    throw new NotConfiguredError(
      'PLAY_URL (set, but retired)',
      'Shares are no longer served from one flat play origin. Set SHARE_DOMAIN to the wildcard domain ' +
        'they live under (e.g. SHARE_DOMAIN=codewrx.app), point *.<domain> at this app, and remove PLAY_URL.',
    );
  }

  return normalizeShareDomain(env(context, 'SHARE_DOMAIN'));
}

/**
 * THE canonical URL of a published project. The only place a share URL is constructed.
 *
 * 🔴 **The server mints it because the client cannot.** There is no root loader, `/api/me` carries no
 * origin, and `brand.ts` forbids `process.env` in the brand module (it is client-imported, so a read
 * there inlines a build-time value and breaks per-environment deploys). That is *why* `ShareDialog`
 * string-built `window.location.origin + '/play/' + id` — nothing ever handed it a URL. Reading the env
 * var in the dialog is not the fix; handing the dialog a finished string is (SPEC §2.5 rule 2).
 *
 * Returns a RELATIVE path when no share domain is configured. The client resolves it against its own
 * origin, which reproduces the old local-dev behaviour exactly — the dev case is not a degraded mode
 * here, it is the correct answer for a single machine serving its own `.data/storage`.
 */
export function shareUrl(target: ShareTarget, context?: unknown): string {
  const domain = resolveShareDomain(context);

  if (!domain) {
    return `${SHARE_ROUTE_PREFIX}/${encodeURIComponent(target.shareId)}`;
  }

  return `https://${shareHostLabel(target)}.${domain}`;
}

export function resolvePlayOrigin(context?: unknown): PlayOrigin {
  const domain = resolveShareDomain(context);

  if (domain) {
    return { origin: `https://${domain}`, isolated: true };
  }

  return { origin: '', isolated: false };
}

/**
 * FAIL CLOSED in production without a separate share domain (§5).
 *
 * Serving a shared build same-origin lets the user's game JavaScript read the app session cookie and
 * every `localStorage` key we own. Local dev accepts that (it is explicitly not the security boundary,
 * documented above and asserted in tests); PRODUCTION must not. Mirrors `assertNotLocalInProduction`:
 * rather than a config comment nobody reads, the share PATH refuses to serve until `SHARE_DOMAIN` names
 * a genuinely separate registrable domain. It is a TARGETED refusal — only `/app` is affected, not the
 * whole app — because a same-origin game is a cross-site hole, not a mere misconfiguration.
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
