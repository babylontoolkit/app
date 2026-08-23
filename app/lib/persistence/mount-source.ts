/**
 * Where do a project's files come from when it is opened? (SPEC §4.5.4b, §4.13)
 *
 * Pure, and tested exhaustively, for the same reason `restore-target.ts` is: this decision can
 * silently destroy work. Under repo-primary persistence a project has up to three possible sources —
 * this browser's checkpoints, the linked repo, and (for a fresh remix) a server seed — and they can
 * legitimately disagree. Every wrong answer is silent:
 *
 *   - prefer the repo when the browser is ahead → the user's unsaved work vanishes on reload, and the
 *     only copy of it is gone;
 *   - prefer the browser when the repo is ahead → they edit a stale project, and their next save
 *     either clobbers the newer commit or diverges for reasons they cannot see;
 *   - miss a divergence → the platform silently picks a winner, which §4.13 forbids outright.
 *
 * So the rules are written down here, once, as data in → decision out. No fetching, no mounting, no
 * `await`. The caller does the IO; this decides what the IO should be.
 *
 * ## The three facts this decision needs
 *
 * `lastSyncedCommitSha` — the commit the platform last agreed with the repo about.
 * `remoteHead`          — where the repo is NOW (null = branch has no commits, or offline).
 * `localSeq`/`syncedSeq` — how far this browser has moved since the last save.
 *
 * The local pair is what makes "the browser has unsaved work" answerable. `localSeq` is the newest
 * checkpoint's seq; `syncedSeq` is the seq recorded when we last pushed. `localSeq > syncedSeq` means
 * checkpoints happened after the last save — real work that exists nowhere else.
 */

export interface MountFacts {
  /** False = UNLINKED: browser-only, and the repo is not part of this decision at all. */
  linked: boolean;

  /** The commit the platform last synced this project to. Undefined = linked but never pushed. */
  lastSyncedCommitSha?: string;

  /**
   * The linked branch's head right now. `null` = the branch has no commits.
   *
   * `undefined` means we could not ask — offline, or the provider errored. That is DIFFERENT from
   * `null` and must stay different: treating "I don't know" as "the repo is empty" would let a reload
   * with a flaky connection decide the browser is authoritative and push over a repo it never read.
   */
  remoteHead?: string | null;

  /** Seq of the newest local checkpoint. Undefined = this browser has no copy of the project. */
  localSeq?: number;

  /** Seq of the checkpoint that was current when we last pushed. Undefined = never pushed from here. */
  syncedSeq?: number;

  /** A one-time server copy left by `api.remix` — only ever present on a freshly remixed project. */
  hasServerSeed?: boolean;

  /**
   * The platform holds a recovery WORKING COPY for this project (§4.5.4c).
   *
   * 🔴 **A BOOLEAN, DELIBERATELY — never its `seq`.** The obvious rule ("mount whichever copy has the
   * higher seq") is WRONG and would fail silently: `seq` is allocated from `nextSeq` in the BROWSER's
   * IndexedDB (`local-snapshots.ts`), so it is per-browser, not global. Two devices both start at 0,
   * and comparing device A's working copy against device B's local checkpoints compares two unrelated
   * counters — which reads as a confident decision and picks an arbitrary winner. The shared counter
   * is meaningful only WITHIN one browser, which is exactly where the working copy is never needed.
   *
   * So this decision never ranks the working copy against a local copy: it is consulted only when this
   * browser has NOTHING, where there is nothing to compare it to and it is strictly better than the
   * `empty` it replaces.
   */
  hasWorkingCopy?: boolean;

  /**
   * Which branch the working copy says its files came from (§4.13a).
   *
   * 🔴 There is ONE copy per project, overwritten in place, so it is stale-by-branch the instant a
   * switch lands. `hasWorkingCopy` alone cannot see that, and the blast radius is narrow but real:
   * this decision never ranks the copy against a local checkpoint, so it only matters on a FRESH
   * BROWSER, on a LINKED project, whose remote we could not reach — and in exactly that state a
   * recovery would restore another branch's tree over a project whose link tuple names a different
   * one. The user opens a game they did not write, with no error anywhere.
   *
   * ⚠️ **`undefined` is UNKNOWN and is never read as a match.** Every copy written before the stamp
   * existed has none, and treating silence as agreement would wave through precisely the oldest and
   * most stale copies — the `remoteHead` `undefined`-vs-`null` distinction, in the same file.
   */
  workingCopyBranch?: string;

  /** The branch the project's link tuple names right now, to compare the stamp against. */
  linkedBranch?: string;
}

/**
 * May the working copy be restored?
 *
 * Pure and separate so the rule is readable and testable on its own — this is a "may we overwrite the
 * user's files" question, which is the category `restore-target.ts` and `planRestore` are in.
 *
 * `spec/fail-loud.md` rule 2: a capability we cannot vouch for reports OFF, never ON. So the answer is
 * NO whenever the two names are both known and disagree, and YES in every state where the question
 * does not arise — an unlinked project (no branch to disagree with), an unstamped copy (unknown, and
 * the pre-stamp behaviour is what those copies were written under), or a project whose own branch we
 * do not know.
 */
export function workingCopyRanks(facts: Pick<MountFacts, 'workingCopyBranch' | 'linkedBranch'>): {
  ranks: boolean;
  reason?: string;
} {
  const stamped = facts.workingCopyBranch;
  const linked = facts.linkedBranch;

  if (!stamped || !linked || stamped === linked) {
    return { ranks: true };
  }

  return {
    ranks: false,
    reason:
      `the recovery copy on our servers was saved from ${stamped}, and this project is on ${linked}. ` +
      "It was not restored, because it would have replaced your files with another branch's.",
  };
}

/**
 * What the caller should mount.
 *
 * - `local`    — this browser's current checkpoint. Nothing to fetch.
 * - `repo`     — fetch the linked repo and mount it (the browser has nothing, or the repo moved ahead).
 * - `seed`     — read the one-time remix copy from the platform.
 * - `empty`    — nothing to mount anywhere; a brand-new project before its first generation.
 * - `diverged` — both sides moved since they last agreed. The platform NEVER merges (§4.13): the caller
 *   must ask the user, and until they answer the LOCAL files stay on screen, because they are the
 *   unsaved ones.
 */
export type MountSource =
  | { source: 'local'; unsavedWork: boolean }
  | { source: 'repo'; reason: 'no-local-copy' | 'remote-ahead' }
  | { source: 'seed' }
  | { source: 'working' }
  | { source: 'empty' }
  | { source: 'diverged'; remoteHead: string };

export function selectMountSource(facts: MountFacts): MountSource {
  const hasLocal = facts.localSeq !== undefined;
  const unsavedWork = hasLocal && facts.localSeq! > (facts.syncedSeq ?? -1);

  /*
   * UNLINKED: the browser is the whole story. A seed is the only other possibility, and it exists
   * exactly once, for a remix that has not been opened yet.
   */
  if (!facts.linked) {
    if (hasLocal) {
      return { source: 'local', unsavedWork: true };
    }

    /*
     * 🔴 The case §4.5.4c exists for. An UNLINKED project with nothing in this browser used to be
     * `empty` — which is how a completed, paid-for generation came back as a blank project after a tab
     * crash, and how clearing site data destroyed a game outright. The recovery copy is the only
     * remaining copy here, so it wins over `empty` and over a remix seed (the seed is the state the
     * project was BORN in; the working copy is where it actually got to).
     */
    if (facts.hasWorkingCopy && workingCopyRanks(facts).ranks) {
      return { source: 'working' };
    }

    return facts.hasServerSeed ? { source: 'seed' } : { source: 'empty' };
  }

  /*
   * Linked, but we could not reach the provider (`remoteHead === undefined`).
   *
   * Mount local and say nothing about the repo. This is NOT the same as deciding the browser wins —
   * we simply have no second opinion, so we show what we have rather than refusing to open the
   * project. `unsavedWork` still reports honestly, so the UI can keep saying "not saved yet". Falling
   * through to a repo comparison here would compare against `undefined` and read as "remote is empty".
   */
  if (facts.remoteHead === undefined) {
    if (hasLocal) {
      return { source: 'local', unsavedWork };
    }

    /*
     * Offline with nothing local: the recovery copy is all we can reach, and it beats a blank editor —
     * unless its branch STAMP disagrees with the project's, which is the one state this whole check
     * exists for (fresh browser + linked project + unreachable remote). Restoring there hands the user
     * another branch's game with nothing saying so.
     */
    return facts.hasWorkingCopy && workingCopyRanks(facts).ranks ? { source: 'working' } : { source: 'empty' };
  }

  // Linked to a branch with no commits yet — a save that created the repo and failed to push.
  if (facts.remoteHead === null) {
    if (hasLocal) {
      return { source: 'local', unsavedWork: true };
    }

    /* The repo genuinely holds nothing, so it cannot be the source — a stamp-matching recovery copy can. */
    return facts.hasWorkingCopy && workingCopyRanks(facts).ranks ? { source: 'working' } : { source: 'empty' };
  }

  /*
   * Nothing here: another device saved this project. The repo is the only copy we can TRUST.
   *
   * ⚠️ The working copy is deliberately NOT preferred over the repo, even though it may hold work that
   * was never pushed. Deciding between them needs to know which is newer, and there is no ordering
   * that spans them: the repo is ordered by commit sha, the working copy by a per-BROWSER `seq`, and
   * this browser (having no local copy) has no `syncedSeq` to anchor either. Guessing would silently
   * mount a stale project over newer commits — §4.13's cardinal sin, and the platform never merges.
   *
   * A linked project also already has durable storage, which is the whole point of linking; §4.5.4c's
   * job is the UNLINKED project that has nowhere else to live. Extending this branch requires a
   * cross-device ordering we do not have, not a preference we have not chosen.
   */
  if (!hasLocal) {
    return { source: 'repo', reason: 'no-local-copy' };
  }

  const remoteMoved = facts.remoteHead !== facts.lastSyncedCommitSha;

  if (remoteMoved && unsavedWork) {
    /*
     * Both moved. Someone committed from their editor AND this browser has work that was never
     * pushed. There is no safe automatic answer — §4.13's two-button choice exists for exactly this,
     * and the platform never merges.
     */
    return { source: 'diverged', remoteHead: facts.remoteHead };
  }

  if (remoteMoved) {
    // The repo moved and we have nothing unsaved — a clean fast-forward. Take the repo's version.
    return { source: 'repo', reason: 'remote-ahead' };
  }

  /*
   * The repo is exactly where we left it. Mount local, which is either identical to the repo or ahead
   * of it by unsaved work — and in the second case the user is told (§4.5.4b's nudges).
   */
  return { source: 'local', unsavedWork };
}

/**
 * Does the LIVE sandbox filesystem outrank every client-held copy of this project?
 *
 * 🔴 Both wrong answers silently overwrite a user's project, which is why this is a pure function
 * rather than an expression inside the mount — the same reason `selectMountSource`, `restore-plan`
 * and `auto-repair` are pure. Answer `true` when it should be `false` and a stale or foreign disk
 * becomes the project's truth; answer `false` when it should be `true` and a client copy serialized
 * mid-watcher-lag is restored over a healthy sandbox (MEASURED live: the starter's `Home.css` under a
 * generation's `Home.tsx`, reverting a landing page two hours after it was built).
 *
 * Three conditions, each load-bearing:
 *
 *   - **the boot restored a filesystem.** On WebContainer this is always false — the FS is empty every
 *     page load, so the restore IS the project. On a server provider that resumed warm, the disk is
 *     exactly as the last session left it and is NEWER than anything this browser or the server holds.
 *   - **the sandbox does not claim to belong to someone else.** `mismatch` means a sentinel is present
 *     and names ANOTHER project (`readIdentityVerdict`) — a mis-pointed `sandbox_id`, and the only
 *     thing standing between that and one project's files becoming another's truth. `unknown` is NOT a
 *     mismatch: a sandbox predating the sentinel makes no claim, and treating silence as an accusation
 *     would send every warm VM down the restore path this gate exists to avoid.
 *   - **the mount source is one that would OVERWRITE the sandbox.** `repo` is an explicit user-facing
 *     sync decision, and `empty`/seed only run when there is nothing to protect.
 */
export function decideLiveSandboxIsTruth(facts: {
  bootRestoredFilesystem: boolean;
  identity: 'match' | 'mismatch' | 'unknown';
  source: MountSource['source'];
}): boolean {
  if (!facts.bootRestoredFilesystem || facts.identity === 'mismatch') {
    return false;
  }

  return facts.source === 'local' || facts.source === 'diverged' || facts.source === 'working';
}
