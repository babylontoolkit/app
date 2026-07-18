/**
 * The Media entry point (SPEC §4.16) — a header button that opens the Media generation panel.
 *
 * Mirrors `ShareButton`: button + dialog state only, so `HeaderActionButtons` stays a thin layout and
 * the panel mounts only when media generation is in play. Gated on an active project — the bytes land
 * in the project, so there is nothing to generate into without one.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { projectId as projectIdStore } from '~/lib/persistence';
import { MediaPanel } from './MediaPanel';

export function MediaButton() {
  const [open, setOpen] = useState(false);
  const activeProjectId = useStore(projectIdStore);

  if (!activeProjectId) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover outline-accent-500"
        title="Generate images & video"
      >
        <div className="i-ph:image" />
        <span>Media</span>
      </button>
      {open && <MediaPanel projectId={activeProjectId} onClose={() => setOpen(false)} />}
    </>
  );
}
