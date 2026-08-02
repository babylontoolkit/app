/**
 * Prompt-version store (SPEC §4.3, spec/doc-sync.md).
 *
 * STORAGE SEAM. Everything the spec requires of the store — immutable versions, exactly-one-active,
 * atomic activation, rollback to any prior version, content hashing — is implemented here against
 * `ObjectStore`, behind an interface.
 *
 * 🔴 **IT PERSISTS THROUGH `ObjectStore`, NOT THE CONTAINER'S DISK, AND THAT IS THE WHOLE POINT
 * (2026-08-01).** This store wrote to `.data/prompt` unconditionally. `spec/hosting.md` says the app
 * is stateless and *"anything stateful in the container is a bug"* — and a Lightsail container
 * filesystem does not survive a deployment, so on AWS **every deploy landed a container with no
 * prompt version at all**. There is no boot-time sync: a version is built ONLY by an admin pressing
 * Refresh or a `curl` with `ADMIN_TOKEN`. So `getActivePrompt()` returned null and `proxy.ts` threw
 * `NotConfiguredError('The system prompt')` on **every generation, for every user, until a human
 * noticed** — and `DEPLOY.md`'s own smoke test ends with "new project → generate", which is exactly
 * the step that would have failed. Reproduced before fixing: a store on an empty root reports
 * `getActive() → null`, `list() → []`.
 *
 * Routing it through `ObjectStore` fixes it without a new mechanism: that seam is already "S3 when
 * `S3_BUCKET` is set, the local filesystem otherwise", so production gets durability across
 * deployments and local dev is byte-identical behaviour one directory over. There is ONE
 * implementation — a second local-only class would be two writers of one state, which is the drift
 * this codebase keeps re-learning.
 *
 * ⚠️ The hot path is unaffected: `active.ts` memoises the active version for 30s in-process, so this
 * costs at most one round of GETs per 30 seconds, never one per generation.
 *
 * Large bodies (the 490KB `babylon.toolkit.d.ts`, the on-demand system docs) are content-addressed
 * so that N versions of a prompt do not store N copies of an unchanged declaration file.
 */
import { createHash } from 'node:crypto';
import { getObjectStore, type ObjectStore } from '~/lib/.server/storage';

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

export { platformDataDir } from '~/lib/.server/platform-dir';

/** Everything this store owns lives under one prefix, so a `list` can never see another subsystem. */
export const PROMPT_STORE_PREFIX = 'prompt';

export class PromptVersionStore implements PromptStore {
  private readonly _objects: ObjectStore;
  private readonly _prefix: string;

  constructor(objects?: ObjectStore, prefix = PROMPT_STORE_PREFIX) {
    this._objects = objects ?? getObjectStore();
    this._prefix = prefix;
  }

  private _versionKey(id: string) {
    return `${this._prefix}/versions/${id}.json`;
  }

  private _blobKey(hash: string) {
    return `${this._prefix}/blobs/${hash}`;
  }

  private get _activeKey() {
    return `${this._prefix}/active.json`;
  }

  private async _putText(key: string, content: string): Promise<void> {
    await this._objects.put(key, new TextEncoder().encode(content), 'application/json');
  }

  private async _getText(key: string): Promise<string | null> {
    const bytes = await this._objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  private async _writeBlob(content: string): Promise<string> {
    const hash = sha256(content);
    const key = this._blobKey(hash);

    /*
     * Content-addressed: identical bytes are already there, and rewriting is pure waste. On S3 the
     * existence probe is a GET rather than a stat, which is why it matters that the blobs it skips
     * are the big ones — a 490KB declaration file re-uploaded per build would dwarf the check.
     */
    if (await this._objects.get(key)) {
      return hash;
    }

    await this._putText(key, content);

    return hash;
  }

  private async _readBlob(hash: string): Promise<string | null> {
    return this._getText(this._blobKey(hash));
  }

  private async _readRecord(id: string): Promise<VersionRecord | null> {
    const raw = await this._getText(this._versionKey(id));

    if (raw === null) {
      return null;
    }

    try {
      return JSON.parse(raw) as VersionRecord;
    } catch {
      // A record that cannot be parsed is a record we do not have — never a thrown refresh.
      return null;
    }
  }

  private async _activeId(): Promise<string | null> {
    const raw = await this._getText(this._activeKey);

    if (raw === null) {
      return null;
    }

    try {
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

    await this._putText(this._versionKey(record.id), JSON.stringify(record, null, 2));

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
    const objects = await this._objects.list(`${this._prefix}/versions/`);
    const activeId = await this._activeId();
    const metas: PromptVersionMeta[] = [];

    for (const object of objects) {
      if (!object.key.endsWith('.json')) {
        continue;
      }

      // The key is prefixed and the id is the basename — never split on '/' assuming a fixed depth.
      const id = object.key.slice(object.key.lastIndexOf('/') + 1).replace(/\.json$/, '');
      const record = await this._readRecord(id);

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

    await this._putText(this._activeKey, JSON.stringify({ versionId: id }, null, 2));
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

    await this._putText(this._versionKey(record.id), JSON.stringify(updated, null, 2));
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
    _store = new PromptVersionStore();
  }

  return _store;
}

/** Test seam. */
export function setPromptStore(store: PromptStore | undefined) {
  _store = store;
}
