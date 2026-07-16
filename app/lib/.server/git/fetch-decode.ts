/**
 * Decoding a blob fetched from a git provider (SPEC §4.5.4b, spec/binary-files.md).
 *
 * ## Why this exists
 *
 * Providers hand back base64 for EVERYTHING, so every fetch has to answer "are these bytes text or
 * binary?" before it can build a `SerializedFileMap`. The code this replaces answered it with an
 * extension allowlist:
 *
 *     /\.(ts|tsx|js|jsx|json|md|txt|css|scss|html|svg|glsl|env|gitignore|mjs|cjs|yml|yaml)$/i
 *
 * Anything outside that list came back `isBinary: true` — so `.toml`, `.sh`, `.lock`, `.editorconfig`
 * and extensionless `Dockerfile` / `LICENSE` / `Makefile`, all ordinary text in a real project, were
 * mis-typed. The bytes survived (base64 in, base64 out), so nothing threw and no test caught it; the
 * file just arrived in the WebContainer flagged binary, which means the editor will not open it and —
 * the expensive half — `createFilesContext` hides it from the agent. A pulled project silently lost
 * files from the model's view.
 *
 * (An earlier draft of this comment also listed `.gltf` and `.babylon` as wrongly-binary. That was
 * false: both are in `BINARY_EXTENSIONS` **deliberately** — the platform treats them as assets, and the
 * allowlist agreed with it by accident. The claim was caught by the contract suite, which is the only
 * reason it is not still sitting here reading as authoritative.)
 *
 * ## The rule
 *
 * Do not guess: DECODE. `classifyFetchedBlob` turns the base64 into the actual bytes and hands them to
 * `fileEntryFromBuffer` — the exact classifier the file watcher uses at every other ingest point
 * (sniff the bytes, then require a strict UTF-8 decode, else treat as binary so the bytes survive).
 * One classifier, one answer, everywhere. The invariant is not "text files are text"; it is that **a
 * file pulled from a repo is typed identically to the same file written by the agent** — which is why
 * deferring to the platform's list is correct even where that list is surprising.
 *
 * `isBinaryPath` still gets a say, but only as an override in the safe direction — a `.png` whose first
 * 100 bytes happen to sniff as text is still a `.png`. It can never turn text INTO binary.
 */
import {
  base64ToBytes,
  bytesToBase64,
  fileEntryFromBuffer,
  isBinaryPath,
  type SerializedDirent,
} from '~/lib/binary/binary-files';

/**
 * Turn a provider's base64 blob into a byte-faithful `SerializedDirent`.
 *
 * Byte-identity is the point (§4.5.4b): for a binary we re-encode the DECODED bytes rather than
 * forwarding the provider's base64 string, because providers wrap their base64 at 60 columns and a
 * `SerializedFileMap` consumer decodes without stripping newlines. Round-tripping through bytes makes
 * the wrapping irrelevant instead of relying on every consumer to tolerate it.
 */
export function classifyFetchedBlob(path: string, base64Content: string): SerializedDirent {
  const bytes = base64ToBytes(base64Content);
  const entry = fileEntryFromBuffer(bytes);

  // The path may veto a text verdict (a .png that sniffs as text is still a .png). Never the reverse.
  const isBinary = entry.isBinary || isBinaryPath(path);

  if (!isBinary) {
    return { type: 'file', content: entry.content, isBinary: false, size: bytes.byteLength };
  }

  return { type: 'file', content: bytesToBase64(bytes), isBinary: true, size: bytes.byteLength };
}
