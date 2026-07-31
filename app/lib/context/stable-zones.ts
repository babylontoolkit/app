/**
 * Which project files belong to the STABLE half of the file context (SPEC §4.2.8,
 * `spec/context-budget.md` §"The shared-starter prefix restructure").
 *
 * ## Why the file context is two blocks
 *
 * The file context used to be ONE cached entry (~the largest block in the prefix), and it rewrites
 * whenever any file changes — which is every build turn. Measured across 66 real generations
 * (2026-07-30): 82% of all LLM spend was cache WRITES, and on later turns of a conversation 81% of
 * cache traffic was writes even when the previous turn was minutes old. Most of those bytes were the
 * starter's framework zones — files the platform itself forbids the model to edit (§4.4c) — being
 * re-written at 2× to cache alongside the handful of game files that actually changed.
 *
 * Splitting on the stability seam gives the stable half its own breakpoint AHEAD of the
 * per-conversation blocks, which buys two things:
 *
 *   1. An edit turn rewrites only the game-code entry, not the framework bytes in front of it.
 *   2. The stable block's bytes are identical for EVERY project on the same template pin (paths are
 *      project-relative and the workdir never enters them), so on a provider that warms per backend
 *      (KIE — `scripts/cache-probe.mjs`) one project's traffic warms the entry for all of them,
 *      exactly like the base prompt.
 *
 * ## 🔴 The default is MUTABLE, and that direction is load-bearing
 *
 * A genuinely-mutable file mis-listed as stable makes the LARGE entry rewrite every turn — the exact
 * failure this module exists to remove, silently restored. A stable file mis-listed as mutable just
 * sits in the small entry costing its own size. So nothing is stable unless this module names it,
 * and the names are the zones the platform already declares read-only or vendored (§4.4c,
 * `opaque-files.ts`): `src/babylon/**` (framework library + internals), `src/routing/**` + the app
 * shell (read-only shell), `public/scripts/**` (vendored runtimes — opaque markers, but the markers
 * are still bytes in the prefix), and the starter's config files.
 *
 * "Stable" does not mean immutable — a user CAN ask for a `vite.config.ts` edit. When that happens
 * the stable entry rewrites once, which is the acceptable rare case; the per-turn case is game code.
 *
 * ⚠️ Deliberately NOT here: `package.json` + the lockfile (they change on every `npm install` the
 * model runs), `public/assets/**` (generated media lands there mid-turn, §4.16), root docs
 * (`SPEC.md`, `README.md` — the user's own documents), `favicon`/`icons.svg` (branding redesigns
 * replace them, §4.4c), and `CLAUDE.md` (lifted into its own Project Instructions block before the
 * split ever sees it).
 */
import type { FileMap } from '~/lib/stores/files';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';

/** Directory prefixes (project-relative, trailing slash) whose contents are stable. */
export const STABLE_ZONE_PREFIXES = ['src/babylon/', 'src/routing/', 'public/scripts/'] as const;

/** Exact project-relative paths that are stable — the starter's shell and config. */
export const STABLE_ZONE_FILES = new Set([
  'src/app.tsx',
  'src/main.tsx',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'eslint.config.js',
  'LICENSE',
  '.gitignore',

  /*
   * Framework-required images (§4.4c: never deleted, never redesigned). Binary → a small marker,
   * but a marker is still prefix bytes, and these two never change size.
   */
  'public/babylon.png',
  'public/spinner.png',
]);

/**
 * Is this path in the stable half? Takes either a project-relative or a workdir-absolute path.
 *
 * `startsWith` for a zone's contents; the equality arm puts the zone's own FOLDER entry with its
 * zone (`createFilesContext` skips folders either way, so this only keeps the split maps tidy).
 */
export function isStableContextPath(path: string): boolean {
  const relative = toProjectRelativePath(path);

  return (
    STABLE_ZONE_FILES.has(relative) ||
    STABLE_ZONE_PREFIXES.some((prefix) => relative.startsWith(prefix) || `${relative}/` === prefix)
  );
}

/**
 * Split a file map into the stable and mutable halves, every entry in exactly one.
 *
 * Folders follow the same rule as files so each half remains a self-consistent `FileMap`;
 * `createFilesContext` skips them either way.
 */
export function splitFilesForContext(files: FileMap): { stable: FileMap; mutable: FileMap } {
  const stable: FileMap = {};
  const mutable: FileMap = {};

  for (const [path, dirent] of Object.entries(files)) {
    (isStableContextPath(path) ? stable : mutable)[path] = dirent;
  }

  return { stable, mutable };
}
