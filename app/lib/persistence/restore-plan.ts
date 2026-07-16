/**
 * What a restore must DELETE (SPEC §4.12, §4.13, §4.5.4b).
 *
 * ## The bug this exists to fix
 *
 * `restoreFiles` writes every file in the incoming map and deletes nothing. It is an OVERLAY, and it
 * has always been one — which was survivable while it only ever ran on a freshly-mounted container.
 * Under repo-primary persistence it runs on a live project, and an overlay is not a restore:
 *
 *   - **Undo (§4.12)** — restore to a checkpoint from before `Boss.ts` existed, and `Boss.ts` is still
 *     there. The undo did not undo. This is the safety net the whole product sells to non-developers.
 *   - **"Use the version from my repository" (§4.13)** — the user picks one of two versions and gets a
 *     THIRD: the repo's files, plus every file only their browser had. Neither version, no warning.
 *   - **Open on a new device** — a file you deleted last week comes back from the template mount.
 *
 * Every one of those is silent. None of them throws.
 *
 * ## Why it is a pure function, and why it is the most dangerous one here
 *
 * This decides which of the user's files to DELETE. Two ways to get it catastrophically wrong, and
 * both are one-liners:
 *
 * 1. **Path shape.** The store holds `/home/project/src/main.ts`. A repo's tree returns
 *    `src/main.ts`. Compare them raw and NOTHING matches, so every file in the project is "missing
 *    from the incoming map" and the restore wipes the project. Both sides normalise through
 *    `toRepoRelativePath` — the same function the push uses, not a second copy of it.
 * 2. **Files the incoming map was never authoritative about.** A map fetched from a repo has no
 *    `.env`, because `isSecretPath` stopped it being pushed. Treat that map as the whole truth and the
 *    restore deletes the user's API keys — the one file in the project that cannot be recovered from
 *    anywhere. Same rule, both directions.
 *
 * So the caller says what the map covers, and it is not a default: `protect` is required at every call
 * site, because "what is this map authoritative about?" has a different answer for a checkpoint (all
 * of it) and a repo (everything but the secrets), and a default would silently pick one.
 */
import { toRepoRelativePath } from '~/lib/git/paths';

export interface RestorePlanInput {
  /** Paths currently live in the store (any shape — normalised here). */
  current: string[];

  /** Paths in the map being restored (any shape — normalised here). */
  incoming: string[];

  /**
   * Paths the incoming map is NOT authoritative about — their absence means "not represented", not
   * "deleted". Required: see the header.
   *
   * Receives a repo-relative path.
   */
  protect: (path: string) => boolean;
}

export interface RestorePlan {
  /** Paths to delete, in the ORIGINAL shape the caller passed in `current` — ready for `deleteFile`. */
  toDelete: string[];
}

/**
 * Decide what a restore deletes.
 *
 * `toDelete` = live files the incoming map does not contain, minus the protected ones.
 */
export function planRestore(input: RestorePlanInput): RestorePlan {
  /*
   * 🔴 A refusal, not an optimisation. An empty incoming map means every live file is "missing", so
   * the plan would be "delete the entire project" — and the situations that produce an empty map are
   * exactly the ones where that is most obviously wrong: a failed fetch that returned `{}`, a caller
   * passing the wrong variable, a repo whose branch has no commits. A restore is never a wipe. If some
   * future flow genuinely needs to empty a project, it can say so explicitly and not through this.
   */
  if (input.incoming.length === 0) {
    return { toDelete: [] };
  }

  const incoming = new Set(input.incoming.map(toRepoRelativePath));
  const toDelete: string[] = [];

  for (const rawPath of input.current) {
    const path = toRepoRelativePath(rawPath);

    if (!path || incoming.has(path) || input.protect(path)) {
      continue;
    }

    // The ORIGINAL shape: the caller has to hand this back to a filesystem that expects its own paths.
    toDelete.push(rawPath);
  }

  return { toDelete };
}

/**
 * `protect` for a map that came from a git repo (a pull, a divergence resolve, a fresh mount).
 *
 * The repo never had the `.env` family — `isSecretPath` kept it out of every push — so its absence
 * from the tree says nothing about whether the user still wants it. Deleting it on pull would destroy
 * the user's keys with no way back.
 */
export { isSecretPath as protectForRepoRestore } from '~/lib/git/paths';

/**
 * `protect` for a map that came from a LOCAL checkpoint.
 *
 * A checkpoint is a serialization of the whole store, so it IS the whole truth: if `.env` is not in it,
 * the project genuinely did not have one at that moment, and restoring to that moment means not having
 * one. Protecting anything here would make undo lie in the other direction.
 */
export const protectNothing = (): boolean => false;
