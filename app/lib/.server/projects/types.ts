/**
 * Projects (SPEC §4.5.5, §4.5.4b).
 *
 * These are the rows the two-wall rule protects: a project belongs to exactly one user, and every
 * route that touches one proves ownership before doing anything else (§4.5.3).
 *
 * A project row is metadata and nothing else — the platform stores no project FILES. The code lives in
 * the user's own repo (§4.5.4b); see the note above `ProjectStore` for why there is no snapshot store
 * here any more.
 */
import type { GitProviderId } from '~/lib/.server/git/provider';

export interface Project {
  id: string;
  userId: string;
  name: string;

  /** The `game_registry` entry this project was created from (§4.4). */
  templateId: string;

  /** Set when published (§4.8). Unique across the platform; the public `/play/[shareId]` key. */
  shareId?: string;

  /** Public-facing title/blurb for the play page and gallery card. Sanitised on the way in (§5). */
  shareTitle?: string;
  shareDescription?: string;

  /** ISO timestamp of the most recent publish. `undefined` after an unpublish — the id is kept, the link is dead. */
  sharedAt?: string;

  /** A network-capable game is launched `?solo=true` when shared, or it hangs waiting for a peer (§4.8). */
  soloLaunch?: boolean;

  /**
   * Gallery listing state (§4.8, §5). `none` = shared but unlisted; `pending` = user asked to be
   * featured; `approved` = an admin listed it; `rejected` = an admin declined. **Nothing is publicly
   * listed without an admin approving it** — the user can only ever move it to `pending`.
   */
  galleryStatus?: 'none' | 'pending' | 'approved' | 'rejected';

  /** Provenance for the remix growth loop (§4.8): the project this one was cloned from, if any. */
  remixedFrom?: string;

  /**
   * When a remix seed was deposited for this project (§4.8) — `undefined` for the overwhelming
   * majority of projects, which never have one.
   *
   * 🔴 This replaces `currentSnapshotId`, and the rename is the point. That field's name promised a
   * version history the platform stopped keeping in §4.5.4b; what it actually held, on the small number
   * of projects that had anything at all, was a pointer to a remix seed. A field whose name describes a
   * deleted system is how a reader concludes the system still exists.
   *
   * It is a HINT, not an address: the seed's key is derived from the project id (`seed-store.ts`), so
   * nothing here can point at the wrong object. If this says a seed exists and storage disagrees, the
   * read returns null and the caller falls back exactly as it would for a project with no seed.
   */
  remixSeedAt?: string;

  /**
   * The user's repo (§4.5.4b) — under repo-primary persistence this is not a sync convenience, it is
   * the ADDRESS OF THE ONLY PERMANENT COPY of the project's code. Exactly one repo + branch.
   *
   * All four move together or not at all: `provider` names the adapter, `linkedRepo`/`linkedBranch`
   * name the target. The database refuses a half-set (`projects_link_complete_check`, migration 0006),
   * because a project holding a repo with no provider reads as LINKED in the UI while no save path can
   * resolve an adapter — the user is told their only copy is safe while nothing is written anywhere.
   *
   * All absent = UNLINKED = the project lives only in this browser.
   */
  provider?: GitProviderId;
  linkedRepo?: string;
  linkedBranch?: string;
  lastSyncedCommitSha?: string;
  githubInstallationRef?: string;

  /**
   * Push to the linked repo on every checkpoint (§4.5.4b). ON by default and never null: a user who
   * linked a repo asked for their work to live there, and a save preference that quietly defaults to
   * off is a user who believes they are saved and is not. Inert while UNLINKED.
   */
  autoPush?: boolean;

  /**
   * Game Backend (§4.15) — a pointer to the user's OWN Supabase project ref. Never a credential: the
   * anon key/URL are public-by-design and derived client-side, and the management PAT is never stored
   * server-side. This just lets the agent know a backend is connected so it scaffolds RLS-first.
   */
  gameBackendRef?: string;

  createdAt: string;
  updatedAt: string;
}

export type NewProject = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 🔴 There is no `SnapshotStore` here, and adding one back is the regression (§4.5.4b).
 *
 * The platform used to keep a per-project version history: a `Snapshot` row per generation, its payload
 * in object storage, addressed by `projects.current_snapshot_id`. Repo-primary persistence deleted the
 * premise — the user's code lives in THEIR repo and nowhere else, and checkpoints live in their browser
 * (`app/lib/persistence/local-snapshots.ts`). A server-side copy of every project is not a backup; it
 * is the old model under a new name.
 *
 * The store outlived the behaviour by one release — migration 0006 removed the writes but left the
 * table, the interface, and both backends standing to serve a single caller: the remix seed. That seed
 * is now stored as what it is, one object at a derived key (`share/seed-store.ts`), and none of this
 * needs to exist.
 *
 * `no-server-storage.spec.ts` pins the invariant, including a source scan for anyone re-adding a client
 * call to a server snapshot route.
 */
export interface ProjectStore {
  create(project: NewProject): Promise<Project>;
  get(id: string): Promise<Project | null>;
  listByUser(userId: string): Promise<Project[]>;
  update(id: string, patch: Partial<Omit<Project, 'id' | 'userId' | 'createdAt'>>): Promise<Project>;
  delete(id: string): Promise<void>;

  /** Public read for `/play/[shareId]` and the gallery — the only unauthenticated project lookup. */
  getByShareId(shareId: string): Promise<Project | null>;

  /** Admin-approved gallery entries, newest published first (§4.8). The only unauthenticated LIST. */
  listGallery(limit: number): Promise<Project[]>;

  /** Projects awaiting gallery curation (§4.10). Admin-only — nothing is public until approved (§5). */
  listGallerySubmissions(limit: number): Promise<Project[]>;
}
