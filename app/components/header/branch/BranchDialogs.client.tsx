/**
 * The Branch submenu's dialogs (§4.13a, §4.1a).
 *
 * All four follow the HOUSE destructive pattern (`ProjectsDashboard.client.tsx`): a padded body, a
 * separated footer, `DialogButton type="danger"` for anything that destroys. Deliberately NOT the
 * inherited `ConfirmationDialog`, whose only consumer is a settings tab — two dialogs asking the same
 * question in the same product, drawn differently, is the defect that pattern was written to fix.
 *
 * 🔴 **The two DESTRUCTIVE warnings come from `describeBranchState`, never from a literal here** —
 * the sentence that names the branch a discard resets to, and the one that says a deleted branch
 * cannot be brought back. Both depend on being testable without rendering a component, and both are
 * reachable by the git-jargon sweep in `save-status.spec.ts`, which can only cover words it can reach.
 *
 * ⚠️ **This comment used to claim EVERY sentence here comes from that function, and that is not true**
 * — the dialog titles, the two list placeholders ("Reading your branches…", "This repository has no
 * branches yet."), the `disabledFor` reasons and the switch dialog's own preview are literals in this
 * file. Stated accurately rather than aspirationally, because a false claim in a comment is how the
 * untested literal beside it survives review. Anything that describes STATE or warns about
 * destruction belongs in the describe-function; a button's own label does not.
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogRoot, DialogTitle, DialogDescription, DialogButton } from '~/components/ui/Dialog';
import type { BranchStateView } from '~/lib/persistence/save-status';
import { classNames } from '~/utils/classNames';
import type { BranchSummary, CommitSummary } from '~/lib/persistence/projects';
import type { TreeDiff, TreeChangeStatus } from '~/lib/persistence/tree-diff';

/** Above this many branches the list gets a filter — the inherited picker's own threshold. */
export const BRANCH_FILTER_THRESHOLD = 10;

const BODY = 'p-6 bg-white dark:bg-gray-950';
const FOOTER =
  'flex justify-end gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800';

/** A scrollable, optionally-filtered branch list. Shared by Switch and Delete. */
function BranchList({
  branches,
  loading,
  currentBranch,
  onPick,
  disabledFor,
}: {
  branches?: BranchSummary[];
  loading: boolean;
  currentBranch?: string;
  onPick: (name: string) => void;

  /**
   * Why this branch cannot be picked, or `undefined`. Rendered as the row's `title`.
   *
   * 🔴 Dimmed WITH A REASON, never merely absent. The server refuses the current and default branches
   * too (`branch-ops.ts`), and its answer is the authoritative one — this is the courtesy that
   * explains the refusal before a round trip. A row that is simply missing tells the user their branch
   * does not exist; a greyed row with no tooltip tells them the feature is broken.
   */
  disabledFor?: (b: BranchSummary) => string | undefined;
}) {
  const [filter, setFilter] = useState('');

  /*
   * 🔴 LOADING IS NOT EMPTY. An unfetched list rendered as an empty one says "this repository has no
   * branches" about a repository the user has branches in — and they would reasonably conclude the
   * feature is broken rather than that it has not finished.
   */
  if (loading || !branches) {
    return <div className="py-6 text-center text-sm text-bolt-elements-textSecondary">Reading your branches…</div>;
  }

  if (branches.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-bolt-elements-textSecondary">
        This repository has no branches yet.
      </div>
    );
  }

  const shown = filter ? branches.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase())) : branches;

  return (
    <div className="flex flex-col gap-2">
      {branches.length > BRANCH_FILTER_THRESHOLD && (
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a branch…"
          className="w-full px-3 py-2 text-sm rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary outline-none"
        />
      )}

      <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
        {shown.map((b) => {
          const disabledReason = disabledFor?.(b);

          return (
            <button
              key={b.name}
              type="button"
              disabled={Boolean(disabledReason)}
              title={disabledReason}
              onClick={() => onPick(b.name)}
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 disabled:opacity-40 disabled:cursor-not-allowed outline-none"
            >
              <div className="i-ph:git-branch shrink-0 opacity-70" />
              <span className="truncate">{b.name}</span>
              {b.name === currentBranch && <span className="ml-auto text-xs opacity-60">current</span>}
              {b.isDefault && b.name !== currentBranch && <span className="ml-auto text-xs opacity-60">default</span>}
            </button>
          );
        })}

        {shown.length === 0 && (
          <div className="py-4 text-center text-sm text-bolt-elements-textSecondary">No branch matches that.</div>
        )}
      </div>
    </div>
  );
}

export function SwitchBranchDialog({
  open,
  onClose,
  branches,
  loading,
  currentBranch,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  branches?: BranchSummary[];
  loading: boolean;
  currentBranch?: string;
  onPick: (name: string) => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog onClose={onClose}>
        <div className={BODY}>
          <DialogTitle>Switch branch</DialogTitle>
          <DialogDescription className="mt-2">
            Every file in the project is replaced with the version on the branch you pick. Your current files are
            checkpointed first.
          </DialogDescription>
          <div className="mt-4">
            <BranchList branches={branches} loading={loading} currentBranch={currentBranch} onPick={onPick} />
          </div>
        </div>
        <div className={FOOTER}>
          <DialogButton type="secondary" onClick={onClose}>
            Cancel
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}

/**
 * The three-way choice a switch with unsaved work must ask (§4.13, requirement 30).
 *
 * 🔴 Never a two-button "are you sure" — that is the divergence discipline: the platform does not
 * pick a winner between two versions of someone's work, so *commit first* is offered ALONGSIDE
 * *discard*, and it is offered FIRST because it is the only answer that loses nothing.
 */
export function SwitchWithChangesDialog({
  prompt,
  onCommitFirst,
  onDiscardAndSwitch,
  onCancel,
}: {
  prompt?: { branch: string; reason: string };
  onCommitFirst: () => void;
  onDiscardAndSwitch: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogRoot open={Boolean(prompt)} onOpenChange={(o) => !o && onCancel()}>
      <Dialog onClose={onCancel}>
        <div className={BODY}>
          <DialogTitle>You have changes that are not saved</DialogTitle>
          <DialogDescription className="mt-2">{prompt?.reason}</DialogDescription>
        </div>
        <div className={FOOTER}>
          <DialogButton type="secondary" onClick={onCancel}>
            Cancel
          </DialogButton>
          <DialogButton type="danger" onClick={onDiscardAndSwitch}>
            Discard them and switch
          </DialogButton>
          <DialogButton type="primary" onClick={onCommitFirst}>
            Commit my changes first
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}

export function NewBranchDialog({
  open,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<{ ok: boolean; nameTaken?: boolean; message?: string }>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setName('');
      setError(undefined);
    }
  }, [open]);

  const submit = async () => {
    const outcome = await onCreate(name.trim());

    if (outcome.ok) {
      onClose();
      return;
    }

    /*
     * 🔴 The typed name STAYS in the field on a collision. The server echoes it back and never
     * suffixes to `-2` (`ensureRepo`'s rule) — a name the user did not choose is a surprise, and an
     * editable collision must not become a dead end.
     */
    setError(outcome.message ?? 'Could not create that branch.');
  };

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog onClose={onClose}>
        <div className={BODY}>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription className="mt-2">
            Your current changes come with you — nothing is replaced, and nothing is lost.
          </DialogDescription>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && !busy && void submit()}
            placeholder="feature/boost-pads"
            className="mt-4 w-full px-3 py-2 text-sm rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary outline-none"
          />
          {error && <p className="mt-2 text-sm text-bolt-elements-icon-error">{error}</p>}
        </div>
        <div className={FOOTER}>
          <DialogButton type="secondary" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton type="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create branch'}
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}

export function DiscardChangesDialog({
  open,
  onClose,
  onConfirm,
  view,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  view: BranchStateView;
  busy: boolean;
}) {
  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog onClose={onClose}>
        <div className={BODY}>
          <DialogTitle>Discard all changes?</DialogTitle>
          {/* The sentence comes from `describeBranchState` — it names the branch and says it is undoable. */}
          <DialogDescription className="mt-2">{view.discardWarning}</DialogDescription>
        </div>
        <div className={FOOTER}>
          <DialogButton type="secondary" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton type="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Discarding…' : 'Discard changes'}
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}

export function DeleteBranchDialog({
  open,
  onClose,
  branches,
  loading,
  currentBranch,
  defaultBranch,
  onDelete,
  view,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  branches?: BranchSummary[];
  loading: boolean;
  currentBranch?: string;
  defaultBranch?: string;
  onDelete: (name: string) => Promise<{ ok: boolean; message?: string }>;
  view: BranchStateView;
  busy: boolean;
}) {
  const [picked, setPicked] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (open) {
      setPicked(undefined);
      setError(undefined);
    }
  }, [open]);

  const confirm = async () => {
    if (!picked) {
      return;
    }

    const outcome = await onDelete(picked);

    if (outcome.ok) {
      onClose();
      return;
    }

    setError(outcome.message ?? 'Could not delete that branch.');
  };

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog onClose={onClose}>
        <div className={BODY}>
          <DialogTitle>Delete a branch</DialogTitle>
          {/*
           * 🔴 The one operation here with NO UNDO, and the copy says so in `describeBranchState`. A
           * checkpoint is a snapshot of FILES and cannot restore a remote ref — a destructive dialog
           * that implies the usual safety net is worse than no dialog at all.
           */}
          <DialogDescription className="mt-2">{view.deleteWarning}</DialogDescription>

          <div className="mt-4">
            <BranchList
              branches={branches}
              loading={loading}
              currentBranch={currentBranch}
              onPick={setPicked}
              disabledFor={(b) =>
                b.name === currentBranch
                  ? 'This is the branch the project is on. Switch away from it first.'
                  : b.name === defaultBranch
                    ? "This is the repository's default branch."
                    : undefined
              }
            />
          </div>

          {picked && <p className="mt-3 text-sm text-bolt-elements-textPrimary">Delete {picked}?</p>}
          {error && <p className="mt-2 text-sm text-bolt-elements-icon-error">{error}</p>}
        </div>
        <div className={FOOTER}>
          <DialogButton type="secondary" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton type="danger" onClick={() => void confirm()} disabled={busy || !picked}>
            {busy ? 'Deleting…' : 'Delete branch'}
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}

/**
 * "What am I about to publish?" (§4.13a — Review changes.)
 *
 * The surface `compareTrees` exists for. Two things it must be honest about, both of which the
 * comparison already handles and this only has to RENDER without undoing:
 *
 *   - a **truncated** list says so, with real counts and a link to the provider's own compare view.
 *     A short list that reads as "this is everything" is the failure the cap exists to avoid;
 *   - a **binary** row shows sizes rather than offering a diff nobody can read.
 */
export function ReviewChangesDialog({
  open,
  onClose,
  load,
  branch,
  compareUrl,
}: {
  open: boolean;
  onClose: () => void;
  load: () => Promise<TreeDiff | undefined>;
  branch?: string;
  compareUrl?: string;
}) {
  const [diff, setDiff] = useState<TreeDiff | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setDiff(undefined);
      return;
    }

    setLoading(true);
    void load()
      .then(setDiff)
      .finally(() => setLoading(false));
  }, [open, load]);

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog className="!max-w-lg !w-[90vw]" onClose={onClose}>
        <div className={BODY}>
          <DialogTitle>Changes since {branch ?? 'your last commit'}</DialogTitle>
          <DialogDescription className="mt-2">
            Everything here goes up the next time you commit. Your keys and dependencies are never included.
          </DialogDescription>

          <div className="mt-4">
            {loading && <div className="py-6 text-center text-sm text-bolt-elements-textSecondary">Comparing…</div>}

            {!loading && diff && diff.changes.length === 0 && (
              <div className="py-6 text-center text-sm text-bolt-elements-textSecondary">
                Nothing has changed — this project matches {branch ?? 'its branch'}.
              </div>
            )}

            {!loading && diff && diff.changes.length > 0 && (
              <div className="max-h-72 overflow-y-auto flex flex-col gap-1">
                {diff.changes.map((change) => (
                  <div key={change.path} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    <span className={classNames('w-14 shrink-0 text-xs font-medium', STATUS_TONE[change.status])}>
                      {STATUS_LABEL[change.status]}
                    </span>
                    <span className="truncate text-bolt-elements-textPrimary">{change.path}</span>
                    {change.isBinary && (
                      <span className="ml-auto shrink-0 text-xs text-bolt-elements-textTertiary">
                        {describeBytes(change.bytes)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/*
             * 🔴 A TRUNCATED LIST SAYS SO, with honest counts. Refusing to show a list is worse than a
             * capped one that admits it is capped — but a capped one that does NOT is the worst of the
             * three, because it reads as completeness.
             */}
            {diff?.truncated && (
              <p className="mt-3 text-xs text-bolt-elements-textSecondary">
                Showing the first {diff.truncated.shown} of {diff.truncated.total} changed files.{' '}
                {compareUrl && (
                  <button type="button" className="underline" onClick={() => window.open(compareUrl, '_blank')}>
                    See them all in your repository
                  </button>
                )}
              </p>
            )}
          </div>
        </div>
        <div className={FOOTER}>
          <DialogButton type="secondary" onClick={onClose}>
            Close
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}

const STATUS_LABEL: Record<TreeChangeStatus, string> = {
  added: 'New',
  modified: 'Changed',
  deleted: 'Removed',
};

const STATUS_TONE: Record<TreeChangeStatus, string> = {
  added: 'text-green-500',
  modified: 'text-amber-500',
  deleted: 'text-bolt-elements-icon-error',
};

/** Sizes for a binary row, where a text diff would be meaningless. */
function describeBytes(bytes?: { from?: number; to?: number }): string {
  const kb = (n?: number) => (n === undefined ? '—' : `${Math.max(1, Math.round(n / 1024))} KB`);

  if (bytes?.from !== undefined && bytes?.to !== undefined) {
    return `${kb(bytes.from)} → ${kb(bytes.to)}`;
  }

  return kb(bytes?.to ?? bytes?.from);
}

/**
 * The branch's history (§4.13a).
 *
 * 🔴 SHORT MESSAGES ONLY — no diff, no file contents. An unbounded read of a large repository's
 * contents is an availability problem for everyone sharing the process (`assertFetchedTreeUsable`'s
 * lesson), and a user who wants the diff has the provider's own commit page, which each row links to.
 */
export function BranchHistoryDialog({
  open,
  onClose,
  load,
  branch,
  commitUrlFor,
}: {
  open: boolean;
  onClose: () => void;
  load: (cursor?: string) => Promise<{ commits: CommitSummary[]; nextCursor?: string } | undefined>;
  branch?: string;
  commitUrlFor?: (sha: string) => string;
}) {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const fetchPage = async (next?: string) => {
    setLoading(true);

    try {
      const page = await load(next);

      if (page) {
        // Appended, never replaced — "Load more" that replaces the list is a pager pretending to be one.
        setCommits((prev) => (next ? [...prev, ...page.commits] : page.commits));
        setCursor(page.nextCursor);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setCommits([]);
      setCursor(undefined);
      void fetchPage();
    }

    /*
     * `open` only, deliberately: the dialog resets and re-reads page one each time it is OPENED, and
     * including `fetchPage` (recreated every render) would re-fetch on every keystroke elsewhere.
     */
  }, [open]);

  return (
    <DialogRoot open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog className="!max-w-lg !w-[90vw]" onClose={onClose}>
        <div className={BODY}>
          <DialogTitle>History for {branch ?? 'this branch'}</DialogTitle>
          <DialogDescription className="mt-2">Everything committed to this branch, newest first.</DialogDescription>

          <div className="mt-4 max-h-72 overflow-y-auto flex flex-col gap-1">
            {commits.map((commit) => (
              <button
                key={commit.sha}
                type="button"
                disabled={!commitUrlFor}
                onClick={() => commitUrlFor && window.open(commitUrlFor(commit.sha), '_blank')}
                className="flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-md text-left hover:bg-bolt-elements-background-depth-3 disabled:hover:bg-transparent outline-none"
              >
                <span className="text-sm text-bolt-elements-textPrimary truncate w-full">{commit.message}</span>
                <span className="text-xs text-bolt-elements-textTertiary">
                  {commit.author} · {new Date(commit.date).toLocaleDateString()}
                </span>
              </button>
            ))}

            {loading && <div className="py-4 text-center text-sm text-bolt-elements-textSecondary">Reading…</div>}

            {!loading && commits.length === 0 && (
              <div className="py-6 text-center text-sm text-bolt-elements-textSecondary">
                Nothing has been committed to this branch yet.
              </div>
            )}
          </div>

          {cursor && !loading && (
            <button
              type="button"
              onClick={() => void fetchPage(cursor)}
              className="mt-3 text-sm underline text-bolt-elements-textSecondary"
            >
              Load more
            </button>
          )}
        </div>
        <div className={FOOTER}>
          <DialogButton type="secondary" onClick={onClose}>
            Close
          </DialogButton>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
