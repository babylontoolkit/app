/**
 * Replace the project's whole working tree with a branch's, as ONE narrated operation (§4.13a).
 *
 * Every door that swaps the tree calls this — switch, discard, and (T18) pull and divergence-resolve —
 * so they cannot drift into three behaviours. That is not tidiness: `recordAgentWrite`/
 * `#recordRestoredFiles`, `prepareMountedProject`/`mountedThisLoad` and clone/pull are all cases in
 * this codebase where one half of a pair was guarded and the other was not, with a comment asserting
 * they matched. A tree replacement has seven steps that must all happen, and "the pull door forgot
 * step 4" has no symptom.
 *
 * ## The order, and what each step costs when it is skipped
 *
 *  1. Raise the phase, so the workspace is COVERED for the whole operation.
 *  2. A **strict** before-checkpoint — the only copy of what is about to be destroyed.
 *  3. Restore, with `protectForRepoRestore`.
 *  4. Invalidate the per-tree state the replacement made false (T12).
 *  5. Checkpoint the result, `markSynced`, `unsavedWork: false`.
 *  6. Write the server working copy under that checkpoint's seq.
 *  7. Reinstall and restart.
 *
 * 🔴 **And every one of them sits inside a `try` whose `finally` calls `endBootPhase()` — on the
 * success path, the throw path and the abort path. That `finally` is the entire licence for covering
 * the workspace.** `bootProgress` is ONE SLOT; a phase raised with nothing guaranteed to bring it
 * down is the 2026-08-03 hang, reported as *"it just sits on this spinning screen"*, over a project
 * that was mounted and working perfectly well.
 *
 * 🔴 **It must never call `mountProjectFiles`.** Reusing the mount is the obvious-looking refactor and
 * it silently NO-OPS the switch twice over: `mountedThisLoad` short-circuits a project already mounted
 * this page load, and `decideLiveSandboxIsTruth` returns `true` for `local`/`diverged`/`working`, which
 * makes the mount call `refreshFiles()` instead of restoring. The user would press Switch, watch a
 * splash, and end up on the same branch with a different label. A source-level assertion pins this.
 */
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { bootProgress, endBootPhase } from '~/lib/stores/boot-progress';
import { protectForRepoRestore } from './restore-plan';
import { runCheckpointSerialize } from './checkpoint-run';
import { waitForWorkbenchActionsSettled } from './workbench-settle';
import { createLocalSnapshot, markSynced } from './local-snapshots';
import { writeWorkingCopyFromStore } from './working-copy-writer';
import { markTreeReplaced } from './tree-replacement-signal';
import { unsavedWork } from './useChatHistory';
import { repoStatus } from './repo-status';
import { ensureRunnableNow } from './useChatHistory';
import { createScopedLogger } from '~/utils/logger';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const logger = createScopedLogger('apply-branch-tree');

export interface ApplyBranchTreeInput {
  projectId: string;

  /** The tree to write. Already normalised at the fetch boundary (`normalizeRepoFileMap`). */
  files: SerializedFileMap;

  /** The branch these files came from — narrated, and stamped on the working copy (T17). */
  branch: string;

  /** Which door this is. Decides the phase and the checkpoint's label; nothing else. */
  operation: 'switch' | 'discard' | 'pull';

  /** IndexedDB handle for the local checkpoints. Absent = this browser has no local history. */
  db?: IDBDatabase;
}

export type ApplyBranchTreeResult =
  | {
      ok: true;

      /** The seq of the BEFORE checkpoint — what an undo restores. Absent when there is no `db`. */
      undoSeq?: number;

      /** True when the project is over budget and only the LOCAL copy was written (edge case 12). */
      serverCopySkipped: boolean;
    }
  | { ok: false; reason: string };

/**
 * The phase each door raises while it reads and writes.
 *
 * ⚠️ EXPORTED, because the phase has to go up BEFORE the caller's network read (owner, 2026-08-22).
 * Reported as *"once I select switch branch it takes quite a few seconds where it is doing nothing and
 * not displaying a splash screen"* — this phase's own doc says it covers "reading the target branch
 * from the provider, before a byte of the workspace has changed", and it never did: the only writer
 * was `applyBranchTree`, which the caller reaches only AFTER awaiting that read. So the surface
 * described as covering the read went up once the read had finished. The caller raises it now and this
 * module re-asserts the identical value, so there is still exactly one rule deciding which phase a
 * given operation shows.
 *
 * ⚠️ THREE CASES, not a two-arm ternary. This routed `pull` to `switching-branch`, so a Sync or a
 * divergence-resolve announced "Switching to trunk" full-screen for thirty seconds to a user who was
 * already on trunk and had pressed neither switch nor branch. It is the fourth of four strings that
 * vary by operation and the last to be given a case — and the only one on a surface the user cannot
 * look away from.
 */
export function phaseFor(operation: ApplyBranchTreeInput['operation'], branch: string) {
  switch (operation) {
    case 'discard':
      return { step: 'discarding', branch } as const;
    case 'pull':
      return { step: 'pulling', branch } as const;
    default:
      return { step: 'switching-branch', branch } as const;
  }
}

function labelFor(operation: ApplyBranchTreeInput['operation'], branch: string): string {
  switch (operation) {
    case 'discard':
      return `Before discarding changes on ${branch}`;
    case 'pull':
      return `Before pulling ${branch}`;
    default:
      return `Before switching to ${branch}`;
  }
}

/**
 * What the LANDED checkpoint is called — the entry the user reads in the §4.12 undo list.
 *
 * ⚠️ This was a two-arm ternary that sent `pull` to the switch wording, so after T18 converged the
 * doors a Pull wrote an undo entry reading "Switched to trunk" for an operation the user performed as
 * *use the version from my repository*. The hand-rolled code this replaced said "Pulled from GitHub",
 * so the convergence would have LOST that.
 *
 * It is the third of three strings that vary by operation, and the only one that had not been given
 * the same shape — which is the whole reason it is a `switch` beside its two siblings now rather than
 * a condition inline at the call site. A label that names the wrong operation is the same defect as a
 * refusal that does (`spec/fail-loud.md`), one surface further along: the user looking for the thing
 * to undo cannot find it, because it is filed under something they never did.
 */
function landedLabelFor(operation: ApplyBranchTreeInput['operation'], branch: string): string {
  switch (operation) {
    case 'discard':
      return `Discarded — restored ${branch}`;
    case 'pull':
      return `Updated from ${branch}`;
    default:
      return `Switched to ${branch}`;
  }
}

/**
 * What to say when it went wrong — NAMING THE OPERATION THE USER ACTUALLY PERFORMED.
 *
 * ⚠️ This was one hardcoded "Could not finish switching to…" for all three doors, so a failed DISCARD
 * told the user it could not finish switching to a branch they had not asked to move to. That is the
 * same defect as `RateLimitedError` defaulting every bucket to "repository imports", and
 * `spec/fail-loud.md` treats a refusal that names the wrong operation as the same class as one that
 * names no cause: the user cannot act on it, so they conclude the button is broken.
 */
function failureFor(operation: ApplyBranchTreeInput['operation'], branch: string): string {
  switch (operation) {
    case 'discard':
      return `Could not finish discarding your changes on ${branch}`;
    case 'pull':
      return `Could not finish pulling ${branch}`;
    default:
      return `Could not finish switching to ${branch}`;
  }
}

export async function applyBranchTree(input: ApplyBranchTreeInput): Promise<ApplyBranchTreeResult> {
  const { projectId, files, branch, operation, db } = input;

  /*
   * 🔴 THE REFUSAL THAT PROTECTS THE RESTORE. `planRestore` declines an empty incoming map by design
   * ("a restore is never a wipe"), so handing one through would restore nothing, delete nothing, and
   * report success — the operation silently not happening while the UI says it did. Refused here,
   * with a sentence, BEFORE the phase goes up, so there is no cover to take down.
   */
  if (Object.keys(files).length === 0) {
    return { ok: false, reason: `Nothing was read from ${branch}, so the project was left as it is.` };
  }

  let undoSeq: number | undefined;

  try {
    bootProgress.set(phaseFor(operation, branch));

    /*
     * 🔴 STEP 2 — A STRICT SERIALIZE, unlike every existing before-overwrite checkpoint in this
     * codebase (`Messages.client.tsx`, `GitHubSyncButton.tsx`, `SaveDivergenceDialog.client.tsx` all
     * use the lax one while restoring with a repo map).
     *
     * `serializeFileMap` OMITS a binary it cannot read. That is right for a map you are going to
     * inspect or ship, and wrong for the ONLY COPY of what is about to be destroyed: a checkpoint
     * written while `havok.wasm` was unreadable restores a project with no physics engine, and the
     * user finds out when they press undo — the one moment they have no other option left.
     *
     * A failed serialize ABORTS the operation and writes nothing. Refusing to switch is recoverable;
     * switching without a way back is not.
     */
    if (db) {
      const photo = await runCheckpointSerialize({
        serialize: () => workbenchStore.serializeFiles({ strict: true }),
        waitForWrites: waitForWorkbenchActionsSettled,
      });

      if (photo.kind !== 'ok') {
        return {
          ok: false,
          reason:
            `Could not save a checkpoint of your current files (${photo.reason}), so nothing was changed. ` +
            'Try again in a moment.',
        };
      }

      const snapshot = await createLocalSnapshot(db, {
        projectId,
        files: photo.files,
        label: labelFor(operation, branch),
      });

      undoSeq = snapshot.seq;
    }

    /*
     * 🔴 STEP 3 — `protectForRepoRestore`, NEVER `protectNothing`.
     *
     * A repo map has no `.env`: `isSecretPath` kept the whole family out of every push. So their
     * absence says "never sent", not "deleted", and `protectNothing` here deletes the user's API
     * keys — the one class of file on disk with no other copy anywhere, and not remotely what they
     * asked for.
     *
     * The progress bar is free: `restoreFiles` already takes `onProgress`, and `BootScreen` draws its
     * bar only for the `files` phase.
     */
    await workbenchStore.restoreFiles(files, {
      protect: protectForRepoRestore,
      onProgress: (done, total) => bootProgress.set({ step: 'files', done, total }),
    });

    /*
     * STEP 4 — the per-tree state the replacement just made false (T12). Both are silent when missed:
     * stale baselines make every later `type="edit"` a diff against a tree that no longer exists, and
     * a retained deleted-path set suppresses files that are on disk — including the ones this
     * restore's OWN deletion pass just recorded.
     */
    workbenchStore.resetAllFileModifications();
    workbenchStore.clearDeletedPaths();

    /*
     * 🔴 STEP 5 — the full post-mount triple, exactly as `mountFromRepo` performs it.
     *
     * Skipping `markSynced` leaves `localSeq > syncedSeq`, so the chip reports unsaved work on a tree
     * that is byte-identical to the branch it was just read from — the one message guaranteed to make
     * a user press the destructive button a second time.
     */
    let seq: number | undefined;

    if (db) {
      const landed = await createLocalSnapshot(db, {
        projectId,
        files,
        label: landedLabelFor(operation, branch),
      });
      seq = landed.seq;

      await markSynced(db, projectId);
    }

    unsavedWork.set(false);

    /*
     * 🔴 STEP 6 — `writeWorkingCopyFromStore`, NOT `refreshSavedCopiesSoon`.
     *
     * That helper is the TOP-UP mechanism: it writes a `kind: 'top-up'` checkpoint labelled "Unsaved
     * changes" and ends with `unsavedWork.set(true)` — contradicting step 5 one line above it, on a
     * tree that has nothing unsaved. §4.5.4c invariant 4 says every trigger writes BOTH copies; it
     * does not say "call the top-up helper".
     *
     * An over-budget project keeps its LOCAL checkpoint and skips only the server copy — and SAYS so,
     * because a recovery capability that is quietly off is the degraded-capability-reports-ON failure
     * (`spec/fail-loud.md` rule 2).
     */
    let serverCopySkipped = false;

    if (seq !== undefined) {
      /*
       * ⚠️ THE BRANCH STAMP, AND ONLY ON A SWITCH.
       *
       * `writeWorkingCopyFromStore` reads the stamp from `repoStatus` (§4.13a T17, so no writer can
       * forget it), and after a SWITCH that store has not yet been refreshed from the server — so a
       * copy written at this instant would carry the branch the user just left. A copy stamped with
       * the wrong branch is worse than an unstamped one: `workingCopyRanks` would refuse a copy that
       * is in fact correct, silently turning crash recovery off.
       *
       * 🔴 A DISCARD AND A PULL CHANGE NO BRANCH, so they must not touch it. That is not a
       * micro-optimisation — those two doors accept a DISPLAY string for `branch` and fall back to
       * human sentences when the name is unknown ("the linked branch", "your repository"). Writing
       * one of those into `repoStatus` would put a sentence into the field the working-copy stamp and
       * every branch comparison read, i.e. a machine field holding prose. Narrow (a complete §4.5.4b
       * link tuple should always give a real name) and exactly the kind of narrow that is true until
       * it is not.
       */
      if (operation === 'switch') {
        repoStatus.set({ ...(repoStatus.get() ?? { linked: true }), branch });
      }

      const written = await writeWorkingCopyFromStore(projectId, seq);
      serverCopySkipped = written === 'skipped-too-large';

      if (serverCopySkipped) {
        toast.warn(
          'This project is too large for crash recovery on our servers. Your local checkpoints still ' +
            'cover it, and committing to your repository is unaffected.',
        );
      }
    }

    /*
     * 🔴 STEP 8 (emitted here, before the install, so a failed install cannot lose it) — tell the
     * §4.2.8 request invariant that this tree replacement was DELIBERATE.
     *
     * INV-3(b) flags a manifest that shrinks sharply within one chat, which is precisely the shape of
     * a legitimate switch — 90 files to 60, every single time. Emitted ONCE, by this module, for the
     * same reason every other step lives here: three doors emitting it separately is the drift this
     * module exists to prevent.
     */
    markTreeReplaced(projectId);

    /*
     * 🔴 STEP 7 — reinstall and restart, AWAITED, via the entry point built for exactly this
     * (`ensureRunnableNow`). The mount's `ensureRunnableOnce` resolves immediately by design, so
     * calling it here would take the splash down at the moment the 30 seconds begins — passing every
     * test while destroying the reason the install is unconditional in the first place.
     *
     * An install PROBLEM is not a failed switch: the tree landed, the checkpoints are written, the
     * pointer is correct. It is logged and surfaced by `ensureProjectRunnable`'s own `onProblem`
     * reporting, and the operation still reports success — refusing here would tell the user their
     * branch did not switch when it did.
     */
    try {
      await ensureRunnableNow(projectId, {
        /*
         * 🔴 RESTART, not "ensure runnable" (owner, 2026-08-22).
         *
         * Without this the very first line of `ensureProjectRunnable` returns `already-running` — the
         * previous branch's dev server is still up — so this step did NOTHING on a switch: no install,
         * no restart. The user was left with a Vite process serving the module graph of the branch
         * they had just left, and the only cures were a full page reload or a manual Ctrl-C plus
         * `npm run dev`, which is exactly how it was reported.
         *
         * ⚠️ It also means the T18 convergence never actually converged: the owner accepted a 30-second
         * narrated install on every Pull, and that install has been skipped every time a dev server
         * was running — which is every time.
         */
        restart: true,
        onStep: (step) => {
          if (step === 'installing') {
            bootProgress.set({ step: 'branch-install' });
          } else if (step === 'starting') {
            bootProgress.set({ step: 'branch-serve' });
          }
        },
      });
    } catch (error) {
      logger.error(`Could not restart the project after ${operation} on ${branch}`, error);
    }

    /*
     * 🔴 STEP 9 — RELOAD THE PREVIEW, or the user is looking at the branch they just left.
     *
     * Reported 2026-08-22: *"when I switched the branch the preview did not work — I had to actually
     * RELOAD the page."* Nothing here had ever asked. Vite's HMR is driven by module invalidation, and
     * this operation invalidates nothing it can see: the files are written straight to the sandbox FS,
     * `public/` assets change without a module graph edit, and the dev server is reinstalled and
     * restarted underneath the running document. The iframe holds a page built from the old branch and
     * a dead HMR socket, and only a manual reload clears it.
     *
     * AFTER the install, and outside its `try`: before it would reload into a server that is about to
     * restart, and skipping it when the install failed would leave the stale document on screen in the
     * one case the user most needs to see what actually landed. The tree is on disk either way.
     */
    try {
      workbenchStore.refreshPreviews();
    } catch (error) {
      /*
       * ⚠️ A COSMETIC STEP MAY NEVER FAIL THE OPERATION — the same rule the reinstall above follows,
       * and its own spec caught this: the first draft ran unguarded, so a preview layer that could not
       * answer turned a switch whose tree had already landed, checkpointed and repointed into
       * `ok: false`. The user would be told their branch did not switch when it did, and would press
       * the button again.
       */
      logger.error(`Could not reload the preview after ${operation} on ${branch}`, error);
    }

    return { ok: true, undoSeq, serverCopySkipped };
  } catch (error) {
    /*
     * 🔴 A FAILURE UNCOVERS AND HANDS THE CALLER A SENTENCE — it does NOT call `reportBootFailure`,
     * and the absence of that call is the point.
     *
     * This used to. Three doc comments (two of them in the callers) then claimed the user was shown a
     * "failure panel with a retry", and a review checked by RENDERING instead of reading: there is no
     * such panel on this path. `shouldCoverWorkspace` returns `false` for `failed`, so
     * `WorkspaceSplash` returns `null`; `BootFailurePanel` is reachable only through `BootScreen`,
     * which renders only in the `!ready` branch — and a branch operation always runs with `ready`
     * true. `reportBootFailure` was also passed no retry function, so `bootRetry` was `undefined` and
     * the button would not have worked if it had rendered.
     *
     * It was worse than merely absent: `endBootPhase` deliberately refuses to clear `failed`, so the
     * phase was pinned there forever with nothing drawing it — and `shouldCoverWorkspace` checks
     * `failed` BEFORE `importActive`, so a later folder or repo import in the same session would have
     * run uncovered.
     *
     * So the honest surface is the caller's: the `finally` returns the phase to `idle` (uncovering the
     * workspace, which is usable — the tree either landed or was left alone), and `reason` carries a
     * sentence that NAMES THE OPERATION AND THE BRANCH. It used to be the bare error message, so a
     * failed Pull reported "sandbox connection closed" and nothing else — the wrong/no-operation
     * defect `failureFor` exists to prevent, arriving through the one path that skipped it.
     */
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Branch ${operation} failed for ${projectId}`, error);

    return { ok: false, reason: `${failureFor(operation, branch)}: ${message}` };
  } finally {
    /*
     * 🔴 THE `finally` THAT LICENSES THE COVER. Success, throw, abort — all three, and it does real
     * work on every one of them.
     *
     * ⚠️ This comment used to say the throw path was already on `failed` and that `endBootPhase`
     * would decline to clear it — i.e. that the `finally` was a no-op there. That stopped being true
     * when the `catch` above stopped calling `reportBootFailure`, and it was the load-bearing half:
     * nothing draws `failed` on this path, so a phase left there covers the workspace forever and
     * blocks a later import's overlay too. Deleting this line now fails the throw-path test as well
     * as the other two.
     */
    endBootPhase();
  }
}
