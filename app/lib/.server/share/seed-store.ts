/**
 * Where the remix seed lives (SPEC §4.8, §4.5.4b).
 *
 * ## Why this module exists rather than a snapshot row
 *
 * The seed used to be stored as a `Snapshot`: a row in the `snapshots` table pointing at bytes in the
 * ObjectStore, created with `label: 'Shared'`, addressed by `projects.current_snapshot_id`. That was
 * never what a snapshot meant — a snapshot was one entry in a per-project version history the platform
 * took after every generation, and §4.5.4b deleted that history outright. What survived was a single
 * copy of one deliberately-published game, wearing the clothes of a system that no longer exists.
 *
 * Keeping it in that shape had a real cost, not just an aesthetic one: `current_snapshot_id` silently
 * changed meaning (it pointed at "the seed" on a published project and at nothing at all on every other
 * one), and the whole store — two backends, a manifest builder, an ownership assertion, a version-list
 * route with no callers — stayed alive to serve one `read` and one `create`. A reader looking for
 * "where are the snapshots" found a full implementation and reasonably concluded the platform still
 * kept them.
 *
 * So the seed is stored as what it is: **one object per project, at a stable key.** No row, no id, no
 * pointer to keep in sync — the key is derived from the project id, so "does this project have a seed"
 * is a question about storage, not about a column that could disagree with storage.
 *
 * ## What a seed is, and the boundary it sits on
 *
 * It is the ONLY source the platform holds under repo-primary persistence, and it exists for exactly
 * two reasons, both of them a deliberate act by the person whose code it is:
 *
 *   - **Publish.** The owner made the game public for others to play and remix. A stranger's remix
 *     cannot read the owner's repo — it is private, and it is theirs — so the owner deposits the seed
 *     from their browser at the moment they choose to publish.
 *   - **Remix.** The clone needs something to open on first mount, on whatever device opens it. Its
 *     files came from the source's seed; this is that copy, under the new owner's project id.
 *
 * `buildRemixSeed` strips the `.env` family before anything reaches here (`remix-seed.ts`). This module
 * does not re-decide that: one rule, one place.
 *
 * ## Bytes
 *
 * A `SerializedFileMap` is JSON — text inline, binaries base64 (`spec/binary-files.md`). It is encoded
 * once here and decoded once here, and base64 stays a wire format throughout: nothing on this path
 * reinterprets it, which is the only reason a PNG survives the round trip.
 */
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { envNumber } from '~/lib/.server/env';
import { DEFAULT_PROJECT_SOURCE_MAX_MB } from '~/lib/.server/storage/limits';
import { getObjectStore } from '~/lib/.server/storage';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('share.seed');

/**
 * One seed per project, at a key derived from the project id.
 *
 * Deliberately NOT keyed by share id: a remix clone has a seed and no share id, and re-keying a seed
 * when a game is unpublished-then-republished would strand the old object under the old key forever.
 */
export function seedKey(projectId: string): string {
  return `seeds/${projectId}.json`;
}

/**
 * Cap on the serialized seed (SPEC §5) — **configurable**, `REMIX_SEED_MAX_MB`.
 *
 * The seed is client-supplied bytes written to object storage, so an uncapped one is unbounded S3 +
 * egress on the platform's bill for any verified user.
 *
 * The default is SHARED with the working copy (`storage/limits.ts`), and that is the fix for a real
 * defect: it used to be 75MB against the working copy's 256MB, two numbers chosen independently. A
 * project between them could be held for crash recovery and published successfully, and then fail to
 * seed — leaving a public, playable, **permanently un-remixable** game whose owner was told nothing,
 * because `depositRemixSeed` may not fail a publish. Same content, same reason to bound it, one number.
 *
 * ⚠️ It shares a request with the build, so both sit under `PUBLISH_BODY_MAX_MB` — see `.env.example`.
 */
export const DEFAULT_REMIX_SEED_MAX_MB = DEFAULT_PROJECT_SOURCE_MAX_MB;

export function maxSeedBytes(context?: unknown): number {
  const mb = envNumber(context, 'REMIX_SEED_MAX_MB', DEFAULT_REMIX_SEED_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_REMIX_SEED_MAX_MB) * 1024 * 1024;
}

export class SeedTooLargeError extends Error {
  readonly statusCode = 413;
  readonly isRetryable = false;

  constructor(bytes: number, limit: number) {
    super(
      `This project is ${(bytes / 1048576).toFixed(1)}MB, over the ${Math.round(limit / 1048576)}MB remix-seed ` +
        'limit, so it cannot be published for remixing. Raise REMIX_SEED_MAX_MB to allow it.',
    );
    this.name = 'SeedTooLargeError';
  }
}

/** Store the source a remix will be cloned from. Overwrites any previous seed for this project. */
export async function putRemixSeed(projectId: string, files: SerializedFileMap, context?: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(files));

  const limit = maxSeedBytes(context);

  if (bytes.byteLength > limit) {
    throw new SeedTooLargeError(bytes.byteLength, limit);
  }

  await getObjectStore(context).put(seedKey(projectId), bytes, 'application/json');
}

/**
 * The project's seed, or null when it has none.
 *
 * A miss is the NORMAL case — an ordinary unpublished project has no seed and never will — so it is a
 * value, not an exception. Corrupt bytes are also null rather than a throw: the caller's honest
 * fallback (a clone with no files) is identical either way, and a seed is never the reason a page fails
 * to load.
 */
export async function getRemixSeed(projectId: string, context?: unknown): Promise<SerializedFileMap | null> {
  const bytes = await getObjectStore(context).get(seedKey(projectId));

  if (!bytes) {
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as SerializedFileMap;
  } catch (error) {
    logger.error(`Remix seed for ${projectId} could not be parsed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Forget the seed.
 *
 * Called when the project is deleted, and when the game is UNPUBLISHED — "make it private again" has to
 * mean the platform stops holding the source, or the §4.8 boundary is a claim rather than a behaviour.
 * An existing clone is unaffected: it has its own seed under its own key.
 */
export async function deleteRemixSeed(projectId: string, context?: unknown): Promise<void> {
  await getObjectStore(context).delete(seedKey(projectId));
}
