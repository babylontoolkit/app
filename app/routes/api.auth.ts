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

const logger = createScopedLogger('api.auth');

type Intent = 'signin' | 'signup' | 'signout' | 'oauth' | 'reset' | 'resend';

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

    switch (body.intent) {
      case 'signup': {
        if (!body.email || !body.password) {
          return json({ error: true, message: 'Email and password are required.' }, { status: 400 });
        }

        const { error } = await client.auth.signUp({
          email: body.email,
          password: body.password,

          /*
           * Verification gates the free grant and generation (§4.5.1, §4.5.4). The grant itself is
           * NOT issued here — it is issued when a verified session first appears (`api.me`), so a
           * signup that never confirms its email can never mint credits.
           */
          options: { emailRedirectTo: `${appUrl}/auth/callback` },
        });

        if (error) {
          return json({ error: true, message: error.message }, { status: 400, headers });
        }

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
          options: { redirectTo: `${appUrl}/auth/callback` },
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

        await client.auth.resetPasswordForEmail(body.email, { redirectTo: `${appUrl}/auth/reset` });

        /*
         * Always report success, even for an address we have never seen. Reporting "no such account"
         * would turn this endpoint into a free membership oracle.
         */
        return json({ ok: true, message: 'If that email has an account, a reset link is on its way.' }, { headers });
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
