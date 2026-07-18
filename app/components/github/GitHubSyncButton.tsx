/**
 * GitHub Sync — the header entry point and dialog (SPEC §4.13). AVAILABLE TO ALL USERS.
 *
 * A sync bridge, not a git client: one linked repo+branch per project, push/pull, and — when the
 * remote has moved — the two-button divergence choice (never a merge). All the git work happens on the
 * server via the Git Data API; this UI just drives it and mounts what a pull returns.
 *
 * 🔴 **The client no longer holds or sends the token (§4.5.4b).** This dialog used to read a raw PAT
 * out of the inherited `githubConnectionStore` (localStorage) and put it in the request body on every
 * op. The server now resolves the token itself from its encrypted per-user store, so the browser never
 * sees it. When the server says `reconnect`, we send the user through the platform's OAuth flow rather
 * than asking them to paste a token anywhere.
 *
 * Before a push we take a fresh checkpoint of the current WebContainer files, so what lands in the repo
 * is what is on screen — not whatever the last auto-snapshot happened to capture.
 */
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { Dialog, DialogRoot, DialogTitle, DialogDescription, DialogButton } from '~/components/ui/Dialog';
import { projectId as projectIdStore } from '~/lib/persistence';
import { db } from '~/lib/persistence/useChatHistory';
import { createLocalSnapshot } from '~/lib/persistence/local-snapshots';
import { getProject } from '~/lib/persistence/projects';
import { workbenchStore } from '~/lib/stores/workbench';
import { protectForRepoRestore } from '~/lib/persistence/restore-plan';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

interface SyncResponse {
  ok?: boolean;
  divergence?: boolean;
  files?: SerializedFileMap;
  linkedRepo?: string;
  linkedBranch?: string;
  commitSha?: string;
  branch?: string;
  message?: string;

  /** The server could not authenticate to the provider — send the user through OAuth again. */
  reconnect?: boolean;
}

/**
 * Hand the user to the platform's OAuth flow, returning them to this exact page afterwards.
 *
 * The connect path is now IN this dialog. Sending the user to "Settings → Connections" to paste a
 * personal access token was the old token model's UI, and that token no longer exists (§4.5.4b) — one
 * button, standard OAuth, back where they started.
 *
 * The dialog also distinguishes three states the old one collapsed into one: still loading (never flash
 * "connect first" at a connected user), the OPERATOR has no OAuth app configured ("not set up on this
 * server" — nothing the user can do), and the USER has not connected (actionable).
 */
function startConnect(provider: 'github' | 'gitlab' = 'github') {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/git/connect/${provider}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function GitHubSyncButton() {
  const [open, setOpen] = useState(false);
  const activeProjectId = useStore(projectIdStore);

  if (!activeProjectId) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2"
        title="Sync with GitHub"
      >
        <div className="i-ph:git-branch" />
        <span>GitHub</span>
      </button>
      {open && <GitHubSyncDialog projectId={activeProjectId} onClose={() => setOpen(false)} />}
    </>
  );
}

function GitHubSyncDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [linkedRepo, setLinkedRepo] = useState<string | undefined>();
  const [linkedBranch, setLinkedBranch] = useState<string | undefined>();
  const [diverged, setDiverged] = useState(false);

  /**
   * Connection state comes from the SERVER now (§4.5.4b), not from `githubConnectionStore` in
   * localStorage — the browser no longer holds the token, so it is no longer the authority on whether
   * one exists. `undefined` = still loading; we must not flash "connect first" at an already-connected
   * user.
   */
  const [connected, setConnected] = useState<boolean | undefined>();
  const [configured, setConfigured] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      /*
       * Load the link state and the connection state together. Both were previously fetched during
       * RENDER with a silent `.catch(() => undefined)`, so a transient failure left an already-linked
       * project showing the "link a repo" form — offering to relink something already linked.
       */
      const [project, connections] = await Promise.all([
        getProject(projectId).catch(() => null),
        fetch('/api/git/connections')
          .then((r) =>
            r.ok ? (r.json() as Promise<{ configured: string[]; connections: Array<{ provider: string }> }>) : null,
          )
          .catch(() => null),
      ]);

      if (cancelled) {
        return;
      }

      if (project) {
        setLinkedRepo(project.linkedRepo);
        setLinkedBranch(project.linkedBranch);
      } else {
        toast.error('Could not load this project’s save settings. Close and try again.');
      }

      if (connections) {
        setConfigured(connections.configured.includes('github'));
        setConnected(connections.connections.some((c) => c.provider === 'github'));
      } else {
        setConnected(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * One call to the sync route. No token — the server holds it (§4.5.4b).
   *
   * This used to `response.json()` unconditionally, so a 500 returning an HTML error page threw inside
   * the caller's `try` with no catch: the spinner stopped and the user was told nothing at all. A save
   * path may not fail quietly, so a non-JSON or non-OK response becomes a real message.
   */
  const call = async (body: Record<string, unknown>): Promise<SyncResponse> => {
    let response: Response;

    try {
      response = await fetch(`/api/projects/${projectId}/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, message: 'Could not reach the server. Check your connection and try again.' };
    }

    const payload = (await response.json().catch(() => null)) as SyncResponse | null;

    if (!payload) {
      return { ok: false, message: `The server returned an unexpected error (${response.status}).` };
    }

    return payload;
  };

  /** Every failure path funnels through here, so none of them can end in silence. */
  const reportFailure = (result: SyncResponse, fallback: string) => {
    if (result.reconnect) {
      toast.error('Your GitHub connection expired. Reconnecting…');
      startConnect('github');

      return;
    }

    toast.error(result.message ?? fallback);
  };

  const link = async () => {
    if (!repo.includes('/')) {
      toast.error('Enter the repo as owner/name.');
      return;
    }

    setBusy(true);

    try {
      const result = await call({ op: 'link', repo, branch });

      if (result.ok) {
        setLinkedRepo(repo);
        setLinkedBranch(branch);
        toast.success('Linked. You can now push and pull.');
      } else {
        reportFailure(result, 'Could not link the repository.');
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Push what is on screen.
   *
   * The files travel in the request body (§4.5.4b). This used to `createSnapshot(...)` first and let
   * the server read the project back out of our own storage — which only worked while we kept a copy
   * of every project, the exact thing repo-primary removes. The browser holds the only copy, so the
   * browser is what sends it.
   */
  const push = async () => {
    setBusy(true);

    try {
      const files = await workbenchStore.serializeFiles();
      const result = await call({ op: 'push', files });

      if (result.ok) {
        toast.success('Saved To GitHub.');
        setDiverged(false);
      } else if (result.divergence) {
        setDiverged(true);
      } else {
        reportFailure(result, 'Could not save to GitHub.');
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Bring the repo's version down, or push to a new branch when the two have diverged.
   *
   * The checkpoint before an overwrite happens HERE now (§4.12, §4.5.4b). The server used to take it,
   * back when it held the files; it holds none, so the only party that can checkpoint the state about
   * to be replaced is the one that has it. It is taken before `restoreFiles`, never after — the point
   * is to capture what is being overwritten.
   */
  const pull = async (op: 'pull' | 'resolve', choice?: string) => {
    setBusy(true);

    try {
      const body: Record<string, unknown> = choice ? { op, choice } : { op };

      // Pushing to a new branch sends the local work; pulling sends nothing.
      if (choice === 'push-to-new-branch') {
        body.files = await workbenchStore.serializeFiles();
      }

      const result = await call(body);

      if (result.ok && result.files) {
        await checkpointBeforeOverwrite();
        await workbenchStore.restoreFiles(result.files, { protect: protectForRepoRestore });
        await snapshotLocally(result.files, 'Pulled from GitHub');
        toast.success('Updated from GitHub.');
        setDiverged(false);
      } else if (result.ok && result.branch) {
        toast.success(`Saved your changes to a new branch: ${result.branch}`);
        setDiverged(false);
      } else {
        reportFailure(result, 'Could not sync with GitHub.');
      }
    } finally {
      setBusy(false);
    }
  };

  /** Capture what is about to be replaced, so any regret is one restore away (§4.12). */
  const checkpointBeforeOverwrite = async () => {
    await snapshotLocally(await workbenchStore.serializeFiles(), 'Before updating from GitHub');
  };

  const snapshotLocally = async (files: SerializedFileMap, label: string) => {
    if (!db) {
      return;
    }

    try {
      await createLocalSnapshot(db, { projectId, files, label });
    } catch (error) {
      // Not fatal to the sync itself, but never silent — this is the user's undo.
      toast.warn(`Could not save a local checkpoint: ${(error as Error).message}`);
    }
  };

  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <Dialog className="!max-w-lg !w-[90vw]" onClose={onClose}>
        <div className="p-6 flex flex-col gap-4">
          <div>
            <DialogTitle>GitHub Sync</DialogTitle>
            <DialogDescription>
              Keep this project in a GitHub repo. Push your changes up, or pull changes you made locally.
            </DialogDescription>
          </div>

          {connected === undefined ? (
            <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
              Checking your GitHub connection…
            </div>
          ) : !configured ? (
            <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
              Saving to GitHub is not set up on this server yet.
            </div>
          ) : !connected ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
                Connect your GitHub account to keep this project safe in your own repository. You stay the owner — we
                only ever write to the repo you choose.
              </div>
              <DialogButton type="primary" onClick={() => startConnect('github')}>
                Connect GitHub
              </DialogButton>
            </div>
          ) : !linkedRepo ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm text-bolt-elements-textSecondary">
                Repository (owner/name)
                <input
                  className="px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="my-org/my-game"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-bolt-elements-textSecondary">
                Branch
                <input
                  className="px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
              <div className="flex justify-end">
                <DialogButton type="primary" onClick={link} disabled={busy}>
                  {busy ? 'Linking…' : 'Link repository'}
                </DialogButton>
              </div>
            </div>
          ) : diverged ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                The repo has changed since you last synced. Choose how to resolve — we never merge automatically.
              </div>
              <div className="flex flex-col gap-2">
                <DialogButton type="secondary" onClick={() => pull('resolve', 'pull-overwrite')} disabled={busy}>
                  Pull (overwrite this project — a checkpoint is saved first)
                </DialogButton>
                <DialogButton type="secondary" onClick={() => pull('resolve', 'push-to-new-branch')} disabled={busy}>
                  Push my changes to a new branch instead
                </DialogButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-bolt-elements-textSecondary">
                Linked to <span className="text-bolt-elements-textPrimary font-medium">{linkedRepo}</span>
                {linkedBranch ? ` (${linkedBranch})` : ''}.
              </div>
              <div className="flex gap-2 justify-end">
                <DialogButton type="secondary" onClick={() => pull('pull')} disabled={busy}>
                  {busy ? 'Working…' : 'Sync from GitHub'}
                </DialogButton>
                <DialogButton type="primary" onClick={push} disabled={busy}>
                  {busy ? 'Working…' : 'Push to GitHub'}
                </DialogButton>
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </DialogRoot>
  );
}
