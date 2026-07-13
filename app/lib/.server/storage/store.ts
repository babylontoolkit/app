/**
 * Object storage (SPEC §4.5.5, §4.8, spec/hosting.md).
 *
 * Snapshots, share builds, skill resources and asset packs all need somewhere to put bytes. That
 * "somewhere" is S3 in production and the local filesystem in development — and NOTHING above this
 * interface may know which. Keeping the seam here is what makes the presigned-URL swap (the planned
 * scaling move, so payloads stop transiting our server) a change to one file rather than to every
 * caller.
 *
 * **Bytes in, bytes out — always `Uint8Array`.** There is no string overload on purpose. A snapshot
 * carries PNGs, GLBs and WASM; a `string` signature is exactly how upstream's file layer destroyed
 * binaries in the first place (spec/binary-files.md). Text callers encode at the boundary.
 */
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '~/lib/.server/env';

export interface StoredObject {
  key: string;
  size: number;
  lastModified?: string;
}

export interface ObjectStore {
  /** The backend actually in use — surfaced in admin/diagnostics so "where did my snapshot go" is answerable. */
  readonly backend: 's3' | 'filesystem';

  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;

  /** The object's bytes, or null when it does not exist. A miss is a value, not an exception. */
  get(key: string): Promise<Uint8Array | null>;

  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
}

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;

  /** Non-AWS S3-compatible endpoints (MinIO, R2). Optional. */
  endpoint?: string;
}

export function getS3Config(context?: unknown): S3Config | null {
  const bucket = env(context, 'S3_BUCKET');

  if (!bucket) {
    return null;
  }

  return {
    bucket,
    region: env(context, 'S3_REGION') || env(context, 'AWS_REGION') || 'us-east-1',
    accessKeyId: env(context, 'S3_ACCESS_KEY_ID') || env(context, 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: env(context, 'S3_SECRET_ACCESS_KEY') || env(context, 'AWS_SECRET_ACCESS_KEY'),
    endpoint: env(context, 'S3_ENDPOINT'),
  };
}

/**
 * Local-filesystem object store — the fallback when `S3_BUCKET` is unset.
 *
 * This is not a mock. It is a real, byte-faithful implementation of the same contract, which is what
 * lets snapshots, restore, share and export be BUILT and TESTED end-to-end before an AWS account
 * exists (§1.3 principle 0: never skip a feature because a vendor is missing).
 */
export class FsObjectStore implements ObjectStore {
  readonly backend = 'filesystem' as const;

  private readonly _root: string;

  constructor(root: string) {
    this._root = root;
  }

  /**
   * Resolve a key under the root, refusing to escape it.
   *
   * Keys are built from user-influenced ids. `../` in a key would otherwise let a caller read or
   * clobber arbitrary files on the host — the filesystem's version of the ownership hole the two-wall
   * rule (§4.5.3) exists to close.
   */
  private _resolve(key: string): string {
    const full = path.resolve(this._root, key);

    if (full !== this._root && !full.startsWith(this._root + path.sep)) {
      throw new Error(`Refusing to resolve object key outside the store root: ${key}`);
    }

    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this._resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });

    // Temp + rename: a crash mid-write can never leave a half-written snapshot that restore would trust.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, file);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buffer = await fs.readFile(this._resolve(key));

      // Copy onto the exact byte range: Buffer may be a view into a larger pooled ArrayBuffer.
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this._resolve(key));
    } catch {
      // Deleting what is not there is success, not failure — the caller's intent is satisfied.
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const root = this._resolve(prefix);
    const found: StoredObject[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];

      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // A prefix that does not exist yet is an empty listing, not an error.
        return;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }

        if (entry.name.endsWith('.tmp')) {
          continue;
        }

        const stat = await fs.stat(full);
        found.push({
          key: path.relative(this._root, full).split(path.sep).join('/'),
          size: stat.size,
          lastModified: stat.mtime.toISOString(),
        });
      }
    };

    await walk(root);

    return found.sort((a, b) => a.key.localeCompare(b.key));
  }
}

/** S3 object store — production. Lazily imports the SDK so the FS path costs nothing to load. */
export class S3ObjectStore implements ObjectStore {
  readonly backend = 's3' as const;

  private readonly _config: S3Config;
  private _client: Promise<import('@aws-sdk/client-s3').S3Client> | undefined;

  constructor(config: S3Config) {
    this._config = config;
  }

  private _getClient() {
    if (!this._client) {
      this._client = import('@aws-sdk/client-s3').then(
        (sdk) =>
          new sdk.S3Client({
            region: this._config.region,
            ...(this._config.endpoint ? { endpoint: this._config.endpoint, forcePathStyle: true } : {}),

            /*
             * Explicit keys are for local/dev and non-AWS endpoints. In production on Lightsail we
             * leave these unset so the SDK's default provider chain picks up the instance role —
             * no long-lived keys on disk at all, which is the posture leaked-key scraping demands.
             */
            ...(this._config.accessKeyId && this._config.secretAccessKey
              ? {
                  credentials: {
                    accessKeyId: this._config.accessKeyId,
                    secretAccessKey: this._config.secretAccessKey,
                  },
                }
              : {}),
          }),
      );
    }

    return this._client;
  }

  async put(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    const [client, sdk] = await Promise.all([this._getClient(), import('@aws-sdk/client-s3')]);

    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this._config.bucket,
        Key: key,
        Body: bytes,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    const [client, sdk] = await Promise.all([this._getClient(), import('@aws-sdk/client-s3')]);

    try {
      const result = await client.send(new sdk.GetObjectCommand({ Bucket: this._config.bucket, Key: key }));
      const bytes = await result.Body?.transformToByteArray();

      return bytes ?? null;
    } catch (error) {
      if ((error as { name?: string })?.name === 'NoSuchKey') {
        return null;
      }

      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const [client, sdk] = await Promise.all([this._getClient(), import('@aws-sdk/client-s3')]);
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this._config.bucket, Key: key }));
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const [client, sdk] = await Promise.all([this._getClient(), import('@aws-sdk/client-s3')]);

    const objects: StoredObject[] = [];
    let token: string | undefined;

    // Paginate. A project with many snapshots silently truncating at 1000 is a data-loss-shaped bug.
    do {
      const result = await client.send(
        new sdk.ListObjectsV2Command({ Bucket: this._config.bucket, Prefix: prefix, ContinuationToken: token }),
      );

      for (const item of result.Contents ?? []) {
        if (item.Key) {
          objects.push({ key: item.Key, size: item.Size ?? 0, lastModified: item.LastModified?.toISOString() });
        }
      }

      token = result.NextContinuationToken;
    } while (token);

    return objects;
  }
}
