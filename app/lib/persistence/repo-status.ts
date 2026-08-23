/**
 * Where the project on screen currently lives — provider, repo, BRANCH (§4.5.4b, §4.13a).
 *
 * ## Why this is its own module
 *
 * It began as one line in `useChatHistory.ts`, which is where everything that mounts a project lives.
 * That was fine while only components read it, and it stopped being fine the moment a WRITER needed
 * it: `projects.ts` cannot import `useChatHistory`, because `useChatHistory` imports `projects.ts`.
 *
 * 🔴 **That import cycle was not a build error, it was a silent hole.** T17 stamps the working copy
 * with the branch its files came from, so a recovery on a fresh browser cannot restore another
 * branch's tree over a project that has moved. `writeWorkingCopyFromStore` reads the stamp from this
 * store rather than taking it as a parameter, precisely so no caller can forget it — but
 * `saveWorkingCopy` in `projects.ts` writes the SAME object by a different route, could not reach the
 * store, and therefore wrote every per-generation checkpoint with no stamp at all. Two consequences,
 * both invisible: the guard was inert on the most frequent write in the product, and it ACTIVELY
 * UN-STAMPED — `applyBranchTree` would stamp `feature/hud` and the next generation's checkpoint would
 * overwrite the copy with nothing, giving the protection a lifetime of one turn.
 *
 * So the store moved to where both writers can see it. `useChatHistory` re-exports it, so every
 * existing reader is untouched and there is still exactly ONE atom — the point is that a second
 * writer can no longer be structurally prevented from consulting it.
 *
 * ⚠️ Keep this module dependency-free (a type import and `nanostores`, nothing else). The whole reason
 * it exists is that it must be importable from both ends of a cycle.
 */
import { atom } from 'nanostores';
import type { RepoStatus } from './projects';

/** The project's repo link, as of the last time we looked. `undefined` = not loaded yet. */
export const repoStatus = atom<RepoStatus | undefined>(undefined);

/**
 * The branch to stamp on a working copy right now, or `undefined` when we cannot say.
 *
 * A named read rather than `repoStatus.get()?.branch` at three call sites, because "which branch do
 * these bytes belong to?" is one question with one answer — and because `undefined` here is
 * load-bearing in a way a raw optional-chain does not advertise: it means UNKNOWN, and
 * `workingCopyRanks` treats unknown as "behave exactly as before the stamp existed", never as a
 * match. A writer that guessed would be worse than one that says nothing.
 */
export function branchForWorkingCopy(): string | undefined {
  return repoStatus.get()?.branch;
}
