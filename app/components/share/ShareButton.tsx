/**
 * The Share entry point (SPEC §4.8) — a header button that opens the Share dialog.
 *
 * Kept as its own component (button + dialog state) so `HeaderActionButtons` stays a thin layout, and
 * so the dialog's `useShareGame` hook only mounts when sharing is actually in play.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { description as descriptionStore, projectId as projectIdStore } from '~/lib/persistence';
import { TOOLBAR_BUTTON } from '~/components/header/toolbar-button';
import { ShareDialog } from './ShareDialog';

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
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={TOOLBAR_BUTTON}
        title={disabled ? 'Available once your game has built' : 'Publish your game to a public link'}
      >
        <div className="i-ph:share-network" />
        <span>Share</span>
      </button>
      {open && <ShareDialog isOpen={open} onClose={() => setOpen(false)} defaultTitle={projectName ?? undefined} />}
    </>
  );
}
