/**
 * The billing sweep (`_specs/no-unbilled-usage_plan.md` D3) — what bills the usage that every other path
 * can lose: a process that died mid-turn, a tab closed on a managed turn nobody reopened, an in-memory tail
 * timer that died with its process, a delete whose settlement failed.
 *
 *   (a) a `running` legacy / enhancer row older than `BILLING_SWEEP_STALE_MS` (default 15 min) whose turn is
 *       not in flight in this process → settled from its last checkpoint, `interrupted`, NEVER refunded
 *       (`settleInterruptedGeneration`). A stale `managed` row is only marked `interrupted`: its usage is
 *       billed by (b) through the session's cursor, never twice. A stale enhancer row that names a session
 *       (the managed enhancer, `_specs/managed-only_plan.md` D10) is priced from that session instead
 *       (`recoverEnhancementSession`) — it has no checkpoints to settle from;
 *   (b) every chat bound to a managed session (active within `BILLING_SWEEP_MANAGED_WINDOW_MS`, default
 *       7 days) with no turn in flight here → a cursor settlement (`agent-managed/sweep.ts`), plus every
 *       orphan a failed delete left behind (D4);
 *   (c) every pending-debit intent (D6) on a chat or orphan cursor — a charge whose cursor advanced and whose
 *       debit never landed — debited once (`settlePendingDebits`).
 *
 * Started lazily at the first request (`ensureBillingSweep`, from the same doorways as the cache warmer and
 * from `/api/me`), then every `BILLING_SWEEP_INTERVAL_MS` (default 10 min). Every run goes through
 * `keepAlive`, never two run at once, and nothing here throws.
 *
 * DECISION: the run is driven from the DOORWAY as well as from a timer. Under workerd a timer created during
 * a request does not outlive it, so a timer alone would sweep once at boot and never again; each doorway
 * call starts a run when the last one is older than the interval. The unref'd timer still covers an idle
 * Node process.
 *
 * VITEST-guarded like the cache warmer: no auto-start under a test runner (the `env()` trap — a test's
 * "empty" context resolves the developer's real credentials). Specs call `runBillingSweep` directly.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getManagedClient, getManagedEngineConfig } from '~/lib/.server/agent-managed/config';
import { recoverEnhancementSession } from '~/lib/.server/agent-managed/enhance-settle';
import { getManagedOrphanStore } from '~/lib/.server/agent-managed/orphans';
import { parseCostCursor } from '~/lib/.server/agent-managed/session-cost';
import { settlePendingDebits } from '~/lib/.server/agent-managed/settle';
import {
  orphanCursorIO,
  sweepManagedChats,
  sweepManagedOrphans,
  type ManagedSweepReport,
} from '~/lib/.server/agent-managed/sweep';
import { getChatIndex } from '~/lib/.server/projects/chat-index';
import { envNumber } from '~/lib/.server/env';
import { keepAlive } from '~/lib/.server/runtime/keep-alive';
import { createScopedLogger } from '~/utils/logger';
import { getGenerationStore } from './generations';
import { isGenerationInFlight } from './in-flight';
import { settleInterruptedGeneration } from './running-generation';

const logger = createScopedLogger('billing-sweep');

export const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_SWEEP_STALE_MS = 15 * 60_000;
export const DEFAULT_SWEEP_MANAGED_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface SweepReport {
  /** Set when this call did nothing because another sweep was already running. */
  skipped?: 'already-running';
  legacy: { settled: number; interrupted: number; credits: number; skipped: number; failed: number };
  managed: ManagedSweepReport | null;
  orphans: ManagedSweepReport | null;
  pendingDebits: number;
  ms: number;
}

let running: Promise<SweepReport> | null = null;
let lastRunAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let started = false;

function emptyReport(): SweepReport {
  return {
    legacy: { settled: 0, interrupted: 0, credits: 0, skipped: 0, failed: 0 },
    managed: null,
    orphans: null,
    pendingDebits: 0,
    ms: 0,
  };
}

/** (a) Stale `running` rows a dead process left. Never throws. */
async function sweepRunningRows(
  context: unknown,
  now: number,
  report: SweepReport['legacy'],
  client: Anthropic | null,
): Promise<void> {
  const staleMs = Math.max(60_000, envNumber(context, 'BILLING_SWEEP_STALE_MS', DEFAULT_SWEEP_STALE_MS));
  let rows;

  try {
    rows = await getGenerationStore(context).listRunning({
      staleBefore: new Date(now - staleMs).toISOString(),
      engines: ['legacy', 'enhancer', 'managed'],
    });
  } catch (error) {
    logger.error(`Could not list running generations: ${(error as Error)?.message}`);
    report.failed += 1;

    return;
  }

  for (const row of rows) {
    try {
      if (isGenerationInFlight(row.id, now)) {
        report.skipped += 1;
        continue;
      }

      if (row.engine === 'managed') {
        /* Its usage is the session's, billed by cursor in (b) — never from this row, or it bills twice. */
        await getGenerationStore(context).markStatus(row.id, 'interrupted');
        report.interrupted += 1;
        continue;
      }

      /* A managed enhancement (D10): priced from its one-shot session — there are no checkpoints. */
      if (row.engine === 'enhancer' && row.managedSessionId) {
        if (!client || !row.userId) {
          report.skipped += 1;
          continue;
        }

        const recovered = await recoverEnhancementSession({
          client,
          generationId: row.id,
          sessionId: row.managedSessionId,
          userId: row.userId,
          model: row.model,
          sessionHourUsd: getManagedEngineConfig(context).sessionHourUsd,
          markInterrupted: async () => {
            await getGenerationStore(context).markStatus(row.id, 'interrupted');
          },
          context,
        });

        if (recovered.outcome === 'settled' || recovered.outcome === 'gone') {
          report.interrupted += 1;
        } else if (recovered.outcome === 'running') {
          report.skipped += 1;
        } else {
          report.failed += 1;
        }

        if (recovered.outcome === 'settled' && recovered.credits > 0) {
          report.settled += 1;
          report.credits += recovered.credits;
        }

        continue;
      }

      const settlement = await settleInterruptedGeneration(row, context);

      report.interrupted += 1;

      if (settlement && settlement.creditsCharged > 0) {
        report.settled += 1;
        report.credits += settlement.creditsCharged;
      }
    } catch (error) {
      report.failed += 1;
      logger.error(`Could not sweep generation ${row.id}: ${(error as Error)?.message}`);
    }
  }
}

/** Does this stored cursor carry a pending debit? A cheap string check before the parse. */
function hasPendingDebit(cursor: string | null | undefined): boolean {
  return Boolean(cursor && cursor.includes('"pending"') && parseCostCursor(cursor)?.pending?.length);
}

/**
 * (c) D6's pending-debit intents: a managed cursor advanced whose debit never landed — a process that died
 * between the two, or a ledger that refused. Every chat cursor and every open orphan cursor carrying one is
 * debited through `settlePendingDebits` (serialised per chat; idempotent by generation id, migration 0029),
 * whatever the session is doing — an intent is a charge already decided, not usage still accruing. Pass (b)
 * heals the chats it settles on its own; this pass covers the rest (a session still running, a chat outside
 * the window, an orphan). Never throws; returns the debits that charged.
 */
async function sweepPendingDebitIntents(context: unknown): Promise<number> {
  let debited = 0;

  try {
    const rows = await getChatIndex(context).listWithManagedSession();

    for (const row of rows) {
      if (hasPendingDebit(row.managedSettledAt)) {
        debited += await settlePendingDebits({ projectId: row.projectId, chatId: row.id, context });
      }
    }
  } catch (error) {
    logger.error(`Could not sweep the pending debits of managed chats: ${(error as Error)?.message}`);
  }

  try {
    const store = getManagedOrphanStore(context);

    for (const orphan of await store.listOpen()) {
      if (!hasPendingDebit(orphan.cursor)) {
        continue;
      }

      debited += await settlePendingDebits({
        projectId: orphan.projectId,
        chatId: orphan.chatId,
        context,
        cursorIO: orphanCursorIO(orphan, store),
      });
    }
  } catch (error) {
    logger.error(`Could not sweep the pending debits of managed orphans: ${(error as Error)?.message}`);
  }

  return debited;
}

function managedClientOrNull(context: unknown, injected?: Anthropic): Anthropic | null {
  if (injected) {
    return injected;
  }

  try {
    return getManagedClient(context);
  } catch {
    /* No Anthropic key (or a spec with no fake): there is no managed usage this process can bill. */
    return null;
  }
}

async function sweepOnce(context: unknown, options: { now?: number; client?: Anthropic }): Promise<SweepReport> {
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const report = emptyReport();

  const client = managedClientOrNull(context, options.client);

  await sweepRunningRows(context, now, report.legacy, client);

  if (client) {
    try {
      report.managed = await sweepManagedChats({
        client,
        context,
        now,
        windowMs: envNumber(context, 'BILLING_SWEEP_MANAGED_WINDOW_MS', DEFAULT_SWEEP_MANAGED_WINDOW_MS),
      });
      report.orphans = await sweepManagedOrphans({ client, context });
    } catch (error) {
      logger.error(`The managed half of the billing sweep failed: ${(error as Error)?.message}`);
    }
  }

  try {
    report.pendingDebits = await sweepPendingDebitIntents(context);
  } catch (error) {
    logger.error(`Could not sweep pending debit intents: ${(error as Error)?.message}`);
  }

  report.ms = Date.now() - startedAt;

  const billed = report.legacy.credits + (report.managed?.credits ?? 0) + (report.orphans?.credits ?? 0);

  if (billed > 0 || report.legacy.interrupted > 0 || (report.orphans?.orphansResolved ?? 0) > 0) {
    logger.warn(
      `Billing sweep: ${report.legacy.interrupted} interrupted row(s), ${report.managed?.settled ?? 0} managed chat(s), ` +
        `${report.orphans?.orphansResolved ?? 0} orphan(s) — ${billed} credits recovered in ${report.ms}ms`,
    );
  }

  return report;
}

/**
 * Run one sweep now. Never two at once (a second call while one runs returns `skipped: 'already-running'`),
 * never throws. `now` and `client` are the specs' seams.
 */
export function runBillingSweep(
  context?: unknown,
  options: { now?: number; client?: Anthropic } = {},
): Promise<SweepReport> {
  if (running) {
    return Promise.resolve({ ...emptyReport(), skipped: 'already-running' });
  }

  lastRunAt = Date.now();

  const run = sweepOnce(context, options)
    .catch((error: unknown) => {
      logger.error(`Billing sweep failed: ${(error as Error)?.message}`);
      return emptyReport();
    })
    .finally(() => {
      running = null;
    });

  running = run;

  return keepAlive(context, run, 'billing sweep');
}

/**
 * Start the sweep lazily, and keep it running (see the module comment). Called from the request doorways;
 * cheap when nothing is due. Never throws.
 */
export function ensureBillingSweep(context?: unknown): void {
  try {
    if (process.env.VITEST || process.env.NODE_ENV === 'test') {
      return;
    }

    const interval = Math.max(60_000, envNumber(context, 'BILLING_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_INTERVAL_MS));

    if (!started) {
      started = true;
      timer = setInterval(() => void runBillingSweep(context), interval);
      (timer as { unref?: () => void }).unref?.();
      logger.info(`Billing sweep started (every ${Math.round(interval / 60_000)}m)`);
    }

    if (!running && Date.now() - lastRunAt >= interval) {
      void runBillingSweep(context);
    }
  } catch (error) {
    logger.error(`Could not start the billing sweep: ${(error as Error)?.message}`);
  }
}

/** Specs only. */
export function resetBillingSweepForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }

  started = false;
  running = null;
  lastRunAt = 0;
}
