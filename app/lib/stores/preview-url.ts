/**
 * Preview URL rules: when to re-mint an expiring one, and how to put a path on one
 * (T8, `spec/sandbox-codesandbox.md`).
 *
 * 🔴 A preview whose credential has expired does not LOOK broken. On CodeSandbox the private preview
 * host answers 401, and a cross-origin 401 page still fires the iframe's `onLoad` — so the workbench
 * clears its stale-preview alert and reports a healthy preview over a dead one. Nothing throws, no
 * console error, and the only recovery a user has is a full page reload. Hence a timer, and hence the
 * timer's arithmetic being a pure function with a test rather than an expression inside a store.
 *
 * The WebContainer answer is `undefined` — its preview URLs do not expire — and that must never be
 * confused with "expires now": absent expiry means schedule NOTHING.
 */

/**
 * Re-mint this long before expiry — IMPORTED, never re-chosen.
 *
 * The boot module's mint cache answers "still fresh?" with this same window, so the two must be one
 * number: a store scheduling at `expiresAt - 5min` against a cache that considers anything inside
 * 2 minutes fresh would fire a timer that returns the OLD token and changes nothing. See
 * `~/lib/sandbox/boot-decisions.ts`, which owns it (pure, importable from either side).
 */
export { PREVIEW_REMINT_WINDOW_MS } from '~/lib/sandbox/boot-decisions';
import { PREVIEW_REMINT_WINDOW_MS } from '~/lib/sandbox/boot-decisions';

/**
 * The floor on a scheduled re-mint.
 *
 * A token already inside the window (or already dead — a laptop that slept through it) yields a
 * negative raw delay. Clamping to a small positive value re-mints promptly on the next tick instead
 * of scheduling `setTimeout(…, 0)` in a loop against a route that may itself be failing.
 */
export const MIN_REMINT_DELAY_MS = 1_000;

/**
 * How long to wait before re-trying a re-mint that FAILED.
 *
 * A failure leaves the still-working URL in place, so this is not urgent — but it must exist: without
 * a retry, one transient blip at the rotation moment means the token is never replaced again and the
 * preview 401s for the rest of the session. Long enough not to hammer a provider that is already
 * unhappy, short enough to beat the remaining window (which is `PREVIEW_REMINT_WINDOW_MS` wide).
 */
export const REMINT_RETRY_DELAY_MS = 30_000;

/**
 * How long from `now` until this URL should be re-minted, or `undefined` for "never".
 *
 * `undefined`/`NaN` expiry → `undefined`: a provider that does not report an expiry does not have
 * one, and inventing a re-mint schedule for it would fire a timer that can never produce a new URL.
 */
export function remintDelayMs(
  expiresAt: number | undefined,
  now: number,
  windowMs: number = PREVIEW_REMINT_WINDOW_MS,
): number | undefined {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
    return undefined;
  }

  return Math.max(MIN_REMINT_DELAY_MS, expiresAt - windowMs - now);
}

/**
 * Put `path` on a preview base URL, keeping whatever credential the base carries.
 *
 * 🔴 URL-join, never string-append: a CodeSandbox preview base carries `?preview_token=…`, so
 * `base + '/play'` glues the path onto the QUERY (`…token=x/play`) and breaks both the route and the
 * token. A re-mint has to re-apply the user's current path onto the NEW base for the same reason —
 * otherwise every hourly token rotation silently kicks the preview back to `/`.
 *
 * 🔴 The path is APPENDED to the base's own pathname, never assigned over it. Assigning is what this
 * did until 2026-07-31, and it was correct only because every preview base then had a pathname of
 * `/` — a CodeSandbox base is `https://<host>.csb.app/`, so `pathname = '/play'` produced the right
 * answer for the wrong reason. Nodepod serves previews from a SAME-ORIGIN mount
 * (`/__virtual__/<pod>/<port>`), and assigning there rewrites the URL to `/play` on our own origin —
 * which is the BUILDER page, not the game. Observed live: the preview iframe silently loaded the app
 * builder inside itself and read exactly like a hang. Same family as the T17b `/play/:shareId`
 * base-path defect: a root-absolute path under a prefix.
 *
 * Appending is identical for a base whose pathname is `/`, so CodeSandbox and WebContainer are
 * byte-for-byte unaffected.
 *
 * A malformed base is returned unchanged rather than throwing: a preview that lost its path is a
 * nuisance, and a `TypeError` inside a render is a blank workbench.
 */
export function previewUrlWithPath(baseUrl: string, path: string): string {
  if (!path || path === '/') {
    return baseUrl;
  }

  try {
    const joined = new URL(baseUrl);

    // '' when the base sits at the origin root, so the two providers converge on the same string.
    const mount = joined.pathname.replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;

    joined.pathname = `${mount}${suffix}`;

    return joined.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * A stable, provider-agnostic id for one preview.
 *
 * 🔴 **This used to be a hardcoded StackBlitz hostname regex, and everything downstream of it was
 * silently dead on any other provider.** It matched only
 * `<sub>.local-credentialless.webcontainer-api.io`, returned `null` for a Nodepod or CodeSandbox
 * preview, and every caller "guarded on that" — so *Open in new window* did nothing at all, the
 * cross-tab preview broadcast never fired, and the storage-sync refresh skipped every preview. None
 * of it threw; the buttons were simply inert. Degrading safely is only a virtue when the thing being
 * degraded is optional, and a menu item that no-ops is a defect wearing a guard's clothes.
 *
 * The id is required to be (a) DETERMINISTIC — two tabs deriving it from the same URL must agree, or
 * the broadcast channel they share is talking to itself — and (b) distinct per port, since a project
 * can have more than one server up. It is NOT required to be meaningful; nothing parses it back.
 *
 * The WebContainer subdomain is kept as the first branch so that provider's ids are byte-identical
 * to before (hide-don't-delete, `spec/sandbox-seam.md`).
 */
export function previewIdFromUrl(url: string): string | null {
  const webcontainer = url.match(/^https?:\/\/([^.]+)\.local-credentialless\.webcontainer-api\.io/);

  if (webcontainer) {
    return webcontainer[1];
  }

  try {
    const parsed = new URL(url);

    /*
     * Nodepod serves previews from our own origin at `/__virtual__/<pod>/<port>` (or `/__preview__/`),
     * so the HOST is the builder's and cannot identify anything — the mount path is the only part
     * that distinguishes one preview from another.
     */
    const mount = parsed.pathname.match(/^\/__(?:virtual|preview)__\/([^/]+)\/([^/]+)/);

    if (mount) {
      return `${mount[1]}-${mount[2]}`;
    }

    // Everything else (CodeSandbox, a plain host:port) is identified by its own origin.
    return parsed.host;
  } catch {
    /*
     * Genuinely unusable input — not a URL at all. `null` here is honest, and it is the ONE case the
     * callers' guards were written for.
     */
    return null;
  }
}
