/**
 * The one operation that replaces the user's whole working tree (§4.13a T15).
 *
 * ## Why this file is the strictest in the feature
 *
 * `applyBranchTree` deletes files. Every other module in `github-branch-client` reads a provider, draws
 * a chip, or decides a label; this one takes a map it was handed and makes the project BE that map. So
 * the assertions here are about the two things that cannot be recovered from when they are wrong — the
 * checkpoint that is the only copy of what is about to be destroyed, and the `protect` rule that decides
 * whether the user still has their API keys afterwards — plus the `finally` that decides whether the
 * workspace is ever visible again.
 *
 * ## What is real, and why
 *
 * 🔴 **`~/lib/stores/boot-progress` is NOT mocked.** The acceptance criterion is a SEQUENCE — phases
 * raised once each, in order, none raised and taken down within a frame (the measured `importTailActive`
 * strobe: on 13424ms, off 13628, on 13801, off 14201). A mocked `bootProgress.set` records the calls
 * that were MADE; what these tests need is the state that RESULTS — every path must end with the
 * workspace uncovered, and that is a question about `endBootPhase`'s own logic running for real. The
 * real atom is a leaf (nanostores only), so using it costs nothing.
 *
 * ⚠️ This paragraph used to justify itself differently: that a mock "cannot show that `endBootPhase`
 * refuses to clear `failed`, which is the difference between test 1(b) and 1(c) and the entire reason
 * the failure surface survives long enough to be read". Both halves are now false — 1(b) and 1(c) both
 * assert `idle`, and there is no failure surface on this path (T18's review found by rendering that
 * nothing draws `failed` outside `BootScreen`'s `!ready` branch, which is why the module stopped
 * setting it). Left in, corrected, because it is the file's headline design decision and a reader who
 * stops at this section would otherwise leave with exactly the retired model.
 *
 * 🔴 **`checkpoint-run.ts`, `restore-plan.ts` and `workbench-settle.ts` are NOT mocked either**, for
 * `refresh-saved-copies.spec.ts`'s stated reason: a mocked `runCheckpointSerialize` proves which branch
 * this module takes on a `{kind:'failed'}` object it was handed, never that a serialize which actually
 * throws reaches that branch, and never that `{ strict: true }` is really passed through. A real
 * `protectForRepoRestore` is what lets test 5 compare by IDENTITY rather than by "some truthy function
 * was supplied".
 *
 * The heavy leaves are stubbed the way `refresh-saved-copies.spec.ts` stubs them: the workbench, the
 * chat-history atoms, the local snapshot store and the working-copy writer.
 *
 * ## Mutation verification (hand-discharged 2026-08-22)
 *
 * Each mutation was applied to `apply-branch-tree.ts`, the suite re-run, and the file restored and
 * `cmp`-verified byte-for-byte.
 *
 *   - remove `finally { endBootPhase(); }` → **8 fail** (all three paths, incl. the throw)
 *   - `protectForRepoRestore` → `protectNothing` → **2 fail**
 *   - `serializeFiles({ strict: true })` → `serializeFiles()` → **2 fail**
 *   - the server copy written under the BEFORE seq → **1 fail**
 *   - delete `markTreeReplaced(projectId)` → **2 fail**
 *   - add a `mountProjectFiles` identifier to the code → **1 fail**
 *   - `phaseFor` drops its `pull` case → **2 fail**
 *   - `reason` drops `failureFor` → **3 fail**
 *   - stamp `repoStatus` on every operation → **2 fail**
 *
 * ⚠️ **A MUTATION RECORD GOES STALE WHEN THE CODE IT MEASURED CHANGES, and a stale one is worse than
 * none.** This paragraph used to say the `finally` was a deliberate no-op on the throw path, because
 * `reportBootFailure` had already moved the phase to `failed` and `endBootPhase` refuses to clear
 * that — so removing it failed 1(a) and 1(c) but not 1(b), and no test could distinguish its absence.
 *
 * That was true and is now false. T18's review found by RENDERING that nothing draws `failed` on this
 * path at all (`shouldCoverWorkspace` returns false for it, and `BootFailurePanel` lives only in
 * `BootScreen`'s `!ready` branch), so the `catch` stopped calling `reportBootFailure` and the throw
 * path now genuinely needs the `finally` — measured, 8 failures. Left uncorrected, this note would
 * have told the next reader that a covered path is untestable, which is the most expensive kind of
 * wrong a comment can be.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { bootPhaseCopy, bootProgress, coversWorkspace, type BootPhase } from '~/lib/stores/boot-progress';
import { protectForRepoRestore, protectNothing } from './restore-plan';
import { clearTreeReplaced, isTreeReplaced, treeReplacedProject } from './tree-replacement-signal';

/* ------------------------------------------------------------------ the doubles */

const serializeFiles = vi.fn(async (_options?: { strict?: boolean }) => beforeFiles() as SerializedFileMap);
const restoreFiles = vi.fn(
  async (_files: SerializedFileMap, _options: { protect: (p: string) => boolean; onProgress?: any }) => undefined,
);
const resetAllFileModifications = vi.fn(() => undefined);
const clearDeletedPaths = vi.fn(() => undefined);

const createLocalSnapshot = vi.fn(async (_db: unknown, _input: any) => ({ id: 'snp', seq: 0 }) as any);
const markSynced = vi.fn(async (_db: unknown, _projectId: string) => undefined);
const writeWorkingCopyFromStore = vi.fn(async (_projectId: string, _seq: number) => 'saved' as string);
const unsavedWorkSet = vi.fn((_value: boolean) => undefined);
const ensureRunnableNow = vi.fn(async (_pid: string, _options: { onStep?: (step: string) => void } = {}) => 'started');

const toastWarn = vi.fn((_message: string) => undefined);

vi.mock('react-toastify', () => ({ toast: { warn: (m: string) => toastWarn(m) } }));

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    serializeFiles: (...args: unknown[]) => serializeFiles(...(args as [{ strict?: boolean }?])),
    restoreFiles: (...args: unknown[]) => restoreFiles(...(args as [SerializedFileMap, any])),
    resetAllFileModifications: () => resetAllFileModifications(),
    clearDeletedPaths: () => clearDeletedPaths(),

    /* The REAL `waitForWorkbenchActionsSettled` reads this. No artifacts = settled immediately. */
    artifacts: { get: () => ({}) },
  },
}));

vi.mock('./local-snapshots', () => ({
  createLocalSnapshot: (...args: unknown[]) => createLocalSnapshot(...(args as [unknown, any])),
  markSynced: (...args: unknown[]) => markSynced(...(args as [unknown, string])),
}));

vi.mock('./working-copy-writer', () => ({
  writeWorkingCopyFromStore: (...args: unknown[]) => writeWorkingCopyFromStore(...(args as [string, number])),
}));

/**
 * A real nanostore for the branch stamp, declared with `vi.hoisted` because `vi.mock` factories are
 * hoisted above the imports and would otherwise read it before initialisation.
 */
const { repoStatusStore } = vi.hoisted(() => {
  let value: { linked: boolean; branch?: string } | undefined;

  return {
    repoStatusStore: {
      get: () => value,
      set: (next: { linked: boolean; branch?: string } | undefined) => {
        value = next;
      },
    },
  };
});

vi.mock('./useChatHistory', () => ({
  unsavedWork: { set: (value: boolean) => unsavedWorkSet(value) },
  ensureRunnableNow: (...args: unknown[]) => ensureRunnableNow(...(args as [string, any])),
}));

/**
 * The BRANCH STAMP store (§4.13a T17), mocked at `./repo-status` — the module that actually declares
 * it.
 *
 * ⚠️ It is deliberately NOT mocked through `./useChatHistory`. That module RE-EXPORTS the atom, so a
 * mock there satisfies the import statement and the code under test still reaches the real one — a
 * spy that is wired up, green, and observing nothing. T17 moved the declaration precisely because two
 * modules needed one atom, and a spec that mocks the re-export instead of the declaration reproduces
 * the two-copies problem inside the test.
 *
 * A real store, not a spy, so the read-modify-write in the module under test behaves as it does live.
 */
vi.mock('./repo-status', () => ({
  repoStatus: repoStatusStore,
  branchForWorkingCopy: () => repoStatusStore.get()?.branch,
}));

/* ------------------------------------------------------------------ fixtures */

const PROJECT = 'prj_1';
const DB = {} as IDBDatabase;

/** What the project holds BEFORE the switch — including the `.env` that must survive it. */
function beforeFiles(): SerializedFileMap {
  return {
    '/home/project/src/main.ts': { type: 'file', content: 'export const before = 1;', isBinary: false, size: 24 },
    '/home/project/.env': { type: 'file', content: 'VITE_KEY=secret', isBinary: false, size: 15 },
  };
}

/** The branch's tree — deliberately a DIFFERENT shape, and with no `.env` (a repo never has one). */
function incomingFiles(): SerializedFileMap {
  return {
    'src/main.ts': { type: 'file', content: 'export const after = 2;', isBinary: false, size: 23 },
    'src/pages/Home.tsx': { type: 'file', content: 'export default function Home() {}', isBinary: false, size: 33 },
  };
}

/* ------------------------------------------------------------------ phase recording */

/** Every phase the REAL atom passed through during a test — `listen`, so the initial value is not one. */
let phases: BootPhase[] = [];
let unlisten: (() => void) | undefined;

/** The `step` names only, which is what the ordering assertions are about. */
function steps(): string[] {
  return phases.map((p) => p.step);
}

let applyBranchTree: typeof import('./apply-branch-tree').applyBranchTree;

beforeEach(async () => {
  /*
   * 🔴 `resetAllMocks`, NOT `clearAllMocks` — and this one bit on the first run.
   *
   * `clearAllMocks` clears `mock.calls` and leaves implementations queued by `mockImplementationOnce`
   * exactly where they were. A test whose SECOND `createLocalSnapshot` never happens (the throwing
   * restore, the failed serialize) therefore leaves its unused seq-6 implementation at the head of the
   * queue, and the next test's `withTwoCheckpoints()` hands out 6 then 5 — the before-checkpoint
   * reporting the after seq and vice versa. Both seq assertions failed, in the one direction that reads
   * like a defect in the module under test rather than in the fixture.
   */
  vi.resetAllMocks();

  /* Implementations, not just call counts — a reset removes them, so every one is restated. */
  serializeFiles.mockImplementation(async () => beforeFiles());
  restoreFiles.mockResolvedValue(undefined);
  createLocalSnapshot.mockImplementation(async (_db: unknown, _input: any) => ({ id: 'snp', seq: 0 }));
  markSynced.mockResolvedValue(undefined);
  writeWorkingCopyFromStore.mockResolvedValue('saved');
  ensureRunnableNow.mockResolvedValue('started');

  clearTreeReplaced();
  bootProgress.set({ step: 'idle' });

  phases = [];
  unlisten = bootProgress.listen((phase) => phases.push(phase));

  ({ applyBranchTree } = await import('./apply-branch-tree'));
});

afterEach(() => {
  unlisten?.();
  vi.useRealTimers();
});

/**
 * The ordinary success fixture: two checkpoints, distinct seqs, so "which seq reached the server copy"
 * is a question with a wrong answer available (test 8).
 */
function withTwoCheckpoints() {
  createLocalSnapshot
    .mockImplementationOnce(async () => ({ id: 'snp_before', seq: 5 }))
    .mockImplementationOnce(async () => ({ id: 'snp_after', seq: 6 }));
}

function run(overrides: Partial<Parameters<typeof applyBranchTree>[0]> = {}) {
  return applyBranchTree({
    projectId: PROJECT,
    files: incomingFiles(),
    branch: 'feature/hud',
    operation: 'switch',
    db: DB,
    ...overrides,
  });
}

/* ================================================================== 1. the finally */

describe('🔴 `endBootPhase()` runs on the success path, the throw path AND the abort path', () => {
  /*
   * That `finally` is the entire licence for covering the workspace. `bootProgress` is ONE SLOT, and a
   * phase raised with nothing guaranteed to bring it down is the 2026-08-03 hang — reported as *"it just
   * sits on this spinning screen"* over a project that was mounted and working perfectly well.
   */
  it('(a) success ends at idle', async () => {
    withTwoCheckpoints();

    const result = await run();

    expect(result).toMatchObject({ ok: true });
    expect(bootProgress.get()).toEqual({ step: 'idle' });
  });

  /**
   * 🔴 A FAILURE UNCOVERS AND RETURNS A SENTENCE — it does NOT park the phase on `failed`.
   *
   * This test used to assert `failed`, on the strength of the module calling `reportBootFailure`. A
   * review checked by RENDERING and found nothing draws that state on this path:
   * `shouldCoverWorkspace` is false for `failed` so `WorkspaceSplash` returns `null`, and
   * `BootFailurePanel` lives only inside `BootScreen`'s `!ready` branch — which a branch operation
   * never runs in. The phase was pinned on `failed` forever (`endBootPhase` refuses to clear it) with
   * nothing drawing it, which also blocked a LATER import's overlay, since `shouldCoverWorkspace`
   * tests `failed` before `importActive`.
   *
   * So the workspace is returned to the user and the explanation travels in `reason`, which the
   * callers render as a non-dismissing toast. Asserting the phase is `idle` is the half that keeps
   * the dead state from coming back.
   */
  it('(b) a throwing restore uncovers the workspace and returns a sentence', async () => {
    withTwoCheckpoints();
    restoreFiles.mockRejectedValue(new Error('sandbox connection closed'));

    const result = await run();

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('sandbox connection closed');

    const phase = bootProgress.get();
    expect(phase).toEqual({ step: 'idle' });

    /* The cover comes DOWN on a failure — a spinner over a dead workspace hides the sentence. */
    expect(coversWorkspace(phase)).toBe(false);
  });

  /**
   * 🔴 A FAILURE NAMES THE OPERATION THE USER ACTUALLY PERFORMED.
   *
   * The failure copy was one hardcoded "Could not finish switching to…" for all three doors, so a
   * failed DISCARD told the user it could not finish switching to a branch they had never asked to
   * move to. `spec/fail-loud.md` treats a refusal that names the wrong operation as the same class as
   * one that names no cause: the user cannot act on it, so they conclude the button is broken — and
   * the bug gets filed against whatever changed most recently, which is how Nodepod and CodeSandbox
   * were each blamed for a defect they had nothing to do with.
   *
   * All three are asserted TOGETHER, because any one alone passes for a different hardcoded string.
   */
  it.each([
    ['switch', /switching to feature\/hud/i, /discard|pull/i],
    ['discard', /discarding your changes on feature\/hud/i, /switching|pull/i],
    ['pull', /pulling feature\/hud/i, /switching|discard/i],
  ] as const)('(b2) a failed %s says so, and does not name another operation', async (operation, says, never) => {
    withTwoCheckpoints();
    restoreFiles.mockRejectedValue(new Error('sandbox connection closed'));

    const result = await run({ operation });

    /*
     * Read off the RETURNED reason, not off the boot phase — that is the string the callers put in
     * the toast, and after the fix above it is the only thing the user ever sees.
     */
    const message = (result as { reason: string }).reason;

    expect(message).toMatch(says);
    expect(message).not.toMatch(never);
  });

  /*
   * 🔴 THE IMPORTANT ONE. Step 2 aborts with an early `return`, not a throw — and an early return that
   * escapes the `finally` leaves the splash up over a project nothing is doing anything to, which is the
   * 2026-08-03 hang arriving through the one path that looks like careful error handling.
   */
  it('(c) an early return from a FAILED before-checkpoint still goes through the finally', async () => {
    vi.useFakeTimers();
    withTwoCheckpoints();
    serializeFiles.mockRejectedValue(new Error('Failed to read 22 binary file(s)'));

    const promise = run();
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('checkpoint');

    /* Not `failed` — this is a refusal, not a crash — and emphatically not left on `switching-branch`. */
    expect(bootProgress.get()).toEqual({ step: 'idle' });
    expect(steps()).toContain('switching-branch');
  });
});

/* ================================================================== 2. phase ordering */

describe('phases are raised once each, in order, with nothing strobing', () => {
  it('a switch narrates switching-branch -> files -> branch-install -> branch-serve -> idle', async () => {
    withTwoCheckpoints();
    ensureRunnableNow.mockImplementation(async (_pid: string, options: any = {}) => {
      options.onStep?.('waiting');
      options.onStep?.('installing');
      options.onStep?.('starting');

      return 'started';
    });
    restoreFiles.mockImplementation(async (_files: SerializedFileMap, options: any) => {
      options.onProgress?.(1, 2);
      options.onProgress?.(2, 2);
    });

    await run();

    /*
     * The branch rides ON the phase — `bootPhaseCopy` takes only the phase, so a name held anywhere
     * else cannot reach the heading the user checks before every file is replaced.
     */
    expect(phases[0]).toEqual({ step: 'switching-branch', branch: 'feature/hud' });

    /* Collapse consecutive repeats: `files` legitimately ticks per file. */
    const shape = steps().filter((step, index, all) => step !== all[index - 1]);
    expect(shape).toEqual(['switching-branch', 'files', 'branch-install', 'branch-serve', 'idle']);

    /* And the bar really got its counts, or `BootScreen` draws an empty one for the whole restore. */
    expect(phases.filter((p) => p.step === 'files')).toEqual([
      { step: 'files', done: 1, total: 2 },
      { step: 'files', done: 2, total: 2 },
    ]);
  });

  /*
   * 🔴 THE STROBE. Measured on the import tail: on 13424ms, off 13628, on 13801, off 14201 — a phase
   * raised, taken down and raised again reads as a broken screen. Collapsing consecutive repeats and
   * asserting the remainder is a SET of unique names is what catches a re-entry that a simple
   * "did it end at idle" check sails past.
   */
  it('no phase is raised, taken down, and raised again', async () => {
    withTwoCheckpoints();
    ensureRunnableNow.mockImplementation(async (_pid: string, options: any = {}) => {
      options.onStep?.('installing');
      options.onStep?.('starting');

      return 'started';
    });
    restoreFiles.mockImplementation(async (_files: SerializedFileMap, options: any) => options.onProgress?.(1, 1));

    await run();

    const shape = steps().filter((step, index, all) => step !== all[index - 1]);
    expect(new Set(shape).size).toBe(shape.length);
  });

  /*
   * A discard writes the same bytes by the same path and is the opposite intention — "undo what I did"
   * rather than "go somewhere else". The user who pressed the destructive button needs their own word
   * reflected back or they cannot tell they hit the right control.
   */
  /**
   * 🔴 EVERY DOOR OPENS ON ITS OWN PHASE — asserted as a TABLE, because the defect was a missing case.
   *
   * `phaseFor` was a two-arm ternary, so a PULL raised `switching-branch` and the user who pressed
   * Sync — or chose "use the version from my repository" — got a full-screen "Switching to trunk" for
   * thirty seconds while sitting on trunk. It is the largest surface in the product and it was the
   * fourth of four operation-varying strings to be given a `pull` case.
   *
   * Nothing caught it because the phase assertions were written per-operation for the two operations
   * that existed when they were written. A per-case test written against the cases somebody thought
   * of cannot see the case they did not — the `outbound-auth` sweep's mistake, in a ternary.
   */
  it.each([
    ['switch', 'feature/hud', 'switching-branch'],
    ['discard', 'main', 'discarding'],
    ['pull', 'trunk', 'pulling'],
  ] as const)('a %s opens on its own phase, carrying the branch', async (operation, branch, step) => {
    withTwoCheckpoints();

    await run({ operation, branch });

    expect(phases[0]).toEqual({ step, branch });
    expect(bootProgress.get()).toEqual({ step: 'idle' });
  });

  /**
   * 🔴 AND WHAT THE USER READS IS NOT ANOTHER OPERATION'S VERB.
   *
   * The phase name alone is not the defect — the COPY is. Asserted through the real `bootPhaseCopy`
   * rather than against the phase id, because that is the string on screen, and because a phase
   * correctly named `pulling` whose case fell through to the `default` arm would satisfy the test
   * above and still say "Opening project" for thirty seconds.
   */
  it.each([
    ['switch', 'feature/hud', /switching to feature\/hud/i, /updating from|discarding/i],
    ['discard', 'main', /discarding/i, /switching to|updating from/i],
    ['pull', 'trunk', /updating from trunk/i, /switching to|discarding/i],
  ] as const)('a %s says so on screen', async (operation, branch, says, never) => {
    withTwoCheckpoints();

    await run({ operation, branch });

    const copy = bootPhaseCopy(phases[0]);
    const words = `${copy.title} ${copy.detail}`;

    expect(words).toMatch(says);
    expect(words).not.toMatch(never);

    // CONTROL: not the `default` arm, which is plausible copy for any unhandled phase.
    expect(copy.title).not.toBe(bootPhaseCopy({ step: 'idle' }).title);
  });
});

/**
 * 🔴 ONLY A SWITCH MOVES THE BRANCH POINTER.
 *
 * `applyBranchTree` stamps `repoStatus` so the working-copy write (T17) carries the branch it just
 * landed rather than the one the server last reported. A discard and a pull change NO branch, so they
 * must not touch it — and the reason is sharper than tidiness: those two doors accept a DISPLAY string
 * and fall back to human sentences when the name is unknown ("the linked branch", "your repository").
 * Writing one of those into `repoStatus` puts prose into the field every branch comparison and the
 * working-copy stamp read.
 */
describe('the branch pointer moves only when the branch actually changed', () => {
  it('a switch stamps the branch it landed', async () => {
    withTwoCheckpoints();
    repoStatusStore.set({ linked: true, branch: 'main' });

    await run({ operation: 'switch', branch: 'feature/hud' });

    expect(repoStatusStore.get()?.branch).toBe('feature/hud');
  });

  /*
   * ⚠️ Neither fixture branch may EQUAL the one already in the store. The discard row originally
   * passed `'main'` into a store already holding `'main'`, so it passed for an implementation that
   * stamps on every operation — vacuous, and it survived the mutation that the pull row killed. A
   * fixture that cannot distinguish the two hypotheses is not a weak test, it is no test.
   */
  it.each([
    ['discard', 'release/2026'],
    ['pull', 'your repository'],
  ] as const)('a %s leaves it alone', async (operation, branch) => {
    withTwoCheckpoints();
    repoStatusStore.set({ linked: true, branch: 'main' });

    await run({ operation, branch });

    expect(repoStatusStore.get()?.branch).toBe('main');
  });
});

/* ================================================================== 3-4. the before-checkpoint */

describe('🔴 the before-checkpoint is STRICT and holds the pre-operation files', () => {
  /*
   * Every existing before-overwrite checkpoint in this codebase uses the LAX serialize
   * (`Messages.client.tsx`, `GitHubSyncButton.tsx`, `SaveDivergenceDialog.client.tsx`). That is right
   * for a map you are going to inspect or ship, and wrong for the only copy of what is about to be
   * destroyed: `serializeFileMap` OMITS a binary it cannot read, so a checkpoint written while
   * `havok.wasm` was unreadable restores a project with no physics engine — and the user finds out when
   * they press undo, the one moment they have no other option left.
   */
  it('serializes strictly', async () => {
    withTwoCheckpoints();

    await run();

    expect(serializeFiles).toHaveBeenCalledWith({ strict: true });
  });

  /*
   * CONTROL. `toHaveBeenCalledWith({strict:true})` above passes for an implementation that ALSO calls it
   * laxly somewhere, and the lax call is the one that would silently drop the binary. This asserts every
   * call, and that the bare zero-argument form — the shape of the existing doors — never happens.
   */
  it('CONTROL — it is never called laxly or with no arguments at all', async () => {
    withTwoCheckpoints();

    await run();

    expect(serializeFiles).not.toHaveBeenCalledWith();
    expect(serializeFiles).not.toHaveBeenCalledWith({ strict: false });
    expect(serializeFiles.mock.calls.every((call) => call[0]?.strict === true)).toBe(true);
  });

  /*
   * The checkpoint carries what is about to be DESTROYED — not the incoming tree. Getting this backwards
   * writes a perfectly valid checkpoint of the branch you just switched to, so undo restores the state
   * you are already in and the pre-switch project is gone with no error anywhere.
   */
  it('the checkpoint holds the pre-operation files, and undo points at it', async () => {
    withTwoCheckpoints();

    const result = await run();

    expect(createLocalSnapshot.mock.calls[0][1]).toMatchObject({
      projectId: PROJECT,
      files: beforeFiles(),
      label: 'Before switching to feature/hud',
    });

    /* The undo target is the BEFORE seq — the after-checkpoint is where you already are. */
    expect(result).toMatchObject({ ok: true, undoSeq: 5 });
  });

  it('a discard labels its checkpoint for the discard, not for a switch', async () => {
    withTwoCheckpoints();

    await run({ operation: 'discard', branch: 'main' });

    expect(createLocalSnapshot.mock.calls[0][1].label).toBe('Before discarding changes on main');
  });
});

describe('a failed before-checkpoint aborts the operation and writes NOTHING', () => {
  /*
   * 🔴 Refusing to switch is recoverable; switching without a way back is not. The whole point of the
   * strict serialize is undermined if a failure is treated as "carry on with a smaller map".
   */
  it('does not restore, does not checkpoint, does not sync, does not upload', async () => {
    vi.useFakeTimers();
    serializeFiles.mockRejectedValue(new Error('Failed to read 22 binary file(s)'));

    const promise = run();
    await vi.runAllTimersAsync();

    const result = await promise;

    expect(result.ok).toBe(false);
    expect(restoreFiles).not.toHaveBeenCalled();
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
    expect(markSynced).not.toHaveBeenCalled();
    expect(unsavedWorkSet).not.toHaveBeenCalled();
    expect(resetAllFileModifications).not.toHaveBeenCalled();
  });

  /* The sentence has to say the project was left alone, or the user re-presses the destructive button. */
  it('says nothing was changed', async () => {
    vi.useFakeTimers();
    serializeFiles.mockRejectedValue(new Error('nope'));

    const promise = run();
    await vi.runAllTimersAsync();

    expect(((await promise) as { reason: string }).reason).toContain('nothing was changed');
  });
});

/* ================================================================== 5. protect */

describe('🔴 the restore protects the secrets — `protectForRepoRestore`, never `protectNothing`', () => {
  /*
   * A repo map has no `.env`: `isSecretPath` kept the whole family out of every push. So its absence
   * says "never sent", not "deleted", and `protectNothing` here DELETES the user's API keys — the one
   * class of file on disk with no other copy anywhere, and not remotely what they asked for.
   */
  it('passes the real `protectForRepoRestore`', async () => {
    withTwoCheckpoints();

    await run();

    expect(restoreFiles).toHaveBeenCalledTimes(1);

    const options = restoreFiles.mock.calls[0][1];

    /*
     * Identity, not "a function was supplied": a private lambda that happens to protect `.env` today is
     * the second copy of the secret rule that `isSecretPath`'s own history exists to forbid.
     */
    expect(options.protect).toBe(protectForRepoRestore);
  });

  /*
   * CONTROL for the assertion above. Asserting `protect('.env') === true` alone would pass for any
   * truthy-returning function, so this pins that the two candidates genuinely disagree about the file
   * whose loss is unrecoverable — i.e. that the choice is doing work.
   */
  it('CONTROL — the two candidates disagree about `.env`, so the choice is real', async () => {
    withTwoCheckpoints();

    await run();

    const protect = restoreFiles.mock.calls[0][1].protect as (p: string) => boolean;

    expect(protect('.env')).toBe(true);
    expect(protect('.env.production')).toBe(true);
    expect(protectNothing()).toBe(false);

    /*
     * …and it protects ONLY the secrets — a protect that returned true for everything would delete
     * nothing, i.e. turn the restore back into the overlay `restore-plan.ts` exists to fix.
     */
    expect(protect('src/main.ts')).toBe(false);
  });

  it('the incoming tree is what gets restored', async () => {
    withTwoCheckpoints();

    await run();

    expect(restoreFiles.mock.calls[0][0]).toEqual(incomingFiles());
  });
});

/* ================================================================== 6-8. the steps after the restore */

describe('the per-tree state the replacement made false is invalidated, in order', () => {
  /*
   * T12. Both are silent when missed: a stale modification baseline makes every later `type="edit"` a
   * diff against a tree that no longer exists, and a retained deleted-path set suppresses files that ARE
   * on disk — including the ones this restore's own deletion pass just recorded.
   *
   * Ordering is the half a "was it called" assertion cannot see: invalidating BEFORE the restore clears
   * state the restore is about to make stale again, which passes every call-count check.
   */
  it('resets modifications and clears deleted paths AFTER the restore and BEFORE the post-checkpoint', async () => {
    withTwoCheckpoints();

    await run();

    expect(resetAllFileModifications).toHaveBeenCalledTimes(1);
    expect(clearDeletedPaths).toHaveBeenCalledTimes(1);

    const restored = restoreFiles.mock.invocationCallOrder[0];
    const reset = resetAllFileModifications.mock.invocationCallOrder[0];
    const cleared = clearDeletedPaths.mock.invocationCallOrder[0];
    const postCheckpoint = createLocalSnapshot.mock.invocationCallOrder[1];

    expect(restored).toBeLessThan(reset);
    expect(restored).toBeLessThan(cleared);
    expect(reset).toBeLessThan(postCheckpoint);
    expect(cleared).toBeLessThan(postCheckpoint);
  });
});

describe('the post-mount triple — checkpoint, markSynced, unsavedWork(false)', () => {
  /*
   * Exactly as `mountFromRepo` performs it. Skipping `markSynced` leaves `localSeq > syncedSeq`, so the
   * chip reports unsaved work on a tree that is byte-identical to the branch it was just read from —
   * the one message guaranteed to make a user press the destructive button a second time.
   */
  it('checkpoints the incoming tree, marks synced, and clears unsaved work — in that order', async () => {
    withTwoCheckpoints();

    await run();

    expect(createLocalSnapshot).toHaveBeenCalledTimes(2);
    expect(createLocalSnapshot.mock.calls[1][1]).toMatchObject({
      projectId: PROJECT,
      files: incomingFiles(),
      label: 'Switched to feature/hud',
    });

    expect(markSynced).toHaveBeenCalledWith(DB, PROJECT);
    expect(unsavedWorkSet).toHaveBeenCalledWith(false);

    expect(createLocalSnapshot.mock.invocationCallOrder[1]).toBeLessThan(markSynced.mock.invocationCallOrder[0]);
    expect(markSynced.mock.invocationCallOrder[0]).toBeLessThan(unsavedWorkSet.mock.invocationCallOrder[0]);
  });

  /*
   * CONTROL — `unsavedWork` is set to false and never back to true. `refreshSavedCopiesSoon` ends with
   * `set(true)`, which is precisely why step 6 uses the writer directly and not that helper: it would
   * contradict this line one statement above it, on a tree with nothing unsaved.
   */
  it('CONTROL — unsavedWork is never flipped back to true', async () => {
    withTwoCheckpoints();

    await run();

    expect(unsavedWorkSet).not.toHaveBeenCalledWith(true);
  });

  /**
   * 🔴 THE LANDED CHECKPOINT NAMES THE OPERATION THE USER PERFORMED — all three, together.
   *
   * This is the entry they read in the §4.12 undo list, and it was a two-arm ternary that sent `pull`
   * to the SWITCH wording: after T18 converged the doors, a Pull wrote "Switched to trunk" for an
   * operation the user performed as *use the version from my repository*. The hand-rolled code T18
   * replaced said "Pulled from GitHub", so the convergence would have lost it.
   *
   * All three are asserted in ONE table because any single case passes for a different hardcoded
   * string, and because the defect was precisely a missing case — a per-case test written for the two
   * cases somebody had thought of is the shape that let it through. Each also asserts it does NOT
   * carry another operation's verb, which is what a fall-through looks like from the outside.
   */
  it.each([
    ['switch', 'feature/hud', /switched to feature\/hud/i, /discard|updated from/i],
    ['discard', 'main', /discarded/i, /switched|updated from/i],
    ['pull', 'trunk', /updated from trunk/i, /switched|discarded/i],
  ] as const)('a %s labels the landed checkpoint as one', async (operation, branch, says, never) => {
    withTwoCheckpoints();

    await run({ operation, branch });

    const label = createLocalSnapshot.mock.calls[1][1].label as string;

    expect(label).toMatch(says);
    expect(label).not.toMatch(never);
  });
});

describe('the server working copy is written under the POST checkpoint seq', () => {
  /*
   * 🔴 A real trap, and the mirror of the `refresh-saved-copies` defect. `selectMountSource` branches on
   * the local checkpoint, and `unsavedWork` is `localSeq > syncedSeq` — a server copy filed under the
   * BEFORE seq describes the pre-switch project under a number the post-switch project already passed.
   * Two distinct seqs in the fixture is what makes the wrong answer available at all.
   */
  it('uses the seq of the second snapshot, not the first', async () => {
    withTwoCheckpoints();

    await run();

    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][0]).toBe(PROJECT);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(6);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).not.toBe(5);
  });

  /*
   * Edge case 12. An over-budget project keeps its LOCAL checkpoint and skips only the server copy — and
   * SAYS so, because a recovery capability that is quietly off is the degraded-capability-reports-ON
   * failure (`spec/fail-loud.md` rule 2).
   */
  it('reports a size-gated skip rather than swallowing it', async () => {
    withTwoCheckpoints();
    writeWorkingCopyFromStore.mockResolvedValue('skipped-too-large');

    const result = await run();

    expect(result).toMatchObject({ ok: true, serverCopySkipped: true });
    expect(toastWarn).toHaveBeenCalledTimes(1);
    expect(toastWarn.mock.calls[0][0]).toContain('crash recovery');
  });

  it('CONTROL — an ordinary save reports no skip and warns nobody', async () => {
    withTwoCheckpoints();

    const result = await run();

    expect(result).toMatchObject({ ok: true, serverCopySkipped: false });
    expect(toastWarn).not.toHaveBeenCalled();
  });

  /*
   * A browser with no local history (`db` absent) still switches — it just has no undo and nothing to
   * file the server copy under. Refusing here would make the feature unavailable in a private window.
   */
  it('without a local database it still restores, and skips both checkpoints', async () => {
    const result = await run({ db: undefined });

    expect(result).toMatchObject({ ok: true, undoSeq: undefined });
    expect(restoreFiles).toHaveBeenCalledTimes(1);
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
  });
});

/* ================================================================== 9. the suppression signal */

describe('🔴 the tree replacement is signalled to the §4.2.8 request invariant', () => {
  /*
   * INV-3(b) flags a manifest that shrinks sharply within one chat, which is precisely the shape of a
   * legitimate switch — 90 files to 60, every single time. Without this, every branch switch a user makes
   * pages someone, and an alert that fires on a routine operation mutes the channel in week one.
   */
  it('marks the project after a successful apply', async () => {
    withTwoCheckpoints();

    await run();

    expect(isTreeReplaced(treeReplacedProject.get(), PROJECT)).toBe(true);
  });

  /* CONTROL — a single slot, not a blanket. A different project's next turn is still checked. */
  it('CONTROL — a different project is not marked', async () => {
    withTwoCheckpoints();

    await run();

    expect(isTreeReplaced(treeReplacedProject.get(), 'prj_other')).toBe(false);
    expect(isTreeReplaced(treeReplacedProject.get(), undefined)).toBe(false);
  });

  /*
   * CONTROL — a FAILED apply marks nothing. The tree did not change, so suppressing the next turn's
   * check would mute a real signal about a project nothing deliberately replaced.
   */
  it('CONTROL — a failed apply marks nothing', async () => {
    withTwoCheckpoints();
    restoreFiles.mockRejectedValue(new Error('sandbox connection closed'));

    await run();

    expect(isTreeReplaced(treeReplacedProject.get(), PROJECT)).toBe(false);
  });

  /*
   * It is emitted BEFORE the install, so a failed install cannot lose it — the tree really was replaced
   * whatever `npm install` did next.
   */
  it('survives an install that blows up', async () => {
    withTwoCheckpoints();
    ensureRunnableNow.mockRejectedValue(new Error('npm exploded'));

    await run();

    expect(isTreeReplaced(treeReplacedProject.get(), PROJECT)).toBe(true);
  });
});

/* ================================================================== 10. reinstall + restart */

describe('the reinstall is awaited, narrated, and not allowed to fail the switch', () => {
  it('raises branch-install then branch-serve from the runnable steps', async () => {
    withTwoCheckpoints();
    ensureRunnableNow.mockImplementation(async (_pid: string, options: any = {}) => {
      options.onStep?.('installing');
      expect(bootProgress.get()).toEqual({ step: 'branch-install' });
      options.onStep?.('starting');
      expect(bootProgress.get()).toEqual({ step: 'branch-serve' });

      return 'started';
    });

    await run();

    expect(ensureRunnableNow).toHaveBeenCalledTimes(1);
    expect(ensureRunnableNow.mock.calls[0][0]).toBe(PROJECT);
  });

  /*
   * 🔴 An install PROBLEM is not a failed switch: the tree landed, the checkpoints are written, the
   * pointer is correct. Refusing here would tell the user their branch did not switch when it did — and
   * would leave the phase on `failed`, covering a workspace that is in fact perfectly usable.
   */
  it('a rejected install still reports success and still ends at idle', async () => {
    withTwoCheckpoints();
    ensureRunnableNow.mockRejectedValue(new Error('install failed'));

    const result = await run();

    expect(result).toMatchObject({ ok: true, undoSeq: 5 });
    expect(bootProgress.get()).toEqual({ step: 'idle' });
  });
});

/* ================================================================== 11. the empty-map refusal */

describe('🔴 an empty incoming map is refused BEFORE the phase goes up', () => {
  /*
   * `planRestore` declines an empty incoming map by design ("a restore is never a wipe"), so handing one
   * through would restore nothing, delete nothing, and report success — the operation silently not
   * happening while the UI says it did. Refused here, with a sentence, before there is any cover to take
   * down.
   */
  it('returns a reason naming the branch, raises no phase, and restores nothing', async () => {
    const result = await run({ files: {} });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('feature/hud');

    /* Not "ended at idle" — never LEFT idle. A phase raised and cleared inside one call is the strobe. */
    expect(phases).toEqual([]);
    expect(bootProgress.get()).toEqual({ step: 'idle' });

    expect(restoreFiles).not.toHaveBeenCalled();
    expect(serializeFiles).not.toHaveBeenCalled();
    expect(createLocalSnapshot).not.toHaveBeenCalled();
    expect(isTreeReplaced(treeReplacedProject.get(), PROJECT)).toBe(false);
  });
});

/* ================================================================== 12. binary byte-identity */

describe('🔴 binary bytes survive the operation unchanged', () => {
  /*
   * SPEC §1.3 principle 10 / `spec/binary-files.md`. Every path a file takes carries its bytes
   * losslessly, and this one hands a whole tree to a filesystem writer. A re-encode, a `toString()`, a
   * truncation of a multi-megabyte entry — none of them throw; the project simply stops running and the
   * user is told the switch succeeded.
   *
   * The hashes are computed from the fixture's strings BEFORE the call (strings are immutable, so they
   * are a genuine before-image even if the map is passed by reference) and re-computed from what
   * `restoreFiles` was actually handed.
   */
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');

  /** A real 1x1 PNG, and a 2 MiB `.wasm` — the `havok.wasm` size class the strict serialize exists for. */
  function binaryTree(): SerializedFileMap {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    const wasm = Buffer.alloc(2 * 1024 * 1024);

    for (let i = 0; i < wasm.length; i++) {
      wasm[i] = (i * 31 + 7) % 256;
    }

    return {
      'public/babylon.png': { type: 'file', content: png.toString('base64'), isBinary: true, size: png.length },
      'public/havok.wasm': { type: 'file', content: wasm.toString('base64'), isBinary: true, size: wasm.length },
      'src/main.ts': { type: 'file', content: 'export const x = 1;', isBinary: false, size: 19 },
    };
  }

  it('a PNG and a multi-MB wasm are sha256-identical before and after', async () => {
    withTwoCheckpoints();

    const files = binaryTree();
    const before = {
      png: sha((files['public/babylon.png'] as { content: string }).content),
      wasm: sha((files['public/havok.wasm'] as { content: string }).content),
    };

    await run({ files });

    const handed = restoreFiles.mock.calls[0][0];
    const after = {
      png: sha((handed['public/babylon.png'] as { content: string }).content),
      wasm: sha((handed['public/havok.wasm'] as { content: string }).content),
    };

    expect(after).toEqual(before);

    /*
     * The `isBinary` flag and the byte count travel too — a base64 string arriving marked text is
     * written back as UTF-8 and is corrupt in a way no hash of the string alone would notice.
     */
    expect(handed['public/havok.wasm']).toMatchObject({ isBinary: true, size: 2 * 1024 * 1024 });

    /* CONTROL — the fixture really is multi-megabyte, so this is not a hash of two empty strings. */
    expect((handed['public/havok.wasm'] as { content: string }).content.length).toBeGreaterThan(2_000_000);
  });

  /* …and the SAME bytes reach the checkpoint that is the record of the tree that landed. */
  it('the post-checkpoint carries the same bytes', async () => {
    withTwoCheckpoints();

    const files = binaryTree();
    const before = sha((files['public/havok.wasm'] as { content: string }).content);

    await run({ files });

    const checkpointed = createLocalSnapshot.mock.calls[1][1].files;
    expect(sha(checkpointed['public/havok.wasm'].content)).toBe(before);
  });
});

/* ================================================================== 13. the source-level wall */

describe('🔴 this module never reaches for the mount', () => {
  /*
   * Reusing `mountProjectFiles` is the obvious-looking refactor and it silently NO-OPS the switch twice
   * over: `mountedThisLoad` short-circuits a project already mounted this page load, and
   * `decideLiveSandboxIsTruth` returns `true` for `local`/`diverged`/`working`, which makes the mount
   * call `refreshFiles()` instead of restoring. The user would press Switch, watch a splash, and end up
   * on the same branch with a different label — and nothing would throw.
   *
   * Comments are stripped FIRST: the module's own doc comment names `mountProjectFiles` to explain why
   * it must not be used, and a gate that fires on its own explanation forces someone to delete the
   * warning to make the suite green.
   */
  const SOURCE = join(process.cwd(), 'app/lib/persistence/apply-branch-tree.ts');

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('contains no reference to `mountProjectFiles`', () => {
    const code = stripComments(readFileSync(SOURCE, 'utf8'));

    expect(code).not.toContain('mountProjectFiles');
  });

  /*
   * CONTROL. A scanner that silently matches nothing reports a clean bill of health forever — the
   * `no-server-storage.spec.ts` lesson. This proves the file was read, the strip left the code intact,
   * and the search would find a call if one were there.
   */
  it('CONTROL — the scanner still sees the code it is scanning', () => {
    const raw = readFileSync(SOURCE, 'utf8');
    const code = stripComments(raw);

    expect(code).toContain('restoreFiles');
    expect(code).toContain('endBootPhase');

    /* …and the strip really removed the doc comment that mentions the forbidden name. */
    expect(raw).toContain('mountProjectFiles');
    expect(code.length).toBeLessThan(raw.length);
  });
});
