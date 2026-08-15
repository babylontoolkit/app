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
import { purgeProject } from '~/lib/.server/projects/purge';
import type { CreationHandoff } from '~/lib/.server/projects/types';
import { mergeCreationPlan, parseCreationPlan } from '~/lib/agent/creation-plan';
import { errorResponse } from '~/lib/.server/http';

/**
 * How much creation handoff a browser may store on a project (§4.4a, §4.2.8).
 *
 * The brief is machine-written, but it ARRIVES IN A BROWSER BODY and it is later sent to the model on
 * the most expensive turn in the product — so it is caller-supplied text on a paid path, and the cap is
 * the same reasoning as `MAX_INSTRUCTIONS_CHARS`: an unbounded one is an unbounded per-turn bill, and
 * nothing about it would ever throw. Generous enough for the real brief (~4KB with the media section)
 * plus a wizard's compiled selections.
 */
const MAX_HANDOFF_PROMPT_CHARS = 8_000;

/**
 * Validate a handoff sent by the browser. `null` CLEARS it — that is how the handoff ends on the first
 * build send, so it must be expressible; anything that is not an object also clears, because a corrupt
 * handoff is exactly a project that should stop offering to build itself.
 *
 * The machine-written `brief` field is RETIRED (owner, 2026-08-08) — an old client still sending one
 * has it silently dropped here. A malformed PLAN is likewise dropped rather than clearing the handoff:
 * clearing on a corrupt plan strands a half-built project with no way to resume.
 */
function parseCreationHandoff(value: unknown): CreationHandoff | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const { userPrompt, plan, blankCanvas } = value as {
    userPrompt?: unknown;
    plan?: unknown;
    blankCanvas?: unknown;
  };

  const parsedPlan = parseCreationPlan(plan);

  return {
    /*
     * Strictly `true`, never truthy: this decides whether the platform runs a two-turn front-end and
     * art build on the user's credits, and it arrives in a browser body. Anything else means "phase
     * it", which is the behaviour every project had before this flag existed.
     */
    ...(blankCanvas === true ? { blankCanvas: true } : {}),
    ...(typeof userPrompt === 'string' && userPrompt.length > 0
      ? { userPrompt: userPrompt.slice(0, MAX_HANDOFF_PROMPT_CHARS) }
      : {}),
    ...(parsedPlan ? { plan: parsedPlan } : {}),
  };
}

/**
 * Fold an incoming handoff onto the one already stored.
 *
 * 🔴 **The plan's `next` may only move FORWARD** (`mergeCreationPlan`). The PATCH is a full replace,
 * so without this a second tab, a stale bundle or an out-of-order retry could rewind the counter and
 * re-run a phase that already ran — paying for it twice and overwriting files that were correct. It
 * belongs HERE rather than in `parseCreationHandoff` because only the route can read the existing
 * row, and it is the ledger's `seq` lesson applied to a counter that decides what gets rebuilt: a
 * read-then-write check is a race, so the merge IS the write.
 *
 * An explicit clear (`null` → `undefined`) is honoured untouched. That is how a completed plan ends,
 * and a merge that resurrected it would make the handoff unclearable.
 */
function mergeCreationHandoff(
  existing: CreationHandoff | undefined,
  incoming: CreationHandoff | undefined,
): CreationHandoff | undefined {
  if (!incoming || !existing) {
    return incoming;
  }

  const plan = mergeCreationPlan(existing.plan, incoming.plan);

  return { ...incoming, ...(plan ? { plan } : {}) };
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  try {
    const user = await requireUser(request, context);
    const project = await requireOwnedProject(user, params.projectId!, context);

    return json({ project: toWireProject(project, context) });
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
       * The whole reaper — published build, seed, conversation, working copy, VM, row, creation refund,
       * in that order and for the reasons written there. It lives in `purge.ts` because account deletion
       * (§4.5.1) reaps every one of a user's projects and must not re-derive the list: two copies of a
       * list this long diverge silently, and the divergence leaves the user's bytes on our servers while
       * the UI reports success.
       */
      await purgeProject(project, { userId: user.id, context });

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
    const body = await request.json<{ name?: string; creationHandoff?: unknown }>();

    const updated = await store.update(project.id, {
      ...(body.name !== undefined ? { name: body.name.slice(0, 120) } : {}),
      ...('creationHandoff' in body
        ? { creationHandoff: mergeCreationHandoff(project.creationHandoff, parseCreationHandoff(body.creationHandoff)) }
        : {}),
    });

    return json({ project: toWireProject(updated, context) });
  } catch (error) {
    return errorResponse(error);
  }
}
