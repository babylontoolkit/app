# Implementation Plan — binary-media-viewer

Spec: `_specs/binary-media-viewer_spec.md`
Branch: `project/feature/binary-media-viewer`
`spec_impact`: **yes** (carried from the spec) → the SPEC.md write-back task is required and is last.

---

## Codebase Analysis

Read-only investigation completed before any plan content was written. Files actually inspected are
cited; conclusions only, no file dumps.

### The insertion point is exactly where the spec says, and nothing needs re-plumbing

- `app/components/editor/codemirror/BinaryContent.tsx` — the whole file is 7 lines: one named export
  `BinaryContent()`, no props, one `<div>` with
  `flex items-center justify-center absolute inset-0 z-10 text-sm bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary`
  and the literal `File format cannot be displayed.` Confirmed: no type awareness of any kind.
- `app/components/editor/codemirror/CodeMirrorEditor.tsx:313-318` — the overlay renders as
  `{doc?.isBinary && <BinaryContent />}` (line 315) inside `<div className={classNames('relative h-full', className)}>`.
  **`doc` is fully in scope at that line**, and `EditorDocument` (lines 36-41) is
  `{ value: string; isBinary: boolean; filePath: string; scroll?: ScrollPosition }` — so `doc.filePath`
  is available with **zero prop-chain changes**. Binary guards confirmed at `:172` (doc-sync effect
  bails), `:272` (document-setting effect bails) and `:458` (`editable && !doc.isBinary && !locked`).
  The overlay is `absolute inset-0 z-10` over a container CodeMirror never populates for a binary, so
  swapping the child is behaviour-preserving.
- Selection chain: `app/lib/stores/editor.ts:15` `selectedFile` atom → `:18` `currentDocument` computed →
  `app/lib/stores/workbench.ts:191/195` → `Workbench.client.tsx:299-300, 539-541` →
  `EditorPanel.tsx:167-176` (`doc={editorDocument}`). `setDocuments` (`editor.ts:35-61`) builds each doc
  from the FileMap, so **`doc.filePath` is a FileMap key, i.e. sandbox-ABSOLUTE** (`/home/project/…`).

### The URL join is already solved — delegate, do not re-implement

- `app/lib/stores/preview-url.ts:86-104` `previewUrlWithPath(baseUrl, path)` already handles the three
  traps its own doc comment records: a CodeSandbox base carrying `?preview_token=…` (so never
  string-concat), a base whose pathname is **not** `/` (Nodepod mounts previews same-origin at
  `/__virtual__/<pod>/<port>`, so the path is APPENDED to the base pathname, never assigned), and a
  malformed base (returned unchanged rather than throwing into a render). It also strips trailing
  slashes off the base pathname (`:95`), which is FR-1/AC-7's trailing-slash requirement already met.
  **FR-1's helper must delegate to this**, or it re-derives three fixed defects.
- `app/lib/stores/previews.ts:12-23` `PreviewInfo { port; ready; baseUrl; expiresAt? }`; the atom is the
  instance field `previews` (`:41`) on `PreviewsStore` (`:28`). `#applyPreviewUrl` (`:303-325`) swaps
  `baseUrl`/`expiresAt` in place and republishes the array, so **`baseUrl` genuinely mutates
  mid-session** — FR-5 is a live requirement, not a hypothetical.
- ⚠️ `usePreviewStore()` (`previews.ts:459`) is **not a React hook** and constructs a store over a stub
  sandbox (`:465`). Read `workbenchStore.previews`, exactly as `Preview.tsx:124`, `Workbench.client.tsx:297`,
  `DeployButton.tsx:38` and `HeaderActionButtons.client.tsx:64` all do.
- There is **no** existing "active preview base URL" selector — `Preview.tsx:125` open-codes
  `previews[activePreviewIndex]` and does **not** filter on `ready`. FR-1's "first `ready` preview" is
  new surface and belongs in the pure module.

### Paths

- `app/lib/common/sandbox-paths.ts` — `SANDBOX_ROOTS = ['/home/project', '/project/workspace']` (`:42`),
  `toProjectRelativePath()` (`:58`), `toSandboxStoreKey(raw, workdir)` (`:105`). WORK_DIR is a build-time
  constant (`app/utils/constants.ts:41`) resolved from `SANDBOX_PROVIDER_TRAITS`
  (`app/lib/common/sandbox-runtime.ts:126-155`): Nodepod `/home/project`, WebContainer `/home/project`,
  CodeSandbox `/project/workspace`. A `/home/project` literal is a banned spelling
  (`app/lib/common/workdir-literals.spec.ts`) — go through the helpers.

### The starter template's serving behaviour (verified byte-identically)

- Template `vite.config.ts` lives at `…/StarterProjects/AppTemplate/vite.config.ts`; its bytes are
  **byte-identical** to the pinned snapshot cached at
  `.data/storage/templates/snapshots/babylontoolkit__AppTemplate/e10214ee….json`.
- `MEDIA_MIME_TYPES` (lines 5-45) carries **40 extensions**; `applyMediaContentType` (lines 47-70) sets
  `Content-Type` **and `Access-Control-Allow-Origin: *` for every one of them**, matches on
  `req.originalUrl` **with the query string stripped** (so a `?t=` cache-buster is safe and was designed
  for), and is registered on both `configureServer` and `configurePreviewServer` (lines 233-247) — so it
  applies to `public/`, `src/` and `/@fs/` alike.
- `server.fs.allow: ['..']` (lines 146-148), no `fs.deny`, no `fs.strict` → `/@fs/<abs>` is permitted for
  anything in or one level above the project root. `publicDir` unset → Vite default `public/`.
  `base: './'` (line 74) is a **build** concern; Vite resolves a relative base to `/` in dev.
- ⚠️ **There is no copy of the template's bytes checked into this repo** (`git ls-files` → zero hits;
  `.data/` is gitignored at `.gitignore:57`). So the FR-2 drift pin **must be a hardcoded mirror with a
  comment naming its source**, optionally cross-checked against the local snapshot when it happens to
  exist. That is what the spec anticipated (spec lines 90, 143, 178).

### 🔴 Cross-origin isolation — the risk the spec does not mention

`app/entry.server.tsx:112-117` sets `Cross-Origin-Embedder-Policy: require-corp` +
`Cross-Origin-Opener-Policy: same-origin` whenever
`SANDBOX_PROVIDER_TRAITS[…].needsCrossOriginIsolation` — which is **true for Nodepod (the shipped
default) and WebContainer**, false only for CodeSandbox. Under `require-corp`, a **cross-origin**
subresource fetched in `no-cors` mode (which is what a bare `<img src>` / `<video src>` is) is refused
outright unless the response carries `Cross-Origin-Resource-Policy`. The template's middleware sets
`Access-Control-Allow-Origin: *` and **not** CORP.

- **Nodepod** — previews are served **same-origin** (`preview-url.ts:134-143`, `/__virtual__/<pod>/<port>`),
  so COEP does not apply at all. Expected ✅.
- **WebContainer** — previews are `*.local-credentialless.webcontainer-api.io`, i.e. cross-origin.
  `entry.server.tsx:94` asserts *"StackBlitz's preview hosts send CORP for exactly this reason"*, so
  expected ✅ — but that sentence is about **iframe documents**, not subresources, and this file's own
  history is that a claim in a comment is how a defect survives review.
- **CodeSandbox** — no COEP on the builder, so unrestricted. ✅.

The escape hatch if WebContainer blocks is `crossOrigin="anonymous"` (CORS mode, satisfied by the
template's `ACAO: *`) — but it is **not** the safe default: it *fails* against any project whose
`vite.config.ts` has lost the media middleware (a real case — imported and remixed projects carry their
own config), where plain no-cors would have worked. Hence **T1 probes before T2/T3 encode an answer**,
rather than shipping a guess and discovering it as "images are broken on WebContainer".

### Conventions this plan follows

- **Pure helpers**: `app/lib/<domain>/<kebab>.ts` + a `.spec.ts` **sibling in the same directory**. Closest
  prior art: `app/lib/stores/preview-url.ts` (+ spec) and `app/lib/media/sniff.ts` (+ spec) — small,
  dependency-free, one exported function, opening with a doc comment stating *why* it exists.
- **Tests**: no `vitest.config.ts`; the config is the `test:` block in `vite.config.ts:105-115`, which sets
  **only `exclude`** — default environment is `node`. jsdom is opt-in per file via a **line-1** pragma
  `// @vitest-environment jsdom` (27 specs do this) plus `import '@testing-library/jest-dom/vitest';`.
  `@testing-library/react` ^16.2.0. Component-spec examples: `app/components/media/MediaButton.spec.tsx`,
  `app/components/chat/ModelTierPanel.spec.tsx`.
- **Source scans**: `app/lib/sandbox/sandbox-seam.spec.ts` is the fullest example; also
  `no-prompt-classifier.spec.ts`, `no-server-storage.spec.ts`, `budgets-wiring.spec.ts`. The pattern:
  read off `join(process.cwd(), 'app')`, **strip comments first**, default-deny with a named allow-list,
  and a `describe('CONTROLS — …')` block proving the scanner is not vacuous.
- **Drift pins**: `app/lib/stores/map-exclusions.spec.ts` (both directions with `it.each`, plus a length
  equality *and* a hardcoded membership pin, because `it.each` over a list cannot notice the list
  shrinking) and `app/lib/preview/protocol.spec.ts:193-224` (behavioural comparison + a CONTROL, because
  the equality passes trivially if the argument is ignored).
- **Styling**: UnoCSS utilities inline, `classNames` from `~/utils/classNames`, tokens
  `bolt-elements-textPrimary/Secondary/Tertiary`, `bolt-elements-borderColor`,
  `bolt-elements-background-depth-1..4`. Icons are `i-ph:*` as an element's *only* class.
  Per SPEC §4.1a, `uno.config.ts`'s `content.pipeline.include` now covers `.ts` — but the shared class
  string stays module-local inside the `.tsx` anyway, so a future move cannot silently un-generate it.
- **`FilesStore`**: `app/lib/stores/files.ts:111` `File { type:'file'; content: string; isBinary: boolean; size?: number; … }`,
  binaries constructed as `{ content: '', isBinary: true, size }` (`:1278-1286`, `:1307-1332`). **`size` is
  the only thing known about a binary's contents** — which is exactly what FR-3's fallback needs.
- **The function this feature must never call**: `files.ts:984` `readBinaryFile(filePath)` and its facade
  `workbench.ts:182`. Legitimate existing callers are all egress (`workbench.ts:815,860,1018,1148`,
  `working-copy-writer.ts:151`). **Both spellings** get banned by the AC-5 scan.

### Facts that shape specific tasks

- **No `<img>` in this repo sources a project file today.** `MediaPanel.tsx` (661 lines) has zero `<img>`
  tags; chat attachments (`FilePreview.tsx:20`) use data URLs, which is exactly the precedent *not* to
  follow. So this is genuinely new surface, not a variation on something existing.
- **No image/video/audio EXTENSION list exists anywhere in `app/`.** The nearest analogues are
  `app/lib/binary/binary-files.ts:58` `BINARY_EXTENSIONS` (no leading dot; used only where bytes are
  unavailable) and `app/lib/.server/share/publish.ts:655` `CONTENT_TYPES` — and that second one **already
  drifts** from the template map (missing `avif/bmp/tiff/hdr/exr/basis/ktx`, `aac/flac/m4a/opus/weba`,
  `webm/m4v/ogv/mov/avi`; and `dds` disagrees). That existing drift is the argument for T5 being a real
  task rather than a formality.
- **SVG is TEXT and confirmed on both deciders** — `'svg'` is absent from `BINARY_EXTENSIONS`, and SVG's
  leading bytes are ASCII so `isBinaryBuffer` (`binary-files.ts`, `getEncoding` over the first 100 bytes)
  returns `'utf8'`. It therefore never reaches this component. OQ-1 stays out of scope.
- `.env` is likewise text, so it never reaches this component either — the spec's "not special-cased" is
  correct for a second, stronger reason.
- `workbenchStore.refreshPreviews()` (`workbench.ts:~139-157`) exists precisely because "an asset appeared
  and the browser never retries a 404'd `<img>`" — the same failure FR-6's retry addresses. Its
  cache-busting rationale is the one to mirror.
- `CodeMirrorEditor` is `memo`+`forwardRef`. A `useStore` subscription added **inside the editor** would
  re-render it on every preview re-mint; the subscription therefore lives inside `BinaryPreview`.

### Found, NOT in scope (flagged rather than silently fixed)

`app/lib/binary/binary-files.ts:58` `BINARY_EXTENSIONS` is missing `opus`, `weba`, `m4v` and `ogv`, all
four of which the template's `MEDIA_MIME_TYPES` serves. `isBinaryPath` is used only where bytes are not
yet available (classifying template zip entries), so a `.opus` in a template would be classified as text
at ingest — a §1.3-principle-10 shaped hazard adjacent to this feature. **Out of scope here**; recorded so
it is a known fact rather than a silent one.

### SPEC.md alignment

Read `SPEC.md` in full for the relevant surface. The plan conforms to:

- **§1.3 principle 10 / `spec/binary-files.md`** — nothing is read, copied or held. The sandbox FS stays
  the single source of truth; the FileMap keeps `isBinary` + `size` with empty content (AC-6).
- **§4.2.8 context budget** — client-only. No byte, data URI or base64 string enters `FileMap`, the
  artifact channel, or any agent context.
- **§2.1a pull compatibility** — additive-first. The upstream diff is one import + one JSX line in
  `CodeMirrorEditor.tsx`; `BinaryContent.tsx` is left **byte-identical on disk with no production
  callers**, which is precisely the hide-don't-delete shape §2.3 already applies to `useGit.ts`.
- **`spec/sandbox-seam.md`** — no provider-specific code. The base URL comes from `previewsStore`, path
  handling from `sandbox-paths.ts`, isolation behaviour from `SANDBOX_PROVIDER_TRAITS`. No new
  `@webcontainer/api` import, no `/home/project` literal.
- **§4.1 / §4.1a** — this is Code-tab surface. §4.1a governs the header row only; nothing here adds a
  toolbar control.
- **§4.9 assets** — this is a viewer for files already in the project, not the asset catalog.
- **§4.16** — the common case is `public/assets/generated/**` (`media/service.ts:956` `deriveDestPath`),
  which is under `public/` by design and therefore takes the cheap `public/`-stripping branch.

**Spec-impacting: yes.** A new user-facing behaviour in the Code tab, plus a new cross-repo coupling (this
repo now mirrors the starter template's `MEDIA_MIME_TYPES`) — both belong in SPEC.md. T8 records them.

---

## Tasks

- [x] **T1** — Probe the two unproven assumptions live, before writing any code
  - Files: none (read-only investigation; record findings in this file under a `## T1 findings` heading)
  - Details: Open a real project in the builder on the **shipped default provider (Nodepod)** with the
    dev server running, and answer four questions from the browser, not from reasoning:
    (a) does `<baseUrl>/starter.jpg` (a `public/` file) load in an `<img>`?
    (b) does `<baseUrl>/@fs/home/project/src/<some binary>` return 200 with the right `Content-Type`
    (OQ-2 — the spec verified `/@fs` on WebContainer earlier, never on Nodepod)?
    (c) repeat (a) and (b) on **WebContainer** (`VITE_SANDBOX_PROVIDER` unset), which is the only
    provider where the preview is cross-origin **and** the builder sends `COEP: require-corp` — check
    the response for `Cross-Origin-Resource-Policy` and watch for `ERR_BLOCKED_BY_RESPONSE`;
    (d) if (c) is blocked, confirm `crossOrigin="anonymous"` unblocks it (the template sets
    `Access-Control-Allow-Origin: *` on all 40 extensions).
    Use the chrome-devtools MCP tools; `list_network_requests` / `get_network_request` give the headers
    directly. **Do not add a `crossOrigin` attribute on the strength of reasoning** — the safe default is
    no attribute (it works same-origin and survives a project whose `vite.config.ts` lost the media
    middleware), and the attribute is only correct if (c) actually fails.
  - Acceptance: this file gains a `## T1 findings` section stating, per provider, whether `public/` and
    `/@fs` load, whether CORP is present, and the decided `crossOrigin` policy — each answer citing an
    observed status code or console error, never an inference. If `/@fs` fails on Nodepod, the finding
    explicitly records that non-`public/` files fall back to the FR-4 state (spec OQ-2's stated
    fallback) and T2/T3 are planned that way — **never** by adding a byte path.

- [x] **T2** — `previewUrlForProjectFile` + preview selection (pure, tested)
  - Files: `app/lib/preview/project-file-url.ts`, `app/lib/preview/project-file-url.spec.ts`
  - Details: Two exports, both pure, neither reading a store (FR-1 requires the helper stay testable).
    - `selectPreviewBaseUrl(previews: PreviewInfo[]): string | undefined` — the first entry with
      `ready === true`, else `undefined`. Deliberately stricter than `Preview.tsx:125`'s index-based read:
      an un-`ready` preview would 404 every element, and FR-4's named state is the honest answer there.
    - `previewUrlForProjectFile(filePath: string, baseUrl: string | undefined, workdir: string): string | null`
      — `null` when `baseUrl` is falsy (FR-4); otherwise normalise with
      `toProjectRelativePath(filePath)` from `~/lib/common/sandbox-paths`, then:
      **`public/` branch** — a relative path beginning with exactly `public/` has that prefix stripped
      (`public/assets/generated/hero.jpg` → `/assets/generated/hero.jpg`), because Vite serves
      `publicDir` at the preview root;
      **`/@fs` branch** — anything else uses `` `/@fs${toSandboxStoreKey(filePath, workdir)}` ``
      (`src/tex/x.png` → `/@fs/home/project/src/tex/x.png`), gated on T1(b)/(c) — if `/@fs` did not hold,
      this branch returns `null` and the component shows FR-4.
      Both branches return `previewUrlWithPath(baseUrl, path)` — **delegate, never re-join**: that
      function already owns trailing slashes, CodeSandbox's `?preview_token=` and Nodepod's non-`/` mount
      path, and its doc comment records the two live defects that produced those rules.
      Open with a doc comment stating why bytes are never read (link §1.3 principle 10) and why the join
      is delegated.
  - Acceptance: `pnpm test` green on a spec covering, at minimum — `public/` stripping; a leading-only
    match (`src/public/x.png` must **not** be stripped, and neither must `publicity/x.png`); the `/@fs`
    branch for a `src/` file; `null` with no `baseUrl` and with `''`; a `baseUrl` **with** a trailing
    slash and one **without** producing the identical URL; a CodeSandbox-shaped base with
    `?preview_token=abc` keeping its query intact; a Nodepod-shaped base
    (`https://app.example/__virtual__/pod/5173`) producing `/__virtual__/pod/5173/assets/x.png` rather
    than `/assets/x.png`; an already-relative input being idempotent; and both `workdir` values from
    `SANDBOX_PROVIDER_TRAITS`. `selectPreviewBaseUrl` covered for empty, all-unready, and
    first-unready-second-ready. **Plus a CONTROL** — a test that fails if the function ignores its
    `baseUrl` argument and returns a constant, since a spec asserting "png resolves to a URL" passes for
    a function that returns one URL for everything.

- [x] **T3** — The extension→kind chooser and the mirrored template map (pure, tested)
  - Files: `app/lib/preview/media-kind.ts`, `app/lib/preview/media-kind.spec.ts`
  - Details: FR-2 — kind is chosen by **extension**, deliberately, because the dev server already types
    the response by extension and a byte sniffer here would be a second detector competing with
    `vite.config.ts`. Export:
    - `TEMPLATE_MEDIA_EXTENSIONS: Readonly<Record<string, string>>` — a **verbatim mirror** of the
      template's `MEDIA_MIME_TYPES` (all **34** entries — corrected from "40" by the T1 findings, which
      counted the source twice; writing 40 would pin the mirror to a fiction), leading dots, lowercase,
      with a doc comment naming
      the source as `babylontoolkit/AppTemplate @ vite.config.ts → MEDIA_MIME_TYPES` and stating that
      **T6** pins it (the plan originally said "T5", which is the editor wiring — same one-word
      correction class as 40→34 above). This is not the render list — it is the drift anchor.
    - `mediaKindForPath(filePath: string): 'image' | 'video' | 'audio' | null` — `null` means "fall back",
      which FR-3 says is the *correct answer*, not a failure. Claim a kind only where mainstream browsers
      can actually decode it: **image** `.png .jpg .jpeg .webp .gif .bmp .avif .ico`; **video**
      `.mp4 .m4v .webm .ogv .mov`; **audio** `.mp3 .ogg .wav .aac .flac .m4a .opus .weba`. Everything else
      in the template map is deliberately excluded and each exclusion is recorded in a
      `DELIBERATELY_NOT_RENDERED` constant with a one-line reason — GPU texture containers
      (`.ktx .ktx2 .basis .dds .hdr .exr`), 3D payloads (`.gltf .glb .bin`), formats no browser decodes
      (`.tiff .tif`), a container Chrome does not play (`.avi`), and `.svg` (**text in this codebase**, so
      it never reaches this component at all — spec OQ-1, out of scope). Case-insensitive; a path with no
      extension, a dotfile, and a double extension (`scene.gz.gltf`) all resolve to `null`.
    - `describeUnrenderable(filePath: string, size: number | undefined): string` — FR-3's naming
      sentence, e.g. `WebAssembly module — 2.1 MB`, `TrueType font — 41 KB`, `Empty file`. A refusal that
      names no cause reads as the tool being broken (`share/build-failure.ts`); this is the same lesson.
      Falls back to the extension itself when unmapped (`.xyz file — 12 KB`), never to a generic string.
  - Acceptance: `pnpm test` green on a spec that asserts each kind for at least three real extensions,
    asserts `null` for `.wasm .ttf .bin .gltf .ktx2 .tiff .avi` and for an extensionless path, asserts
    case-insensitivity (`HERO.PNG`), and asserts `describeUnrenderable` names both type and a
    human-readable size (and says "empty" at size 0). **Plus CONTROLS**: a test proving
    `mediaKindForPath` does **not** return `'image'` for everything (feed it a `.wasm` and a `.txt` in the
    same assertion block) — per the spec's own Testing Guidelines, "a test asserting png is an image
    passes for a function that calls everything an image".

- [x] **T4** — `BinaryPreview.tsx`
  - Files: `app/components/editor/codemirror/BinaryPreview.tsx`,
    `app/components/editor/codemirror/BinaryPreview.spec.tsx`
  - Details: One component, `BinaryPreview({ filePath }: { filePath: string })`, replacing what
    `BinaryContent` rendered. It owns the same overlay shell —
    `absolute inset-0 z-10 flex items-center justify-center bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary` —
    as a **module-local const used by every branch**, so the fallback and the media branches cannot drift
    apart (§4.1a's one-shared-style lesson, applied one level down).
    - **`src` is derived on every render** (FR-5): `useStore(workbenchStore.previews)` →
      `selectPreviewBaseUrl` → `previewUrlForProjectFile(filePath, baseUrl, WORK_DIR)`. Never cached in
      state, because `#applyPreviewUrl` re-mints `baseUrl` in place and a cached string becomes a broken
      element. Subscribe **inside this component, not inside `CodeMirrorEditor`** — the editor is
      `memo`'d and would otherwise re-render on every re-mint.
    - **`size` is read non-reactively** — `workbenchStore.files.get()[filePath]?.size` — because a binary's
      size does not change while you look at it, and `useStore(workbenchStore.files)` would re-render this
      component on every file the watcher delivers.
    - **Branches, in order**: no `src` → FR-4, *"Start the dev server to preview this file."*;
      `size === 0` → FR-3 fallback (`Empty file`) with no network request attempted;
      `mediaKindForPath` → `null` → FR-3 fallback naming type + size;
      `image` → `<img>`; `video` → `<video controls preload="metadata">`; `audio` → `<audio controls>`.
    - **`onError` → FR-6**: swap to the fallback with a reason (*"Could not load this file from the dev
      server."*) plus a **Retry** affordance that bumps a nonce appended as `?t=<nonce>` — safe because
      `applyMediaContentType` strips the query before matching, which it was written to do. Error state
      **resets when `src` or `filePath` changes** (a `key={src}` on the element, or an effect on
      `[src, filePath]`), or a transient 404 on one file poisons every later file in the session. It must
      never throw into the editor's render path.
    - **`crossOrigin`**: apply exactly what T1 decided, with a comment citing the observation. Default is
      **no attribute**.
    - **OQ-3 / OQ-4 (spec recommends both)**: a CSS checkerboard behind `image` so a §4.16 cut-out PNG is
      distinguishable from a white one, and a caption reading natural dimensions + size on `onLoad`
      (`img.naturalWidth/naturalHeight`, `video.videoWidth/videoHeight`). Both are additive and neither
      may block the element rendering.
    - Media is `max-w-full max-h-full object-contain`; the shell scrolls nothing (it is an overlay).
  - Acceptance: `pnpm test` green on a `.spec.tsx` with the **line-1** `// @vitest-environment jsdom`
    pragma. Assertions: with no ready preview the FR-4 sentence is on screen and **no `<img>` is
    rendered**; with a ready preview a `.png` renders an `<img>` whose `src` is the resolved
    `http(s)` URL; an `.mp4` renders a `<video>` with `controls`; an `.mp3` renders an `<audio>` with
    `controls`; `havok.wasm` renders neither and shows a sentence containing both the type and the size;
    a zero-byte file shows the empty-file sentence and issues no request; firing `error` on the element
    swaps to the reason text and shows Retry, and Retry produces a **different** `src`; and changing
    `filePath` after an error clears the error. **AC-9 is asserted here directly**: the `<video>`'s `src`
    matches `/^https?:/` and **not** `/^blob:/` — reverting to a Blob is the specific regression this
    assertion exists to catch, so assert both halves, not just the positive.

- [x] **T5** — Wire into the editor
  - Files: `app/components/editor/codemirror/CodeMirrorEditor.tsx`
  - Details: Change the line-25 import from `BinaryContent` to `BinaryPreview`, and line 315 from
    `{doc?.isBinary && <BinaryContent />}` to `{doc?.isBinary && <BinaryPreview filePath={doc.filePath} />}`.
    Nothing else in the file changes — `doc` is already in scope and the binary guards at `:172`, `:272`
    and `:458` already do the right thing (FR-7: editing stays disabled; this task adds no save path, no
    drag-replace, no write). **`BinaryContent.tsx` is left byte-identical on disk** with no production
    callers — §2.1a hide-don't-delete, the same shape §2.3 already applies to `useGit.ts`.
  - Acceptance: `git diff` against `CodeMirrorEditor.tsx` shows exactly **two changed lines and zero
    added lines** (AC-10); `git diff --stat` shows `BinaryContent.tsx` untouched;
    `pnpm typecheck && pnpm lint` green.

- [x] **T6** — The two anti-regression pins: no bytes, no drift
  - Files: `app/lib/preview/binary-preview-guards.spec.ts`, `app/lib/preview/media-kind.spec.ts`
    (extend with the drift block)
  - Details: two independent guards, each written the way this codebase's own scans are written.
    - **AC-5 source scan** — read `BinaryPreview.tsx`, `project-file-url.ts` and `media-kind.ts` off
      `join(process.cwd(), 'app')`, **strip comments first** (a doc comment explaining why we do not read
      bytes must not trip the scan — that trap is why `sandbox-seam.spec.ts` strips), and assert that
      neither `readBinaryFile` **nor** `workbenchStore.readBinaryFile` **nor** `sandbox.fs.readFile` nor
      `createObjectURL` nor `new Blob` appears. Default-deny with an explicit allow-list, and a `SELF`
      exclusion **by exact path** (the spec names the forbidden strings as data, so it would flag itself;
      excluding by a `*.spec.ts` pattern is the documented bug that let a real import hide).
      **CONTROLS**, per the house rule that a scan matching nothing reports a clean bill of health
      forever: assert each file's stripped source is >200 chars and contains a known export; assert
      `readBinaryFile` **is** found in `app/lib/stores/files.ts` (proving the needle is findable); and
      assert a commented mention does not trip the scan.
    - **AC-8 drift pin** — compare `TEMPLATE_MEDIA_EXTENSIONS` against a second hardcoded copy of the
      template's map, **both directions** with `it.each` (every extension present in both; every MIME
      equal), **plus a length equality** and **a hardcoded membership pin** for at least three entries —
      because `it.each` over a list cannot notice that list shrinking (`map-exclusions.spec.ts`'s
      technique). Additionally assert every extension `mediaKindForPath` claims is present in
      `TEMPLATE_MEDIA_EXTENSIONS` with a matching MIME prefix (`image/`, `video/`, `audio/`), and that
      `DELIBERATELY_NOT_RENDERED` ∪ the claimed set **exactly equals** the template map — so the template
      **gaining** an extension fails this test, which is the drift that actually matters. Optionally
      cross-check against the local pinned snapshot at
      `.data/storage/templates/snapshots/babylontoolkit__AppTemplate/*.json` **when it exists** — a soft
      check that must skip cleanly in CI, never a dependency (`.data/` is gitignored).
  - Acceptance: `pnpm test` green. **Mutation-verified and the verification recorded in the commit
    message**: deleting the comment strip makes the scan fail (proving it is looking at code);
    reintroducing a `readBinaryFile` call in `BinaryPreview.tsx` makes the scan fail; removing one entry
    from `TEMPLATE_MEDIA_EXTENSIONS` makes the drift pin fail; adding one makes it fail. A guard that
    passes with the thing it guards removed is not a weak test, it is no test.

- [x] **T7** — Live drive on the real browser (AC-11)
  - Files: none (record results in this file under `## T7 findings`)
  - Details: This codebase's own history is that defects live in the wiring the unit tests drive around
    (the §4.14 MCP relay, the §4.5.6 chat wiring). Run the shipped default (**Nodepod**) with a project
    containing at least: a PNG **and** a transparent cut-out PNG under `public/`, a PNG under `src/`, an
    MP4, and an MP3. Using the chrome-devtools MCP tools, click each in Code view and verify:
    the image renders; the transparent one is distinguishable against the checkerboard; the `src/` image
    renders via `/@fs` (or shows FR-4 if T1 ruled `/@fs` out on this provider); the MP4 renders a
    `<video controls>` **and seeks** — scrub to the middle and confirm playback resumes there, which is
    the property a Blob could not have delivered and is therefore the load-bearing observation of this
    task; the MP3 plays; `havok.wasm` shows the FR-3 fallback naming type and size and **never a blank
    pane**; and with the dev server stopped every binary shows the FR-4 sentence rather than a
    broken-image icon (AC-4). Confirm **AC-6** from the console:
    `workbenchStore.files.get()['<the png path>']` still reports `content === ''` and `isBinary === true`
    after viewing. Repeat the image + video checks once on **WebContainer** to close the COEP question
    with an observation rather than a comment.
  - Acceptance: a `## T7 findings` section with a per-item pass/fail, at least one screenshot reference
    for the video mid-seek, the console output for the AC-6 check quoted verbatim, and the WebContainer
    result stated. Any failure is reported and fixed, not narrated as a pass — the model describing
    success is not verification.

- [x] **T8** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details: Add **§4.1b — Binary media preview in Code view** immediately after §4.1a (the last
    subsection of §4.1 before §4.2), following SPEC.md's "How to update this spec" contract: **replace/merge**
    into the current-state sections and **append** to the Decisions log, never delete. Record:
    (a) clicking a binary in Code view renders `<img>`/`<video controls>`/`<audio controls>` pointed at the
    **running preview's URL**, with a named fallback for anything unrenderable and a named state when no
    dev server is running; (b) 🔴 **no bytes are read** — the URL is the mechanism precisely *because* it
    means video streams with range requests, there is no object-URL lifetime to leak, and neither the
    `readFile`-bytes-are-on-loan class nor §4.2.8 is touched; the "What this spec deliberately does NOT
    include" list from the feature spec is carried across so nobody re-adds a Blob thinking it was an
    oversight; (c) 🔴 **this repo now mirrors the starter template's `MEDIA_MIME_TYPES`** — a new
    cross-repo coupling, pinned by a drift test, and the reason the template gaining an extension must
    fail a test here; (d) the COEP finding from T1 stated as an **observation with its date**, per this
    codebase's rule that a live config cited in the present tense goes stale silently; (e) kind is chosen
    by extension **deliberately**, not by a byte sniffer, so there is exactly one detector; (f) SVG stays
    editable source (text — it never reaches this component) as an open item, and the
    `BINARY_EXTENSIONS` gap found in the analysis flagged as known-and-unfixed. Also update
    §4.1's Code-tab bullet, which currently describes only IntelliSense.
  - Acceptance: SPEC.md accurately describes the shipped behaviour; no section contradicts the code; the
    template-mirroring coupling and the no-bytes decision are both recorded with their rationale; no new
    dependency was added, so the Dependencies section needs no change and the plan says so explicitly.

---

## T1 findings

Probed live 2026-08-14 in Chrome against the running builder (`http://localhost:5173`, `.env.local`
`VITE_SANDBOX_PROVIDER=nodepod`), project **Classic Asteroids** (`prj_20260815035847_6bkfk4jp`, Blank
Canvas starter, 76 files) with its dev server up. Every answer below is an observed status code, header
or console result. Nothing here is reasoned from the source unless it says "executed".

### Decision (this is what T2/T3/T4 encode)

- **`crossOrigin`: NO ATTRIBUTE.** This is the plan's stated safe default and it is now backed by a
  positive observation rather than by the absence of a counter-example: bare no-cors `<img>` loads
  succeeded on the only provider this build can run, with `COEP: require-corp` genuinely active
  (`window.crossOriginIsolated === true`).
- **The `/@fs` branch is LIVE.** OQ-2 is answered yes on Nodepod. T2 keeps it; the FR-4 fallback is not
  needed for non-`public/` files.

### Per provider

| Provider | `public/` | `/@fs` | CORP on preview responses | Verdict |
|---|---|---|---|---|
| **Nodepod** (shipped default, the one under test) | ✅ 200 | ✅ 200 | ✅ present | fully answered |
| **WebContainer** | — | — | — | 🔴 **not selectable in this build** (see below) |
| **CodeSandbox** | — | — | — | not selectable in this build |

**Nodepod — (a) `public/`.** `previews` held exactly one entry,
`{ port: 5173, ready: true, baseUrl: "http://localhost:5173/__virtual__/pod050f09c8/5173" }`, no
`expiresAt`. Real `<img>` elements with **no `crossOrigin` attribute**:

- `…/5173/starter.jpg` → `load`, `naturalWidth/Height = 2400×1436`; response `200`,
  `content-type: image/jpeg`, `content-length: 573334`.
- `…/5173/babylon.png` → `load`, `180×208`; `200`, `content-type: image/png`.

**Nodepod — (b) `/@fs`.** Same no-`crossOrigin` `<img>` probes, URL built exactly as T2 specifies
(`` `/@fs${absoluteSandboxPath}` ``, appended to the base pathname):

- `…/5173/@fs/home/project/src/assets/hero.png` → `load`, `343×361`; `200`, `content-type: image/png`,
  `content-length: 13057`.
- `…/5173/@fs/home/project/src/assets/player.png` → `load`, `596×704`; `200`, `image/png`, `109829`.

So **OQ-2 resolves in favour of `/@fs` on Nodepod.** No byte path is needed and none is added.

**Nodepod — COEP was genuinely on, so the test meant something.** The builder document's own response
carries `cross-origin-embedder-policy: require-corp` and `cross-origin-opener-policy: same-origin`;
`window.crossOriginIsolated === true` and `SharedArrayBuffer` exists. The probes still passed because
the Nodepod preview is **same-origin** (`new URL(baseUrl).origin === location.origin` → `true`;
mount `/__virtual__/pod050f09c8/5173`), so COEP never applies to these subresources.

**Nodepod — CORP is present anyway.** Every preview response carried
`cross-origin-resource-policy: cross-origin` and `cross-origin-embedder-policy: credentialless`
(alongside `vary: Origin`, `cache-control: no-store`). Recorded as an observation about Nodepod only —
it is **not** evidence about WebContainer, and must not be cited as such.

**(c)/(d) — WebContainer and CodeSandbox could not be probed, and the reason is not a shortfall.**
`app/lib/common/sandbox-runtime.ts:67` declares `ENABLED_SANDBOX_PROVIDERS = ['nodepod']`. Executing the
real resolver (`node --experimental-strip-types` over the unmodified module) gives:

```
resolve(undefined)      = nodepod      <- "VITE_SANDBOX_PROVIDER unset"
resolve("webcontainer") = nodepod
[sandbox] VITE_SANDBOX_PROVIDER="webcontainer" is DISABLED in this build (enabled: nodepod); using
nodepod. See ENABLED_SANDBOX_PROVIDERS in app/lib/common/sandbox-runtime.ts.
```

Two consequences, both worth stating plainly:

1. ⚠️ **The task's own parenthetical is stale.** "`VITE_SANDBOX_PROVIDER` unset" no longer selects
   WebContainer — `DEFAULT_SANDBOX_PROVIDER` is `nodepod`, so unset *is* Nodepod. Restarting the dev
   server with the var removed would have re-run the Nodepod probes and reported them as a WebContainer
   pass. That is the "model narrates success" failure this codebase keeps recording, and it is the
   reason the resolver was executed before the server was touched.
2. **Enabling WebContainer was NOT done deliberately.** It would mean editing
   `ENABLED_SANDBOX_PROVIDERS`, which is outside T1's declared files (`none`) and is a **licensing**
   wall, not a config knob (`spec/licensing.md` makes a StackBlitz plan a hard Phase-3 gate).

**So the COEP question stays OPEN for WebContainer — and it is not blocking**, because no shipped
configuration can reach it. The decided policy (no attribute) is correct for every provider this build
can select. **Re-test trigger:** if `webcontainer` is ever added back to `ENABLED_SANDBOX_PROVIDERS`,
re-run (a)/(b) there and check for `ERR_BLOCKED_BY_RESPONSE`; the escape hatch remains
`crossOrigin="anonymous"` (the template sets `Access-Control-Allow-Origin: *`), and it must still not
become the default — see the `.wasm` observation below for why it is not free.

### Three further observations that change how T4 must be written

1. 🔴 **A missing file returns `200`, not `404` — so `response.ok` is a LIE here and FR-6 must stay
   `onError`-driven.** `…/@fs/home/project/src/assets/DOES_NOT_EXIST.png` and `…/5173/NOPE_MISSING.png`
   both returned **`200`** with `content-type: image/png` and a **623-byte body that is the app's
   `index.html`** (`<!doctype html>\n<html lang="en">…@react-refresh…`) — Vite's SPA fallback, retyped by
   the template's extension-based middleware, which matches the URL and neither knows nor cares that no
   file exists. The `<img>` still fired **`error`** (decode failure), so FR-6 works exactly as planned —
   but any future "check it exists first" preflight built on `fetch(...).ok` would report every missing
   file as present. The element's own `onError` is the only reliable signal.
2. ✅ **The FR-6 retry cache-buster is safe.** `…/starter.jpg?t=1786774508223` → `200`,
   `content-type: image/jpeg`, `content-length: 573334`, `<img>` `load 2400×1436`. The template's
   `applyMediaContentType` strips the query before matching, as its design intended.
3. ⚠️ **`Access-Control-Allow-Origin: *` is present on media extensions and ABSENT on `.wasm`.**
   `…/scripts/havok.wasm` returned `200 application/wasm` with **no** ACAO header (the template's map is
   media-only; that content-type came from Vite itself). Concrete evidence that `crossOrigin="anonymous"`
   is not a free default — it would fail for exactly the files FR-3 falls back on.

### 🔴 A number in this plan's own Codebase Analysis is WRONG — fix before T3

The Codebase Analysis above states `MEDIA_MIME_TYPES` "carries **40 extensions**". **It carries 34.**
Counted twice, independently, off
`/Users/mackey/Documents/Repos/Babylon/Repositories/StarterProjects/AppTemplate/vite.config.ts`
(zero duplicate keys) and corroborated against the pinned snapshot
`.data/storage/templates/snapshots/babylontoolkit__AppTemplate/e10214ee…json`:

```
MEDIA_MIME_TYPES ENTRY COUNT = 34
duplicate keys: none
```

The 34: `.gltf .glb .bin` · `.png .jpg .jpeg .webp .gif .bmp .tiff .tif .avif .ico .svg` ·
`.hdr .exr .ktx .ktx2 .basis .dds` · `.mp3 .ogg .wav .aac .flac .m4a .opus .weba` ·
`.mp4 .m4v .webm .ogv .mov .avi`.

This is **not** cosmetic: **T3** mandates a verbatim mirror of "all 40 entries" and **T6**'s drift pin
asserts a *length equality*, so writing either against 40 pins the mirror to a fiction and the drift
test fails on its first run — or worse, is "fixed" by padding the mirror. **T3 must be corrected to 34
before it is executed.** Left unedited here on purpose: amending T3/T6's text is those tasks' scope, not
T1's.

Two further facts read out of the same file, both load-bearing for T3:

- **ACAO is set only inside `if (mime)`**, which is the mechanism behind the `.wasm` observation above —
  `.wasm` is genuinely absent from the map, so it gets no ACAO and `crossOrigin="anonymous"` would fail
  on it. The `.wasm` content-type came from Vite, not this middleware.
- **The middleware normalises three gzip double-extensions** (`.gz.gltf` → `.gltf`, `.gz.glb`, `.gz.bin`)
  before lookup. T3 wants `scene.gz.gltf` → `null`, which stays correct (`.gltf` is not a rendered kind),
  but the mirror's doc comment should note the normalisation exists rather than implying a naive
  `lastIndexOf('.')`.

### Preconditions for later tasks, confirmed incidentally

- FileMap keys are **sandbox-absolute** (`/home/project/public/starter.jpg`), as the analysis stated —
  so T2's `toSandboxStoreKey`/`toProjectRelativePath` handling is correct.
- **AC-6 already holds before the feature exists**: all 13 binaries in the mounted project report
  `content: ""` with `isBinary: true` and a real `size` (e.g. `havok.wasm` `2094566`,
  `starter.jpg` `573334`). T7 re-checks this *after* viewing.
- `PreviewInfo` shape matches the spec, and Nodepod reports **no** `expiresAt` — FR-5 is exercised by
  the other providers, not this one.
- The Blank Canvas starter carries **no `.mp4`/`.mp3`**, so **T7 must add or generate an MP4 and an MP3**
  (and a transparent cut-out PNG) before its live drive can be run.

## T7 findings

Driven live 2026-08-14 in Chrome (chrome-devtools MCP) against the running builder
(`http://localhost:5173`, `.env.local` `VITE_SANDBOX_PROVIDER=nodepod`), project **Classic Asteroids**
(`prj_20260815035847_6bkfk4jp`), through the **real UI** — every result below comes from clicking an
entry in the Code-view file tree, never from calling the component directly. Screenshots in
`_specs/t7-evidence/`.

**Fixtures.** T1 recorded that the Blank Canvas starter carries no `.mp4`/`.mp3`, so three were made
with ffmpeg and written into the sandbox through `workbenchStore.createFile`: a 10s H.264 MP4
(`+faststart`, 155,095 B), an 8s MP3 (64,592 B), and a 400×400 RGBA cut-out PNG. ⚠️ The cut-out was
**pixel-verified before use** — the first attempt was colortype 6 and **100% transparent** (the shape
never rendered), which would have made the OQ-3 check meaningless while looking fine in a container
check. The one used is 44.2% opaque / 55.8% fully transparent. This is `sniff.ts`'s rule applied to a
test fixture: *a container is not a content check*.

### Per item

| # | Item | Result |
|---|---|---|
| 1 | PNG/JPG under `public/` (`starter.jpg`) | ✅ `<img>`, 2400×1436, caption `2400 × 1436 · 559.9 KB` |
| 2 | Transparent cut-out vs checkerboard | ✅ opaque disc over a clearly visible checkerboard — screenshot `cutout-checkerboard.png` |
| 3 | Image under `src/` via `/@fs` (`hero.png`) | ✅ `…/@fs/home/project/src/assets/hero.png`, 343×361 |
| 4 | MP4 `<video controls>` **and seeks** | ✅ see below — screenshot `video-midseek.png` |
| 5 | MP3 plays | ✅ `<audio controls>`, `readyState 4`, `duration 8`, caption `63.1 KB` |
| 6 | `havok.wasm` names type + size, never blank | ✅ `WebAssembly module — 2.0 MB`, zero media elements |
| 7 | Dev server stopped → FR-4, not a broken image | ⚠️ **PARTIAL — read the detail**, two distinct states |
| 8 | AC-6 — no bytes in the file map after viewing | ✅ verbatim below |
| 9 | WebContainer repeat | 🔴 **still not selectable in this build** — unchanged from T1 |

**(4) The seek is the load-bearing observation, and it passed.** `<video controls preload="metadata">`,
`duration 10`, `640×360`, `readyState 4`. Set `currentTime = 5.0` → `seeked` fired → played on from
**5.0 → 6.148s**. The screenshot shows the native transport reading **`0:05 / 0:10`** with the test
pattern's frame counter on `5`, under breadcrumb `public > assets > clip.mp4`. **AC-9 asserted live at
the same moment**: `src` matched `/^https?:/` and did **not** match `/^blob:/`. A Blob could not have
served a range request; this is the property the whole design was chosen for.

**(7) The stopped server produced TWO distinct states, and the difference is worth recording.** The dev
server was genuinely killed (`sandbox.spawn('sh', ['-c', 'pkill -f vite …'])`, exit 0; the preview URL
then answered **503**), not simulated.

- **Server dead, `previews` atom still `ready: true`** (it does not notice the death). Verbatim:

```
{"file":"starter.jpg","text":"Could not load this file from the dev server.Retry","mediaCount":0,"hasRetry":true}
{"file":"clip.mp4",   "text":"Could not load this file from the dev server.Retry","mediaCount":0,"hasRetry":true}
{"file":"havok.wasm", "text":"WebAssembly module — 2.0 MB",                       "mediaCount":0,"hasRetry":false}
```

  (`havok.wasm` is unaffected because it never touches the network — the FR-3 branch returns before any
  URL is used.) The kill and the 503 that confirmed it, verbatim from the same session:

```
{"killExit":0,"probeAfterKill":{"status":503,"type":"text/plain"},
 "base":"http://localhost:5173/__virtual__/podc99557ad/5173"}
```

- **The genuine FR-4 precondition — no ready preview.** Verbatim, at the moment of the click:

```
{"previewsAtClick":[],"overlayText":"Start the dev server to preview this file.","mediaCount":0,
 "breadcrumbHasFile":true}
```

  Screenshot `no-dev-server-fr4.png` shows exactly that state: **Code** tab, `starter.jpg` selected in
  the tree, breadcrumb `public > starter.jpg`, the pane reading *"Start the dev server to preview this
  file."*, and the terminal still on `npm run dev`.
  ⚠️ **The first version of this screenshot was WRONG and an adversarial verifier caught it** — it had
  captured the app mid-reload (Preview tab, a spinner) and did not contain the sentence at all, while
  the text beside it asserted that it did. Re-taken, and the state was re-asserted in the DOM
  immediately before the capture. Recording the miss rather than quietly replacing the file: a
  screenshot cited as proof of a state it does not show is precisely the "model describes success"
  failure this task exists to prevent, and it happened here.

So AC-4's **letter** ("shows the FR-4 message") holds only once the store reflects reality; its
**substance** ("not a broken-image icon") holds in both states, because the other state is FR-6's named
sentence with a working recovery. ⚠️ The stale-preview behaviour is **pre-existing and NOT this
feature's** — `previews` has no server-death detection — but it is now user-visible where it was not
before, and it is the reason FR-6 had to be a named state with a Retry rather than a silent blank.

**(8) AC-6 — the console's own output, unedited**, read after viewing every file, including the 2 MB
wasm and the MP4:

```json
[{"path":"/home/project/public/starter.jpg","entry":{"type":"file","content":"","isBinary":true,"size":573334,"isLocked":false}},
 {"path":"/home/project/public/assets/cutout.png","entry":{"type":"file","content":"","isBinary":true,"size":1646,"isLocked":false}},
 {"path":"/home/project/src/assets/hero.png","entry":{"type":"file","content":"","isBinary":true,"size":13057,"isLocked":false}},
 {"path":"/home/project/public/assets/clip.mp4","entry":{"type":"file","content":"","isBinary":true,"size":155095,"isLocked":false}},
 {"path":"/home/project/public/assets/theme.mp3","entry":{"type":"file","content":"","isBinary":true,"size":64592,"isLocked":false}},
 {"path":"/home/project/public/scripts/havok.wasm","entry":{"type":"file","content":"","isBinary":true,"size":2094566,"isLocked":false}}]
```

Only the line breaks between array elements are added. Every caption in the table above is these same
numbers through `formatSize` (÷1024): 573334 → `559.9 KB`, 155095 → `151.5 KB`, 64592 → `63.1 KB`,
1646 → `1.6 KB`, 2094566 → `2.0 MB`.

**(9) WebContainer.** `ENABLED_SANDBOX_PROVIDERS = ['nodepod']` still holds, so the COEP question stays
open exactly as T1 left it — not a shortfall, and not blocking, because no shipped configuration can
reach it. The re-test trigger in T1 is unchanged.

### Two things the live drive found that no unit test could

1. ✅ **FR-6 fired for real, on its actual edge case, and recovered.** The very first file opened
   (`theme.mp3`, written seconds earlier) showed *"Could not load this file from the dev server."* —
   the dev server had not picked the new file up yet, which is the exact row in the spec's edge-case
   table. **Retry** produced `…/theme.mp3?t=1` and it loaded (`readyState 4`, `duration 8`). The retry
   is not decorative; it was needed within a minute of first use.
2. ✅ **FR-5 was exercised for real, twice, which T1 predicted Nodepod would not do.** Restarting the
   dev server minted a **new pod id** (`podc99557ad` → `pod3e93ad5e`), and both files opened afterwards
   resolved against the NEW base and loaded (`usesNewPod: true`, `loadedOK: true`). Better still, the
   FR-4 capture above caught the transition live: with `previews: []` the pane read *"Start the dev
   server…"*, and when the server came up as `pod5c88a43c` the same pane — **with no user action** —
   became `<img>` with caption `2400 × 1436 · 559.9 KB`. That is the store-derived `src` doing exactly
   what FR-5 asks. T1 said "FR-5 is exercised by the other providers, not this one"; a pod restart
   exercises it on Nodepod too.

### Honest limits of this drive

- **Item 7 is PARTIAL, not a pass**, and the table says so. AC-4's substance ("never a broken-image
  icon") held in both states; its letter ("the FR-4 message") holds only once `previews` reflects
  reality. The stale-preview gap is **pre-existing and not this feature's** — `previews` has no
  server-death detection — but this feature makes it user-visible, which is the argument for FR-6 being
  a named state with a working Retry rather than a blank pane.
- **Item 1's `public/` image is a JPG** (`starter.jpg`); the PNG-under-`public/` case is covered by
  `cutout.png` in item 2, same code path.
- **Not every item has a screenshot.** Items 3, 5 and the 5.0 → 6.148s playback half are console values
  only; the mid-seek frame, the checkerboard and the FR-4 state are the three that are pictured.
- **The final "76 files, fixtures gone" is a post-reload store read**, not proof of a cleanup routine —
  the pod is simply recreated on reload and the fixtures were never checkpointed. The repo itself was
  verified clean with `git status`.
- **No exception from `BinaryPreview` appears in the console** across the whole session (the only two
  errors are 404 resource loads during the pod transition, neither from the render path).

## Notes carried forward

- **No new dependencies.** `@testing-library/react`, `jsdom` and `@testing-library/jest-dom` are already
  present; everything else is existing internal modules. ✅ **Confirmed at T8: `package.json` and
  `pnpm-lock.yaml` are both unmodified, so no dependency record needed changing anywhere in SPEC.md**
  — stated explicitly per T8's Acceptance rather than left as a silent omission. (SPEC.md has no
  section literally named "Dependencies"; the claim is about the absence of any dependency change, and
  it was verified with `git diff` rather than asserted.)
- **Open Questions disposition** — OQ-1 (SVG): out of scope, recorded in T8(f). OQ-2 (`/@fs` on Nodepod):
  answered by T1, with the spec's own stated fallback (FR-4, never a byte path) if it fails.
  OQ-3 (checkerboard) and OQ-4 (dimensions caption): both adopted per the spec's recommendation, in T4.
- **Task order is dependency order.** T1 gates T2/T4 because it decides the `/@fs` branch and the
  `crossOrigin` attribute; T5 needs T4; T6 needs T3 and T4; T7 needs everything; T8 is last so it records
  the true final state.

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
