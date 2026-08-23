/**
 * Every link this product builds into a git provider's website, in ONE place (§4.13a).
 *
 * 🔴 **`isSecretPath`'s rule, applied to link building.** These URLs were a `PROVIDER_ORIGIN` record
 * and a template literal inside the header chip, and the feature that needed a second and a third
 * link would have made three copies of a shape the two providers do not share:
 *
 *   - a branch tree is `/tree/<branch>` on GitHub and `/-/tree/<branch>` on GitLab;
 *   - a pull request (GitLab: merge request) is `/compare/<base>...<head>?expand=1` on GitHub and
 *     `/-/merge_requests/new?merge_request[source_branch]=…` on GitLab;
 *   - **branch names legally contain `/`** — `feature/boost-pads` is the single most common shape —
 *     so every one of them needs encoding, and getting it wrong produces a 404 rather than an error.
 *
 * A URL assembled at three call sites is three chances to ship a broken link, and a broken link in a
 * menu reads to the user as the button being broken (`spec/fail-loud.md`'s lesson about a refusal
 * that names no cause, one surface over).
 *
 * ⚠️ Client-safe by construction: static strings and `encodeURIComponent`, no env, no secrets. It
 * lives beside `paths.ts` for the same reason that one does.
 */

/** The two providers this platform saves to (§4.5.4b). */
export type GitProviderId = 'github' | 'gitlab';

/** Where a linked project's code actually is. */
export const PROVIDER_ORIGIN: Record<GitProviderId, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
};

/**
 * Encode one branch name for a URL PATH segment.
 *
 * ⚠️ `encodeURIComponent` escapes `/` to `%2F`, which is exactly right here: both providers accept a
 * fully-encoded ref in a tree path, and leaving the slash raw makes `feature/boost-pads` read as two
 * path segments — a 404 that looks like the branch not existing. Unicode branch names encode too.
 */
function encodeBranch(branch: string): string {
  return encodeURIComponent(branch);
}

/** The repository's own page. `repo` is `owner/name`. */
export function repoUrl(provider: GitProviderId, repo: string): string {
  return `${PROVIDER_ORIGIN[provider]}/${repo}`;
}

/** A branch's file tree. The path shape differs between the two providers — that is the whole point. */
export function branchTreeUrl(provider: GitProviderId, repo: string, branch: string): string {
  const base = repoUrl(provider, repo);

  return provider === 'gitlab' ? `${base}/-/tree/${encodeBranch(branch)}` : `${base}/tree/${encodeBranch(branch)}`;
}

/** One commit. Where a user goes for the DIFF this product deliberately does not fetch. */
export function commitUrl(provider: GitProviderId, repo: string, sha: string): string {
  const base = repoUrl(provider, repo);

  return provider === 'gitlab'
    ? `${base}/-/commit/${encodeURIComponent(sha)}`
    : `${base}/commit/${encodeURIComponent(sha)}`;
}

/**
 * The "Open a pull request" page, pre-filled with the branch. GitLab calls it a merge request.
 *
 * GitHub compares two refs in the path; GitLab takes the source branch as a query parameter. Neither
 * form is derivable from the other, which is why this is a function and not a template.
 */
export function newPullRequestUrl(
  provider: GitProviderId,
  repo: string,
  branch: string,
  defaultBranch?: string,
): string {
  const base = repoUrl(provider, repo);

  if (provider === 'gitlab') {
    /* The bracketed parameter name is GitLab's own; the brackets must survive encoding. */
    return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
  }

  /*
   * 🔴 `defaultBranch` IS OPTIONAL, AND ITS ABSENCE MUST NOT BECOME A GUESS.
   *
   * `canOpenPullRequest` deliberately treats an unknown default as "we could not ask" and keeps the
   * action OFFERED — never inventing `main`. A caller that then wrote `defaultBranch ?? 'main'` into
   * the URL would reintroduce exactly the guess the predicate refuses, one layer down: on a
   * `master`-trunked repository the user would land on the empty compare page the predicate exists to
   * prevent, which reads as our button being broken.
   *
   * GitHub's one-ref form (`/compare/<head>`) compares against the repository's OWN default, so the
   * honest answer when we do not know it is to let the provider supply it. `?expand=1` still opens the
   * PR form. GitLab never needed a base at all — its form defaults the target itself.
   */
  const head = encodeBranch(branch);

  return defaultBranch
    ? `${base}/compare/${encodeBranch(defaultBranch)}...${head}?expand=1`
    : `${base}/compare/${head}?expand=1`;
}

/**
 * May we offer "Open a pull request"?
 *
 * 🔴 **Offered only when it can WORK.** Both refusals produce an empty compare page on the provider's
 * own site, which reads as our button being broken:
 *
 *   - **you are on the default branch** — there is nothing to compare it against;
 *   - **the branch has never been pushed** — the provider has no such ref, so the page 404s or opens
 *     a comparison of nothing.
 *
 * ⚠️ `defaultBranch` `undefined` means WE COULD NOT ASK, and that DISABLES the first rule rather than
 * guessing `main` — the `decideBranchDelete` distinction, and the `remoteHead` `undefined`-vs-`null`
 * one underneath it. Guessing here would hide the button on a `master`-trunked repository's real
 * feature branch and offer it on the trunk.
 */
export function canOpenPullRequest(facts: {
  branch?: string;
  defaultBranch?: string;
  lastSyncedCommitSha?: string;
}): boolean {
  if (!facts.branch) {
    return false;
  }

  if (facts.defaultBranch && facts.branch === facts.defaultBranch) {
    return false;
  }

  /* Never pushed: the provider has no ref to compare, whatever this browser thinks it holds. */
  return Boolean(facts.lastSyncedCommitSha);
}
