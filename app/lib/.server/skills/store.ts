/**
 * Skills store (SPEC §4.11, spec/skills.md).
 *
 * Same STORAGE SEAM as the prompt store, and persisted the same way — through `ObjectStore`, so a
 * skill version survives the container that built it. This file's header used to promise exactly
 * that ("resources in S3 under a `storage_prefix`") while writing to `.data/skills` unconditionally;
 * see `prompt/store.ts` for the deploy-time outage that made the gap real. Everything the runtime
 * needs is here — immutable versions, per-skill activation, per-skill rollback, and a resources
 * manifest.
 *
 * The `resources` manifest is the security boundary: `read_skill_resource` resolves ONLY through it
 * by exact path match. There are no filesystem path semantics anywhere in that lookup, so the whole
 * path-traversal class of bugs cannot occur — and routing storage through `ObjectStore` does not
 * weaken it, because the manifest still decides which key is read.
 */
import { getObjectStore, type ObjectStore } from '~/lib/.server/storage';
import { sha256 } from '~/lib/.server/prompt/store';
import { isExcludedSkill } from './exclusions';

export interface SkillVersionMeta {
  id: string;
  name: string;
  description: string;
  sourceCommitSha: string;
  createdAt: string;
  bodyBytes: number;

  /** Bundle-relative paths of every non-SKILL.md file (`references/foo.md`, …). */
  resourcePaths: string[];
  isActive: boolean;
}

export interface SkillVersion extends SkillVersionMeta {
  /** SKILL.md with frontmatter stripped — the instructions handed to the model. */
  body: string;
}

export interface NewSkillVersion {
  name: string;
  description: string;
  body: string;
  sourceCommitSha: string;

  /** Bundle-relative path → file contents. */
  resources: Record<string, string>;
}

export interface SkillStore {
  put(version: NewSkillVersion): Promise<SkillVersionMeta>;
  activate(name: string, versionId: string): Promise<void>;

  /** Active version of every synced skill, sorted by name (stable index bytes). */
  listActive(): Promise<SkillVersion[]>;

  /** Every version of every skill — for the admin rollback UI. */
  listAll(): Promise<SkillVersionMeta[]>;
  getActive(name: string): Promise<SkillVersion | null>;

  /** Resolves STRICTLY through the version's manifest. Unknown path → null, never an exception. */
  readResource(name: string, resourcePath: string): Promise<string | null>;
}

interface SkillRecord {
  id: string;
  name: string;
  description: string;
  sourceCommitSha: string;
  createdAt: string;
  bodyBytes: number;
  body: string;

  /** manifest: bundle-relative path → blob sha. */
  resources: Record<string, string>;
}

/** Everything this store owns lives under one prefix, so a `list` can never see another subsystem. */
export const SKILL_STORE_PREFIX = 'skills';

export class SkillVersionStore implements SkillStore {
  private readonly _objects: ObjectStore;
  private readonly _prefix: string;

  constructor(objects?: ObjectStore, prefix = SKILL_STORE_PREFIX) {
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

    // Content-addressed: identical bytes are already there, and rewriting is pure waste.
    if (await this._objects.get(key)) {
      return hash;
    }

    await this._putText(key, content);

    return hash;
  }

  private async _readBlob(hash: string): Promise<string | null> {
    return this._getText(this._blobKey(hash));
  }

  private async _readRecord(id: string): Promise<SkillRecord | null> {
    const raw = await this._getText(this._versionKey(id));

    if (raw === null) {
      return null;
    }

    try {
      return JSON.parse(raw) as SkillRecord;
    } catch {
      return null;
    }
  }

  /** name → active version id. */
  private async _activeMap(): Promise<Record<string, string>> {
    const raw = await this._getText(this._activeKey);

    if (raw === null) {
      return {};
    }

    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private _toMeta(record: SkillRecord, activeId: string | undefined): SkillVersionMeta {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      sourceCommitSha: record.sourceCommitSha,
      createdAt: record.createdAt,
      bodyBytes: record.bodyBytes,
      resourcePaths: Object.keys(record.resources).sort(),
      isActive: record.id === activeId,
    };
  }

  async put(version: NewSkillVersion): Promise<SkillVersionMeta> {
    const createdAt = new Date().toISOString();
    const bodyHash = sha256(version.body);

    const record: SkillRecord = {
      id: `sv_${version.name}_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${bodyHash.slice(0, 8)}`,
      name: version.name,
      description: version.description,
      sourceCommitSha: version.sourceCommitSha,
      createdAt,
      bodyBytes: Buffer.byteLength(version.body, 'utf8'),
      body: version.body,
      resources: {},
    };

    for (const [resourcePath, contents] of Object.entries(version.resources)) {
      record.resources[resourcePath] = await this._writeBlob(contents);
    }

    await this._putText(this._versionKey(record.id), JSON.stringify(record, null, 2));

    const active = await this._activeMap();

    return this._toMeta(record, active[version.name]);
  }

  async activate(name: string, versionId: string): Promise<void> {
    const record = await this._readRecord(versionId);

    if (!record) {
      throw new Error(`Skill version not found: ${versionId}`);
    }

    if (record.name !== name) {
      throw new Error(`Skill version ${versionId} belongs to "${record.name}", not "${name}"`);
    }

    const active = await this._activeMap();
    active[name] = versionId;

    await this._putText(this._activeKey, JSON.stringify(active, null, 2));
  }

  async listAll(): Promise<SkillVersionMeta[]> {
    const objects = await this._objects.list(`${this._prefix}/versions/`);
    const active = await this._activeMap();
    const metas: SkillVersionMeta[] = [];

    for (const object of objects) {
      if (!object.key.endsWith('.json')) {
        continue;
      }

      // The key is prefixed and the id is the basename — never split on '/' assuming a fixed depth.
      const id = object.key.slice(object.key.lastIndexOf('/') + 1).replace(/\.json$/, '');
      const record = await this._readRecord(id);

      if (record) {
        metas.push(this._toMeta(record, active[record.name]));
      }
    }

    return metas.sort((a, b) => a.name.localeCompare(b.name) || b.createdAt.localeCompare(a.createdAt));
  }

  async getActive(name: string): Promise<SkillVersion | null> {
    /*
     * Platform-excluded skills (exclusions.ts) do not exist as far as the runtime is concerned —
     * this is the read seam that keeps an ALREADY-SYNCED excluded version unreachable, not just
     * unsynced. `listActive` inherits the filter (it goes through here), so the index, the `/`
     * autocomplete, and `load_skill`'s available-list all agree by construction. `listAll` stays
     * unfiltered on purpose: the admin rollback UI should see what is stored.
     */
    if (isExcludedSkill(name)) {
      return null;
    }

    const active = await this._activeMap();
    const id = active[name];

    if (!id) {
      return null;
    }

    const record = await this._readRecord(id);

    return record ? { ...this._toMeta(record, id), body: record.body } : null;
  }

  async listActive(): Promise<SkillVersion[]> {
    const active = await this._activeMap();
    const skills: SkillVersion[] = [];

    // Sorted by name so the index text is byte-stable — an unstable index would bust the prompt cache.
    for (const name of Object.keys(active).sort()) {
      const skill = await this.getActive(name);

      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  async readResource(name: string, resourcePath: string): Promise<string | null> {
    // Same rule as `getActive` — an excluded skill's bundle is unreachable, resources included.
    if (isExcludedSkill(name)) {
      return null;
    }

    const active = await this._activeMap();
    const id = active[name];

    if (!id) {
      return null;
    }

    const record = await this._readRecord(id);

    // Exact-match manifest lookup. No path joining, no normalization, no traversal surface.
    const hash = record?.resources[resourcePath];

    return hash ? this._readBlob(hash) : null;
  }
}

let _store: SkillStore | undefined;

export function getSkillStore(): SkillStore {
  if (!_store) {
    _store = new SkillVersionStore();
  }

  return _store;
}

/** Test seam. */
export function setSkillStore(store: SkillStore | undefined) {
  _store = store;
}
