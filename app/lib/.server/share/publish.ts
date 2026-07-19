/**
 * Publishing a build (SPEC §4.8, §5, spec/hosting.md).
 *
 * The flow: the WebContainer runs `npm run build` (client side — the server never executes user code,
 * §5), the client hands us the resulting `dist/` as a byte-faithful `SerializedFileMap`, and this
 * module puts it in object storage under a share key and mints the public id.
 *
 * Two things here are load-bearing, and both are about the fact that **the file paths in that map came
 * from the client**:
 *
 * 1. **Every key is re-derived, never trusted.** A build map is a client-supplied
 *    `Record<path, dirent>`. `../` in one of those paths, applied naively to a storage prefix, writes
 *    OUTSIDE this share — over another user's build, or over a snapshot. `buildObjectKey` is the only
 *    way a path becomes a key, and it rejects rather than sanitises: a path that needed cleaning is a
 *    path we do not understand, and quietly "fixing" it into some other valid key is how you end up
 *    overwriting the wrong object with a straight face.
 * 2. **The secret rules run again, here, on the bytes actually being uploaded.** `runPublishingChecklist`
 *    (checklist.ts) already scanned the SOURCE, but this is the last code that touches the bytes before
 *    they become world-readable, and it is the only place that sees what is *actually* in the upload.
 *    Defence in depth on the one action that cannot be undone.
 */
import { randomInt } from 'node:crypto';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { base64ToBytes } from '~/lib/binary/binary-files';
import { getObjectStore } from '~/lib/.server/storage';
import { getProjectStore } from '~/lib/.server/projects/store';
import { deleteRemixSeed } from './seed-store';
import type { Project } from '~/lib/.server/projects/types';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('share.publish');

/**
 * Share ids are in URLs people paste to friends, so: no ambiguous glyphs (no `l`/`1`/`O`/`0`) and long
 * enough that the id space cannot be walked. 12 characters of a 31-symbol alphabet is ~59 bits.
 *
 * **`randomInt`, not `Math.random`.** A share that is not submitted to the gallery is *unlisted*, and
 * an unlisted game is protected by exactly one thing: the unguessability of this id. `Math.random` is
 * a PRNG whose internal state is recoverable from its outputs — an attacker who reads a handful of
 * public gallery share ids could then predict the unlisted ones. This is a CSPRNG for the same reason
 * a session token is.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SHARE_ID_LENGTH = 12;

export function generateShareId(): string {
  let id = '';

  for (let i = 0; i < SHARE_ID_LENGTH; i++) {
    id += ALPHABET[randomInt(ALPHABET.length)];
  }

  return id;
}

/** Where a share's static files live. One prefix per share id — never per project. */
export function buildPrefix(shareId: string): string {
  return `builds/${shareId}`;
}

export class UnsafeBuildPathError extends Error {
  readonly statusCode = 400;
  readonly isRetryable = false;

  constructor(path: string) {
    super(`That build contains a file path we cannot publish safely: ${path}`);
    this.name = 'UnsafeBuildPathError';
  }
}

/**
 * Caps on the uploaded build (SPEC §5). The `dist/` map is client-supplied and written to a public
 * bucket, so without a bound it is unbounded S3 storage + CDN egress on the platform's bill for any
 * verified user, repeatable per re-publish. Generous for a real game build (wasm + textures + audio),
 * bounded against abuse.
 */
export const MAX_BUILD_BYTES = 150 * 1024 * 1024;
export const MAX_BUILD_FILES = 10_000;

export class BuildTooLargeError extends Error {
  readonly statusCode = 413;
  readonly isRetryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'BuildTooLargeError';
  }
}

/** Paths that must never be uploaded to a public bucket, whatever the checklist said. */
const NEVER_PUBLISH = [/(^|\/)\.env$/, /(^|\/)\.env\.[^/]*local$/, /(^|\/)\.npmrc$/, /(^|\/)\.git\//];

/**
 * Turn a client-supplied build path into a storage key, or throw.
 *
 * Rejects (never rewrites): absolute paths, `..` in any segment, backslashes (a Windows-shaped path
 * that a POSIX key would mangle), null bytes, and empty segments. Anything that survives is a plain
 * relative path made of ordinary segments, and joining it to the prefix cannot escape the prefix.
 */
export function buildObjectKey(shareId: string, rawPath: string): string {
  /*
   * Normalise ONLY the known WebContainer workdir and the dist root — never a bare leading slash, so a
   * genuinely absolute path (`/etc/...`) is rejected below rather than silently relativised.
   */
  const path = rawPath.replace(/^\/?home\/project\//, '').replace(/^dist\//, '');

  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new UnsafeBuildPathError(rawPath);
  }

  if (path.includes('\\') || path.includes('\0')) {
    throw new UnsafeBuildPathError(rawPath);
  }

  const segments = path.split('/');

  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new UnsafeBuildPathError(rawPath);
  }

  if (NEVER_PUBLISH.some((rule) => rule.test(path))) {
    throw new UnsafeBuildPathError(rawPath);
  }

  return `${buildPrefix(shareId)}/${segments.join('/')}`;
}

export interface PublishInput {
  project: Project;

  /** The contents of `dist/` after `npm run build`, byte-faithful (spec/binary-files.md). */
  dist: SerializedFileMap;
  title?: string;
  description?: string;

  /** Ask an admin to feature this in the gallery (§4.8). Curation is theirs, not the user's. */
  submitToGallery?: boolean;

  /** From the checklist — a network-capable game is launched solo (§4.8). */
  soloLaunch?: boolean;
}

export interface PublishResult {
  shareId: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * Upload a build and mint (or reuse) the project's share id.
 *
 * Re-publishing REUSES the existing share id — the URL a user already sent to their friends must keep
 * working and must show the new version. It writes the new files over the old prefix and then deletes
 * whatever the previous build left behind, in that order: a visitor mid-publish sees a stale file or a
 * fresh one, never a missing one.
 */
export async function publishBuild(input: PublishInput, context?: unknown): Promise<PublishResult> {
  const { project, dist } = input;
  const shareId = project.shareId ?? generateShareId();
  const objects = getObjectStore(context);
  const prefix = buildPrefix(shareId);

  const entries = Object.entries(dist).filter(
    (entry): entry is [string, Exclude<SerializedFileMap[string], undefined> & { type: 'file' }] =>
      entry[1]?.type === 'file',
  );

  if (entries.length === 0) {
    throw new UnsafeBuildPathError('the build produced no files');
  }

  // Cap BEFORE decoding/writing: reject an oversized build rather than stream it into the bucket.
  if (entries.length > MAX_BUILD_FILES) {
    throw new BuildTooLargeError(`That build has too many files (${entries.length} > ${MAX_BUILD_FILES}).`);
  }

  const approxBytes = entries.reduce((sum, [, dirent]) => sum + (dirent.content?.length ?? 0), 0);

  if (approxBytes > MAX_BUILD_BYTES) {
    throw new BuildTooLargeError('That build is too large to publish.');
  }

  // Derive every key BEFORE writing anything — one bad path fails the publish, it does not half-do it.
  const planned = entries.map(([path, dirent]) => ({
    key: buildObjectKey(shareId, path),
    bytes: dirent.isBinary ? base64ToBytes(dirent.content) : new TextEncoder().encode(dirent.content),
    path,
  }));

  const previous = await objects.list(prefix);
  const written = new Set<string>();
  let totalBytes = 0;

  for (const file of planned) {
    await objects.put(file.key, file.bytes, contentTypeFor(file.path));
    written.add(file.key);
    totalBytes += file.bytes.byteLength;
  }

  // Files the old build had and the new one does not. Left behind, they would be served forever.
  for (const stale of previous) {
    if (!written.has(stale.key)) {
      await objects.delete(stale.key);
    }
  }

  await getProjectStore(context).update(project.id, {
    shareId,
    shareTitle: input.title?.trim() || project.name,
    shareDescription: input.description?.trim() || undefined,
    sharedAt: new Date().toISOString(),
    soloLaunch: input.soloLaunch ?? false,

    // Submitting is a REQUEST. Nothing becomes publicly listed without an admin approving it (§5).
    galleryStatus: input.submitToGallery ? 'pending' : 'none',
  });

  logger.info(`Published ${project.id} as ${shareId}: ${planned.length} files, ${totalBytes} bytes`);

  return { shareId, fileCount: planned.length, totalBytes };
}

/**
 * Unpublish: the URL stops working, the build is deleted, and the remix seed is forgotten.
 *
 * The share id is NOT released back — it stays on the project (as `sharedAt: undefined`) so that a
 * later re-publish reuses it. Recycling ids would let a stale link land on somebody else's game.
 *
 * 🔴 The SEED goes too (§4.8, §4.5.4b), and that is not housekeeping. The seed is the only source the
 * platform holds, and the sole justification for holding it is that the owner deliberately made this
 * game public. Unpublishing withdraws exactly that. Keeping the seed would mean "make it private
 * again" left our copy of their code sitting in storage — the §4.5.4b promise reduced to a claim.
 *
 * An existing remix is unaffected: a clone has its own seed, under its own project id.
 */
export async function unpublish(project: Project, context?: unknown): Promise<void> {
  if (!project.shareId) {
    return;
  }

  const objects = getObjectStore(context);

  for (const object of await objects.list(buildPrefix(project.shareId))) {
    await objects.delete(object.key);
  }

  await deleteRemixSeed(project.id, context);
  await getProjectStore(context).update(project.id, {
    sharedAt: undefined,
    galleryStatus: 'none',
    remixSeedAt: undefined,
  });

  logger.info(`Unpublished ${project.id} (${project.shareId}) and deleted its remix seed`);
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  ktx2: 'image/ktx2',
  dds: 'image/vnd-ms.dds',
  env: 'application/octet-stream',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

/**
 * Content type by extension.
 *
 * `.wasm` and `.glb` matter more than they look: Babylon streams both, and a wrong type on the WASM
 * (Havok physics) makes the browser refuse to compile it — the game loads and then simply never
 * simulates. Unknown types fall back to a byte stream rather than guessing.
 */
export function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';

  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
