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

  /**
   * When a remix seed was deposited for this project (§4.8) — absent on almost every project.
   *
   * Read as a boolean: it is what tells the client whether `/api/projects/:id/seed` is worth asking
   * for. It replaces `currentSnapshotId`, whose name promised a server-side version history that no
   * longer exists (§4.5.4b).
   */
  remixSeedAt?: string;

  /**
   * Where this project is permanently saved (§4.5.4b). All absent = UNLINKED = it exists only in this
   * browser, which is what the LINKED/UNLINKED indicator reads. The three always travel together.
   */
  provider?: 'github' | 'gitlab';
  linkedRepo?: string;
  linkedBranch?: string;

  /** Push to the linked repo on every checkpoint. On by default; inert while unlinked. */
  autoPush?: boolean;

  createdAt: string;
  updatedAt: string;
}

/*
 * 🔴 `SnapshotSummary` and `SnapshotList` are gone (§4.5.4b).
 *
 * They described a SERVER-side version history — the shape of `GET /api/projects/:id/snapshots`, a
 * route that no longer exists. The checkpoint history is local now and has its own types, next to the
 * store that owns them: `LocalSnapshot` / `LocalSnapshotSummary` in `~/lib/persistence/local-snapshots`.
 */
