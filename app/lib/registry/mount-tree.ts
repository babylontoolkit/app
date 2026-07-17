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
 * Everything here is a pure transform of the file list into the tree — no container, no I/O — so the
 * one invariant that MUST NOT regress, **binary byte-identity** (`spec/binary-files.md`), is unit
 * testable without a sandbox: binaries decode from base64 to a `Uint8Array` and are handed to the
 * mount as raw bytes, never a string (a string would be UTF-8 re-encoded and corrupt every non-ASCII
 * byte, the exact upstream defect the binary work exists to make impossible).
 */
import type { DirectoryNode, FileNode, FileSystemTree } from '@webcontainer/api';
import { base64ToBytes } from '~/lib/binary/binary-files';
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
 * Turn a flat `TemplateFile[]` into the nested `FileSystemTree` `container.mount` expects.
 *
 * Text files carry their string content; binaries decode to a `Uint8Array` so the mount transfers raw
 * bytes (§ byte-identity above). Intermediate directories are created as they are encountered, and a
 * directory that also appears as an explicit entry never overwrites the children already placed under
 * it (order-independent).
 */
export function buildFileSystemTree(files: TemplateFile[]): FileSystemTree {
  const root: FileSystemTree = {};

  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment.length > 0);

    if (segments.length === 0) {
      continue;
    }

    let node = root;

    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index];
      const existing = node[segment];

      if (existing && 'directory' in existing) {
        node = existing.directory;
      } else {
        const dir: DirectoryNode = { directory: {} };
        node[segment] = dir;
        node = dir.directory;
      }
    }

    const leaf = segments[segments.length - 1];
    const contents = file.isBinary ? base64ToBytes(file.content) : file.content;
    const fileNode: FileNode = { file: { contents } };
    node[leaf] = fileNode;
  }

  return root;
}
