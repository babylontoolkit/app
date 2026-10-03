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
import { advanceOpenOrphan, getManagedOrphanStore } from './orphans';
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

  /**
   * Settle the managed sessions only, leaving the chats' legacy / enhancer rows to the sweep. A RE-HOME
   * (`message-store.ts` `settleBeforeRehome`) moves a chat rather than deleting it: its legacy turns still
   * belong to it and may be in flight in another request.
   */
  skipLegacyRows?: boolean;

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

  /**
   * Sessions (or chat lists) whose handling is NOT confirmed — the chats could not be read, or a session
   * could neither be settled completely nor kept in a CONFIRMED orphan write (R1-b). A caller about to erase
   * the chat rows must refuse while this is non-zero (`assertDeleteSettled`): the rows are the only record.
   */
  unconfirmed: number;
}

/** A delete or move refused because a managed session's billing could not be secured first (retryable). */
export class ManagedSettlementUnconfirmedError extends Error {
  readonly statusCode = 503;
  readonly isRetryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'ManagedSettlementUnconfirmedError';
  }
}

/**
 * Refuse (throw, retryable) unless every session the delete or move would erase was handled — settled in
 * full, or kept in a confirmed orphan record. DECISION (R1-b): an erase that cannot prove the usage survives
 * it is refused rather than proceeding; the user retries in a moment.
 */
export function assertDeleteSettled(report: DeleteSettleReport, what: string): void {
  if (report.unconfirmed > 0) {
    throw new ManagedSettlementUnconfirmedError(
      `${what} could not be completed right now: an agent session's usage could not be saved for billing first. ` +
        'Nothing was deleted — please try again in a moment.',
    );
  }
}

function isMidTurn(status: string | undefined): boolean {
  return status === 'running' || status === 'rescheduling';
}

/** The chats being erased. THROWS on a read failure — a dropped row is a session nobody settles (R1-b). */
async function chatsOf(input: DeleteSettleInput): Promise<ChatIndexRow[]> {
  const index = getChatIndex(input.context);

  if (!input.chatIds) {
    return index.listByProject(input.projectId);
  }

  const rows = await Promise.all(input.chatIds.map((id) => index.get(id)));

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

  /*
   * An idle open orphan of this session (a past failed release left it beside the bound chat) must not be swept
   * later from a cursor older than what was just billed (no-unbilled-usage R2). An advance that fails (after
   * its retry) is treated as an incomplete settlement: the caller then records an orphan, and `record` MERGES
   * this cursor into the open one — the same advance by the other door; if that fails too the erase is refused.
   */
  if (!(await advanceOpenOrphan(input.context, sessionId, settled.cursor))) {
    return { ok: false, cursor: settled.cursor ?? null };
  }

  return { ok: true };
}

async function recordOrphan(
  row: ChatIndexRow & { managedSessionId: string },
  input: DeleteSettleInput,
  why: string,
  cursor: string | null,
): Promise<boolean> {
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

    return true;
  } catch (error) {
    logger.error(
      `Chat ${row.id}: could not record its unsettled session ${row.managedSessionId}: ${(error as Error)?.message}`,
    );
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Chat ${row.id}: managed session ${row.managedSessionId} could not be settled NOR kept in an orphan record — ` +
        `the delete or move is refused until it can be (${why}; ${(error as Error)?.message})`,
      {
        severity: 'critical',
        scope: 'managed-delete-settle',
        userId: input.userId,
        tags: { sessionId: row.managedSessionId },
      },
    );

    return false;
  }
}

async function settleNow(input: DeleteSettleInput): Promise<DeleteSettleReport> {
  const report: DeleteSettleReport = {
    sessions: 0,
    settled: 0,
    credits: 0,
    orphaned: 0,
    legacyRows: 0,
    unconfirmed: 0,
  };
  let rows: ChatIndexRow[] = [];

  try {
    rows = await chatsOf(input);
  } catch (error) {
    /* Unknown chats are unknown sessions: the erase must not proceed on them (R1-b). */
    report.unconfirmed += 1;
    logger.error(`Project ${input.projectId}: could not read the chats being deleted: ${(error as Error)?.message}`);
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

        if (!(await recordOrphan(row, input, why, cursor))) {
          report.unconfirmed += 1;
        }
      }
    }
  }

  /* Legacy / enhancer rows of these chats that nothing will ever finish. */
  if (input.skipLegacyRows) {
    return report;
  }

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

/**
 * Settle every session and running row the delete is about to orphan. Never throws — the caller decides from
 * the report (`assertDeleteSettled`) whether the erase may proceed.
 */
export function settleBeforeDelete(input: DeleteSettleInput): Promise<DeleteSettleReport> {
  return keepAlive(
    input.context,
    settleNow(input).catch((error: unknown) => {
      logger.error(`Settle-before-delete failed for project ${input.projectId}: ${(error as Error)?.message}`);
      return { sessions: 0, settled: 0, credits: 0, orphaned: 0, legacyRows: 0, unconfirmed: 1 };
    }),
    `settle before delete ${input.projectId}`,
  );
}
