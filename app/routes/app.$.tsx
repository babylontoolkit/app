/**
 * The public page for a shared game (SPEC §4.8, §5).
 *
 * A published project is reachable two ways, decided entirely by `SHARE_DOMAIN`:
 *
 *   LOCAL DEV (unset)   localhost:5173/app/:shareId          → wrapper
 *                       localhost:5173/app/:shareId/index.html
 *                       localhost:5173/app/:shareId/assets/x.js
 *
 *   DEPLOYED (set)      arcade-racer-k7m2p9qx4nrt.codewrx.app/          → wrapper
 *                       arcade-racer-k7m2p9qx4nrt.codewrx.app/assets/x.js
 *
 * ⚠️ **The route is `/app`, not `/play`, and that is not cosmetic.** SPEC §4.4c's play contract has
 * every generated game enter gameplay via `navigate('/play', { gameMode })`. Under the old shape a
 * shared build sat at `/play/<shareId>/` and its own gameplay route resolved to `/play/<shareId>/play`
 * — two different meanings of "play" nested inside each other. The published build resolves its mount
 * point at runtime (`appBasename()`, see `publish.ts`), so the rename costs the build nothing.
 *
 * The ONLY unauthenticated project read on the platform (§4.5, migration 0001's public-read policy):
 * a game is playable if and only if it has a live share. Everything is served from object storage;
 * the server never runs the game.
 */
import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getProjectStore } from '~/lib/.server/projects/store';
import { getObjectStore } from '~/lib/.server/storage';
import {
  buildContentKey,
  cacheControlFor,
  isPlayServableInProduction,
  resolvePlayRequest,
  resolveShareDomain,
  shareIdFromHost,
  shareUrl,
} from '~/lib/.server/share/serve';
import { contentTypeFor } from '~/lib/.server/share/publish';
import { renderPlayWrapper } from '~/lib/.server/share/wrapper';
import { env } from '~/lib/.server/env';

function notFound(): Response {
  return new Response('This game is not available.', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/**
 * Refuse (fail closed) to serve a shared build same-origin in production (§5). A game is user code; on
 * the app origin its JS could read app cookies. Only the share PATH is refused, never the whole app.
 */
function playNotIsolated(): Response {
  return new Response(
    'This game cannot be served from this origin. The share domain (SHARE_DOMAIN) is not configured on this server.',
    { status: 503, headers: { 'content-type': 'text/plain' } },
  );
}

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const domain = resolveShareDomain(context);

  /*
   * ONE path shape reaches this loader, from both addresses.
   *
   * A vanity-host request (`arcade-racer-<id>.codewrx.app/assets/x.js`) has already been rewritten to
   * `/app/<id>/assets/x.js` at the server entry — `vite.config.ts`'s `shareHostPlugin` in dev,
   * `functions/[[path]].ts` in production — because a route cannot decide it should have been a
   * different route (see `share-host.ts` for the live measurement). So the splat is the only source of
   * the id here, and the host is a SIGNAL, never a second parser.
   */
  const splat = params['*'] ?? '';
  const slash = splat.indexOf('/');
  const shareId = slash === -1 ? splat : splat.slice(0, slash);
  const rest = slash === -1 ? '' : splat.slice(slash + 1);

  /** Did this arrive on the project's own origin? Decides the iframe base and the canonical redirect. */
  const onShareHost = shareIdFromHost(request.headers.get('host') ?? url.hostname, domain) !== undefined;

  if (!shareId) {
    return notFound();
  }

  /*
   * In production, refuse to serve a shared build without a genuinely separate share domain (§5).
   * Reaching here in production with `SHARE_DOMAIN` unset would serve user code on the app origin — a
   * cross-site hole, not a mere misconfiguration.
   */
  if (!isPlayServableInProduction(context)) {
    return playNotIsolated();
  }

  const project = await getProjectStore(context).getByShareId(shareId);

  // No project, or the share was pulled (id kept, `sharedAt` cleared) → gone. Same answer either way.
  if (!project || !project.sharedAt) {
    return notFound();
  }

  /*
   * 🔴 ONE ORIGIN ACTUALLY SERVES GAME BYTES, OR THE ISOLATION IS ONLY APPROXIMATE.
   *
   * With a share domain configured, an app-origin `/app/<id>` request redirects to the canonical vanity
   * URL rather than serving. Leaving it serving in parallel would look harmless and quietly undo the
   * per-game boundary this whole shape exists for: every published game would stay reachable on one
   * shared origin, so game A could still read game B's `localStorage` simply by using the app-origin
   * address. It also keeps a single canonical URL for link previews.
   *
   * 301 rather than 404 because links live in other people's chat logs, and a permanent redirect is the
   * one answer that is correct for a visitor, a crawler and a link unfurler at the same time.
   */
  if (domain && !onShareHost) {
    /*
     * `shareId` rather than `project.shareId`: the row's field is optional on the type, and this is
     * the id we actually RESOLVED the project by — so it is the one that is certainly correct.
     */
    const canonical = shareUrl({ shareId, shareSlug: project.shareSlug }, context);
    const target = `${canonical}${rest ? `/${rest}` : ''}${url.search}`;

    return new Response(null, {
      status: 301,
      headers: { location: target, 'cache-control': 'public, max-age=0, must-revalidate' },
    });
  }

  /*
   * Three request shapes (T17b, `resolvePlayRequest`): a person gets the wrapper, the wrapper's
   * iframe (`?embed=1` / `sec-fetch-dest: iframe`) gets the game DOCUMENT — index.html's bytes for
   * any extensionless path, so the game's client-side routes work under the share prefix — and a
   * path with an extension gets the build file's bytes.
   */
  const mode = resolvePlayRequest(rest, {
    embed: url.searchParams.has('embed'),
    secFetchDest: request.headers.get('sec-fetch-dest'),
  });

  // The bare share URL is the shell page: it frames the game and overlays the badge.
  if (mode === 'wrapper') {
    const html = renderPlayWrapper({
      shareId,
      title: project.shareTitle || project.name,
      description: project.shareDescription,
      solo: project.soloLaunch ?? false,

      /*
       * The game document lives at the SAME address as this wrapper — on a vanity host that is the
       * project's own origin, in local dev it is `/app/<id>`. So the iframe src is always relative to
       * here, and only the Remix link has to reach back to the app (see `wrapper.ts`).
       */
      gameBase: onShareHost ? '' : `/app/${encodeURIComponent(shareId)}`,
      appOrigin: env(context, 'APP_URL')?.trim().replace(/\/+$/, '') ?? '',
    });

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',

        // The shell itself carries our origin; keep it from being framed elsewhere.
        'x-frame-options': 'SAMEORIGIN',
        'cache-control': 'public, max-age=0, must-revalidate',
      },
    });
  }

  // Otherwise: serve bytes — the game document for the iframe, or the requested build file.
  let key: string;

  try {
    key = buildContentKey(shareId, mode === 'game-document' ? 'index.html' : rest);
  } catch {
    return notFound();
  }

  const bytes = await getObjectStore(context).get(key);

  if (!bytes) {
    return notFound();
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': contentTypeFor(key),
      'cache-control': cacheControlFor(key),

      // Defence in depth: this content is user code. It never needs to see a referrer or be sniffed.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}
