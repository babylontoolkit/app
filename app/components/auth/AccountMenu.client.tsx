/**
 * Account menu and sign-in gate (SPEC §4.5.1).
 *
 * **Anonymous visitors may look around.** Browsing the gallery and playing a shared game need no
 * account at all — that is the zero-cost funnel. The gate falls only at creation intent, and even
 * then it is an invitation, not a wall.
 *
 * Renders nothing when accounts are not configured (local mode): there is no one to sign in as, and
 * a dead "Sign in" button that reports "not configured" is worse than no button.
 */
import { useStore } from '@nanostores/react';
import { useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { refreshSession, sessionStore } from '~/lib/stores/session';
import { requestSignIn } from '~/lib/stores/auth-gate';

export function AccountMenu() {
  const session = useStore(sessionStore);
  const [open, setOpen] = useState(false);

  // Local mode: a single developer, no accounts, nothing to sign into.
  if (session.loading || !session.accountsEnabled) {
    return null;
  }

  /*
   * The header's own door into the gate — through the SAME store every other door uses, so there is
   * exactly one dialog in the app (`AuthGate`). This button used to hold an `open` flag and render an
   * `AuthDialog` of its own, which made "the auth dialog is open" a thing with two writers in two
   * places: the drift this codebase has now found three times (two buttons called Sync, three flags
   * meaning "the UI is open", two components drawing one save state), fixed each time by a parent.
   *
   * No reason sentence — pressing "Sign in" IS the intent, and narrating it back is noise. The
   * destination is simply where the user already is.
   */
  if (!session.authenticated) {
    return (
      <button
        onClick={() => requestSignIn({ reason: '', redirectTo: window.location.pathname + window.location.search })}
        className="px-3 py-1 rounded-md text-xs font-medium bg-bolt-elements-button-primary-background
          hover:bg-bolt-elements-button-primary-backgroundHover text-bolt-elements-button-primary-text"
      >
        Sign in
      </button>
    );
  }

  const user = session.user!;

  const signOut = async () => {
    await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'signout' }),
    });
    await refreshSession();
    window.location.href = '/';
  };

  const resendVerification = async () => {
    await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'resend', email: user.email }),
    });
    toast.success('Verification email sent.');
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs
          text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive"
      >
        <div className="i-ph:user-circle-duotone text-lg" />
        <span className="max-w-[10ch] truncate">{user.displayName}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-56 z-50 rounded-lg p-2
          border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg"
        >
          <div className="px-2 py-1.5 border-b border-bolt-elements-borderColor mb-1">
            <div className="text-xs font-medium text-bolt-elements-textPrimary truncate">{user.displayName}</div>
            <div className="text-[10px] text-bolt-elements-textTertiary truncate">{user.email}</div>
          </div>

          {/*
           * Verification gates GENERATION, not browsing (§4.5.1) — so an unverified user gets a nudge
           * here rather than a locked-out app. They can look around; they just cannot spend our money.
           */}
          {!user.emailVerified && (
            <div className="px-2 py-1.5 mb-1 rounded bg-bolt-elements-item-backgroundDanger">
              <p className="text-[10px] text-bolt-elements-icon-error mb-1">
                Verify your email to start building and claim your free credits.
              </p>
              <button onClick={resendVerification} className="text-[10px] underline text-bolt-elements-icon-error">
                Resend the link
              </button>
            </div>
          )}

          {/*
           * Pro is an UPSELL here, never a gate on anything but BYOK (§4.6.1). Export and GitHub Sync
           * stay available to this user regardless — we never hold a project hostage.
           */}
          {session.pro.proFeaturesEnabled && (
            <a
              href="/settings/pro"
              className={classNames(
                'flex items-center gap-2 px-2 py-1.5 rounded text-xs',
                'hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textPrimary',
              )}
            >
              <div className="i-ph:key-duotone" />
              {session.pro.byokUnlocked ? 'Pro Tools — BYOK unlocked' : 'Unlock BYOK with Pro Tools'}
            </a>
          )}

          <a
            href="/settings/credits"
            className="flex items-center gap-2 px-2 py-1.5 rounded text-xs
              hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textPrimary"
          >
            <div className="i-ph:lightning-duotone" />
            Credits &amp; usage
          </a>

          <button
            onClick={signOut}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs
              hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textPrimary"
          >
            <div className="i-ph:sign-out-duotone" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
