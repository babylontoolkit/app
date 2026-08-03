/**
 * The account itself — self-serve deletion (SPEC §4.5.1).
 *
 * Its own route rather than another `intent` on `/api/auth`, because everything there is a front door
 * onto Supabase's session machinery (sign in, sign out, reset) and this is the one operation that
 * destroys data. Mixing them means a bug in intent parsing on a sign-in path can reach a purge.
 *
 * `requireUser`, NOT `requireVerifiedUser`. Verification gates SPENDING (§4.5.1); a user who signed up,
 * never confirmed their email, and wants their address off our systems must be able to leave. Making
 * "verify your email" a precondition for deletion would be the wrong answer to the only request where
 * holding out for more of someone's data is least defensible.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { createRequestClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { decideAccountDeletion, deleteAccount } from '~/lib/.server/account/delete-account';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.account');

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: true, message: 'Method not allowed.' }, { status: 405 });
  }

  try {
    const user = await requireUser(request, context);
    const body = await request.json<{ intent?: string; confirmation?: unknown }>();

    if (body.intent !== 'delete') {
      return json({ error: true, message: 'Unknown intent.' }, { status: 400 });
    }

    /*
     * The email is read from the SESSION, never from the body — otherwise the confirmation check is a
     * caller comparing a string against a string they also supplied, which is no check at all.
     */
    const decision = decideAccountDeletion({
      confirmation: body.confirmation,
      email: user.email,
      accountsEnabled: isSupabaseConfigured(context),
    });

    if (!decision.ok) {
      return json({ error: true, message: decision.message }, { status: decision.status });
    }

    logger.warn(`Account deletion requested by ${user.id}`);

    const result = await deleteAccount(user, context);

    /*
     * Sign the browser out on the way past. The account is gone, so its cookies now carry a JWT for a
     * user that does not exist — harmless to us (every route re-verifies against the auth server) but
     * it leaves the tab in a state where the UI believes someone is signed in. `signOut` also clears
     * the session server-side; the `Set-Cookie` headers it produces MUST ride back on this response or
     * the browser keeps them.
     */
    const headers = new Headers();

    if (isSupabaseConfigured(context)) {
      try {
        const { client, headers: authHeaders } = await createRequestClient(request, context);
        await client.auth.signOut();
        authHeaders.forEach((value, key) => headers.append(key, value));
      } catch (error) {
        // Best-effort: the account IS deleted. A stale cookie is not a reason to report failure.
        logger.warn(`Could not clear cookies after deleting ${user.id}: ${(error as Error)?.message}`);
      }
    }

    getMonitor(context).track(FUNNEL_EVENTS.ACCOUNT_DELETED, {
      userId: user.id,
      projectsDeleted: result.projectsDeleted,
    });

    return json({ ok: true, projectsDeleted: result.projectsDeleted }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
