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
    return hasLocal ? { source: 'local', unsavedWork } : { source: 'empty' };
  }

  // Linked to a branch with no commits yet — a save that created the repo and failed to push.
  if (facts.remoteHead === null) {
    return hasLocal ? { source: 'local', unsavedWork: true } : { source: 'empty' };
  }

  // Nothing here: another device saved this project. The repo is the only copy we can see.
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
