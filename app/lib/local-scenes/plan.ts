/**
 * What a local-scene import copies (D22). Pure: given the scene URL and (for a `.gltf`) its parsed JSON,
 * decide every file to fetch and where it lands — always under `public/scenes/<name>/`, never outside.
 *
 * Only in-root relative URIs travel. An embedded `data:` URI is already inside the scene; an absolute
 * URL is someone else's server; and a URI that climbs out of the scene folder (`..`, a leading `/`)
 * would write outside `public/scenes/<name>/`, which is exactly what this planner exists to prevent.
 */
import { lastPathSegment, sceneNameFromUrl } from './url';

export interface SceneImportPlan {
  name: string;
  files: Array<{ url: string; dest: string }>;
  skipped: Array<{ uri: string; reason: string }>;

  /**
   * Set when the scene itself cannot be imported safely (its own file name is not a plain file name);
   * `files` is then EMPTY. Additive — every valid plan leaves it undefined.
   */
  error?: string;
}

/**
 * 🔴 The scene URL's OWN basename is decoded AFTER the path is split, so `..%2F..%2Fsrc%2Fapp.tsx` is one
 * URL segment that decodes to `../../src/app.tsx`. A basename must therefore be a plain file name: no
 * separator of either kind, no NUL, and not `.`/`..`.
 */
function isPlainFileName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/**
 * A referenced URI, decoded, as a path INSIDE the scene folder — or `null` when it is not one.
 * `.` and empty segments are dropped (`./tex/a.png` is ordinary glTF); a `..` segment, a NUL, or a
 * leading separator refuses. Backslashes count as separators, because a Windows exporter can write them.
 */
function containedPath(decoded: string): string | null {
  if (decoded.includes('\0') || /^[/\\]/.test(decoded)) {
    return null;
  }

  const segments = decoded.split(/[/\\]/).filter((segment) => segment !== '' && segment !== '.');

  if (segments.length === 0 || segments.includes('..')) {
    return null;
  }

  return segments.join('/');
}

/**
 * A skipped URI is reported back to the model (T19's tool result) and the user, and an embedded `data:`
 * URI can be megabytes of base64 — so the REPORT carries a bounded prefix, never the payload.
 */
const MAX_REPORTED_URI = 120;
const reportUri = (uri: string) => (uri.length > MAX_REPORTED_URI ? uri.slice(0, MAX_REPORTED_URI) + '…' : uri);

function referencedUris(gltfJson: unknown): string[] {
  const json = gltfJson as { buffers?: unknown; images?: unknown } | null;
  const uris: string[] = [];

  for (const list of [json?.buffers, json?.images]) {
    if (!Array.isArray(list)) {
      continue;
    }

    for (const item of list) {
      /* No `uri` means the data lives in a bufferView / the GLB's own chunk — nothing to copy. */
      const uri = (item as { uri?: unknown } | null)?.uri;

      if (typeof uri === 'string' && uri.length > 0) {
        uris.push(uri);
      }
    }
  }

  return uris;
}

export function planSceneImport(sceneUrl: string, gltfJson: unknown | null): SceneImportPlan {
  const name = sceneNameFromUrl(sceneUrl);
  const base = `public/scenes/${name}/`;
  const basename = lastPathSegment(sceneUrl) || `${name}.gltf`;

  if (!isPlainFileName(basename)) {
    return {
      name,
      files: [],
      skipped: [],
      error:
        `Refusing to import ${sceneUrl}: its file name "${reportUri(basename)}" is not a plain file name, ` +
        `so it could be written outside public/scenes/${name}/.`,
    };
  }

  const files: SceneImportPlan['files'] = [{ url: sceneUrl, dest: base + basename }];
  const skipped: SceneImportPlan['skipped'] = [];

  if (gltfJson !== null) {
    for (const uri of referencedUris(gltfJson)) {
      if (uri.startsWith('data:')) {
        skipped.push({ uri: reportUri(uri), reason: 'embedded data URI' });
        continue;
      }

      // Any scheme counts, not only `x://` — `https:evil.com/x.png` and `file:x.png` resolve off-origin.
      if (uri.includes('://') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) || uri.startsWith('//')) {
        skipped.push({ uri: reportUri(uri), reason: 'absolute URL — not copied' });
        continue;
      }

      let decoded: string;

      try {
        decoded = decodeURIComponent(uri);
      } catch {
        skipped.push({ uri: reportUri(uri), reason: 'malformed URI — not copied' });
        continue;
      }

      const inside = containedPath(decoded);

      if (inside === null) {
        skipped.push({ uri: reportUri(uri), reason: 'outside the scene folder' });
        continue;
      }

      let url: string;

      try {
        url = new URL(uri, sceneUrl).href;
      } catch {
        skipped.push({ uri: reportUri(uri), reason: 'malformed URI — not copied' });
        continue;
      }

      files.push({ url, dest: base + inside });
    }
  }

  /*
   * Backstop: whatever the rules above decided, every dest must still be a normalised path under
   * `base`. A rule edited later that lets one through is dropped here rather than written.
   */
  const contained = files.filter((file) => {
    const rest = file.dest.startsWith(base) ? file.dest.slice(base.length) : null;

    return rest !== null && containedPath(rest) === rest;
  });

  if (contained.length === 0 || contained[0] !== files[0]) {
    return {
      name,
      files: [],
      skipped,
      error: `Refusing to import ${sceneUrl}: it would be written outside public/scenes/${name}/.`,
    };
  }

  const seen = new Set<string>();

  return {
    name,
    files: contained.filter((file) => (seen.has(file.dest) ? false : (seen.add(file.dest), true))),
    skipped,
  };
}
