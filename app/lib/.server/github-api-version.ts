/**
 * The GitHub REST API version this platform pins, in ONE place (SPEC §4.5.4b, §4.3, §4.4).
 *
 * ## Why this exists
 *
 * GitHub versions its REST API by date, selected with an `X-GitHub-Api-Version` request header, and
 * **a request that sends no header does not get "the latest" — it gets `2022-11-28` forever.** That
 * default is now deprecated (`Deprecation: Tue, 10 Mar 2026`), and when its window closes
 * (`Sunset: Fri, 10 Mar 2028`) requests against it answer **410 Gone**. Measured live 2026-07-30:
 *
 *     POST /user/repos                                 → deprecation + sunset headers
 *     POST /user/repos  X-GitHub-Api-Version: 2026-03-10 → no deprecation headers
 *
 * Nothing in this codebase sent the header, so every GitHub call the platform makes — Save (§4.5.4b),
 * doc-sync (§4.3), skills-sync (§4.11), template pin-and-fetch (§4.4) — was riding a dated default it
 * never chose. The first anyone would have heard of it is the day it stops: Save fails, projects
 * cannot be created, and the prompt cannot be rebuilt, all at once, on a date nobody has in a calendar.
 *
 * ## Why it is a shared constant and not four string literals
 *
 * The same reason `isSecretPath` is one function: a rule copied into several doors drifts, and the
 * drift is silent. Here the drift has a specific shape — some calls on the new version and some on the
 * old — so a response field removed in one version is present on one code path and absent on another,
 * with no error anywhere. Import this; do not type the date.
 *
 * ## What changed in `2026-03-10`, and why the bump is safe for us (VERIFIED, not assumed)
 *
 * Diffed live against a real repository, both versions, every endpoint this platform calls:
 *
 *   - `GET /repos/{owner}/{repo}` loses exactly two properties — `has_downloads` and
 *     `use_squash_pr_title_as_default`. Neither is read anywhere in this codebase (grep before you
 *     doubt it), and `full_name` / `default_branch` / `private` — the three `ensureRepo` actually
 *     depends on — are unchanged.
 *   - `POST /user/repos` still answers **422** for a name that already exists, with the same body.
 *     That status is load-bearing: `GitHubProvider.ensureRepo` reads it as "the name is taken" and
 *     walks to the next free name. A version that changed it would silently turn every Save on a
 *     colliding name into a hard failure.
 *   - Repository creation blocked by trade-control regulations now answers **451** where it answered
 *     422. `toGitHubError`'s `status >= 400` catch-all maps that to `invalid` — loud, not retried,
 *     and correctly NOT mistaken for a name collision.
 *   - The Git Data API (blobs, trees, commits, refs) — the whole push — is unchanged in both
 *     directions.
 *
 * ⚠️ **Do not bump this date without re-running that comparison.** A version bump changes every
 * endpoint at once, and the failure mode of a removed field is `undefined` flowing into a code path
 * that expected a string — which throws somewhere unrelated, or does not throw at all.
 *
 * ⚠️ **This pins OUR platform's calls only.** The inherited bolt.diy routes that talk to GitHub on a
 * user's own token (`api.github-user`, `api.github-stats`, `api.github-branches`,
 * `api.system.git-info`, `services/githubApiService.ts`, the deploy dialog) still send no header and
 * still default to `2022-11-28`. They keep working until the 2028 sunset; they are left alone here to
 * keep the upstream diff small (SPEC §2.1a), and they are listed so the sweep is a decision on record
 * rather than an oversight.
 */

/** The pinned version. One date, one place — see the header for what a bump costs. */
export const GITHUB_API_VERSION = '2026-03-10';

/** The header name GitHub selects a version with. Lowercase: Octokit normalises, `fetch` does not care. */
export const GITHUB_API_VERSION_HEADER = 'x-github-api-version';

/**
 * Add the version pin to a plain `fetch` header bag.
 *
 * For the raw-`fetch` doors (doc-sync, skills-sync, template fetch). The Octokit door uses a request
 * hook instead, because `@octokit/core`'s constructor accepts `baseUrl`, `userAgent`, `previews` and
 * `timeZone` as default headers and **silently ignores an arbitrary `headers` option** — a pin passed
 * that way would look right in review and never reach the wire.
 */
export function withGitHubApiVersion<T extends Record<string, string>>(headers: T): T & Record<string, string> {
  return { ...headers, [GITHUB_API_VERSION_HEADER]: GITHUB_API_VERSION };
}
