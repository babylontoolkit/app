/**
 * Projects and snapshots (SPEC §4.5.5).
 *
 * These are the rows the two-wall rule protects: a project belongs to exactly one user, and every
 * route that touches one proves ownership before doing anything else (§4.5.3).
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';

export interface Project {
  id: string;
  userId: string;
  name: string;

  /** The `game_registry` entry this project was created from (§4.4). */
  templateId: string;

  /** Set when published (§4.8). Unique across the platform; the public `/play/[shareId]` key. */
  shareId?: string;

  /** The snapshot the builder remounts on resume. */
  currentSnapshotId?: string;

  /** GitHub Sync (§4.13) — exactly one linked repo + branch per project. */
  linkedRepo?: string;
  linkedBranch?: string;
  lastSyncedCommitSha?: string;
  githubInstallationRef?: string;

  createdAt: string;
  updatedAt: string;
}

export type NewProject = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;

/** One file in a snapshot's manifest — enough to render a diff without fetching the payload. */
export interface ManifestEntry {
  path: string;
  size: number;
  isBinary: boolean;
}

export interface Snapshot {
  id: string;
  projectId: string;

  /** Object-store key of the payload. The bytes never live in the database. */
  storagePath: string;

  fileManifest: ManifestEntry[];

  /**
   * The assistant message this snapshot was taken AFTER — the anchor for "restore to before this
   * change" (§4.12). Null for the creation snapshot and for manual saves.
   */
  messageId?: string;

  /** Human label for the version history ("before kart physics", "restored to checkpoint 3"). */
  label?: string;

  createdAt: string;
}

/**
 * A snapshot's payload.
 *
 * `SerializedFileMap` is the byte-faithful wire format the binary work already established
 * (spec/binary-files.md): text inline, binary base64. Reusing it — rather than inventing a tar here —
 * is what makes the snapshot→restore round-trip preserve bytes exactly, because it is the SAME codec
 * the WebContainer writes and reads through.
 */
export type SnapshotPayload = SerializedFileMap;

export interface ProjectStore {
  create(project: NewProject): Promise<Project>;
  get(id: string): Promise<Project | null>;
  listByUser(userId: string): Promise<Project[]>;
  update(id: string, patch: Partial<Omit<Project, 'id' | 'userId' | 'createdAt'>>): Promise<Project>;
  delete(id: string): Promise<void>;

  /** Public read for `/play/[shareId]` and the gallery — the only unauthenticated project lookup. */
  getByShareId(shareId: string): Promise<Project | null>;
}

export interface SnapshotStore {
  /** Write the payload to object storage and record the row. Returns the recorded snapshot. */
  create(input: { projectId: string; files: SnapshotPayload; messageId?: string; label?: string }): Promise<Snapshot>;

  get(id: string): Promise<Snapshot | null>;

  /** The payload bytes, decoded back to a `SerializedFileMap`. Null when the object is gone. */
  read(id: string): Promise<SnapshotPayload | null>;

  listByProject(projectId: string): Promise<Snapshot[]>;

  /** Used by account deletion and project delete — removes rows AND objects. */
  deleteByProject(projectId: string): Promise<void>;
}
