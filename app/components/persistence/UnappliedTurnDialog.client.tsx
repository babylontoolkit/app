/**
 * "Your last change didn't make it onto this device" (SPEC §4.5.4c, §4.6, §4.12).
 *
 * Appears when the project on screen is older than the last assistant turn in the conversation — which
 * means the user was CHARGED for work they cannot see. Measured: a `/bt-landing` redesign finished,
 * settled 427 credits, and the tab died before anything durable was written; re-opening showed the
 * project from before the run, with nothing to say the generation had happened.
 *
 * ## Why this asks instead of just doing it
 *
 * The files are recoverable — the artifact carries them — but "the copy on screen is older than the
 * last turn" has TWO causes with opposite correct actions: a crash before the checkpoint, and a
 * deliberate §4.12 restore. They are indistinguishable from what we know, and auto-applying would
 * silently undo somebody's undo. So this takes §4.13's posture: when the platform cannot be sure, it
 * asks. (`detectUnappliedTurn` returns `apply` without asking only when the project has no files at
 * all, where there is nothing to overwrite.)
 *
 * ## What the user is actually being asked
 *
 * Not "would you like to re-run a generation" — that would sound like it costs money again, and they
 * would say no. They already paid; this is their work, waiting. The wording says exactly that, and the
 * dismissal is safe: the conversation keeps the artifact, so declining loses nothing permanently.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { Dialog, DialogRoot, DialogTitle, DialogDescription, DialogButton } from '~/components/ui/Dialog';
import { unappliedTurn } from '~/lib/persistence/useChatHistory';
import { applyTranscriptArtifact } from '~/lib/persistence/apply-artifact';
import { workbenchStore } from '~/lib/stores/workbench';

export function UnappliedTurnDialog() {
  const pending = useStore(unappliedTurn);
  const [busy, setBusy] = useState(false);

  if (!pending) {
    return null;
  }

  const close = () => unappliedTurn.set(undefined);

  const apply = async () => {
    setBusy(true);

    try {
      /*
       * The message rides in the atom rather than being looked up again: the only other place to find
       * it is the rendered conversation, and a second source can disagree with the first about which
       * turn "the last one" is.
       */
      const applied = await applyTranscriptArtifact(pending.message);

      if (applied === 0) {
        toast.error('That change contained no files to restore.');
      } else {
        toast.success(`Restored ${applied} file${applied === 1 ? '' : 's'} from your last change.`);
        workbenchStore.showWorkbench.set(true);
      }
    } catch (error) {
      /* LOUD: this is the recovery of work the user has already paid for. */
      toast.error(`Could not restore your last change: ${(error as Error)?.message}`);
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <DialogRoot open onOpenChange={(open) => !open && close()}>
      <Dialog>
        <DialogTitle>Your last change isn’t on this device</DialogTitle>
        <DialogDescription>
          <p className="mb-2">
            The last thing the assistant built for this project isn’t in the files here — most likely the tab closed
            before it finished saving.
          </p>
          <p className="mb-2">
            You’ve already paid for it, and it’s still in the conversation, so it can be put back now.
          </p>
          <p className="text-bolt-elements-textSecondary text-sm">
            If you deliberately went back to an earlier version, choose <strong>Leave it</strong> — restoring would undo
            that.
          </p>
        </DialogDescription>
        <div className="px-5 pb-4 flex gap-2 justify-end">
          <DialogButton type="secondary" onClick={close}>
            Leave it
          </DialogButton>
          <DialogButton type="primary" onClick={apply} disabled={busy}>
            {busy ? 'Restoring…' : 'Restore my change'}
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
