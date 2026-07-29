/**
 * A ceiling on how many of one account's sandboxes may be RUNNING at once
 * (`spec/sandbox-codesandbox.md` §11, plan T5).
 *
 * Per-project sandboxes (T1–T3) fixed a correctness bug and created a cost one: a user who opens six
 * projects in an afternoon now has six VMs, each billing until its own idle timeout fires. The
 * provider's concurrency limit is measured for the whole API key, so one enthusiastic account is a
 * platform-wide resource question, exactly like the fork budget `create-limit.ts` bounds.
 *
 * 🔴 **This never refuses a session.** Hibernation is free, reversible, and MEASURED at 1.3–2.4s to
 * resume with the filesystem and the running dev server intact — so the cap MAKES ROOM rather than
 * saying no. A cap that could refuse would turn a cost lever into "you cannot open your project",
 * which is a worse failure than the bill it prevents (the same judgement `create-limit.ts` records
 * about refusing a real user).
 *
 * The decision is pure and the IO is a thin best-effort wrapper, for the usual reason: the judgement
 * is what has to be exhaustively testable, and the failure mode of the IO half is a VM that stays up
 * a few minutes longer — never a lost file, never a failed request.
 */
import { getProjectStore } from '~/lib/.server/projects/store';
import { getMonitor } from '~/lib/.server/monitoring';
import { DEFAULT_SANDBOX_MAX_RUNNING_VMS } from './config';
import { hibernateSandbox, listRunningSandboxes, type RunningSandbox } from './service';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('sandbox-vm-cap');

export interface VmCapDecision {
  /** Sandbox ids to hibernate, oldest first. Never contains the sandbox the caller is keeping. */
  hibernate: string[];
}

/**
 * Which of a user's OTHER running sandboxes have to go to sleep?
 *
 * ⚠️ `otherRunning` is deliberately named: it must NOT include the sandbox the caller just started or
 * resumed. That one is always kept — it is the project the user is looking at — and it counts against
 * `cap`, so the number of others allowed to stay up is `cap - 1`. Passing the kept sandbox in here
 * would let the cap hibernate the VM the request is about, i.e. put the user's project to sleep the
 * instant they opened it.
 *
 * "Oldest" is LEAST RECENTLY TOUCHED: the later of session start and last activity. Using session
 * start alone would reclaim the project a user has had open and busy since morning before one they
 * opened ten minutes ago and abandoned — exactly backwards, and invisible (the victim just waits a
 * few seconds longer next time they type). A VM the provider tells us nothing about sorts oldest of
 * all, because hibernation is the cheap direction. Ties break on the id so the answer is deterministic.
 */
export function decideVmCap(otherRunning: readonly RunningSandbox[], cap: number): VmCapDecision {
  /*
   * A nonsensical cap falls back rather than being obeyed — the same rule as `decideCreateAllowed`
   * and `sandboxHibernationSeconds`. Obeying `0` would hibernate every project on the platform.
   */
  const effective = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_SANDBOX_MAX_RUNNING_VMS;

  /** One entry per sandbox: the provider list is a picture, and a duplicated id must not double-count. */
  const unique = new Map<string, RunningSandbox>();

  for (const vm of otherRunning) {
    if (vm.sandboxId && !unique.has(vm.sandboxId)) {
      unique.set(vm.sandboxId, vm);
    }
  }

  const age = (vm: RunningSandbox) => {
    const marks = [vm.startedAt, vm.lastActiveAt].filter((at): at is number => typeof at === 'number' && !isNaN(at));

    return marks.length > 0 ? Math.max(...marks) : Number.NEGATIVE_INFINITY;
  };

  const oldestFirst = [...unique.values()].sort((a, b) => age(a) - age(b) || a.sandboxId.localeCompare(b.sandboxId));

  /** The kept sandbox occupies one slot, so this is how many of the others may stay running. */
  const allowedOthers = Math.max(0, effective - 1);
  const excess = oldestFirst.length - allowedOthers;

  return { hibernate: excess > 0 ? oldestFirst.slice(0, excess).map((vm) => vm.sandboxId) : [] };
}

/**
 * How long the whole cap sweep may take before the caller stops waiting for it.
 *
 * The catch below handles a REJECTION; it does nothing about slowness, and this runs on the path a
 * user is waiting on to open their project. A provider list call that hangs would hold the session
 * request open indefinitely — a cost optimisation that can stall an open is no better than one that
 * can fail it. Same reasoning as the monitoring transport's own deadline.
 */
export const VM_CAP_DEADLINE_MS = 5_000;

export interface EnforceVmCapOptions {
  userId: string;

  /** The sandbox this request is about. Always kept, and it consumes one slot of the cap. */
  keepSandboxId: string;

  cap: number;
  context?: unknown;

  /** Test seam — the deadline, so a spec can prove the timeout without waiting five seconds. */
  deadlineMs?: number;
}

/**
 * Apply the cap for one user, best-effort.
 *
 * The candidate set comes from the PROJECT ROWS, not from an in-process map: a container restart must
 * not lose track of a running VM (the same durability argument `create-limit.ts` explicitly trades
 * away for its rate window, where the state genuinely is disposable and this state is not).
 *
 * Every failure is swallowed after being reported. This runs on the boot path of a project the user is
 * waiting for, and a cost optimisation that can fail an open is not a cost optimisation.
 *
 * @returns the sandbox ids we asked the provider to hibernate.
 */
export async function enforceRunningVmCap(options: EnforceVmCapOptions): Promise<string[]> {
  const { userId, keepSandboxId, cap, context, deadlineMs = VM_CAP_DEADLINE_MS } = options;

  const sweep = async () => {
    const projects = await getProjectStore(context).listByUser(userId);

    /*
     * sandboxId → projectId, so the lifecycle mark this sweep writes names the project whose VM went
     * to sleep (T12). The map is built from the same pass that selects the candidates, because a
     * second lookup keyed by sandbox id would be a second source of truth for the same row.
     */
    const projectForSandbox = new Map<string, string>();

    for (const project of projects) {
      if (project.sandboxId && project.sandboxId !== keepSandboxId) {
        projectForSandbox.set(project.sandboxId, project.id);
      }
    }

    const candidates = new Set(projectForSandbox.keys());

    // No other project has ever had a sandbox — do not spend a provider call to discover that.
    if (candidates.size === 0) {
      return [];
    }

    const running = (await listRunningSandboxes(context)).filter((vm) => candidates.has(vm.sandboxId));

    const { hibernate } = decideVmCap(running, cap);

    /*
     * Concurrently: these are independent VMs, and serialising them multiplies one round trip by
     * however many are over the cap while the user waits. `hibernateSandbox` is already best-effort
     * and logged inside, so none of these can reject.
     */
    await Promise.all(
      hibernate.map(async (sandboxId) => {
        await hibernateSandbox(sandboxId, context, { userId, projectId: projectForSandbox.get(sandboxId) });
        logger.info(`Hibernated sandbox ${sandboxId} for user ${userId} to stay under the ${cap}-VM cap.`);
      }),
    );

    return hibernate;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    /*
     * The deadline abandons the WAIT, not the work: whatever is in flight still completes at the
     * provider, and the worst case is a VM that stays up until its own idle timeout — which is the
     * exact state this function exists to improve, never a broken request.
     */
    return await Promise.race([
      sweep(),
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), deadlineMs);
      }),
    ]);
  } catch (error) {
    getMonitor(context).captureException(error, { scope: 'sandbox.vm-cap', userId, tags: { keepSandboxId } });

    return [];
  } finally {
    clearTimeout(timer);
  }
}
