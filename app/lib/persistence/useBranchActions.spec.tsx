// @vitest-environment jsdom
/**
 * THE BRANCH ACTIONS HOOK — the wiring between the server, the decision cores and the ONE apply path
 * (§4.13a, T19).
 *
 * The hook contains no rule of its own, and that is exactly why it needs behavioural tests rather than
 * a source scan: every defect available here is a *routing* defect, and each one is silent.
 *
 *   - a switch that proceeds instead of asking replaces the user's whole working tree with someone
 *     else's branch and reports success;
 *   - a create that touches the tree discards precisely the in-progress work the user branched to
 *     protect — requirement 34, and the whole point of the feature;
 *   - a delete that reaches the network before its local refusal turns a courtesy into a round trip
 *     whose answer the user cannot act on;
 *   - a failure reported through an auto-closing toast is a failure nobody read.
 *
 * ## The instrument
 *
 * `renderHook` against the real hook, with the SEAMS mocked and the DECISION CORES real. Mocking
 * `decideBranchSwitch` would test that the hook calls a mock; leaving it real means "unsaved work is a
 * question, never an overwrite" is asserted through the code that will actually run. `applyBranchTree`
 * IS mocked — it boots a sandbox and takes checkpoints, and here its value is that ZERO calls to it is
 * an assertion (tests 11 and 7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

/**
 * Everything a `vi.mock` factory closes over must be HOISTED with it — the factories are lifted above
 * the file body, so a plain `const` above them is still in its temporal dead zone when they run.
 */
const seams = vi.hoisted(() => ({
  db: { name: 'boltHistory' } as unknown as IDBDatabase,

  applyBranchTree: vi.fn(),

  listBranches: vi.fn(),
  switchBranch: vi.fn(),
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
  discardChanges: vi.fn(),
  readBranchTree: vi.fn(),
  listCommits: vi.fn(),

  /**
   * The sandbox side of the review comparison.
   *
   * `workbenchStore.files` is a getter here rather than an atom because the hook only ever reads it,
   * and a plain container keeps the fixture in the test's hands: `seams.localFiles = {...}` is the
   * whole setup. `readBinaryFile` is the seam whose ABSENCE is the silent defect test 2 exists for.
   */
  localFiles: {} as Record<string, unknown>,
  readBinaryFile: vi.fn(),

  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

/* `~/lib/persistence` re-exports `useChatHistory`, which boots a sandbox at import time. */
/**
 * The owner's 2026-08-22 branch-delete switch, made drivable.
 *
 * ⚠️ Default `open: false` delegates to the REAL gate, so the switch is asserted against production
 * behaviour rather than a mock of it. The suite below opens it to keep the per-branch protections
 * under test while the feature is off — suspending a capability must not retire the coverage of the
 * rules that make restoring it safe.
 */
const branchDeleteGate = vi.hoisted(() => ({ open: false }));

vi.mock('./branch-delete', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./branch-delete')>();

  return {
    ...actual,
    branchDeleteAvailability: () => (branchDeleteGate.open ? { ok: true } : actual.branchDeleteAvailability()),
  };
});

vi.mock('~/lib/persistence', async () => {
  const { atom: makeAtom } = await import('nanostores');

  return { projectId: makeAtom<string | undefined>('prj_1') };
});

vi.mock('~/lib/persistence/useChatHistory', async () => {
  const { atom: makeAtom } = await import('nanostores');

  return {
    db: seams.db,
    repoStatus: makeAtom<{ linked: boolean; branch?: string; provider?: string } | undefined>(undefined),
    unsavedWork: makeAtom<boolean>(false),
  };
});

vi.mock('~/lib/persistence/apply-branch-tree', () => ({ applyBranchTree: seams.applyBranchTree }));

vi.mock('~/lib/persistence/projects', () => ({
  listBranches: seams.listBranches,
  switchBranch: seams.switchBranch,
  createBranch: seams.createBranch,
  deleteBranch: seams.deleteBranch,
  discardChanges: seams.discardChanges,
  readBranchTree: seams.readBranchTree,
  listCommits: seams.listCommits,
}));

/*
 * ⚠️ `~/lib/stores/workbench` boots a sandbox at import time — the module graph the whole file is
 * mocked to avoid. `review()` reads `files.get()` and `readBinaryFile` from it, and `compareTrees`
 * itself is left REAL: mocking the comparison would test that the hook calls a mock, where the
 * property that matters is that the reader it supplies changes the ANSWER.
 */
vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    files: { get: () => seams.localFiles },
    readBinaryFile: seams.readBinaryFile,
  },
}));

vi.mock('react-toastify', () => ({
  toast: { error: seams.toastError, info: seams.toastInfo, success: seams.toastSuccess },
}));

import { useBranchActions } from './useBranchActions';
import { streamingState } from '~/lib/stores/streaming';
import { repoStatus, unsavedWork } from './useChatHistory';
import { saveState } from './save-queue';
import { projectId } from '~/lib/persistence';
import { bytesToBase64 } from '~/lib/binary/binary-files';

/** One file, so "the tree that was applied is the tree the server returned" is checkable. */
const TREE = { 'src/main.ts': { type: 'file', content: 'from the branch', isBinary: false } } as never;

const BRANCHES = [
  { name: 'main', head: 'a1', isDefault: true, protected: true },
  { name: 'feature/boost-pads', head: 'b2', isDefault: false, protected: false },
  { name: 'feature/skins', head: 'c3', isDefault: false, protected: false },
];

beforeEach(() => {
  vi.clearAllMocks();

  projectId.set('prj_1');
  repoStatus.set({ linked: true, provider: 'github', branch: 'main' });
  unsavedWork.set(false);
  saveState.set({ status: 'idle' });

  seams.applyBranchTree.mockResolvedValue({ ok: true });
  seams.listBranches.mockResolvedValue({ ok: true, branches: BRANCHES });
  seams.switchBranch.mockResolvedValue({ ok: true, files: TREE, branch: 'feature/boost-pads' });
  seams.discardChanges.mockResolvedValue({ ok: true, files: TREE, branch: 'main' });
  seams.createBranch.mockResolvedValue({ ok: true });
  seams.deleteBranch.mockResolvedValue({ ok: true });

  seams.localFiles = {};
  seams.readBranchTree.mockResolvedValue({ ok: true, files: {}, branch: 'main' });
  seams.listCommits.mockResolvedValue({ ok: true, commits: [] });
  seams.readBinaryFile.mockResolvedValue(new Uint8Array());
});

afterEach(() => cleanup());

/** Render the hook and hand back a getter, because every action replaces the returned object. */
function actions() {
  const { result } = renderHook(() => useBranchActions());

  return result;
}

describe('switching branches', () => {
  /**
   * 🔴 UNSAVED WORK IS A QUESTION, NEVER AN OVERWRITE (§4.13 divergence discipline, requirement 30).
   *
   * The strongest assertion here is the NEGATIVE one: nothing was applied. A hook that returned a
   * prompt AND started the switch would look correct in every screenshot and would have destroyed the
   * user's work before they answered.
   */
  it('returns a prompt and touches NOTHING when there is unsaved work', async () => {
    unsavedWork.set(true);

    const result = actions();

    let prompt: { branch: string; reason: string } | undefined;

    await act(async () => {
      prompt = await result.current.switchTo('feature/boost-pads');
    });

    expect(prompt?.branch).toBe('feature/boost-pads');
    expect(prompt?.reason).toContain('feature/boost-pads');
    expect(seams.switchBranch).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });

  /**
   * Already there. A full restore would rewrite every file, restart Vite and reinstall dependencies to
   * arrive exactly where it started — 30 seconds of destruction-and-rebuild whose only effect is risk.
   */
  it('is a no-op that SAYS SO when the user picks the branch they are already on', async () => {
    const result = actions();

    let prompt: unknown;

    await act(async () => {
      prompt = await result.current.switchTo('main');
    });

    expect(prompt).toBeUndefined();
    expect(seams.toastInfo).toHaveBeenCalledWith(expect.stringContaining('main'));
    expect(seams.switchBranch).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });

  /** The CONTROL: a clean tree goes straight through, server first, then the ONE apply path. */
  it('reads the branch and applies it through applyBranchTree when the tree is clean', async () => {
    const result = actions();

    await act(async () => {
      await result.current.switchTo('feature/boost-pads');
    });

    expect(seams.switchBranch).toHaveBeenCalledWith('prj_1', 'feature/boost-pads');
    expect(seams.applyBranchTree).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_1',
        files: TREE,
        branch: 'feature/boost-pads',
        operation: 'switch',
        db: seams.db,
      }),
    );
  });

  /**
   * The answered prompt. It does NOT discard and then switch — that would be two tree replacements and
   * two installs for one intention. The switch already replaces every file, so "discard" is exactly
   * what not keeping the local ones means, and the work stays recoverable from `applyBranchTree`'s
   * strict before-checkpoint.
   */
  it('switchDiscardingChanges applies immediately, without asking again', async () => {
    unsavedWork.set(true);

    const result = actions();

    await act(async () => {
      await result.current.switchDiscardingChanges('feature/boost-pads');
    });

    expect(seams.switchBranch).toHaveBeenCalledWith('prj_1', 'feature/boost-pads');
    expect(seams.applyBranchTree).toHaveBeenCalledTimes(1);
    expect(seams.applyBranchTree.mock.calls[0][0]).toMatchObject({ operation: 'switch' });
  });

  /**
   * 🔴 A FAILED TREE REPLACEMENT IS A PERSISTENT TOAST. There is no failure panel on this path, so the
   * toast is the whole report — and an auto-closing one is a report that was never read, on the
   * operation most likely to leave the user unsure what state their project is in.
   */
  it('reports a failed apply in a toast that does not disappear', async () => {
    seams.applyBranchTree.mockResolvedValue({ ok: false, reason: 'Could not finish switching to feature/boost-pads' });

    const result = actions();

    await act(async () => {
      await result.current.switchTo('feature/boost-pads');
    });

    expect(seams.toastError).toHaveBeenCalledWith(
      'Could not finish switching to feature/boost-pads',
      expect.objectContaining({ autoClose: false }),
    );
  });

  /** The same rule one layer earlier: a branch the server could not READ is just as persistent. */
  it('reports an unreadable branch in a toast that does not disappear', async () => {
    seams.switchBranch.mockResolvedValue({ ok: false, message: 'Could not read that branch.' });

    const result = actions();

    await act(async () => {
      await result.current.switchTo('feature/boost-pads');
    });

    expect(seams.toastError).toHaveBeenCalledWith('Could not read that branch.', { autoClose: false });
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });
});

describe('creating a branch', () => {
  /**
   * 🔴 REQUIREMENT 34, AND THE WHOLE FEATURE: a create performs NO tree operation. The in-progress work
   * carries onto the new branch. A restore here would discard exactly what the user was protecting by
   * branching — and it would look like a working feature, because the files would still be *a* valid
   * project.
   */
  it('touches no file at all — the work comes with you', async () => {
    unsavedWork.set(true);

    const result = actions();

    await act(async () => {
      await result.current.create('feature/skins');
    });

    expect(seams.createBranch).toHaveBeenCalledWith('prj_1', 'feature/skins');
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
    expect(seams.switchBranch).not.toHaveBeenCalled();
    expect(seams.discardChanges).not.toHaveBeenCalled();
  });

  /** The pointer moved server-side, so the local view must follow or the chip names the branch you left. */
  it('moves the local branch pointer to the new branch', async () => {
    const result = actions();

    await act(async () => {
      await result.current.create('feature/skins');
    });

    expect(repoStatus.get()?.branch).toBe('feature/skins');
    expect(seams.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('feature/skins'));
  });

  /**
   * A collision is an EDITABLE refusal, not a dead end and not a silent `-2`. The dialog keeps the
   * typed name; the hook's job is to say which kind of failure it was so the dialog can.
   */
  it('reports a name collision as a collision, and does NOT move the pointer', async () => {
    seams.createBranch.mockResolvedValue({ ok: false, kind: 'name-taken', message: 'feature/skins already exists.' });

    const result = actions();

    let outcome: { ok: boolean; nameTaken?: boolean } | undefined;

    await act(async () => {
      outcome = await result.current.create('feature/skins');
    });

    expect(outcome).toMatchObject({ ok: false, nameTaken: true });
    expect(repoStatus.get()?.branch).toBe('main');
    expect(seams.toastSuccess).not.toHaveBeenCalled();
  });

  /** The CONTROL for the field above: an ordinary failure must not be reported as a collision. */
  it('does not call every failure a collision', async () => {
    seams.createBranch.mockResolvedValue({ ok: false, kind: 'unavailable', message: 'GitHub is unreachable.' });

    const result = actions();

    let outcome: { ok: boolean; nameTaken?: boolean } | undefined;

    await act(async () => {
      outcome = await result.current.create('feature/skins');
    });

    expect(outcome).toMatchObject({ ok: false, nameTaken: false });
  });
});

describe('discarding changes', () => {
  /**
   * 🔴 UNLINKED IS A REFUSAL THAT NAMES THE MISSING LINK. Discard means "go back to the saved version",
   * and an unlinked project has no saved version — the only interpretation available to a best-effort
   * implementation is emptying the project, which is the most destructive thing this codebase could do,
   * arrived at by treating a missing precondition as a default.
   */
  it('refuses on an unlinked project, and reaches no server', async () => {
    repoStatus.set({ linked: false });
    unsavedWork.set(true);

    const result = actions();

    await act(async () => {
      await result.current.discard();
    });

    expect(seams.toastError).toHaveBeenCalledWith(expect.stringContaining('not saved to a repository'));
    expect(seams.discardChanges).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });

  /** The CONTROL: with a link and something to discard, it goes through the one apply path. */
  it('reads the branch back and applies it as a discard', async () => {
    unsavedWork.set(true);

    const result = actions();

    await act(async () => {
      await result.current.discard();
    });

    expect(seams.discardChanges).toHaveBeenCalledWith('prj_1');
    expect(seams.applyBranchTree).toHaveBeenCalledWith(expect.objectContaining({ operation: 'discard', files: TREE }));
  });

  /**
   * Nothing to discard is REPORTED, not performed. A "successful" discard that replaces the tree with a
   * byte-identical copy still restarts the dev server and reinstalls dependencies, so the user watches
   * 30 seconds of work happen and cannot tell whether anything was lost.
   */
  it('says there is nothing to discard rather than rebuilding an identical tree', async () => {
    const result = actions();

    await act(async () => {
      await result.current.discard();
    });

    expect(seams.toastInfo).toHaveBeenCalledWith(expect.stringContaining('nothing to discard'));
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });
});

describe('deleting a branch', () => {
  /* These assert WHICH branch may be deleted; the feature switch has its own suite below. */
  beforeEach(() => {
    branchDeleteGate.open = true;
  });

  afterEach(() => {
    branchDeleteGate.open = false;
  });

  /**
   * 🔴 The local refusals are a COURTESY that must happen BEFORE the round trip — the server re-derives
   * both and its answer is authoritative, but a menu that has to ask the network what it is allowed to
   * offer cannot dim and explain. Zero calls to `deleteBranch` is the assertion.
   */
  it('refuses the branch the project is ON, before any network call', async () => {
    const result = actions();

    let outcome: { ok: boolean; message?: string } | undefined;

    await act(async () => {
      outcome = await result.current.remove('main');
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome?.message).toContain('main');
    expect(seams.deleteBranch).not.toHaveBeenCalled();
  });

  /**
   * The repository's trunk, which is a DIFFERENT mistake with a different fix — and the default branch
   * is READ from the fetched list, never guessed as `main`. (Here the project is on `feature/skins`, so
   * the current-branch rule above cannot be what refuses it.)
   */
  it('refuses the default branch, read from the list rather than guessed', async () => {
    repoStatus.set({ linked: true, provider: 'github', branch: 'feature/skins' });

    const result = actions();

    await act(async () => {
      await result.current.refreshBranches();
    });

    await waitFor(() => expect(result.current.branches).toHaveLength(3));

    let outcome: { ok: boolean; message?: string } | undefined;

    await act(async () => {
      outcome = await result.current.remove('main');
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome?.message).toMatch(/default branch/i);
    expect(seams.deleteBranch).not.toHaveBeenCalled();
  });

  /** The CONTROL. Without it both refusals pass for a `remove` that never deletes anything. */
  it('deletes an ordinary branch', async () => {
    const result = actions();

    await act(async () => {
      await result.current.refreshBranches();
    });

    let outcome: { ok: boolean } | undefined;

    await act(async () => {
      outcome = await result.current.remove('feature/boost-pads');
    });

    expect(outcome?.ok).toBe(true);
    expect(seams.deleteBranch).toHaveBeenCalledWith('prj_1', 'feature/boost-pads');
  });
});

describe('reading the branch list', () => {
  /**
   * 🔴 LOADING IS NOT EMPTY. `branches` starts `undefined` and only becomes an array once the read has
   * answered — the caller renders "reading…" off that distinction, and collapsing the two says "this
   * repository has no branches" about a repository that has plenty.
   */
  it('is undefined until it has been read, and an array afterwards', async () => {
    const result = actions();

    expect(result.current.branches).toBeUndefined();

    await act(async () => {
      await result.current.refreshBranches();
    });

    expect(result.current.branches).toEqual(BRANCHES);
    expect(result.current.loadingBranches).toBe(false);
  });

  /** A list that silently failed to load is indistinguishable from a repository with no branches. */
  it('is LOUD when the list cannot be read, and leaves it unfetched', async () => {
    seams.listBranches.mockResolvedValue({ ok: false, message: 'Could not read the branches.' });

    const result = actions();

    await act(async () => {
      await result.current.refreshBranches();
    });

    expect(seams.toastError).toHaveBeenCalledWith('Could not read the branches.');
    expect(result.current.branches).toBeUndefined();
  });
});

/**
 * 🔴 §4.12 — A GENERATION OWNS THE TREE WHILE IT RUNS, AND THIS IS THE CLIENT HALF.
 *
 * The server is the wall (`isProjectClaimed` refuses the route, T1), so an unwired check here was
 * never a data-loss hole — it was a DEAD COURTESY LAYER. Both decision cores declared the refusal and
 * nothing supplied the fact, so `generationInFlight` had no production writer at all: the user pressed
 * Switch, waited for a round trip, and got a server error where they should have had an immediate
 * sentence. A refusal that arrives late reads as a bug in the button rather than as the state it
 * reflects.
 *
 * ⚠️ These assert that NO NETWORK CALL is made, not merely that a toast appeared. "It refused" is
 * satisfied by a refusal that still spends the round trip.
 */
describe('a running generation blocks the tree-replacing actions, locally', () => {
  beforeEach(() => {
    streamingState.set(true);
  });

  afterEach(() => {
    streamingState.set(false);
  });

  it('refuses a switch before it asks the server', async () => {
    repoStatus.set({ linked: true, branch: 'main' });

    const { result } = renderHook(() => useBranchActions());
    await act(async () => {
      await result.current.switchTo('feature/boost-pads');
    });

    expect(seams.switchBranch).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
    expect(seams.toastError).toHaveBeenCalledWith(expect.stringMatching(/building/i));
  });

  it('refuses a discard before it asks the server', async () => {
    repoStatus.set({ linked: true, branch: 'main' });
    unsavedWork.set(true);

    const { result } = renderHook(() => useBranchActions());
    await act(async () => {
      await result.current.discard();
    });

    expect(seams.discardChanges).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
    expect(seams.toastError).toHaveBeenCalledWith(expect.stringMatching(/building/i));
  });

  /**
   * 🔴 THE CONTROL. Both assertions above are "nothing happened", which passes for a hook that is
   * broken, for a project that is not linked, and for a fixture that never reached the action. With
   * the stream idle the same calls must go through.
   */
  it('CONTROL — with no generation running, the same switch proceeds', async () => {
    streamingState.set(false);
    repoStatus.set({ linked: true, branch: 'main' });

    const { result } = renderHook(() => useBranchActions());
    await act(async () => {
      await result.current.switchTo('feature/boost-pads');
    });

    expect(seams.switchBranch).toHaveBeenCalledWith('prj_1', 'feature/boost-pads');
    expect(seams.applyBranchTree).toHaveBeenCalled();
  });
});

/**
 * 🔴 AND IT BLOCKS THEM WHEN THE GENERATION STARTS *AFTER* THE HOOK RENDERED — which is the only
 * sequence that happens in the product.
 *
 * The block above sets `streamingState` in a `beforeEach`, so the callback is born already knowing.
 * That passes for a hook whose `useCallback` has forgotten `generationInFlight` in its dependency
 * array — and it had. Every other fact in `facts` is settled before the hook renders; a generation is
 * the one that arrives later, so it is the one whose omission is invisible to a test that arranges it
 * first. Measured: with the dep missing, both tests here failed and all 21 above passed.
 *
 * This is the "a function-only spec cannot see a caller whose units are wrong" lesson wearing React:
 * the rule was implemented, asserted, and unreachable in the sequence that matters.
 */
describe('...including a generation that starts AFTER the menu was opened', () => {
  afterEach(() => {
    streamingState.set(false);
  });

  it('refuses a switch when the stream starts after mount', async () => {
    streamingState.set(false);
    repoStatus.set({ linked: true, branch: 'main' });

    const { result } = renderHook(() => useBranchActions());

    // The user opens the menu, the agent starts writing, and only THEN they press Switch.
    await act(async () => {
      streamingState.set(true);
    });

    await act(async () => {
      await result.current.switchTo('feature/boost-pads');
    });

    expect(seams.switchBranch).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });

  it('refuses a discard when the stream starts after mount', async () => {
    streamingState.set(false);
    repoStatus.set({ linked: true, branch: 'main' });
    unsavedWork.set(true);

    const { result } = renderHook(() => useBranchActions());

    await act(async () => {
      streamingState.set(true);
    });

    await act(async () => {
      await result.current.discard();
    });

    expect(seams.discardChanges).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 REVIEW CHANGES — "what am I about to publish?" (§4.13a, T19 scope gap).
 *
 * `compareTrees` has its own exhaustive suite; nothing here re-tests the comparison. What is tested is
 * the WIRING, and the wiring has exactly two defects available to it, both silent:
 *
 *   - reading through an op that MOVES the sync pointer, which would make "let me look at this branch"
 *     leave the project claiming to be up to date with a commit it never applied;
 *   - calling `compareTrees` WITHOUT `readLocalBytes`, which is documented behaviour rather than a
 *     crash: same-size binaries are then reported UNCHANGED. A regenerated asset lands on a different
 *     length virtually never — but the class of file most likely to have changed after §4.16 media
 *     generation would be the one class this screen could never show, on the one screen built to make
 *     the user look carefully.
 *
 * Neither throws, neither shows up in a screenshot, and both make the list SHORTER, which reads as a
 * clean tree.
 */
describe('reviewing changes', () => {
  /** The pleasant case, and the control every negative assertion below needs. */
  it('reads the branch and returns a diff of it against the sandbox', async () => {
    seams.localFiles = { '/home/project/src/main.ts': { type: 'file', content: 'local', isBinary: false, size: 5 } };
    seams.readBranchTree.mockResolvedValue({
      ok: true,
      branch: 'main',
      files: { 'src/main.ts': { type: 'file', content: 'remote', isBinary: false, size: 6 } },
    });

    const result = actions();

    let diff: Awaited<ReturnType<typeof result.current.review>>;

    await act(async () => {
      diff = await result.current.review();
    });

    expect(seams.readBranchTree).toHaveBeenCalledWith('prj_1');
    expect(diff?.changes).toEqual([
      expect.objectContaining({ path: 'src/main.ts', status: 'modified', isBinary: false }),
    ]);
  });

  /**
   * 🔴 THE READER IS LOAD-BEARING, AND THIS DRIVES IT END TO END.
   *
   * The fixture is the one shape that cannot be settled any other way: a binary whose two versions are
   * the SAME SIZE. `File.content` is always empty when `isBinary` (SPEC §1.3 principle 10) and `size`
   * ties, so the verdict came from the bytes or it came from nowhere — and with no reader supplied
   * `sameBinary` returns `true` and the row disappears.
   *
   * The reader must also be handed the STORE path, not the repo-relative one: `readBinaryFile` reads
   * the sandbox FS, which knows `/home/project/public/logo.png` and nothing about `public/logo.png`.
   */
  it('passes a readLocalBytes reader through to workbenchStore.readBinaryFile, and it decides the verdict', async () => {
    const LOCAL = new Uint8Array([1, 2, 3, 4]);
    const REMOTE = new Uint8Array([9, 9, 9, 9]);

    seams.localFiles = {
      '/home/project/public/logo.png': { type: 'file', content: '', isBinary: true, size: LOCAL.length },
    };
    seams.readBranchTree.mockResolvedValue({
      ok: true,
      branch: 'main',
      files: {
        'public/logo.png': { type: 'file', content: bytesToBase64(REMOTE), isBinary: true, size: REMOTE.length },
      },
    });
    seams.readBinaryFile.mockResolvedValue(LOCAL);

    const result = actions();

    let diff: Awaited<ReturnType<typeof result.current.review>>;

    await act(async () => {
      diff = await result.current.review();
    });

    expect(seams.readBinaryFile).toHaveBeenCalledWith('/home/project/public/logo.png');
    expect(diff?.changes).toEqual([
      expect.objectContaining({ path: 'public/logo.png', status: 'modified', isBinary: true }),
    ]);
  });

  /**
   * 🔴 THE CONTROL FOR THE TEST ABOVE. Without it, "the binary is reported modified" also passes for a
   * `review()` that reports EVERY binary as modified — which is the other wrong answer, and the one
   * that trains the user to skim the list.
   */
  it('CONTROL — the same-size binary with the SAME bytes reports nothing changed', async () => {
    const SAME = new Uint8Array([1, 2, 3, 4]);

    seams.localFiles = {
      '/home/project/public/logo.png': { type: 'file', content: '', isBinary: true, size: SAME.length },
    };
    seams.readBranchTree.mockResolvedValue({
      ok: true,
      branch: 'main',
      files: {
        'public/logo.png': { type: 'file', content: bytesToBase64(SAME), isBinary: true, size: SAME.length },
      },
    });
    seams.readBinaryFile.mockResolvedValue(SAME);

    const result = actions();

    let diff: Awaited<ReturnType<typeof result.current.review>>;

    await act(async () => {
      diff = await result.current.review();
    });

    expect(seams.readBinaryFile).toHaveBeenCalled();
    expect(diff?.changes).toEqual([]);
  });

  /**
   * A read that failed is `undefined`, never an empty diff.
   *
   * An empty `TreeDiff` renders as "Nothing has changed" — a confident, specific, wrong statement about
   * a project whose changes we could not read, made on the screen the user opened to decide whether to
   * publish. `undefined` is what lets the caller say nothing instead.
   */
  it('is LOUD and returns undefined when the branch cannot be read — never a fabricated empty diff', async () => {
    seams.readBranchTree.mockResolvedValue({ ok: false, message: 'Could not read the branch to compare against.' });

    const result = actions();

    let diff: Awaited<ReturnType<typeof result.current.review>>;

    await act(async () => {
      diff = await result.current.review();
    });

    expect(diff).toBeUndefined();
    expect(seams.toastError).toHaveBeenCalledWith('Could not read the branch to compare against.');
  });

  /**
   * 🔴 LOOKING AT A BRANCH IS NOT AGREEING WITH IT (T5's headline invariant).
   *
   * `review` reads through the `tree` op precisely because that op does NOT move
   * `lastSyncedCommitSha`. A review routed through `switchBranch` would return the same diff, look
   * identical on screen, and leave the project claiming to be synced with a commit it never applied —
   * after which the next push believes it is a fast-forward. Zero calls to the tree-replacing seams is
   * the assertion; `readBranchTree` having been called is what stops it passing for a `review` that
   * does nothing at all.
   */
  it('reads through the tree op and moves NOTHING — no switch, no apply', async () => {
    seams.localFiles = { '/home/project/src/main.ts': { type: 'file', content: 'local', isBinary: false, size: 5 } };

    const result = actions();

    await act(async () => {
      await result.current.review();
    });

    expect(seams.readBranchTree).toHaveBeenCalledWith('prj_1');
    expect(seams.switchBranch).not.toHaveBeenCalled();
    expect(seams.discardChanges).not.toHaveBeenCalled();
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });
});

/**
 * BRANCH HISTORY (§4.13a, T19 scope gap).
 *
 * One bounded page at a time, and the cursor is the whole mechanism: a `history` that drops it returns
 * page one forever, so "Load more" appends a duplicate of what the user is already looking at. Nothing
 * throws, and the list even grows.
 */
describe('reading the branch history', () => {
  const PAGE_ONE = [
    { sha: 'aaa1', message: 'Add boost pads', author: 'jane', date: '2026-08-01T00:00:00Z' },
    { sha: 'bbb2', message: 'Tune the drift', author: 'jane', date: '2026-08-02T00:00:00Z' },
  ];

  it('returns the commits and the cursor that fetches the next page', async () => {
    seams.listCommits.mockResolvedValue({ ok: true, commits: PAGE_ONE, nextCursor: 'cursor-2' });

    const result = actions();

    let page: Awaited<ReturnType<typeof result.current.history>>;

    await act(async () => {
      page = await result.current.history();
    });

    expect(page?.commits).toEqual(PAGE_ONE);
    expect(page?.nextCursor).toBe('cursor-2');
  });

  /**
   * 🔴 THE CURSOR REACHES THE SERVER. Asserted on the SERIALIZED argument rather than on the returned
   * page, because a `listCommits(projectId, {})` that ignores its cursor returns a perfectly valid
   * page — page one — and every assertion about the RESULT would still pass.
   */
  it('passes the cursor through to listCommits', async () => {
    seams.listCommits.mockResolvedValue({ ok: true, commits: PAGE_ONE, nextCursor: 'cursor-2' });

    const result = actions();

    await act(async () => {
      await result.current.history();
    });

    // Page one asks for no cursor at all.
    expect(seams.listCommits.mock.calls[0]).toEqual(['prj_1', { cursor: undefined }]);

    await act(async () => {
      await result.current.history('cursor-2');
    });

    expect(seams.listCommits.mock.calls[1][0]).toBe('prj_1');
    expect(seams.listCommits.mock.calls[1][1]).toStrictEqual({ cursor: 'cursor-2' });
  });

  /** A history that could not be read says so, and returns nothing rather than an empty history. */
  it('is LOUD and returns undefined when the history cannot be read', async () => {
    seams.listCommits.mockResolvedValue({ ok: false, message: 'Could not read the history.' });

    const result = actions();

    let page: Awaited<ReturnType<typeof result.current.history>>;

    await act(async () => {
      page = await result.current.history();
    });

    expect(page).toBeUndefined();
    expect(seams.toastError).toHaveBeenCalledWith('Could not read the history.');
  });
});

/**
 * The client half of the owner's 2026-08-22 switch. The route refuses identically and is the wall
 * that matters (`clone.spec.ts`); this one keeps a caller reaching the hook some other way from
 * making a round trip that can only be refused.
 */
describe('branch deletion is switched off', () => {
  it('refuses without calling the server', async () => {
    const result = actions();

    let outcome: { ok: boolean; message?: string } | undefined;

    await act(async () => {
      outcome = await result.current.remove('feature/old');
    });

    expect(outcome?.ok).toBe(false);
    expect(outcome?.message).toMatch(/GitHub or GitLab/i);
    expect(seams.deleteBranch).not.toHaveBeenCalled();
  });

  /**
   * CONTROL. Without it the assertion above passes for a hook whose `remove` is broken for every
   * input — including one that refuses the ordinary branches the feature exists to delete.
   */
  it('CONTROL — the same branch IS deletable with the switch open', async () => {
    branchDeleteGate.open = true;

    try {
      const result = actions();

      let outcome: { ok: boolean; message?: string } | undefined;

      await act(async () => {
        outcome = await result.current.remove('feature/old');
      });

      expect(outcome?.ok).toBe(true);
      expect(seams.deleteBranch).toHaveBeenCalled();
    } finally {
      branchDeleteGate.open = false;
    }
  });
});
