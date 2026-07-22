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
import { TOOLBAR_BUTTON } from '~/components/header/toolbar-button';
import { MediaPanel } from './MediaPanel';

export function MediaButton() {
  const [open, setOpen] = useState(false);
  const activeProjectId = useStore(projectIdStore);

  if (!activeProjectId) {
    return null;
  }

  return (
    <>
      {/* One shared toolbar style — see `header/toolbar-button.ts` for why it is not inlined here. */}
      <button onClick={() => setOpen(true)} className={TOOLBAR_BUTTON} title="Generate images & video">
        <div className="i-ph:image" />
        <span>Media</span>
      </button>
      {open && <MediaPanel projectId={activeProjectId} onClose={() => setOpen(false)} />}
    </>
  );
}
