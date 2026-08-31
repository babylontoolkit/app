/**
 * The one mounted sign-in dialog (SPEC §4.5.1).
 *
 * Every door that can raise the gate — `startProject`, `/remix/:shareId`, the header's own "Sign in"
 * button — goes through `requestSignIn` and lands here. **One component, one dialog.** `AccountMenu`
 * used to own a second `AuthDialog` of its own, which meant "the auth dialog is open" had two writers
 * in two places; that is the drift this codebase has now found three times (two Syncs, three flags
 * meaning "the UI is open", two components drawing one save state), and the fix each time was a
 * parent rather than a third copy.
 *
 * Lives in the header because the header is on every route a gate can be raised from, and because a
 * dialog rendered by the creation path would unmount the moment that path navigated away — taking the
 * form with it while the user was typing in it.
 */
import { useStore } from '@nanostores/react';
import { authGate, dismissSignIn } from '~/lib/stores/auth-gate';
import { AuthDialog } from './AuthDialog.client';

export function AuthGate() {
  const gate = useStore(authGate);

  if (!gate) {
    return null;
  }

  return <AuthDialog open onClose={dismissSignIn} reason={gate.reason} redirectTo={gate.redirectTo} />;
}
