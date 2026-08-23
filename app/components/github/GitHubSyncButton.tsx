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
import { getProject, linkProjectToRepo } from '~/lib/persistence/projects';
import { workbenchStore } from '~/lib/stores/workbench';
import { applyBranchTree } from '~/lib/persistence/apply-branch-tree';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { PROVIDER_LABEL, type GitProvider } from '~/lib/persistence/useSaveProject';

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
function startConnect(provider: GitProvider) {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/git/connect/${provider}?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * ⚠️ **No longer in the header — the dialog is now opened from `GitStatusChip`.**
 *
 * This button was labelled "Sync" to stop it competing with the button then called "Save"; §4.5.4c
 * renamed Save to Sync and handed it that exact word, so the header showed two adjacent buttons with
 * one label and two different verbs. The fix was not a third name — it was noticing that the badge, the
 * provider picker, the push button and this dialog are four controls for ONE question ("where does my
 * game live?"), and giving them one parent. See `GitStatusChip`.
 *
 * Kept exported (hide-don't-delete) so nothing that still imports it breaks; it renders correctly if
 * mounted. Prefer the chip.
 */
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
        title="Sync a repository — pull changes, resolve divergence, or link an existing repo"
      >
        <div className="i-ph:git-branch" />
        <span>Repository</span>
      </button>
      {open && <GitHubSyncDialog projectId={activeProjectId} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * 🔴 **`provider` is a REQUIRED-BY-DEFAULT prop, not an assumption (fixed 2026-08-02).**
 *
 * This dialog hardcoded GitHub in three places at once: it posted `op: 'link'` with no `provider` (so
 * the route's legacy `github` default stood), it asked `connections.some(c => c.provider === 'github')`,
 * and it sent a lapsed connection to `startConnect('github')`. That was survivable while the dialog
 * had its own button, and stopped being so when `GitStatusChip` became the only way in: the chip
 * carries a provider radio group that can be set to GitLab and did not pass the choice down. So a user
 * with both providers connected could link a **GitLab** repo, have `github` recorded on the row, and
 * then have every later push resolve the wrong token against the wrong host — silently, since the link
 * itself succeeds.
 *
 * The check that looked like a guard was not one: `c.provider === 'github'` proves the user has a
 * GitHub CONNECTION, not that the repository they typed is on GitHub.
 */
export function GitHubSyncDialog({
  projectId,
  provider = 'github',
  onClose,
}: {
  projectId: string;
  provider?: GitProvider;
  onClose: () => void;
}) {
  const providerLabel = PROVIDER_LABEL[provider];
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
        setConfigured(connections.configured.includes(provider));
        setConnected(connections.connections.some((c) => c.provider === provider));
      } else {
        setConnected(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, provider]);

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
      toast.error(`Your ${providerLabel} connection expired. Reconnecting…`);
      startConnect(provider);

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
      /*
       * Through `linkProjectToRepo`, never an inline `call({op:'link'})` — that wrapper makes
       * `provider` a REQUIRED argument precisely so this call site cannot fall back to the route's
       * legacy `github` default and mislabel a GitLab repo. One writer for one fact (§4.5.4b).
       */
      const result = await linkProjectToRepo(projectId, { repo, branch, provider });

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
        toast.success(`Saved to ${providerLabel}.`);
        setDiverged(false);
      } else if (result.divergence) {
        setDiverged(true);
      } else {
        reportFailure(result, `Could not sync to ${providerLabel}.`);
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Bring the repo's version down, or push to a new branch when the two have diverged.
   *
   * ⚠️ The checkpoint before an overwrite is no longer taken HERE (§4.13a T18). It moved into
   * `applyBranchTree`, along with the restore itself, so that a pull, a switch and a discard cannot
   * drift into three behaviours — and it got STRICTER on the way: a lax serialize omits a binary it
   * cannot read, and this is the only copy of what is about to be replaced.
   *
   * (This comment used to say the checkpoint happens here, which stayed true right up until it did
   * not. A false claim in a doc comment is how the thing it describes survives review.)
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
        /*
         * 🔴 ONE APPLY PATH FOR EVERY TREE REPLACEMENT (§4.13a T18, Open Question 2 — converge).
         *
         * This used to be its own four lines: a NON-strict checkpoint, a restore, a second snapshot,
         * a toast. That is the same operation `applyBranchTree` performs for a switch and a discard,
         * done differently — and "one underlying operation behaves differently depending on which
         * door reached it" is the shape this codebase keeps rediscovering (`recordAgentWrite` vs
         * `#recordRestoredFiles`, `prepareMountedProject` vs `mountedThisLoad`, clone vs pull).
         *
         * What a Pull gains by converging, each of which it silently lacked:
         *   - a STRICT before-checkpoint (the lax one omits a binary it cannot read, so the undo net
         *     for the thing being overwritten could quietly be missing `havok.wasm`);
         *   - `resetAllFileModifications` + `clearDeletedPaths`, so the model is not shown baselines
         *     for a tree that no longer exists and files are not suppressed from the map;
         *   - `markSynced` + the server working copy, written together (§4.5.4c invariant 4);
         *   - the reinstall, and the narration that makes it bearable.
         *
         * ⚠️ **The honest cost, stated rather than buried: a Pull now takes 30+ seconds** instead of
         * finishing silently in two. That is an owner decision (taken 2026-08-22), not a tidiness
         * one. The argument for it is requirement 22's: a Pull that leaves `node_modules` describing
         * the PRE-pull tree is a latent broken project that fails silently and much later, where the
         * install's cost is at least visible while it happens.
         */
        /*
         * 🔴 CLOSE THE DIALOG FIRST, OR THE NARRATION NARRATES TO NOBODY.
         *
         * `WorkspaceSplash` is deliberately `z-50` (it must sit under the sidebar and header); this
         * dialog's overlay is `z-[9999]` with a backdrop blur. Awaiting with the modal still open puts
         * the whole 30-second story — "Updating from trunk", the file progress bar, the reinstall, the
         * elapsed clock — nine thousand z-index levels beneath a blurred black scrim showing two
         * buttons that read "Working…".
         *
         * That inverts this task's own justification for costing the user those seconds: the install
         * is worth doing BECAUSE its cost is visible.
         *
         * Closing here is safe because the server call has already returned the tree — the decision is
         * made, and everything that follows is local work narrated by the full-page splash. ⚠️ If it
         * FAILS there is no panel to fall back to (see the refusal branch below): the persistent toast
         * is the whole report, which is why it names the operation and does not auto-dismiss.
         */
        onClose();

        const applied = await applyBranchTree({
          projectId,
          files: result.files,
          branch: linkedBranch ?? 'the linked branch',
          operation: 'pull',
          db,
        });

        if (!applied.ok) {
          /*
           * 🔴 THE DIALOG IS GONE, SO THIS TOAST IS THE WHOLE REPORT — hence `autoClose: false`.
           *
           * There is no failure panel on this path (a comment here used to claim one; a review found
           * by rendering that `WorkspaceSplash` draws nothing for `failed` and `BootFailurePanel` is
           * reachable only from the `!ready` boot screen). At the default 5 seconds this was the
           * entire explanation for a possibly half-replaced tree, and then it was gone.
           *
           * `applied.reason` names the operation and the branch (`failureFor`), so the sentence is
           * actionable on its own: the user can press Sync again.
           */
          toast.error(applied.reason, { autoClose: false });

          return;
        }

        toast.success(`Updated from ${providerLabel}.`);
      } else if (result.ok && result.branch) {
        toast.success(`Saved your changes to a new branch: ${result.branch}`);
        setDiverged(false);
      } else {
        reportFailure(result, `Could not sync with ${providerLabel}.`);
      }
    } finally {
      setBusy(false);
    }
  };

  /*
   * 🔴 THE BEFORE-CHECKPOINT MOVED, IT DID NOT DISAPPEAR (§4.13a T18).
   *
   * This file used to own a `checkpointBeforeOverwrite` + `snapshotLocally` pair that took a
   * NON-strict `serializeFiles()` photograph before a pull replaced the tree. `applyBranchTree` now
   * takes that checkpoint, and takes it STRICT — which is the upgrade, not a side effect of tidying:
   * a lax serialize silently omits a binary it cannot read, so the undo net for the very files being
   * overwritten could be missing `havok.wasm` with nothing saying so (§4.12's poisoned-checkpoint
   * case). A strict failure ABORTS the pull instead, leaving the project untouched.
   *
   * Deleted rather than left dormant: two components taking two different checkpoints of one moment
   * is the two-writers drift this codebase keeps rediscovering, and a dead helper is how the second
   * one comes back.
   */

  return (
    <DialogRoot open onOpenChange={(o) => !o && onClose()}>
      <Dialog className="!max-w-lg !w-[90vw]" onClose={onClose}>
        <div className="p-6 flex flex-col gap-4">
          <div>
            <DialogTitle>{providerLabel} Sync</DialogTitle>
            <DialogDescription>
              Keep this project in a {providerLabel} repo. Push your changes up, or pull changes you made locally.
            </DialogDescription>
          </div>

          {connected === undefined ? (
            <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
              Checking your {providerLabel} connection…
            </div>
          ) : !configured ? (
            <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
              Saving to {providerLabel} is not set up on this server yet.
            </div>
          ) : !connected ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-bolt-elements-borderColor p-3 text-sm text-bolt-elements-textSecondary">
                Connect your {providerLabel} account to keep this project safe in your own repository. You stay the
                owner — we only ever write to the repo you choose.
              </div>
              {/*
               * 🔴 `provider`, never a literal. This button was `startConnect('github')` while the copy
               * above it and the reconnect path both followed the chosen provider — so a user in GitLab
               * mode with no GitLab connection was sent to authorise GITHUB, came back still
               * unconnected, and was shown the same screen again. A loop with no error anywhere.
               */}
              <DialogButton type="primary" onClick={() => startConnect(provider)}>
                Connect {providerLabel}
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
                  {busy ? 'Working…' : `Sync from ${providerLabel}`}
                </DialogButton>
                <DialogButton type="primary" onClick={push} disabled={busy}>
                  {busy ? 'Working…' : `Push to ${providerLabel}`}
                </DialogButton>
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </DialogRoot>
  );
}
