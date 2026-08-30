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
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import type { FileMap } from '~/lib/stores/files';

/**
 * Directories whose contents never reach the model.
 *
 *   - `public/scripts/` — vendor runtime shims: framework-required, read-only, and enormous.
 *   - `.codesandbox/` — the sandbox PROVIDER's own directory (task config, the project-identity
 *     sentinel). It is excluded at the map layer (`MAP_EXCLUDED_DIRS`), so this is the second wall:
 *     any ingest path that fills context without going through the map (an import, a restore, a
 *     future one) still cannot put its BODIES in front of the model — and an edit here is not
 *     harmless, since deleting `tasks.json` stops the template's dev server from ever starting.
 *     (As with every opaque file, the model is still told the path EXISTS via a `<boltFile>` marker;
 *     opaque means "not in the conversation", never "not in the project".)
 */
const OPAQUE_DIRS = ['public/scripts/', '.codesandbox/'];

/** Image assets that happen to be text. Their PNG/JPG siblings are already opaque by being binary. */
const OPAQUE_EXTENSIONS = ['.svg'];

/**
 * Exact root-relative paths that are in the project but never in the conversation:
 *   - Generated dependency graphs (see `hygiene.ts`): never authored, never edited, always huge.
 *   - `license.json`: a Unity Toolkit project licence. The licenser that generated these was removed
 *     2026-08-30 (§4.18) and the rule STAYS, deliberately: a project imported or cloned from outside
 *     can still carry one. It is machine-generated crypto (a deterministic `secret`/`key` pair), it
 *     ships with the project on every egress path (ZIP, GitHub push, share build), and no correct edit
 *     to it exists — the model must never rewrite it. Dropping it from this set would start feeding
 *     those bytes to the model on every turn of such a project: a context regression that throws
 *     nothing and just costs money (§4.2.8). Deliberately NOT an `isSecretPath` (it must travel with
 *     the user's repo, unlike `.env`).
 */
const OPAQUE_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'license.json',
]);

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
export function stripOpaqueContent(files: FileMap): FileMap {
  const stripped: FileMap = {};

  for (const [path, dirent] of Object.entries(files)) {
    /*
     * 🔴 Through `toProjectRelativePath`, never a workdir literal. This took a `workdir` parameter
     * defaulting to `'/home/project/'` and every caller used the default — so under a provider rooted
     * anywhere else the prefix never matched, `isOpaqueToModel` was asked about an ABSOLUTE path,
     * every check failed, and the whole strip became a NO-OP: the 218KB lockfile and the vendored
     * `public/scripts/*` bodies went back to being POSTed on every turn. Nothing threw, and the
     * server-side strip still protected the model, so the only symptom was a bigger request.
     */
    const relative = toProjectRelativePath(path);

    if (dirent?.type === 'file' && !dirent.isBinary && dirent.content && isOpaqueToModel(relative)) {
      stripped[path] = { ...dirent, content: '', size: dirent.content.length };
      continue;
    }

    stripped[path] = dirent;
  }

  return stripped;
}
