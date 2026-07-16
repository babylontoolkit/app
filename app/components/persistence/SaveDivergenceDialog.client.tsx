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
import { mountDivergence, repoStatus, startGitConnect, unsavedWork } from '~/lib/persistence';
import { db } from '~/lib/persistence/useChatHistory';
import { createLocalSnapshot, markSynced } from '~/lib/persistence/local-snapshots';
import { resolveDivergence, type DivergenceChoice } from '~/lib/persistence/projects';
import { protectForRepoRestore } from '~/lib/persistence/restore-plan';
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
         * 🔴 Checkpoint BEFORE overwriting, never after. This is the only moment the version being
         * replaced still exists anywhere — it is the unsaved side, so there is no repo to get it back
         * from. Taking it afterwards would checkpoint the thing that replaced it (§4.12).
         */
        if (db) {
          await createLocalSnapshot(db, {
            projectId: divergence.projectId,
            files: await workbenchStore.serializeFiles(),
            label: 'Before taking the other version',
          });
        }

        /*
         * A real switch, not an overlay: the user asked for the repo's version, and an overlay would
         * hand them a THIRD version — the repo's files plus every file only this browser had.
         * `protectForRepoRestore` keeps the secrets the repo never carried.
         */
        await workbenchStore.restoreFiles(result.files, { protect: protectForRepoRestore });

        if (db) {
          /*
           * These files came FROM the repo, so they are saved by definition — checkpoint them and mark
           * them synced. Without the mark, a project that just resolved cleanly would immediately
           * claim unsaved work and nag the user to save what they had literally just downloaded.
           */
          await createLocalSnapshot(db, {
            projectId: divergence.projectId,
            files: result.files,
            label: 'Updated from your repository',
          });
          await markSynced(db, divergence.projectId);
        }

        unsavedWork.set(false);
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
