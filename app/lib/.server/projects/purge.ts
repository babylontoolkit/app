/**
 * Deleting a project deletes everything the project named (SPEC §4.5.4b, §4.8, §5).
 *
 * Lifted VERBATIM out of `DELETE /api/projects/:id` when account deletion (§4.5.1) needed the same
 * reaper. It is one function rather than two call sites doing the same list of deletes because the
 * list is long, every entry on it exists because it was once MISSING, and the failure mode of a
 * divergence is silent: the second caller quietly leaves bytes behind and reports success. That is
 * the two-writers drift this codebase keeps rediscovering — here it would be over the user's whole
 * conversation history.
 *
 * `delete-leaves-nothing.spec.ts` drives the ROUTE and asserts the property (after a delete, storage
 * holds nothing belonging to that project), so it covers this module too.
 */
import { deleteMessages } from './message-store';
import { deleteWorkingCopy } from './working-copy';
import { getProjectStore } from './store';
import { deleteRemixSeed } from '~/lib/.server/share/seed-store';
import { unpublish } from '~/lib/.server/share/publish';
import { deleteSandbox } from '~/lib/.server/sandbox/service';
import { refundProjectCreate } from '~/lib/.server/billing/project-create-service';
import { getMonitor } from '~/lib/.server/monitoring';
import { createScopedLogger } from '~/utils/logger';
import type { Project } from './types';

const logger = createScopedLogger('projects.purge');

export interface PurgeProjectOptions {
  /** The verified owner. Already asserted by the caller — this function does NOT check ownership. */
  userId: string;

  context?: unknown;

  /**
   * Refund the flat creation charge if this project never delivered a build (§4.4a).
   *
   * True for an ordinary project delete. **False when the whole account is going**, because a refund
   * credits a ledger belonging to a user who is about to stop existing: it moves no money anybody can
   * spend, and it appends fresh rows to the financial record at the moment we are trying to close it.
   */
  refundCreation?: boolean;
}

/**
 * Reap one project: bytes first, row second, every time.
 *
 * The project id is the ONLY handle on this user's bytes — the seed, the conversation, the working
 * copy and the published build all live at keys derived from it. Delete the row first and a failure
 * here strands them with nothing left that can name them: invisible, un-deletable, and (for the chat)
 * still ours after the user pressed Delete believing it gone. Losing bytes whose project survives is
 * recoverable; the reverse is not.
 */
export async function purgeProject(project: Project, options: PurgeProjectOptions): Promise<void> {
  const { userId, context, refundCreation = true } = options;

  /*
   * 🔴 The PUBLISHED BUILD goes first, and it was missing entirely until account deletion went looking
   * for it. `unpublish` was only ever reachable from the Share dialog, so deleting a published project
   * removed the row that resolves `/play/:shareId` and left the built game — every asset, the whole
   * `dist/` — in object storage under a prefix keyed by a share id no surviving record mentions. Same
   * shape as the orphaned `messages/` payload this function's own history is about, one door along.
   *
   * It runs first because it is the only public surface here: whatever else fails afterwards, the game
   * has already stopped being servable to strangers.
   *
   * Best-effort in the same sense as the sandbox below — reported, never swallowed (`spec/fail-loud.md`).
   * `unpublish` also writes the project row, which is fine: the row is deleted further down, and a
   * failure to update it must not keep a public build alive.
   */
  if (project.shareId) {
    try {
      await unpublish(project, context);
    } catch (error) {
      logger.warn(`Could not unpublish ${project.id} (${project.shareId}): ${(error as Error)?.message}`);
      getMonitor(context).captureException(error, {
        scope: 'share.unpublish-on-delete',
        userId,
        tags: { projectId: project.id, shareId: project.shareId },
      });
    }
  }

  /*
   * 🔴 The MESSAGES delete is not tidiness. It did not exist: `DELETE /api/projects/:id` removed the
   * row and left `messages/{projectId}.json` behind forever, because the key was private to the
   * messages route and nothing else could address it. "Delete my project" left the conversation on our
   * servers.
   *
   * Both are unconditional: deleting an absent object is a no-op, and asking a hint first
   * (`remixSeedAt`) leaves the bytes behind on any disagreement between hint and storage.
   */
  await deleteRemixSeed(project.id, context);
  await deleteMessages(project.id, context);

  /*
   * The working copy (§4.5.4c) — the platform's recovery buffer for this project's files. Same
   * unconditional rule as the two above: bytes must never outlive the record that named them, and it
   * holds the user's whole game, so leaving it behind is the worst version of that orphan.
   */
  await deleteWorkingCopy(project.id, context);

  /*
   * The project's VM (migration 0013). Same orphan rule as the bytes above, with money attached: the
   * sandbox id lives ONLY on this row, so deleting the row without reaping the VM leaves a machine that
   * bills by the second and that no panel we have can name. That is the exact "bytes outliving the
   * record that named them" failure the rest of this function exists to prevent — the legacy per-user
   * registry produced a fleet of them, which is what `scripts/sweep-legacy-sandboxes.mjs` is for.
   *
   * Best-effort, per `deleteSandbox`'s own contract: a provider outage must not make a project
   * undeletable, and the user pressed Delete. But NOT swallowed — an orphan is a bill nobody sees, so
   * the failure is logged AND monitored (§5A) rather than caught into silence.
   */
  if (project.sandboxId) {
    try {
      await deleteSandbox(project.sandboxId, context, { userId, projectId: project.id });
    } catch (error) {
      logger.warn(
        `Could not delete sandbox ${project.sandboxId} for project ${project.id}: ${(error as Error)?.message}`,
      );
      getMonitor(context).captureException(error, {
        scope: 'sandbox.delete-project',
        userId,
        tags: { projectId: project.id, sandboxId: project.sandboxId },
      });
    }
  }

  /*
   * The flat creation charge comes BACK if this project never delivered a build (§4.4a, migration
   * 0015) — i.e. it never had a generation the user was actually charged for. That is the observable
   * definition of "creation did not deliver", and it correctly declines to refund someone who built a
   * game and then deleted it.
   *
   * On the SERVER's delete path deliberately, not the client's `rollbackRegisteredProject`: that one is
   * fire-and-forget and never rejects, so a refund hung off it is a refund that can silently not happen.
   *
   * 🔴 AFTER `store.delete`, never before. A refund written first is paid again on every retry of a
   * FAILED delete — and a failed delete leaves the card in place, so retrying is exactly what the user
   * does next. Ordering it here means the money only moves once the project is actually gone, and
   * `requireOwnedProject` then 404s the retry before it can reach this line. Two CONCURRENT deletes
   * still race past that, so uniqueness is enforced structurally by migration 0015's partial unique
   * index — the ordering and the index close different holes, so keep both.
   */
  await getProjectStore(context).delete(project.id);

  if (refundCreation) {
    await refundProjectCreate({ userId, projectId: project.id, context });
  }
}
