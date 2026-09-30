/**
 * Local-scene URL rules (D22, D27). Scenes are served from the exporter dev server, never copied into the project (D60).
 *
 * "Local" means the user's own machine: a Unity dev server on `localhost`/loopback, on an origin that
 * is NOT the page's own (the preview itself is served from somewhere, and its own requests are not a
 * local-scene problem). The same host rule is inlined in `app/lib/preview/agent-script.ts`, which cannot
 * import it (it is serialized with `String(fn)`); keep the two in step.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** An http(s) URL on a loopback host, and not on `pageOrigin`. `false` for anything that does not parse. */
export function isLocalDevUrl(raw: string, pageOrigin?: string): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    return false;
  }

  return pageOrigin === undefined || url.origin !== pageOrigin;
}

const SCENE_EXTENSIONS = /\.(gz\.gltf|gltf|gz\.glb|glb)$/i;

/** The last path segment of `raw`, percent-decoded (raw on a malformed escape). */
export function lastPathSegment(raw: string): string {
  let path: string;

  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.split(/[?#]/)[0];
  }

  const segment = path.split('/').filter(Boolean).pop() ?? '';

  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The scene's folder name: basename without its scene extension, `[^A-Za-z0-9_-]` → `-`. */
export function sceneNameFromUrl(raw: string): string {
  const name = lastPathSegment(raw)
    .replace(SCENE_EXTENSIONS, '')
    .replace(/[^A-Za-z0-9_-]/g, '-');

  return name || 'scene';
}
