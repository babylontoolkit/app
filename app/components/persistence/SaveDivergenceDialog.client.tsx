/**
 * "Your repository changed somewhere else" — the two-button choice (SPEC §4.13, §4.5.4b).
 *
 * This appears when both sides moved: someone committed to the repo from their own editor AND this
 * browser has work that was never saved. There is no correct automatic answer, so the platform does
 * not invent one — §4.13 forbids merging outright, and this dialog is the whole of the alternative.
 *
 * ## What the user is actually being asked
 *
 * They are not being asked about git. They are being asked "there are two versions of your game, which
 * one do you want?" — so the wording talks about versions and devices, not branches and heads, and the
 * dialog never uses the word "conflict" (which sounds like something they broke).
 *
 * Both answers are lossless, which is the thing to make obvious: taking the other version checkpoints
 * this one first (undo is one click away, §4.12), and keeping this one puts it somewhere new rather
 * than over anything. A user who believes they are choosing which half of their work to destroy will
 * pick neither and close the tab — and then the browser copy is what actually gets lost.
 *
 * Nothing here blocks a generation. The dialog is dismissible and the local files stay on screen while
 * it is open: they are the unsaved side, so they are the side that must not be disturbed by a question.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { Dialog, DialogRoot, DialogTitle, DialogDescription, DialogButton } from '~/components/ui/Dialog';
import { mountDivergence, repoStatus, startGitConnect } from '~/lib/persistence';
import { db } from '~/lib/persistence/useChatHistory';
import { applyBranchTree } from '~/lib/persistence/apply-branch-tree';
import { resolveDivergence, type DivergenceChoice } from '~/lib/persistence/projects';
import { workbenchStore } from '~/lib/stores/workbench';

export function SaveDivergenceDialog() {
  const divergence = useStore(mountDivergence);
  const repo = useStore(repoStatus);
  const [busy, setBusy] = useState<DivergenceChoice | undefined>();

  if (!divergence) {
    return null;
  }

  const where = repo?.provider === 'gitlab' ? 'GitLab' : 'GitHub';
  const close = () => mountDivergence.set(undefined);

  const choose = async (choice: DivergenceChoice) => {
    setBusy(choice);

    try {
      /*
       * `push-to-new-branch` sends the local work; `pull-overwrite` sends nothing and receives. The
       * files are read HERE, at the moment of the choice, so what travels is what is on screen.
       */
      const files = choice === 'push-to-new-branch' ? await workbenchStore.serializeFiles() : undefined;
      const result = await resolveDivergence(divergence.projectId, choice, files ? { files } : undefined);

      if (!result.ok) {
        if (result.reconnect) {
          toast.error(`Your ${where} connection expired. Reconnecting…`);
          startGitConnect(repo?.provider ?? 'github');

          return;
        }

        // LOUD, and the dialog STAYS OPEN — the choice has not been made, so it must not look made.
        toast.error(result.message ?? 'That did not work. Your work is still here — try again.');

        return;
      }

      if (choice === 'pull-overwrite' && result.files) {
        /*
         * 🔴 ONE APPLY PATH FOR EVERY TREE REPLACEMENT (§4.13a T18, Open Question 2 — converge).
         *
         * This arm used to hand-roll the whole sequence: a NON-strict before-checkpoint, a restore, a
         * second checkpoint, `markSynced`, `unsavedWork(false)`. Every step was right and it was a
         * SECOND implementation of what `applyBranchTree` does for a switch and a discard — which is
         * the one-half-of-a-pair-guarded shape this codebase keeps rediscovering. The steps it was
         * missing were the ones nobody had thought to add here yet: `resetAllFileModifications`,
         * `clearDeletedPaths`, the server working copy, and the reinstall.
         *
         * ⚠️ The before-checkpoint is now STRICT. That is the real upgrade: this is *the* moment the
         * version being replaced exists nowhere else — it is the unsaved side, so there is no repo to
         * get it back from — and a lax serialize omits a binary it cannot read. A strict failure
         * ABORTS the resolve and leaves the user's files exactly where they were, which is the only
         * acceptable answer when the alternative is destroying the only copy without a net.
         */
        /*
         * 🔴 CLOSE FIRST, OR THE NARRATION IS INVISIBLE. `WorkspaceSplash` is `z-50` by design (under
         * the sidebar and header); this dialog's overlay is `z-[9999]` with a backdrop blur, so
         * awaiting with it open buries the whole 30-second story beneath a black scrim.
         *
         * Safe here for a stronger reason than in the sync dialog: the server has ALREADY resolved the
         * divergence — the choice is made and recorded — so there is no longer a decision this dialog
         * is holding open. What follows is local work narrated by the full-page splash. ⚠️ If it
         * FAILS there is no panel to fall back to (see the refusal branch below): the persistent toast
         * is the whole report.
         */
        close();

        const applied = await applyBranchTree({
          projectId: divergence.projectId,
          files: result.files,

          /*
           * The divergence signal carries only a project id and a remote head, so the branch name
           * comes from `repoStatus` — the same store the working-copy stamp reads (`repo-status.ts`).
           * One reader, one answer.
           */
          branch: repo?.branch ?? 'your repository',
          operation: 'pull',
          db,
        });

        if (!applied.ok) {
          /*
           * 🔴 LOUD, AND IT STAYS ON SCREEN (`autoClose: false`).
           *
           * The dialog cannot "stay open" any more — the server already resolved the divergence, so
           * re-asking would offer a decision the user has spent, and the second press would be refused
           * as no longer divergent. That makes this toast the WHOLE report: there is no failure panel
           * on this path (a comment here used to claim one; a review found by rendering that there is
           * not). `applied.reason` names the operation and the branch, so it is actionable alone.
           */
          toast.error(applied.reason, { autoClose: false });

          return;
        }

        toast.success('Updated. You are now on the version from your repository.');
      } else if (choice === 'push-to-new-branch') {
        /*
         * The work is safe, but it is NOT on the project's own branch — so `unsavedWork` stays true on
         * purpose. Saying "saved" here would be true about the bytes and false about the thing the
         * user cares about: this project is still not up to date with itself.
         */
        toast.success(
          result.branch
            ? `Kept your version — it is saved separately as "${result.branch}".`
            : 'Kept your version — it is saved separately.',
        );
      }

      close();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <DialogRoot open onOpenChange={(o) => !o && close()}>
      <Dialog className="!max-w-lg !w-[90vw]" onClose={close}>
        <div className="p-6 flex flex-col gap-4">
          <div>
            <DialogTitle>There are two versions of this project</DialogTitle>
            <DialogDescription>
              Your {where} repository has changes that were made somewhere else — another device, or an editor on your
              computer. This browser also has changes that were never saved. We will not mix them together, so it is
              your call.
            </DialogDescription>
          </div>

          <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
            Whichever you pick, nothing is thrown away — the other version is kept and you can go back to it.
          </div>

          <div className="flex flex-col gap-2">
            <DialogButton type="primary" onClick={() => choose('push-to-new-branch')} disabled={busy !== undefined}>
              {busy === 'push-to-new-branch' ? 'Saving…' : 'Keep what is in this browser (saved separately)'}
            </DialogButton>
            <DialogButton type="secondary" onClick={() => choose('pull-overwrite')} disabled={busy !== undefined}>
              {busy === 'pull-overwrite' ? 'Updating…' : 'Use the version from my repository instead'}
            </DialogButton>
          </div>

          <div className="text-xs text-bolt-elements-textTertiary">
            Not sure? Close this and keep working — nothing is lost, and we will ask again next time you save.
          </div>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
