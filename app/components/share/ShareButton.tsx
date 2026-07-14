/**
 * The Share entry point (SPEC §4.8) — a header button that opens the Share dialog.
 *
 * Kept as its own component (button + dialog state) so `HeaderActionButtons` stays a thin layout, and
 * so the dialog's `useShareGame` hook only mounts when sharing is actually in play.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { description as descriptionStore, projectId as projectIdStore } from '~/lib/persistence';
import { ShareDialog } from './ShareDialog';

export function ShareButton() {
  const [open, setOpen] = useState(false);
  const activeProjectId = useStore(projectIdStore);
  const projectName = useStore(descriptionStore);

  // No project yet → nothing to share. The button simply does not render (§4.8: sharing is per-project).
  if (!activeProjectId) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover outline-accent-500"
        title="Share your game"
      >
        <div className="i-ph:share-network" />
        <span>Share</span>
      </button>
      {open && <ShareDialog isOpen={open} onClose={() => setOpen(false)} defaultTitle={projectName ?? undefined} />}
    </>
  );
}
