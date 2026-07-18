/**
 * Media task records (SPEC §4.16) — one JSON object per render, at a DERIVED key.
 *
 * `media/tasks/{projectId}/{mediaId}.json` in the ObjectStore — the seed-store rule (§4.8): the key
 * is a pure function of ids the route has already ownership-checked (`requireOwnedProject`), so there
 * is no caller-supplied storage id to validate and no second wall to forget. This is TASK STATE
 * (status, KIE task id, result URL, refund flag) — the money anchor is a `generations` row and the
 * ledger rows, exactly like an LLM generation; and the BYTES land in the user's project, never here
 * (§4.5.4b: the platform stores no project files — a result URL is a pointer to KIE's expiring copy,
 * not a copy).
 */
import type { ObjectStore } from '~/lib/.server/storage';

export type MediaTaskStatus = 'pending' | 'succeeded' | 'failed';

export interface MediaTaskRecord {
  /** `med_…` — also the id of the anchoring `generations` row and the ledger debit's generationId. */
  id: string;

  projectId: string;
  userId: string;

  kind: 'image' | 'video';
  endpoint: 'jobs' | 'veo';

  /** The canonical priced model id (aliases resolved) — what the debit was computed from. */
  model: string;

  prompt: string;
  options: Record<string, string | number | boolean>;
  durationSeconds?: number;

  /** Where the bytes belong in the PROJECT (repo-relative, e.g. `public/assets/generated/x.png`). */
  destPath: string;

  /** The raw cost and what was actually debited — echoed to the UI, authoritative in the ledger. */
  usd: number;
  credits: number;

  status: MediaTaskStatus;
  kieTaskId: string;
  resultUrl?: string;
  error?: string;

  /** Set when the failure refund has been appended — the poll path's idempotency latch. */
  refunded?: boolean;

  createdAt: string;
  updatedAt: string;
}

export function mediaTaskKey(projectId: string, mediaId: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '__');

  return `media/tasks/${safe(projectId)}/${safe(mediaId)}.json`;
}

export async function putMediaTask(store: ObjectStore, record: MediaTaskRecord): Promise<void> {
  await store.put(
    mediaTaskKey(record.projectId, record.id),
    new TextEncoder().encode(JSON.stringify(record, null, 2)),
    'application/json',
  );
}

export async function getMediaTask(
  store: ObjectStore,
  projectId: string,
  mediaId: string,
): Promise<MediaTaskRecord | null> {
  const bytes = await store.get(mediaTaskKey(projectId, mediaId));

  if (!bytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as MediaTaskRecord;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

/** Recent tasks for a project — the Media panel's history list. Newest first, bounded. */
export async function listMediaTasks(store: ObjectStore, projectId: string, limit = 20): Promise<MediaTaskRecord[]> {
  const objects = await store.list(`media/tasks/${projectId.replace(/[^a-zA-Z0-9._-]/g, '__')}/`);
  const newest = objects
    .sort((a, b) => (b.lastModified ?? b.key).localeCompare(a.lastModified ?? a.key))
    .slice(0, limit);

  const records = await Promise.all(
    newest.map(async (o) => {
      const bytes = await store.get(o.key);

      if (!bytes) {
        return null;
      }

      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as MediaTaskRecord;
      } catch {
        return null;
      }
    }),
  );

  return records
    .filter((r): r is MediaTaskRecord => Boolean(r?.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
