/**
 * Projects — list and create (SPEC §4.5.5).
 */
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireUser } from '~/lib/.server/supabase/auth';
import { getProjectStore } from '~/lib/.server/projects/store';
import { toWireProject } from '~/lib/.server/projects/wire';
import { countChats } from '~/lib/.server/projects/message-store';
import { errorResponse } from '~/lib/.server/http';
import { getMonitor, FUNNEL_EVENTS } from '~/lib/.server/monitoring';
import { debitProjectCreate, quoteProjectCreate } from '~/lib/.server/billing/project-create-service';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.projects');

export async function loader({ request, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);

    // Scoped to the caller. There is no "list all projects" — not even for admins, on this route.
    const projects = await getProjectStore(context).listByUser(user.id);

    /*
     * `chatCount` rides along so the dashboard can say how many conversations a project has (§4.5.6).
     *
     * A project with none is a real, deliberate state — deleting a chat never deletes the game, because
     * for an UNLINKED project the browser holds its only copy (§4.5.4b). Without a count on the card
     * that state is indistinguishable from an orphan, which is exactly how it was reported.
     *
     * Counted from the SERVER, not from the browser's local chats: the dashboard's whole job is to be
     * right on a device that has never opened the project.
     *
     * One prefix listing per project (`countChats` reads no bodies), in parallel. If a count fails, the
     * project still lists — a card is not worth losing someone's project list over.
     */
    const withCounts = await Promise.all(
      projects.map(async (project) => ({
        ...toWireProject(project, context),
        chatCount: await countChats(project.id, context).catch(() => undefined),
      })),
    );

    return json({ projects: withCounts });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    /*
     * Remix sends every non-GET method here, so an unguarded `DELETE /api/projects` would fall into
     * the CREATE branch, fail on the missing body, and surface as a 500 — an alarming way to say
     * "that endpoint doesn't exist". Deleting a project is done through `/api/projects/:id`.
     */
    if (request.method !== 'POST') {
      return json(
        { error: true, message: `Cannot ${request.method} /api/projects.`, statusCode: 405, isRetryable: false },
        { status: 405, headers: { Allow: 'GET, POST' } },
      );
    }

    const user = await requireUser(request, context);
    const body = await request.json<{ name?: string; templateId?: string }>();

    /*
     * The flat New Project charge (§4.4a, migration 0015) — the one thing permitted to stop a creation.
     *
     * Creation runs NO generation now: it clones the pinned starter, installs it and serves it. The
     * owner's rule is "nothing else should be able to stop the project from getting created", and this
     * gate honours it by running FIRST — before the project row, before a VM, before a template fetch.
     * A refusal therefore leaves nothing half-made, which is categorically different from a mid-creation
     * failure. `project_create` is absent from `mayGoNegative` for the same reason: a debit taken before
     * the spend it pays for refuses rather than overdraws.
     *
     * Quote first, debit after `store.create`: the refusal must leave no row behind, and the debit's
     * audit note is the project id, which does not exist until the row does.
     */
    const quote = await quoteProjectCreate({ userId: user.id, context });

    if (!quote.ok) {
      return json(
        { error: true, message: quote.message, statusCode: 402, isRetryable: false, balance: quote.balance },
        { status: 402 },
      );
    }

    const store = getProjectStore(context);

    const project = await store.create({
      /*
       * `userId` comes from the SESSION, never from the body. This is the line that makes ownership
       * mean anything: a client-supplied owner would let anyone create a project in someone else's
       * account and then legitimately "own" it.
       */
      userId: user.id,

      name: (body.name || 'Untitled Game').slice(0, 120),
      templateId: body.templateId || 'blank-canvas',
    });

    /*
     * The debit. A throw here means a concurrent creation drained the balance between the quote and now
     * — `project_create` may not overdraw, so the ledger refuses. Undo the row rather than keep an
     * unpaid project: an unpaid project is worse than a refused one, because nothing downstream will
     * ever notice it, whereas the user can simply click New Project again.
     */
    let balance: number | undefined;

    try {
      balance = await debitProjectCreate({ userId: user.id, projectId: project.id, charge: quote.charge, context });
    } catch (error) {
      /*
       * The rollback is reported by its RESULT, never assumed. A `catch` that swallows the failure and
       * then logs "rolled back" leaves an unpaid project row behind under a line asserting the opposite
       * — the false-claim-in-a-log class this codebase keeps rediscovering.
       */
      const rolledBack = await store
        .delete(project.id)
        .then(() => true)
        .catch(() => false);

      logger[rolledBack ? 'warn' : 'error'](
        rolledBack
          ? `Project ${project.id} rolled back — the creation charge could not be taken: ${(error as Error)?.message}`
          : `UNPAID PROJECT ${project.id}: the creation charge failed AND the rollback failed. ${
              (error as Error)?.message
            }`,
      );

      return json(
        {
          error: true,
          message: 'Your credit balance changed while this project was being created. Please try again.',
          statusCode: 402,
          isRetryable: true,
        },
        { status: 402 },
      );
    }

    // Funnel: a new project exists (§5A). "First playable" and "share" come later in the same story.
    getMonitor(context).track(FUNNEL_EVENTS.PROJECT_CREATED, {
      userId: user.id,
      templateId: project.templateId,
    });

    /*
     * `balance` rides back so the client can show the charge immediately. Omitted (not zero) when nothing
     * was charged — zero is a real balance, and reporting it would wipe the displayed number for every
     * unmetered/BYOK/free-price creation.
     */
    return json(
      { project: toWireProject(project, context), ...(balance !== undefined ? { balance } : {}) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
