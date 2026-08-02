/**
 * Object-store selection (SPEC §4.5.5, spec/hosting.md).
 *
 * S3 when `S3_BUCKET` is set; the local filesystem otherwise. The choice is made once, here, so that
 * every caller — snapshots, share builds, assets — is written against `ObjectStore` and none of them
 * grows an `if (s3)`.
 */
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';
import { platformDataDir } from '~/lib/.server/platform-dir';
import { FsObjectStore, getS3Config, S3ObjectStore, type ObjectStore } from './store';

const logger = createScopedLogger('storage');

export type { ObjectStore, StoredObject } from './store';
export { FsObjectStore, S3ObjectStore, getS3Config } from './store';

let _store: ObjectStore | undefined;

export function getObjectStore(context?: unknown): ObjectStore {
  if (!_store) {
    const s3 = getS3Config(context);

    if (s3) {
      logger.info(`Object storage: S3 bucket "${s3.bucket}" (${s3.region})`);
      _store = new S3ObjectStore(s3);
    } else {
      const root = path.join(platformDataDir(), 'storage');
      logger.info(`Object storage: local filesystem at ${root} (set S3_BUCKET to use S3)`);
      _store = new FsObjectStore(root);
    }
  }

  return _store;
}

/** Test seam. */
export function setObjectStore(store: ObjectStore | undefined) {
  _store = store;
}
