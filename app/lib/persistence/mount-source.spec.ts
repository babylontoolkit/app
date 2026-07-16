/**
 * Which copy of the project gets mounted (SPEC §4.5.4b, §4.13).
 *
 * Every case below is a way to lose someone's game without an error message. The two that matter most
 * are opposites, which is why the whole matrix is enumerated rather than spot-checked:
 *
 *   - mounting the repo over newer local work destroys the only copy of that work;
 *   - mounting stale local work over a newer repo means the next save either clobbers a real commit or
 *     diverges for reasons the user cannot see.
 *
 * And the third: deciding a winner when both moved. §4.13 forbids the platform ever merging or
 * choosing — that is the user's call, always.
 */
import { describe, expect, it } from 'vitest';
import { selectMountSource, type MountFacts } from './mount-source';

/** A linked project sitting exactly where it was last saved. Each test perturbs one fact. */
const inSync: MountFacts = {
  linked: true,
  lastSyncedCommitSha: 'abc123',
  remoteHead: 'abc123',
  localSeq: 5,
  syncedSeq: 5,
};

describe('unlinked — the browser is the whole story', () => {
  it('mounts local, and always reports the work as unsaved', () => {
    expect(selectMountSource({ linked: false, localSeq: 3 })).toEqual({ source: 'local', unsavedWork: true });
  });

  /** Nothing about an unlinked project is saved anywhere, however many checkpoints it has. */
  it('reports unsaved even when a stale syncedSeq is somehow present', () => {
    expect(selectMountSource({ linked: false, localSeq: 3, syncedSeq: 3 })).toEqual({
      source: 'local',
      unsavedWork: true,
    });
  });

  it('reads the remix seed when this browser has never opened it', () => {
    expect(selectMountSource({ linked: false, hasServerSeed: true })).toEqual({ source: 'seed' });
  });

  it('prefers local checkpoints over the seed once the project has been worked on', () => {
    expect(selectMountSource({ linked: false, localSeq: 0, hasServerSeed: true })).toMatchObject({ source: 'local' });
  });

  it('is empty for a brand-new project with nothing anywhere', () => {
    expect(selectMountSource({ linked: false })).toEqual({ source: 'empty' });
  });

  /** The repo must not enter the decision at all — an unlinked project has no repo to consult. */
  it('ignores repo facts entirely', () => {
    expect(selectMountSource({ linked: false, localSeq: 1, remoteHead: 'zzz', lastSyncedCommitSha: 'aaa' })).toEqual({
      source: 'local',
      unsavedWork: true,
    });
  });
});

describe('linked and in sync', () => {
  it('mounts local without touching the network', () => {
    expect(selectMountSource(inSync)).toEqual({ source: 'local', unsavedWork: false });
  });

  it('mounts local and flags the unsaved work when this browser has moved on', () => {
    expect(selectMountSource({ ...inSync, localSeq: 9 })).toEqual({ source: 'local', unsavedWork: true });
  });

  /** Linked but never pushed from this browser: everything local is unsaved. */
  it('treats a missing syncedSeq as "nothing has been saved from here"', () => {
    expect(selectMountSource({ ...inSync, syncedSeq: undefined })).toEqual({ source: 'local', unsavedWork: true });
  });
});

describe('the repo has moved', () => {
  it('takes the repo when we have no unsaved work — a clean fast-forward', () => {
    expect(selectMountSource({ ...inSync, remoteHead: 'def456' })).toEqual({
      source: 'repo',
      reason: 'remote-ahead',
    });
  });

  /** A different device saved this project; this browser has never seen it. */
  it('takes the repo when this browser has no copy at all', () => {
    expect(selectMountSource({ ...inSync, localSeq: undefined, syncedSeq: undefined })).toEqual({
      source: 'repo',
      reason: 'no-local-copy',
    });
  });

  it('takes the repo for a fresh browser even when the repo is where we last left it', () => {
    expect(selectMountSource({ ...inSync, localSeq: undefined })).toMatchObject({ source: 'repo' });
  });
});

describe('both moved — the platform never picks a winner (§4.13)', () => {
  /**
   * The user committed from VS Code AND has unpushed work in the browser. Auto-mounting the repo eats
   * the browser's work; auto-keeping local means the next save fights the commit. Neither is ours to
   * choose.
   */
  it('reports divergence rather than resolving it', () => {
    expect(selectMountSource({ ...inSync, remoteHead: 'def456', localSeq: 9 })).toEqual({
      source: 'diverged',
      remoteHead: 'def456',
    });
  });

  it('carries the remote head so the caller can show what it is choosing between', () => {
    const result = selectMountSource({ ...inSync, remoteHead: 'newsha', localSeq: 99 });

    expect(result).toMatchObject({ source: 'diverged', remoteHead: 'newsha' });
  });
});

/**
 * 🔴 `undefined` (could not ask) is not `null` (the branch is empty).
 *
 * Collapsing them means a reload on a flaky connection reads the repo as empty, concludes the browser
 * is authoritative, and cheerfully offers to push over a repo it never managed to read.
 */
describe('offline — "I do not know" is not "the repo is empty"', () => {
  it('mounts local and never claims the repo moved', () => {
    expect(selectMountSource({ ...inSync, remoteHead: undefined, localSeq: 9 })).toEqual({
      source: 'local',
      unsavedWork: true,
    });
  });

  it('still reports honestly that everything is saved when nothing local has changed', () => {
    expect(selectMountSource({ ...inSync, remoteHead: undefined })).toEqual({ source: 'local', unsavedWork: false });
  });

  it('never reports divergence on a fact it could not read', () => {
    expect(
      selectMountSource({ ...inSync, remoteHead: undefined, localSeq: 9, lastSyncedCommitSha: 'aaa' }),
    ).toMatchObject({ source: 'local' });
  });

  it('is empty rather than reaching for a repo it cannot see', () => {
    expect(selectMountSource({ ...inSync, remoteHead: undefined, localSeq: undefined })).toEqual({ source: 'empty' });
  });
});

describe('linked to a branch with no commits', () => {
  /** Save created the repo and the push failed — the link exists, the bytes never landed. */
  it('mounts local and calls it unsaved, because it is', () => {
    expect(selectMountSource({ linked: true, remoteHead: null, localSeq: 4 })).toEqual({
      source: 'local',
      unsavedWork: true,
    });
  });

  it('is empty when there is nothing on either side', () => {
    expect(selectMountSource({ linked: true, remoteHead: null })).toEqual({ source: 'empty' });
  });

  /** An empty remote is not something to fast-forward TO — there is nothing there. */
  it('never tries to mount an empty repo over real local work', () => {
    expect(selectMountSource({ linked: true, remoteHead: null, localSeq: 0, syncedSeq: 0 })).toMatchObject({
      source: 'local',
    });
  });
});

describe('seq boundaries', () => {
  /** seq starts at 0, so `?? -1` and not `?? 0` — checkpoint zero is real work. */
  it('counts checkpoint 0 as unsaved work when nothing has been pushed', () => {
    expect(selectMountSource({ linked: true, remoteHead: null, localSeq: 0 })).toEqual({
      source: 'local',
      unsavedWork: true,
    });
  });

  it('counts checkpoint 0 as saved when checkpoint 0 is what was pushed', () => {
    expect(selectMountSource({ ...inSync, localSeq: 0, syncedSeq: 0 })).toEqual({
      source: 'local',
      unsavedWork: false,
    });
  });

  it('does not call an older local checkpoint unsaved work', () => {
    // After a restore the pointer can sit behind what was pushed. That is not new work.
    expect(selectMountSource({ ...inSync, localSeq: 2, syncedSeq: 5 })).toEqual({
      source: 'local',
      unsavedWork: false,
    });
  });
});
