/**
 * The managed half of the billing sweep (`_specs/no-unbilled-usage_plan.md` D3 (b), D4).
 *
 * A managed chat's usage is billed by its cost cursor, at the end of each request and by in-memory tails
 * (a detach's, a Stop's). In-memory work dies with the process, and a chat nobody reopens is never settled
 * again — so the sweep settles every chat bound to a session, and every orphan a failed delete left
 * behind. Both are cursor settlements (`settleManagedTurn`), so a session whose cost equals its cursor
 * charges nothing and a second sweep is free; both are serialised per chat with every other settlement.
 *
 * Skipped, and why:
 *   - a chat with a turn in flight in THIS process (`in-flight.ts`) or a detached turn's tail still
 *     waiting — billing part of a live turn under the sweep's id would put it beyond that turn's refund;
 *   - a session that is still `running` / `rescheduling` — it is mid-turn somewhere; it is settled when
 *     it stops (by its turn, its tail, or a later sweep).
 *
 * Never throws: every chat is settled on its own, and a failure is counted and logged, never fatal.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { isManagedTurnInFlight } from '~/lib/.server/billing/in-flight';
import { getMonitor } from '~/lib/.server/monitoring';
import { getChatIndex } from '~/lib/.server/projects/chat-index';
import { getProjectStore } from '~/lib/.server/projects/store';
import { createScopedLogger } from '~/utils/logger';
import { getManagedEngineConfig } from './config';
import { getManagedOrphanStore, type ManagedOrphan, type ManagedOrphanStore } from './orphans';
import { sessionModel } from './session-health';
import {
  hasPendingDetachTail,
  settleManagedTurn,
  settlePendingDebitsDetailed,
  type SettlementCursorIO,
} from './settle';

/** A per-settlement id suffix — a generation is debited at most once (migration 0029), so ids never repeat. */
const uniqueSuffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const logger = createScopedLogger('managed-sweep');

/** The ledger's word for a swept turn — the stop tail's choice, so the credits panel names it as an edit. */
const SWEEP_STATUS_KIND = 'edit';

export interface ManagedSweepReport {
  chats: number;
  settled: number;
  credits: number;
  skipped: number;
  failed: number;
  orphansResolved: number;
}

const emptyReport = (): ManagedSweepReport => ({
  chats: 0,
  settled: 0,
  credits: 0,
  skipped: 0,
  failed: 0,
  orphansResolved: 0,
});

/** An HTTP 404 from the SDK — the session no longer exists, so what it had not settled cannot be billed. */
function isGone(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

function isMidTurn(status: string | undefined): boolean {
  return status === 'running' || status === 'rescheduling';
}

export async function sweepManagedChats(input: {
  client: Anthropic;
  context?: unknown;
  now: number;
  windowMs: number;
}): Promise<ManagedSweepReport> {
  const report = emptyReport();
  const config = getManagedEngineConfig(input.context);
  let rows;

  try {
    rows = await getChatIndex(input.context).listWithManagedSession({
      updatedSince: new Date(input.now - input.windowMs).toISOString(),
    });
  } catch (error) {
    logger.error(`Could not list chats with a managed session: ${(error as Error)?.message}`);
    report.failed += 1;

    return report;
  }

  report.chats = rows.length;

  for (const row of rows) {
    try {
      if (isManagedTurnInFlight(row.id, input.now) || hasPendingDetachTail(row.projectId, row.id)) {
        report.skipped += 1;
        continue;
      }

      const userId = row.userId ?? (await getProjectStore(input.context).get(row.projectId))?.userId;

      if (!userId) {
        logger.warn(`Chat ${row.id}: its project ${row.projectId} names no owner — cannot bill its session`);
        report.skipped += 1;
        continue;
      }

      const session = await input.client.beta.sessions.retrieve(row.managedSessionId);

      if (isMidTurn(session?.status)) {
        report.skipped += 1;
        continue;
      }

      const settled = await settleManagedTurn({
        client: input.client,
        sessionId: row.managedSessionId,
        projectId: row.projectId,
        chatId: row.id,
        userId,
        generationId: `${row.id}_sweep_${uniqueSuffix()}`,
        model: sessionModel(session) ?? config.model,
        statusKind: SWEEP_STATUS_KIND,
        sessionHourUsd: config.sessionHourUsd,
        context: input.context,
        anchorWhenEmpty: false,
        requireBoundSession: true,
      });

      if (!settled.complete) {
        report.failed += 1;
      }

      if (settled.settlement && settled.settlement.creditsCharged > 0) {
        report.settled += 1;
        report.credits += settled.settlement.creditsCharged;
        logger.warn(
          `Chat ${row.id}: the sweep billed ${settled.settlement.creditsCharged} credits nobody had settled ` +
            `(session ${row.managedSessionId})`,
        );
      }
    } catch (error) {
      report.failed += 1;
      logger.error(`Chat ${row.id}: the sweep could not settle its session: ${(error as Error)?.message}`);
    }
  }

  return report;
}

/** An orphan's cursor lives on its own record — the chat row that held it may be gone. */
export function orphanCursorIO(orphan: ManagedOrphan, store: ManagedOrphanStore): SettlementCursorIO {
  let cursor = orphan.cursor;

  return {
    bound: async () => orphan.sessionId,
    get: async () => cursor,
    set: async (next) => {
      await store.setCursor(orphan.id, next);
      cursor = next;
    },
  };
}

/** Settle one orphan (D4). Resolves it once its usage is accounted for. Never throws. */
async function settleOrphan(
  orphan: ManagedOrphan,
  input: { client: Anthropic; context?: unknown },
  report: ManagedSweepReport,
): Promise<void> {
  const store = getManagedOrphanStore(input.context);

  try {
    let session;

    try {
      session = await input.client.beta.sessions.retrieve(orphan.sessionId);
    } catch (error) {
      if (!isGone(error)) {
        throw error;
      }

      /*
       * Verifier money defect 1: the session is gone, but an intent on the orphan's cursor is a DECIDED charge
       * that needs no session — debit it before the record is resolved, and keep the record open if it does
       * not land, so the next sweep retries.
       */
      const pending = await settlePendingDebitsDetailed({
        projectId: orphan.projectId,
        chatId: orphan.chatId,
        context: input.context,
        cursorIO: orphanCursorIO(orphan, store),
      });

      if (pending.remaining > 0) {
        logger.error(
          `Orphaned session ${orphan.sessionId} is gone and a debit its cursor counts did not land — kept for the next sweep`,
        );
        report.failed += 1;

        return;
      }

      logger.error(
        `Orphaned session ${orphan.sessionId} (chat ${orphan.chatId}) no longer exists — what it had not settled ` +
          'cannot be billed',
      );
      getMonitor(input.context).captureMessage(
        `Managed session ${orphan.sessionId} vanished before its orphaned usage could be billed`,
        { scope: 'managed-orphan', level: 'warning', userId: orphan.userId },
      );
      await store.resolve(orphan.id);
      report.orphansResolved += 1;

      return;
    }

    if (isMidTurn(session?.status)) {
      /* Its chat is gone, so no browser will ever answer it: stop it; a later sweep settles the rest. */
      await input.client.beta.sessions.events.send(orphan.sessionId, { events: [{ type: 'user.interrupt' }] });
      report.skipped += 1;

      return;
    }

    const config = getManagedEngineConfig(input.context);
    const settled = await settleManagedTurn({
      client: input.client,
      sessionId: orphan.sessionId,
      projectId: orphan.projectId,
      chatId: orphan.chatId,
      userId: orphan.userId,
      generationId: `${orphan.chatId}_orphan_${uniqueSuffix()}`,
      model: sessionModel(session) ?? orphan.model,
      statusKind: SWEEP_STATUS_KIND,
      sessionHourUsd: config.sessionHourUsd,
      context: input.context,
      anchorWhenEmpty: false,
      requireBoundSession: true,
      cursorIO: orphanCursorIO(orphan, store),
    });

    if (!settled.complete) {
      report.failed += 1;
      return;
    }

    if (settled.settlement && settled.settlement.creditsCharged > 0) {
      report.settled += 1;
      report.credits += settled.settlement.creditsCharged;
    }

    await store.resolve(orphan.id);
    report.orphansResolved += 1;

    await input.client.beta.sessions.archive(orphan.sessionId).catch((error: unknown) => {
      logger.warn(`Orphaned session ${orphan.sessionId}: could not archive it: ${(error as Error)?.message}`);
    });
  } catch (error) {
    report.failed += 1;
    logger.error(`Orphan ${orphan.id}: the sweep could not settle it: ${(error as Error)?.message}`);
  }
}

export async function sweepManagedOrphans(input: {
  client: Anthropic;
  context?: unknown;
}): Promise<ManagedSweepReport> {
  const report = emptyReport();
  let orphans: ManagedOrphan[];

  try {
    orphans = await getManagedOrphanStore(input.context).listOpen();
  } catch (error) {
    logger.error(`Could not list managed billing orphans: ${(error as Error)?.message}`);
    report.failed += 1;

    return report;
  }

  for (const orphan of orphans) {
    await settleOrphan(orphan, input, report);
  }

  return report;
}
