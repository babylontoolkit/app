/**
 * Files that live in the project but must never be shown to the model (SPEC §4.2.8).
 *
 * There are three ways a file can be in a project without belonging in the context window, and only
 * the first was handled before:
 *
 *   1. **Binary** — bytes cannot be UTF-8 encoded without corruption (`spec/binary-files.md`).
 *   2. **Generated** — the lockfile: correct text, 218KB of it, that the model must never read or edit.
 *   3. **Opaque** — vendor runtime shims and image assets: text, hand-written by someone, but never
 *      something the agent should open. `public/scripts/twgsl.js` is 73KB of minified WebGPU glue;
 *      `pep.js` is 41KB of pointer-event polyfill. Together with `glslang.js` they are 129KB — HALF
 *      the starter's entire text payload — and no correct edit to any of them exists.
 *
 * All three are treated the same way: they are written to the sandbox out-of-band, and the model is
 * told they EXIST (path + size) and nothing more, exactly as binaries already are. The agent cannot
 * "helpfully" rewrite what it cannot see, and we do not pay to send it minified WASM glue on every
 * step of every generation.
 *
 * SVGs are included deliberately. They are image assets — the landing-page rule (§4.4c) tells the
 * model to IMPORT images by path, never to author them — and `src/assets/vite.svg` alone is 9KB of
 * path data for a logo the brand rule forbids it from using.
 *
 * **Opaque means "not in the conversation", NOT "not in the project".** These files ship with the
 * project and must reach every egress path (ZIP, GitHub sync, snapshot, share build) intact — the
 * lockfile especially, since a project without it installs non-deterministically.
 */
import type { FileMap } from '~/lib/stores/files';

/** Vendor runtime shims: framework-required, read-only, and enormous. */
const OPAQUE_DIRS = ['public/scripts/'];

/** Image assets that happen to be text. Their PNG/JPG siblings are already opaque by being binary. */
const OPAQUE_EXTENSIONS = ['.svg'];

/** Generated dependency graphs — see `hygiene.ts`. Never authored, never edited, always huge. */
const OPAQUE_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

/**
 * Is this file part of the project, but not part of the conversation?
 *
 * `path` is project-relative (`public/scripts/twgsl.js`), not container-absolute.
 */
export function isOpaqueToModel(path: string): boolean {
  return (
    OPAQUE_FILES.has(path) ||
    OPAQUE_DIRS.some((dir) => path.startsWith(dir)) ||
    OPAQUE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))
  );
}

/**
 * Drop opaque BODIES from the map the client posts to the agent route, keeping the entries.
 *
 * These files belong in the FilesStore — every egress path (ZIP, GitHub sync, snapshot, share build)
 * builds from that map, so a lockfile missing from it is a lockfile missing from the user's project.
 * But they are never rendered into the model's context (`createFilesContext` emits a marker), so
 * shipping 218KB of `package-lock.json` to the server on EVERY turn is pure freight.
 *
 * Keeping `size` means the marker the model does see stays truthful. Binaries already arrive here
 * with empty content by the same logic (`spec/binary-files.md`) — this closes the text-shaped hole in
 * the same rule.
 */
export function stripOpaqueContent(files: FileMap, workdir = '/home/project/'): FileMap {
  const stripped: FileMap = {};

  for (const [path, dirent] of Object.entries(files)) {
    const relative = path.startsWith(workdir) ? path.slice(workdir.length) : path;

    if (dirent?.type === 'file' && !dirent.isBinary && dirent.content && isOpaqueToModel(relative)) {
      stripped[path] = { ...dirent, content: '', size: dirent.content.length };
      continue;
    }

    stripped[path] = dirent;
  }

  return stripped;
}
