/**
 * The branch operations, as a HOOK rather than a menu item's closure (§4.13a).
 *
 * 🔴 **A hook because more than one surface performs these.** Three call sites drifting into three
 * meanings of "switch branch" is the two-Syncs bug wearing different clothes (§4.1a) — and here the
 * drift would not be a confusing label, it would be two code paths replacing the user's whole working
 * tree with different amounts of care.
 *
 * ⚠️ **Today there is exactly ONE consumer** — the chip's Branch submenu. This comment used to say the
 * sync dialog's branch field was "the second on day one", which was a plan, not a fact:
 * `GitHubSyncButton` still owns its own `useState('main')` link-time field and does not import this.
 * Stated accurately, because a comment that describes an intended second caller reads as evidence the
 * shape is already earning its keep. It is not yet; the argument for it is the drift above, and that
 * argument stands on its own.
 *
 * Every action is: ask the SERVER → run the DECISION CORE → apply through the ONE apply path. None of
 * the three steps is optional and none is re-implemented here:
 *
 *   - the server owns the tuple write and the ingest guard (`api.projects.$projectId.github`);
 *   - `decideBranchSwitch` / `decideDiscard` / `decideBranchDelete` own "may this happen, and what
 *     does it do to the files" — pure, exhaustively tested, and in the same category as
 *     `restore-target.ts` for the same reason;
 *   - `applyBranchTree` owns the seven-step tree replacement.
 *
 * This module is the WIRING between them, and it deliberately contains no rule of its own.
 */
import { useCallback, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { projectId as projectIdStore } from '~/lib/persistence';
import { streamingState } from '~/lib/stores/streaming';
import { db, repoStatus, unsavedWork } from './useChatHistory';
import { applyBranchTree, phaseFor } from './apply-branch-tree';
import { decideBranchSwitch } from './branch-switch';
import { decideDiscard } from './discard';
import { branchDeleteAvailability, decideBranchDelete } from './branch-delete';
import { bootProgress, endBootPhase } from '~/lib/stores/boot-progress';
import {
  createBranch,
  deleteBranch,
  discardChanges,
  listBranches,
  listCommits,
  readBranchTree,
  switchBranch,
  type BranchSummary,
  type CommitSummary,
} from './projects';
import { compareTrees, type TreeDiff } from './tree-diff';
import { workbenchStore } from '~/lib/stores/workbench';
import { saveState as saveStateStore } from './save-queue';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('branch-actions');

/** What the caller must answer before a destructive switch can proceed. */
export type SwitchPrompt = { branch: string; reason: string };

/** One page of history, plus the cursor that fetches the next. */
export interface HistoryPage {
  commits: CommitSummary[];
  nextCursor?: string;
}

export interface BranchActions {
  /** The project's branches, or `undefined` while they have never been fetched. */
  branches?: BranchSummary[];

  /** True while the list is being read. The menu shows this rather than an empty list — see below. */
  loadingBranches: boolean;

  /** True while an operation is running. Every action refuses to start a second one. */
  busy: boolean;

  /**
   * Fetch the branch list. Called when the MENU OPENS, not on mount.
   *
   * 🔴 An empty list and an unfetched list are different things, and rendering them the same way says
   * "this repository has no branches" about a repository the user has branches in. The caller renders
   * `loadingBranches` instead.
   */
  refreshBranches: () => Promise<void>;

  /**
   * Switch to an existing branch. Returns a PROMPT when the user must answer first.
   *
   * The three-way choice (commit / discard and switch / cancel) is `decideBranchSwitch`'s, and it is
   * returned rather than resolved here because only the caller can render it — this hook must not own
   * a dialog, or the sync dialog's field would inherit the chip's.
   */
  switchTo: (branch: string) => Promise<SwitchPrompt | undefined>;

  /** Switch, having already answered the prompt by discarding. */
  switchDiscardingChanges: (branch: string) => Promise<void>;

  /** Create a branch from where the user is standing. Touches NO file — the work carries over. */
  create: (name: string) => Promise<{ ok: boolean; nameTaken?: boolean; message?: string }>;

  /** Throw away every uncommitted change and go back to the branch head. */
  discard: () => Promise<void>;

  /** Delete a branch in the user's repository. The one operation here with no undo. */
  remove: (name: string) => Promise<{ ok: boolean; message?: string }>;

  /**
   * What a commit would contain — the sandbox tree compared against the branch's.
   *
   * 🔴 Reads through the `tree` op, which deliberately does NOT move `lastSyncedCommitSha`: looking at
   * a branch is not agreeing with it. Reviewing changes must never be able to make the project claim
   * it is up to date with a commit it never applied.
   */
  review: () => Promise<TreeDiff | undefined>;

  /** One bounded page of the branch's history. `cursor` continues a previous page. */
  history: (cursor?: string) => Promise<HistoryPage | undefined>;
}

export function useBranchActions(): BranchActions {
  const projectId = useStore(projectIdStore);
  const repo = useStore(repoStatus);
  const hasUnsaved = useStore(unsavedWork);

  /*
   * The save queue's state, read from its own store rather than through `useSaveProject`. The switch
   * and discard decisions refuse while a push is in flight (`SaveQueue` has no cancel, so a queued
   * push would commit the NEW branch's files under the old turn's summary) — and that is a fact about
   * the queue, not about the header's view of it.
   */
  const saveState = useStore(saveStateStore);
  const streaming = useStore(streamingState);

  const [branches, setBranches] = useState<BranchSummary[] | undefined>();
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshBranches = useCallback(async () => {
    if (!projectId) {
      return;
    }

    setLoadingBranches(true);

    try {
      const outcome = await listBranches(projectId);

      if (outcome.ok) {
        setBranches(outcome.branches ?? []);
      } else {
        // LOUD. A list that silently failed to load is indistinguishable from a repo with no branches.
        toast.error(outcome.message ?? 'Could not read the branches.');
      }
    } finally {
      setLoadingBranches(false);
    }
  }, [projectId]);

  /**
   * The facts every decision core needs. Assembled once so the three actions cannot disagree about
   * what "unsaved work" or "busy" means — which is the kind of disagreement that shows up as one
   * button warning the user and another not.
   */
  const facts = {
    currentBranch: repo?.branch ?? '',
    unsavedWork: hasUnsaved,
    saveStatus: saveState.status,

    /*
     * 🔴 §4.12 — a generation owns the tree while it runs, and this is the CLIENT half of that.
     *
     * The server is the wall (`isProjectClaimed` refuses the route, T1), so leaving this unwired was
     * not a data-loss hole — it was a dead courtesy layer: both decision cores declare the refusal and
     * nothing supplied the fact, so the user pressed Switch, waited for a round trip, and got an error
     * where they should have got an immediate sentence. A refusal that arrives late reads as a bug in
     * the button rather than as the state it reflects.
     */
    generationInFlight: streaming,
  };

  /** Read the tree and hand it to the ONE apply path. Shared by switch and discard. */
  const apply = useCallback(
    async (
      pid: string,
      read: () => Promise<{
        ok: boolean;
        files?: import('~/lib/binary/binary-files').SerializedFileMap;
        branch?: string;
        message?: string;
      }>,
      operation: 'switch' | 'discard',
      fallbackBranch: string,
    ) => {
      /*
       * 🔴 THE SPLASH GOES UP BEFORE THE NETWORK READ (owner, 2026-08-22).
       *
       * Reported as *"once I select switch branch it takes quite a few seconds where it is doing
       * nothing and not displaying a splash screen."* Reading a branch tree from the provider is a
       * multi-second round trip, and the only writer of these phases was `applyBranchTree` — which
       * this function reaches only after awaiting that read. So the phase whose own doc says it covers
       * "reading the target branch from the provider, before a byte of the workspace has changed" went
       * up at the moment the read FINISHED, and the user pressed a menu item into silence.
       *
       * `phaseFor` is shared with `applyBranchTree` rather than re-derived here: three operations show
       * three different sentences on a full-page surface, and a second copy of that mapping is how a
       * Pull comes to announce "Switching to trunk" (`spec/fail-loud.md`'s wrong-operation defect on
       * the largest surface the product has).
       */
      bootProgress.set(phaseFor(operation, fallbackBranch));

      const outcome = await read();

      if (!outcome.ok || !outcome.files) {
        /*
         * ⚠️ UNCOVER on the read's own failure paths. `applyBranchTree`'s `finally` is what normally
         * brings this down, and these two returns never reach it — leaving a full-page splash over a
         * workspace with nothing running, which `endBootPhase` cannot clear later because nothing else
         * would call it.
         */
        endBootPhase();
        toast.error(outcome.message ?? 'Could not read that branch.', { autoClose: false });

        return;
      }

      const applied = await applyBranchTree({
        projectId: pid,
        files: outcome.files,
        branch: outcome.branch ?? fallbackBranch,
        operation,
        db,
      });

      if (!applied.ok) {
        /*
         * Persistent, for `applyBranchTree`'s reason: there is no failure panel on this path, so this
         * toast is the whole report — and `reason` names the operation and the branch.
         */
        toast.error(applied.reason, { autoClose: false });

        return;
      }

      toast.success(operation === 'discard' ? 'Your changes were discarded.' : `You are now on ${outcome.branch}.`);
    },
    [],
  );

  const switchTo = useCallback<BranchActions['switchTo']>(
    async (branch) => {
      if (!projectId || busy) {
        return undefined;
      }

      const plan = decideBranchSwitch({ ...facts, targetBranch: branch });

      if (plan.action === 'noop') {
        toast.info(plan.reason);
        return undefined;
      }

      if (plan.action === 'refuse') {
        toast.error(plan.reason);
        return undefined;
      }

      if (plan.action === 'confirm') {
        // The caller renders the three-way choice. Nothing has happened yet.
        return { branch, reason: plan.reason };
      }

      setBusy(true);

      try {
        await apply(projectId, () => switchBranch(projectId, branch), 'switch', branch);
      } finally {
        setBusy(false);
      }

      return undefined;
    },

    /*
     * ⚠️ `facts.generationInFlight` IS IN HERE, and its absence was a real defect rather than a lint
     * nit. Every other fact is settled before the hook renders; a generation STARTS AFTERWARDS, which
     * is the only sequence that occurs in the product. Omitted, the callback stayed closed over
     * `false` and went straight to the network — so the §4.12 refusal this hook advertises was still
     * a dead courtesy layer, and the block of tests asserting it could not see that because they set
     * the stream BEFORE rendering.
     */
    [projectId, busy, facts.currentBranch, facts.unsavedWork, facts.saveStatus, facts.generationInFlight, apply],
  );

  /**
   * The "discard them and switch" answer.
   *
   * ⚠️ It does NOT discard and then switch — that would be two tree replacements, two installs and a
   * pointless intermediate state. The switch already replaces every file with the target branch's, so
   * discarding is exactly what NOT keeping the local ones means. The user's work is still recoverable
   * from the strict before-checkpoint `applyBranchTree` takes.
   */
  const switchDiscardingChanges = useCallback<BranchActions['switchDiscardingChanges']>(
    async (branch) => {
      if (!projectId || busy) {
        return;
      }

      setBusy(true);

      try {
        await apply(projectId, () => switchBranch(projectId, branch), 'switch', branch);
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, apply],
  );

  const create = useCallback<BranchActions['create']>(
    async (name) => {
      if (!projectId || busy) {
        /*
         * ⚠️ NAMES THE CAUSE. This returned a bare `{ ok: false }`, so the dialog fell back to its
         * generic "Could not create that branch." — a refusal with no reason, on the one path where
         * the reason is known and the fix is "wait a moment". `spec/fail-loud.md`'s rule, on a
         * two-line early return.
         */
        return {
          ok: false,
          message: busy ? 'Another branch operation is still running. Try again in a moment.' : undefined,
        };
      }

      setBusy(true);

      try {
        const outcome = await createBranch(projectId, name);

        if (!outcome.ok) {
          return { ok: false, nameTaken: outcome.kind === 'name-taken', message: outcome.message };
        }

        /*
         * 🔴 NO FILE IS TOUCHED, and that is the whole feature — the in-progress work carries onto the
         * new branch. The pointer moved server-side, so the local view of it must follow or the chip
         * keeps naming the branch the user just left.
         */
        repoStatus.set({ ...(repoStatus.get() ?? { linked: true }), branch: name });
        await refreshBranches();
        toast.success(`Created ${name}. Your changes came with you.`);

        return { ok: true };
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, refreshBranches],
  );

  const discard = useCallback<BranchActions['discard']>(async () => {
    if (!projectId || busy) {
      return;
    }

    const plan = decideDiscard({ linked: repo?.linked === true, ...facts });

    if (plan.action === 'noop') {
      toast.info(plan.reason);
      return;
    }

    if (plan.action === 'refuse') {
      toast.error(plan.reason);
      return;
    }

    setBusy(true);

    try {
      await apply(projectId, () => discardChanges(projectId), 'discard', repo?.branch ?? 'your branch');
    } finally {
      setBusy(false);
    }

    // `generationInFlight` included for `switchTo`'s reason — a generation starts after this renders.
  }, [
    projectId,
    busy,
    repo?.linked,
    repo?.branch,
    facts.currentBranch,
    facts.unsavedWork,
    facts.saveStatus,
    facts.generationInFlight,
    apply,
  ]);

  const remove = useCallback<BranchActions['remove']>(
    async (name) => {
      if (!projectId || busy) {
        // Names its cause, for `create`'s reason.
        return {
          ok: false,
          message: busy ? 'Another branch operation is still running. Try again in a moment.' : undefined,
        };
      }

      /*
       * The feature switch, ahead of the per-branch rules (`branch-delete.ts`, owner 2026-08-22).
       * The route refuses identically and is the wall that matters; this one keeps a caller that
       * reaches the hook some other way from making a pointless round trip.
       */
      const availability = branchDeleteAvailability();

      if (!availability.ok) {
        return { ok: false, message: availability.reason };
      }

      /*
       * The client-side refusal is a COURTESY — it dims and explains before a round trip. The server
       * re-derives it (`branch-ops.ts`) and its answer is the authoritative one, which is why the
       * default branch here comes from the fetched list rather than from a guess.
       */
      const plan = decideBranchDelete({
        name,
        currentBranch: repo?.branch ?? '',
        defaultBranch: branches?.find((b) => b.isDefault)?.name,
      });

      if (!plan.ok) {
        return { ok: false, message: plan.reason };
      }

      setBusy(true);

      try {
        const outcome = await deleteBranch(projectId, name);

        if (outcome.ok) {
          await refreshBranches();
          toast.success(`Deleted ${name}.`);
        }

        return { ok: outcome.ok, message: outcome.message };
      } finally {
        setBusy(false);
      }
    },
    [projectId, busy, repo?.branch, branches, refreshBranches],
  );

  /**
   * "What am I about to publish?" (§4.13a — Review changes.)
   *
   * 🔴 The comparison is `compareTrees`, and the BYTES for a local binary come from the sandbox
   * (`readBinaryFile`) — never from `File.content`, which is always empty when `isBinary`. Without the
   * reader, same-sized binaries are reported unchanged, so the file class most likely to have changed
   * after an asset generation is the one class the review could never see.
   *
   * ⚠️ Those bytes are ON LOAN. `compareTrees` only hashes them and takes no ownership; a future
   * change that wants to keep or post them must copy first.
   */
  const review = useCallback<BranchActions['review']>(async () => {
    if (!projectId) {
      return undefined;
    }

    const outcome = await readBranchTree(projectId);

    if (!outcome.ok || !outcome.files) {
      toast.error(outcome.message ?? 'Could not read the branch to compare against.');
      return undefined;
    }

    return compareTrees(workbenchStore.files.get(), outcome.files, {
      readLocalBytes: (path) => workbenchStore.readBinaryFile(path),
    });
  }, [projectId]);

  const history = useCallback<BranchActions['history']>(
    async (cursor) => {
      if (!projectId) {
        return undefined;
      }

      const outcome = await listCommits(projectId, { cursor });

      if (!outcome.ok) {
        toast.error(outcome.message ?? 'Could not read the history.');
        return undefined;
      }

      return { commits: outcome.commits ?? [], nextCursor: outcome.nextCursor };
    },
    [projectId],
  );

  logger.debug(`branch actions ready for ${projectId ?? 'no project'}`);

  return {
    review,
    history,
    branches,
    loadingBranches,
    busy,
    refreshBranches,
    switchTo,
    switchDiscardingChanges,
    create,
    discard,
    remove,
  };
}
