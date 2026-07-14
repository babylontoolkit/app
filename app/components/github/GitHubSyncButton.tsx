/**
 * GitHub Sync — the header entry point and dialog (SPEC §4.13). AVAILABLE TO ALL USERS.
 *
 * A sync bridge, not a git client: one linked repo+branch per project, push/pull, and — when the
 * remote has moved — the two-button divergence choice (never a merge). All the git work happens on the
 * server via the Git Data API; this UI just drives it and mounts what a pull returns.
 *
 * The user's GitHub token comes from the inherited connector (the `githubConnectionStore`); we pass it
 * in the request body so the server can act as the user against their own repo. Before a push we take a
 * fresh checkpoint of the current WebContainer files, so what lands in the repo is what is on screen —
 * not whatever the last auto-snapshot happened to capture.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { Dialog, DialogRoot, DialogTitle, DialogDescription, DialogButton } from '~/components/ui/Dialog';
import { isGitHubConnected, githubConnectionStore } from '~/lib/stores/githubConnection';
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
  const connected = useStore(isGitHubConnected);
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [linkedRepo, setLinkedRepo] = useState<string | undefined>();
  const [linkedBranch, setLinkedBranch] = useState<string | undefined>();
  const [diverged, setDiverged] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load the project's link state once.
  if (!loaded) {
    setLoaded(true);
    getProject(projectId)
      .then((p) => {
        setLinkedRepo(p.linkedRepo);
        setLinkedBranch(p.linkedBranch);
      })
      .catch(() => undefined);
  }

  const token = () => githubConnectionStore.get().token;

  const call = async (body: Record<string, unknown>): Promise<SyncResponse> => {
    const response = await fetch(`/api/projects/${projectId}/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, token: token() }),
    });

    return (await response.json()) as SyncResponse;
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
        toast.error(result.message ?? 'Could not link the repository.');
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
        toast.error(result.message ?? 'Push failed.');
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
        toast.error(result.message ?? 'Sync failed.');
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

          {!connected ? (
            <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
              Connect your GitHub account in Settings → Connections first, then reopen this.
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
