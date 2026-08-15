/**
 * What a binary file IS, for the Code-view preview (T3, SPEC §4.1b, FR-2/FR-3).
 *
 * Two things are asserted here and they fail in opposite directions:
 *
 *   - **{@link mediaKindForPath} routes to an ELEMENT.** Answering `'image'` for a `.ktx2` draws a
 *     broken-image icon, which reads as the tool being broken; answering `null` for a `.png` hides a
 *     file the browser would have shown. Neither throws.
 *   - **{@link describeUnrenderable} is the sentence a user reads when nothing is drawn.** A refusal
 *     that names no cause is read as the button being broken (`share/build-failure.ts`), so "we know
 *     what this is" and "we said what this is" are the same requirement.
 *
 * Every positive assertion below — "png is an image" — passes for a function that calls EVERYTHING an
 * image, and every `describeUnrenderable` assertion passes for a function returning one constant
 * string. The `CONTROLS` block is the only part of this file that can tell those apart; it is not
 * decoration.
 *
 * The cross-repo drift pin (`TEMPLATE_MEDIA_EXTENSIONS` vs the template's own `MEDIA_MIME_TYPES`, the
 * rendered/{@link DELIBERATELY_NOT_RENDERED} partition covering it exhaustively, and the rendered set
 * being allowed to EXCEED it only via the enumerated {@link RENDERED_WITHOUT_TEMPLATE_MIME}) lives at
 * the bottom of this file — added by T6, which is where that block's own reasoning is written down.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIBERATELY_NOT_RENDERED,
  RENDERED,
  RENDERED_WITHOUT_TEMPLATE_MIME,
  TEMPLATE_MEDIA_EXTENSIONS,
  describeUnrenderable,
  isPreviewableTextMedia,
  mediaKindForPath,
  type MediaKind,
} from './media-kind';

describe('mediaKindForPath', () => {
  /*
   * Three real extensions per kind, never one: a single example per kind is satisfied by a lookup that
   * happens to contain three entries, and the container formats below (`.ktx2`, `.avi`) are the ones a
   * "looks like media, therefore render it" implementation gets wrong.
   */
  it('draws the raster image formats a browser decodes in an <img>', () => {
    expect(mediaKindForPath('public/assets/hero.png')).toBe('image');
    expect(mediaKindForPath('public/assets/hero.jpg')).toBe('image');
    expect(mediaKindForPath('public/assets/hero.webp')).toBe('image');
    expect(mediaKindForPath('public/assets/hero.gif')).toBe('image');
  });

  /*
   * SVG is an image kind as of 2026-08-15 (owner: *"let make svg show up a render image like other
   * images"*). It is the one rendered extension that is NOT a binary — `isBinaryBuffer` correctly types
   * markup as text — so it reaches the viewer through `isPreviewableTextMedia` rather than through
   * `doc.isBinary`, and this assertion is about the OTHER half: once it gets there, it must route to an
   * `<img>` like every other image. A `.svg` left out of `RENDERED` would mount the viewer over the
   * editor and then draw `describeUnrenderable`'s sentence — the file hidden behind a refusal to show
   * it, which is strictly worse than never having previewed it at all.
   */
  it('draws .svg as an image', () => {
    expect(mediaKindForPath('/home/project/public/icons.svg')).toBe('image');
    expect(mediaKindForPath('public/assets/logo.SVG')).toBe('image');
  });

  it('draws the video formats a browser plays in a <video>', () => {
    expect(mediaKindForPath('public/assets/intro.mp4')).toBe('video');
    expect(mediaKindForPath('public/assets/intro.webm')).toBe('video');
    expect(mediaKindForPath('public/assets/intro.mov')).toBe('video');
  });

  it('draws the audio formats a browser plays in an <audio>', () => {
    expect(mediaKindForPath('public/audio/engine.mp3')).toBe('audio');
    expect(mediaKindForPath('public/audio/engine.wav')).toBe('audio');
    expect(mediaKindForPath('public/audio/engine.ogg')).toBe('audio');
  });

  /*
   * The formats measured into the render list on 2026-08-15, kept as their own case because they are
   * the ones the template's `MEDIA_MIME_TYPES` does NOT type: they reach the element through Vite's own
   * MIME table or through the browser sniffing a container with no `Content-Type` at all. A test that
   * only ever names template extensions would go green with every one of these silently dropped.
   */
  it('draws the measured extensions the template map does not type', () => {
    expect(mediaKindForPath('public/clips/capture.mkv')).toBe('video');
    expect(mediaKindForPath('public/clips/capture.3gp')).toBe('video');
    expect(mediaKindForPath('public/audio/engine.oga')).toBe('audio');
    expect(mediaKindForPath('public/audio/engine.mka')).toBe('audio');
    expect(mediaKindForPath('public/assets/hero.apng')).toBe('image');
  });

  /*
   * 🔴 `null` is a CORRECT ANSWER, not a failure. `havok.wasm` is 2MB of nothing to look at and
   * `.ktx2` is decoded by the GPU — an element pointed at either renders a black rectangle or a broken
   * icon, which is strictly worse than a sentence naming the file (FR-3). `.tiff` and `.avi` are the
   * traps: both are unambiguously "media" and neither is decodable by a mainstream browser.
   */
  it('answers null for the binaries a browser cannot draw', () => {
    for (const path of [
      'public/havok.wasm',
      'public/fonts/Inter.ttf',
      'public/models/scene.bin',
      'public/models/scene.gltf',
      'public/textures/albedo.ktx2',
      'public/textures/scan.tiff',
      'public/clips/capture.avi',
    ]) {
      expect(mediaKindForPath(path)).toBeNull();
    }
  });

  /* No extension at all — nothing to look up, and guessing would be inventing a type. */
  it('answers null for an extensionless path', () => {
    expect(mediaKindForPath('/home/project/LICENSE')).toBeNull();
    expect(mediaKindForPath('LICENSE')).toBeNull();
  });

  /*
   * A file map carries whatever the artist typed, and `HERO.PNG` off a camera roll or a Windows tool is
   * routine. A case-sensitive lookup renders those as "unknown binary" — visibly wrong, silently.
   */
  it('is case-insensitive about the extension', () => {
    expect(mediaKindForPath('public/assets/HERO.PNG')).toBe('image');
    expect(mediaKindForPath('public/assets/Intro.MP4')).toBe('video');
    expect(mediaKindForPath('public/audio/Engine.WaV')).toBe('audio');
  });

  /*
   * 🔴 A DOTFILE HAS NO EXTENSION. `lastIndexOf('.')` without the `dot > 0` guard reads `.env` as an
   * extension named `.env` — which is the first step to a config file being treated as a media type.
   * `.gitignore` and a dotfile inside a directory that itself has a dot are the same shape.
   */
  it('answers null for a dotfile, which has no extension at all', () => {
    expect(mediaKindForPath('/home/project/.env')).toBeNull();
    expect(mediaKindForPath('/home/project/.gitignore')).toBeNull();
    expect(mediaKindForPath('.env')).toBeNull();
  });

  /*
   * A double extension is read from the LAST dot, so `scene.gz.gltf` is a `.gltf` — not renderable, and
   * not accidentally matched as some `.gz` special case. (The template's middleware normalises the three
   * gzip pairs before ITS lookup; none of them is a rendered kind, so a naive last-dot read agrees.)
   */
  it('reads a double extension from the last dot', () => {
    expect(mediaKindForPath('public/models/scene.gz.gltf')).toBeNull();
    expect(mediaKindForPath('public/models/scene.gz.bin')).toBeNull();

    /* The same rule the other way: a dotted stem must not hide a renderable extension. */
    expect(mediaKindForPath('public/assets/hero.v2.final.png')).toBe('image');
  });

  /* The extension is read from the BASENAME — a dot in a directory name is not the file's type. */
  it('ignores dots in directory names', () => {
    expect(mediaKindForPath('/home/project/some.dir/hero.png')).toBe('image');
    expect(mediaKindForPath('/home/project/some.png/LICENSE')).toBeNull();
  });
});

/*
 * ── isPreviewableTextMedia — the ONE place `doc.isBinary` is not the whole rule ──────────────────
 *
 * Every other file this viewer draws is binary, so `doc.isBinary` decided everything. SVG is markup:
 * it is correctly typed as TEXT, it never reached the viewer, and rendering it needs an explicit
 * enumerated exception. Two things fail in opposite directions and neither throws:
 *
 *   - answering FALSE for `.svg` puts the feature back where it started (the owner's request silently
 *     undone — an SVG opens as source and nothing says why);
 *   - answering TRUE for anything else mounts the viewer over a file that has no preview to show, and
 *     — because `CodeMirrorEditor` passes `sourceAvailable={!doc.isBinary}` — hands every genuine
 *     binary a Source toggle onto an editor that was never populated (§4.1a's dead-end rule).
 */
describe('isPreviewableTextMedia', () => {
  it('is true for .svg, case-insensitively', () => {
    expect(isPreviewableTextMedia('/home/project/public/icons.svg')).toBe(true);

    /* A file map carries whatever the artist typed — `ICONS.SVG` off a Windows tool is routine. */
    expect(isPreviewableTextMedia('/home/project/public/ICONS.SVG')).toBe(true);
    expect(isPreviewableTextMedia('public/assets/Logo.Svg')).toBe(true);
  });

  it('is false for the binaries — they have no source to fall back to', () => {
    for (const path of [
      'public/assets/hero.png',
      'public/clips/intro.mp4',
      'public/audio/engine.mp3',
      'public/havok.wasm',
      'public/models/scene.glb',
    ]) {
      expect(isPreviewableTextMedia(path), `${path} is a binary — there is no source behind it`).toBe(false);
    }
  });

  it('is false for ordinary source files', () => {
    /*
     * The direction that would be catastrophic rather than merely wrong: a predicate that answered
     * "does this look like media?" would start covering the editor for files whose only crime is their
     * name, and the file it covered is one the user can no longer edit by default.
     */
    expect(isPreviewableTextMedia('src/scripts/KartMode.ts')).toBe(false);
    expect(isPreviewableTextMedia('src/pages/Home.tsx')).toBe(false);
    expect(isPreviewableTextMedia('src/pages/Home.css')).toBe(false);
    expect(isPreviewableTextMedia('README.md')).toBe(false);
  });

  it('is false for a path with no extension at all', () => {
    expect(isPreviewableTextMedia('/home/project/LICENSE')).toBe(false);
    expect(isPreviewableTextMedia('LICENSE')).toBe(false);

    /* A dotfile has no extension either — the `dot > 0` guard, asked of this predicate. */
    expect(isPreviewableTextMedia('/home/project/.env')).toBe(false);
  });

  it('reads the extension from the last dot of the BASENAME', () => {
    expect(isPreviewableTextMedia('/home/project/some.svg/LICENSE')).toBe(false);
    expect(isPreviewableTextMedia('public/assets/logo.v2.final.svg')).toBe(true);
  });
});

describe('CONTROLS — isPreviewableTextMedia is not a restatement of mediaKindForPath', () => {
  /*
   * 🔴 THE CONTROL THAT MATTERS. Every assertion in the block above passes for an implementation
   * spelled `return mediaKindForPath(filePath) !== null` — `.svg` is a rendered image, so it answers
   * true; `.ts` and `LICENSE` are not, so they answer false. Four of the five negative cases above are
   * satisfied by it too.
   *
   * That implementation is wrong in a way nothing else here can see. `CodeMirrorEditor` passes
   * `sourceAvailable={!doc.isBinary}` — so the two predicates are answering DIFFERENT questions ("draw
   * it" vs "there is text behind it") and collapsing them makes every PNG, MP4 and MP3 claim to have
   * editable source. The user clicks Source on a photograph and gets an empty CodeMirror that
   * `CodeMirrorEditor`'s own `if (doc.isBinary) return;` guarantees was never populated: a control that
   * looks live, does nothing, and cannot be got out of except by reselecting the file.
   *
   * Mutation-verified 2026-08-15: rewriting the body to `mediaKindForPath(filePath) !== null` fails
   * this test and nothing else in the repo.
   */
  it('🔴 CONTROL: a RENDERED binary image is not previewable text', () => {
    /* `.png` is the tell: it renders (so `mediaKindForPath` says image) and has no source behind it. */
    expect(mediaKindForPath('public/assets/hero.png')).toBe('image');
    expect(isPreviewableTextMedia('public/assets/hero.png')).toBe(false);

    /* The same trap in the other two kinds, so a special-case for images alone does not sneak past. */
    expect(mediaKindForPath('public/clips/intro.mp4')).toBe('video');
    expect(isPreviewableTextMedia('public/clips/intro.mp4')).toBe(false);

    expect(mediaKindForPath('public/audio/engine.mp3')).toBe('audio');
    expect(isPreviewableTextMedia('public/audio/engine.mp3')).toBe(false);
  });

  it('CONTROL: it is not answering true for everything, nor false for everything', () => {
    /*
     * The control's own control. The block above is entirely negative, so it passes for a predicate
     * that has stopped working altogether — which would silently return SVG to opening as source.
     */
    expect(isPreviewableTextMedia('public/icons.svg')).toBe(true);
    expect(isPreviewableTextMedia('public/hero.png')).toBe(false);
  });

  it('🔴 every previewable text extension is also a RENDERED kind', () => {
    /*
     * The coupling between the two predicates, stated as the invariant rather than as an example.
     * `CodeMirrorEditor` mounts the viewer when EITHER is true, and `BinaryPreview` then asks
     * `mediaKindForPath` what to draw — so an extension that is previewable-text but not rendered
     * covers a perfectly editable file with `describeUnrenderable`'s "nothing to show here" sentence.
     * Nothing throws; the user simply loses the file behind a refusal.
     *
     * Probed over a domain that is INDEPENDENT of the list under test (the template map plus this
     * feature's own enumerated exceptions), because a domain derived from `PREVIEWABLE_TEXT_MEDIA`
     * could not notice it growing — and `PREVIEWABLE_TEXT_MEDIA` is module-local by design, so
     * probing is the only door.
     */
    const previewableText = PROBE_DOMAIN.filter((ext) => isPreviewableTextMedia(`file${ext}`));

    expect(previewableText, 'the probe found no previewable text media at all').not.toEqual([]);

    for (const ext of previewableText) {
      expect(mediaKindForPath(`file${ext}`), `${ext} opens the viewer but nothing draws it`).not.toBeNull();
    }
  });
});

describe('describeUnrenderable', () => {
  /*
   * FR-3's sentence has to carry BOTH halves. The type alone ("WebAssembly module") leaves the user
   * unable to tell a stub from the real 2MB physics engine; the size alone names nothing.
   */
  it('names both the type and a human-readable size', () => {
    const sentence = describeUnrenderable('public/havok.wasm', 2094566);

    expect(sentence).toContain('WebAssembly module');
    expect(sentence).toContain('MB');
    expect(sentence).toBe('WebAssembly module — 2.0 MB');
  });

  it('names the type for other real project binaries', () => {
    expect(describeUnrenderable('public/fonts/Inter.ttf', 312044)).toContain('TrueType font');
    expect(describeUnrenderable('public/textures/albedo.ktx2', 4096)).toContain('KTX2 texture');
    expect(describeUnrenderable('public/models/scene.gltf', 1024)).toContain('glTF scene');
  });

  /*
   * A zero-byte file is its own diagnosis: "glTF scene — 0.0 B" invites the user to wonder why the
   * scene will not load, where "Empty file" answers it. It also short-circuits BEFORE the extension is
   * read, so it is the one case where the type is deliberately not named.
   */
  it('says "Empty file" at size 0, whatever the extension', () => {
    expect(describeUnrenderable('public/havok.wasm', 0)).toBe('Empty file');
    expect(describeUnrenderable('public/models/scene.gltf', 0)).toBe('Empty file');
    expect(describeUnrenderable('/home/project/.env', 0)).toBe('Empty file');
  });

  /*
   * 🔴 THE UNMAPPED EXTENSION IS QUOTED BACK, NOT GENERALISED. A generic "Unsupported file" is the
   * `share/build-failure.ts` failure exactly: told to accept something unnamed, the only available
   * conclusion is that the feature is broken. `.xyz` is still strictly more than the caller knew.
   */
  it('falls back to the extension itself rather than a generic string', () => {
    const sentence = describeUnrenderable('public/data/blob.xyz', 12288);

    expect(sentence).toContain('.xyz');
    expect(sentence).toBe('.xyz file — 12.0 KB');
  });

  /* Same rule, lowercased — the extension is quoted back canonically, not as typed. */
  it('lowercases the quoted-back extension', () => {
    expect(describeUnrenderable('public/data/BLOB.XYZ', 12288)).toBe('.xyz file — 12.0 KB');
  });

  /*
   * `size` is absent when the file map has no `size` for the entry. Naming the type alone is honest;
   * printing "0.0 B" or "NaN B" would be inventing a number, and a wrong number reads as a real one.
   */
  it('names the type alone when the size is unknown or nonsense', () => {
    expect(describeUnrenderable('public/havok.wasm', undefined)).toBe('WebAssembly module');
    expect(describeUnrenderable('public/havok.wasm', Number.NaN)).toBe('WebAssembly module');
    expect(describeUnrenderable('public/havok.wasm', -1)).toBe('WebAssembly module');
    expect(describeUnrenderable('public/havok.wasm', Number.POSITIVE_INFINITY)).toBe('WebAssembly module');
  });

  /* An extensionless binary still gets a sentence — there is simply no type to name. */
  it('falls back to "Binary file" when there is no extension to quote', () => {
    expect(describeUnrenderable('/home/project/somebinary', 2048)).toBe('Binary file — 2.0 KB');
    expect(describeUnrenderable('/home/project/.env', 512)).toBe('Binary file — 512.0 B');
  });
});

/*
 * CONTROLS.
 *
 * Per the spec's Testing Guidelines: *a test asserting png is an image passes for a function that calls
 * everything an image.* Every assertion above is of that shape. These are the only tests in this file
 * that fail when the function stops discriminating — mutation-verified: forcing `mediaKindForPath` to
 * `return 'image'` fails this block and nothing else could be relied on to notice.
 */
describe('CONTROLS — the answers discriminate', () => {
  it('CONTROL: mediaKindForPath does not call everything an image', () => {
    /* One assertion block, two non-media inputs: a real project binary and a plain text file. */
    expect(mediaKindForPath('public/havok.wasm')).not.toBe('image');
    expect(mediaKindForPath('README.txt')).not.toBe('image');

    expect(mediaKindForPath('public/havok.wasm')).toBeNull();
    expect(mediaKindForPath('README.txt')).toBeNull();

    /* And the control's own control: the discrimination is real, not "everything is null". */
    expect(mediaKindForPath('public/assets/hero.png')).toBe('image');
  });

  /*
   * 🔴 CONTROL: THE MEASURED-FAILING FORMATS ARE STILL REFUSED.
   *
   * The render list grew on 2026-08-15 and every addition was proved by loading a real file into a real
   * element. These are the ones that FAILED the same measurement — `.avi` with `DEMUXER_ERROR_COULD_NOT_
   * OPEN`, the rest with `MEDIA_ERR_DECODE`, `.tiff` with an `error` on an `<img>` — so they are the
   * control on the growth itself: without them, "we measured more formats" and "we started rendering
   * anything that looks like media" are indistinguishable, and the second ships a black rectangle.
   *
   * ⚠️ `.ts` IS TYPESCRIPT SOURCE IN THIS CODEBASE. It is also the extension of an MPEG transport
   * stream, and a lookup table copied from a media library carries it as video — at which point every
   * `.ts` file in `src/` is a candidate for a `<video>` element. It is listed here as a genuine footgun,
   * not for symmetry with the others.
   */
  it('CONTROL: the formats that failed the measurement are still not rendered', () => {
    for (const ext of ['.avi', '.mpg', '.wmv', '.aiff', '.caf', '.wma', '.tiff', '.ts']) {
      expect(mediaKindForPath(`public/clips/capture${ext}`), `${ext} must not be rendered`).toBeNull();
    }

    /* The control's own control: this is discrimination, not a function that refuses everything. */
    expect(mediaKindForPath('public/clips/capture.mkv')).toBe('video');
  });

  /* The three kinds are three answers, not one — a single-kind implementation passes half this file. */
  it('CONTROL: the three kinds are distinguished from each other', () => {
    const kinds = new Set([
      mediaKindForPath('hero.png'),
      mediaKindForPath('intro.mp4'),
      mediaKindForPath('engine.mp3'),
    ]);

    expect(kinds.size).toBe(3);
    expect(kinds).toEqual(new Set(['image', 'video', 'audio']));
  });

  it('CONTROL: describeUnrenderable is not returning one constant string', () => {
    const wasm = describeUnrenderable('public/havok.wasm', 2094566);
    const font = describeUnrenderable('public/fonts/Inter.ttf', 2094566);
    const unknown = describeUnrenderable('public/data/blob.xyz', 2094566);

    /* The PATH reaches the result: three inputs differing only in extension, three sentences. */
    expect(new Set([wasm, font, unknown]).size).toBe(3);

    /* The SIZE reaches the result: one path, two sizes, two sentences. */
    expect(describeUnrenderable('public/havok.wasm', 1024)).not.toBe(describeUnrenderable('public/havok.wasm', 2048));

    /* And neither half is silently dropped — an impl printing only the size passes the line above. */
    expect(wasm).toContain('WebAssembly module');
    expect(wasm).toContain('2.0 MB');
  });
});

/*
 * ── T6 / AC-8 — THE CROSS-REPO DRIFT PIN ──────────────────────────────────────────────────────────
 *
 * `TEMPLATE_MEDIA_EXTENSIONS` is a hand-copied mirror of a map that lives in ANOTHER REPOSITORY
 * (`babylontoolkit/AppTemplate @ vite.config.ts → MEDIA_MIME_TYPES`). Nothing in the type system, the
 * build, or CI relates the two, and the failure is silent in both directions:
 *
 *   - the template GAINS an extension → the dev server serves it perfectly, this repo declines to
 *     render it, and the user sees a fallback sentence for a file that would have displayed fine;
 *   - the template LOSES or RETYPES one → we point an element at a URL the server now hands back as
 *     `text/html` (Vite's SPA fallback answers 200, not 404 — see `BinaryPreview.tsx`'s `onError`
 *     note), so the only signal is a decode failure the user reads as the tool being broken.
 *
 * This is the same class as `map-exclusions.spec.ts`'s watcher-glob/walk-predicate pin, one repo
 * further apart, so it borrows that file's technique wholesale — including the part that is easy to
 * leave out: **`it.each` over a list cannot notice the list SHRINKING**, so the parameterized blocks
 * are backed by a length equality AND hardcoded membership pins.
 *
 * ⚠️ The second copy below is HARDCODED ON PURPOSE. The template is not checked into this repo (the
 * pinned snapshot under `.data/` is gitignored and absent in CI), so there is no file to read — and a
 * pin that read the same source as the thing it pins would assert nothing anyway. Transcribed
 * verbatim from `AppTemplate/vite.config.ts` on 2026-08-14; 34 entries, leading dots, lowercase.
 */
const TEMPLATE_MIME_TYPES_AS_OF_2026_08_14: Readonly<Record<string, string>> = {
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

/** The count is stated as a literal so that BOTH copies changing together still fails. */
const TEMPLATE_ENTRY_COUNT = 34;

describe('AC-8 — TEMPLATE_MEDIA_EXTENSIONS cannot drift from the starter template', () => {
  const pinnedKeys = Object.keys(TEMPLATE_MIME_TYPES_AS_OF_2026_08_14);
  const mirroredKeys = Object.keys(TEMPLATE_MEDIA_EXTENSIONS);

  it.each(pinnedKeys)('the mirror carries %s with the template’s own MIME type', (ext) => {
    expect(mirroredKeys).toContain(ext);
    expect(TEMPLATE_MEDIA_EXTENSIONS[ext]).toBe(TEMPLATE_MIME_TYPES_AS_OF_2026_08_14[ext]);
  });

  it.each(mirroredKeys)('the template really has %s — the mirror invented nothing', (ext) => {
    /*
     * The reverse direction. An extension in the mirror that the template does not serve is the
     * subtler half: this repo would happily point an `<img>` at a URL the dev server types as
     * `application/octet-stream`, and the element's decode failure is the only symptom.
     */
    expect(pinnedKeys).toContain(ext);
    expect(TEMPLATE_MIME_TYPES_AS_OF_2026_08_14[ext]).toBe(TEMPLATE_MEDIA_EXTENSIONS[ext]);
  });

  it('both maps have exactly 34 entries — the it.each blocks cannot see a list shrink', () => {
    /*
     * 🔴 The load-bearing arithmetic. Delete an entry from BOTH copies and every parameterized
     * assertion above still passes, because they only ever iterate what is there.
     */
    expect(mirroredKeys).toHaveLength(TEMPLATE_ENTRY_COUNT);
    expect(pinnedKeys).toHaveLength(TEMPLATE_ENTRY_COUNT);
  });

  it('membership pins: one entry per family stays on the list', () => {
    /*
     * One from each of the four groups the template comments itself into, chosen so that a whole
     * group being dropped is caught by name rather than only by the count.
     */
    expect(TEMPLATE_MEDIA_EXTENSIONS['.png']).toBe('image/png');
    expect(TEMPLATE_MEDIA_EXTENSIONS['.ktx2']).toBe('image/ktx2');
    expect(TEMPLATE_MEDIA_EXTENSIONS['.weba']).toBe('audio/webm');
    expect(TEMPLATE_MEDIA_EXTENSIONS['.mov']).toBe('video/quicktime');
    expect(TEMPLATE_MEDIA_EXTENSIONS['.glb']).toBe('model/gltf-binary');
  });
});

/**
 * What the module DECLARES it renders, flattened to `(kind, extension)` pairs.
 *
 * 🔴 **`RENDERED` is exported for exactly this test, and reading it is what turns "claims nothing the
 * template does not serve" from a SAMPLE into a PROOF.** The first draft of this block could only
 * probe `mediaKindForPath` over the template's own keys — which can never see an extension claimed
 * that the template does not serve, because such an extension is not in the set being iterated. The
 * space of extensions is unbounded, so no amount of probing closes that direction; enumerating the
 * declaration does, in one pass.
 *
 * Both halves are asserted below and they fail in opposite directions:
 *
 *   - **the DATA** (`RENDERED`) — every declared extension must be one the dev server actually types,
 *     with a MIME the element agrees with;
 *   - **the BEHAVIOUR** (`mediaKindForPath`) — every declared extension must actually route to the
 *     kind it is declared under.
 *
 * Asserting only the data passes for a function that ignores the table it is supposed to read; that is
 * the same shape as `budgets-wiring.spec.ts` (every seam takes the budgets OPTIONALLY, so a proxy that
 * forgets one runs on the default, silently, with the constant still correct).
 */
type RenderedPair = [MediaKind, string];

const RENDERED_PAIRS: RenderedPair[] = (Object.keys(RENDERED) as MediaKind[]).flatMap((kind) =>
  RENDERED[kind].map((ext): RenderedPair => [kind, ext]),
);

const renderedExtensions = RENDERED_PAIRS.map(([, ext]) => ext);

/**
 * The rendered pairs the template map DOES type — the only ones a MIME-prefix check can speak about.
 *
 * The MIME assertion below borrows the template's opinion as an INDEPENDENT one; for an extension the
 * template never types there is no opinion to borrow, and `undefined.startsWith` is a crash rather than
 * a finding. Those extensions are covered instead by the enumerated `RENDERED_WITHOUT_TEMPLATE_MIME`.
 */
const RENDERED_PAIRS_IN_TEMPLATE: RenderedPair[] = RENDERED_PAIRS.filter(([, ext]) => ext in TEMPLATE_MEDIA_EXTENSIONS);

/**
 * The domain the BEHAVIOUR is probed over — deliberately built from the two maps that are NOT
 * `RENDERED`.
 *
 * 🔴 A probe domain derived from the thing under test cannot see it shrink. If this were
 * `renderedExtensions`, deleting a whole kind would delete the inputs that would have caught it, which
 * is `map-exclusions.spec.ts`'s lesson stated as a set. Both halves here are independent of `RENDERED`:
 * the template map lives in another repository, and `RENDERED_WITHOUT_TEMPLATE_MIME` is a separate
 * export whose agreement with `RENDERED` is itself asserted below.
 */
const PROBE_DOMAIN = [
  ...new Set([...Object.keys(TEMPLATE_MEDIA_EXTENSIONS), ...Object.keys(RENDERED_WITHOUT_TEMPLATE_MIME)]),
];

/** The same question asked of the BEHAVIOUR instead of the table. */
const claimed = PROBE_DOMAIN.filter((ext) => mediaKindForPath(`file${ext}`) !== null);

describe('AC-8 — the rendered / deliberately-not-rendered partition is exhaustive', () => {
  it.each(RENDERED_PAIRS_IN_TEMPLATE)('the template types %s extension %s with a matching MIME prefix', (kind, ext) => {
    /*
     * A MIME the element disagrees with is a type error nowhere at all: routing a `.mov` to an `<img>`
     * or a `.ktx2` to a `<video>` throws nothing, it renders a broken-image icon or a transport bar
     * over a black rectangle. The template's own MIME is the independent opinion — nothing in this repo
     * derives it, which is the whole reason it is capable of contradicting us.
     *
     * ⚠️ Scoped to the INTERSECTION since 2026-08-15. The rendered set is deliberately allowed to
     * exceed the template map (a `.mkv` arrives with no `Content-Type` at all and Chrome sniffs it), so
     * this can no longer be asked of every rendered extension — what stops that loosening from
     * swallowing the check is the exact-set assertion against `RENDERED_WITHOUT_TEMPLATE_MIME` below,
     * not this block.
     */
    const mime = TEMPLATE_MEDIA_EXTENSIONS[ext];

    expect(mime.startsWith(`${kind}/`), `${ext} is drawn as ${kind} but the template types it ${mime}`).toBe(true);
  });

  it.each(RENDERED_PAIRS)('mediaKindForPath actually routes %s extension %s', (kind, ext) => {
    /*
     * 🔴 DATA AND BEHAVIOUR PINNED TO EACH OTHER. The block above proves the TABLE is right; this
     * proves the FUNCTION reads it. A `mediaKindForPath` that dropped a kind, short-circuited, or
     * matched case-sensitively would leave `RENDERED` perfectly correct and render nothing — and every
     * assertion written against the constant alone would stay green.
     */
    expect(mediaKindForPath(`/home/project/x${ext}`)).toBe(kind);
  });

  it('no extension is claimed by two kinds at once', () => {
    /*
     * `mediaKindForPath` returns the FIRST kind whose list contains the extension, so a duplicate makes
     * the answer depend on `Object.keys` order — a `.mov` in both `image` and `video` renders an
     * `<img>` and nothing anywhere says so.
     */
    expect(new Set(renderedExtensions).size).toBe(renderedExtensions.length);
  });

  it('🔴 every template extension is classified as rendered or deliberately not rendered', () => {
    /*
     * This is the assertion the whole block is for, and it is the one that must not weaken: a new
     * extension in the template lands in neither set, and without this it is simply ignored forever —
     * no test iterates it, nothing throws, and the only symptom is a file the dev server serves and
     * this repo declines to show.
     *
     * ⚠️ It used to be an EQUALITY (`RENDERED ∪ DELIBERATELY_NOT_RENDERED === the template map`) and is
     * now a COVERING, because the rendered set legitimately exceeds the map. The direction that matters
     * — the template gaining an extension — is unchanged and just as strong; the direction that was
     * given up (`RENDERED` claiming something the template does not serve) is not dropped, it MOVED to
     * `RENDERED_WITHOUT_TEMPLATE_MIME` below, where it is an exact set equality rather than a blanket
     * ban. Failing the unclassified list as a LIST rather than counting it is deliberate: the failure
     * message then names the extension somebody has to go and classify.
     */
    const classified = new Set([...renderedExtensions, ...Object.keys(DELIBERATELY_NOT_RENDERED)]);
    const unclassified = Object.keys(TEMPLATE_MEDIA_EXTENSIONS).filter((ext) => !classified.has(ext));

    expect(unclassified).toEqual([]);
  });

  it('every deliberately-not-rendered reason is about an extension the template still serves', () => {
    /*
     * The other direction of the retired equality, kept whole. An extension retired from the template
     * but left in `DELIBERATELY_NOT_RENDERED` is a reason recorded for a file that can no longer exist
     * — it reads as current fact and is quietly fiction. (`RENDERED` is not held to this: exceeding the
     * map is the point, and the excess is enumerated separately.)
     */
    const orphaned = Object.keys(DELIBERATELY_NOT_RENDERED).filter((ext) => !(ext in TEMPLATE_MEDIA_EXTENSIONS));

    expect(orphaned).toEqual([]);
  });

  it('🔴 every rendered extension outside the template map is enumerated, and nothing else is', () => {
    /*
     * 🔴 THE REPLACEMENT GUARD. Loosening the partition above from an equality to a covering removes
     * the only thing that constrained `RENDERED` from ABOVE — and "the rendered set may go beyond the
     * template" degrades, silently and immediately, into "nothing checks the rendered set at all",
     * which is the drift `TEMPLATE_MEDIA_EXTENSIONS` exists to prevent arriving through the back door.
     * So the excess is not permitted, it is ENUMERATED: every extension we render that the template
     * does not type must be listed in `RENDERED_WITHOUT_TEMPLATE_MIME` with the measurement that put it
     * there.
     *
     * Written as a sorted equality so it fails in BOTH directions, and both directions are real:
     *
     *   - an extension added to `RENDERED` and not enumerated is a claim with no evidence behind it —
     *     the exact way a black `<video>` ships, since nothing else can now object to it;
     *   - an extension enumerated but no longer rendered is a measurement documenting a decision the
     *     code has stopped making, which is how a comment starts lying.
     */
    const outsideTheTemplate = renderedExtensions.filter((ext) => !(ext in TEMPLATE_MEDIA_EXTENSIONS)).sort();

    expect(outsideTheTemplate).toEqual(Object.keys(RENDERED_WITHOUT_TEMPLATE_MIME).sort());
  });

  it('every enumerated exception states its evidence, not just its name', () => {
    /*
     * The list is only worth having if its entries carry the measurement — an empty or placeholder
     * reason turns the guard above into a second copy of `RENDERED`, which agrees with itself by
     * construction and can therefore never disagree with anything.
     */
    for (const [ext, evidence] of Object.entries(RENDERED_WITHOUT_TEMPLATE_MIME)) {
      expect(evidence.length, `${ext} is enumerated with no evidence`).toBeGreaterThan(20);
      expect(evidence, `${ext}'s entry does not say what was measured`).toMatch(/measured|PLAYS|RENDERS/i);
    }
  });

  it('nothing is in both halves of the partition', () => {
    /* A `.png` listed as deliberately-not-rendered would still render, and the reason would read as fact. */
    const overlap = renderedExtensions.filter((ext) => ext in DELIBERATELY_NOT_RENDERED);

    expect(overlap).toEqual([]);
  });

  it('the behaviour claims exactly what the table declares — no more, no less', () => {
    /*
     * The set-level statement of the two `it.each` blocks, and the one that notices a DELETION: a kind
     * removed from `RENDERED` shrinks both the parameterized list and the thing it iterates, so every
     * per-entry assertion still passes (`map-exclusions.spec.ts`'s lesson). Comparing the probed set to
     * the declared set is what fails — and only because `PROBE_DOMAIN` is built from the two maps that
     * are NOT `RENDERED`, so the inputs survive the deletion they are meant to catch.
     */
    expect(claimed.sort()).toEqual([...renderedExtensions].sort());
  });

  it('CONTROL: the partition is a real split, not one empty half', () => {
    /*
     * The equality above passes for a `RENDERED` holding EVERYTHING (with an empty
     * `DELIBERATELY_NOT_RENDERED`) and equally for one holding NOTHING — the same "collapse everything
     * to one entry" trap `files-context.spec.ts` records. Both halves must be populated, and both must
     * contain the entries whose classification is the point.
     */
    expect(renderedExtensions.length).toBeGreaterThan(10);
    expect(Object.keys(DELIBERATELY_NOT_RENDERED).length).toBeGreaterThan(5);

    expect(renderedExtensions).toEqual(expect.arrayContaining(['.png', '.mp4', '.mp3', '.svg']));

    /*
     * ⚠️ `.svg` was named here until 2026-08-15 and has MOVED to the rendered side (owner: *"let make
     * svg show up a render image like other images"*), so it is now pinned one line up instead. The
     * membership pin is replaced rather than shortened: dropping an entry to make the assertion pass
     * is how a control quietly stops controlling, and this list's job is to prove the excluded half is
     * still populated with the entries whose exclusion is the point.
     *
     * `.hdr` is the replacement, and it is a real successor rather than a filler: like `.svg` it is an
     * IMAGE the template serves, so it is exactly the kind of extension a "render anything image-ish"
     * regression would sweep up — and unlike `.svg` no browser can decode it, which is why it stays on
     * this side of the split.
     */
    expect(Object.keys(DELIBERATELY_NOT_RENDERED)).toEqual(expect.arrayContaining(['.ktx2', '.tiff', '.avi', '.hdr']));

    /* All three kinds are populated — a kind emptied out is a whole element that never renders. */
    for (const kind of ['image', 'video', 'audio'] as MediaKind[]) {
      expect(RENDERED[kind].length, `RENDERED.${kind} is empty`).toBeGreaterThan(0);
    }

    /*
     * And the intersection the MIME check runs over is not empty. `RENDERED_PAIRS_IN_TEMPLATE` is a
     * FILTER, so a mistake in it — or in the template mirror — reduces that `it.each` to zero cases,
     * and a parameterized block with no cases passes loudly and silently at the same time.
     */
    expect(RENDERED_PAIRS_IN_TEMPLATE.length).toBeGreaterThan(10);
  });

  it('CONTROL: claims nothing that is in neither map, asked of the BEHAVIOUR', () => {
    /*
     * Kept as a behavioural control now that the proof lives in the `RENDERED` enumeration above. It is
     * cheap and it catches the one thing enumerating a table cannot: a `mediaKindForPath` that ignores
     * the table entirely — a hardcoded `return 'video'`, or a `.includes()` on the whole path — passes
     * every constant-derived assertion in this file and fails here.
     *
     * ⚠️ `.mkv`, `.apng` and `.3gp` were on this list until 2026-08-15 and are now MEASURED RENDERED,
     * so they moved out of it. That is the honest bookkeeping for a control whose premise changed —
     * the alternative, deleting the control because three of its inputs stopped qualifying, would have
     * removed the only assertion here that a hardcoded return value fails. Every format below is real,
     * common, and absent from BOTH maps.
     */
    for (const ext of ['.wmv', '.flv', '.jfif', '.mp2', '.aiff', '.mpg', '.heic', '.wma']) {
      expect(ext in TEMPLATE_MEDIA_EXTENSIONS).toBe(false);
      expect(ext in RENDERED_WITHOUT_TEMPLATE_MIME).toBe(false);
      expect(mediaKindForPath(`file${ext}`), `${ext} is claimed but nothing types it`).toBeNull();
    }
  });
});

/*
 * SOFT CHECK — the locally pinned starter snapshot, when there is one.
 *
 * `.data/` is gitignored, so this is present on a developer machine that has created a project and
 * absent everywhere else including CI. It must therefore SKIP CLEANLY and never be a dependency: its
 * value is that a developer who has just promoted a new template pin finds out on the next `pnpm test`
 * rather than after shipping. The hardcoded copy above remains the pin.
 */
const SNAPSHOT_DIR = join(process.cwd(), '.data/storage/templates/snapshots/babylontoolkit__AppTemplate');

function readSnapshotMediaMimeTypes(): Record<string, string> | null {
  try {
    if (!existsSync(SNAPSHOT_DIR)) {
      return null;
    }

    const snapshots = readdirSync(SNAPSHOT_DIR).filter((name) => name.endsWith('.json'));

    for (const name of snapshots) {
      const files = JSON.parse(readFileSync(join(SNAPSHOT_DIR, name), 'utf-8')) as Array<{
        path?: string;
        content?: string;
      }>;

      const config = Array.isArray(files) ? files.find((file) => file.path === 'vite.config.ts') : undefined;
      const block = config?.content?.match(/const MEDIA_MIME_TYPES[^{]*\{([\s\S]*?)\n\};/)?.[1];

      if (!block) {
        continue;
      }

      const parsed: Record<string, string> = {};

      for (const [, ext, mime] of block.matchAll(/"(\.[a-z0-9]+)":\s*"([^"]+)"/g)) {
        parsed[ext] = mime;
      }

      if (Object.keys(parsed).length > 0) {
        return parsed;
      }
    }

    return null;
  } catch {
    /* A malformed or half-written snapshot is not this feature's problem — the hard pin still holds. */
    return null;
  }
}

const snapshotMimeTypes = readSnapshotMediaMimeTypes();

describe.skipIf(!snapshotMimeTypes)('AC-8 — soft cross-check against the locally pinned snapshot', () => {
  it('the pinned starter agrees with the hardcoded copy, entry for entry', () => {
    expect(snapshotMimeTypes).toEqual(TEMPLATE_MIME_TYPES_AS_OF_2026_08_14);
  });

  it('CONTROL: the snapshot really was parsed, not silently read as empty', () => {
    /* Without this, a regex that stopped matching would make the equality above pass on `{}` vs `{}`. */
    expect(Object.keys(snapshotMimeTypes ?? {})).toHaveLength(TEMPLATE_ENTRY_COUNT);
    expect(snapshotMimeTypes?.['.png']).toBe('image/png');
  });
});
