/**
 * The Media entry point (SPEC §4.16) — a header button that opens the Media generation panel.
 *
 * Mirrors `ShareButton`: button + dialog state only, so `HeaderActionButtons` stays a thin layout and
 * the panel mounts only when media generation is in play. Gated on an active project — the bytes land
 * in the project, so there is nothing to generate into without one.
 *
 * 🔴 AND ON THE GATEWAY, BUT ONLY ONCE THE SESSION HAS ANSWERED (2026-08-11). A deployment can serve
 * no media at all (`LLM_PROVIDER=Anthropic` with no `MEDIA_PROVIDER` — `getMediaProvider` returns
 * null), and this button rendered anyway, opening a panel that offered KIE's catalogue and refused at
 * quote time.
 *
 * ⚠️ THERE ARE THREE NULLS, NOT TWO, AND ONLY ONE OF THEM MEANS "NO GATEWAY".
 *
 *   1. `loading`      — /api/me has not answered yet.
 *   2. `loadFailed`   — it answered badly, or not at all (non-OK, offline, mid-deploy).
 *   3. settled `null` — it answered, and this deployment serves no media.
 *
 * Only (3) may hide the button. The first draft of this guard read `!loading && !provider` and filed
 * (2) under (3), because `refreshSession` reports a FAILED request as a fully empty session with
 * `loading: false` — so one blip made Media vanish on a box where media is configured. And it is not
 * a page-load-only concern: `usePromptEnhancer` refreshes the session MID-SESSION, so the button
 * would disappear out from under a user mid-edit, resizing the toolbar §4.1a says must not resize.
 * That is `mount-source.ts`'s rule — "could not ask" is not "asked and got none" — which this file's
 * own comment invoked while the code went on to collapse exactly those two.
 *
 * ⚠️ HIDDEN, NOT DISABLED — deliberately the opposite of Share/Deploy. Those are disabled-not-absent
 * because they become available a moment later; this one never will on this deployment, and §4.1a's
 * other half is that a permanently-disabled control "is a dead end, not a roadmap".
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { projectId as projectIdStore } from '~/lib/persistence';
import { sessionStore } from '~/lib/stores/session';
import { TOOLBAR_BUTTON } from '~/components/header/toolbar-button';
import { MediaPanel } from './MediaPanel';

export function MediaButton() {
  const [open, setOpen] = useState(false);
  const activeProjectId = useStore(projectIdStore);
  const { media, loading: sessionLoading, loadFailed } = useStore(sessionStore);

  if (!activeProjectId) {
    return null;
  }

  if (!sessionLoading && !loadFailed && !media.provider) {
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
