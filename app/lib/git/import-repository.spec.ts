/**
 * The ONE path a repository takes into a workspace (T7, `_specs/server-side-git-clone_plan.md`).
 *
 * Every property asserted here fails SILENTLY in production — a phase set one line late leaves the
 * first seconds of the operation uncovered, a literal `idle` reset erases the only sentence explaining
 * a failure, a missed `rollback` leaves an empty dashboard card and a VM billing by the second, and a
 * file body smuggled into the hand-off message corrupts every binary AND buys a permanent per-turn
 * context bill. None of them throws, and none of them is visible in a code review of the happy path.
 *
 * Collaborators are mocked at the LEAF (the registration, the clone, the file write, the settle, the
 * checkpoint) so the module under test is real: the thing being tested is the ORDER and the ARGUMENTS,
 * which is exactly what a higher mock would hide.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  openImportWorkspace: vi.fn(),
  rollback: vi.fn(),
}));

const projects = vi.hoisted(() => ({ cloneRepoIntoProject: vi.fn(), linkProjectToRepo: vi.fn() }));
const snapshots = vi.hoisted(() => ({ createLocalSnapshot: vi.fn(), markSynced: vi.fn() }));
const workbench = vi.hoisted(() => ({ restoreFiles: vi.fn(), files: { get: vi.fn(() => ({})) } }));
const settle = vi.hoisted(() => ({ settleAfterCreation: vi.fn() }));

/*
 * The scoped logger is captured because "best-effort" and "silently swallowed" are the same code shape
 * (`spec/fail-loud.md`): a bare `catch {}` around the link would pass every survival assertion below
 * while leaving nobody anything to read. What is asserted is that the refusal REACHES the log.
 */
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() }));
vi.mock('~/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/logger')>()),
  createScopedLogger: () => log,
}));

/*
 * The checkpoint's failure is LOUD, so the toast is a seam under test rather than noise to silence.
 * `toast.warn` and `logger.error` are different audiences: one is the user whose import may not survive
 * the reload, the other is us.
 */
const toasts = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toasts }));

vi.mock('~/lib/registry/import-project', () => ({ openImportWorkspace: registry.openImportWorkspace }));
vi.mock('~/lib/persistence/projects', () => ({
  cloneRepoIntoProject: projects.cloneRepoIntoProject,
  linkProjectToRepo: projects.linkProjectToRepo,
}));
vi.mock('~/lib/persistence/local-snapshots', () => ({
  createLocalSnapshot: snapshots.createLocalSnapshot,

  /*
   * ⚠️ A partial module mock makes every un-mocked export `undefined`, and the importer's calls to
   * this one are wrapped in a best-effort `catch` — so omitting it here does not fail a test, it
   * turns the call into a swallowed TypeError and reports green for behaviour that never happens.
   */
  markSynced: snapshots.markSynced,
}));
vi.mock('~/lib/persistence/useChatHistory', () => ({ db: {} }));
vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: workbench }));

/*
 * `settleAfterCreation` is mocked (it is a real clock loop and would add ~3s of dead time per test)
 * but `IMPORT_SETTLE_OPTIONS` is kept REAL via `importActual`. Stubbing the constant too would let the
 * module pass any object at all and still satisfy the assertion — the test would be checking that two
 * mocks agree with each other rather than that the import uses the import profile.
 */
vi.mock('~/lib/registry/settle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/registry/settle')>()),
  settleAfterCreation: settle.settleAfterCreation,
}));

import { importRepositoryIntoWorkspace, projectNameFromRepo } from './import-repository';
import { bootProgress, coversWorkspace, type BootPhase } from '~/lib/stores/boot-progress';
import { IMPORT_SETTLE_OPTIONS, MOUNT_SETTLE_OPTIONS } from '~/lib/registry/settle';

const FILES = {
  '/home/project/package.json': { type: 'file' as const, content: '{"scripts":{"dev":"vite"}}', isBinary: false },
  '/home/project/src/main.ts': { type: 'file' as const, content: 'console.log(1)', isBinary: false },
  '/home/project/public/logo.png': { type: 'file' as const, content: '', isBinary: true },
};

/** Every phase the store passed through, in order. */
let phases: BootPhase[] = [];
let unlisten: () => void;

const importChat = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  bootProgress.set({ step: 'idle' });
  phases = [];
  unlisten = bootProgress.listen((phase) => phases.push(phase));

  registry.rollback.mockResolvedValue(undefined);
  registry.openImportWorkspace.mockImplementation(async () => ({
    sandbox: {},
    projectId: 'prj_1',
    rollback: registry.rollback,
  }));
  projects.cloneRepoIntoProject.mockResolvedValue({
    ok: true,
    files: FILES,
    repo: 'octocat/Hello-World',
    branch: 'develop',
    provider: 'github',
    skippedSecrets: [],
  });
  projects.linkProjectToRepo.mockResolvedValue({ ok: true });
  workbench.restoreFiles.mockImplementation(async (_files: unknown, options: any) => {
    options?.onProgress?.(2, 3);
    options?.onProgress?.(3, 3);
  });
  workbench.files.get.mockReturnValue(FILES);
  settle.settleAfterCreation.mockResolvedValue({ quiesced: true, elapsedMs: 3000, finalCount: 3 });
  snapshots.createLocalSnapshot.mockResolvedValue(undefined);
  importChat.mockResolvedValue(undefined);
});

afterEach(() => {
  unlisten?.();
});

const run = (over: Partial<Parameters<typeof importRepositoryIntoWorkspace>[0]> = {}) =>
  importRepositoryIntoWorkspace({ repo: 'https://github.com/octocat/Hello-World.git', importChat, ...over });

describe('the boot surface covers the whole operation', () => {
  it('runs cloning → files → settling and returns to idle', async () => {
    await expect(run()).resolves.toMatchObject({ ok: true });

    const steps = phases.map((p) => p.step);
    expect(steps[0]).toBe('cloning');
    expect(steps).toContain('files');
    expect(steps).toContain('settling');
    expect(steps.indexOf('files')).toBeGreaterThan(steps.indexOf('cloning'));
    expect(steps.indexOf('settling')).toBeGreaterThan(steps.lastIndexOf('files'));
    expect(steps[steps.length - 1]).toBe('idle');
  });

  /*
   * 🔴 The phase must be set BEFORE the registration round trip, not after it. Registration is a server
   * call and a credit charge — it is already part of the wait the user is looking at, and setting the
   * phase afterwards leaves the first seconds of the operation uncovered. That gap is invisible in every
   * test that only reads the FINAL sequence, so it is asserted at the moment the collaborator is called.
   */
  it('covers the workspace before the project is even registered', async () => {
    let phaseAtRegistration: BootPhase | undefined;
    registry.openImportWorkspace.mockImplementation(async () => {
      phaseAtRegistration = bootProgress.get();
      return { sandbox: {}, projectId: 'prj_1', rollback: registry.rollback };
    });

    await run();

    expect(phaseAtRegistration).toEqual({ step: 'cloning' });
  });

  /** `idle` never appears in the MIDDLE — a single uncovered frame is a flash of the assembling tree. */
  it('never uncovers the workspace while work is in flight', async () => {
    await run();

    for (const phase of phases.slice(0, -1)) {
      expect(coversWorkspace(phase)).toBe(true);
    }
  });
});

describe('the phase is cleared with endBootPhase, never a literal idle reset', () => {
  /*
   * 🔴 THE MUTATION THIS FILE EXISTS FOR. `bootProgress.set({ step: 'idle' })` in the `finally` would
   * satisfy every happy-path assertion above and stomp the `failed` phase a fraction of a second after
   * it appeared — taking down the only sentence explaining what went wrong.
   */
  it('leaves the failure standing after the finally has run', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({ ok: false, message: 'Connect GitHub and try again.' });

    await run();

    expect(bootProgress.get()).toMatchObject({ step: 'failed', message: 'Connect GitHub and try again.' });
    expect(phases.map((p) => p.step)).not.toContain('idle');
  });

  it('reports a thrown failure in the server’s own words, and keeps it', async () => {
    workbench.restoreFiles.mockRejectedValue(new Error('Ran out of disk in the sandbox.'));

    await expect(run()).resolves.toMatchObject({ ok: false, message: 'Ran out of disk in the sandbox.' });
    expect(bootProgress.get()).toMatchObject({ step: 'failed', message: 'Ran out of disk in the sandbox.' });
  });

  /*
   * The CONTROL for the two above: the reset is not merely absent. On success the phase really does
   * return to `idle`, so a "fix" that deletes the `finally` outright fails here rather than making the
   * failure tests pass by doing nothing at all.
   */
  it('does clear the phase when the import succeeds', async () => {
    await run();

    expect(bootProgress.get()).toEqual({ step: 'idle' });
  });
});

describe('a failed import leaves no orphan project', () => {
  it('rolls back exactly once when the clone is refused', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({ ok: false, message: 'Over the 256MB import limit.' });

    await run();

    expect(registry.rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back exactly once when writing the files throws', async () => {
    workbench.restoreFiles.mockRejectedValue(new Error('write failed'));

    await run();

    expect(registry.rollback).toHaveBeenCalledTimes(1);
  });

  /*
   * Nothing to roll back: `openImportWorkspace` failing means no row was created (it cleans up its own
   * boot failure). Calling a rollback here would delete a project this call never registered.
   */
  it('rolls back nothing when the registration itself failed', async () => {
    registry.openImportWorkspace.mockRejectedValue(new Error('Not enough credits — 150 needed, 12 available.'));

    await expect(run()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('150 needed') });
    expect(registry.rollback).not.toHaveBeenCalled();
  });

  /** 🔴 And NEVER on success — the rollback deletes the project the user is about to be handed. */
  it('never rolls back a successful import', async () => {
    await run();

    expect(registry.rollback).not.toHaveBeenCalled();
  });

  it('refuses rather than cloning into a workspace with no project id', async () => {
    registry.openImportWorkspace.mockResolvedValue({ sandbox: {}, projectId: undefined, rollback: registry.rollback });

    await expect(run()).resolves.toMatchObject({ ok: false });
    expect(projects.cloneRepoIntoProject).not.toHaveBeenCalled();
    expect(registry.rollback).toHaveBeenCalledTimes(1);
  });
});

describe('the files are written as a RESTORE, not an overlay', () => {
  it('protects the secret family and narrates progress', async () => {
    await run();

    const [files, options] = workbench.restoreFiles.mock.calls[0];
    expect(files).toBe(FILES);

    /*
     * `protectForRepoRestore`, never `protectNothing`: a repo map has no `.env` (it was never pushed),
     * so treating it as the whole truth deletes the one file with no other copy.
     */
    const { protectForRepoRestore } = await import('~/lib/persistence/restore-plan');
    expect(options.protect).toBe(protectForRepoRestore);

    expect(phases).toContainEqual({ step: 'files', done: 2, total: 3 });
    expect(phases).toContainEqual({ step: 'files', done: 3, total: 3 });
  });
});

describe('the settle uses the IMPORT profile', () => {
  /*
   * The OPTIONS, not merely "settle was called". The three profiles differ only in numbers, and the
   * import one is the patient one — a mount profile here would end the wait ~40s early on a large repo,
   * silently, with the workbench uncovering into a half-arrived tree.
   */
  it('passes IMPORT_SETTLE_OPTIONS and a live readCount', async () => {
    await run();

    expect(settle.settleAfterCreation).toHaveBeenCalledTimes(1);

    const options = settle.settleAfterCreation.mock.calls[0][0];
    expect(options).toMatchObject(IMPORT_SETTLE_OPTIONS);
    expect(options.minMs).not.toBe(MOUNT_SETTLE_OPTIONS.minMs);
    expect(options.readCount()).toBe(Object.keys(FILES).length);
  });
});

describe('the hand-off carries pointers, never file bodies', () => {
  it('sends BOTH the project id and the repo URL', async () => {
    await run();

    expect(importChat).toHaveBeenCalledTimes(1);

    const [description, , metadata] = importChat.mock.calls[0];
    expect(description).toContain('Hello-World');
    expect(metadata).toMatchObject({ projectId: 'prj_1', gitUrl: 'https://github.com/octocat/Hello-World.git' });
  });

  /*
   * 🔴 §4.2.8 + `spec/binary-files.md`. A `<boltAction type="file">` here is paid for on this turn and
   * every later turn forever, AND the parser would replay it — decoding the logo through a text protocol
   * and writing it back corrupted over bytes that are already correct on disk.
   */
  it('emits no file bodies and no credential', async () => {
    await run();

    const serialized = JSON.stringify(importChat.mock.calls[0][1]);
    expect(serialized).not.toContain('<boltAction type="file"');
    expect(serialized).not.toContain('console.log(1)');
    expect(serialized).not.toMatch(/ghp_|token|password/i);

    // The CONTROL: the message really is there, so the assertions above are not passing on an empty list.
    expect(serialized).toContain('Hello-World');
  });

  it('records the branch and the file count it actually imported', async () => {
    await run();

    const content = (importChat.mock.calls[0][1] as Array<{ content: string }>)[0].content;
    expect(content).toContain('develop');
    expect(content).toContain('3 file(s)');
  });

  it('names the secrets it declined to import', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({
      ok: true,
      files: FILES,
      repo: 'octocat/Hello-World',
      branch: 'main',
      skippedSecrets: ['.env.production'],
    });

    await run();

    expect((importChat.mock.calls[0][1] as Array<{ content: string }>)[0].content).toContain('.env.production');
  });

  it('does not hand off at all when the import failed', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({ ok: false, message: 'nope' });

    await run();

    expect(importChat).not.toHaveBeenCalled();
  });
});

describe('what the user chose is what gets cloned', () => {
  /*
   * Both selectors have always asked for a branch and a provider, and the old handler dropped the
   * branch on the floor: picking `develop` and getting `main` is a wrong answer from a UI that asked
   * the right question. A GitLab import defaulting to GitHub resolves the wrong token against the
   * wrong host.
   */
  it('forwards the branch and the provider to the server clone', async () => {
    await run({ branch: 'develop', provider: 'gitlab' });

    expect(projects.cloneRepoIntoProject).toHaveBeenCalledWith('prj_1', {
      repo: 'https://github.com/octocat/Hello-World.git',
      branch: 'develop',
      provider: 'gitlab',
    });
  });
});

describe('a lapsed connection is an offer to reconnect, not a credential box', () => {
  it('surfaces reconnect without throwing', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({
      ok: false,
      reconnect: true,
      message: 'Connect GitHub and try again.',
    });

    await expect(run()).resolves.toEqual({
      ok: false,
      reconnect: true,
      message: 'Connect GitHub and try again.',
    });
  });
});

describe('the checkpoint that survives the hand-off’s page load', () => {
  it('writes a local snapshot of the imported bytes', async () => {
    await run();

    expect(snapshots.createLocalSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshots.createLocalSnapshot.mock.calls[0][1]).toMatchObject({ projectId: 'prj_1', files: FILES });
  });

  /** Best-effort: files that are already correct on disk must not be thrown away by a failed checkpoint. */
  it('still completes the import when the checkpoint fails', async () => {
    snapshots.createLocalSnapshot.mockRejectedValue(new Error('IndexedDB is full'));

    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(importChat).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 …AND IT IS LOUD (`spec/fail-loud.md`).
   *
   * The only ENABLED sandbox provider is session-scoped (`SANDBOX_PROVIDER_TRAITS.nodepod` —
   * `outlivesSession: false`), so the runtime holding these bytes does not survive the full page load
   * `importChat` ends in: this checkpoint is what the reload MOUNTS FROM. A failure here therefore means
   * the import may simply not come back, and the user is the only party who can do anything about it —
   * a `logger.error` on that path is a silent data loss with a receipt nobody reads.
   *
   * `logger.error` is asserted alongside, so "made it loud" cannot mean "moved the record from the log
   * to a toast that auto-dismisses".
   */
  it('warns the user, naming the consequence, when the checkpoint fails', async () => {
    snapshots.createLocalSnapshot.mockRejectedValue(new Error('IndexedDB is full'));

    await expect(run()).resolves.toMatchObject({ ok: true });

    expect(toasts.warn).toHaveBeenCalledTimes(1);

    const message = toasts.warn.mock.calls[0][0] as string;

    // The cause, in the failure's own words — never a fixed "something went wrong".
    expect(message).toContain('IndexedDB is full');

    // The consequence, and the one action that fixes it.
    expect(message).toMatch(/reload/i);
    expect(message).toMatch(/repositor/i);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('checkpoint'), expect.any(Error));
  });

  /**
   * The CONTROL. A successful import says nothing — otherwise the assertion above is satisfied by a
   * component that warns on every import, which is how a real warning stops being read.
   */
  it('says nothing when the checkpoint succeeds', async () => {
    await run();

    expect(toasts.warn).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 T9 — AN IMPORTED PROJECT IS BORN LINKED (§4.5.4b).
 *
 * Every property here fails silently. A dropped `provider` records a GitLab project as GitHub, which
 * resolves the wrong token against the wrong host on the user's FIRST push — and it is invisible on the
 * github path, because `github` is the default at every layer beneath this one, so the gitlab case is
 * the only one that can see it. A link that fails must leave the project honestly UNLINKED rather than
 * take down an import whose files are already correct on disk and already checkpointed.
 */
describe('an imported project is born linked', () => {
  /*
   * The whole point of the wrapper: all three fields, and `provider` matching what the CLONE actually
   * resolved. Driven on gitlab deliberately — asserting this on a github clone would pass for an
   * implementation that omits `provider` entirely and lets the route's legacy default stand.
   */
  it('records the complete tuple with the provider the clone actually used', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({
      ok: true,
      files: FILES,
      repo: 'group/my-game',
      branch: 'trunk',
      provider: 'gitlab',
      skippedSecrets: [],
    });

    await run({ repo: 'https://gitlab.com/group/my-game.git', provider: 'gitlab' });

    expect(projects.linkProjectToRepo).toHaveBeenCalledTimes(1);
    expect(projects.linkProjectToRepo).toHaveBeenCalledWith('prj_1', {
      repo: 'group/my-game',
      branch: 'trunk',
      provider: 'gitlab',
    });
  });

  /**
   * 🔴 IT ALSO RECORDS *WHICH COMMIT* IT TOOK — and dropping that is silent, expensive and reads as
   * three unrelated bugs.
   *
   * `selectMountSource` computes `remoteMoved = remoteHead !== lastSyncedCommitSha`, so a link that
   * omits the head leaves `undefined` where a real sha belongs and the project mounts as `diverged`
   * against the very commit it was cloned from. MEASURED live 2026-08-03 in a browser with every
   * store wiped: the two-versions dialog on a project four seconds old, a redundant full restore that
   * rewrote `vite.config.ts`, a Vite restart, and a terminal cleared of the `npm install` log and the
   * dev-server banner — reported as *"there is no proper npm install and npm run dev"*.
   *
   * Asserted as its own test rather than folded into the tuple above, because the tuple assertion
   * uses `toEqual` semantics and therefore PASSES for `head: undefined`. A check that cannot fail for
   * the value it is named after is not a weak test, it is no test.
   */
  it('records the commit the clone actually read', async () => {
    const head = 'f'.repeat(40);

    projects.cloneRepoIntoProject.mockResolvedValue({
      ok: true,
      files: FILES,
      repo: 'octocat/Hello-World',
      branch: 'develop',
      provider: 'github',
      head,
      skippedSecrets: [],
    });

    await run();

    expect(projects.linkProjectToRepo).toHaveBeenCalledWith('prj_1', expect.objectContaining({ head }));
  });

  /**
   * The other half, which costs no dialog and is therefore the easier one to drop: the checkpoint the
   * import just wrote IS the repo's bytes, so `syncedSeq` must move with it. Leave it and
   * `localSeq > syncedSeq` makes a project nobody has touched open claiming it has changes to commit,
   * which teaches the user to ignore the one badge that says their work is at risk.
   */
  it('marks the import checkpoint as already synced', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({
      ok: true,
      files: FILES,
      repo: 'octocat/Hello-World',
      branch: 'develop',
      provider: 'github',
      head: 'f'.repeat(40),
      skippedSecrets: [],
    });

    await run();

    expect(snapshots.markSynced).toHaveBeenCalledWith({}, 'prj_1');
  });

  /*
   * CONTROLS. "Already synced" is a claim about agreeing with a specific commit, so it must not be
   * made when there is no commit to agree with, nor when the link never landed — in both cases the
   * project is honestly unlinked and the mark would be a durability claim the platform cannot back.
   */
  it('does not claim synced when the clone reported no head', async () => {
    await run();

    expect(snapshots.markSynced).not.toHaveBeenCalled();
  });

  it('does not claim synced when the link failed', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({
      ok: true,
      files: FILES,
      repo: 'octocat/Hello-World',
      branch: 'develop',
      provider: 'github',
      head: 'f'.repeat(40),
      skippedSecrets: [],
    });
    projects.linkProjectToRepo.mockResolvedValue({ ok: false, message: 'nope' });

    await run();

    expect(snapshots.markSynced).not.toHaveBeenCalled();
  });

  /*
   * 🔴 ORDER. The checkpoint is what the hand-off's full page load mounts from, and `importChat`
   * NAVIGATES — anything after it is running in a document that is going away. So the link belongs
   * strictly between them, and neither neighbour can be asserted by a call-count.
   */
  it('links after the checkpoint and before the hand-off', async () => {
    const order: string[] = [];
    snapshots.createLocalSnapshot.mockImplementation(async () => void order.push('checkpoint'));
    projects.linkProjectToRepo.mockImplementation(async () => {
      order.push('link');
      return { ok: true };
    });
    importChat.mockImplementation(async () => void order.push('handoff'));

    await run();

    expect(order).toEqual(['checkpoint', 'link', 'handoff']);
  });

  /** A clone that could not name where it read from has no complete tuple to write — and never a partial one. */
  it.each([
    ['no provider', { repo: 'octocat/Hello-World', branch: 'main' }],
    ['no branch', { repo: 'octocat/Hello-World', provider: 'github' as const }],
    ['no repo', { branch: 'main', provider: 'github' as const }],
  ])('does not attempt a half-written link when the clone reported %s', async (_label, resolved) => {
    projects.cloneRepoIntoProject.mockResolvedValue({ ok: true, files: FILES, skippedSecrets: [], ...resolved });

    await expect(run()).resolves.toMatchObject({ ok: true });

    expect(projects.linkProjectToRepo).not.toHaveBeenCalled();
  });

  /*
   * Best-effort, both shapes. A refusal is a missing POINTER — the code is on disk, the checkpoint is
   * written, and rolling the project back over it would destroy the successful part of the operation.
   */
  it('completes the import when the link is refused', async () => {
    projects.linkProjectToRepo.mockResolvedValue({ ok: false, message: 'The server returned an error (500).' });

    await expect(run()).resolves.toEqual({ ok: true });

    expect(importChat).toHaveBeenCalledTimes(1);
    expect(registry.rollback).not.toHaveBeenCalled();
    expect(bootProgress.get()).toEqual({ step: 'idle' });

    // …and it is REPORTED. Surviving the failure silently is the other way to get this wrong.
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('The server returned an error (500).'));
  });

  /*
   * 🔴 And when it THROWS. `linkProjectToRepo` is documented never to throw, but this call sits inside
   * the outer `catch` whose job is `rollback()` — so if that contract is ever broken the import would
   * DELETE a project whose files are correct, over a pointer write. Best-effort has to be enforced at
   * the call site, not assumed from the callee's doc comment.
   */
  it('completes the import when the link throws', async () => {
    projects.linkProjectToRepo.mockRejectedValue(new Error('boom'));

    await expect(run()).resolves.toEqual({ ok: true });

    expect(importChat).toHaveBeenCalledTimes(1);
    expect(registry.rollback).not.toHaveBeenCalled();
    expect(bootProgress.get()).toEqual({ step: 'idle' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not record the link'), expect.any(Error));
  });

  /** No files, no link: a refused clone must not record a repository this project never received. */
  it('does not link when the clone was refused', async () => {
    projects.cloneRepoIntoProject.mockResolvedValue({ ok: false, message: 'nope' });

    await run();

    expect(projects.linkProjectToRepo).not.toHaveBeenCalled();
  });
});

describe('projectNameFromRepo', () => {
  it.each([
    ['https://github.com/octocat/Hello-World.git', 'Hello-World'],
    ['https://github.com/octocat/Hello-World', 'Hello-World'],
    ['https://gitlab.com/group/sub/my-game/', 'my-game'],
    ['octocat/Hello-World', 'Hello-World'],
    ['  octocat/Hello-World.git  ', 'Hello-World'],
    ['', 'Imported project'],
  ])('%s → %s', (repo, expected) => {
    expect(projectNameFromRepo(repo)).toBe(expected);
  });
});
