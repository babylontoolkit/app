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
import {
  decideLiveSandboxIsTruth,
  selectMountSource,
  workingCopyRanks,
  type MountFacts,
  type MountSource,
} from './mount-source';

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
 * 🔴 THE BRANCH STAMP ON THE RECOVERY COPY (§4.13a T17).
 *
 * There is exactly ONE working copy per project and it is overwritten in place, so the instant a
 * branch switch lands it describes a tree the project is no longer on — with nothing in the object
 * saying so. `hasWorkingCopy` is a boolean and cannot see that.
 *
 * The blast radius is narrow and entirely silent: the copy is never ranked against a local checkpoint,
 * so this only bites on a FRESH BROWSER, on a LINKED project, whose remote we could not reach. In
 * exactly that state a recovery would restore another branch's tree over a project whose link tuple
 * names a different one, and the user opens a game they did not write, with no error anywhere.
 *
 * Two directions, and only one of them is obvious:
 *
 *   - a stamp that DISAGREES must not rank (the loss above);
 *   - a stamp that is ABSENT must still rank. Every copy written before the field existed has none,
 *     and reading silence as disagreement would turn crash recovery OFF for every project that has not
 *     checkpointed since — the `remoteHead` `undefined`-vs-`null` distinction, in the same file.
 *
 * The CONTROL comes first deliberately: without it, an implementation that simply never ranks the
 * working copy passes every other assertion in this block.
 */
describe('the working copy carries the branch it was written from (§4.13a)', () => {
  /** The three states that produce `working` — each enumerated so no gate can be dropped unnoticed. */
  const RANKING_STATES: Array<{ what: string; facts: MountFacts }> = [
    { what: 'unlinked with nothing in this browser', facts: { linked: false, hasWorkingCopy: true } },
    {
      what: 'linked but the provider is unreachable',
      facts: { linked: true, remoteHead: undefined, hasWorkingCopy: true },
    },
    { what: 'linked to a branch with no commits', facts: { linked: true, remoteHead: null, hasWorkingCopy: true } },
  ];

  /*
   * 🔴 THE CONTROL. Every other test in this block asserts that something does NOT happen, and a gate
   * that refused the working copy outright — or a `workingCopyRanks` hardwired to `false` — would
   * satisfy all of them while silently deleting §4.5.4c. This is the ordinary case: the stamp agrees
   * with the project's branch, and the recovery still happens, in all three states.
   */
  it('CONTROL — a stamp matching the linked branch still mounts the recovery copy, in every state', () => {
    for (const { what, facts } of RANKING_STATES) {
      expect(
        selectMountSource({ ...facts, workingCopyBranch: 'feature/hud', linkedBranch: 'feature/hud' }),
        what,
      ).toEqual({ source: 'working' });
    }
  });

  /*
   * The loss this exists to prevent. `main` on disk, `feature/hud` on the project — restoring would
   * replace the user's files with another branch's, so the decision falls through to the honest empty
   * project instead.
   */
  it('refuses a copy stamped with a different branch, in every state', () => {
    for (const { what, facts } of RANKING_STATES) {
      expect(selectMountSource({ ...facts, workingCopyBranch: 'main', linkedBranch: 'feature/hud' }), what).toEqual({
        source: 'empty',
      });
    }
  });

  /*
   * 🔴 ABSENT IS UNKNOWN, NOT A MISMATCH. Every copy written before T17 has no stamp, and treating
   * that as disagreement would silently switch crash recovery off for exactly the oldest projects —
   * the ones most likely to need it. Old copies must behave EXACTLY as they did before the field
   * existed, which is why this is asserted against the same three states rather than spot-checked.
   */
  it('still mounts an UNSTAMPED copy — silence is not disagreement', () => {
    for (const { what, facts } of RANKING_STATES) {
      expect(selectMountSource({ ...facts, workingCopyBranch: undefined, linkedBranch: 'feature/hud' }), what).toEqual({
        source: 'working',
      });
    }
  });

  /*
   * The other unknown side: a project whose own branch we do not know (an unlinked project, or a
   * status read that could not answer). There is nothing to disagree WITH, so the pre-stamp behaviour
   * stands — the same bias, from the opposite direction.
   */
  it('still mounts when the project’s own branch is unknown', () => {
    for (const { what, facts } of RANKING_STATES) {
      expect(selectMountSource({ ...facts, workingCopyBranch: 'main', linkedBranch: undefined }), what).toEqual({
        source: 'working',
      });
    }
  });

  /*
   * A mismatch removes the working copy from the decision; it does not rewrite the rest of it. An
   * unlinked project with a remix seed still gets its seed rather than an empty editor.
   */
  it('falls back to the remix seed rather than to nothing when the stamp disagrees', () => {
    expect(
      selectMountSource({
        linked: false,
        hasWorkingCopy: true,
        hasServerSeed: true,
        workingCopyBranch: 'main',
        linkedBranch: 'feature/hud',
      }),
    ).toEqual({ source: 'seed' });
  });

  /*
   * CONTROL for the branch above — the seed only wins because the copy was refused. With a matching
   * stamp the working copy still beats the seed (the seed is the state the project was BORN in).
   */
  it('CONTROL — a matching stamp still beats the remix seed', () => {
    expect(
      selectMountSource({
        linked: false,
        hasWorkingCopy: true,
        hasServerSeed: true,
        workingCopyBranch: 'feature/hud',
        linkedBranch: 'feature/hud',
      }),
    ).toEqual({ source: 'working' });
  });

  /*
   * The stamp is only ever consulted where the copy could be MOUNTED. A mismatched stamp must not
   * disturb a decision that was never going to use the copy — otherwise the guard would start
   * changing outcomes on paths that have their own, correct, answers.
   */
  it('changes nothing on the decisions that never reach the working copy', () => {
    const stamped = { workingCopyBranch: 'main', linkedBranch: 'feature/hud', hasWorkingCopy: true } as const;

    // Local checkpoints always win — there is nothing to compare, so nothing is compared.
    expect(selectMountSource({ ...inSync, ...stamped })).toMatchObject({ source: 'local' });

    // A reachable repo outranks the copy either way.
    expect(
      selectMountSource({ linked: true, remoteHead: 'abc123', lastSyncedCommitSha: 'abc123', ...stamped }),
    ).toEqual({ source: 'repo', reason: 'no-local-copy' });

    // And a divergence is still a divergence.
    expect(
      selectMountSource({
        linked: true,
        remoteHead: 'newsha',
        lastSyncedCommitSha: 'oldsha',
        localSeq: 5,
        syncedSeq: 2,
        ...stamped,
      }),
    ).toMatchObject({ source: 'diverged' });
  });
});

/**
 * `workingCopyRanks` on its own — a "may we overwrite the user's files" question, which is the
 * category `restore-target.ts` and `planRestore` are in, and the reason it is pure and exported.
 *
 * The REASON is part of the contract, not decoration. A recovery that silently does not happen is
 * indistinguishable from one that was never available (`spec/fail-loud.md`), and a refusal that names
 * no cause is read as the feature being broken — so the sentence has to name BOTH branches: the one
 * the copy holds and the one the project is on.
 */
describe('workingCopyRanks', () => {
  it('ranks a matching stamp, and says nothing about why', () => {
    expect(workingCopyRanks({ workingCopyBranch: 'main', linkedBranch: 'main' })).toEqual({ ranks: true });
  });

  it('refuses a mismatch and names BOTH branches', () => {
    const verdict = workingCopyRanks({ workingCopyBranch: 'main', linkedBranch: 'feature/hud' });

    expect(verdict.ranks).toBe(false);
    expect(verdict.reason).toContain('main');
    expect(verdict.reason).toContain('feature/hud');
  });

  /* Unknown on either side is not disagreement — the pre-stamp behaviour stands. */
  it('ranks when either side is unknown', () => {
    expect(workingCopyRanks({ workingCopyBranch: undefined, linkedBranch: 'main' })).toEqual({ ranks: true });
    expect(workingCopyRanks({ workingCopyBranch: 'main', linkedBranch: undefined })).toEqual({ ranks: true });
    expect(workingCopyRanks({})).toEqual({ ranks: true });
  });

  /*
   * An empty string is not a branch name. It can only arrive from a malformed body or a half-written
   * status, and matching it against a real branch — or refusing a copy because of it — would both be
   * decisions taken on a value that means nothing.
   */
  it('treats an empty string as unknown rather than as a name', () => {
    expect(workingCopyRanks({ workingCopyBranch: '', linkedBranch: 'main' })).toEqual({ ranks: true });
    expect(workingCopyRanks({ workingCopyBranch: 'main', linkedBranch: '' })).toEqual({ ranks: true });
  });

  /* Branch names are case-sensitive in git, and `Main` is a different branch from `main`. */
  it('compares names exactly', () => {
    expect(workingCopyRanks({ workingCopyBranch: 'Main', linkedBranch: 'main' }).ranks).toBe(false);
    expect(workingCopyRanks({ workingCopyBranch: 'feature/hud', linkedBranch: 'feature/hud ' }).ranks).toBe(false);
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
