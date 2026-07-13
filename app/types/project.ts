/**
 * The project/snapshot types the CLIENT is allowed to know about (SPEC §4.5.5).
 *
 * The server's own types live in `app/lib/.server/projects/types.ts`, and Remix will not let client
 * code import from `.server/**` — correctly, since that module also reaches the admin Supabase client.
 * So this is the wire contract, written down once, on the public side of the seam.
 *
 * Keep it a SUBSET of what the routes actually return. It deliberately omits `userId` (the server
 * derives it from the session and never trusts it from the client) and `storagePath` (an object-store
 * key; the browser has no business knowing where our bytes live).
 */

/** A project as `GET /api/projects` and `GET /api/projects/:id` return it. */
export interface Project {
  id: string;
  name: string;

  /** The `game_registry` entry this project was seeded from (§4.4). */
  templateId: string;

  /** Set once published (§4.8) — the public `/play/:shareId` key. */
  shareId?: string;

  /** The checkpoint the builder remounts on resume. */
  currentSnapshotId?: string;

  /** GitHub Sync (§4.13). */
  linkedRepo?: string;
  linkedBranch?: string;

  createdAt: string;
  updatedAt: string;
}

/**
 * A checkpoint as the LIST route returns it — metadata only.
 *
 * The file payload is deliberately not here: a project's snapshot can be many megabytes, and the
 * version-history UI needs to show twenty of them without downloading twenty copies of the game.
 * Bytes come from `readSnapshot()`, one at a time, only when actually restoring.
 */
export interface SnapshotSummary {
  id: string;
  label?: string;

  /** The message this checkpoint was taken after — what anchors "restore to before this change". */
  messageId?: string;

  createdAt: string;
  fileCount: number;
  totalBytes?: number;
}

/** What `GET /api/projects/:id/snapshots` returns. */
export interface SnapshotList {
  currentSnapshotId: string | null;
  snapshots: SnapshotSummary[];
}
