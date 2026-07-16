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
import { getProject, createSnapshot } from '~/lib/persistence/projects';
import { workbenchStore } from '~/lib/stores/workbench';
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

  const push = async () => {
    setBusy(true);

    try {
      // Checkpoint the current files first, so the push reflects what is on screen.
      const files = await workbenchStore.serializeFiles();
      await createSnapshot(projectId, { files, label: 'Before GitHub push' });

      const result = await call({ op: 'push' });

      if (result.ok) {
        toast.success('Pushed to GitHub.');
        setDiverged(false);
      } else if (result.divergence) {
        setDiverged(true);
      } else {
        reportFailure(result, 'Push failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const pull = async (op: 'pull' | 'resolve', choice?: string) => {
    setBusy(true);

    try {
      const result = await call(choice ? { op, choice } : { op });

      if (result.ok && result.files) {
        await workbenchStore.restoreFiles(result.files);
        toast.success('Synced from GitHub.');
        setDiverged(false);
      } else if (result.ok && result.branch) {
        toast.success(`Pushed your changes to a new branch: ${result.branch}`);
        setDiverged(false);
      } else {
        reportFailure(result, 'Sync failed.');
      }
    } finally {
      setBusy(false);
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
