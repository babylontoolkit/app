/**
 * Skills store (SPEC §4.11, spec/skills.md).
 *
 * Same STORAGE SEAM as the prompt store: the spec's target is Supabase `skills` / `skill_versions`
 * rows with resources in S3 under a `storage_prefix` (Stage 2). Until those exist, this filesystem
 * adapter provides everything the runtime actually needs — immutable versions, per-skill activation,
 * per-skill rollback, and a resources manifest. Swap the adapter, keep the callers.
 *
 * The `resources` manifest is the security boundary: `read_skill_resource` resolves ONLY through it
 * by exact path match. There are no filesystem path semantics anywhere in that lookup, so the whole
 * path-traversal class of bugs cannot occur.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformDataDir, sha256 } from '~/lib/.server/prompt/store';

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

export class FsSkillStore implements SkillStore {
  private readonly _root: string;

  constructor(root?: string) {
    this._root = root ?? path.join(platformDataDir(), 'skills');
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

  private async _atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  }

  private async _writeBlob(content: string): Promise<string> {
    const hash = sha256(content);
    const file = path.join(this._blobsDir, hash);

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

  private async _readRecord(id: string): Promise<SkillRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this._versionsDir, `${id}.json`), 'utf8')) as SkillRecord;
    } catch {
      return null;
    }
  }

  /** name → active version id. */
  private async _activeMap(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(this._activePath, 'utf8')) as Record<string, string>;
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
    await fs.mkdir(this._versionsDir, { recursive: true });

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

    await this._atomicWrite(path.join(this._versionsDir, `${record.id}.json`), JSON.stringify(record, null, 2));

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

    await fs.mkdir(this._root, { recursive: true });

    const active = await this._activeMap();
    active[name] = versionId;

    await this._atomicWrite(this._activePath, JSON.stringify(active, null, 2));
  }

  async listAll(): Promise<SkillVersionMeta[]> {
    let files: string[];

    try {
      files = await fs.readdir(this._versionsDir);
    } catch {
      return [];
    }

    const active = await this._activeMap();
    const metas: SkillVersionMeta[] = [];

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const record = await this._readRecord(file.replace(/\.json$/, ''));

      if (record) {
        metas.push(this._toMeta(record, active[record.name]));
      }
    }

    return metas.sort((a, b) => a.name.localeCompare(b.name) || b.createdAt.localeCompare(a.createdAt));
  }

  async getActive(name: string): Promise<SkillVersion | null> {
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
    _store = new FsSkillStore();
  }

  return _store;
}

/** Test seam. */
export function setSkillStore(store: SkillStore | undefined) {
  _store = store;
}
