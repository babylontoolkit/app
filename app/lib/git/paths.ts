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

/**
 * Strip the WebContainer workdir prefix — a repo has no `/home/project`.
 *
 * ⚠️ The `(\/|$)` is load-bearing and was missing. The rule used to require a TRAILING SLASH, so the
 * workdir root itself (`/home/project`, no slash) normalised to `home/project` rather than to the
 * empty string — i.e. to a path that looks like an ordinary file two directories deep. Harmless on the
 * push, which only ever maps real files. Not harmless on `planRestore`, which reads "not empty, and
 * not in the incoming map" as **delete it**, and would have handed the workdir itself to `deleteFile`.
 * Caught by `restore-plan.spec.ts`; fixed here rather than worked around there, because the whole
 * point of this module is that there is one rule and everyone gets the same one.
 */
export function toRepoRelativePath(rawPath: string): string {
  return rawPath.replace(/^\/?(home\/project(\/|$))?/, '').replace(/^\/+/, '');
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
