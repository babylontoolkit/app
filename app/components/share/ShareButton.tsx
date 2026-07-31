/**
 * The Share entry point (SPEC §4.8) — a header button that opens the Share dialog.
 *
 * Kept as its own component (button + dialog state) so `HeaderActionButtons` stays a thin layout, and
 * so the dialog's `useShareGame` hook only mounts when sharing is actually in play.
 */
import { useCallback, useState } from 'react';
import { useStore } from '@nanostores/react';
import { description as descriptionStore, projectId as projectIdStore } from '~/lib/persistence';
import { getProject } from '~/lib/persistence/projects';
import { TOOLBAR_BUTTON } from '~/components/header/toolbar-button';
import { ShareDialog } from './ShareDialog';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ShareButton');

interface ShareButtonProps {
  /**
   * Set while the preview is still booting. The button RENDERS anyway — see the toolbar note in
   * `HeaderActionButtons`: a right-aligned row whose members pop in shoves everything left, and a user
   * is better served seeing that sharing exists (and why it is not ready) than watching it appear.
   */
  disabled?: boolean;
}

export function ShareButton({ disabled }: ShareButtonProps = {}) {
  const [open, setOpen] = useState(false);
  const activeProjectId = useStore(projectIdStore);
  const projectName = useStore(descriptionStore);

  /**
   * 🔴 The share id the project ALREADY has. Found live 2026-07-31: `ShareDialog` declared
   * `existingShareId` and nothing ever passed it — one consumer, zero producers — so the dialog's
   * `shareId` state started `undefined` on every open and only ever got a value from a publish
   * performed in that same session. Close the dialog and re-open it, or reload the page, and a live
   * published game presented the first-time "Share your game" form with no link, no Unpublish and no
   * Update: the URL the user had just been given was simply gone, and the only way back to it was to
   * publish again.
   *
   * Read on OPEN rather than on mount: the header renders this for every project view, and the answer
   * can change elsewhere (an unpublish on another device, a publish in another tab), so a value cached
   * at mount is the same staleness one step later.
   */
  const [existingShareId, setExistingShareId] = useState<string | undefined>();

  const openDialog = useCallback(() => {
    setOpen(true);

    if (!activeProjectId) {
      return;
    }

    /*
     * Fire-and-forget: this decides which FACE the dialog opens on, and a failed lookup must not stop
     * the user sharing. Failing to it leaves the publish form — which is wrong-but-recoverable (a
     * re-publish overwrites the same share), where claiming "shared" we cannot confirm would hand the
     * user a link that may not exist.
     */
    getProject(activeProjectId)
      .then((project) => setExistingShareId(project.shareId))
      .catch((error) => logger.warn(`Could not read the project's share state: ${(error as Error).message}`));
  }, [activeProjectId]);

  // No project yet → nothing to share. The button simply does not render (§4.8: sharing is per-project).
  if (!activeProjectId) {
    return null;
  }

  return (
    <>
      {/*
       * The same style as every other toolbar action (`header/toolbar-button.ts`). It was accent-filled
       * as the row's "primary"; the owner's call is that a row of buttons wearing four different looks
       * reads as mess before it reads as hierarchy. The only element allowed to differ is the git chip,
       * because it carries STATE rather than an action.
       */}
      <button
        onClick={openDialog}
        disabled={disabled}
        className={TOOLBAR_BUTTON}
        title={disabled ? 'Available once your game has built' : 'Publish your game to a public link'}
      >
        <div className="i-ph:share-network" />
        <span>Share</span>
      </button>
      {open && (
        <ShareDialog
          isOpen={open}
          onClose={() => setOpen(false)}
          defaultTitle={projectName ?? undefined}
          existingShareId={existingShareId}
        />
      )}
    </>
  );
}
