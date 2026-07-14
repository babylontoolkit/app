/**
 * Remix / Duplicate (SPEC §4.8).
 *
 * The primary growth loop: a visitor plays a shared game, hits "Remix", and gets their own editable
 * copy. Self-remix ("Duplicate project") is the SAME path with the source owned by the caller — one
 * function, two entry points, because the only thing that differs is whether a share was involved.
 *
 * What travels and what does not is the whole contract, and it is security-shaped:
 *
 * - **The files travel** — a byte-faithful copy of the source's current snapshot becomes the new
 *   project's creation snapshot. (Copying only the snapshot, never a live handle, is why a remix of a
 *   deleted-tomorrow project keeps working.)
 * - **Ownership does NOT travel.** The new project belongs to the caller, full stop. `remixedFrom`
 *   records provenance for analytics; it grants nothing.
 * - **The GitHub link does NOT travel** (§4.13). It points at someone else's repo, to which the new
 *   owner has no write access — carrying it forward would produce a project that fails every push.
 * - **The share id / gallery state does NOT travel.** A remix is private and unpublished until its new
 *   owner decides otherwise. Inheriting a share id would mean two projects claim one public URL.
 *
 * `deriveRemix` is the pure part — given a source project and the new owner, what the new project row
 * should be — so the "what travels" rule is a table of assertions rather than a claim buried in an
 * async clone. The actual snapshot copy is orchestrated by the route.
 */
import type { NewProject, Project } from '~/lib/.server/projects/types';

export interface RemixContext {
  /** Who is getting the copy. For self-remix this equals `source.userId`; the code does not care. */
  newOwnerId: string;

  /** Optional override; defaults to a "(remix)" / "(copy)" suffix on the source name. */
  name?: string;

  /** True when the caller owns the source — changes only the default name suffix, never permissions. */
  isSelfRemix?: boolean;
}

/** Fields a remix copies from its source. Everything NOT here is deliberately dropped — see the header. */
export function deriveRemix(source: Project, ctx: RemixContext): NewProject {
  const suffix = ctx.isSelfRemix ? 'copy' : 'remix';

  return {
    userId: ctx.newOwnerId,
    name: ctx.name?.trim() || `${source.name} (${suffix})`,
    templateId: source.templateId,

    // Provenance only. This is the one thing that crosses from the source, and it grants nothing.
    remixedFrom: source.id,

    /*
     * Everything below is EXPLICITLY reset. Listing them is the point: a future field added to
     * Project will not silently leak into remixes, because a remix names exactly what it carries.
     */
    shareId: undefined,
    shareTitle: undefined,
    shareDescription: undefined,
    sharedAt: undefined,
    soloLaunch: undefined,
    galleryStatus: 'none',
    currentSnapshotId: undefined,
    linkedRepo: undefined,
    linkedBranch: undefined,
    lastSyncedCommitSha: undefined,
    githubInstallationRef: undefined,
    gameBackendRef: undefined,
  };
}
