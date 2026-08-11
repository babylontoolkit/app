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
import type { MediaEndpoint, MediaProviderName } from './provider';

export type MediaTaskStatus = 'pending' | 'succeeded' | 'failed';

export interface MediaTaskRecord {
  /** `med_…` — also the id of the anchoring `generations` row and the ledger debit's generationId. */
  id: string;

  projectId: string;
  userId: string;

  kind: 'image' | 'video';

  /**
   * 🔴 WHICH GATEWAY IS RENDERING THIS — stamped at creation, read by every later poll and download.
   *
   * `MEDIA_PROVIDER` is an operator switch and a render takes minutes, so "who is serving media" is
   * not a stable fact for the life of a task. Resolving it from CURRENT config at poll time would
   * ask the wrong gateway about a task id it has never issued: the render never completes, the
   * failure path eventually refunds art that may have rendered perfectly, and nothing throws.
   *
   * ⚠️ OPTIONAL because records written before this field existed have none. They resolve to `'KIE'`
   * (`mediaProviderOf`) — the only gateway that could have written them.
   */
  provider?: MediaProviderName;

  endpoint: MediaEndpoint;

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

  /**
   * The KIE task being polled RIGHT NOW — stage 1's render task, then stage 2's cut-out task. One
   * field, because the poll path only ever asks about the current stage; `renderUrl` keeps stage 1's
   * output so the chaining is auditable after the fact.
   */
  kieTaskId: string;
  resultUrl?: string;
  error?: string;

  /**
   * This image was PAID FOR as transparent, so it owes a `recraft/remove-background` pass (§4.16).
   * Stored, never re-derived: the delivery decision reads the price list and the prompt, and a task
   * that was billed for two stages must run two stages even if either changes mid-render.
   */
  cutout?: boolean;

  /** Which stage `kieTaskId` refers to. Absent on an ordinary single-stage task. */
  stage?: 'render' | 'cutout';

  /** Stage 1's (opaque) render — the input the cut-out pass was given. Never delivered to the project. */
  renderUrl?: string;

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
