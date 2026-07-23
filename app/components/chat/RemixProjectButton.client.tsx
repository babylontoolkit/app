/**
 * "Remix Project" — clone the current game into a new owned copy (SPEC §4.8 self-remix).
 *
 * The platform's unit is the server PROJECT (files + snapshot), not the local conversation, so this
 * runs the self-remix (`POST /api/remix { projectId }`, `deriveRemix`) against the id of the project
 * currently mounted, then hands the clone to the builder's resume path — the same mount baton a
 * shared-game remix uses (`pending-remix.ts`). The clone is born UNLINKED with no chats, exactly as
 * `deriveRemix` requires.
 *
 * ## Why this is a HOOK, not a button (2026-07-23)
 *
 * Remix used to be triggered ONLY from the sidebar chat list (a per-chat action), which the owner
 * removed — remixing belongs to the PROJECT, not to a row in the conversation list. It now lives in the
 * ⋯ main menu. Per §4.1a, an action a surface triggers is worth having independently of whatever
 * renders it; keeping the logic here means the menu item and any future trigger take the SAME path
 * rather than drifting into subtly different meanings of "remix".
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { useNavigate } from '@remix-run/react';
import { toast } from 'react-toastify';
import { projectId } from '~/lib/persistence/useChatHistory';
import { setPendingRemix } from '~/lib/persistence/pending-remix';

/**
 * Remix the current game.
 *
 * Returns `{ remix, busy }`: `remix` is a no-op when there is no project (nothing to clone) or while a
 * remix is already in flight (the double-click guard — a second POST would mint a second orphan clone).
 */
export function useRemixProject(): { remix: () => Promise<void>; busy: boolean } {
  const navigate = useNavigate();
  const pid = useStore(projectId);
  const [busy, setBusy] = useState(false);

  const remix = async () => {
    if (!pid || busy) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch('/api/remix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: pid }),
      });

      const data = (await response.json().catch(() => undefined)) as
        | { projectId?: string; message?: string }
        | undefined;

      if (response.ok && data?.projectId) {
        // Hand the clone to the builder's mount path, same baton a shared-game remix uses.
        setPendingRemix(data.projectId);
        navigate('/', { replace: true });
        toast.success('Project remixed');

        return;
      }

      // Never silent: the user asked for a copy and has to know they did not get one.
      toast.error(data?.message ?? 'Failed to remix project');
    } catch (error) {
      toast.error(`Failed to remix project: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  return { remix, busy };
}
