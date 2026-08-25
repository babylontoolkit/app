/**
 * "The file tree was replaced under you." (§4.12, §4.13, §4.13a.)
 *
 * ## The defect this ends
 *
 * Reported 2026-08-22: *"after a discard all changes… the files in Code List still shows changes"* — a
 * `+11 −8` badge sitting on a file whose changes had just been thrown away.
 *
 * `Workbench.client.tsx` holds `fileHistory` in a component-local `useState`, written only by
 * `DiffView`'s effect and **cleared by nothing at all**. So it survives every tree replacement, still
 * holding an `originalContent` and a "latest version" that no longer exist on disk. Three surfaces read
 * it and all three lie together: the file-tree badge, the "modified files" dropdown, and the diff view
 * itself — which renders the discarded content as the *before* side of a comparison with nothing on the
 * other end.
 *
 * It is the shape this codebase keeps rediscovering (`identityForMount`, `chat-reset.ts`): **state that
 * survives because nothing resets it.** The discard was correct — `restoreFiles`, then
 * `resetAllFileModifications`, then `clearDeletedPaths`, all of which did their jobs. This is a fourth
 * piece of "what changed" that lived somewhere none of them could reach.
 *
 * ## Why a counter, and why here
 *
 * A monotonic revision rather than a boolean or an event: a reader needs to know *that it changed*
 * since it last looked, and two replacements in a row must read as two. A boolean has to be cleared by
 * its reader, which makes the reader a writer and races the next restore.
 *
 * 🔴 It is bumped inside `FilesStore.restoreFiles` — **the one function all six restore doors pass
 * through** (mount, working-copy recovery, checkpoint undo, repo restore, git pull, remix seed), for
 * exactly the reason stated on `restore-flag.ts` beside it: a signal raised per-door is a signal the
 * seventh door forgets. The reported bug was discard; fixing it at the door would have left undo, a
 * branch switch and a repo pull each showing the same phantom diff.
 *
 * A nanostore rather than the plain module counter `restore-flag.ts` uses, because a COMPONENT renders
 * from this one and has to re-render when it moves.
 */
import { atom } from 'nanostores';

/**
 * How many times the tree has been replaced wholesale this page load.
 *
 * The number itself means nothing — only that it differs from the last value a reader saw. Never
 * persisted: a reader that has not rendered yet has nothing stale to discard.
 */
export const treeRevision = atom(0);

/** Record a wholesale tree replacement. Called by `FilesStore.restoreFiles`, and nowhere else. */
export function bumpTreeRevision(): void {
  treeRevision.set(treeRevision.get() + 1);
}

/** Test-only reset, so one spec's replacements cannot make the next spec's reader fire on mount. */
export function resetTreeRevision(): void {
  treeRevision.set(0);
}
