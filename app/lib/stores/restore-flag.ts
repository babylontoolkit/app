/**
 * Is a restore writing over the project right now? (SPEC §4.5.4c, §4.12)
 *
 * A restore's whole job is to write and delete files, and a top-up's whole job is to notice files being
 * written and deleted. Left to themselves they compose into a bug: the restore is photographed as if the
 * user had made those changes, so every mount appends a duplicate checkpoint and a §4.12 undo is
 * immediately followed by a checkpoint of the state it just undid.
 *
 * ONE flag, one writer (`FilesStore.restoreFiles` and the mount sequence), one reader (`planTopUp`'s
 * facts). Deliberately not a parameter threaded through call sites: a top-up is scheduled on a 4-second
 * debounce, so the thing that needs suppressing is often something that was scheduled BEFORE the restore
 * started and fires in the middle of it — there is no call site to thread it through.
 *
 * A plain module-level counter rather than a nanostore: nothing renders from it, and a counter (not a
 * boolean) is what makes nesting safe — a mount that restores twice must not have its first restore's
 * completion declare the second one over.
 */

let depth = 0;

export function isRestoreInFlight(): boolean {
  return depth > 0;
}

/**
 * Run `work` with restores marked in flight.
 *
 * `try/finally`, always: a restore that THROWS still leaves the tree half-written, which is the state
 * that most needs the suppression — and a flag stuck on would silently disable every top-up for the
 * rest of the page's life, turning a loud failure into the exact silent data loss this all exists to
 * prevent.
 */
export async function withRestoreInFlight<T>(work: () => Promise<T>): Promise<T> {
  depth++;

  try {
    return await work();
  } finally {
    depth--;
  }
}

/** Test-only reset, so one spec's leaked depth cannot silence the next spec's top-ups. */
export function resetRestoreInFlight(): void {
  depth = 0;
}
