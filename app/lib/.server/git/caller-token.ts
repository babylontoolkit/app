/**
 * The caller's platform git token, for the inherited read-only GitHub routes.
 *
 * `api.github-stats` and `api.github-user` are upstream bolt.diy routes built for a BYOK world:
 * they resolve a token from the caller's cookie or the operator's env, because in bolt.diy that is
 * the only place a token can be. This fork added a second, primary source — the encrypted
 * `git_tokens` row written by `/api/git/connect/:provider` (§4.5.4b, so the browser never holds a
 * git token) — and those two routes were never told about it.
 *
 * The result was a connect button that genuinely worked and appeared to do nothing: OAuth ran,
 * GitHub auto-approved, the token landed server-side, and the repo picker still answered
 * `401 GitHub token not found`.
 *
 * A shared helper rather than two copies, for the reason `isSecretPath` is one rule in one place:
 * the two routes back the same picker (repos and branches), so a difference between them shows up
 * as a list that loads and a branch dropdown that does not.
 *
 * **Never throws.** Its callers use it inside a `||` chain with other sources; an exception there
 * would turn "you have not connected" into a 500 on a route that had two more options to try.
 */
import { requireUser } from '~/lib/.server/supabase/auth';
import { storedAccessToken } from './resolve';
import type { GitProviderId } from './provider';

export async function callerOAuthToken(
  request: Request,
  context: unknown,
  provider: GitProviderId = 'github',
): Promise<string | null> {
  try {
    /*
     * Re-deriving the user rather than taking an id argument: every caller has already run
     * `denyUnlessVerified`, so this resolves the same session, and a helper that ACCEPTS a user id
     * can be handed the wrong one. The token is the caller's own or nothing (`spec/spend-holes.md`).
     */
    const user = await requireUser(request, context);

    return await storedAccessToken(context, user.id, provider);
  } catch {
    return null;
  }
}
