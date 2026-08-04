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
import { decideLiveSandboxIsTruth, selectMountSource, type MountFacts, type MountSource } from './mount-source';

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
 * 🔴 A FRESHLY CLONED PROJECT IS NOT DIVERGED FROM THE COMMIT IT WAS CLONED FROM.
 *
 * MEASURED live 2026-08-03, in a browser with IndexedDB, localStorage and the service worker all
 * wiped: cloning `burn-the-asphalt-demo` logged `Mounting project … from: diverged` and put up the
 * two-versions dialog for a project that had existed for four seconds.
 *
 * The cause is entirely in the FACTS, not in the rule below — `remoteMoved` is
 * `remoteHead !== lastSyncedCommitSha`, and the import recorded no `lastSyncedCommitSha`, so a real
 * sha was compared against `undefined` and every clone "moved". These tests pin the two halves the
 * importer now supplies, because the damage was three layers downstream and read as unrelated bugs:
 * the redundant restore rewrote `vite.config.ts`, Vite restarted, and a restart CLEARS the terminal —
 * so the `npm install` log and the dev-server banner vanished and the workspace looked inert.
 */
describe('a fresh clone (§4.13) — recorded at the commit it took', () => {
  const justCloned = { linked: true, lastSyncedCommitSha: 'abc123', remoteHead: 'abc123' } as const;

  it('mounts local rather than reporting a divergence against itself', () => {
    expect(selectMountSource({ ...justCloned, localSeq: 0, syncedSeq: 0 })).toEqual({
      source: 'local',
      unsavedWork: false,
    });
  });

  /*
   * The half that is easy to drop, because it costs no dialog: without `markSynced` the import's own
   * checkpoint outranks a `syncedSeq` that was never written, so a project nobody has touched opens
   * claiming it has changes to commit. That trains the user to ignore the one badge that tells them
   * their work is at risk.
   */
  it('does not report the import checkpoint as unsaved work', () => {
    expect(selectMountSource({ ...justCloned, localSeq: 0 })).toMatchObject({ unsavedWork: true });
    expect(selectMountSource({ ...justCloned, localSeq: 0, syncedSeq: 0 })).toMatchObject({ unsavedWork: false });
  });

  /*
   * The CONTROL, and the reason this file cannot claim more than it proves: recording the sha must not
   * blind the rule to a genuine divergence. A real commit landing after the clone still has to stop.
   */
  it('still reports a divergence once the repo actually moves', () => {
    expect(selectMountSource({ ...justCloned, remoteHead: 'def456', localSeq: 3, syncedSeq: 0 })).toEqual({
      source: 'diverged',
      remoteHead: 'def456',
    });
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

describe('the server working copy (§4.5.4c)', () => {
  /*
   * 🔴 The measured loss this whole mechanism exists for. An UNLINKED project with nothing in this
   * browser used to be `empty` — which is how a completed, paid-for generation came back as a blank
   * project after a tab crash, and how clearing site data destroyed a game outright.
   */
  it('mounts the recovery copy for an unlinked project this browser has lost', () => {
    expect(selectMountSource({ linked: false, hasWorkingCopy: true })).toEqual({ source: 'working' });
  });

  it('is still empty when there is no recovery copy either', () => {
    expect(selectMountSource({ linked: false })).toEqual({ source: 'empty' });
  });

  /* The seed is the state the project was BORN in; the working copy is where it actually got to. */
  it('prefers the recovery copy over a remix seed', () => {
    expect(selectMountSource({ linked: false, hasWorkingCopy: true, hasServerSeed: true })).toEqual({
      source: 'working',
    });
  });

  /*
   * 🔴 THE TRAP. `seq` comes from `nextSeq` in the BROWSER's IndexedDB, so it is per-browser and two
   * devices both start at 0. Ranking a working copy against local checkpoints compares two unrelated
   * counters and picks an arbitrary winner while looking like a decision. Local always wins when it
   * exists — there is nothing to compare, so nothing is compared.
   */
  it('never lets the recovery copy override this browser’s own checkpoints', () => {
    expect(selectMountSource({ linked: false, localSeq: 0, hasWorkingCopy: true })).toMatchObject({
      source: 'local',
    });
    expect(selectMountSource({ ...inSync, localSeq: 3, syncedSeq: 3, hasWorkingCopy: true })).toMatchObject({
      source: 'local',
    });
  });

  /* Offline with nothing local: the recovery copy is all we can reach, and it beats a blank editor. */
  it('mounts the recovery copy when linked but the provider is unreachable', () => {
    expect(selectMountSource({ linked: true, remoteHead: undefined, hasWorkingCopy: true })).toEqual({
      source: 'working',
    });
  });

  it('mounts the recovery copy when the linked branch has no commits', () => {
    expect(selectMountSource({ linked: true, remoteHead: null, hasWorkingCopy: true })).toEqual({
      source: 'working',
    });
  });

  /*
   * ⚠️ Deliberately NOT preferred over a reachable repo. There is no ordering spanning a commit sha
   * and a per-browser seq, so choosing would mean guessing — and guessing wrong mounts a stale project
   * over newer commits. A linked project also already has durable storage.
   */
  it('never outranks a reachable repo', () => {
    expect(
      selectMountSource({ linked: true, remoteHead: 'abc123', lastSyncedCommitSha: 'abc123', hasWorkingCopy: true }),
    ).toEqual({ source: 'repo', reason: 'no-local-copy' });
  });

  /* Divergence is still divergence — the recovery copy must not quietly resolve it. */
  it('does not suppress a divergence', () => {
    expect(
      selectMountSource({
        linked: true,
        remoteHead: 'newsha',
        lastSyncedCommitSha: 'oldsha',
        localSeq: 5,
        syncedSeq: 2,
        hasWorkingCopy: true,
      }),
    ).toMatchObject({ source: 'diverged' });
  });
});

/**
 * The warm-boot gate: does the LIVE sandbox disk outrank every client-held copy?
 *
 * `selectMountSource` above decides WHICH copy would be mounted; this decides whether that copy gets
 * written over a sandbox that is already holding the project. Both wrong answers are silent, and they
 * destroy different things:
 *
 *   - `true` when it should be `false` — a stale or FOREIGN filesystem becomes the project's truth,
 *     and §4.5.4b then pushes it to the user's own repository under their name;
 *   - `false` when it should be `true` — a client copy serialized mid-watcher-lag is restored over a
 *     healthy warm sandbox (MEASURED live: the starter's `Home.css` landing under a generation's
 *     `Home.tsx`, reverting a landing page two hours after it was built).
 *
 * Enumerated rather than spot-checked for the same reason as the matrix above: there are only
 * 6 × 3 × 2 inputs, and every one of them is somebody's only copy of a game.
 */
const ALL_SOURCES: MountSource['source'][] = ['local', 'repo', 'seed', 'working', 'empty', 'diverged'];
const ALL_IDENTITIES = ['match', 'mismatch', 'unknown'] as const;

/** The sources that would OVERWRITE a live sandbox, and therefore the only ones the gate can open for. */
const PROTECTED_SOURCES: MountSource['source'][] = ['local', 'diverged', 'working'];

describe('decideLiveSandboxIsTruth — the warm-boot gate', () => {
  /*
   * 🔴 THE WEBCONTAINER CASE, and the reason this can never be reduced to the source check alone. A
   * tab-local WASM filesystem is EMPTY on every page load, so `bootRestoredFilesystem` is always
   * false there and the restore IS the project. Opening the gate on that provider would mount a
   * project by mounting nothing — an empty editor, with no error, for every user of the incumbent
   * runtime.
   */
  it('never opens when the boot restored no filesystem — whatever the source or the sentinel says', () => {
    for (const source of ALL_SOURCES) {
      for (const identity of ALL_IDENTITIES) {
        expect(decideLiveSandboxIsTruth({ bootRestoredFilesystem: false, identity, source })).toBe(false);
      }
    }
  });

  /*
   * 🔴 THE SENTINEL MISMATCH — a sandbox that is present and NAMES ANOTHER PROJECT
   * (`readIdentityVerdict`). With per-project VMs this should be impossible, which is exactly why it
   * is worth a clause: the failure it catches is a mis-pointed `sandbox_id` (an operator edit, a
   * restored old row, a compare-and-set that lost), and the consequence of trusting that disk is one
   * project's files becoming another project's truth and then being pushed to that project's repo.
   * The gate must stay CLOSED even on a warm boot whose source is otherwise protected.
   */
  it('stays closed on a mismatch, even warm and on an otherwise-qualifying source', () => {
    for (const source of PROTECTED_SOURCES) {
      expect(decideLiveSandboxIsTruth({ bootRestoredFilesystem: true, identity: 'mismatch', source })).toBe(false);
    }
  });

  /*
   * 🔴 `unknown` IS NOT A MISMATCH, and this is the asymmetry that matters. A sandbox created before
   * the sentinel existed — or one whose `.codesandbox/` was cleaned — makes no claim, and treating
   * silence as an accusation would send EVERY warm VM in existence down the restore-from-a-client-copy
   * path the gate exists to avoid. Pinned as an equivalence rather than as separate cases, so the two
   * verdicts cannot drift apart later.
   */
  it('treats a sandbox that makes no claim exactly like one that agrees', () => {
    for (const source of ALL_SOURCES) {
      expect(decideLiveSandboxIsTruth({ bootRestoredFilesystem: true, identity: 'unknown', source })).toBe(
        decideLiveSandboxIsTruth({ bootRestoredFilesystem: true, identity: 'match', source }),
      );
    }
  });

  /*
   * The source gate. `local`, `diverged` and `working` are the copies that would be WRITTEN over the
   * sandbox, so they are the only ones the gate can protect against.
   */
  it('opens for the sources that would overwrite the sandbox', () => {
    for (const source of PROTECTED_SOURCES) {
      for (const identity of ['match', 'unknown'] as const) {
        expect(decideLiveSandboxIsTruth({ bootRestoredFilesystem: true, identity, source })).toBe(true);
      }
    }
  });

  /*
   * And stays shut for the rest — not because they are dangerous, but because there is nothing to
   * protect: `repo` is an EXPLICIT user-facing sync decision (§4.13 — the user asked for the repo's
   * version, and a gate that overrode that would make "Sync from GitHub" do nothing), while `empty`
   * and `seed` only run when the browser holds no copy at all.
   */
  it('stays shut for repo, seed and empty on a warm boot', () => {
    for (const source of ALL_SOURCES.filter((candidate) => !PROTECTED_SOURCES.includes(candidate))) {
      for (const identity of ALL_IDENTITIES) {
        expect(decideLiveSandboxIsTruth({ bootRestoredFilesystem: true, identity, source })).toBe(false);
      }
    }
  });

  /*
   * CONTROL. Every assertion above is a `false` except one, so a function that simply returned `false`
   * — or a loop that iterated nothing — would pass most of this block. This is the case that has to
   * be TRUE: the whole point of the gate is that a healthy warm sandbox wins.
   */
  it('CONTROL: the ordinary warm resume genuinely opens the gate', () => {
    expect(decideLiveSandboxIsTruth({ bootRestoredFilesystem: true, identity: 'match', source: 'local' })).toBe(true);
  });
});
