/**
 * The account, as the SERVER knows it (SPEC §4.5.1, §4.5.2).
 *
 * This panel had no notion of an account at all: it edited a per-browser `bolt_profile` and the chrome
 * printed "Guest User" beside it. Somebody signed in had nowhere in the product that would tell them
 * WHICH account they were signed into — and with the fields below writing to `localStorage`, the
 * natural conclusion was that the name they typed there was their account name.
 *
 * Read-only on purpose for now: `profiles.display_name` is settable, but a second editor for a value
 * the OAuth handshake also writes needs its own decision about which wins, and inventing that quietly
 * is how two writers on one field start. Renders nothing in local mode — there is no account there.
 */
import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { sessionStore } from '~/lib/stores/session';
import { useDisplayIdentity } from '~/lib/hooks/useSession';

export function AccountSection() {
  const session = useStore(sessionStore);
  const identity = useDisplayIdentity();

  if (identity.kind !== 'account' || !session.user) {
    return null;
  }

  const user = session.user;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700/50 p-4">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-full overflow-hidden shrink-0 bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
          {identity.avatar ? (
            <img src={identity.avatar} alt={identity.name} className="w-full h-full object-cover" />
          ) : (
            <div className="i-ph:user-circle-duotone w-8 h-8 text-gray-400 dark:text-gray-500" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 dark:text-gray-100 truncate">{identity.name}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{user.email}</div>
        </div>

        {/*
         * Verification gates GENERATION, not browsing (§4.5.1). Saying so here, rather than only in the
         * account menu, means the one screen a confused user opens can answer "why can't I build".
         */}
        <span
          className={classNames(
            'shrink-0 px-2 py-1 rounded-md text-xs font-medium',
            user.emailVerified
              ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
          )}
        >
          {user.emailVerified ? 'Verified' : 'Email not verified'}
        </span>
      </div>

      {!user.emailVerified && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          Verify your email to start building and claim your free credits. Use “Resend the link” in the account menu at
          the top right.
        </p>
      )}
    </div>
  );
}
