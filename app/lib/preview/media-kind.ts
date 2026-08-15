/**
 * What a binary file IS, for the Code-view preview (SPEC §4.1b, FR-2/FR-3).
 *
 * 🔴 **Kind is chosen by EXTENSION, deliberately — a byte sniffer here would be a SECOND detector.**
 * The dev server has already decided this file's `Content-Type` from its extension (the starter's
 * `MEDIA_MIME_TYPES` middleware), and the browser will sniff the response regardless. A magic-number
 * check in this repo could therefore disagree with the header the element actually receives, and the
 * loser of that disagreement is the user — so there is exactly one detector and this mirrors it.
 * Contrast `app/lib/media/sniff.ts`, which sniffs bytes precisely because it is checking a PROVIDER'S
 * CLAIM about bytes we hold; here we hold nothing and are agreeing with a server we control.
 *
 * `null` from {@link mediaKindForPath} is a CORRECT ANSWER, not a failure: `havok.wasm` is not
 * renderable and saying so by name is the honest result (FR-3).
 */

import { formatSize } from '~/utils/formatSize';

/**
 * A verbatim mirror of the starter template's `MEDIA_MIME_TYPES`.
 *
 * Source: `babylontoolkit/AppTemplate @ vite.config.ts → MEDIA_MIME_TYPES` (34 entries, leading dots,
 * lowercase). ⚠️ **This is a CROSS-REPO COUPLING and only a test can enforce it** — the template lives
 * in another repository, so a drift here fails silently: this repo would decline to render an extension
 * the dev server serves perfectly well. The pin belongs in `media-kind.spec.ts` and must compare BOTH
 * directions plus a length equality, because a per-entry comparison cannot notice the list SHRINKING.
 *
 * This is the drift anchor, **not** the render list — see {@link mediaKindForPath} for what is
 * actually drawn. Every extension here should be in exactly one of "rendered" or
 * {@link DELIBERATELY_NOT_RENDERED}, so that the template GAINING an extension fails a test here
 * rather than being silently ignored.
 *
 * ⚠️ The template's middleware also normalises three gzip double-extensions (`.gz.gltf` → `.gltf`,
 * `.gz.glb`, `.gz.bin`) before its lookup. None of those three is a rendered kind, so this module does
 * not replicate the normalisation — a naive last-dot read reaches the same answer. Noted so a future
 * reader does not mistake the omission for an oversight.
 */
export const TEMPLATE_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  // 3D models
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',

  // Images — raster
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',

  // Images — HDR / compressed textures (Babylon)
  '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream',
  '.ktx': 'image/ktx',
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.dds': 'application/octet-stream',

  // Audio
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',

  // Video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

export type MediaKind = 'image' | 'video' | 'audio';

/**
 * The extensions actually drawn, per kind.
 *
 * The rule is **"can a mainstream browser decode this in this element?"**, not "is it media" — an
 * element that renders a black rectangle or a broken-image icon is worse than a sentence naming the
 * file, because the first reads as the tool being broken and the second reads as an answer.
 *
 * 🔴 **Membership here is decided by MEASUREMENT, never by `canPlayType` and never by reasoning.**
 * Measured 2026-08-15 by loading real ffmpeg-encoded files off the running dev server into real
 * elements (`loadedmetadata` vs `error`), because `canPlayType` answers a question about a MIME STRING
 * and the browser then goes and sniffs the container anyway. It was wrong in BOTH directions on the
 * files this project actually holds: it rejects `audio/opus` and `video/quicktime`, yet `.opus` and
 * `.mov` both play (3.01s / 320×180); and it accepts `video/x-matroska`, which is right, while the dev
 * server sends `.mkv` with NO `Content-Type` at all — so the template's MIME map is not what makes it
 * work. **Adding an extension here without loading one is how a black rectangle ships.**
 */
export const RENDERED: Readonly<Record<MediaKind, readonly string[]>> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.ico', '.apng', '.svg'],
  video: ['.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv', '.3gp'],
  audio: ['.mp3', '.ogg', '.oga', '.wav', '.aac', '.flac', '.m4a', '.opus', '.weba', '.mka'],
};

/**
 * Extensions we render that the template's `MEDIA_MIME_TYPES` does NOT carry, and the evidence.
 *
 * The rendered set is deliberately allowed to EXCEED the template map, because the two answer
 * different questions — the map says "what does the starter's middleware explicitly type?", this says
 * "what can the browser display?" — and the measurement below proved they are not the same set. But
 * the excess is enumerated rather than merely permitted: without this list, "the rendered set may go
 * beyond the template" degrades into "nothing checks the rendered set at all", which is the drift
 * `TEMPLATE_MEDIA_EXTENSIONS` exists to prevent, arriving through the back door.
 *
 * Every entry states how the file actually reached the element, measured 2026-08-15 on Nodepod.
 */
export const RENDERED_WITHOUT_TEMPLATE_MIME: Readonly<Record<string, string>> = {
  '.mkv': 'dev server sends NO Content-Type; Chrome sniffs Matroska — measured PLAYS, 3.0s, 320×180',
  '.mka': 'dev server sends NO Content-Type; sniffed as Matroska audio — measured PLAYS, 3.0s',
  '.oga': "typed `audio/ogg` by Vite's own MIME table, not by the template — measured PLAYS, 3.01s",
  '.3gp': "typed `video/3gpp` by Vite's own MIME table — measured PLAYS, 3.0s, 320×180",
  '.apng': "typed `image/apng` by Vite's own MIME table — measured RENDERS, 320×180 (animated PNG)",
};

/**
 * Every template extension NOT drawn, and why.
 *
 * Written down rather than left as the absence of a list entry, because "we forgot it" and "a browser
 * cannot show it" are indistinguishable from the outside — and the second is a decision that deserves
 * a reason someone can disagree with. Asserting that this set plus the rendered set covers the whole
 * template map is what stops a new template extension landing in neither.
 */
export const DELIBERATELY_NOT_RENDERED: Readonly<Record<string, string>> = {
  '.ktx': 'GPU texture container — decoded by the GPU, not by an <img>',
  '.ktx2': 'GPU texture container — decoded by the GPU, not by an <img>',
  '.basis': 'GPU texture container — decoded by the GPU, not by an <img>',
  '.dds': 'GPU texture container — decoded by the GPU, not by an <img>',
  '.hdr': 'high-dynamic-range image — no browser renders it natively',
  '.exr': 'high-dynamic-range image — no browser renders it natively',
  '.gltf': '3D scene payload — a viewer, not an image (out of scope here)',
  '.glb': '3D scene payload — a viewer, not an image (out of scope here)',
  '.bin': 'opaque buffer, usually a glTF payload — nothing to show',
  '.tiff': 'MEASURED 2026-08-15: a real TIFF off the dev server fires `error` on an <img>',
  '.tif': 'MEASURED 2026-08-15: a real TIFF off the dev server fires `error` on an <img>',
  '.avi':
    'MEASURED 2026-08-15, and the ONE the user explicitly asked for: a real AVI served as ' +
    '`video/x-msvideo` fails with `DEMUXER_ERROR_COULD_NOT_OPEN` — Chrome has no AVI demuxer. ' +
    'Rendering it would replace `AVI video — 86.1 KB` with a permanently black <video>, which is ' +
    'exactly the trade FR-3 refuses. Also FAILS by the same measurement: .mpg, .wmv, .ts, .aiff, ' +
    '.caf, .wma (all MEDIA_ERR_DECODE) — none of which the template serves either.',
};

/**
 * TEXT files we preview anyway — the answer to spec OQ-1 (owner, 2026-08-15: *"let make svg show up a
 * render image like other images"*).
 *
 * 🔴 **This is the ONE place the `isBinary` gate is deliberately not the whole rule.** Every other file
 * this viewer draws is binary, so `doc.isBinary` decided everything; SVG is markup, `isBinaryBuffer`
 * correctly types it as text, and it therefore never reached the viewer at all. Rendering it needs an
 * explicit, enumerated exception rather than a loosening of the binary test — a predicate like "does it
 * look like an image?" would start swallowing source files whose names happen to end in a media
 * extension, and the file it swallowed would be one the user can no longer edit.
 *
 * ⚠️ **And that is why the source is never taken away.** The spec's own OQ-1 note says editing SVG
 * source is legitimate and warns against silently rerouting it — `icons.svg` in the starter is
 * hand-edited markup. So the preview is the DEFAULT, not the only option: `BinaryPreview` offers a
 * Source toggle for exactly the files in this set, and the editor underneath is untouched and still
 * live. A viewer that replaces an editor is a feature; one that removes it is a regression.
 */
const PREVIEWABLE_TEXT_MEDIA = ['.svg'];

/** Is this a TEXT file the Code view should preview rather than open as source by default? */
export function isPreviewableTextMedia(filePath: string): boolean {
  return PREVIEWABLE_TEXT_MEDIA.includes(extensionOf(filePath));
}

/** Human names for the binaries a project actually contains, so FR-3 can say what it found. */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  '.wasm': 'WebAssembly module',
  '.ttf': 'TrueType font',
  '.otf': 'OpenType font',
  '.woff': 'Web font',
  '.woff2': 'Web font',
  '.eot': 'Embedded OpenType font',
  '.gltf': 'glTF scene',
  '.glb': 'glTF binary scene',
  '.bin': 'Binary buffer',
  '.ktx': 'KTX texture',
  '.ktx2': 'KTX2 texture',
  '.basis': 'Basis texture',
  '.dds': 'DDS texture',
  '.hdr': 'HDR image',
  '.exr': 'OpenEXR image',
  '.tiff': 'TIFF image',
  '.tif': 'TIFF image',
  '.avi': 'AVI video',
  '.mpg': 'MPEG video',
  '.mpeg': 'MPEG video',
  '.wmv': 'Windows Media video',
  '.flv': 'Flash video',
  '.wma': 'Windows Media audio',
  '.aiff': 'AIFF audio',
  '.aif': 'AIFF audio',
  '.caf': 'Core Audio file',
  '.amr': 'AMR audio',
  '.mid': 'MIDI sequence',
  '.midi': 'MIDI sequence',
  '.zip': 'ZIP archive',
  '.gz': 'gzip archive',
  '.pdf': 'PDF document',
  '.ttc': 'TrueType collection',
  '.mo': 'Compiled translations',
  '.db': 'Database file',
  '.node': 'Native Node addon',
};

/**
 * The lowercased extension INCLUDING its dot, or `''` when there is none.
 *
 * `dot > 0` is load-bearing: a dotfile (`.env`, `.gitignore`) has its only dot at index 0 of the
 * basename and has no extension at all. Reading `lastIndexOf('.')` without that guard makes `.env`
 * an extension named `.env`, which is how a config file starts being treated as a media type.
 */
function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');

  return dot > 0 ? base.slice(dot) : '';
}

/**
 * Which element should draw this file, or `null` for "name it instead" (FR-3).
 *
 * Case-insensitive, because a file map carries whatever the artist typed (`HERO.PNG` is routine).
 */
export function mediaKindForPath(filePath: string): MediaKind | null {
  const ext = extensionOf(filePath);

  if (!ext) {
    return null;
  }

  for (const kind of Object.keys(RENDERED) as MediaKind[]) {
    if (RENDERED[kind].includes(ext)) {
      return kind;
    }
  }

  return null;
}

/**
 * FR-3's sentence: what this file is, and how big — e.g. `WebAssembly module — 2.0 MB`.
 *
 * 🔴 **A refusal that names no cause reads as the tool being broken.** That is the whole lesson of
 * `share/build-failure.ts`, where "the project failed to build" sent users hunting for an error the
 * product already knew the file and line of; told to accept something unnamed, the only available
 * conclusion is that the feature is at fault. So this never returns a generic string: an unmapped
 * extension is quoted back verbatim (`.xyz file — 12 KB`), which is still strictly more than the
 * caller knew.
 *
 * `size` is `undefined` when the file map has no `size` for the entry — the sentence then names the
 * type alone rather than inventing a number.
 */
export function describeUnrenderable(filePath: string, size: number | undefined): string {
  if (size === 0) {
    return 'Empty file';
  }

  const ext = extensionOf(filePath);
  const name = TYPE_NAMES[ext] ?? (ext ? `${ext} file` : 'Binary file');

  if (size === undefined || !Number.isFinite(size) || size < 0) {
    return name;
  }

  return `${name} — ${formatSize(size)}`;
}
