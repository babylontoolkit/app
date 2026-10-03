/**
 * Delete settles first (`_specs/no-unbilled-usage_plan.md` D4).
 *
 * A chat's index row is the only record of its managed session and its cost cursor, and deleting a chat,
 * a project (the rows cascade) or an account (the projects cascade) removes it. Before this, the session
 * was never interrupted, settled or archived: it kept running, and a pending tail then found it unbound and
 * charged nothing. So every delete path calls this FIRST, and for each managed session bound to the doomed
 * chats it:
 *
 *   1. interrupts it if it is mid-turn, and waits (bounded, `MANAGED_SUPERSEDE_WAIT_MS`) for it to stop —
 *      the `settleStoppedTail` pattern; no browser will ever answer it again;
 *   2. settles it by cursor (`requireBoundSession`, under `<chat>_delete_<ts>`);
 *   3. archives it.
 *
 * and settles every `running` legacy / enhancer row of those chats whose turn is not in flight here —
 * regardless of staleness, since nothing will ever finish it (`settleInterruptedGeneration`).
 *
 * A settlement that cannot complete (the session read failed, the cursor write failed, no Anthropic key)
 * does NOT block the delete — the user pressed Delete, and holding that hostage to our vendor's uptime is
 * the wrong trade — but the session id and the cursor are first copied to a durable orphan record
 * (`orphans.ts`) that the sweep bills later. If even THAT write fails, the failure is alerted (critical):
 * it is the one case where the usage may be lost, and it must be visible.
 *
 * Never throws. Everything runs through `keepAlive`: the delete's request may end while this works.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { isGenerationInFlight } from '~/lib/.server/billing/in-flight';
import { settleInterruptedGeneration } from '~/lib/.server/billing/running-generation';
import { envNumber } from '~/lib/.server/env';
import { ALERT_SIGNALS, getMonitor } from '~/lib/.server/monitoring';
import { getChatIndex, type ChatIndexRow } from '~/lib/.server/projects/chat-index';
import { keepAlive } from '~/lib/.server/runtime/keep-alive';
import { createScopedLogger } from '~/utils/logger';
import { getManagedClient, getManagedEngineConfig } from './config';
import { getManagedOrphanStore } from './orphans';
import { sessionModel, SUPERSEDE_WAIT_MS } from './session-health';
import { settleManagedTurn } from './settle';

/** A per-settlement id suffix — a generation is debited at most once (migration 0029), so ids never repeat. */
const uniqueSuffix = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const logger = createScopedLogger('managed-delete-settle');

export interface DeleteSettleInput {
  /** The verified owner — billed for the sessions' usage. */
  userId: string;
  projectId: string;

  /** The chats being deleted. Absent = every chat of the project (a project or account delete). */
  chatIds?: string[];

  context?: unknown;

  /** Specs' seams. */
  client?: Anthropic;
  pollMs?: number;
}

export interface DeleteSettleReport {
  sessions: number;
  settled: number;
  credits: number;
  orphaned: number;
  legacyRows: number;
}

function isMidTurn(status: string | undefined): boolean {
  return status === 'running' || status === 'rescheduling';
}

async function chatsOf(input: DeleteSettleInput): Promise<ChatIndexRow[]> {
  const index = getChatIndex(input.context);

  if (!input.chatIds) {
    return index.listByProject(input.projectId);
  }

  const rows = await Promise.all(input.chatIds.map((id) => index.get(id).catch(() => null)));

  return rows.filter((row): row is ChatIndexRow => Boolean(row && row.projectId === input.projectId));
}

/**
 * Interrupt (if mid-turn), wait, settle, archive. `ok` when the usage is fully accounted for; otherwise
 * `cursor` is the cost cursor AS THE SETTLEMENT LEFT IT — what an orphan record must carry (defect A).
 */
async function settleSession(
  row: ChatIndexRow & { managedSessionId: string },
  input: DeleteSettleInput,
  client: Anthropic,
  report: DeleteSettleReport,
): Promise<{ ok: boolean; cursor?: string | null }> {
  const sessionId = row.managedSessionId;
  const waitMs = Math.max(0, envNumber(input.context, 'MANAGED_SUPERSEDE_WAIT_MS', SUPERSEDE_WAIT_MS));
  const deadline = Date.now() + waitMs;
  let session = await client.beta.sessions.retrieve(sessionId);

  if (isMidTurn(session?.status)) {
    await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] });

    for (;;) {
      session = await client.beta.sessions.retrieve(sessionId);

      if (!isMidTurn(session?.status) || Date.now() >= deadline) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500));
    }

    if (isMidTurn(session?.status)) {
      logger.warn(
        `Session ${sessionId}: still ${session.status} after the delete's interrupt — settling what has landed`,
      );
    }
  }

  const config = getManagedEngineConfig(input.context);
  const settled = await settleManagedTurn({
    client,
    sessionId,
    projectId: row.projectId,
    chatId: row.id,
    userId: input.userId,
    generationId: `${row.id}_delete_${uniqueSuffix()}`,
    model: sessionModel(session) ?? config.model,
    statusKind: 'edit',
    sessionHourUsd: config.sessionHourUsd,
    context: input.context,
    anchorWhenEmpty: false,
    requireBoundSession: true,
  });

  if (settled.settlement && settled.settlement.creditsCharged > 0) {
    report.settled += 1;
    report.credits += settled.settlement.creditsCharged;
  }

  /* Its chat moved to another session meanwhile: that session's owner settles it — nothing to keep. */
  if (settled.unbound) {
    return { ok: true };
  }

  /*
   * Still mid-turn after the wait: usage may still land after this settlement — keep it for the sweep, with
   * the cursor this settlement WROTE, never the one read before it (or the sweep re-bills what was just
   * charged — verifier defect A).
   */
  if (!settled.complete || isMidTurn(session?.status)) {
    return { ok: false, cursor: settled.cursor };
  }

  await client.beta.sessions.archive(sessionId).catch((error: unknown) => {
    logger.warn(`Session ${sessionId}: could not archive it on delete: ${(error as Error)?.message}`);
  });

  return { ok: true };
}

async function recordOrphan(
  row: ChatIndexRow & { managedSessionId: string },
  input: DeleteSettleInput,
  why: string,
  cursor: string | null,
) {
  try {
    const model = (() => {
      try {
        return getManagedEngineConfig(input.context).model;
      } catch {
        return 'unknown';
      }
    })();

    await getManagedOrphanStore(input.context).record({
      userId: input.userId,
      projectId: row.projectId,
      chatId: row.id,
      sessionId: row.managedSessionId,
      cursor,
      model,
      reason: why.slice(0, 500),
    });
    logger.warn(
      `Chat ${row.id}: its session ${row.managedSessionId} could not be settled on delete (${why}) — kept for the sweep`,
    );
  } catch (error) {
    logger.error(
      `Chat ${row.id}: could not record its unsettled session ${row.managedSessionId}: ${(error as Error)?.message}`,
    );
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Chat ${row.id} was deleted with managed session ${row.managedSessionId} UNSETTLED and no orphan record — ` +
        `its unbilled usage may be lost (${why}; ${(error as Error)?.message})`,
      {
        severity: 'critical',
        scope: 'managed-delete-settle',
        userId: input.userId,
        tags: { sessionId: row.managedSessionId },
      },
    );
  }
}

async function settleNow(input: DeleteSettleInput): Promise<DeleteSettleReport> {
  const report: DeleteSettleReport = { sessions: 0, settled: 0, credits: 0, orphaned: 0, legacyRows: 0 };
  let rows: ChatIndexRow[] = [];

  try {
    rows = await chatsOf(input);
  } catch (error) {
    logger.error(`Project ${input.projectId}: could not list the chats being deleted: ${(error as Error)?.message}`);
  }

  const managed = rows.filter((row): row is ChatIndexRow & { managedSessionId: string } =>
    Boolean(row.managedSessionId),
  );

  report.sessions = managed.length;

  if (managed.length > 0) {
    let client: Anthropic | null = input.client ?? null;
    let clientError = '';

    if (!client) {
      try {
        client = getManagedClient(input.context);
      } catch (error) {
        clientError = (error as Error)?.message ?? String(error);
      }
    }

    for (const row of managed) {
      let ok = false;
      let why = clientError || 'the settlement did not complete';

      /* The cursor before any settlement ran — correct only while nothing has been settled here. */
      let cursor: string | null = row.managedSettledAt ?? null;

      if (client) {
        try {
          const result = await settleSession(row, input, client, report);

          ok = result.ok;

          if (result.cursor !== undefined) {
            cursor = result.cursor;
          }

          if (!ok) {
            why = 'the settlement did not complete, or the session was still running after the interrupt';
          }
        } catch (error) {
          why = (error as Error)?.message ?? String(error);
        }
      }

      if (!ok) {
        report.orphaned += 1;
        await recordOrphan(row, input, why, cursor);
      }
    }
  }

  /* Legacy / enhancer rows of these chats that nothing will ever finish. */
  try {
    const store = getGenerationStore(input.context);
    const running = await store.listRunning({
      engines: ['legacy', 'enhancer'],
      ...(input.chatIds ? { chatIds: input.chatIds } : { projectId: input.projectId }),
    });

    for (const row of running) {
      if (isGenerationInFlight(row.id)) {
        continue;
      }

      await settleInterruptedGeneration(row, input.context);
      report.legacyRows += 1;
    }
  } catch (error) {
    logger.error(
      `Project ${input.projectId}: could not settle running legacy rows on delete: ${(error as Error)?.message}`,
    );
  }

  return report;
}

/** Settle every session and running row the delete is about to orphan. Never throws. */
export function settleBeforeDelete(input: DeleteSettleInput): Promise<DeleteSettleReport> {
  return keepAlive(
    input.context,
    settleNow(input).catch((error: unknown) => {
      logger.error(`Settle-before-delete failed for project ${input.projectId}: ${(error as Error)?.message}`);
      return { sessions: 0, settled: 0, credits: 0, orphaned: 0, legacyRows: 0 };
    }),
    `settle before delete ${input.projectId}`,
  );
}
