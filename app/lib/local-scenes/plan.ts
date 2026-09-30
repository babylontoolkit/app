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

  /**
   * `optional` marks a file found in an `extras` string rather than in `buffers`/`images`: the exporter's
   * metadata can name a file it never wrote (a skybox that was not baked), so a 404 on one is reported as
   * skipped instead of failing the whole import. Absent on every core file.
   */
  files: Array<{ url: string; dest: string; optional?: boolean }>;
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

/**
 * The file types a Babylon Toolkit scene names in its `extras` metadata (environment maps, light-probe
 * and nav-mesh sidecars, the project script bundle, textures, audio, gzip sidecars, wasm). A string must
 * END in one of these to count as a file — `TOOLKIT.LightProbeNetwork`, a GUID, `"birp"` or a class name
 * never does, so an unknown field is never fetched.
 */
const EXTRAS_FILE_EXTENSIONS = [
  'env',
  'bin',
  'js',
  'json',
  'ktx',
  'ktx2',
  'dds',
  'hdr',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'basis',
  'gz',
  'wasm',
  'mp3',
  'ogg',
  'wav',
  'glb',
  'gltf',
];
const EXTRAS_FILE_PATTERN = new RegExp(`^[^\\s?#]+\\.(?:${EXTRAS_FILE_EXTENSIONS.join('|')})$`, 'i');
const MAX_EXTRAS_REFERENCE = 512;

/**
 * Keys whose string value is a LABEL, not a location. A Toolkit skybox carries
 * `environment.info.name = "procedural_skybox_ibl.env"` beside the real `environment.url =
 * "assets/procedural_skybox_ibl.env"`; the name is not a path from the scene folder.
 */
const EXTRAS_LABEL_KEYS = new Set(['name']);

function collectExtrasStrings(value: unknown, key: string | null, out: string[]): void {
  if (typeof value === 'string') {
    if (
      key !== null &&
      !EXTRAS_LABEL_KEYS.has(key) &&
      value.length <= MAX_EXTRAS_REFERENCE &&
      EXTRAS_FILE_PATTERN.test(value)
    ) {
      out.push(value);
    }

    return;
  }

  if (Array.isArray(value)) {
    // An array element inherits its array's key (`files: ["a.bin", "b.bin"]`).
    for (const item of value) {
      collectExtrasStrings(item, key, out);
    }

    return;
  }

  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectExtrasStrings(child, childKey, out);
    }
  }
}

/**
 * Every file-like string under every `extras` object in the document (asset, scenes, nodes, materials,
 * textures, …). This is how a Toolkit scene names its sidecars — and its project script bundle:
 * `scenes[0].extras.metadata.project = "<project>.js"`, which the runtime loads from
 * `rootUrl + project` (`SceneManager.getScriptBundleUrl`), i.e. from the scene's own folder. It is
 * REFERENCED, not loaded by convention, so it travels through the same rules as any other URI.
 */
function extrasReferences(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      extrasReferences(item, out);
    }

    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'extras') {
      collectExtrasStrings(child, null, out);
    } else {
      extrasReferences(child, out);
    }
  }
}

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
    const core = referencedUris(gltfJson);
    const extras: string[] = [];
    extrasReferences(gltfJson, extras);

    const candidates = [
      ...core.map((uri) => ({ uri, optional: false })),
      ...extras.map((uri) => ({ uri, optional: true })),
    ];

    for (const { uri, optional } of candidates) {
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

      files.push(optional ? { url, dest: base + inside, optional: true } : { url, dest: base + inside });
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
