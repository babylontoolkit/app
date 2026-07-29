/**
 * The running-VM ceiling (`spec/sandbox-codesandbox.md` §11, plan T5).
 *
 * Two directions, and unlike the fork ceiling only ONE of them is allowed to be visible: hibernation
 * is free and reversible, so the cap MAKES ROOM and must never refuse a session. That makes the
 * failure modes of this module quiet by construction, which is exactly why the judgement is pure and
 * exhaustively pinned here:
 *
 *   - **Hibernating the sandbox the request is about** puts the user's project to sleep the instant
 *     they open it. `decideVmCap` can only ever be given the OTHERS, and the kept VM consumes one slot
 *     — so `allowedOthers` is `cap - 1`, and getting that off by one either hibernates nothing (the
 *     bill it exists to bound) or one VM too many (a resume the user pays for in latency).
 *   - **Obeying a nonsensical cap.** `0` means "hibernate every project on the platform"; the guard
 *     falls back instead, the same rule as `sandboxHibernationSeconds`.
 *   - **Reaching past the user's own projects.** The provider list is workspace-wide (the account is
 *     ours, the users are ours), so the intersection with ONE user's project rows is the only thing
 *     making this a per-user cap rather than a platform-wide one. Widen it and one user's open project
 *     hibernates a stranger's.
 *   - **Failing the request it precedes.** This runs on the boot path of a project the user is waiting
 *     for. A cost optimisation that can fail an open is not a cost optimisation.
 *
 * The candidate set is read from the PROJECT ROWS rather than an in-process map on purpose (a
 * container restart must not lose track of a running VM), so the IO half is tested against a real
 * `FsProjectStore` with only the provider mocked — a real network call from a test is a hard failure
 * here, as in `sandbox-routes.spec.ts`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsProjectStore, setProjectStore } from '~/lib/.server/projects/store';
import type { Project } from '~/lib/.server/projects/types';
import { DEFAULT_SANDBOX_MAX_RUNNING_VMS, sandboxMaxRunningVms } from './config';
import { decideVmCap, enforceRunningVmCap } from './vm-cap';
import type { RunningSandbox } from './service';

const service = vi.hoisted(() => ({
  listRunningSandboxes: vi.fn(),
  hibernateSandbox: vi.fn(),
}));

vi.mock('./service', () => service);
vi.mock('~/lib/.server/sandbox/service', () => service);

const NOW = 1_700_000_000_000;

/** A provider call that never answers — the shape the deadline exists for. Never resolves, never rejects. */
const neverSettles = <T>() => new Promise<T>(() => undefined);

/** A running VM with an explicit session start, so "oldest" is unambiguous in the assertions. */
const vm = (sandboxId: string, startedAt?: number, lastActiveAt?: number): RunningSandbox => ({
  sandboxId,
  startedAt,
  lastActiveAt,
});

describe('decideVmCap — the pure judgement', () => {
  it('hibernates nothing when the user has no other running sandbox', () => {
    expect(decideVmCap([], 2)).toEqual({ hibernate: [] });
  });

  it('hibernates nothing while UNDER the cap', () => {
    /* cap 3 keeps the new VM plus two others: one other is comfortably inside the budget. */
    expect(decideVmCap([vm('sb-a', NOW - 1000)], 3)).toEqual({ hibernate: [] });
  });

  it('is at the cap, not over it, with `cap - 1` others running', () => {
    /*
     * The boundary IS the test. `cap` instead of `cap - 1` here means the kept sandbox is not counted,
     * so a cap of 2 silently allows 3 running VMs — the bill this module exists to bound.
     */
    expect(decideVmCap([vm('sb-a', NOW - 1000)], 2)).toEqual({ hibernate: [] });
    expect(decideVmCap([vm('sb-a', NOW - 2000), vm('sb-b', NOW - 1000)], 2)).toEqual({ hibernate: ['sb-a'] });
  });

  it('hibernates the oldest STARTED first when start is the only mark the provider gives', () => {
    /*
     * ⚠️ Title deliberately says "started", not "recently used": every VM here has a `startedAt` and no
     * `lastActiveAt`, so this case cannot tell the two rules apart. The least-recently-TOUCHED claim is
     * pinned by the test below, which is the one that fails under `startedAt ?? lastActiveAt`.
     *
     * Reclaiming the newest would take the project the user just flipped away from, which is the one
     * they are most likely to flip back to — a guaranteed resume wait for no extra saving.
     */
    const decision = decideVmCap(
      [vm('sb-new', NOW - 1_000), vm('sb-old', NOW - 900_000), vm('sb-mid', NOW - 60_000)],
      2,
    );

    expect(decision.hibernate).toEqual(['sb-old', 'sb-mid']);
    expect(decision.hibernate).not.toContain('sb-new');
  });

  it('🔴 keeps a long-running BUSY VM and sleeps the newer IDLE one — age is least-recently-TOUCHED', () => {
    /*
     * The case the previous `startedAt ?? lastActiveAt` rule got exactly backwards, and the reason the
     * "most recently used" claim needed a test of its own: `sb-busy` was opened this morning and the
     * user is typing in it right now; `sb-idle` was opened ten minutes ago and abandoned. Sorting on
     * session start reclaims the project in active use and keeps the abandoned one — invisible, because
     * the victim only ever experiences it as a resume wait next time they type.
     */
    const busySinceMorning = vm('sb-busy', NOW - 9_000_000, NOW - 1_000);
    const openedRecentlyThenAbandoned = vm('sb-idle', NOW - 600_000, NOW - 600_000);

    expect(decideVmCap([busySinceMorning, openedRecentlyThenAbandoned], 2)).toEqual({ hibernate: ['sb-idle'] });

    // Same answer whichever order the provider happens to list them in.
    expect(decideVmCap([openedRecentlyThenAbandoned, busySinceMorning], 2)).toEqual({ hibernate: ['sb-idle'] });

    /* And it holds when the idle VM reports no activity at all — start is then its only mark. */
    expect(decideVmCap([busySinceMorning, vm('sb-idle', NOW - 600_000)], 2)).toEqual({ hibernate: ['sb-idle'] });
  });

  it('takes the LATER of the two marks, never the earlier one', () => {
    /*
     * `Math.min` here would make every VM look as old as its session start — i.e. the old rule wearing
     * the new code's shape. Activity is what says a project is in use.
     */
    const decision = decideVmCap([vm('sb-a', NOW - 1_000, NOW - 500_000), vm('sb-b', NOW - 400_000, NOW - 300_000)], 2);

    /* By the later mark `sb-b` is the older of the two; by the earlier mark it would be `sb-a`. */
    expect(decision).toEqual({ hibernate: ['sb-b'] });
  });

  it('takes as many as it needs, oldest first, when the account is far over', () => {
    const running = [vm('sb-1', NOW - 5), vm('sb-2', NOW - 4), vm('sb-3', NOW - 3), vm('sb-4', NOW - 2)];

    // cap 2 → one other may stay: the newest.
    expect(decideVmCap(running, 2)).toEqual({ hibernate: ['sb-1', 'sb-2', 'sb-3'] });

    // cap 3 → two others may stay.
    expect(decideVmCap(running, 3)).toEqual({ hibernate: ['sb-1', 'sb-2'] });
  });

  it('cap 1 means EVERY other sandbox sleeps — the kept one is the whole budget', () => {
    const running = [vm('sb-a', NOW - 3), vm('sb-b', NOW - 2), vm('sb-c', NOW - 1)];

    expect(decideVmCap(running, 1)).toEqual({ hibernate: ['sb-a', 'sb-b', 'sb-c'] });
  });

  it('falls back to the default for a nonsensical cap rather than obeying it', () => {
    /*
     * Obeying `0` (or a NaN from a typo'd env var) would hibernate a sandbox the instant it was minted
     * and put every other project on the account to sleep. The default keeps one other VM up.
     */
    const running = [vm('sb-old', NOW - 2), vm('sb-new', NOW - 1)];
    const atDefault = decideVmCap(running, DEFAULT_SANDBOX_MAX_RUNNING_VMS);

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(decideVmCap(running, bad)).toEqual(atDefault);
    }

    expect(atDefault).toEqual({ hibernate: ['sb-old'] });
  });

  it('floors a fractional cap instead of letting it drift half a VM', () => {
    const running = [vm('sb-a', NOW - 3), vm('sb-b', NOW - 2), vm('sb-c', NOW - 1)];

    expect(decideVmCap(running, 2.9)).toEqual(decideVmCap(running, 2));
  });

  it('falls back to lastActiveAt when the provider gives no session start', () => {
    const decision = decideVmCap(
      [vm('sb-recent', undefined, NOW - 1_000), vm('sb-stale', undefined, NOW - 900_000)],
      2,
    );

    expect(decision).toEqual({ hibernate: ['sb-stale'] });
  });

  it('sorts a VM of UNKNOWN age oldest of all', () => {
    /*
     * Hibernation is the cheap direction: a VM the provider tells us nothing about should be reclaimed
     * before a known-recent one. The inverse would keep mystery VMs up forever.
     */
    expect(decideVmCap([vm('sb-known', NOW - 900_000), vm('sb-mystery')], 2)).toEqual({ hibernate: ['sb-mystery'] });
    expect(decideVmCap([vm('sb-known', NOW - 900_000), vm('sb-mystery')], 1)).toEqual({
      hibernate: ['sb-mystery', 'sb-known'],
    });
  });

  it('still answers deterministically when EVERY age is unknown', () => {
    /*
     * Two unknowns subtract to NaN in the comparator, which is falsy — so the id tie-break decides, and
     * the answer is stable. Without that fallback the sort is implementation-defined and this module's
     * behaviour becomes unexplainable in exactly the case the provider is least helpful.
     */
    expect(decideVmCap([vm('sb-b'), vm('sb-a'), vm('sb-c')], 2)).toEqual({ hibernate: ['sb-a', 'sb-b'] });
    expect(decideVmCap([vm('sb-c'), vm('sb-b'), vm('sb-a')], 2)).toEqual({ hibernate: ['sb-a', 'sb-b'] });
  });

  it('counts a duplicated id once — the provider list is a picture, not a tally', () => {
    /*
     * Double-counting would report the account over its cap on the strength of one VM listed twice and
     * hibernate a project that never needed to sleep.
     */
    expect(decideVmCap([vm('sb-a', NOW - 1), vm('sb-a', NOW - 1)], 2)).toEqual({ hibernate: [] });

    const decision = decideVmCap([vm('sb-a', NOW - 2), vm('sb-a', NOW - 2), vm('sb-b', NOW - 1)], 2);
    expect(decision).toEqual({ hibernate: ['sb-a'] });
  });

  it('ignores an entry with no sandbox id at all', () => {
    expect(decideVmCap([{ sandboxId: '' }, vm('sb-a', NOW - 1)], 2)).toEqual({ hibernate: [] });
  });

  it('breaks age ties deterministically, in either input order', () => {
    /* A non-deterministic answer here makes the whole module untestable and the behaviour unexplainable. */
    const a = vm('sb-a', NOW);
    const b = vm('sb-b', NOW);

    expect(decideVmCap([a, b], 2)).toEqual({ hibernate: ['sb-a'] });
    expect(decideVmCap([b, a], 2)).toEqual({ hibernate: ['sb-a'] });
  });

  it('never returns the kept sandbox — it is not in its input by contract', () => {
    /*
     * The contract is the wall: `otherRunning` excludes the sandbox the caller is keeping, and the IO
     * wrapper below is what enforces it. Pinned so a future caller cannot "helpfully" pass the full
     * list and expect the pure function to filter.
     */
    const decision = decideVmCap([vm('sb-keep', NOW - 900_000), vm('sb-other', NOW - 1)], 2);

    expect(decision.hibernate).toEqual(['sb-keep']);
  });
});

describe('sandboxMaxRunningVms — the env guard', () => {
  /*
   * ⚠️ `env()` falls back to `process.env`, and vitest loads `.env.local` — so an "empty" context is
   * not empty. Every case stubs the variable explicitly (the `oauth.spec.ts` trap).
   */
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 2 when unset', () => {
    vi.stubEnv('CODESANDBOX_MAX_RUNNING_VMS', undefined as unknown as string);
    expect(sandboxMaxRunningVms({})).toBe(DEFAULT_SANDBOX_MAX_RUNNING_VMS);
    expect(DEFAULT_SANDBOX_MAX_RUNNING_VMS).toBe(2);
  });

  it('honours a sane override', () => {
    vi.stubEnv('CODESANDBOX_MAX_RUNNING_VMS', '5');
    expect(sandboxMaxRunningVms({})).toBe(5);
  });

  it('ignores a nonsensical override rather than obeying it', () => {
    for (const bad of ['0', '-3', 'two', '', 'NaN']) {
      vi.stubEnv('CODESANDBOX_MAX_RUNNING_VMS', bad);
      expect(sandboxMaxRunningVms({})).toBe(DEFAULT_SANDBOX_MAX_RUNNING_VMS);
    }
  });

  it('floors a fractional override', () => {
    vi.stubEnv('CODESANDBOX_MAX_RUNNING_VMS', '3.7');
    expect(sandboxMaxRunningVms({})).toBe(3);
  });
});

describe('enforceRunningVmCap — the best-effort IO half', () => {
  let tmp: string;
  let projects: FsProjectStore;
  let mine: Project;

  beforeEach(async () => {
    for (const spy of Object.values(service)) {
      spy.mockReset();
    }

    service.listRunningSandboxes.mockResolvedValue([]);
    service.hibernateSandbox.mockResolvedValue(undefined);

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-vm-cap-'));
    projects = new FsProjectStore(tmp);
    setProjectStore(projects);

    mine = await projects.create({ userId: 'user-1', name: 'Mine', templateId: 'racing' });
    await projects.update(mine.id, { sandboxId: 'sb-keep' });
  });

  afterEach(async () => {
    setProjectStore(undefined);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Give `userId` a project already holding `sandboxId`. */
  const projectWith = async (userId: string, name: string, sandboxId: string) => {
    const project = await projects.create({ userId, name, templateId: 'racing' });
    await projects.update(project.id, { sandboxId });

    return project;
  };

  it('spends NO provider call when no other project has ever had a sandbox', async () => {
    /*
     * The common case — a one-project account — must not pay a workspace-wide list on every open. The
     * answer is already on the rows.
     */
    expect(await enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 2, context: {} })).toEqual([]);

    expect(service.listRunningSandboxes).not.toHaveBeenCalled();
    expect(service.hibernateSandbox).not.toHaveBeenCalled();
  });

  it('hibernates the oldest of the user’s OWN other projects once over the cap', async () => {
    await projectWith('user-1', 'Older', 'sb-old');
    await projectWith('user-1', 'Newer', 'sb-new');

    service.listRunningSandboxes.mockResolvedValue([
      vm('sb-keep', NOW),
      vm('sb-new', NOW - 60_000),
      vm('sb-old', NOW - 900_000),
    ]);

    const hibernated = await enforceRunningVmCap({
      userId: 'user-1',
      keepSandboxId: 'sb-keep',
      cap: 2,
      context: {},
    });

    expect(hibernated).toEqual(['sb-old']);
    expect(service.hibernateSandbox).toHaveBeenCalledTimes(1);
    expect(service.hibernateSandbox).toHaveBeenCalledWith('sb-old', expect.anything(), expect.anything());
  });

  it('🔴 never hibernates the sandbox the request is about, even when it is the oldest running VM', async () => {
    /*
     * The resumed VM's session started long ago by definition. Counting it as a candidate would put the
     * project to sleep the instant the user opened it.
     */
    await projectWith('user-1', 'Other', 'sb-other');

    service.listRunningSandboxes.mockResolvedValue([vm('sb-keep', NOW - 5_000_000), vm('sb-other', NOW - 1_000)]);

    const hibernated = await enforceRunningVmCap({
      userId: 'user-1',
      keepSandboxId: 'sb-keep',
      cap: 1,
      context: {},
    });

    expect(hibernated).toEqual(['sb-other']);

    // First args only: an argument added to `hibernateSandbox` must never make this assertion vacuous.
    expect(service.hibernateSandbox.mock.calls.map((call) => call[0])).not.toContain('sb-keep');
  });

  it('🔴 never reaches another user’s sandbox, even when the provider lists it as the oldest', async () => {
    /*
     * `listRunningSandboxes` is workspace-wide. Without the intersection against THIS user's rows, one
     * user opening a project hibernates a stranger's — a per-user cap turned into a platform-wide one.
     */
    await projectWith('someone-else', 'Theirs', 'sb-theirs');
    await projectWith('user-1', 'Mine too', 'sb-mine-2');

    service.listRunningSandboxes.mockResolvedValue([
      vm('sb-theirs', NOW - 9_000_000),
      vm('sb-keep', NOW),
      vm('sb-mine-2', NOW - 1_000),
    ]);

    const hibernated = await enforceRunningVmCap({
      userId: 'user-1',
      keepSandboxId: 'sb-keep',
      cap: 1,
      context: {},
    });

    expect(hibernated).toEqual(['sb-mine-2']);
    expect(service.hibernateSandbox.mock.calls.map((call) => call[0])).not.toContain('sb-theirs');
  });

  it('ignores a recorded sandbox the provider is not running — a stopped VM costs nothing', async () => {
    await projectWith('user-1', 'Asleep', 'sb-asleep');
    await projectWith('user-1', 'Awake', 'sb-awake');

    service.listRunningSandboxes.mockResolvedValue([vm('sb-keep', NOW), vm('sb-awake', NOW - 1_000)]);

    expect(await enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 2, context: {} })).toEqual([]);
    expect(service.hibernateSandbox).not.toHaveBeenCalled();
  });

  it('🔴 swallows a provider list failure — the cap must never fail the session it precedes', async () => {
    await projectWith('user-1', 'Other', 'sb-other');
    service.listRunningSandboxes.mockRejectedValue(new Error('provider is having a day'));

    await expect(
      enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 1, context: {} }),
    ).resolves.toEqual([]);

    expect(service.hibernateSandbox).not.toHaveBeenCalled();
  });

  it('swallows a project-store failure too', async () => {
    vi.spyOn(projects, 'listByUser').mockRejectedValue(new Error('store is down'));

    await expect(
      enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 1, context: {} }),
    ).resolves.toEqual([]);

    expect(service.listRunningSandboxes).not.toHaveBeenCalled();
  });

  it('🔴 gives up WAITING on a hung provider list, and answers instead of hanging the open', async () => {
    /*
     * The `catch` handles a rejection and does nothing about slowness. A provider list that never
     * settles would hold the session request open forever — a cost optimisation that can stall an open
     * is no better than one that can fail it. The deadline abandons the WAIT, never the work: whatever
     * is in flight still completes at the provider, and the worst case is a VM that stays up until its
     * own idle timeout, which is the exact state this function exists to improve.
     */
    await projectWith('user-1', 'Other', 'sb-other');
    service.listRunningSandboxes.mockReturnValue(neverSettles());

    await expect(
      enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 1, context: {}, deadlineMs: 5 }),
    ).resolves.toEqual([]);

    expect(service.hibernateSandbox).not.toHaveBeenCalled();
  });

  it('gives up waiting on a hung HIBERNATE too — the deadline covers the whole sweep', async () => {
    await projectWith('user-1', 'Other', 'sb-other');
    service.listRunningSandboxes.mockResolvedValue([vm('sb-keep', NOW), vm('sb-other', NOW - 1_000)]);
    service.hibernateSandbox.mockReturnValue(neverSettles());

    await expect(
      enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 1, context: {}, deadlineMs: 5 }),
    ).resolves.toEqual([]);

    /* Abandoning the wait is not abandoning the work: the request was still ISSUED. */
    expect(service.hibernateSandbox).toHaveBeenCalledWith('sb-other', expect.anything(), expect.anything());
  });

  it('still reports what it hibernated when the sweep beats the deadline', async () => {
    /*
     * The control for the two cases above: a `Promise.race` that resolved `[]` unconditionally would
     * pass both of them and silently stop reporting anything on the ordinary path.
     */
    await projectWith('user-1', 'Other', 'sb-other');
    service.listRunningSandboxes.mockResolvedValue([vm('sb-keep', NOW), vm('sb-other', NOW - 1_000)]);

    await expect(
      enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 1, context: {}, deadlineMs: 10_000 }),
    ).resolves.toEqual(['sb-other']);
  });

  it('🔴 hibernates EVERY over-cap VM, and issues the calls without waiting for each other', async () => {
    /*
     * Serialising these multiplies one provider round trip by however many VMs are over the cap while
     * the user waits for their project — the reason the sweep has a deadline at all. The gate proves
     * concurrency rather than timing it: all three calls must be in flight before any of them finishes,
     * which a `for … await` loop cannot manage. The 250ms valve exists so a serial implementation fails
     * as an ASSERTION rather than as a hung suite.
     */
    await projectWith('user-1', 'A', 'sb-a');
    await projectWith('user-1', 'B', 'sb-b');
    await projectWith('user-1', 'C', 'sb-c');

    service.listRunningSandboxes.mockResolvedValue([
      vm('sb-keep', NOW),
      vm('sb-a', NOW - 900_000),
      vm('sb-b', NOW - 600_000),
      vm('sb-c', NOW - 300_000),
    ]);

    const timeline: string[] = [];
    let openTheGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openTheGate = resolve;
    });

    service.hibernateSandbox.mockImplementation(async (sandboxId: string) => {
      timeline.push(`enter:${sandboxId}`);

      if (timeline.filter((event) => event.startsWith('enter:')).length === 3) {
        openTheGate();
      }

      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 250))]);
      timeline.push(`exit:${sandboxId}`);
    });

    const hibernated = await enforceRunningVmCap({
      userId: 'user-1',
      keepSandboxId: 'sb-keep',
      cap: 1,
      context: {},
    });

    expect(hibernated).toEqual(['sb-a', 'sb-b', 'sb-c']);
    expect(service.hibernateSandbox).toHaveBeenCalledTimes(3);

    // All three were issued before the first one came back.
    expect(timeline.slice(0, 3)).toEqual(['enter:sb-a', 'enter:sb-b', 'enter:sb-c']);
  });

  it('uses the default cap when handed a nonsensical one, rather than sleeping everything', async () => {
    await projectWith('user-1', 'Older', 'sb-old');
    await projectWith('user-1', 'Newer', 'sb-new');

    service.listRunningSandboxes.mockResolvedValue([
      vm('sb-keep', NOW),
      vm('sb-new', NOW - 60_000),
      vm('sb-old', NOW - 900_000),
    ]);

    expect(await enforceRunningVmCap({ userId: 'user-1', keepSandboxId: 'sb-keep', cap: 0, context: {} })).toEqual([
      'sb-old',
    ]);
  });
});
