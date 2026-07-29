/**
 * One project — read, rename, delete (SPEC §4.5.3, §4.5.5).
 *
 * Every method here goes through `requireOwnedProject`. That is not boilerplate: `projectId` comes
 * straight out of the URL, so it is a value the caller chooses.
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { requireOwnedProject } from '~/lib/.server/projects/ownership';
import { getProjectStore } from '~/lib/.server/projects/store';
import { toWireProject } from '~/lib/.server/projects/wire';
import { deleteMessages } from '~/lib/.server/projects/message-store';
import { deleteRemixSeed } from '~/lib/.server/share/seed-store';
import { deleteWorkingCopy } from '~/lib/.server/projects/working-copy';
import { deleteSandbox } from '~/lib/.server/sandbox/service';
import { refundProjectCreate } from '~/lib/.server/billing/project-create-service';
import { getMonitor } from '~/lib/.server/monitoring';
import { errorResponse } from '~/lib/.server/http';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.projects.$projectId');

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    return json({ project: toWireProject(project) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);
    const store = getProjectStore(context);

    if (request.method === 'DELETE') {
      /*
       * Bytes first, row second — every time.
       *
       * The project id is the ONLY handle on this user's bytes: the seed and the conversation are both
       * stored at keys derived from it. Delete the row first and a failure here strands them with
       * nothing left that can name them — invisible, un-deletable, and (for the chat) still ours after
       * the user pressed Delete believing it gone. Losing bytes whose project survives is recoverable;
       * the reverse is not.
       *
       * 🔴 The MESSAGES delete is not tidiness. It did not exist: `DELETE /api/projects/:id` removed
       * the row and left `messages/{projectId}.json` behind forever, because the key was private to the
       * messages route and nothing else could address it. "Delete my project" left the conversation on
       * our servers.
       *
       * Both are unconditional: deleting an absent object is a no-op, and asking a hint first
       * (`remixSeedAt`) leaves the bytes behind on any disagreement between hint and storage.
       */
      await deleteRemixSeed(project.id, context);
      await deleteMessages(project.id, context);

      /*
       * The working copy (§4.5.4c) — the platform's recovery buffer for this project's files. Same
       * unconditional rule as the two above: bytes must never outlive the record that named them, and
       * it holds the user's whole game, so leaving it behind is the worst version of that orphan.
       */
      await deleteWorkingCopy(project.id, context);

      /*
       * The project's VM (migration 0013). Same orphan rule as the bytes above, with money attached:
       * the sandbox id lives ONLY on this row, so deleting the row without reaping the VM leaves a
       * machine that bills by the second and that no panel we have can name. That is the exact
       * "bytes outliving the record that named them" failure the rest of this branch exists to
       * prevent — the legacy per-user registry produced a fleet of them, which is what
       * `scripts/sweep-legacy-sandboxes.mjs` is for.
       *
       * Best-effort, per `deleteSandbox`'s own contract: a provider outage must not make a project
       * undeletable, and the user pressed Delete. But NOT swallowed — an orphan is a bill nobody
       * sees, so the failure is logged AND monitored (§5A) rather than caught into silence.
       */
      if (project.sandboxId) {
        try {
          await deleteSandbox(project.sandboxId, context, { userId: user.id, projectId: project.id });
        } catch (error) {
          logger.warn(
            `Could not delete sandbox ${project.sandboxId} for project ${project.id}: ${(error as Error)?.message}`,
          );
          getMonitor(context).captureException(error, {
            scope: 'sandbox.delete-project',
            userId: user.id,
            tags: { projectId: project.id, sandboxId: project.sandboxId },
          });
        }
      }

      /*
       * The flat creation charge comes BACK if this project never delivered a build (§4.4a, migration
       * 0015) — i.e. it never had a generation the user was actually charged for. That is the observable
       * definition of "creation did not deliver", and it correctly declines to refund someone who built
       * a game and then deleted it.
       *
       * On the SERVER's delete path deliberately, not the client's `rollbackRegisteredProject`: that one
       * is fire-and-forget and never rejects, so a refund hung off it is a refund that can silently not
       * happen.
       *
       * 🔴 AFTER `store.delete`, never before. A refund written first is paid again on every retry of a
       * FAILED delete — and a failed delete leaves the card in place, so retrying is exactly what the
       * user does next. Ordering it here means the money only moves once the project is actually gone,
       * and `requireOwnedProject` then 404s the retry before it can reach this line. Two CONCURRENT
       * deletes still race past that, so uniqueness is enforced structurally by migration 0015's partial
       * unique index — the ordering and the index close different holes, so keep both.
       */
      await store.delete(project.id);

      await refundProjectCreate({ userId: user.id, projectId: project.id, context });

      return json({ ok: true });
    }

    /*
     * Rename only.
     *
     * `linkedRepo`/`linkedBranch` used to be settable here, one field at a time. Under §4.5.4b that is
     * no longer a pointer to a sync convenience — it is the address of the only permanent copy of the
     * user's game, and it is only meaningful together with a `provider` (migration 0006's
     * `projects_link_complete_check` refuses a half-set). Linking is a real operation with an OAuth
     * token, a repo that must exist, and a push; it lives at `/api/projects/:id/github`. A patch route
     * that could point a project at any string was a way to make a project claim it was saved
     * somewhere it had never written a byte.
     */
    const body = await request.json<{ name?: string }>();

    const updated = await store.update(project.id, {
      ...(body.name !== undefined ? { name: body.name.slice(0, 120) } : {}),
    });

    return json({ project: toWireProject(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}
