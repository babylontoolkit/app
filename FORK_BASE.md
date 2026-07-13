# FORK_BASE.md — Upstream Fork Record

| Field | Value |
|---|---|
| Upstream repo | https://github.com/stackblitz-labs/bolt.diy |
| Upstream license | MIT (retained; see LICENSE) |
| Forked at commit | `<FILL IN: git rev-parse HEAD of upstream at fork time>` |
| Fork date | `<FILL IN>` |
| Fork repo | github.com/babylontoolkit/app-builder (private) |

## Upstream pull log

| Date | Upstream commit pulled to | Notes / conflicts |
|---|---|---|
| — | — | — |

## Pull policy

Per SPEC §2.1/§2.1a: **indefinite pull compatibility** — monthly pulls (and before each phase gate), CI green post-merge, every pull logged above. No divergence cutoff is planned; if one is ever forced, record date, final upstream commit, and reason here with a SPEC change in the same PR.

## Major intentional divergences (keep this list honest — it is the merge map)

- System prompt pipeline replaced (SPEC §4.3)
- Project creation: templates-only (SPEC §4.4)
- Persistence: Supabase hosted layer replaces local-first storage (SPEC §4.5)
- LLM calls moved server-side behind agent proxy + credit gate (SPEC §3, §4.2)
- Provider picker demoted to Settings › Advanced / BYOK (SPEC §2.3)
- Skills runtime added (SPEC §4.11)
- Branding/UX pass (SPEC §2.3, §4.1)
- **Binary files are first-class (SPEC §1.3 principle 10, §4.4)** — see divergence map below

## Divergence map — binary-file support (merge hotspot: file layer)

Upstream's file layer is text-oriented and destroys binary bytes at ingest. Per §2.1a this is
implemented as an ADDITIVE module hooked into existing seams; upstream's `FileMap`/`File` types
and control flow are extended, never restructured.

**New (all net-new files — zero merge surface):**
- `app/lib/binary/binary-files.ts` — codec, binary detection, snapshot (de)serialization, deploy wire format
- `app/lib/binary/binary-files.spec.ts` — regression suite (byte-identity round-trips)

**Contract:** binary BYTES live in the WebContainer FS (the source of truth for a session).
`File` carries `isBinary` + `size` and an EMPTY `content` — so binary content can never reach the
editor's text map or LLM context. Egress paths read real bytes back on demand; snapshots/deploys
carry them base64-encoded as a wire format only.

**Upstream files touched (each a small, localized hook — keep them small on merge):**

| File | Change |
|---|---|
| `app/lib/stores/files.ts` | watcher uses `fileEntryFromBuffer` (was: `content = ''` for binaries); added `readBinaryFile` / `serializeFiles` / `restoreFiles`; `File.size` |
| `app/lib/stores/workbench.ts` | ZIP export, folder sync, GitHub + GitLab push read real bytes (were: skipped binaries) |
| `app/lib/persistence/{types,useChatHistory}.ts` | `Snapshot.files` is a `SerializedFileMap`; restore writes bytes (was: wrote 0-byte files); binaries excluded from the replay artifact |
| `app/lib/.server/llm/{constants,utils}.ts` | binaries emitted to the model as a `<boltFile binary size>` marker, never as an empty `boltAction` |
| `app/routes/api.github-template.ts` | zip/Contents extraction keeps binaries as base64; size cap no longer drops assets; release→branch zipball fallback; placeholder-token guard; gitlink vendoring (no-op for our starter, which vendors `src/babylon` directly) |
| `app/utils/selectStarterTemplate.ts` | template binaries written to the container as bytes, out-of-band of the artifact; copies `babylon.png`/`spinner.png` into `public/` |
| `app/utils/{folderImport,fileUtils}.ts` | folder import writes binaries as bytes (was: dropped, "Skipping N binary files") |
| `app/components/git/GitUrlImport.client.tsx` | binaries excluded from the artifact so the clone's correct bytes are not overwritten by a mangled UTF-8 copy |
| `app/components/deploy/*`, `app/routes/api.{netlify,vercel}-deploy.ts` | build output read as bytes; binaries uploaded base64 (were: `readFile(…, 'utf-8')` → U+FFFD corruption) |

## Other upstream files touched

| File | Change |
|---|---|
| `uno.config.ts` | `presetIcons` collections: register `ph` + `svg-spinners` explicitly. Upstream relies on presetIcons' filesystem loader, which it installs only when `!process.env.VSCODE_CWD` (it assumes VS Code means the UnoCSS extension is the host). A dev server started from VS Code's integrated terminal inherits that var, so every `i-ph:*` / `i-svg-spinners:*` icon silently rendered blank. Loading the collections ourselves is launch-environment independent. Upstream-mergeable (additive keys). |
