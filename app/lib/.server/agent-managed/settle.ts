/**
 * Settling a managed turn (`_specs/managed-agents-engine_plan.md` D7, D13, T7).
 *
 * Every request that ran a managed turn settles ONCE, at its end — a finished turn, a detached one (a
 * closed tab), a Stop, a failure, a budget pause — and each settlement charges exactly the session's
 * usage events after the chat's cursor (`usage.ts`), plus the active session-hours added since, then
 * advances the cursor. So a turn split across a closed tab and a reopened one is billed once in total,
 * and a settlement that finds nothing new charges nothing.
 *
 * ## Order: cursor first, then the debit
 *
 * The cursor is advanced BEFORE `settleGeneration` writes the debit. If the debit then fails,
 * `settleGeneration` alerts (`LEDGER_INTEGRITY`) and the usage goes unbilled — the platform's loss, and
 * visible. The other order risks the mirror image: a debit written, the cursor write lost, and the same
 * usage charged AGAIN on the next settlement — the user's loss, silently. If the cursor write itself
 * fails nothing is charged now and the usage stays unsettled for the next settlement.
 *
 * Settlements of one chat are SERIALISED in process: a detached request settling while the reopened tab
 * settles would both read the same cursor and both charge the same events. (The relay registry is
 * in-process too, so the engine runs on ONE instance — `--scale 1` — like today's tool relay.)
 *
 * Never throws: a settlement can never refuse (§4.6), and a generation the user watched finish must not
 * report an error because our bookkeeping hiccuped.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { refundGeneration, settleGeneration, type Settlement } from '~/lib/.server/billing/gate';
import type { GenerationUsage } from '~/lib/.server/agent/step-usage';
import { createScopedLogger } from '~/utils/logger';
import { getManagedSettledAt, releaseManagedSession, setManagedSettledAt } from './sessions';
import { getMonitor } from '~/lib/.server/monitoring';
import {
  emptyUsage,
  parseCursor,
  serializeCursor,
  sessionHoursCostUsd,
  unsettledUsage,
  type UsageEventLike,
} from './usage';

const logger = createScopedLogger('managed-settle');

/** How far back of the cursor the listing reaches — `created_at` and `processed_at` are not one clock. */
const LIST_SLACK_MS = 5 * 60_000;

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier settlement of the same chat has finished. */
function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);

  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });

  return next;
}

export interface SettleManagedInput {
  client: Anthropic;
  sessionId: string;
  projectId: string;
  chatId: string;
  userId: string;
  generationId: string;
  model: string;
  statusKind: string;
  sessionHourUsd: number;
  context?: unknown;

  /**
   * Write the zero settlement (the `generations` anchor) even when nothing is new. Default true — a
   * turn's own settlement always anchors its row. A rebind's settlement of an old session's tail passes
   * false, so a dead session that owed nothing leaves no empty row behind.
   */
  anchorWhenEmpty?: boolean;
}

export interface ManagedSettlement {
  settlement: Settlement | null;

  /** The token usage charged by THIS settlement (zero when nothing was new). */
  usage: GenerationUsage;

  /** Model requests charged by this settlement. */
  requests: number;

  /** The session-hour USD added to the raw cost. */
  sessionHoursUsd: number;
}

async function listUsageEvents(input: SettleManagedInput, cursorAt: string | null): Promise<UsageEventLike[]> {
  const params: Record<string, unknown> = { types: ['span.model_request_end'], order: 'asc' };

  if (cursorAt) {
    params['created_at[gt]'] = new Date(Date.parse(cursorAt) - LIST_SLACK_MS).toISOString();
  }

  const events: UsageEventLike[] = [];

  for await (const event of input.client.beta.sessions.events.list(input.sessionId, params)) {
    events.push(event as unknown as UsageEventLike);
  }

  return events;
}

export function settleManagedTurn(input: SettleManagedInput): Promise<ManagedSettlement> {
  return serialised(`${input.projectId}:${input.chatId}`, () => settleNow(input));
}

async function settleNow(input: SettleManagedInput): Promise<ManagedSettlement> {
  let usage = emptyUsage();
  let requests = 0;
  let sessionHoursUsd = 0;

  try {
    const cursor = parseCursor(await getManagedSettledAt(input.projectId, input.chatId, input.context));
    const [events, session] = await Promise.all([
      listUsageEvents(input, cursor.at),
      input.client.beta.sessions.retrieve(input.sessionId).catch((error) => {
        logger.warn(`Could not read session ${input.sessionId}'s active time: ${(error as Error)?.message}`);
        return null;
      }),
    ]);

    const unsettled = unsettledUsage(events, cursor);
    const activeNow = session?.usage?.active_seconds ?? session?.stats?.active_seconds ?? cursor.activeSeconds;
    const hours = sessionHoursCostUsd(activeNow, cursor, input.sessionHourUsd);
    const next = { at: unsettled.latestAt, activeSeconds: Math.max(cursor.activeSeconds, activeNow) };

    if (unsettled.requests > 0 || next.activeSeconds !== cursor.activeSeconds) {
      try {
        await setManagedSettledAt(input.projectId, input.chatId, serializeCursor(next), input.context);
        usage = unsettled.usage;
        requests = unsettled.requests;
        sessionHoursUsd = hours;
      } catch (error) {
        logger.error(
          `Chat ${input.chatId}: could not advance the settlement cursor — leaving ${unsettled.requests} request(s) ` +
            `unsettled for the next settlement: ${(error as Error)?.message}`,
        );
      }
    }
  } catch (error) {
    logger.error(`Generation ${input.generationId}: could not read the session's usage: ${(error as Error)?.message}`);
  }

  if (input.anchorWhenEmpty === false && requests === 0 && sessionHoursUsd <= 0) {
    return { settlement: null, usage, requests, sessionHoursUsd };
  }

  /*
   * Always called, even for zero: it anchors the `generations` row the route's annotations and the
   * Admin reports read, and with nothing to charge it writes no ledger row.
   */
  const settlement = await settleGeneration({
    userId: input.userId,
    generationId: input.generationId,
    model: input.model,
    provider: 'Anthropic',
    statusKind: input.statusKind,
    usage,
    extraRawCostUsd: sessionHoursUsd,
    context: input.context,
  });

  return { settlement, usage, requests, sessionHoursUsd };
}

/**
 * Does this managed turn REFUND (§4.6)? Pure, because it decides money.
 *
 *   - A detached turn (closed tab) or a Stop is billed for what it consumed — never refunded.
 *   - A budget pause (the credit ceiling, D13) never refunds: a refunding ceiling would let a low-balance
 *     user build on step one and keep their balance.
 *   - A FAILED turn refunds — unless it wrote files: work that reached the project is never given away (D7).
 *   - A turn that ended normally but put nothing on screen and ran no tools is an empty response — a
 *     failure, refunded (the legacy `empty-response` verdict).
 */
export function shouldRefundManagedTurn(input: {
  end: 'end_turn' | 'budget' | 'failed' | 'detached' | 'aborted';
  wroteFiles: boolean;
  producedText: boolean;
  toolCalls: number;
}): boolean {
  if (input.end === 'detached' || input.end === 'aborted' || input.end === 'budget') {
    return false;
  }

  if (input.wroteFiles) {
    return false;
  }

  if (input.end === 'failed') {
    return true;
  }

  return !input.producedText && input.toolCalls === 0;
}

/** Refund this request's charge, if any. Never throws (`refundGeneration` alerts on its own failure). */
export async function refundManagedTurn(
  userId: string,
  generationId: string,
  settlement: Settlement | null,
  context?: unknown,
): Promise<void> {
  if (settlement && settlement.creditsCharged > 0) {
    await refundGeneration(
      userId,
      generationId,
      settlement.creditsCharged,
      'Automatic refund — the generation failed',
      context,
    );
  }
}

/**
 * Rebind a chat whose session is DEAD (`session-health.ts`): bill what the old session still owes, then
 * release the chat's id so the next claim creates a fresh session.
 *
 * A terminated or archived session is still listable, so its unbilled tail is settled first — under its
 * own generation id, never this turn's (one generation, one settlement). A session that is GONE (404)
 * cannot be listed: that tail is unbillable, and it is reported rather than silently dropped.
 */
export async function rebindDeadSession(
  input: Omit<SettleManagedInput, 'anchorWhenEmpty'> & { reason: 'terminated' | 'archived' | 'missing' },
): Promise<void> {
  if (input.reason === 'missing') {
    logger.error(
      `Chat ${input.chatId}: managed session ${input.sessionId} no longer exists — any usage it had not settled ` +
        'cannot be billed. Starting a new session.',
    );
    getMonitor(input.context).captureMessage(
      `Managed session ${input.sessionId} (chat ${input.chatId}) vanished; its unsettled tail could not be billed`,
      { scope: 'managed-rebind', level: 'warning' },
    );
  } else {
    await settleManagedTurn({ ...input, generationId: `${input.generationId}_prior`, anchorWhenEmpty: false });
  }

  const released = await releaseManagedSession(input.projectId, input.chatId, input.sessionId, input.context);

  logger.warn(
    released
      ? `Chat ${input.chatId}: released ${input.reason} session ${input.sessionId}; a new session will be created`
      : `Chat ${input.chatId}: ${input.reason} session ${input.sessionId} was already replaced by a concurrent turn`,
  );
}
