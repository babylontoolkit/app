/**
 * The public play-page shell (SPEC §4.8, §5).
 *
 * A full-screen page that frames the game and overlays two things §4.8 requires: the
 * "Made with Babylon Toolkit — Remix this game" badge (the growth loop) and a Report link (the
 * moderation path, §5). The game itself runs in the iframe; this shell is OUR trusted markup.
 *
 * **Everything user-supplied is escaped.** The title and description come from the project owner, and
 * a shared page is public — an unescaped `<script>` in a game title is stored XSS on the play origin.
 * `escapeHtml` is applied to every interpolated value without exception; there is no "this one is
 * safe" case, because the moment there is, someone adds a second one that isn't.
 *
 * The badge/report links are RELATIVE — the shell is served from the app origin, so `/remix/:id` and
 * `/api/play/:id/report` resolve to us. Only the iframe `src` crosses to the play origin.
 */
import { escapeHtml } from '~/utils/escapeHtml';
import { brand } from '~/config/brand';

export interface PlayWrapperInput {
  shareId: string;
  title: string;
  description?: string;

  /** Network-capable game → append `?solo=true` so it launches without waiting for a peer (§4.8). */
  solo: boolean;

  /** Absolute play origin, or '' for same-origin (local dev). */
  playOrigin: string;
}

export function renderPlayWrapper(input: PlayWrapperInput): string {
  const { shareId, solo, playOrigin } = input;
  const title = escapeHtml(input.title);
  const description = input.description ? escapeHtml(input.description) : '';

  const base = playOrigin ? `${playOrigin}/${encodeURIComponent(shareId)}` : `/play/${encodeURIComponent(shareId)}`;

  /*
   * The iframe loads the DIRECTORY URL, never `/index.html` (T17b). The game is a BrowserRouter app
   * whose basename resolves to `/play/<id>/` at runtime — a document URL ending in `index.html` leaves
   * `index.html` as the route path, which matches nothing and renders a blank page. `?embed=1` is what
   * tells the serve layer "this request wants the game document, not the wrapper" (`resolvePlayRequest`
   * — without it, the extensionless directory URL would serve the wrapper again, recursively).
   */
  /*
   * 🔴 `__nodepod=host` is what keeps the published game from being replaced by the BUILDER'S SANDBOX
   * (found live 2026-08-01, local dev only). Nodepod registers a service worker at the root of our
   * origin to serve pod previews, and its fetch handler cannot tell one of OUR same-origin iframes from
   * a preview — so its recovery rule adopts ANY unattributed frame into whatever pod is currently live
   * and proxies it to that pod's dev server. The share page then renders the BUILDER's Vite app
   * (`/@vite/client`, `/src/main.tsx`) instead of the built game: a blank screen, with the only trace a
   * console warning about routes not matching. Every asset still 200s, so it looks like a working
   * publish.
   *
   * Production is unaffected — `PLAY_URL` makes this iframe cross-origin, and the worker passes
   * cross-origin straight through — which is exactly why this could hide: it breaks only where the
   * game is developed, never where it is shipped.
   *
   * The parameter is answered by the worker BEFORE any claim rule (`static/__sw__.js` rule 1b in our
   * fork). It must survive on the DIRECTORY url the iframe loads; the game's own subresources need no
   * marker, because a frame that was never claimed leaves nothing for them to be attributed to.
   */
  const gameSrc = `${base}/?embed=1&__nodepod=host${solo ? '&solo=true' : ''}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title}</title>
${description ? `<meta name="description" content="${description}" />` : ''}
<meta property="og:title" content="${title}" />
${description ? `<meta property="og:description" content="${description}" />` : ''}
<meta property="og:type" content="website" />
<style>
  html, body { margin: 0; height: 100%; background: #0b0d12; overflow: hidden; font-family: system-ui, sans-serif; }
  #game { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  #badge {
    position: fixed; left: 12px; bottom: 12px; z-index: 10;
    display: flex; gap: 10px; align-items: center;
    padding: 8px 12px; border-radius: 10px;
    background: rgba(12, 14, 20, 0.72); backdrop-filter: blur(8px);
    color: #e7e9ee; font-size: 13px; line-height: 1;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  }
  #badge a { color: #9db4ff; text-decoration: none; font-weight: 600; }
  #badge a:hover { text-decoration: underline; }
  #badge .made { opacity: 0.7; }
  #badge .sep { opacity: 0.3; }
  #report { background: none; border: 0; color: #7f8694; cursor: pointer; font-size: 13px; padding: 0; }
  #report:hover { color: #c2c7d0; }
</style>
</head>
<body>
<iframe
  id="game"
  src="${gameSrc}"
  title="${title}"
  allow="accelerometer; gamepad; fullscreen; autoplay; xr-spatial-tracking"
  allowfullscreen
></iframe>
<div id="badge">
  <span class="made">${escapeHtml(brand.playBadgeAttribution)}</span>
  <span class="sep">·</span>
  <a href="/remix/${encodeURIComponent(shareId)}">${escapeHtml(brand.playBadgeRemixLabel)}</a>
  <span class="sep">·</span>
  <button id="report" type="button">Report</button>
</div>
<script>
  document.getElementById('report').addEventListener('click', function () {
    var reason = window.prompt('Report this game to the moderators. What is wrong with it?');
    if (!reason) { return; }
    fetch('/api/play/${encodeURIComponent(shareId)}/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason })
    }).then(function () { window.alert('Thank you — a moderator will review this game.'); })
      .catch(function () { window.alert('Could not send the report. Please try again later.'); });
  });
</script>
</body>
</html>`;
}
