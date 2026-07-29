/**
 * Append-only sandbox VM lifecycle marks (plan T12, SPEC §4.6, `spec/sandbox-codesandbox.md`).
 *
 * ## Why this exists
 *
 * The launch decision (owner, 2026-07-27) was to bake VM compute into `CREDIT_MARGIN` rather than
 * meter it per user. T11 turned that into a tested margin floor with two inputs: a MEASURED
 * `SANDBOX_VM_USD_PER_HOUR` and an ESTIMATED `SANDBOX_EST_VM_HOURS_PER_KCREDIT`. The second one is a
 * guess, and a guess that nothing measures is just a belief that gets more expensive the longer it is
 * wrong. These marks are what turn it into a number — and what decides whether per-user metering ever
 * needs to exist at all.
 *
 * ## The rules, each of which fails silently if broken
 *
 * - **Append-only.** A mark records a moment; VM-hours are DERIVED by pairing them
 *   (`admin/vm-report.ts`), never accumulated into a mutable counter. This is the credit ledger's
 *   rule for the credit ledger's reason: a counter loses updates under concurrency and can never
 *   answer "where did the hours go", which is the only question this data is collected to answer.
 * - **Best-effort, always.** Every write goes through `recordSandboxMark`, which cannot throw. A VM
 *   opens on the path a user is waiting on; failing their project open because our own bookkeeping
 *   write failed would be strictly worse than the missing row. A failure is LOGGED and monitored,
 *   never swallowed — an accounting stream that silently stopped reads exactly like an idle platform.
 * - **A mark carries no credential.** `sandboxId` is a pointer, the same status it holds on the
 *   project row; reaching a sandbox still needs a server-minted scoped session (§5).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';
import { getMonitor } from '~/lib/.server/monitoring';

const logger = createScopedLogger('sandbox-usage');

/**
 * What happened to a VM.
 *
 * `create` and `resume` OPEN a running interval; `hibernate` and `delete` CLOSE one. That pairing is
 * the whole schema — everything the report computes falls out of it.
 */
export type SandboxLifecycleEvent = 'create' | 'resume' | 'hibernate' | 'delete';

export interface SandboxMark {
  event: SandboxLifecycleEvent;
  sandboxId: string;

  /** Which project's VM. Absent only if a caller could not say — the report still counts the hours. */
  projectId?: string;

  /** Which account the time is attributable to. Absent marks aggregate under `unattributed`. */
  userId?: string;

  /** Epoch-ms of the event. */
  at: number;
}

export interface SandboxUsageStore {
  append(mark: SandboxMark): Promise<void>;

  /** Most recent marks first. The report sorts for itself — order here is only about the window. */
  list(limit?: number): Promise<SandboxMark[]>;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem (local mode)
 * ---------------------------------------------------------------------------------------------
 */

/**
 * JSONL, appended.
 *
 * A line per mark rather than a file per mark: marks arrive on every project open, and a directory
 * that grows a file per open is a listing cost paid on every dashboard load. Append is also the one
 * write shape that cannot lose a concurrent neighbour's row under `O_APPEND`.
 */
export class FsSandboxUsageStore implements SandboxUsageStore {
  private readonly _file: string;

  constructor(file?: string) {
    this._file = file ?? path.join(platformDataDir(), 'sandbox-usage', 'marks.jsonl');
  }

  async append(mark: SandboxMark): Promise<void> {
    await fs.mkdir(path.dirname(this._file), { recursive: true });
    await fs.appendFile(this._file, `${JSON.stringify(mark)}\n`, 'utf8');
  }

  async list(limit = 5000): Promise<SandboxMark[]> {
    let raw: string;

    try {
      raw = await fs.readFile(this._file, 'utf8');
    } catch {
      // Nothing has ever run. An empty report is the correct answer, not an error.
      return [];
    }

    const marks: SandboxMark[] = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }

      try {
        marks.push(JSON.parse(line) as SandboxMark);
      } catch {
        // A torn line at the tail of an append-only file is not worth failing a listing over.
      }
    }

    return marks.sort((a, b) => b.at - a.at).slice(0, limit);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Postgres (production)
 * ---------------------------------------------------------------------------------------------
 */

export class SupabaseSandboxUsageStore implements SandboxUsageStore {
  constructor(private readonly _context?: unknown) {}

  async append(mark: SandboxMark): Promise<void> {
    const db = await createAdminClient(this._context);

    const { error } = await db.from('sandbox_lifecycle_marks').insert({
      user_id: mark.userId ?? null,
      project_id: mark.projectId ?? null,
      sandbox_id: mark.sandboxId,
      event: mark.event,
      at: new Date(mark.at).toISOString(),
    });

    if (error) {
      throw new Error(`Sandbox mark insert failed: ${error.message}`);
    }
  }

  async list(limit = 5000): Promise<SandboxMark[]> {
    const db = await createAdminClient(this._context);

    const { data, error } = await db
      .from('sandbox_lifecycle_marks')
      .select()
      .order('at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Sandbox mark read failed: ${error.message}`);
    }

    return (data ?? []).map(
      (row: any): SandboxMark => ({
        event: row.event,
        sandboxId: row.sandbox_id,
        projectId: row.project_id ?? undefined,
        userId: row.user_id ?? undefined,
        at: new Date(row.at).getTime(),
      }),
    );
  }
}

/**
 * How long a mark write may hold up the request that produced it.
 *
 * Generous — a mark is one insert — but finite. See `recordSandboxMark`.
 */
export const MARK_WRITE_DEADLINE_MS = 2_000;

let _store: SandboxUsageStore | undefined;

export function getSandboxUsageStore(context?: unknown): SandboxUsageStore {
  if (!_store) {
    _store = isSupabaseConfigured(context) ? new SupabaseSandboxUsageStore(context) : new FsSandboxUsageStore();
  }

  return _store;
}

/** Test seam. */
export function setSandboxUsageStore(store: SandboxUsageStore | undefined) {
  _store = store;
}

/**
 * Record a mark. **This is the only way marks are written, and it never throws.**
 *
 * Every caller sits on a path that spends money or opens a user's project. Bookkeeping that can fail
 * either of those is not bookkeeping, it is a new failure mode — so the contract is inverted from the
 * generation row (which throws loudly, because the ledger's foreign key depends on it): a missing
 * mark costs accuracy in one report, and nothing else.
 *
 * It is still reported. A stream of marks that silently stopped is indistinguishable from a platform
 * nobody is using, which is the most flattering possible way for a metric to break.
 */
export async function recordSandboxMark(mark: SandboxMark, context?: unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    /*
     * 🔴 The deadline is not about failure — the catch below handles that. It is about SLOWNESS.
     *
     * Every emission site sits on a path a user is waiting on (opening a project, deleting one), and
     * a store that HANGS rather than rejects would stall that path indefinitely. "Cannot throw" is
     * not the same guarantee as "cannot block", and the same distinction is already written into
     * `vm-cap.ts`'s own deadline. Abandoning the wait does not abandon the write: whatever is in
     * flight still lands, and the worst case is a mark that arrives after we stopped caring.
     */
    const timedOut = await Promise.race([
      getSandboxUsageStore(context)
        .append(mark)
        .then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), MARK_WRITE_DEADLINE_MS);
      }),
    ]);

    /*
     * A timeout is REPORTED, for the same reason a rejection is. Resolving silently would make a store
     * that HANGS the one failure mode this module cannot see — and the doc comment above promises the
     * opposite. A hang is also the worse of the two: a rejection is usually one bad write, a hang is
     * every request from here on paying two seconds for nothing.
     */
    if (timedOut) {
      logger.warn(
        `Sandbox ${mark.event} mark for ${mark.sandboxId} did not land within ${MARK_WRITE_DEADLINE_MS}ms — abandoning the wait.`,
      );

      getMonitor(context).captureException(new Error('Sandbox lifecycle mark write timed out'), {
        scope: 'sandbox.usage-mark',
        userId: mark.userId,
        tags: { sandboxId: mark.sandboxId, event: mark.event, projectId: mark.projectId, timedOut: true },
      });
    }
  } catch (error) {
    logger.warn(`Could not record sandbox ${mark.event} mark for ${mark.sandboxId}: ${(error as Error)?.message}`);

    getMonitor(context).captureException(error, {
      scope: 'sandbox.usage-mark',
      userId: mark.userId,
      tags: { sandboxId: mark.sandboxId, event: mark.event, projectId: mark.projectId },
    });
  } finally {
    clearTimeout(timer);
  }
}
