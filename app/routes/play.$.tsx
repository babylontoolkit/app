/**
 * `/play/:shareId` — the public play page for a shared game (SPEC §4.8, §5).
 *
 * This is a full splat route so it serves the whole build tree:
 *
 *   /play/:shareId                → the wrapper page (full-screen game in an iframe + remix badge)
 *   /play/:shareId/index.html     → the game's entry HTML (served to the iframe)
 *   /play/:shareId/assets/x.js …  → every build asset
 *
 * The ONLY unauthenticated project read on the platform (§4.5, migration 0001's public-read policy):
 * a game is playable if and only if it has a live share. Everything is served from object storage;
 * the server never runs the game.
 *
 * In production the play bucket is fronted by CloudFront on a separate origin, and this loader is a
 * local-dev / fallback path — but it is written to be correct on its own, because "correct only behind
 * a CDN we haven't configured yet" is how a share path ships broken.
 */
import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getProjectStore } from '~/lib/.server/projects/store';
import { getObjectStore } from '~/lib/.server/storage';
import {
  buildContentKey,
  cacheControlFor,
  isPlayServableInProduction,
  resolvePlayOrigin,
} from '~/lib/.server/share/serve';
import { contentTypeFor } from '~/lib/.server/share/publish';
import { renderPlayWrapper } from '~/lib/.server/share/wrapper';

function notFound(): Response {
  return new Response('This game is not available.', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/**
 * Refuse (fail closed) to serve a shared build same-origin in production (§5). A game is user code; on
 * the app origin its JS could read app cookies. Only the play PATH is refused, never the whole app.
 */
function playNotIsolated(): Response {
  return new Response(
    'This game cannot be served from this origin. The play domain (PLAY_URL) is not configured on this server.',
    { status: 503, headers: { 'content-type': 'text/plain' } },
  );
}

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  // params['*'] is "abc" for /play/abc, "abc/assets/x.js" for the nested asset.
  const splat = params['*'] ?? '';
  const slash = splat.indexOf('/');
  const shareId = slash === -1 ? splat : splat.slice(0, slash);
  const rest = slash === -1 ? '' : splat.slice(slash + 1);

  if (!shareId) {
    return notFound();
  }

  /*
   * In production, refuse to serve a shared build without a genuinely separate play origin (§5). This
   * loader is a local-dev / fallback path (CloudFront serves the real bytes on PLAY_URL); reaching it
   * in production with PLAY_URL unset would serve user code on the app origin — a cross-site hole.
   */
  if (!isPlayServableInProduction(context)) {
    return playNotIsolated();
  }

  const project = await getProjectStore(context).getByShareId(shareId);

  // No project, or the share was pulled (id kept, `sharedAt` cleared) → gone. Same answer either way.
  if (!project || !project.sharedAt) {
    return notFound();
  }

  const wantsWrapper = rest === '' || rest === 'play' || rest === 'index';

  // The bare /play/:shareId URL is the shell page: it frames the game and overlays the badge.
  if (wantsWrapper && !isAssetRequest(request)) {
    const origin = resolvePlayOrigin(context);
    const html = renderPlayWrapper({
      shareId,
      title: project.shareTitle || project.name,
      description: project.shareDescription,
      solo: project.soloLaunch ?? false,
      playOrigin: origin.origin,
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

  // Otherwise: serve a build file's bytes.
  let key: string;

  try {
    key = buildContentKey(shareId, rest);
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

/** A request for `/play/:id` that is really an asset fetch (has an extension) is not a wrapper request. */
function isAssetRequest(request: Request): boolean {
  return /\.[a-z0-9]+$/i.test(new URL(request.url).pathname);
}
