/**
 * "Have this turn's file actions finished landing?" — one reader, shared by every checkpoint door.
 *
 * 🔴 **One rule, one place** (`isSecretPath`'s rule, `toSandboxStoreKey`'s shape). Two call sites need
 * this — the per-generation checkpoint and `applyBranchTree`'s strict before-checkpoint — and both are
 * photographing a tree that is about to become the ONLY copy of something. A second private lambda
 * that filters the action list slightly differently is not a style problem: it is a checkpoint taken
 * mid-write, which restored with `protectNothing` DELETES every file the writer had not reached yet.
 *
 * ⚠️ `start` actions are excluded and that exclusion is load-bearing. The dev server runs for the life
 * of the project, so a settle wait that counts it is stuck-closed forever — the same trap
 * `settleableStatuses` records for the game-ready celebration, where a `running` dev server meant the
 * celebration could never fire.
 */
import { waitForActionsSettled, type ActionsSettledResult } from '~/lib/runtime/actions-settled';
import { workbenchStore } from '~/lib/stores/workbench';
import { CHECKPOINT_SETTLE_TIMEOUT_MS } from './checkpoint-run';

/** Resolve once every non-`start` action has settled, or the window expires. Never rejects. */
export function waitForWorkbenchActionsSettled(): Promise<ActionsSettledResult> {
  return waitForActionsSettled({
    readStatuses: () =>
      Object.values(workbenchStore.artifacts.get()).flatMap((artifact) =>
        Object.values(artifact.runner.actions.get())
          // The dev server (`start`) runs for the life of the project — waiting on it is the stuck-closed trap.
          .filter((action) => action.type !== 'start')
          .map((action) => action.status),
      ),
    timeoutMs: CHECKPOINT_SETTLE_TIMEOUT_MS,
  });
}
