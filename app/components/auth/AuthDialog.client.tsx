/**
 * Sign in / sign up (SPEC §4.5.1).
 *
 * Email + password, plus Google and GitHub OAuth. All of it Supabase's — we never handle a password
 * beyond forwarding it, and we never mint a token.
 *
 * `redirectTo` preserves the intent through auth (§4.5.1): a visitor who clicked Remix or New Project
 * and hit the gate lands back on the thing they were trying to do, not on a generic dashboard. That
 * detail is the difference between a funnel and a leak.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { refreshSession } from '~/lib/stores/session';

interface Props {
  open: boolean;
  onClose: () => void;

  /** Where to land after auth. Defaults to the current page. */
  redirectTo?: string;
}

type Mode = 'signin' | 'signup' | 'reset';

export function AuthDialog({ open, onClose, redirectTo }: Props) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return null;
  }

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as { message?: string; url?: string; ok?: boolean };

    if (!response.ok) {
      throw new Error(data.message || 'Something went wrong.');
    }

    return data;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      if (mode === 'reset') {
        const data = await post({ intent: 'reset', email });
        toast.success(data.message ?? 'Check your inbox.');
        setMode('signin');
      } else if (mode === 'signup') {
        const data = await post({ intent: 'signup', email, password });
        toast.success(data.message ?? 'Check your inbox to verify your email.');
        onClose();
      } else {
        await post({ intent: 'signin', email, password });
        await refreshSession();

        // The preserved intent — back to the New Project / Remix the visitor started (§4.5.1).
        if (redirectTo) {
          window.location.href = redirectTo;
        } else {
          onClose();
        }
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const oauth = async (provider: 'google' | 'github') => {
    setBusy(true);

    try {
      const data = await post({ intent: 'oauth', provider, redirectTo });

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      toast.error((error as Error).message);
      setBusy(false);
    }
  };

  const input =
    'w-full px-3 py-2 rounded-md text-sm bg-bolt-elements-background-depth-1 ' +
    'border border-bolt-elements-borderColor text-bolt-elements-textPrimary ' +
    'focus:outline-none focus:border-bolt-elements-focus';

  return (
    <div
      className="overlay-centered fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl p-6 bg-bolt-elements-background-depth-2
          border border-bolt-elements-borderColor shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-bolt-elements-textPrimary mb-1">
          {mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Welcome back'}
        </h2>
        <p className="text-xs text-bolt-elements-textSecondary mb-4">
          {mode === 'signup'
            ? 'Verify your email and your starter credits are on us.'
            : mode === 'reset'
              ? 'We will email you a link to set a new password.'
              : 'Sign in to keep building.'}
        </p>

        <form onSubmit={submit} className="flex flex-col gap-2">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={input}
          />

          {mode !== 'reset' && (
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
            />
          )}

          <button
            type="submit"
            disabled={busy}
            className={classNames(
              'w-full py-2 rounded-md text-sm font-medium mt-1',
              'bg-bolt-elements-button-primary-background hover:bg-bolt-elements-button-primary-backgroundHover',
              'text-bolt-elements-button-primary-text disabled:opacity-50',
            )}
          >
            {busy ? 'Working…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send link' : 'Sign in'}
          </button>
        </form>

        {mode !== 'reset' && (
          <>
            <div className="flex items-center gap-2 my-3">
              <div className="flex-1 h-px bg-bolt-elements-borderColor" />
              <span className="text-[10px] text-bolt-elements-textTertiary">or</span>
              <div className="flex-1 h-px bg-bolt-elements-borderColor" />
            </div>

            <div className="flex gap-2">
              {(['github', 'google'] as const).map((provider) => (
                <button
                  key={provider}
                  disabled={busy}
                  onClick={() => oauth(provider)}
                  className="flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs
                    bg-bolt-elements-background-depth-3 hover:bg-bolt-elements-item-backgroundActive
                    text-bolt-elements-textPrimary disabled:opacity-50"
                >
                  <div className={`i-ph:${provider === 'github' ? 'github-logo' : 'google-logo'}`} />
                  {provider === 'github' ? 'GitHub' : 'Google'}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="flex justify-between mt-4 text-[11px] text-bolt-elements-textSecondary">
          <button onClick={() => setMode(mode === 'signup' ? 'signin' : 'signup')} className="hover:underline">
            {mode === 'signup' ? 'Already have an account?' : 'Create an account'}
          </button>

          {mode === 'signin' && (
            <button onClick={() => setMode('reset')} className="hover:underline">
              Forgot password?
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
