/**
 * "All Projects" — the project grid (SPEC §4.1 Dashboard).
 *
 * A project is the platform's real unit of work: the files, the server checkpoints, ownership, sharing
 * and remixing all hang off the server `Project` row (§4.5.5). The sidebar only ever showed *local*
 * chats (IndexedDB, this-browser-only), so there was no way to see your library across devices. This
 * page fetches the authoritative list from `/api/projects` and lets you open, remix, rename or delete
 * each one.
 *
 * Two data sources are merged here:
 *   - the SERVER project list (`listProjects`) — the source of truth, works on any device;
 *   - the LOCAL chats (`getAll`) — used only to resolve a project's `/chat/:urlId` so "Open" lands the
 *     user back in the exact conversation when it exists in this browser. When it does not, we fall back
 *     to mounting the project's files fresh through the shared pending-mount baton.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@remix-run/react';
import { toast } from 'react-toastify';
import { formatDistanceToNow } from 'date-fns';
import { db, getAll, deleteById, type ChatHistoryItem } from '~/lib/persistence';
import { listProjects, deleteProject, renameProject, ApiError } from '~/lib/persistence/projects';
import { setPendingOpenProject, setPendingRemix } from '~/lib/persistence/pending-remix';
import { filterOwnedRecords, localViewer } from '~/lib/persistence/local-owner';
import { describeProjectSaveBadge } from '~/lib/persistence/save-status';
import { readCurrentLocalSnapshot } from '~/lib/persistence/local-snapshots';
import { useGameRegistry } from '~/lib/hooks/useGameRegistry';
import { bootedProjectId } from '~/lib/sandbox';
import type { Project } from '~/types/project';
import { classNames } from '~/utils/classNames';
import { Dialog, DialogButton, DialogDescription, DialogRoot, DialogTitle } from '~/components/ui/Dialog';

/** The subset of a local chat we need to resolve "open in the same conversation". */
interface LocalChatRef {
  urlId?: string;
  id: string;
  timestamp: string;
}

/**
 * A project's local chats, most recent first (§4.5.6).
 *
 * This used to keep the FIRST chat it met per project and drop the rest on the floor — which was
 * invisible while a project could only have one chat, and became "Open sends me to a random old
 * conversation" the moment it could have several. IndexedDB iteration order is not recency, so even at
 * 1:1 the "first" was arbitrary; it just never had a sibling to be wrong about.
 */
function buildLocalChatIndex(chats: ChatHistoryItem[]): Map<string, LocalChatRef[]> {
  const byProject = new Map<string, LocalChatRef[]>();

  for (const chat of chats) {
    const pid = chat.metadata?.projectId;

    if (!pid) {
      continue;
    }

    const refs = byProject.get(pid) ?? [];
    refs.push({ urlId: chat.urlId, id: chat.id, timestamp: chat.timestamp });
    byProject.set(pid, refs);
  }

  for (const refs of byProject.values()) {
    refs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  }

  return byProject;
}

export function ProjectsDashboard() {
  const navigate = useNavigate();
  const { entries } = useGameRegistry();

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [localChats, setLocalChats] = useState<Map<string, LocalChatRef[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /** templateId → friendly game-type title ("gm_racing_v1" → "Arcade Racing"). */
  const templateTitles = useMemo(() => {
    const map = new Map<string, string>();

    for (const entry of entries) {
      map.set(entry.id, entry.title);
    }

    return map;
  }, [entries]);

  const load = useCallback(async () => {
    setError(null);

    try {
      const [serverProjects, chats] = await Promise.all([
        listProjects(),
        db ? getAll(db) : Promise.resolve([] as ChatHistoryItem[]),
      ]);

      // Newest activity first — the project you touched last is the one you probably want.
      serverProjects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

      setProjects(serverProjects);

      /*
       * The GRID is already safe — `listProjects` is `requireUser` → `listByUser` server-side, so it
       * only ever returns this account's projects. This index is the other half: it resolves "Open"
       * to a `/chat/:urlId` out of the shared IndexedDB, and an unfiltered one would hand this user a
       * chat id belonging to whoever else uses the browser. Scoped for the same reason the sidebar is
       * (`local-owner.ts`); a project with no chat of the viewer's own falls through to the fresh
       * mount, which is the correct answer and already the common one across devices.
       */
      setLocalChats(buildLocalChatIndex(filterOwnedRecords(chats, localViewer())));
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 401) {
        setNeedsAuth(true);
        setProjects([]);

        return;
      }

      setError(err instanceof Error ? err.message : 'Could not load your projects.');
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Manual refresh — same load as mount; spins the icon while the server round-trip is in flight. */
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
  }, [load]);

  /**
   * Go to the builder for a project — as an SPA transition, or as a real page load when this tab is
   * already holding another project's sandbox.
   *
   * 🔴 ONE TAB, ONE SANDBOX CONNECTION. The seam hands every store a single `Promise<SandboxProvider>`
   * captured in their constructors (`filesStore`, `previewsStore`, the terminals), so there is no way
   * to re-point them at a second VM mid-page: an SPA navigate to project B would mount B's files
   * through A's connection, into A's filesystem. `bootForProject` refuses that outright — but a
   * refusal the user meets as an error is a worse answer than simply reloading, which is cheap next to
   * the VM resume it precedes and leaves every module-level store honestly fresh for the new project
   * (the class of bug §4.5.6 kept rediscovering: state that survives an SPA navigate).
   *
   * The baton lives in `sessionStorage`, which survives a page load, so `setPendingOpenProject` above
   * still reaches the builder either way.
   */
  const openBuilder = useCallback(
    (to: string, targetProjectId: string) => {
      const booted = bootedProjectId();

      if (booted && booted !== targetProjectId) {
        window.location.href = to;
        return;
      }

      navigate(to);
    },
    [navigate],
  );

  const openProject = useCallback(
    (project: Project) => {
      const [mostRecent] = localChats.get(project.id) ?? [];

      if (mostRecent?.urlId) {
        // The conversation lives in this browser — reopen it exactly where it was left.
        openBuilder(`/chat/${mostRecent.urlId}`, project.id);
        return;
      }

      /*
       * No local chat (another device, or a remix left before its first message persisted): mount the
       * project's files fresh through the same baton a remix uses, and let the builder pull the most
       * recent conversation back from the server.
       */
      setPendingOpenProject(project.id, 'latest');
      openBuilder('/', project.id);
    },
    [localChats, openBuilder],
  );

  /**
   * New chat, same game (§4.5.6).
   *
   * Mounts the project's files and starts an empty conversation. The existing chats are untouched —
   * this is a fresh context on the same game, not a replacement for what came before.
   */
  const newChatOnProject = useCallback(
    (project: Project) => {
      setPendingOpenProject(project.id, 'fresh');
      openBuilder('/', project.id);
    },
    [openBuilder],
  );

  const remixProject = useCallback(
    async (project: Project) => {
      setBusyId(project.id);

      try {
        /*
         * Send this browser's copy of the project (§4.5.4b).
         *
         * Duplicating one of my own projects has nothing on the server to copy: the platform holds no
         * files, and this project's repo (if it even has one) is private and belongs to me. The only
         * copy is the checkpoint in this browser — so the dashboard hands it over.
         *
         * `undefined` when this browser has never seen the project (made on another device). The
         * server then falls back to the published seed if there is one; a duplicate that comes out
         * empty is honest in that case, because we genuinely have nothing to copy from here.
         */
        const local = db ? await readCurrentLocalSnapshot(db, project.id) : undefined;

        const response = await fetch('/api/remix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ projectId: project.id, files: local?.files }),
        });

        const data = (await response.json()) as { projectId?: string; message?: string };

        if (response.ok && data.projectId) {
          setPendingRemix(data.projectId);

          /*
           * Through `openBuilder`, not a bare navigate: a dashboard reached by SPA from the builder
           * still holds that project's sandbox, and mounting the clone through it is exactly the
           * cross-connection `bootForProject` refuses. `openBuilder` decides SPA vs page load.
           */
          openBuilder('/', data.projectId);
          toast.success('Project remixed');

          return;
        }

        toast.error(data.message ?? 'Failed to remix project');
      } catch {
        toast.error('Failed to remix project');
      } finally {
        setBusyId(null);
      }
    },
    [openBuilder],
  );

  const doDelete = useCallback(
    async (project: Project) => {
      setConfirmDelete(null);
      setBusyId(project.id);

      try {
        await deleteProject(project.id);

        /*
         * Keep the sidebar in sync: drop EVERY local chat for this project, not just one (§4.5.6).
         * The server sweeps its whole prefix; a browser that dropped only the first would leave the
         * siblings in the sidebar, pointing at a project that no longer exists.
         */
        const chats = localChats.get(project.id) ?? [];
        const database = db;

        if (database) {
          await Promise.all(chats.map((chat) => deleteById(database, chat.id).catch(() => undefined)));
        }

        setProjects((prev) => (prev ? prev.filter((p) => p.id !== project.id) : prev));
        toast.success('Project deleted');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete project');
      } finally {
        setBusyId(null);
      }
    },
    [localChats],
  );

  const startRename = useCallback((project: Project) => {
    setRenamingId(project.id);
    setRenameValue(project.name);
  }, []);

  const commitRename = useCallback(
    async (project: Project) => {
      const name = renameValue.trim();

      setRenamingId(null);

      if (!name || name === project.name) {
        return;
      }

      // Optimistic: reflect the new name immediately, roll back on failure.
      setProjects((prev) => (prev ? prev.map((p) => (p.id === project.id ? { ...p, name } : p)) : prev));

      try {
        await renameProject(project.id, name);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to rename project');
        setProjects((prev) =>
          prev ? prev.map((p) => (p.id === project.id ? { ...p, name: project.name } : p)) : prev,
        );
      }
    },
    [renameValue],
  );

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-bolt-elements-textPrimary">Your Projects</h1>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="flex items-center rounded-md p-1.5 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2 transition-colors disabled:opacity-60"
              title="Refresh the project list"
              aria-label="Refresh the project list"
            >
              <span className={classNames('i-ph:arrows-clockwise h-4 w-4', { 'animate-spin': refreshing })} />
            </button>
          </div>
          <p className="text-bolt-elements-textSecondary mt-1">
            Every game you have built. Open one to keep working, or start something new.
          </p>
        </div>
        <a
          href="/"
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-accent-500 hover:bg-bolt-elements-button-primary-backgroundHover"
        >
          <span className="i-ph:plus-circle" /> New Project
        </a>
      </div>

      {projects === null ? (
        <div className="mt-16 flex items-center justify-center text-bolt-elements-textSecondary gap-2">
          <span className="i-svg-spinners:90-ring-with-bg" /> Loading your projects…
        </div>
      ) : needsAuth ? (
        <div className="mt-16 text-center text-bolt-elements-textSecondary">Sign in to see your projects.</div>
      ) : error ? (
        <div className="mt-16 text-center">
          <p className="text-bolt-elements-textSecondary">{error}</p>
          <button
            onClick={load}
            className="mt-3 px-4 py-2 rounded-lg text-sm border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3"
          >
            Try again
          </button>
        </div>
      ) : projects.length === 0 ? (
        <div className="mt-16 text-center text-bolt-elements-textSecondary">
          No projects yet. Click <span className="text-bolt-elements-textPrimary">New Project</span> to build your first
          game.
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {projects.map((project) => {
            const typeTitle = templateTitles.get(project.templateId);
            const isBusy = busyId === project.id;

            return (
              <div
                key={project.id}
                className={classNames(
                  'rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 overflow-hidden flex flex-col transition-opacity',
                  { 'opacity-60 pointer-events-none': isBusy },
                )}
              >
                <div className="p-4 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    {renamingId === project.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(project)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitRename(project);
                          } else if (e.key === 'Escape') {
                            setRenamingId(null);
                          }
                        }}
                        className="flex-1 bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary rounded-md px-2 py-1 text-sm border border-bolt-elements-borderColor focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                      />
                    ) : (
                      <button
                        onClick={() => openProject(project)}
                        className="text-left text-lg font-medium text-bolt-elements-textPrimary truncate hover:text-accent"
                        title={project.name}
                      >
                        {project.name}
                      </button>
                    )}
                  </div>

                  <div className="flex items-center flex-wrap gap-2 mt-2 text-xs text-bolt-elements-textSecondary">
                    {typeTitle && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-3">
                        <span className="i-ph:game-controller" /> {typeTitle}
                      </span>
                    )}
                    {project.shareId && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">
                        <span className="i-ph:globe-simple" /> Shared
                      </span>
                    )}
                    {/*
                     * Where this project is saved (§4.5.4b).
                     *
                     * 🔴 This badge ALWAYS renders. It used to appear only when `linkedRepo` was set —
                     * so the state worth warning about (this game exists in one browser and nowhere
                     * else) was the one state the dashboard said nothing at all about, and silence
                     * reads as "fine".
                     */}
                    {(() => {
                      const badge = describeProjectSaveBadge(project);

                      return (
                        <span
                          title={badge.detail}
                          className={classNames(
                            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full',
                            badge.tone === 'warning'
                              ? 'bg-amber-500/10 text-amber-400'
                              : 'bg-bolt-elements-background-depth-3',
                          )}
                        >
                          <span
                            className={classNames(
                              badge.tone === 'warning'
                                ? 'i-ph:warning-circle'
                                : project.provider === 'gitlab'
                                  ? 'i-ph:gitlab-logo-simple'
                                  : 'i-ph:github-logo',
                            )}
                          />{' '}
                          {badge.label}
                        </span>
                      );
                    })()}
                  </div>

                  <div className="mt-2 text-xs text-bolt-elements-textTertiary flex items-center gap-1.5">
                    <span>Updated {formatUpdated(project.updatedAt)}</span>

                    {/*
                     * How many conversations this game has (§4.5.6).
                     *
                     * "No chats yet" is a REAL state, not an orphan: deleting a chat never deletes the
                     * game, because for an UNLINKED project this browser holds its only copy (§4.5.4b).
                     * Without this the card gave no way to tell "I deleted its only conversation" from
                     * "something is broken" — which is exactly how it was reported.
                     *
                     * `undefined` renders NOTHING. It means we did not count, and saying "No chats yet"
                     * because a listing failed would be a lie about someone's data.
                     */}
                    {project.chatCount !== undefined && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="flex items-center gap-1">
                          <span className="i-ph:chat-teardrop-dots" />
                          {project.chatCount === 0
                            ? 'No chats yet'
                            : `${project.chatCount} chat${project.chatCount === 1 ? '' : 's'}`}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex border-t border-bolt-elements-borderColor text-sm">
                  <button
                    onClick={() => openProject(project)}
                    className="flex-1 text-center py-2.5 font-medium text-white bg-accent-500 hover:bg-bolt-elements-button-primary-backgroundHover flex items-center justify-center gap-1.5"
                  >
                    <span className="i-ph:arrow-square-out" /> Open
                  </button>
                  {/* `shareUrl` is server-minted (`toWireProject`) — the browser cannot know `SHARE_DOMAIN`. */}
                  {project.shareUrl && (
                    <a
                      href={project.shareUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-2.5 text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 flex items-center justify-center border-l border-bolt-elements-borderColor"
                      title="Play the shared build"
                    >
                      <span className="i-ph:play" />
                    </a>
                  )}
                  <button
                    onClick={() => newChatOnProject(project)}
                    className="px-3 py-2.5 text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 flex items-center justify-center border-l border-bolt-elements-borderColor"
                    title="New chat, same game — a fresh context on this project"
                  >
                    <span className="i-ph:chat-teardrop-dots" />
                  </button>
                  <button
                    onClick={() => remixProject(project)}
                    className="px-3 py-2.5 text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 flex items-center justify-center border-l border-bolt-elements-borderColor"
                    title="Remix into a new project"
                  >
                    <span className="i-ph:git-fork" />
                  </button>
                  <button
                    onClick={() => startRename(project)}
                    className="px-3 py-2.5 text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 flex items-center justify-center border-l border-bolt-elements-borderColor"
                    title="Rename"
                  >
                    <span className="i-ph:pencil-simple" />
                  </button>
                  <button
                    onClick={() => setConfirmDelete(project)}
                    className="px-3 py-2.5 text-bolt-elements-textPrimary hover:text-red-500 hover:bg-bolt-elements-background-depth-3 flex items-center justify-center border-l border-bolt-elements-borderColor"
                    title="Delete"
                  >
                    <span className="i-ph:trash" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/*
       * 🔴 Structured to MATCH the Delete Chat dialog exactly (owner, 2026-08-03: "the project delete
       * dialog does not look as good as the delete chat dialog").
       *
       * `Dialog` supplies no padding of its own, and this one only padded its BUTTON ROW — so the title
       * and the sentence sat flush against the panel edge while the chat dialog next door had a padded
       * body and a separated footer. Two dialogs asking the same question in the same product, drawn
       * differently, because each was styled on its own. The body/footer split is what makes the footer
       * read as actions rather than as more text, and the destructive action needs that separation most.
       */}
      <DialogRoot open={confirmDelete !== null}>
        <Dialog onClose={() => setConfirmDelete(null)}>
          <div className="p-6 bg-white dark:bg-gray-950">
            <DialogTitle className="text-gray-900 dark:text-white">Delete Project?</DialogTitle>
            <DialogDescription className="mt-2 text-gray-600 dark:text-gray-400">
              <p>
                You are about to delete{' '}
                <span className="font-medium text-gray-900 dark:text-white">{confirmDelete?.name}</span>
              </p>
              <p className="mt-2">
                Its saved checkpoints will be permanently removed. Are you sure you want to delete this project?
              </p>
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
            <DialogButton type="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </DialogButton>
            <DialogButton type="danger" onClick={() => confirmDelete && doDelete(confirmDelete)}>
              Delete
            </DialogButton>
          </div>
        </Dialog>
      </DialogRoot>
    </main>
  );
}

/** A resilient relative timestamp — never throw a page over a malformed date string. */
function formatUpdated(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return 'recently';
  }
}

export default ProjectsDashboard;
