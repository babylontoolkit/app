/**
 * A managed first build that FINISHED records that on the project row itself — the server's job, not the
 * tab's (owner, 2026-10-02).
 *
 * Reported live: *"the build plan stayed on step 1 the whole time… I think the creation is done, but it's
 * just sitting there so I am not sure."* The session's record showed the build had ended normally with all
 * three steps reported done. But only the browser tab that pressed Build ever advanced the plan
 * (`saveCreationHandoff` from `onFinish`), and that tab's state did not survive: the stream dropped, the page
 * reloaded, the RESUMED turn finished the build — and nothing wrote it down. The row still said "owes its
 * first build", so the plan card spun on Step 1 forever, the "your game is ready" message never came, and
 * every later message would have been treated as a first build.
 *
 * The server already knows the moment (`creationPhasesCompleted`, only on a turn that ENDED normally) and
 * already holds the row, so it writes it here, at the end of the turn, whatever tab is or is not watching.
 * Same rules as the client's write: the plan only moves FORWARD (`advanceCreationPlanTo` stops at the first
 * phase the turn did not report), and a COMPLETE plan clears the handoff — the row's presence is what
 * `projectOwesBuild` reads. Idempotent: the client's own write after this one finds nothing left to do.
 * Never throws — a bookkeeping failure must not fail a build that worked.
 */
import { advanceCreationPlanTo, isCreationPlanComplete, type CreationPhaseId } from '~/lib/agent/creation-plan';
import { getProjectStore } from '~/lib/.server/projects/store';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('managed-build-complete');

export interface BuildCompleteResult {
  /** The plan reached its end and the handoff was cleared. */
  complete: boolean;
}

export async function recordManagedBuildPhases(input: {
  projectId: string;
  phases: readonly CreationPhaseId[];
  generationId: string;
  context?: unknown;
}): Promise<BuildCompleteResult> {
  try {
    const store = getProjectStore(input.context);
    const project = await store.get(input.projectId);
    const plan = project?.creationHandoff?.plan;

    /* Already recorded (by the client, or an earlier request of this turn): nothing owed. */
    if (!project || !plan) {
      return { complete: !project?.creationHandoff };
    }

    const advanced = advanceCreationPlanTo(plan, input.phases, {
      generationId: input.generationId,
      at: new Date().toISOString(),
      state: 'finished',
    });

    if (isCreationPlanComplete(advanced)) {
      await store.update(input.projectId, { creationHandoff: undefined });
      logger.info(`Project ${input.projectId}: first build complete — handoff cleared`);

      return { complete: true };
    }

    if (advanced.next !== plan.next) {
      await store.update(input.projectId, { creationHandoff: { ...project.creationHandoff, plan: advanced } });
    }

    return { complete: false };
  } catch (error) {
    logger.error(`Project ${input.projectId}: could not record the finished build: ${(error as Error)?.message}`);

    return { complete: false };
  }
}
