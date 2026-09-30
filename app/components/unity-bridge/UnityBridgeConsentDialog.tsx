/**
 * Asks the user before a consent-tier Unity operation runs (SPEC §4.17, D16).
 *
 * Opens whenever `bridgeConsentStore` holds a request. There is deliberately NO "remember my choice"
 * control and no close button: every consent-tier call is answered by a person, once (spec B14). The
 * server dispatches only after an Allow, so a Deny — or no answer before the timeout — runs nothing.
 */
import { useStore } from '@nanostores/react';
import { Dialog, DialogButton, DialogDescription, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import { answerConsent, bridgeConsentStore } from '~/lib/stores/unity-bridge';

export function UnityBridgeConsentDialog() {
  const consent = useStore(bridgeConsentStore);

  if (!consent) {
    return null;
  }

  /*
   * `!z-[10000]`: above every other bridge dialog (they sit at the shared Dialog's `z-[9999]`). Important,
   * because two utilities setting one property are ordered by the generated stylesheet, not the class
   * string. The store also never auto-opens another bridge dialog over a pending prompt.
   */
  return (
    <DialogRoot open>
      <Dialog showCloseButton={false} className="!z-[10000]">
        <div className="p-6 flex flex-col gap-3">
          <DialogTitle>Allow this Unity operation?</DialogTitle>
          <DialogDescription>{`The agent wants to run this on "${consent.target}":`}</DialogDescription>
          <pre className="text-xs bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all">
            {consent.operation}
          </pre>
          <p className="text-sm text-bolt-elements-textSecondary">
            This can change installed software or your project's history. It runs only if you allow it.
          </p>
          <div className="flex justify-end gap-2 mt-2">
            <DialogButton type="secondary" onClick={() => void answerConsent(false)}>
              Deny
            </DialogButton>
            <DialogButton type="primary" onClick={() => void answerConsent(true)}>
              Allow once
            </DialogButton>
          </div>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
