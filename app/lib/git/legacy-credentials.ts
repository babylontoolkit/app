/**
 * Clearing the credential the retired browser-side clone left behind (SPEC §4.13, §5).
 *
 * Upstream's clone asked the user by `window.prompt` for a username and a personal access token and
 * wrote the pair — **in plaintext, JSON, non-httpOnly, no expiry** — to a cookie named `git:<domain>`,
 * then sent it as Basic auth through `/api/git-proxy`. Server-side clone replaces that flow entirely
 * (`git/clone.ts`): the token is resolved from `git_tokens` under the caller's session, encrypted at
 * rest and service-role only, and the browser never holds one.
 *
 * 🔴 **Superseding the flow does not remove what it already wrote.** A user who cloned a private repo
 * last month still has their PAT sitting in a cookie that every script on the origin can read and that
 * rides on every request to it — for a credential that works against their whole account, off-platform,
 * for as long as it is valid, and that nothing in the product will ever use again. Leaving it because
 * "we stopped writing it" is its own defect, and a quieter one than the flow it came from: there is no
 * longer any UI that would show the user it exists.
 *
 * So it is actively reaped, on every load, not merely ignored.
 *
 * ⚠️ The reaper is deliberately NOT in `useGit` — that hook has no callers left, so a cleanup living
 * there would never run for exactly the users who have the cookie. It goes at the app root, which is
 * the only place guaranteed to execute for everyone.
 *
 * ⚠️ It matches the `git:` PREFIX rather than a list of hosts. The cookie is named after whatever
 * domain the user cloned from — `git:github.com`, `git:gitlab.com`, `git:git.example.com` — so a
 * host allow-list here would reap the two anybody thought of and leave the self-hosted one, which is
 * the case most likely to hold a long-lived token.
 */
import Cookies from 'js-cookie';

/** The prefix upstream's `saveGitAuth` used: `git:` + the URL's domain. */
export const LEGACY_GIT_COOKIE_PREFIX = 'git:';

/**
 * Remove every `git:<domain>` credential cookie. Returns the names it removed, for the log.
 *
 * Never throws: this runs at app start, and a browser that refuses cookie access (a hardened profile,
 * a sandboxed iframe) must not take the application down over a cleanup.
 */
export function clearLegacyGitCredentialCookies(): string[] {
  const removed: string[] = [];

  try {
    for (const name of Object.keys(Cookies.get() ?? {})) {
      if (!name.startsWith(LEGACY_GIT_COOKIE_PREFIX)) {
        continue;
      }

      /*
       * `path` is passed EXPLICITLY even though it is js-cookie's own default, because a removal must
       * match the attributes the cookie was SET with and upstream's `saveGitAuth` was a bare
       * `Cookies.set('git:' + domain, …)` — i.e. `path=/`. Spelling it out means this keeps working
       * if js-cookie ever changes that default, and a cleanup that reports success while removing
       * nothing is worse than none: it stops anyone looking.
       */
      Cookies.remove(name, { path: '/' });
      removed.push(name);
    }
  } catch {
    // A browser that will not let us read cookies is not one we can clean up. Nothing else breaks.
  }

  return removed;
}
