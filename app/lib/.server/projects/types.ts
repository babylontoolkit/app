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
import type { CreationPlan } from '~/lib/agent/creation-plan';
import type { GitProviderId } from '~/lib/.server/git/provider';

/**
 * What an unbuilt project still owes its owner: the words they typed at creation, carried until their
 * first build turn. Capped on the way in (`api.projects.$projectId.ts`) — it arrives in a browser body
 * and it reaches the model, so an unbounded one is an unbounded per-turn bill (§4.2.8).
 *
 * 🔴 The machine-written `brief` field is RETIRED (owner, 2026-08-08): the baked system prompt and the
 * file context carry what it used to, and the first build turn is an ordinary turn. Old rows may still
 * hold a `brief` key; readers ignore it. The row's PRESENCE is what means "created, never built".
 */
export interface CreationHandoff {
  /** The user's own words. Absent on the card path — there were none, and inventing some is worse. */
  userPrompt?: string;

  /**
   * The phase plan (`~/lib/agent/creation-plan`), present once the build has started.
   *
   * 🔴 **This is what moved the END of the handoff.** Migration 0016's rule was "NULL once the first
   * build turn has been SENT"; it is now "NULL once the LAST PHASE has completed". The brief is still
   * consumed on send — re-appending it would double-charge an uncached history forever — but the plan
   * has to outlive that send, because it is the only record of which phases are still owed, and
   * without it a tab that dies mid-build strands a half-written project with nothing able to resume.
   *
   * Absent on a project created before phases, and on one whose build never started. Both mean the
   * same thing to every reader: no plan, so behave exactly as the single-turn creation did.
   */
  plan?: CreationPlan;
}

export interface Project {
  id: string;
  userId: string;
  name: string;

  /** The `game_registry` entry this project was created from (§4.4). */
  templateId: string;

  /** Set when published (§4.8). Unique across the platform; the public key a share resolves by. */
  shareId?: string;

  /**
   * The readable half of the public host — `arcade-racer` in `arcade-racer-k7m2p9qx4nrt.codewrx.app`.
   *
   * 🔴 **DECORATION, AND DELIBERATELY NOT UNIQUE.** Identity is `shareId` alone, which is why there is
   * no unique index on this column and never should be: fifty projects may be called "Arcade Racer"
   * and all fifty get a working URL. It also means a stale slug still resolves, so re-deriving it on
   * every publish cannot break a link somebody already pasted.
   */
  shareSlug?: string;

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

  /**
   * Unity Project Licenser (§4.18) — the linked Unity project's `productGUID` (32 hex chars). A plain
   * pointer that follows `gameBackendRef`; NEVER a credential. It is the value the generated
   * `license.json` is locked to (the license `key` is a hash over `plan-<guid>`), so a license only
   * validates in the Unity project it was linked for. `undefined` = no Unity project linked.
   */
  linkedUnityProjectId?: string;

  /**
   * The provider sandbox VM holding this project's workspace (`spec/sandbox-codesandbox.md`).
   *
   * A plain pointer following `gameBackendRef`/`linkedUnityProjectId` — NEVER a credential, and not
   * part of the client wire contract (`app/types/project.ts`): the browser supplies a PROJECT id it
   * must own, and the server mints every scoped session from the platform API key.
   *
   * ⚠️ Absent from the wire TYPE is not absent from the wire — a TS type strips nothing at runtime,
   * and both project routes serialize the whole row. DECIDED (2026-07-27): it is stripped in one
   * place, `projects/wire.ts`'s `toWireProject`, which both routes call. Read that file for why the
   * pointer is withheld even though it is not a credential; do not read the omission from
   * `app/types/project.ts` as the guarantee — it never was one.
   *
   * It replaces the per-user registry (`sandboxes/{userId}.json`), which gave one VM to a user rather
   * than to a project — so opening project B warm-booted project A's filesystem with nothing to check
   * identity against. `undefined` = no VM has been created for this project yet.
   */
  sandboxId?: string;

  /**
   * The creation → build handoff for a project that has never been built (§4.4a, migration 0016).
   *
   * 🔴 **A FACT ABOUT THE PROJECT, NOT ABOUT ONE BROWSER.** It shipped in `localStorage`, which made the
   * handoff card and — far worse — the hidden creation brief a property of the device that happened to
   * create the project. Open an unbuilt project on a second machine and the first build turn went out
   * with NO brief: no play contract, no scaffolded class name, no list of the images actually on disk.
   * The build still ran and was simply worse, with nothing reporting why (§4.2.8's silent failure mode).
   *
   * 🔴 **NULL IS THE END STATE, and it is set when the first build turn is SENT** — never when it
   * succeeds, because a failed build is one the user retries and the retry must still carry the brief.
   */
  creationHandoff?: CreationHandoff;

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
