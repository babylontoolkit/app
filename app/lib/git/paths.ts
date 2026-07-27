/**
 * Path rules shared by the push, the remix seed, and the restore (SPEC §4.13, §4.5.4b, §5).
 *
 * These two functions were born inside `app/lib/.server/git/sync-logic.ts`, which is server-only —
 * Remix will not let client code import from `.server/**`, and correctly so. But the CLIENT now needs
 * the identical rules: `restore-plan.ts` has to know which store paths a repo's file map is not
 * authoritative about, and it has to normalise paths the same way the push did, or it compares
 * `/home/project/src/main.ts` against `src/main.ts`, concludes every file was deleted, and wipes the
 * project.
 *
 * So they live here, client-safe, and `sync-logic.ts` re-exports them. This is the same shape as
 * `capabilities.ts` living outside `.server/**` because the client bundle imports the registry.
 *
 * 🔴 **One rule, one place.** The reason is written into `isSecretPath`'s own history: the previous
 * rule was a second, narrower copy of "what counts as a secret" (`/\.env\.[^/]*local$/`, mirroring the
 * gitignore convention), and it pushed `.env.production` — the most dangerous file in the family —
 * because it does not end in `local`. A third copy is how that happens again. Import these; do not
 * reimplement them.
 */
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';

/**
 * Strip the sandbox workdir prefix — a repo has no `/home/project` and no `/project/workspace`.
 *
 * 🔴 Delegates to `toProjectRelativePath`, which knows EVERY provider root (`SANDBOX_ROOTS`). This
 * function kept its own `home/project`-only regex after the CodeSandbox provider landed — while the
 * `sandbox-paths.ts` doc comment claimed the delegation already existed — and the result was a
 * "successful" save that nested the user's entire project under `project/workspace/` in their repo
 * (found live 2026-07-27: github.com/…/blank-canvas showed one folder and read as an empty repo).
 * Nothing threw: every path was non-empty, every blob uploaded, the link was recorded. The restore
 * direction was armed too — `planRestore` comparing `/project/workspace/src/main.ts` against a
 * repo's `src/main.ts` concludes every file is new and every store file deleted. A second copy of a
 * path rule does not fail loudly when it drifts; it fails as someone's repository.
 *
 * (The trailing-slash lesson from this function's own history — the workdir root itself must
 * normalise to the empty string, or `planRestore` hands the workdir to `deleteFile` — now lives in
 * `toProjectRelativePath`, pinned by `sandbox-paths.spec.ts` and `restore-plan.spec.ts`.)
 */
export function toRepoRelativePath(rawPath: string): string {
  return toProjectRelativePath(rawPath);
}

/**
 * Re-key a repo-fetched file map to repo-relative paths, at the fetch boundary.
 *
 * A healthy repo's tree is already relative, so this is a no-op. It exists because the
 * `home/project`-only era of `toRepoRelativePath` pushed nested `project/workspace/...` trees
 * (2026-07-27), and a repo written that way ROUND-TRIPS its damage on every pull: the raw keys are
 * restored at face value, which writes a `project/workspace/` copy INSIDE the user's project — and
 * a checkpoint then preserves the nesting as if it were the user's work. Normalizing what we READ
 * heals the sandbox whatever the repo holds; normalizing what we WRITE (`mapToTreeBlobs`) heals the
 * repo on the next push. Both directions, one rule.
 *
 * Keys that normalize to nothing (the workdir root itself) are dropped, and a collision after
 * normalizing (a nested copy alongside a correct one) resolves to whichever entry sorts LAST —
 * deterministic, and irrelevant in practice since both copies came from the same push.
 */
export function normalizeRepoFileMap<T>(files: Record<string, T | undefined>): Record<string, T | undefined> {
  const out: Record<string, T | undefined> = {};

  for (const [rawPath, dirent] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const path = toRepoRelativePath(rawPath);

    if (path) {
      out[path] = dirent;
    }
  }

  return out;
}

/**
 * Files that must never be pushed to a repo, however the sync is triggered (§4.14, §5).
 *
 * The whole `.env` family is excluded, not just `.env` and `.env.*local`. The narrower rule this
 * replaces mirrored the gitignore convention and therefore **pushed `.env.production`**. Nothing
 * failed; the secrets just went to a repo. Under §4.5.4b every save is a push, so an exclusion gap is
 * now hit on every generation rather than on an occasional manual sync.
 *
 * `.env.example` / `.env.sample` / `.env.template` are deliberately NOT secret: they are the
 * placeholder files a project is *supposed* to commit, and dropping them silently would break the
 * round-trip for anyone cloning the repo.
 *
 * ⚠️ This has a SECOND meaning now, and it is the mirror of the first: because these files never reach
 * the repo, a file map fetched FROM the repo never contains them — so a restore that treated that map
 * as the whole truth would delete the user's `.env`, which is the one file in the project we can never
 * get back. Same rule, both directions (`restore-plan.ts`).
 */
export function isSecretPath(path: string): boolean {
  const name = path.split('/').pop() ?? '';

  // An `.npmrc` carries a registry auth token. Not part of the `.env` family; every bit as secret.
  if (name === '.npmrc') {
    return true;
  }

  if (name === '.env') {
    return true;
  }

  /*
   * `.env.` with the DOT, not `.env` — `.environment.md` starts with ".env" and is an ordinary file.
   * Over-matching is not a harmless bias here: it would silently drop the user's file from every save.
   */
  if (!name.startsWith('.env.')) {
    return false;
  }

  return !/^\.env\.(example|sample|template)$/i.test(name);
}
