# spec/binary-files.md — Binary files are first-class

Sub-spec for **SPEC §1.3 principle 10** and **§4.4**. Governs every path that moves project
files. Implemented; this documents the contract so it is not re-broken.

> **See also `spec/context-budget.md` (SPEC §4.2.8), which generalizes this one.** "Binary" turned out
> to be one of *three* reasons a file belongs in the project but not in the model's context — the
> others being *generated* (the lockfile) and *opaque* (vendored/minified code, `.svg`). All three are
> now declared to the model as `<boltFile>` markers and written to the sandbox out-of-band, by the same
> mechanism this spec introduced. The rule below — never route these through a `boltArtifact` — is
> unchanged; it simply applies to a wider set of files than "binary".

---

## 1. The bug this exists to prevent

Upstream bolt.diy's file layer is text-oriented. The WebContainer watcher decoded every file
as UTF-8 and, for anything that failed, stored `content: ''`:

```ts
// app/lib/stores/files.ts — BEFORE
const isBinary = isBinaryFile(buffer);
if (!isBinary) { content = this.#decodeFileContent(buffer); }
this.files.setKey(sanitizedPath, { type: 'file', content, isBinary });   // binary → content: ''
```

**Binary bytes were destroyed at ingest.** Everything downstream — snapshots, restore, ZIP
export, GitHub push — was then faithfully persisting an empty string. Measured: a 36,882-byte
PNG round-tripped through snapshot→restore as **0 bytes**. The user-visible symptom was Vite's
`Failed to resolve import ../assets/babylon.png` and a blank preview.

Three further paths *actively corrupted* binaries rather than dropping them: the starter
template (`zipEntry.async('string')`), git import (a non-fatal `TextDecoder` that replaced
every invalid byte with U+FFFD, then wrote the garbage back over the clone's correct bytes),
and all three deploy paths (`readFile(path, 'utf-8')` over `dist/`).

## 2. The contract

> **The WebContainer FS is the single source of truth for binary bytes.**

This is what makes principle 10's two halves reconcilable — *bytes always survive* AND
*binary content never reaches the model or the editor*. They are only compatible if the bytes
live somewhere other than the file map.

| Layer | Holds | Never holds |
|---|---|---|
| WebContainer FS | the real bytes | — |
| `FileMap` / `File` | `isBinary` + `size`, `content: ''` | binary content |
| LLM context | a `<boltFile binary size>` marker | binary content, empty `boltAction`s |
| Snapshots / deploys | base64 **wire format** | live store state |

**Rules:**

1. **`File.content` is ALWAYS empty when `isBinary`.** Read bytes with
   `FilesStore.readBinaryFile(path)`. Anything that reads `dirent.content` for a binary is a bug.
2. **Never route a binary through the `boltArtifact`/`boltAction` stream.** It is a TEXT
   protocol — the action runner UTF-8 encodes whatever it is handed, so a binary in an artifact
   is corrupted by construction, *and* the artifact reaches the model. Binaries are written to
   the sandbox **out-of-band** (direct `fs.writeFile` with a `Uint8Array`), and the artifact
   carries only text files.
3. **Never hand a binary to `fs.writeFile` as a string.** `writeFile(path, base64String)` writes
   the base64 *text*; `{ encoding: undefined }` does not make a string binary.
4. **base64 is a wire format, not a store format.** It is legal in a snapshot, a deploy payload,
   or a GitHub blob — never in the live `FileMap`.
5. **A missing binary is reported, never silently zeroed.** Serialization omits an unreadable
   file and logs it; a 0-byte PNG is the failure mode we are engineered against.

## 3. Where it lives

- **`app/lib/binary/binary-files.ts`** (net-new, additive per §2.1a) — codec (`bytesToBase64` /
  `base64ToBytes`), detection (`isBinaryBuffer` content sniff, `isBinaryPath` extension list),
  the watcher's entry builder (`fileEntryFromBuffer`), snapshot (de)serialization
  (`serializeFileMap` / `writeSerializedFileMap`), and the deploy wire format (`DeployFile`).
- **`app/lib/binary/binary-files.spec.ts`** — regression suite. Byte-identity round-trips,
  including a real on-disk PNG through the production snapshot path.
- Hooked into upstream at existing seams (FilesStore watcher, workbench egress, persistence,
  template route, import paths, deploy routes). **Extend, never rewrite** — this is the #1 merge
  hotspot (§2.1a).

`FilesStore` exposes `readBinaryFile()`, `serializeFiles()`, `restoreFiles()`; `workbenchStore`
re-exports them.

## 4. Covered paths

Template mount · git clone/import · folder import · WebContainer writes · snapshot · restore ·
ZIP export · folder sync · GitHub push · GitLab push · Netlify/Vercel/GitHub deploys · share
builds.

## 5. Required verification (do not trust a typecheck — these bugs are invisible to it)

1. **Round-trip is hash-identical.** snapshot → JSON transport → restore → sha256 equal to the
   original bytes. Asserted in the spec file for both synthetic and real PNGs.
2. **End-to-end, against the real starter:** mount `babylontoolkit/AppTemplate` → every binary
   byte-identical to a fresh `git clone` → `vite build` reports **zero** `UNRESOLVED_IMPORT` →
   `vite dev` boots and serves each asset with a matching sha256, and `file(1)` still identifies
   them as PNG/WASM.

3. **`public/babylon.png` + `public/spinner.png` are present** in the created project (SPEC §4.4 —
   framework requirement; copied from `src/babylon/assets/` at project creation). These two are
   the canonical smoke test: they were the observed casualties of the binary bug.

Last verified against `AppTemplate@main`: 12/12 binaries byte-identical (incl. `player.png`
109KB and `havok.wasm` 2MB), 3762 modules transformed, 0 unresolved imports, both `public/`
framework assets present and hash-identical to their sources.

## 6. Related kit requirements (SPEC §4.4)

The file layer cannot save a template that is itself broken:

- **No git submodules.** A zipball never contains submodule content (only a `160000` gitlink)
  and WebContainers cannot run `git submodule`. `src/babylon` must stay vendored in-repo.
- **Exact `@babylonjs/*` pins + a committed lockfile.** A caret on a package absent from
  `@babylonjs-toolkit/next`'s exact peer pins floats to a newer minor and breaks `npm run build`
  (which is what Share/publish runs).
