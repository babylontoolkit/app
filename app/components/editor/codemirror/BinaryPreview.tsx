/**
 * What a binary file looks like in Code view (SPEC §4.1b).
 *
 * Replaces the one hardcoded sentence upstream shows for EVERY binary — "File format cannot be
 * displayed." — which was never a format check: `BinaryContent` inspects nothing, so a PNG, an MP4 and
 * `havok.wasm` all got the same refusal. The sentence survives as the honest answer for the files that
 * genuinely cannot be shown, but it now NAMES what it found, because a refusal that names no cause
 * reads as the tool being broken (`share/build-failure.ts`).
 *
 * 🔴 **No bytes are read, and that is the mechanism, not an optimisation.** The element is pointed at
 * the project's OWN running dev server, which is already serving these files with the right
 * `Content-Type`. Consequences worth stating because a future reader will be tempted by `Blob`:
 * video and audio arrive over HTTP RANGE REQUESTS, so a 200 MB capture seeks instantly and never
 * enters the tab's heap; there is no object-URL lifetime, so there is no revoke-on-unmount leak to get
 * wrong; and neither the `readFile`-bytes-are-on-loan detachment class nor §4.2.8 is touched at all.
 * `spec/binary-files.md`'s rule that the sandbox FS is the single source of truth for binary bytes
 * holds trivially here. The feature spec's "what this deliberately does NOT include" list exists so
 * nobody re-adds a piece of the Blob design thinking it was an oversight.
 *
 * Concretely: this component must never call `readBinaryFile`, never construct a `new Blob`, and never
 * mint a `createObjectURL`. That is asserted by a source scan (`binary-preview-guards.spec.ts`) rather
 * than left to this paragraph — a rule that lives only in a comment is one nobody is keeping, and this
 * sentence is itself the reason that scan has to strip comments before it decides.
 *
 * ⚠️ The store subscription lives HERE and not in `CodeMirrorEditor`, which is `memo`'d: a `useStore`
 * up there would re-render the whole editor every time a preview URL is re-minted.
 */

import { useStore } from '@nanostores/react';
import { useEffect, useState } from 'react';
import { describeUnrenderable, mediaKindForPath } from '~/lib/preview/media-kind';
import { previewUrlForProjectFile, selectPreviewBaseUrl } from '~/lib/preview/project-file-url';
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import { formatSize } from '~/utils/formatSize';

/**
 * The overlay shell, shared by EVERY branch.
 *
 * One constant rather than a class string per branch, for §4.1a's reason one level down: the fallback
 * and the media states are the same surface in different moods, and a style only looks wrong next to
 * its siblings — nothing in a code review shows you both at once. Kept module-local inside the `.tsx`
 * so it is extracted whatever `uno.config.ts`'s `content.pipeline.include` covers.
 */
const SHELL =
  'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 ' +
  'bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary';

const MESSAGE = 'text-sm text-center text-bolt-elements-textSecondary';

/**
 * The Source/Preview toggle, positioned over the editor's top-right.
 *
 * `z-20` sits above the `z-10` overlay so the control stays reachable in both modes — in Source mode it
 * is the ONLY thing this component renders, floating over a live editor.
 */
const TOGGLE =
  'absolute top-2 right-2 z-20 px-2 py-1 text-xs rounded-md border ' +
  'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 ' +
  'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary ' +
  'hover:bg-bolt-elements-background-depth-3 transition-colors';
const CAPTION = 'text-xs text-bolt-elements-textTertiary tabular-nums';
const MEDIA = 'max-w-full max-h-full object-contain';

/**
 * A checkerboard, so a cut-out PNG is distinguishable from a white one (spec OQ-3).
 *
 * §4.16 produces transparent art routinely — the whole two-stage cut-out pipeline exists for it — and
 * against a flat panel a correct alpha channel and a solid white background look identical. Inline
 * rather than a utility class because the pattern is four gradients; there is no token for it.
 */
const CHECKERBOARD = {
  backgroundImage:
    'linear-gradient(45deg, rgba(128,128,128,0.18) 25%, transparent 25%), ' +
    'linear-gradient(-45deg, rgba(128,128,128,0.18) 25%, transparent 25%), ' +
    'linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.18) 75%), ' +
    'linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.18) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
} as const;

/**
 * Add a cache-busting parameter WITHOUT destroying the credential the URL may already carry.
 *
 * 🔴 `` `${url}?t=${n}` `` is the obvious spelling and it is wrong on CodeSandbox, whose preview URLs
 * carry `?preview_token=…`: a second `?` makes the token part of a garbage query and the retry 401s.
 * This is the same defect `previewUrlWithPath`'s doc comment records for path joining, one query
 * parameter to the left — hence the URL API, and hence returning the input unchanged rather than
 * throwing into a render if it is somehow not a URL.
 *
 * Safe against the dev server: the template's `applyMediaContentType` strips the query BEFORE matching
 * the extension (verified live 2026-08-14 — `starter.jpg?t=…` → 200 `image/jpeg`).
 */
function withCacheBuster(url: string, attempt: number): string {
  try {
    const busted = new URL(url);
    busted.searchParams.set('t', String(attempt));

    return busted.toString();
  } catch {
    return url;
  }
}

/** The failure sentence, kept next to the state that shows it. */
const LOAD_FAILED = 'Could not load this file from the dev server.';
const NO_PREVIEW = 'Start the dev server to preview this file.';

/**
 * An icon-sprite SVG renders as NOTHING, correctly, and that is indistinguishable from a broken viewer.
 *
 * Measured 2026-08-15 on the starter's own files by decoding the rendered pixels: `vite.svg` is 51.8%
 * non-transparent and `react.svg` 41.8%, while `icons.svg` is **0%** — it is a sheet of `<symbol>`
 * definitions, which draw only where a `<use>` references them. So the blank pane is the right answer
 * and the user has no way to know that. FR-3's rule applies verbatim one format down: name what you
 * found rather than showing an empty box, or the tool looks broken.
 *
 * Read off the SOURCE (free — SVG is text and already in the map) rather than by sampling canvas
 * pixels: a canvas read per preview costs a decode and a full-image `getImageData`, and it would answer
 * "nothing is visible" without being able to say WHY.
 */
const SPRITE_NOTE = 'Icon sprite — its <symbol> shapes draw only where a <use> references them.';

function isSpriteSheet(source: string | undefined): boolean {
  return !!source && source.includes('<symbol');
}

interface Props {
  /** A `FileMap` key, i.e. sandbox-absolute — `doc.filePath` straight off the editor document. */
  filePath: string;

  /**
   * Is there editable SOURCE behind this preview? (SVG — `media-kind.ts`'s `isPreviewableTextMedia`.)
   *
   * When true this component renders a **Source** toggle, and flipping it unmounts the overlay so the
   * live CodeMirror instance underneath shows through — the editor is never torn down, only covered.
   * False for every genuine binary, where there is nothing to show and a toggle would be a dead end
   * (§4.1a's rule about permanently-inert controls).
   */
  sourceAvailable?: boolean;
}

export function BinaryPreview({ filePath, sourceAvailable = false }: Props) {
  const previews = useStore(workbenchStore.previews);

  /*
   * Derived on EVERY render, never cached in state (FR-5). `#applyPreviewUrl` swaps `baseUrl` in place
   * when a provider's credential rotates, so a `useState` copy of this string becomes a broken element
   * that nothing repoints — a preview that has silently died does not LOOK broken, which is the exact
   * failure `preview-url.ts` opens by describing.
   */
  const resolved = previewUrlForProjectFile(filePath, selectPreviewBaseUrl(previews), WORK_DIR);

  /*
   * Read non-reactively: a binary's size does not change while you look at it, and subscribing to the
   * file map would re-render this component for every file the watcher delivers during a mount.
   */
  const entry = workbenchStore.files.get()[filePath];
  const size = entry?.type === 'file' ? entry.size : undefined;

  /*
   * Only ever populated for the TEXT media (SVG) — a binary's `content` is always empty by design
   * (`spec/binary-files.md`), so this reads nothing that is not already in the map.
   */
  const source = entry?.type === 'file' && !entry.isBinary ? entry.content : undefined;

  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [meta, setMeta] = useState<string | undefined>(undefined);
  const [showSource, setShowSource] = useState(false);

  /*
   * A failure belongs to ONE file at ONE URL. Without this reset a single transient 404 would poison
   * every later file in the session — the user clicks a good PNG and is told the dev server is
   * unreachable. `attempt` is deliberately NOT reset: it only ever increments, so a retry can never
   * re-request a URL string this session has already seen fail.
   *
   * `showSource` resets with it for the same reason one level up: "I wanted to read THIS file's markup"
   * is a statement about one file, and carrying it to the next one silently hides the preview the user
   * just clicked.
   */
  useEffect(() => {
    setFailed(false);
    setMeta(undefined);
    setShowSource(false);
  }, [filePath, resolved]);

  /*
   * Source mode renders NO overlay — just the way back. The editor underneath was never unmounted, so
   * this reveals a live, editable CodeMirror rather than a rendering of the file's text.
   */
  if (sourceAvailable && showSource) {
    return (
      <button className={TOGGLE} onClick={() => setShowSource(false)}>
        Preview
      </button>
    );
  }

  const shell = (children: React.ReactNode) => (
    <div className={SHELL}>
      {children}
      {sourceAvailable && (
        <button className={TOGGLE} onClick={() => setShowSource(true)}>
          Source
        </button>
      )}
    </div>
  );

  // FR-4 — a named state, never a blank pane or a broken-image icon.
  if (!resolved) {
    return shell(<p className={MESSAGE}>{NO_PREVIEW}</p>);
  }

  /*
   * FR-3 — nothing to fetch, so nothing is fetched. Checked before the kind, since an empty `.png` is
   * still empty.
   */
  if (size === 0) {
    return shell(<p className={MESSAGE}>{describeUnrenderable(filePath, 0)}</p>);
  }

  const kind = mediaKindForPath(filePath);

  // FR-3 — the correct answer for wasm/fonts/glTF, not a failure.
  if (kind === null) {
    return shell(<p className={MESSAGE}>{describeUnrenderable(filePath, size)}</p>);
  }

  // FR-6 — the element told us it could not load. Name it, and offer another go.
  if (failed) {
    return shell(
      <>
        <p className={MESSAGE}>{LOAD_FAILED}</p>
        <button
          className="px-3 py-1 text-xs rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors"
          onClick={() => {
            setFailed(false);
            setAttempt((previous) => previous + 1);
          }}
        >
          Retry
        </button>
      </>,
    );
  }

  const src = attempt === 0 ? resolved : withCacheBuster(resolved, attempt);
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);

  /*
   * `onError` only ever sets state — it must never throw into the editor's render path (FR-6).
   *
   * ⚠️ It is also the ONLY reliable failure signal here. A missing file does not 404: Vite's SPA
   * fallback answers 200 with `index.html`, which the template's extension-keyed middleware then
   * retypes as `image/png` (observed live 2026-08-14). So any future "check it exists first" preflight
   * built on `response.ok` would report every missing file as present. The element's own decode
   * failure is the truth.
   */
  const onError = () => setFailed(true);

  /*
   * No `crossOrigin` attribute — decided by observation, not reasoning (T1, 2026-08-14). Bare no-cors
   * loads succeed on Nodepod (the shipped default and, per `ENABLED_SANDBOX_PROVIDERS`, currently the
   * only selectable provider) with `COEP: require-corp` genuinely active, because its previews are
   * same-origin. `crossOrigin="anonymous"` is NOT a free default: the template sets
   * `Access-Control-Allow-Origin` only on the extensions in its media map, so a project whose
   * `vite.config.ts` has lost that middleware — imported and remixed projects carry their own — would
   * break where plain no-cors works.
   */
  return shell(
    <>
      {kind === 'image' && (
        <img
          alt={name}
          className={MEDIA}
          src={src}
          style={CHECKERBOARD}
          onError={onError}
          onLoad={(event) => {
            const img = event.currentTarget;
            setMeta(describeMedia(img.naturalWidth, img.naturalHeight, size));
          }}
        />
      )}
      {kind === 'video' && (
        <video
          className={MEDIA}
          controls
          preload="metadata"
          src={src}
          onError={onError}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            setMeta(describeMedia(video.videoWidth, video.videoHeight, size));
          }}
        />
      )}
      {/* `object-contain` is meaningless on a transport bar, so audio takes the width half of MEDIA only. */}
      {kind === 'audio' && (
        <audio
          className="w-full max-w-full md:max-w-md"
          controls
          src={src}
          onError={onError}
          onLoadedMetadata={() => setMeta(describeMedia(0, 0, size))}
        />
      )}
      {meta && <p className={CAPTION}>{meta}</p>}
      {isSpriteSheet(source) && <p className={CAPTION}>{SPRITE_NOTE}</p>}
    </>,
  );
}

/** The OQ-4 caption: natural dimensions where they exist, and the size we already knew. */
function describeMedia(width: number, height: number, size: number | undefined): string {
  const parts: string[] = [];

  if (width > 0 && height > 0) {
    parts.push(`${width} × ${height}`);
  }

  if (size !== undefined && Number.isFinite(size) && size > 0) {
    parts.push(formatSize(size));
  }

  return parts.join(' · ');
}
