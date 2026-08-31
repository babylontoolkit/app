/**
 * Authentication (SPEC §4.5.1).
 *
 * Supabase Auth owns password hashing, token issuance and refresh, OAuth handshakes, and reset flows.
 * We never store a password, and we never mint a token — this route is a thin, skinned front door
 * onto their machinery.
 *
 * The refreshed-session cookies Supabase produces MUST ride back on the response, or the user is
 * silently signed out mid-session; `client.headers` carries them and every branch below returns them.
 */
import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { createRequestClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { errorResponse } from '~/lib/.server/http';
import { env } from '~/lib/.server/env';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';
import { safeRedirect, passwordProblem } from '~/lib/auth/safe-redirect';

const logger = createScopedLogger('api.auth');

type Intent = 'signin' | 'signup' | 'signout' | 'oauth' | 'reset' | 'resend' | 'update-password';

export async function action({ request, context }: ActionFunctionArgs) {
  /*
   * Local mode has no accounts to manage — everyone is already the single local user (see
   * `auth.ts`). Report that plainly instead of pretending to sign someone in.
   */
  if (!isSupabaseConfigured(context)) {
    return json(
      {
        error: true,
        message: 'Accounts are not configured on this server. You are signed in as the local developer.',
        statusCode: 503,
      },
      { status: 503 },
    );
  }

  try {
    const body = await request.json<{
      intent: Intent;
      email?: string;
      password?: string;
      provider?: 'google' | 'github';
      redirectTo?: string;
    }>();

    const { client, headers } = await createRequestClient(request, context);
    const appUrl = env(context, 'APP_URL') || new URL(request.url).origin;

    /*
     * The preserved intent, on the ONE hop that can carry it (§4.5.1).
     *
     * Supabase bounces the user through an address WE choose, so the only way the thing they were
     * trying to do survives an OAuth round trip or an email confirmation is to ride in that address's
     * query string — `/auth/callback` reads `next` and redirects to it. `body.redirectTo` used to be
     * accepted here and silently dropped: the dialog sent it, the server destructured it, and every
     * OAuth sign-in landed on the dashboard having forgotten the Remix that started it.
     *
     * `safeRedirect` runs HERE as well as in the callback. The callback is the wall; this refuses the
     * value at the point it enters the system, so a hostile `redirectTo` is never written into a URL
     * we hand to a third party in the first place.
     */
    const next = safeRedirect(body.redirectTo);
    const callbackUrl = `${appUrl}/auth/callback?next=${encodeURIComponent(next)}`;

    switch (body.intent) {
      case 'signup': {
        if (!body.email || !body.password) {
          return json({ error: true, message: 'Email and password are required.' }, { status: 400 });
        }

        const weak = passwordProblem(body.password);

        if (weak) {
          return json({ error: true, message: weak }, { status: 400 });
        }

        const { error } = await client.auth.signUp({
          email: body.email,
          password: body.password,

          /*
           * Verification gates the free grant and generation (§4.5.1, §4.5.4). The grant itself is
           * NOT issued here — it is issued when a verified session first appears (`api.me`), so a
           * signup that never confirms its email can never mint credits.
           */
          options: { emailRedirectTo: callbackUrl },
        });

        if (error) {
          return json({ error: true, message: error.message }, { status: 400, headers });
        }

        // Funnel entry point (§5A). The grant — and the VERIFIED event — come later, once confirmed.
        getMonitor(context).track(FUNNEL_EVENTS.SIGNUP);

        return json(
          { ok: true, message: 'Check your inbox to verify your email, then you can start building.' },
          { headers },
        );
      }

      case 'signin': {
        if (!body.email || !body.password) {
          return json({ error: true, message: 'Email and password are required.' }, { status: 400 });
        }

        const { error } = await client.auth.signInWithPassword({ email: body.email, password: body.password });

        if (error) {
          // Deliberately vague: distinguishing "no such user" from "wrong password" enumerates accounts.
          return json({ error: true, message: 'That email or password is incorrect.' }, { status: 401, headers });
        }

        return json({ ok: true }, { headers });
      }

      case 'oauth': {
        const { data, error } = await client.auth.signInWithOAuth({
          provider: body.provider ?? 'github',
          options: { redirectTo: callbackUrl },
        });

        if (error || !data.url) {
          return json({ error: true, message: 'Could not start the sign-in.' }, { status: 400, headers });
        }

        return json({ ok: true, url: data.url }, { headers });
      }

      case 'reset': {
        if (!body.email) {
          return json({ error: true, message: 'Email is required.' }, { status: 400 });
        }

        /*
         * `/auth/reset` is a REAL route (`app/routes/auth.reset.tsx`) — it was not, for as long as
         * this line has existed, so every reset email landed on a 404 and the whole flow was dead at
         * its last step while every piece before it worked.
         */
        await client.auth.resetPasswordForEmail(body.email, { redirectTo: `${appUrl}/auth/reset` });

        /*
         * Always report success, even for an address we have never seen. Reporting "no such account"
         * would turn this endpoint into a free membership oracle.
         */
        return json({ ok: true, message: 'If that email has an account, a reset link is on its way.' }, { headers });
      }

      /*
       * The second half of a password reset (§4.5.1).
       *
       * `/auth/reset` has already exchanged the emailed code for a real session, so by the time this
       * runs the caller IS signed in — as the person who proved control of that mailbox — and this is
       * an ordinary authenticated `updateUser`. There is no token to pass and none is accepted: a
       * route that took one would be a second, weaker way to change any password, and the reason it
       * would be weaker is that it is ours rather than Supabase's.
       *
       * `getUser()`, never `getSession()`: the cookie is attacker-supplied, and this changes a
       * credential.
       */
      case 'update-password': {
        const weak = passwordProblem(body.password);

        if (weak) {
          return json({ error: true, message: weak }, { status: 400, headers });
        }

        const { data, error: sessionError } = await client.auth.getUser();

        if (sessionError || !data.user) {
          /*
           * The link expired, was already used, or was opened in a different browser. Say which of
           * those it could be and what to do — "unauthorized" tells someone holding an email link
           * nothing they can act on.
           */
          return json(
            {
              error: true,
              message: 'That reset link has expired or was already used. Request a new one and try again.',
            },
            { status: 401, headers },
          );
        }

        const { error } = await client.auth.updateUser({ password: body.password! });

        if (error) {
          return json({ error: true, message: error.message }, { status: 400, headers });
        }

        return json({ ok: true, message: 'Your password has been changed.' }, { headers });
      }

      case 'resend': {
        if (!body.email) {
          return json({ error: true, message: 'Email is required.' }, { status: 400 });
        }

        await client.auth.resend({ type: 'signup', email: body.email });

        return json({ ok: true, message: 'Verification email sent.' }, { headers });
      }

      case 'signout': {
        await client.auth.signOut();
        return json({ ok: true }, { headers });
      }

      default:
        return json({ error: true, message: 'Unknown intent.' }, { status: 400 });
    }
  } catch (error) {
    logger.error(`Auth action failed: ${(error as Error).message}`);
    return errorResponse(error);
  }
}
