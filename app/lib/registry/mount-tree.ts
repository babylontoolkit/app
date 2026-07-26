/**
 * Building a WebContainer `FileSystemTree` from a project's `TemplateFile[]` (SPEC §4.4, §4.2.8,
 * `spec/binary-files.md`).
 *
 * This is the PURE half of the atomic mount (§4.4). The starter used to reach the sandbox as 64
 * sequential `container.fs.writeFile` calls, each awaited — which raced a cold WebContainer boot: on
 * the first project after a page load, the writes and the boot interleaved and `npm install` ran
 * against an empty `/home/project`, silently (measured live 2026-07-17). One `container.mount(tree)`
 * is atomic — it cannot half-apply, it is faster, and it is trivially gated on a booted container.
 *
 * 🔴 **THE MOUNT TREE CARRIES TEXT ONLY — binaries CANNOT ride it, and the reason is invisible to a
 * Node test (fixed 2026-07-17, `spec/binary-files.md`).** `container.mount(tree)` does not transfer a
 * `Uint8Array` file body as bytes: for a `FileSystemTree` it runs `JSON.stringify(toInternalFileSystemTree(tree))`,
 * and that internal transform decodes every binary body with **`new TextDecoder('latin1')`**. Per the
 * WHATWG Encoding standard the label `latin1` is an alias for **windows-1252**, whose decoder remaps
 * bytes `0x80`–`0x9F` to code points *above* `0xFF` (e.g. `0x89` → U+2030, the PNG magic byte; `0x80`
 * → U+20AC). The worker rebuilds bytes with `charCodeAt & 0xFF`, so those remapped code points
 * truncate to the WRONG byte — `0x89` lands as `0x30`. Every PNG/ICO/JPG and every `.wasm` in the
 * starter is destroyed, silently, in the browser (dead images + `WebAssembly.instantiate(): unknown
 * type form` from Havok/glslang/twgsl). It slipped past `mount-tree.spec.ts` because **Node's**
 * `TextDecoder('latin1')` is true byte-identity ISO-8859-1 — the vitest env is the one place the bug
 * does not reproduce, the same env-diverges-from-test trap as the `env()`/`oauth.spec.ts` fallback.
 *
 * So `buildFileSystemTree` REFUSES a binary (loud, not silent), and binaries are written separately via
 * `container.fs.writeFile(path, Uint8Array)` — which IS byte-faithful — in `mount.ts`. That is NOT a
 * return to 64 per-file writes: the ~52 text files (incl. `package.json`, the file the boot race was
 * about) still land in ONE atomic mount; only the dozen binaries write after it, and they do not
 * participate in the boot race (`npm install` needs none of them).
 *
 * Everything here is a pure transform of the file list into the tree — no container, no I/O — so the
 * text/binary partition is unit testable without a sandbox.
 */
import type { SandboxDirectoryNode, SandboxFileNode, SandboxFileTree } from '~/lib/sandbox';
import type { TemplateFile } from '~/types/template';

/**
 * Framework-required runtime assets (SPEC §4.4). The preloader ESM-imports the bundled copies under
 * `src/babylon/assets/`, and ALSO fetches these from `public/` at runtime — so they must exist in two
 * places. The starter ships only the bundled copies; creation makes the `public/` ones.
 */
const FRAMEWORK_PUBLIC_ASSETS = ['babylon.png', 'spinner.png'];

/**
 * Ensure `public/{babylon,spinner}.png` exist by copying the bundled `src/babylon/assets/` binaries.
 *
 * Pure and separate from the mount so the copy rule is testable on its own: a missing `public/` asset
 * produces a project whose preloader 404s, the class of bug the binary layer exists to prevent. If the
 * copy is already present it is left alone; if the source cannot be found the asset is skipped (the
 * caller logs it) rather than fabricated.
 */
export function withFrameworkPublicAssets(files: TemplateFile[]): TemplateFile[] {
  const additions: TemplateFile[] = [];

  for (const name of FRAMEWORK_PUBLIC_ASSETS) {
    const target = `public/${name}`;

    if (files.some((file) => file.path === target)) {
      continue;
    }

    const source =
      files.find((file) => file.isBinary && file.path === `src/babylon/assets/${name}`) ??
      files.find((file) => file.isBinary && file.path.endsWith(`/assets/${name}`));

    if (!source) {
      continue;
    }

    additions.push({ name, path: target, content: source.content, isBinary: true });
  }

  return additions.length > 0 ? [...files, ...additions] : files;
}

/**
 * Split a project's files into what the atomic mount tree may carry (text) and what must be written
 * as raw bytes afterwards (binary). Pure, so `mount.ts` stays a thin I/O wrapper and the routing rule
 * is tested here. The `isBinary` flag is the single source of truth — the same flag both the old
 * two-list write path and this one keyed off, so nothing about classification changes.
 */
export function partitionForMount(files: TemplateFile[]): { textFiles: TemplateFile[]; binaryFiles: TemplateFile[] } {
  const textFiles: TemplateFile[] = [];
  const binaryFiles: TemplateFile[] = [];

  for (const file of files) {
    (file.isBinary ? binaryFiles : textFiles).push(file);
  }

  return { textFiles, binaryFiles };
}

/**
 * Turn a flat `TemplateFile[]` of TEXT files into the nested `FileSystemTree` `container.mount` expects.
 *
 * Every file carries its string content. A binary file is REFUSED with a throw, never silently
 * corrupted: `container.mount` JSON-serializes a `Uint8Array` body through a browser
 * `TextDecoder('latin1')` = windows-1252, which mangles bytes `0x80`–`0x9F` (see the module header).
 * Callers must `partitionForMount` first and write binaries via `fs.writeFile`. Intermediate
 * directories are created as they are encountered, and a directory that also appears as an explicit
 * entry never overwrites the children already placed under it (order-independent).
 */
export function buildFileSystemTree(files: TemplateFile[]): SandboxFileTree {
  const root: SandboxFileTree = {};

  for (const file of files) {
    if (file.isBinary) {
      // A silent-corruption guard, not a theoretical one: this exact routing shipped once (2026-07-17).
      throw new Error(
        `buildFileSystemTree received a binary file (${file.path}). Binaries must be written via ` +
          `fs.writeFile — container.mount corrupts binary bodies in the browser. Partition first.`,
      );
    }

    const segments = file.path.split('/').filter((segment) => segment.length > 0);

    if (segments.length === 0) {
      continue;
    }

    let node: SandboxFileTree = root;

    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index];
      const existing = node[segment];

      if (existing && 'directory' in existing) {
        node = existing.directory;
      } else {
        const dir: SandboxDirectoryNode = { directory: {} };
        node[segment] = dir;
        node = dir.directory;
      }
    }

    const leaf = segments[segments.length - 1];
    const fileNode: SandboxFileNode = { file: { contents: file.content } };
    node[leaf] = fileNode;
  }

  return root;
}
