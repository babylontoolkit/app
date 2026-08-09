/**
 * The top bar's title — the PROJECT's name (SPEC §4.5.5, §4.5.6).
 *
 * 🔴 It names the PROJECT, not the chat, and the distinction is the point. A project holds MANY chats
 * (§4.5.6, "New chat, same game"): the chats are conversations *about* the thing, and they are listed
 * in the sidebar where each can be renamed on its own row. The thing itself — the game you are
 * building, the unit that owns the files, the sandbox, sharing and ownership — is the project, and
 * the one always-visible slot in the chrome should name that. The header previously showed the
 * active chat's description, so the title changed every time you started a new conversation on the
 * same game, and two windows on one project could disagree about what it was called.
 *
 * Additive rather than a rewrite of upstream's `ChatDescription` (SPEC §2.1a): that component and its
 * `useEditChatDescription` hook are inherited, and the hook is still shared with the sidebar's
 * `HistoryItem`. Repurposing it would have quietly changed what the sidebar's rename does too.
 *
 * The pencil renames the PROJECT, because a control must edit the thing it sits next to — a pencil
 * beside a project name that renamed a hidden chat is the "two Syncs" defect (§4.1a) wearing a
 * different hat.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import WithTooltip from '~/components/ui/Tooltip';
import { projectId as projectIdStore } from '~/lib/persistence';
import { getProject, renameProject } from '~/lib/persistence/projects';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ProjectTitle');

/** Mirrors the server's cap (`api.projects.$projectId.ts` slices to 120). */
const MAX_NAME_LENGTH = 120;

/**
 * 🔴 "Not loaded YET" and "could not be loaded" are DIFFERENT, and collapsing them is what emptied the
 * header (found 2026-08-09).
 *
 * `getProject` used to be `.catch(() => undefined)` with the note *"an offline miss leaves the bar
 * empty, exactly as it was before a name arrived"* — which treats a permanent failure as a slow
 * success. It is not offline-only and it is not transient: `requireOwnedProject` answers **404, not
 * 403**, for a project that is missing OR belongs to someone else (the enumeration-oracle rule,
 * §4.5.3), so a project whose server row is gone returns the same shape forever. The component then
 * rendered `null`, the title silently vanished, and the one always-visible label naming what you are
 * looking at was simply absent — with nothing anywhere saying why.
 *
 * MEASURED live: `GET /api/projects/prj_…` → `404 {"message":"That project does not exist."}` for a
 * project the browser still held with six local checkpoints, while a project created after the
 * server's store was reset showed its title normally. Same code, same header — which is exactly why it
 * reads as "sometimes it disappears".
 *
 * The distinction matters beyond the label: a project the server cannot resolve also cannot be
 * renamed, shared, deployed, or given a working copy, so an empty bar hides a half-dead project behind
 * what looks like a cosmetic gap. Loading still renders nothing (a flash of fallback text on every
 * open would be worse); FAILING says so.
 */
type NameState = { status: 'loading' } | { status: 'ready'; name: string } | { status: 'unavailable' };

export function ProjectTitle() {
  const activeProjectId = useStore(projectIdStore);

  const [state, setState] = useState<NameState>({ status: 'loading' });
  const name = state.status === 'ready' ? state.name : undefined;
  const setName = useCallback(
    (next: string | undefined) => setState(next ? { status: 'ready', name: next } : { status: 'unavailable' }),
    [],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  /*
   * The name as the SERVER last confirmed it — what an failed rename reverts to. Kept in a ref rather
   * than derived from `name`, which is optimistically overwritten the moment the user submits.
   */
  const confirmed = useRef<string | undefined>();

  useEffect(() => {
    if (!activeProjectId) {
      setState({ status: 'loading' });
      confirmed.current = undefined;

      return undefined;
    }

    let cancelled = false;

    setState({ status: 'loading' });

    getProject(activeProjectId)
      .then((project) => {
        if (!cancelled) {
          setState(project.name ? { status: 'ready', name: project.name } : { status: 'unavailable' });
          confirmed.current = project.name;
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        /*
         * Never silent. This is the whole defect: the bar going blank was the ONLY symptom of a
         * project the server cannot resolve, and it was indistinguishable from one still loading.
         */
        logger.warn(`Could not load project ${activeProjectId} for the header title`, error);
        setState({ status: 'unavailable' });
        confirmed.current = undefined;
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const startEditing = useCallback(() => {
    setDraft(name ?? '');
    setEditing(true);
  }, [name]);

  const submit = useCallback(
    async (event?: { preventDefault: () => void }) => {
      event?.preventDefault();

      const next = draft.trim().slice(0, MAX_NAME_LENGTH);
      const previous = confirmed.current;

      setEditing(false);

      /*
       * An empty name is a no-op, not a rename. The server would accept `''` and the project would
       * become an untitled row in the dashboard with nothing to click — easy to do by selecting all
       * and hitting enter, and there is no undo.
       */
      if (!activeProjectId || !next || next === previous) {
        setDraft('');
        return;
      }

      // Optimistic: the header is the surface being typed into, so it must not lag a round trip.
      setName(next);

      try {
        await renameProject(activeProjectId, next);
        confirmed.current = next;
      } catch (error) {
        setName(previous);
        toast.error(error instanceof Error ? error.message : 'Could not rename this project.');
      }
    },
    [activeProjectId, draft],
  );

  /*
   * Still asking. Renders nothing on purpose — a fallback label flashed on every open would be a worse
   * lie than a brief gap, and this state always resolves.
   */
  if (state.status === 'loading') {
    return null;
  }

  /*
   * Asked and failed. Say so, and do NOT offer the pencil: renaming posts to the same project the
   * server just refused to resolve, so the control could only ever produce an error toast.
   */
  if (state.status === 'unavailable') {
    return (
      <TooltipProvider>
        <WithTooltip tooltip="This project's record could not be loaded, so it cannot be renamed, shared or deployed. Reload the page; if it persists, the project no longer exists on the server.">
          <span className="truncate text-bolt-elements-textTertiary italic">Project unavailable</span>
        </WithTooltip>
      </TooltipProvider>
    );
  }

  if (!name) {
    return null;
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="flex items-center gap-2">
        <input
          type="text"
          className="bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary rounded px-2 min-w-0"
          autoFocus
          value={draft}
          maxLength={MAX_NAME_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // Abandon, do not save — Escape is the one gesture that must never write.
              setEditing(false);
              setDraft('');
            }
          }}
          style={{ width: `${Math.min(Math.max(draft.length + 2, 12), 48)}ch` }}
        />
        {/*
         * The tick fires on `onMouseDown`, not `onClick`: the input's `onBlur` also submits, and blur
         * fires first on a click — by the time `onClick` ran the form would already be closed.
         */}
        <TooltipProvider>
          <WithTooltip tooltip="Save name">
            <div className="flex items-center p-2 rounded-md bg-bolt-elements-item-backgroundAccent">
              <button
                type="submit"
                className="i-ph:check-bold scale-110 hover:text-bolt-elements-item-contentAccent"
                onMouseDown={submit}
              />
            </div>
          </WithTooltip>
        </TooltipProvider>
      </form>
    );
  }

  return (
    <div className="flex items-center min-w-0">
      <span className="truncate">{name}</span>
      <TooltipProvider>
        <WithTooltip tooltip="Rename project">
          <button
            type="button"
            className="ml-2 shrink-0 i-ph:pencil-fill scale-110 hover:text-bolt-elements-item-contentAccent"
            onClick={(event) => {
              event.preventDefault();
              startEditing();
            }}
          />
        </WithTooltip>
      </TooltipProvider>
    </div>
  );
}
