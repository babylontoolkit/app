// @vitest-environment jsdom
/**
 * ONE APPLY PATH FOR EVERY TREE REPLACEMENT — the two doors T18 converged (§4.13a T18).
 *
 * `applyBranchTree` already owned the switch and the discard. T18 pointed the remaining two doors at
 * it: the Sync dialog's **Pull**, and the divergence dialog's **"use the version from my repository"**
 * resolve. Both used to hand-roll the same operation slightly differently — a NON-strict
 * before-checkpoint, a restore, a second snapshot, and (in the divergence dialog only) `markSynced` +
 * `unsavedWork(false)`. "One underlying operation behaves differently depending on which door reached
 * it" is the `recordAgentWrite`/`#recordRestoredFiles`, `prepareMountedProject`/`mountedThisLoad`,
 * clone/pull shape this codebase keeps rediscovering, and it has no symptom until someone presses undo.
 *
 * ## The half that actually matters
 *
 * A door that calls `applyBranchTree` **and still does its own restore** would DOUBLE-APPLY: two
 * checkpoints of one moment, a restore over a restore, and an undo history whose entries no longer
 * mean what their labels say. That is a convergence half-done, it type-checks, it lints, and every
 * existing test stays green — so the strongest assertions here are the NEGATIVE ones.
 *
 * ## The instrument, and why it is not a source scan
 *
 * These are BEHAVIOURAL component tests in jsdom. Both files are React components that pull in the
 * workbench, so the reflex in this repo is a comment-stripped source scan (`no-client-token.spec.ts`,
 * `budgets-wiring.spec.ts`, `tree-replacement-wiring.spec.ts`). That reflex was checked rather than
 * followed: `GitHubSyncDialog.spec.tsx` already renders one of these two components with its module
 * graph mocked at the seams, so the honest instrument is available — and it is strictly stronger,
 * because a scan can only see that the call is written, never that pressing the button reaches it, and
 * never that nothing else runs alongside it. `applyBranchTree` is mocked, so "the door did not restore"
 * is observable as literally zero calls to `workbenchStore.restoreFiles`.
 *
 * Two things a render genuinely cannot see, and only those two, are pinned at source level below (with
 * the strip and its control, for `no-client-token.spec.ts`'s documented reason — both components now
 * EXPLAIN the move by naming the moved symbols in prose).
 *
 * ## What the acceptance's "unchanged control" rests on, and where it is proved
 *
 * The pre-existing pull behaviour — byte-faithful tree, `protectForRepoRestore`, checkpoint-FIRST — is
 * not re-tested here. All three are now properties of the module both doors call, and
 * `apply-branch-tree.spec.ts` proves each behaviourally, with controls:
 *
 *   - byte-faithful tree → *"the incoming tree is what gets restored"*;
 *   - `protectForRepoRestore` → *"passes the real `protectForRepoRestore`"* + a control proving the two
 *     candidate protect functions actually disagree about `.env`;
 *   - checkpoint-first → *"the checkpoint holds the pre-operation files, and undo points at it"*, and
 *     *"a failed before-checkpoint aborts the operation and writes NOTHING"*;
 *   - `markSynced` + `unsavedWork(false)` (which the divergence dialog used to do itself, and which
 *     were the two behaviours most at risk of being dropped in the move) → *"the post-mount triple"*,
 *     including a control that `unsavedWork` is never flipped back to true.
 *
 * Duplicating those here would test the mock. What is asserted instead is the JOIN: that each door
 * reaches that module, and that the module still carries the strict serialize — so the acceptance's
 * "both take a strict before-checkpoint" is true for both doors through one chain rather than by
 * assumption.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Everything a `vi.mock` factory closes over must be HOISTED with it — the factories are lifted above
 * the file body, so a plain `const` above them is still in its temporal dead zone when they run.
 */
const seams = vi.hoisted(() => ({
  /** A distinguishable sentinel, so "the door passed ITS db" is checkable rather than `undefined`. */
  db: { name: 'boltHistory' } as unknown as IDBDatabase,

  unsavedWorkSet: vi.fn(),

  applyBranchTree: vi.fn(),
  getProject: vi.fn(),
  linkProjectToRepo: vi.fn(),
  resolveDivergence: vi.fn(),

  /*
   * Three of the four steps the doors must no longer perform themselves (the fourth,
   * `unsavedWork.set(false)`, is `unsavedWorkSet` above). Spied so ZERO calls is an assertion.
   */
  restoreFiles: vi.fn(),
  createLocalSnapshot: vi.fn(),
  markSynced: vi.fn(),

  // Legitimately still used by the PUSH arms — present so those paths behave, never asserted as absent.
  serializeFiles: vi.fn(async () => ({}) as never),

  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarn: vi.fn(),
}));

/*
 * `~/lib/persistence` re-exports `useChatHistory`, which boots a sandbox on import. The atoms are
 * CREATED in the factory and read back out of the mocked module below, rather than being declared here
 * and captured — a captured `const` is in its temporal dead zone when the hoisted factory runs.
 */
vi.mock('~/lib/persistence', async () => {
  const { atom: makeAtom } = await import('nanostores');

  return {
    projectId: makeAtom<string | undefined>('prj_1'),
    mountDivergence: makeAtom<{ projectId: string; remoteHead: string } | undefined>(undefined),
    repoStatus: makeAtom<{ linked: boolean; provider?: string; branch?: string } | undefined>(undefined),
    unsavedWork: { get: () => false, set: seams.unsavedWorkSet, subscribe: vi.fn(), listen: vi.fn() },
    requestSave: vi.fn(),
    startGitConnect: vi.fn(),
  };
});

vi.mock('~/lib/persistence/projects', () => ({
  getProject: seams.getProject,
  linkProjectToRepo: seams.linkProjectToRepo,
  resolveDivergence: seams.resolveDivergence,
}));

vi.mock('~/lib/persistence/useChatHistory', () => ({ db: seams.db }));
vi.mock('~/lib/persistence/apply-branch-tree', () => ({ applyBranchTree: seams.applyBranchTree }));

vi.mock('~/lib/persistence/local-snapshots', () => ({
  createLocalSnapshot: seams.createLocalSnapshot,
  markSynced: seams.markSynced,
}));

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    serializeFiles: seams.serializeFiles,
    restoreFiles: seams.restoreFiles,
    resetAllFileModifications: vi.fn(),
    clearDeletedPaths: vi.fn(),
  },
}));

vi.mock('react-toastify', () => ({
  toast: { error: seams.toastError, success: seams.toastSuccess, warn: seams.toastWarn },
}));

import { GitHubSyncDialog } from '~/components/github/GitHubSyncButton';
import { SaveDivergenceDialog } from '~/components/persistence/SaveDivergenceDialog.client';

/* The mocked module's atoms — the same instances the components subscribe to. */
import { mountDivergence, repoStatus } from '~/lib/persistence';

const { unsavedWorkSet, db: DB } = seams;

/** One file, so a matcher cannot silently drift from what the doors were handed. */
const PULLED = { 'src/main.ts': { type: 'file', content: 'from the repo', isBinary: false } } as never;

beforeEach(() => {
  vi.clearAllMocks();

  seams.applyBranchTree.mockResolvedValue({ ok: true, serverCopySkipped: false });
  seams.getProject.mockResolvedValue({ id: 'prj_1', linkedRepo: 'octocat/my-game', linkedBranch: 'trunk' });
  seams.resolveDivergence.mockResolvedValue({ ok: true, files: PULLED });
  seams.serializeFiles.mockResolvedValue({} as never);

  mountDivergence.set({ projectId: 'prj_1', remoteHead: 'abc123' });
  repoStatus.set({ linked: true, provider: 'github', branch: 'trunk' });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/git/connections')) {
        return new Response(JSON.stringify({ configured: ['github'], connections: [{ provider: 'github' }] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true, files: PULLED }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mountDivergence.set(undefined);
});

/** Render the sync dialog on a LINKED project and press its Pull button. */
let onClose: ReturnType<typeof vi.fn>;

async function pull() {
  onClose = vi.fn();
  render(<GitHubSyncDialog projectId="prj_1" onClose={onClose} />);

  const button = await waitFor(() => screen.getByRole('button', { name: /Sync from GitHub/ }));
  fireEvent.click(button);

  await waitFor(() => expect(seams.applyBranchTree).toHaveBeenCalled());

  return seams.applyBranchTree.mock.calls[0][0] as Record<string, unknown>;
}

/** Render the divergence dialog and choose the repo's version. */
async function resolve() {
  render(<SaveDivergenceDialog />);

  fireEvent.click(screen.getByRole('button', { name: /Use the version from my repository/ }));

  await waitFor(() => expect(seams.applyBranchTree).toHaveBeenCalled());

  return seams.applyBranchTree.mock.calls[0][0] as Record<string, unknown>;
}

describe('the Pull door goes through applyBranchTree', () => {
  it('hands it the pulled tree, the linked branch, operation "pull" and this browser’s db', async () => {
    const input = await pull();

    expect(input).toMatchObject({ projectId: 'prj_1', files: PULLED, operation: 'pull', db: DB });
  });

  /**
   * 🔴 THE BRANCH IS PASSED, ALWAYS.
   *
   * Both the phase copy the user reads while the workspace is covered AND the working-copy branch
   * stamp (§4.13a T17) are derived from it, and an omitted optional-looking argument compiles. The
   * assertion is on a NON-EMPTY string rather than on the literal, because the door falls back to a
   * sentence when the project has no `linkedBranch` — a fallback that is deliberate, and would be
   * indistinguishable from an omission if only the happy value were pinned.
   */
  it('always passes a branch', async () => {
    const input = await pull();

    expect(typeof input.branch).toBe('string');
    expect(input.branch).not.toBe('');
    expect(input.branch).toBe('trunk');
  });

  /**
   * 🔴 THE DOUBLE-APPLY. The half that has no symptom.
   *
   * A door that calls `applyBranchTree` and keeps its old sequence restores twice and writes two
   * checkpoints of one moment. Asserted as ZERO calls — the module is mocked, so anything the spies
   * see was done by the COMPONENT.
   */
  it('does not restore, checkpoint or mark synced itself — the module owns all of that', async () => {
    await pull();

    expect(seams.restoreFiles).not.toHaveBeenCalled();
    expect(seams.createLocalSnapshot).not.toHaveBeenCalled();
    expect(seams.markSynced).not.toHaveBeenCalled();
    expect(unsavedWorkSet).not.toHaveBeenCalled();
  });

  /**
   * A refusal is LOUD and never dressed as success. `applyBranchTree` returns `{ok:false, reason}`
   * for an empty tree and for a failed strict before-checkpoint — the case where the project was
   * deliberately left untouched, which is exactly when a "Updated from GitHub." toast would be a lie.
   */
  it('surfaces a refusal and does not claim the pull landed', async () => {
    seams.applyBranchTree.mockResolvedValue({ ok: false, reason: 'Could not save a checkpoint' });

    await pull();

    /*
     * 🔴 `autoClose: false` IS PART OF THE ASSERTION. With the dialog closed before the work starts,
     * this toast is the ENTIRE report — there is no failure panel on this path (a review found by
     * rendering that `WorkspaceSplash` draws nothing for `failed`). At react-toastify's 5-second
     * default, the only explanation for a possibly half-replaced tree would vanish while the user was
     * still reading it.
     */
    expect(seams.toastError).toHaveBeenCalledWith('Could not save a checkpoint', { autoClose: false });
    expect(seams.toastSuccess).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE DIALOG CLOSES BEFORE THE WORK, OR THE NARRATION NARRATES TO NOBODY.
 *
 * This is the half of T18's acceptance — *"a pull and a divergence-resolve both **narrate**"* — that
 * was false in the shipped UI while every other assertion in this file passed.
 *
 * `WorkspaceSplash` is deliberately `z-50` (it must sit under the sidebar and header). Both of these
 * doors are `Dialog`s whose overlay is `z-[9999]` with a `backdrop-blur`. Awaiting `applyBranchTree`
 * with the modal still open buries the entire thirty-second story — the phase heading, the file
 * progress bar, the reinstall, the elapsed clock — beneath a blurred black scrim showing two buttons
 * that read "Working…". The narration mechanism was complete, correct, and rendered to nobody.
 *
 * That inverts the argument the owner accepted the thirty seconds for: the install is worth doing
 * BECAUSE its cost is visible.
 *
 * ⚠️ Asserted as ORDERING (`invocationCallOrder`), not as "was it called" — the sync door's `onClose`
 * is also called when the dialog is dismissed, and the divergence door already called `close()` at
 * the END of its handler. Both would satisfy a bare "did it close?" check while still covering the
 * splash for the whole operation, which is precisely the state this test exists to forbid.
 */
describe('the narration is actually visible — the modal is gone before the work starts', () => {
  /*
   * ⚠️ Observed AT CALL TIME rather than by invocation order, because the state that matters is "was
   * the dialog already closed when the work began?" — and both doors also close at the END of their
   * handler, which an order-of-first-call check would happily accept.
   */
  it('the sync door closes before it awaits applyBranchTree', async () => {
    let closedFirst = false;

    seams.applyBranchTree.mockImplementation(async () => {
      closedFirst = onClose.mock.calls.length > 0;

      return { ok: true, serverCopySkipped: false };
    });

    await pull();

    expect(closedFirst).toBe(true);
  });

  it('the divergence door closes before it awaits applyBranchTree', async () => {
    let closedFirst = false;

    seams.applyBranchTree.mockImplementation(async () => {
      // The dialog renders nothing once the signal is cleared, which is what "closed" means here.
      closedFirst = mountDivergence.get() === undefined;

      return { ok: true, serverCopySkipped: false };
    });

    await resolve();

    expect(closedFirst).toBe(true);
  });
});

describe('the divergence resolve door goes through the same applyBranchTree', () => {
  it('hands it the repo’s tree, the repo’s branch, operation "pull" and the db', async () => {
    const input = await resolve();

    expect(input).toMatchObject({ projectId: 'prj_1', files: PULLED, operation: 'pull', db: DB });
  });

  it('always passes a branch', async () => {
    const input = await resolve();

    expect(typeof input.branch).toBe('string');
    expect(input.branch).not.toBe('');
    expect(input.branch).toBe('trunk');
  });

  /**
   * 🔴 The same double-apply assertion, and it is the sharper of the two: this arm previously owned
   * FIVE steps (before-checkpoint, restore, after-checkpoint, `markSynced`, `unsavedWork(false)`), so
   * it is the door with the most to leave behind. `markSynced` and `unsavedWork(false)` are not lost —
   * `applyBranchTree` performs both, proven behaviourally by `apply-branch-tree.spec.ts`'s
   * *"the post-mount triple"* — they have simply moved, which is what these zeros record.
   */
  it('does not restore, checkpoint, mark synced or clear unsaved work itself', async () => {
    await resolve();

    expect(seams.restoreFiles).not.toHaveBeenCalled();
    expect(seams.createLocalSnapshot).not.toHaveBeenCalled();
    expect(seams.markSynced).not.toHaveBeenCalled();
    expect(unsavedWorkSet).not.toHaveBeenCalled();
  });

  /**
   * A refusal is LOUD — and the dialog does NOT come back, which is a deliberate change of contract.
   *
   * ⚠️ This test previously asserted the dialog STAYS OPEN, on the reasoning that "the choice has not
   * landed, so it must not look made". That reasoning was right for the failure it was written
   * against — a `resolveDivergence` call the SERVER refused — and it is wrong for this one: by the
   * time `applyBranchTree` runs, the server has already resolved the divergence and returned the
   * tree. The choice IS made. Re-offering it would ask the user to spend a decision they have spent,
   * and on the second press the server would refuse it as no longer divergent.
   *
   * ⚠️ What replaces it is NOT a panel. An earlier draft of this comment said `applyBranchTree` raises
   * its own full-page failure surface; a review checked by rendering and found it does not — nothing
   * draws the `failed` phase outside `BootScreen`'s `!ready` branch, which a branch operation never
   * runs in. So the module no longer sets that phase, and the toast asserted below is the WHOLE
   * report: persistent (`autoClose: false`) and naming the operation and branch, because a five-second
   * message is not an explanation for a tree that may be half-replaced.
   *
   * The dialog had to close for the narration to be visible at all (see the ordering tests above), so
   * "stays open" and "narrates" could not both be true.
   */
  it('surfaces a refusal and does not claim the resolve landed', async () => {
    seams.applyBranchTree.mockResolvedValue({ ok: false, reason: 'Nothing was read from trunk' });

    await resolve();

    // Persistent, for the reason on the sync door's twin: this toast is the whole report.
    expect(seams.toastError).toHaveBeenCalledWith('Nothing was read from trunk', { autoClose: false });
    expect(seams.toastSuccess).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE CONTROL FOR THE CHANGE ABOVE: a refusal by the SERVER — before any tree exists — still
   * keeps the dialog open, because there the choice genuinely has not landed.
   *
   * Without this, "the dialog closes on failure" would read as a blanket rule, and the next person to
   * touch this file would have no way to see that the two failures are different events.
   */
  it('CONTROL — a server refusal keeps the dialog open, because nothing was decided', async () => {
    seams.resolveDivergence.mockResolvedValue({ ok: false, message: 'That did not work.' });

    render(<SaveDivergenceDialog />);
    fireEvent.click(screen.getByRole('button', { name: /Use the version from my repository/ }));

    await waitFor(() => expect(seams.toastError).toHaveBeenCalledWith('That did not work.'));

    expect(seams.applyBranchTree).not.toHaveBeenCalled();
    expect(mountDivergence.get()).toBeDefined();
  });
});

/**
 * 🔴 THE CONTROLS FOR THE ZEROS.
 *
 * Every negative assertion above passes for a harness that never reached the handler at all — a
 * mis-typed button name, a dialog that rendered its unlinked form, a click that did nothing. Each is
 * already anchored by the `applyBranchTree` call in the same test, and these make the anchor explicit:
 * the spies CAN see calls, and the doors DO still serialize when the arm calls for it.
 */
describe('CONTROL — the harness really drives these doors', () => {
  it('the push arm still serializes, so serializeFiles is reachable through this render', async () => {
    render(<GitHubSyncDialog projectId="prj_1" onClose={vi.fn()} />);

    const button = await waitFor(() => screen.getByRole('button', { name: /Push to GitHub/ }));
    fireEvent.click(button);

    await waitFor(() => expect(seams.serializeFiles).toHaveBeenCalled());
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });

  it('the push-to-new-branch resolve still serializes and never applies a tree', async () => {
    render(<SaveDivergenceDialog />);

    seams.resolveDivergence.mockResolvedValue({ ok: true, branch: 'my-work-2' });
    fireEvent.click(screen.getByRole('button', { name: /Keep what is in this browser/ }));

    await waitFor(() => expect(seams.serializeFiles).toHaveBeenCalled());
    expect(seams.applyBranchTree).not.toHaveBeenCalled();
  });

  it('a successful pull says so', async () => {
    await pull();

    expect(seams.toastSuccess).toHaveBeenCalledWith('Updated from GitHub.');
  });
});

/* ------------------------------------------------------------------------------------------------ */

const APPLY = 'app/lib/persistence/apply-branch-tree.ts';
const SYNC = 'app/components/github/GitHubSyncButton.tsx';
const DIVERGENCE = 'app/components/persistence/SaveDivergenceDialog.client.tsx';

const raw = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

/**
 * Comments stripped, for `no-client-token.spec.ts`'s documented reason — and here it is not a
 * precaution. Both components now EXPLAIN the move by naming the moved symbols in prose
 * (`SaveDivergenceDialog.client.tsx` says the arm "used to hand-roll … `markSynced`, `unsavedWork`"),
 * so an unstripped scan for those names would fail on the explanation of the fix.
 */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = (file: string) => stripComments(raw(file));

/**
 * 🔴 THE STRICT BEFORE-CHECKPOINT IS INHERITED — and this is where the acceptance's "both doors take a
 * strict before-checkpoint" becomes TRUE rather than assumed.
 *
 * The behavioural tests above prove each door reaches `applyBranchTree`. `apply-branch-tree.spec.ts`
 * proves — with a control that it is never ALSO called laxly — that the module serializes with
 * `{ strict: true }`. This asserts the join, at the only place a render cannot: that the call the
 * chain depends on is still written in the module. It is deliberately a duplicate of an assertion that
 * exists elsewhere, because a chain proved in two halves in two files has no test that fails when the
 * middle is removed.
 *
 * The strictness is not a detail. `serializeFileMap` OMITS a binary it cannot read, which is right for
 * a map you are going to ship and wrong for the ONLY copy of what is about to be destroyed — a lax
 * photograph restores a project with no `havok.wasm`, and the user finds out at the one moment they
 * have no other option left. It is the upgrade both doors gained, not a side effect of tidying.
 */
describe('what both doors inherit from the module they now share', () => {
  it('the before-checkpoint is STRICT', () => {
    expect(code(APPLY)).toMatch(/serializeFiles\(\{\s*strict:\s*true\s*\}\)/);
  });

  /**
   * The two behaviours the divergence dialog performed itself and no longer does. Asserted as PRESENT
   * in the module, so "it moved" and "it was dropped" are distinguishable from this file — the zeros
   * in the resolve describe above say only that the component stopped doing them.
   */
  it('carries the markSynced + unsavedWork(false) the divergence dialog gave up', () => {
    const source = code(APPLY);

    expect(source).toMatch(/markSynced\(db,\s*projectId\)/);
    expect(source).toMatch(/unsavedWork\.set\(false\)/);
  });

  /**
   * Neither door re-imports its way back to the old sequence. The behavioural zeros already cover the
   * live path; this covers the dead one — an import re-added for a helper that is never called reads
   * as a partly-restored second implementation to the next person to open the file, which is how the
   * second writer comes back.
   *
   * ⚠️ SCOPED DELIBERATELY. `workbenchStore.serializeFiles()` legitimately REMAINS in both files —
   * the sync dialog's push arm and the divergence dialog's push-to-new-branch arm both read the local
   * tree to send it — so it is absent from this list. Asserting it away would be asserting something
   * false.
   */
  it('neither door still hand-rolls the sequence', () => {
    for (const file of [SYNC, DIVERGENCE]) {
      const source = code(file);

      expect(source, `${file} still restores`).not.toMatch(/restoreFiles\(/);
      expect(source, `${file} still checkpoints`).not.toMatch(/createLocalSnapshot\(/);
      expect(source, `${file} still chooses the protect`).not.toMatch(/protectForRepoRestore/);
      expect(source, `${file} still marks synced`).not.toMatch(/markSynced\(/);
    }
  });
});

/**
 * 🔴 `applyBranchTree` IS THE ONLY TREE-REPLACING ENTRY POINT LEFT IN `app/components/`.
 *
 * The four assertions above name the two files T18 touched, which is the enumeration problem the
 * `coversWorkspace` gate was rewritten to escape: *"each version was a list of the doors someone had
 * enumerated, and the third door walked straight past both."* This is DEFAULT-DENY over the whole
 * component tree instead, so a fifth door added later has to argue for itself here.
 */
describe('no component reaches past the module to replace a tree', () => {
  /**
   * The one allowed caller, with its reason — the `outbound-enumerate.spec.ts` `PUBLIC_BY_DESIGN`
   * shape.
   *
   * `Messages.client.tsx` restores a LOCAL CHECKPOINT for §4.12 undo, with `protectNothing`. That is
   * not a repo tree replacement and must not become one: the incoming map really is the whole truth
   * (it was photographed from this same project), whereas a repo map has no `.env` — which is why
   * `applyBranchTree` uses `protectForRepoRestore` and why routing undo through it would be wrong,
   * not merely unnecessary.
   */
  const ALLOWED = new Map([
    ['app/components/chat/Messages.client.tsx', '§4.12 checkpoint undo — a local snapshot, protectNothing'],
  ]);

  const componentFiles = () => {
    const out: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) {
          out.push(path.relative(process.cwd(), full));
        }
      }
    };

    walk(path.resolve(process.cwd(), 'app/components'));

    return out;
  };

  it('only the allow-listed component calls workbenchStore.restoreFiles', () => {
    const files = componentFiles();

    expect(files.length, 'the walker found no components — this scan is reading nothing').toBeGreaterThan(50);

    const callers = files.filter((file) => /workbenchStore\.restoreFiles\(/.test(code(file)));

    expect(callers.sort()).toEqual([...ALLOWED.keys()].sort());
  });

  /**
   * The allow-list is LIVE, not folklore. An entry for a file that no longer calls it would silently
   * turn the assertion above into "nobody calls it", which passes forever — the same shape as a
   * scanner that matches nothing and reports a clean bill of health.
   */
  it('CONTROL — the allow-listed caller really is one', () => {
    for (const file of ALLOWED.keys()) {
      expect(code(file), `${file} no longer restores — retire its allow-list entry`).toMatch(
        /workbenchStore\.restoreFiles\(/,
      );
    }
  });
});

/**
 * 🔴 THE SCANNER CONTROLS. Every source assertion above is a regex over a file, and a regex that
 * cannot fail is precisely the failure this file exists to catch one level down.
 */
describe('CONTROL — the scans can fail', () => {
  it('finds a symbol that is really there', () => {
    expect(code(SYNC)).toMatch(/applyBranchTree\(/);
    expect(code(DIVERGENCE)).toMatch(/applyBranchTree\(/);
    expect(code(APPLY)).toMatch(/export async function applyBranchTree/);
  });

  it('does not find one that is not', () => {
    expect(code(SYNC)).not.toMatch(/applyBranchTreeTwice/);
    expect(code(APPLY)).not.toMatch(/serializeFilesLaxly/);
  });

  /**
   * 🔴 THE STRIP IS REAL, proven on the exact collision it exists for: the divergence dialog names
   * `markSynced` ONLY in the comment explaining that the step MOVED. An unstripped scan for it would
   * fail on the explanation of the fix — so the "neither door still marks synced" assertion above
   * would be red for correct code, and someone would weaken it.
   */
  it('the comment strip really strips', () => {
    expect(raw(DIVERGENCE)).toMatch(/markSynced/);
    expect(code(DIVERGENCE)).not.toMatch(/markSynced/);

    // And the module names `mountProjectFiles` only in the comment forbidding its use.
    expect(raw(APPLY)).toMatch(/mountProjectFiles/);
    expect(code(APPLY)).not.toMatch(/mountProjectFiles/);
  });
});
