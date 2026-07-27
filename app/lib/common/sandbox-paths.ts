/**
 * Where a project's files live INSIDE the sandbox, and how to talk about them outside it
 * (SPEC §8, `spec/sandbox-seam.md`, `spec/sandbox-codesandbox.md`).
 *
 * 🔴 **The workdir is a property of the PROVIDER, not a constant of the product.** WebContainer puts
 * a project at `/home/project`; CodeSandbox puts it at `/project/workspace`. Nothing in the platform
 * chooses either — the runtime does.
 *
 * That was untrue in practice until this module existed. `/home/project/` was hardcoded as a bare
 * STRING LITERAL in about ten places (not even via `WORK_DIR`), each doing
 * `path.replace('/home/project/', '')` to turn a store key into something relative. Under a provider
 * with a different root every one of those is a **silent no-op**: the path stays absolute, and the
 * next thing to touch it fails somewhere unrelated. MEASURED live on the first CodeSandbox project
 * creation — `createFilesContext` handed a still-absolute path to the `ignore` package and the whole
 * generation died with:
 *
 *     path should be a `path.relative()`d string, but got "/project/workspace/CLAUDE.md"
 *
 * An error that names neither the workdir, the provider, nor the ten places that assumed one.
 *
 * ## One rule, one place
 *
 * The same reasoning `isSecretPath` records: a second, narrower copy of a path rule is how
 * `.env.production` got pushed. Ten copies of a workdir prefix is that failure already realised —
 * they simply all happened to agree while there was only one provider. `toRepoRelativePath`
 * delegates here rather than keeping its own regex, so there is exactly one definition of "strip the
 * sandbox root".
 */

/**
 * Every root a provider may put a project at.
 *
 * A LIST, not a single constant, because a file map can outlive the provider that produced it — a
 * working copy (§4.5.4c) written under WebContainer is restored into a CodeSandbox project, and its
 * keys still carry the old root. Recognising both is what makes that survivable rather than a
 * project full of paths nothing matches.
 *
 * ⚠️ Adding a provider means adding its root HERE and nowhere else. If a root is missing, nothing
 * throws at the boundary — paths silently stay absolute and fail later, somewhere that does not
 * mention paths at all.
 */
export const SANDBOX_ROOTS = ['/home/project', '/project/workspace'] as const;

/**
 * Turn a sandbox-absolute path into a project-relative one.
 *
 * ⚠️ The `(\/|$)` is load-bearing, and its absence has already caused a real bug once
 * (`toRepoRelativePath`, caught by `restore-plan.spec.ts`): requiring a TRAILING SLASH means the
 * workdir root itself (`/home/project`, no slash) normalises to `home/project` rather than to the
 * empty string — a value that looks like an ordinary file two directories deep. `planRestore` reads
 * "not empty, and not in the incoming map" as **delete it**, and would have handed the workdir
 * itself to `deleteFile`.
 *
 * Idempotent by construction: an already-relative path has no root to strip and comes back
 * unchanged, so it is safe to call on a value of unknown provenance — which is the common case,
 * since store keys, repo trees and working copies do not agree about which form they carry.
 */
export function toProjectRelativePath(rawPath: string): string {
  for (const root of SANDBOX_ROOTS) {
    // Escape the root for use in a pattern; these are literals today, but a `.` in one would matter.
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^\//, '');
    const stripped = rawPath.replace(new RegExp(`^\\/?${escaped}(\\/|$)`), '');

    if (stripped !== rawPath) {
      return stripped.replace(/^\/+/, '');
    }
  }

  return rawPath.replace(/^\/+/, '');
}

/** Is this path inside a known sandbox root? Useful for deciding whether a key needs rebasing at all. */
export function isSandboxAbsolutePath(rawPath: string): boolean {
  return SANDBOX_ROOTS.some((root) => rawPath === root || rawPath.startsWith(`${root}/`));
}
