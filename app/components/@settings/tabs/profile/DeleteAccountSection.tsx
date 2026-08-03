/**
 * Self-serve account deletion (SPEC §4.5.1).
 *
 * Three deliberate choices, all of them about making an irreversible action feel irreversible:
 *
 * - **It is not a button, it is a disclosure.** The destructive control does not sit on the panel
 *   waiting to be mis-clicked; opening the confirmation is itself an act.
 * - **The confirmation is the user's EMAIL, typed.** A checkbox or an "Are you sure?" is answered
 *   reflexively; typing your own address is the only cheap gesture that cannot be performed absently.
 *   (The server re-checks it against the session — see `decideAccountDeletion`. This field is the
 *   pause, not the wall.)
 * - **What will happen is listed BEFORE the field, in plain words**, including the two things people
 *   are most likely to be surprised by afterwards: published games stop working, and their code in
 *   their own GitHub repo is untouched (§4.5.4b — that is the whole point of repo-primary, and it is
 *   the one reassuring fact available at this moment).
 *
 * Renders nothing unless there is a real account to delete: local mode has no accounts (§4.5), and a
 * dead danger zone that reports "not configured" is worse than no danger zone.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { useDisplayIdentity } from '~/lib/hooks/useSession';
import { useStore } from '@nanostores/react';
import { sessionStore } from '~/lib/stores/session';

export function DeleteAccountSection() {
  const session = useStore(sessionStore);
  const identity = useDisplayIdentity();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);

  if (identity.kind !== 'account' || !session.user) {
    return null;
  }

  const email = session.user.email;

  const deleteAccount = async () => {
    setBusy(true);

    try {
      const response = await fetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'delete', confirmation }),
      });

      const data = (await response.json()) as { ok?: boolean; message?: string; projectsDeleted?: number };

      if (!response.ok || !data.ok) {
        /*
         * The server's own sentence, verbatim — it distinguishes "that does not match" from "we
         * deleted your projects but could not close the account", and those need different reactions
         * from the user. A generic "Could not delete account" is the `build-failure` mistake again.
         */
        toast.error(data.message || 'Could not delete the account. Please try again.');
        setBusy(false);

        return;
      }

      /*
       * A full page load, not an SPA navigate. Every store in this tab holds state belonging to an
       * account that no longer exists — the session, the project list, the open chat — and there is no
       * teardown path that clears all of them. Reloading is the only way to be sure none of it is
       * still on screen.
       */
      window.location.href = '/';
    } catch {
      toast.error('Could not reach the server. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="mt-10 pt-8 border-t border-gray-200 dark:border-gray-800">
      <h3 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">Danger zone</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Deleting your account is permanent. There is no undo and we cannot restore it for you.
      </p>

      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className={classNames(
            'px-4 py-2 rounded-lg text-sm font-medium',
            'border border-red-300 dark:border-red-500/40',
            'text-red-600 dark:text-red-400',
            'hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors',
          )}
        >
          Delete my account
        </button>
      ) : (
        <div className="rounded-xl border border-red-300 dark:border-red-500/40 bg-red-50/50 dark:bg-red-500/5 p-4">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">This will immediately:</p>

          <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1 mb-4 list-disc pl-5">
            <li>Delete every project in your account, along with its chats and files on our servers</li>
            <li>Stop any game you have published — shared links will no longer work</li>
            <li>Disconnect and delete your GitHub or GitLab connection</li>
            <li>Leave any remaining credits unusable — they are not refundable</li>
          </ul>

          {/*
           * The one piece of good news available here, and the reason repo-primary persistence exists
           * (§4.5.4b). Someone deleting their account has usually already worried about their work.
           */}
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            Any code you committed to your own GitHub or GitLab repository stays where it is — that is yours, and we do
            not touch it.
          </p>

          <label className="block text-sm text-gray-700 dark:text-gray-200 mb-2">
            Type <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{email}</span> to confirm
          </label>

          <input
            type="text"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={email}
            className={classNames(
              'w-full px-3 py-2 mb-4 rounded-lg',
              'bg-white dark:bg-gray-800/50',
              'border border-gray-200 dark:border-gray-700/50',
              'text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500',
              'focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500/50',
            )}
          />

          {/*
           * The button is disabled until the typed email matches, but the SERVER is what decides
           * (`decideAccountDeletion`) — this only stops the user firing a request that was always
           * going to be refused.
           */}
          <div className="flex items-center gap-3">
            <button
              onClick={deleteAccount}
              disabled={busy || confirmation.trim().toLowerCase() !== email.trim().toLowerCase()}
              className={classNames(
                'px-4 py-2 rounded-lg text-sm font-medium text-white',
                'bg-red-600 hover:bg-red-700 transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-red-600',
              )}
            >
              {busy ? 'Deleting…' : 'Permanently delete my account'}
            </button>

            <button
              onClick={() => {
                setOpen(false);
                setConfirmation('');
              }}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
