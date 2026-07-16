/**
 * Prompt-version store (SPEC §4.3, spec/doc-sync.md).
 *
 * STORAGE SEAM. The spec's target backend is a Supabase `prompt_versions` table (§4.5.5), which
 * does not exist yet (Stage 2). Everything the spec requires of the store — immutable versions,
 * exactly-one-active, atomic activation, rollback to any prior version, content hashing — is
 * implemented here against the filesystem, behind an interface. When Supabase lands, add a
 * `SupabasePromptStore` implementing `PromptStore` and switch `getPromptStore()`. No caller changes.
 *
 * Large bodies (the 490KB `babylon.toolkit.d.ts`, the on-demand system docs) are content-addressed
 * so that N versions of a prompt do not store N copies of an unchanged declaration file.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PromptVersionMeta {
  id: string;

  /**
   * Hash of the BASE prompt only — the cached prefix we pay cached-input rates on (§4.2.8).
   * Deliberately narrow: it is the identity of what the model sees on every generation.
   *
   * NOT the right key for "did this build change" — see `buildHash`.
   */
  contentHash: string;

  /**
   * Hash of the WHOLE build: base prompt + every on-demand block + every declaration file.
   *
   * Derived from the stored blob hashes, never persisted — a stored copy could drift from the blobs
   * it claims to describe, and there is nothing this field knows that the record does not.
   */
  buildHash: string;

  /**
   * `main` HEAD of the agent repo when this version was FIRST built — immutable provenance.
   *
   * Not "the current docs commit": docs move on without changing a single baked byte, and this
   * version was genuinely built from THIS commit. For "are we current?", read `lastSeenCommitSha`.
   */
  sourceCommitSha: string;

  /**
   * The most recent agent-repo commit confirmed to rebuild byte-identically to this version, and
   * when we confirmed it.
   *
   * Observation, NOT build identity — which is why it can be updated on an immutable version. A
   * refresh that finds nothing changed has still learned something real: this content is current as
   * of a newer commit. Without it, `sourceCommitSha` reads as stale against HEAD and there is no way
   * to tell "the docs moved and we never resynced" (a bug) from "the docs moved and nothing we bake
   * changed" (correct, and the common case).
   *
   * Falls back to build time for versions written before these fields existed.
   */
  lastSeenCommitSha: string;
  lastSeenAt: string;

  /** Hash of the skills index text baked into this prompt (§4.11). */
  skillsSetHash: string;
  createdAt: string;
  isActive: boolean;

  /** Byte size of the base prompt — the thing we pay cached-input rates on. */
  baseBytes: number;
  onDemandIds: string[];
  declarationIds: string[];
}

export interface PromptVersion extends PromptVersionMeta {
  /** The assembled base system prompt. Sent as the cached prefix on every generation. */
  content: string;
}

export interface NewPromptVersion {
  content: string;
  sourceCommitSha: string;
  skillsSetHash: string;
  onDemand: Record<string, string>;
  declarations: Record<string, string>;
}

export interface PromptStore {
  put(version: NewPromptVersion): Promise<PromptVersionMeta>;
  get(id: string): Promise<PromptVersion | null>;
  getActive(): Promise<PromptVersion | null>;
  list(): Promise<PromptVersionMeta[]>;
  activate(id: string): Promise<void>;

  /**
   * Record that `commitSha` was confirmed to rebuild byte-identically to this version.
   *
   * Touches ONLY the observation fields — never content, hashes, or `sourceCommitSha`. The build
   * stays immutable; all that changed is what we know about it.
   */
  recordSeen(id: string, commitSha: string): Promise<void>;

  /** On-demand block body (a system doc routed in by keyword). Null when absent from this version. */
  readOnDemand(versionId: string, blockId: string): Promise<string | null>;

  /** A synced declaration file (`babylon.toolkit.d.ts`, …) — editor IntelliSense + agent on demand. */
  readDeclaration(versionId: string, declId: string): Promise<string | null>;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Fingerprint every artefact a build produces, from the hashes of their bodies.
 *
 * Ids are sorted so the fingerprint depends on CONTENT, not on the order `Promise.all` happened to
 * populate the maps in — an unstable fingerprint would report a spurious change on every build.
 */
function fingerprintFromHashes(
  baseHash: string,
  onDemand: Record<string, string>,
  declarations: Record<string, string>,
): string {
  const canonical = (map: Record<string, string>) =>
    Object.keys(map)
      .sort()
      .map((id) => `${id}:${map[id]}`)
      .join(',');

  return sha256([baseHash, canonical(onDemand), canonical(declarations)].join('|'));
}

/**
 * The fingerprint of a candidate build — the ONLY correct key for a "has anything changed?" no-op.
 *
 * `contentHash` covers the base prompt alone, so keying the no-op on it silently discarded any
 * update confined to an on-demand block or a declaration file (see `buildSystemPrompt`).
 */
export function computeBuildHash(version: NewPromptVersion): string {
  const hashBodies = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).map(([id, body]) => [id, sha256(body)]));

  return fingerprintFromHashes(sha256(version.content), hashBodies(version.onDemand), hashBodies(version.declarations));
}

interface VersionRecord {
  id: string;
  contentHash: string;
  sourceCommitSha: string;

  /** Optional: absent on versions written before observation tracking existed. */
  lastSeenCommitSha?: string;
  lastSeenAt?: string;
  skillsSetHash: string;
  createdAt: string;
  baseBytes: number;

  /** Content-addressed refs: logical id → blob sha. */
  base: string;
  onDemand: Record<string, string>;
  declarations: Record<string, string>;
}

/** Root for all locally-persisted platform data. Overridable so tests never touch the real store. */
export function platformDataDir(): string {
  return process.env.PLATFORM_DATA_DIR || path.join(process.cwd(), '.data');
}

export class FsPromptStore implements PromptStore {
  private readonly _root: string;

  constructor(root?: string) {
    this._root = root ?? path.join(platformDataDir(), 'prompt');
  }

  private get _versionsDir() {
    return path.join(this._root, 'versions');
  }

  private get _blobsDir() {
    return path.join(this._root, 'blobs');
  }

  private get _activePath() {
    return path.join(this._root, 'active.json');
  }

  private async _writeBlob(content: string): Promise<string> {
    const hash = sha256(content);
    const file = path.join(this._blobsDir, hash);

    // Content-addressed: identical bytes are already there, and rewriting is pure waste.
    try {
      await fs.access(file);
      return hash;
    } catch {
      await fs.mkdir(this._blobsDir, { recursive: true });
      await this._atomicWrite(file, content);

      return hash;
    }
  }

  private async _readBlob(hash: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this._blobsDir, hash), 'utf8');
    } catch {
      return null;
    }
  }

  /** Write via temp + rename so a crash mid-write can never leave a half-written record readable. */
  private async _atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  }

  private async _readRecord(id: string): Promise<VersionRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this._versionsDir, `${id}.json`), 'utf8')) as VersionRecord;
    } catch {
      return null;
    }
  }

  private async _activeId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(this._activePath, 'utf8');
      return (JSON.parse(raw) as { versionId: string }).versionId;
    } catch {
      return null;
    }
  }

  private _toMeta(record: VersionRecord, activeId: string | null): PromptVersionMeta {
    return {
      id: record.id,
      contentHash: record.contentHash,

      /*
       * Derived from the record's own blob refs, which ARE the content hashes (blobs are
       * content-addressed). So this needs no stored field and no migration: versions written before
       * `buildHash` existed fingerprint correctly on read.
       */
      buildHash: fingerprintFromHashes(record.contentHash, record.onDemand, record.declarations),
      sourceCommitSha: record.sourceCommitSha,

      /*
       * A version never observed since it was built has been seen exactly once: at build time, from
       * the commit it was built from. That is also the honest reading of a legacy record.
       */
      lastSeenCommitSha: record.lastSeenCommitSha ?? record.sourceCommitSha,
      lastSeenAt: record.lastSeenAt ?? record.createdAt,
      skillsSetHash: record.skillsSetHash,
      createdAt: record.createdAt,
      isActive: record.id === activeId,
      baseBytes: record.baseBytes,
      onDemandIds: Object.keys(record.onDemand),
      declarationIds: Object.keys(record.declarations),
    };
  }

  async put(version: NewPromptVersion): Promise<PromptVersionMeta> {
    await fs.mkdir(this._versionsDir, { recursive: true });

    const contentHash = sha256(version.content);
    const createdAt = new Date().toISOString();

    const record: VersionRecord = {
      /*
       * Suffixed with the BUILD hash, not `contentHash`: the timestamp only resolves to the second,
       * so two versions sharing a base prompt (an on-demand-only change) would otherwise collide on
       * id and silently overwrite each other's record.
       */
      id: `pv_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${computeBuildHash(version).slice(0, 8)}`,
      contentHash,
      sourceCommitSha: version.sourceCommitSha,
      skillsSetHash: version.skillsSetHash,
      createdAt,
      baseBytes: Buffer.byteLength(version.content, 'utf8'),
      base: await this._writeBlob(version.content),
      onDemand: {},
      declarations: {},
    };

    for (const [id, body] of Object.entries(version.onDemand)) {
      record.onDemand[id] = await this._writeBlob(body);
    }

    for (const [id, body] of Object.entries(version.declarations)) {
      record.declarations[id] = await this._writeBlob(body);
    }

    await this._atomicWrite(path.join(this._versionsDir, `${record.id}.json`), JSON.stringify(record, null, 2));

    return this._toMeta(record, await this._activeId());
  }

  async get(id: string): Promise<PromptVersion | null> {
    const record = await this._readRecord(id);

    if (!record) {
      return null;
    }

    const content = await this._readBlob(record.base);

    if (content === null) {
      return null;
    }

    return { ...this._toMeta(record, await this._activeId()), content };
  }

  async getActive(): Promise<PromptVersion | null> {
    const id = await this._activeId();
    return id ? this.get(id) : null;
  }

  async list(): Promise<PromptVersionMeta[]> {
    let files: string[];

    try {
      files = await fs.readdir(this._versionsDir);
    } catch {
      return [];
    }

    const activeId = await this._activeId();
    const metas: PromptVersionMeta[] = [];

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const record = await this._readRecord(file.replace(/\.json$/, ''));

      if (record) {
        metas.push(this._toMeta(record, activeId));
      }
    }

    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Flip the active version. A single atomic pointer write — so "exactly one active" is structural,
   * not a constraint we have to police, and a failed build can never leave zero versions active.
   */
  async activate(id: string): Promise<void> {
    const record = await this._readRecord(id);

    if (!record) {
      throw new Error(`Prompt version not found: ${id}`);
    }

    await fs.mkdir(this._root, { recursive: true });
    await this._atomicWrite(this._activePath, JSON.stringify({ versionId: id }, null, 2));
  }

  /**
   * Stamp an observation onto an existing version.
   *
   * Read-modify-write of the record's observation fields only: everything that gives the version its
   * identity (`content*`, `sourceCommitSha`, the blob refs) is carried across untouched, so this
   * cannot rewrite what a version IS. Silently no-ops on an unknown id — an observation is a note in
   * the margin, and failing a refresh over one would invert the cost of getting this wrong.
   */
  async recordSeen(id: string, commitSha: string): Promise<void> {
    const record = await this._readRecord(id);

    if (!record) {
      return;
    }

    const updated: VersionRecord = { ...record, lastSeenCommitSha: commitSha, lastSeenAt: new Date().toISOString() };

    await this._atomicWrite(path.join(this._versionsDir, `${record.id}.json`), JSON.stringify(updated, null, 2));
  }

  async readOnDemand(versionId: string, blockId: string): Promise<string | null> {
    const record = await this._readRecord(versionId);
    const hash = record?.onDemand[blockId];

    return hash ? this._readBlob(hash) : null;
  }

  async readDeclaration(versionId: string, declId: string): Promise<string | null> {
    const record = await this._readRecord(versionId);
    const hash = record?.declarations[declId];

    return hash ? this._readBlob(hash) : null;
  }
}

let _store: PromptStore | undefined;

export function getPromptStore(): PromptStore {
  if (!_store) {
    _store = new FsPromptStore();
  }

  return _store;
}

/** Test seam. */
export function setPromptStore(store: PromptStore | undefined) {
  _store = store;
}
