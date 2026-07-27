/**
 * Which sandbox belongs to whom (SPEC §4.5.3, §8, `spec/sandbox-codesandbox.md`).
 *
 * 🔴 **The client may never supply a sandbox id.** A `SandboxSession` is a bearer credential for one
 * sandbox, so an endpoint that minted one for a caller-supplied id would hand any account a live
 * shell inside any other account's project — read their code, read their `.env`, run commands. That
 * is the exact failure the old snapshot route had (`assertSnapshotBelongsTo` existed because the id
 * came from the client), and §4.5.4b's answer is the one used here: **derive the key from the
 * verified identity so there is no id to supply.**
 *
 * ## Why this is keyed by USER and not by PROJECT (a deliberate, temporary stopgap)
 *
 * Per-project sandboxes are the correct end state and need a `sandbox_id` column on the project
 * record. That migration is not written yet. Rather than block a first live run on it — or, far
 * worse, invent a caller-supplied id "just for testing" — this keys one sandbox per user, in object
 * storage, exactly like the §4.5.4c working copy.
 *
 * The limitation is real and worth stating plainly: **a user's projects share one sandbox**, so
 * opening a second project overwrites the first one's files in the VM. That is acceptable only
 * because the code lives in the user's repo and the working copy (§4.5.4b/c), and because this is a
 * bring-up path rather than the shipping design. It becomes wrong the moment more than one project
 * is open, which is why the migration is the next step and not an optional follow-up.
 *
 * What it does NOT compromise is authorization: the key is a pure function of a verified user id
 * today, and becomes a pure function of an owned project id tomorrow. Neither is reachable from the
 * wire.
 */
import { getObjectStore } from '~/lib/.server/storage';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('sandbox-registry');

/**
 * One record per user, at a DERIVED key.
 *
 * Its own prefix so a future account deletion can sweep it alongside `working/` and `seeds/` —
 * bytes must never outlive the record that named them.
 */
export function sandboxRecordKey(userId: string): string {
  return `sandboxes/${userId}.json`;
}

export interface SandboxRecord {
  sandboxId: string;

  /** For diagnostics only ("this VM has been around since…"). Never used to order or expire anything. */
  createdAt: string;
}

/** The user's sandbox, or null when they have never had one. A miss is a value, not an exception. */
export async function getSandboxRecord(userId: string, context?: unknown): Promise<SandboxRecord | null> {
  const bytes = await getObjectStore(context).get(sandboxRecordKey(userId));

  if (!bytes) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SandboxRecord;

    /*
     * A record with no usable id is treated as absent rather than passed on. `decideSandboxStart`
     * reads a missing id as "create", which is the safe direction — the alternative is calling the
     * provider with `undefined` and reporting an outage.
     */
    return typeof parsed?.sandboxId === 'string' && parsed.sandboxId ? parsed : null;
  } catch (error) {
    logger.error(`Sandbox record for ${userId} could not be parsed: ${(error as Error).message}`);
    return null;
  }
}

export async function putSandboxRecord(userId: string, record: SandboxRecord, context?: unknown): Promise<void> {
  await getObjectStore(context).put(
    sandboxRecordKey(userId),
    new TextEncoder().encode(JSON.stringify(record)),
    'application/json',
  );
}

export async function deleteSandboxRecord(userId: string, context?: unknown): Promise<void> {
  await getObjectStore(context).delete(sandboxRecordKey(userId));
}
