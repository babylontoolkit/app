/**
 * `/auth/reset` — set a new password (SPEC §4.5.1).
 *
 * ## Why this file exists
 *
 * `/api/auth`'s `reset` intent has always told Supabase to send the user here, and this route did not
 * exist. Every other part of the flow worked — the dialog's "Forgot password?", the deliberately vague
 * "if that email has an account" response, the email itself — and then the link landed on a 404. The
 * failure was invisible from inside the product because nothing throws: the endpoint returns `ok`, and
 * only a person holding the email ever finds out.
 *
 * ## The shape
 *
 * Supabase's link carries a one-time `code`. The loader exchanges it for a real session and then
 * REDIRECTS to this same path without it, for two reasons: a code is single-use, so leaving it in the
 * address bar means a reload looks like an expired link; and a credential-grade token in the URL is a
 * token in browser history, in the referrer of every asset the page loads, and in any proxy log along
 * the way. The `Set-Cookie` headers from the exchange ride on that redirect — dropping them is the
 * classic "signed in, then immediately signed out" bug, and here it would present as a reset form that
 * refuses every password.
 *
 * After the exchange the visitor is signed in as the person who proved control of that mailbox, so the
 * form itself is an ordinary authenticated `updateUser` (`intent: 'update-password'`). We never mint,
 * carry, or validate a reset token ourselves.
 */
import { useEffect, useState } from 'react';
import { json, redirect, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { useLoaderData, useNavigate } from '@remix-run/react';
import { toast } from 'react-toastify';
import { createScopedLogger } from '~/utils/logger';
import { createRequestClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { classNames } from '~/utils/classNames';
import { MIN_PASSWORD_LENGTH } from '~/lib/auth/safe-redirect';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { refreshSession } from '~/lib/stores/session';

const logger = createScopedLogger('auth.reset');

interface LoaderData {
  /** True once there is a session to change a password on. */
  ready: boolean;

  /** Why not, when `ready` is false — always a sentence the user can act on. */
  problem?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  /*
   * Local mode has no accounts and no passwords (§4.5). Landing here means a link from some other
   * deployment, or a bookmark; say so rather than rendering a form that cannot do anything.
   */
  if (!isSupabaseConfigured(context)) {
    return json<LoaderData>({ ready: false, problem: 'Accounts are not configured on this server.' });
  }

  /*
   * Supabase reports a dead link in the query string rather than by failing the redirect. Prefer its
   * description — "Email link is invalid or has expired" is more use than anything generic we could
   * write, and it distinguishes expiry from an already-used link.
   */
  const errorDescription = url.searchParams.get('error_description') ?? url.searchParams.get('error');

  if (errorDescription) {
    return json<LoaderData>({ ready: false, problem: errorDescription });
  }

  const code = url.searchParams.get('code');
  const { client, headers } = await createRequestClient(request, context);

  if (code) {
    const { error } = await client.auth.exchangeCodeForSession(code);

    if (error) {
      logger.warn(`Password-reset exchange failed: ${error.message}`);

      /*
       * The headers still ride: the exchange may have cleared a stale cookie on its way to failing,
       * and dropping that leaves the browser holding a session Supabase has already rejected.
       */
      return json<LoaderData>(
        { ready: false, problem: 'That reset link has expired or was already used. Request a new one below.' },
        { headers },
      );
    }

    // Strip the single-use code from the URL. See the header comment — the cookies MUST come along.
    return redirect('/auth/reset', { headers });
  }

  /*
   * No code: either the post-exchange redirect above, or someone who opened this page directly.
   * `getUser()`, not `getSession()` — the cookie is attacker-supplied and this page changes a
   * credential, so it has to be verified against the auth server rather than trusted.
   */
  const { data } = await client.auth.getUser();

  if (!data.user) {
    return json<LoaderData>(
      { ready: false, problem: 'This page needs a valid reset link. Request one below and open it from your email.' },
      { headers },
    );
  }

  return json<LoaderData>({ ready: true }, { headers });
}

export default function ResetRoute() {
  const { ready, problem } = useLoaderData<LoaderData>();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  /*
   * The exchange in the loader signed this browser in. The session store was populated before that
   * happened, so without this the header still shows "Sign in" next to a page that just authenticated
   * the user — the same false statement `resolveDisplayIdentity` exists to prevent, one screen over.
   */
  useEffect(() => {
    if (ready) {
      void refreshSession();
    }
  }, [ready]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as { message?: string };

    if (!response.ok) {
      throw new Error(data.message || 'Something went wrong.');
    }

    return data;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    /*
     * Checked here as well as by the server, because the two answer different questions: the server
     * decides whether the password is ACCEPTABLE, this decides whether the user typed what they meant.
     * A mismatch is not a policy failure and should not cost a round trip to find out about.
     */
    if (password !== confirm) {
      toast.error('Those passwords do not match.');
      return;
    }

    setBusy(true);

    try {
      await post({ intent: 'update-password', password });
      await refreshSession();
      setDone(true);
      toast.success('Your password has been changed.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resend = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      const data = await post({ intent: 'reset', email });
      toast.success(data.message ?? 'Check your inbox.');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input =
    'w-full px-3 py-2 rounded-md text-sm bg-bolt-elements-background-depth-1 ' +
    'border border-bolt-elements-borderColor text-bolt-elements-textPrimary ' +
    'focus:outline-none focus:border-bolt-elements-focus';

  const button = classNames(
    'w-full py-2 rounded-md text-sm font-medium mt-1',
    'bg-bolt-elements-button-primary-background hover:bg-bolt-elements-button-primary-backgroundHover',
    'text-bolt-elements-button-primary-text disabled:opacity-50',
  );

  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <main className="flex-1 flex items-center justify-center">
        <div
          className="w-full max-w-sm rounded-xl p-6 bg-bolt-elements-background-depth-2
            border border-bolt-elements-borderColor shadow-xl"
        >
          {done ? (
            <>
              <h1 className="text-lg font-semibold text-bolt-elements-textPrimary mb-1">Password changed</h1>
              <p className="text-xs text-bolt-elements-textSecondary mb-4">
                You are signed in. Pick up where you left off.
              </p>
              <button onClick={() => navigate('/', { replace: true })} className={button}>
                Start building
              </button>
            </>
          ) : ready ? (
            <>
              <h1 className="text-lg font-semibold text-bolt-elements-textPrimary mb-1">Set a new password</h1>
              <p className="text-xs text-bolt-elements-textSecondary mb-4">
                At least {MIN_PASSWORD_LENGTH} characters. You will stay signed in on this device.
              </p>

              <form onSubmit={submit} className="flex flex-col gap-2">
                <input
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={input}
                />
                <input
                  type="password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={input}
                />
                <button type="submit" disabled={busy} className={button}>
                  {busy ? 'Working…' : 'Change password'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-bolt-elements-textPrimary mb-1">This link cannot be used</h1>
              <p className="text-xs text-bolt-elements-textSecondary mb-4">{problem}</p>

              <form onSubmit={resend} className="flex flex-col gap-2">
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={input}
                />
                <button type="submit" disabled={busy} className={button}>
                  {busy ? 'Working…' : 'Send a new link'}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
