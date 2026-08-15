# Spec for binary-media-viewer

branch: project/feature/binary-media-viewer
design_system: DESIGN.md
spec_impact: yes

> Authored 2026-08-14 from a live report: *"in the App Builder in code view when i click on a video or
> image it says format not supported… Does bolt.diy not support display video and images in the
> workspace?"*
>
> ⚠️ **REVISED the same day, after the owner asked: *"arent you just SERVING those files from the
> public of the app?"*** The first draft read the bytes out of the sandbox, wrapped them in a Blob and
> managed object-URL lifetimes — roughly 200 lines of memory-safety machinery. That was wrong. The
> project's own Vite dev server is **already serving these files, already with the right
> Content-Type**, and the preview URL is already in a store. The design below is what is left once
> that is used instead, and it is both smaller and *better* (see §"Why the URL wins outright").

## Summary

Clicking any binary file in Code view renders one hardcoded sentence — **"File format cannot be
displayed."** — whether it is a PNG, an MP4, or `havok.wasm`. It is not a format check: upstream
bolt.diy has no binary viewer at all, and the component never inspects the file type.

Replace it with `<img>` / `<video controls>` / `<audio controls>` pointed at the **running dev
server's preview URL**, keeping the existing sentence as the honest fallback for things that cannot be
shown (wasm, ttf, bin) and for when no dev server is running.

No bytes are read, copied, or held by the App Builder.

## Ground truth (verified 2026-08-14)

| Fact | Where |
|---|---|
| The message is 7 lines with no type awareness | `app/components/editor/codemirror/BinaryContent.tsx` |
| Rendered as an absolute overlay when `doc.isBinary` | `CodeMirrorEditor.tsx:315` — `{doc?.isBinary && <BinaryContent />}` |
| The editor already skips every text path for binaries; editable forced off | `CodeMirrorEditor.tsx:172, 272, 458` |
| `File.content` is always empty for binaries; map holds `isBinary` + `size` | `files.ts:111-126` |
| **The starter's Vite serves media with explicit MIME types** — `.mp4`→`video/mp4`, `.mp3`→`audio/mpeg`, `.webm`, `.ogg`, `.wav`, `.png`, `.webp`, `.svg`, … | starter `vite.config.ts`, `MEDIA_MIME_TYPES` + `applyMediaContentType` |
| …and sets `Access-Control-Allow-Origin: *` on every one of them | same middleware |
| `public/**` is served at the preview root (`public/starter.jpg` → `<baseUrl>/starter.jpg`) | Vite default + `copyPublicDir` |
| The preview URL is a public atom: `PreviewInfo { port, ready, baseUrl, expiresAt? }` | `app/lib/stores/previews.ts:12-23, 41` |
| Vite also serves arbitrary in-project files at `/@fs/<abs path>` | verified live earlier this session — `_specs/*.md` returned 200 through the sandbox preview |
| `isBinary` comes from a text-sniffing heuristic, so **SVG is TEXT** | `binary-files.ts:208` `isBinaryBuffer` → `getEncoding(...) === 'binary'` |

## Why the URL wins outright

This is not merely simpler — it is the better implementation, and one difference is not close:

- **Video and audio stream.** An `<video src="blob:…">` needs the *entire* file in memory before it
  plays. A URL gets HTTP range requests, so a 200 MB capture seeks instantly and never occupies the
  tab's heap. The Blob design needed a size cap precisely *because* it was the wrong mechanism; with a
  URL the cap disappears along with the reason for it.
- **No lifetime problem, so no lifetime bugs.** No `createObjectURL`, no `revokeObjectURL`, no leak per
  click, no revoke-on-unmount/switch/project-change. The single largest risk in the first draft was
  memory, and it is now structurally absent rather than defended against.
- **No contact with the bytes at all**, which retires two `CLAUDE.md` hazards outright: the
  `readFile`-bytes-are-on-loan detachment class (Nodepod returns a live view into its own VFS), and any
  question of binary content reaching the file map or model context (§4.2.8).
- **Correct Content-Type for free**, chosen by the template's own map rather than by a second detector
  in this repo.

What it costs: a preview must be running. That is the whole trade, and it is stated in FR-4.

## Project Spec Alignment (from SPEC.md — REQUIRED)

- **§1.3 principle 10 / `spec/binary-files.md`** — the sandbox FS stays the single source of truth for
  binary bytes. This feature reads *nothing* and writes *nothing*; it points an element at a URL.
- **§4.2.8 context budget** — client-only. No byte, data URI or base64 string enters `FileMap`, the
  artifact channel, or any agent context.
- **§2.1a pull compatibility** — additive. `BinaryContent.tsx` (upstream) keeps its current body as the
  fallback; the new component is ours. Upstream diff: one import, one JSX line.
- **`spec/sandbox-seam.md`** — no provider-specific code. The preview `baseUrl` comes from
  `previewsStore`, which already abstracts WebContainer / Nodepod / CodeSandbox differences, including
  URL expiry.
- **§4.9 assets** — this is a viewer for files already in the project, not the asset catalog.

## Functional Requirements

**FR-1 — Resolve the file to a URL on the running preview.**
Two cases, one helper (`previewUrlForProjectFile`, pure and tested):
- under `public/` → strip the prefix: `public/scripts/x.wasm` → `<baseUrl>/scripts/x.wasm`
- anywhere else in the project → `<baseUrl>/@fs/<absolute sandbox path>`

`baseUrl` is the first `ready` preview from `previewsStore.previews`. The helper takes `baseUrl` as an
argument and returns `null` when there is none — it must not read stores itself, so it stays testable.

**FR-2 — Kind is chosen by EXTENSION, deliberately.**
The dev server already types the response by extension, and browsers sniff images regardless, so a
byte-level sniffer buys nothing here and would be a second detector competing with
`vite.config.ts`'s map. **Mirror the template's own extension list**; a spec asserts the two do not
drift, the same way `MAP_EXCLUDE_GLOBS` is pinned against `MAP_EXCLUDED_DIRS`.

**FR-3 — Three kinds, one fallback.**
`image` → `<img>`; `video` → `<video controls preload="metadata">`; `audio` → `<audio controls>`;
anything else keeps the current sentence, **naming what it found** ("WebAssembly module — 2.1 MB")
rather than staying generic. A refusal that names no cause reads as the tool being broken
(`share/build-failure.ts`).

**FR-4 — No preview running is a NAMED state, not a blank pane.**
When no `ready` preview exists, show "Start the dev server to preview this file." That is honest and
actionable. It is also the one regression against the Blob design, accepted: the dev server is started
automatically on project mount, so this is the uncommon case.

**FR-5 — Survive preview URL changes.**
`PreviewInfo.expiresAt` exists because some providers mint expiring URLs and `previews.ts` re-mints
them. The component must derive its `src` from the store on each render rather than caching a string,
so a re-mint repoints the element instead of leaving a broken image.

**FR-6 — A media element error is a named fallback, not a black box.**
`onError` on the element (404 because the dev server has not picked the file up yet, an unplayable
codec) swaps to the fallback with the reason. It must never throw into the editor's render path.

**FR-7 — Read-only.** No save path, no drag-replace, no writes. Editing is already disabled for
binaries (`CodeMirrorEditor.tsx:458`); nothing here changes that.

## Possible Edge Cases

| Case | Required behaviour |
|---|---|
| **SVG is text, so `isBinary` is false** | Opens as editable source today; unchanged by this feature. A preview toggle is **Open Question 1** — do not silently reroute it. |
| No dev server / preview not ready | FR-4 named state. |
| File newly written, dev server has not served it yet | `onError` → fallback; a manual retry affordance is acceptable. |
| Preview URL expires mid-view | FR-5 re-derives from the store. |
| Unplayable codec in a valid `.mp4` | FR-6 names it rather than showing a black rectangle. |
| `havok.wasm`, fonts, `.bin` | Fallback naming type + size. This is the correct answer, not a failure. |
| Zero-byte file | Fallback ("empty file"). |
| A file outside the Vite `server.fs.allow` root | `/@fs` 403s → FR-6 fallback. In-project files are inside the root by definition. |
| `.env` | Already served by the user's own dev server to their own browser; this adds no exposure. Not special-cased. |

## Acceptance Criteria

1. Clicking a PNG/JPG/WebP/GIF in `public/` renders the image; an MP4/WebM renders a playable
   `<video controls>`; an MP3/WAV/OGG renders a playable `<audio controls>`.
2. An image under `src/` (not `public/`) renders via the `/@fs` path.
3. Clicking `public/scripts/havok.wasm` shows a fallback naming type and size — never a blank pane.
4. With no dev server running, every binary shows the FR-4 message, not a broken-image icon.
5. **`readBinaryFile` is never called by this feature** — asserted by a source scan with a control, so
   the Blob design cannot creep back in unnoticed.
6. Bytes never reach the file map: after viewing, `files.get()[path].content === ''` and
   `isBinary === true`.
7. `previewUrlForProjectFile` is pure and exhaustively tested: `public/` stripping, `/@fs` for other
   paths, `null` with no `baseUrl`, and trailing-slash handling on `baseUrl`.
8. The extension list does not drift from the template's `MEDIA_MIME_TYPES` (pinned, with a control).
9. A `<video>` element is given a URL, **not** a blob — asserted directly, since reverting to a Blob is
   the specific regression that reintroduces the memory problem.
10. `pnpm typecheck && pnpm lint && pnpm test` green; upstream diff limited to one import + one JSX line.
11. Driven live in the real browser on a project containing an image, an MP4 and an MP3 — including
    **seeking within the video**, which is the property a Blob could not have delivered.

## Open Questions

1. **SVG** — preview, source, or a toggle? It is text and never reaches this component today.
   Recommendation: toggle later; editing SVG source is legitimate.
2. **`/@fs` across providers** — verified on the WebContainer preview earlier today. Confirm on Nodepod
   (the shipped default) during T1; if it does not hold there, non-`public/` files fall back to FR-4
   rather than gaining a byte path.
3. **Transparent images** — checkerboard backdrop or theme background? Recommendation: checkerboard, so
   a cut-out PNG (which §4.16 produces routinely) is distinguishable from a white one.
4. **Natural size / dimensions caption** — cheap and useful; recommend including it.

## Testing Guidelines

- `previewUrlForProjectFile` and the kind chooser are pure → plain unit tests **with controls** (a test
  asserting "png is an image" passes for a function that calls everything an image).
- The no-preview and error states are the ones users actually hit; assert the strings.
- AC-5 and AC-9 are the anti-regression pair: a source scan proving no byte read, and an assertion that
  the element's `src` is an http(s) URL rather than `blob:`.
- Live drive (AC-11) because this codebase's own history is that defects live in the wiring the unit
  tests drive around.

## Implementation sequencing (for bt-plan)

1. **T1** — `previewUrlForProjectFile` + kind chooser (pure, tested); confirm `/@fs` on Nodepod (OQ-2).
2. **T2** — `BinaryPreview.tsx`: element per kind, `onError` fallback, no-preview state, store-derived
   `src`.
3. **T3** — wire into `CodeMirrorEditor.tsx` (one import, one JSX line); `BinaryContent` becomes the
   fallback body.
4. **T4** — drift pin against the template's `MEDIA_MIME_TYPES`; source scan for AC-5.
5. **T5** — live drive (AC-11), including video seeking.
6. **T6** — SPEC.md subsection under the workbench/editor area.

## What this spec deliberately does NOT include (and why it was removed)

The first draft specified: byte reads via `readBinaryFile`, `Blob` construction, object-URL
create/revoke lifetimes, a `PREVIEW_MAX_MB` size gate, an LRU byte cache, a stale-read race guard, and
a detachment test using a transferring double. **All of it existed to manage bytes this design never
touches.** Recorded here so nobody re-adds a piece of it thinking it was an oversight — if a future
change genuinely needs the bytes client-side, that is a new decision with the memory cost stated up
front, not a gap in this one.
