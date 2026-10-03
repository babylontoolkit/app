/**
 * The billing sweep (`_specs/no-unbilled-usage_plan.md` D3) — what bills the usage that every other path
 * can lose: a process that died mid-turn, a tab closed on a managed turn nobody reopened, an in-memory tail
 * timer that died with its process, a delete whose settlement failed.
 *
 *   (a) a `running` legacy / enhancer row older than `BILLING_SWEEP_STALE_MS` (default 15 min) whose turn is
 *       not in flight in this process → settled from its last checkpoint, `interrupted`, NEVER refunded
 *       (`settleInterruptedGeneration`). A stale `managed` row is only marked `interrupted`: its usage is
 *       billed by (b) through the session's cursor, never twice;
 *   (b) every chat bound to a managed session (active within `BILLING_SWEEP_MANAGED_WINDOW_MS`, default
 *       7 days) with no turn in flight here → a cursor settlement (`agent-managed/sweep.ts`), plus every
 *       orphan a failed delete left behind (D4);
 *   (c) pending-debit intents (D6) — a named hook, filled by T6.
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
import { getManagedClient } from '~/lib/.server/agent-managed/config';
import { sweepManagedChats, sweepManagedOrphans, type ManagedSweepReport } from '~/lib/.server/agent-managed/sweep';
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
async function sweepRunningRows(context: unknown, now: number, report: SweepReport['legacy']): Promise<void> {
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

/**
 * (c) D6's pending-debit intents: a managed cursor advanced whose debit never landed (a crash between the
 * two). T6 fills this; until then it reports nothing. Kept here, named, so the sweep has ONE place where
 * every unbilled-usage class is collected.
 */
async function sweepPendingDebitIntents(_context: unknown): Promise<number> {
  return 0;
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

  await sweepRunningRows(context, now, report.legacy);

  const client = managedClientOrNull(context, options.client);

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
