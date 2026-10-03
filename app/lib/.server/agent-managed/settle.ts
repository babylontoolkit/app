/**
 * Settling a managed turn (`_specs/managed-agents-engine_plan.md` D7, D13, T7).
 *
 * Every request that ran a managed turn settles ONCE, at its end — a finished turn, a detached one (a
 * closed tab), a Stop, a failure, a budget pause — and each settlement charges exactly the session's
 * cumulative cost (`session-cost.ts`: every thread's tokens plus its runtime) minus what the chat's cost
 * cursor has already charged, then advances the cursor. So a turn split across a closed tab and a reopened one is billed once in total,
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
import {
  debitAnchoredGeneration,
  refundGeneration,
  settleGeneration,
  type Settlement,
} from '~/lib/.server/billing/gate';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import type { GenerationUsage } from '~/lib/.server/agent/step-usage';
import { createScopedLogger } from '~/utils/logger';
import { advanceOpenOrphan, getManagedOrphanStore } from './orphans';
import { sessionModel } from './session-health';
import { getManagedSessionId, getManagedSettledAt, releaseManagedSession, setManagedSettledAt } from './sessions';
import { ALERT_SIGNALS, getMonitor } from '~/lib/.server/monitoring';
import { getBillingConfig, ratesFor } from '~/lib/.server/billing/rates';
import {
  decideManagedCharge,
  EMPTY_COST_CURSOR,
  listCostCents,
  parseCostCursor,
  serializeCostCursor,
  sessionCost,
  tokensOf,
  trueTokenCostUsd,
  warmTokenCostUsd,
  ZERO_TOKENS,
  type ApiUsageLike,
  type BillingRates,
  type CostCursor,
  type ManagedCharge,
  type PendingDebit,
  type ThreadUsage,
  type TierTokens,
} from './session-cost';
import { emptyUsage, isAfterCursor, parseCursor, type UsageEventLike } from './usage';

const logger = createScopedLogger('managed-settle');

/** The ledger note's name for a managed charge (D3) — never the retired "flat creation price". */
export const MANAGED_CHARGE_LABEL = 'managed session';

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

  /**
   * The model to bill at when the session does not report its own. The session's model WINS: a chat's
   * session runs one tier's agent for its whole life, and the Premium/Platinum rungs are separate
   * sessions — billing at a configured model instead would charge a Platinum turn at Standard's rates.
   */
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

  /**
   * Settle only while the chat is still BOUND to `sessionId` (checked inside the per-chat chain). For a
   * settlement that runs LATE — a detached turn's background tail, a Stop's tail — the chat may have moved
   * to another session in the meantime (a tier switch, a rebind), and the cursor went with it: settling the
   * old session against the new cursor would bill its whole history a second time. Default false — a
   * turn's own settlement and a rebind's run while the session is bound by construction.
   */
  requireBoundSession?: boolean;

  /**
   * Where this settlement reads the bound session and reads/writes the cost cursor. Default: the chat's
   * index row (`sessions.ts`). The orphan record of a chat deleted while its settlement failed
   * (no-unbilled-usage D4, `orphans.ts`) supplies its own — the chat row that held the cursor is gone.
   */
  cursorIO?: SettlementCursorIO;

  /**
   * The ledger note's pricing label. Default `managed session`; a turn's carried-over charge says so
   * (verifier slip d), so the ledger tells a carry from the turn's own row.
   */
  chargeLabel?: string;

  /**
   * This turn is REFUNDED by policy (`shouldRefundManagedTurn` — a failed turn that wrote nothing). Its
   * pending intent is marked so, and DROPPED rather than kept when its debit does not land: the user owes
   * nothing for it, and a later recovery must never charge it (verifier money defect 2).
   */
  refundable?: boolean;
}

/** The bound session and the cost cursor, wherever they live (see `SettleManagedInput.cursorIO`). */
export interface SettlementCursorIO {
  bound(): Promise<string | null>;
  get(): Promise<string | null>;
  set(next: string): Promise<void>;
}

export interface ManagedSettlement {
  settlement: Settlement | null;

  /** The token usage charged by THIS settlement (zero when nothing was new). */
  usage: GenerationUsage;

  /** Model requests charged by this settlement. */
  requests: number;

  /** Always 0 now: session runtime is part of the session's cumulative cost (`session-cost.ts`). */
  sessionHoursUsd: number;

  /** The model this settlement billed at (the session's own, when it reported one). */
  model?: string;

  /**
   * Everything the session had cost is now accounted for: the session was read, either nothing was new or
   * the cursor advanced over the new usage, AND no debit the cursor counts is still missing from the ledger
   * (no-unbilled-usage D6). `false` when the read or the cursor write failed, or a debit did not land — the
   * usage is still unsettled, and a caller about to lose the cursor (a delete D4, a rebind D5) must keep a
   * record of it. `true` for a session no longer bound to the chat (its new owner settles it).
   */
  complete: boolean;

  /**
   * The cost cursor as it stands AFTER this settlement — the one it wrote, or the one it found when it
   * charged nothing. `undefined` when it never got as far as reading it. A caller that must keep a record of
   * the cursor beyond the chat row (a delete's orphan, D4) keeps THIS one: the pre-settlement cursor would
   * make the next settlement charge this one's usage again (verifier defect A).
   */
  cursor?: string | null;

  /** The chat was no longer bound to this session: its new owner settles it; nothing was read. */
  unbound?: true;

  /** The session no longer exists (404): what it had not settled cannot be billed, and never will be. */
  gone?: true;
}

/** Every thread of the session with its model and cumulative usage (`null` until the thread first idles). */
async function readThreads(input: SettleManagedInput): Promise<ThreadUsage[]> {
  const threads: ThreadUsage[] = [];

  for await (const thread of input.client.beta.sessions.threads.list(input.sessionId)) {
    const model = (thread.agent as { model?: { id?: unknown } } | undefined)?.model?.id;

    threads.push({
      id: thread.id,
      model: typeof model === 'string' && model ? model : input.model,
      tokens: thread.usage ? tokensOf(thread.usage as ApiUsageLike) : null,
    });
  }

  return threads;
}

/**
 * What the PREVIOUS settlement design (request events after a timestamp cursor) had already billed, so a
 * session that was settled under it and continues under this one is never charged twice. Only the
 * primary thread existed then; cache writes are counted as the 5-minute tier, which is what Managed Agents
 * writes (measured 2026-10-02).
 */
async function legacyBaseline(
  input: SettleManagedInput,
  text: string | null,
  cost: (t: TierTokens) => {
    trueCostUsd: number;
    warmBasisUsd: number;
  },
  billing: BillingRates,
): Promise<CostCursor> {
  const old = parseCursor(text);

  if (!old.at) {
    return { ...EMPTY_COST_CURSOR, tokens: { ...ZERO_TOKENS } };
  }

  const tokens = { ...ZERO_TOKENS };

  for await (const event of input.client.beta.sessions.events.list(input.sessionId, {
    types: ['span.model_request_end'],
    order: 'asc',
  } as never)) {
    const e = event as unknown as UsageEventLike;

    if (isAfterCursor(e.processed_at, old.at)) {
      continue;
    }

    tokens.input += e.model_usage?.input_tokens ?? 0;
    tokens.output += e.model_usage?.output_tokens ?? 0;
    tokens.cacheRead += e.model_usage?.cache_read_input_tokens ?? 0;
    tokens.cache5m += e.model_usage?.cache_creation_input_tokens ?? 0;
  }

  const runtime = input.sessionHourUsd > 0 ? (old.activeSeconds / 3600) * input.sessionHourUsd : 0;
  const priced = cost(tokens);
  const warmBasisUsd = priced.warmBasisUsd + runtime;

  return {
    v: 2,
    tokens,
    trueCostUsd: priced.trueCostUsd + runtime,
    warmBasisUsd,
    credits: warmBasisUsd > 0 ? Math.max(1, Math.ceil((warmBasisUsd / billing.creditUnitCostUsd) * billing.margin)) : 0,
  };
}

export function settleManagedTurn(input: SettleManagedInput): Promise<ManagedSettlement> {
  return serialised(`${input.projectId}:${input.chatId}`, () => settleNow(input));
}

/**
 * One settlement: the session's CUMULATIVE cost across every thread (`session-cost.ts`) minus what the
 * cursor says was already charged. Every thread is billed — a subagent's usage never reaches the primary
 * event stream (measured), so a settlement that read only that stream would have given every subagent
 * token away — and the total charged for a session can never be worth less than what it cost us.
 */
/** The default cursor home: the chat's index row. */
export function chatCursorIO(input: { projectId: string; chatId: string; context?: unknown }): SettlementCursorIO {
  return {
    bound: () => getManagedSessionId(input.projectId, input.chatId, input.context),
    get: () => getManagedSettledAt(input.projectId, input.chatId, input.context),
    set: (next) => setManagedSettledAt(input.projectId, input.chatId, next, input.context),
  };
}

const isNotFound = (error: unknown) => (error as { status?: unknown } | null)?.status === 404;

/** What happened to one recovered intent. */
type IntentOutcome = 'debited' | 'already-billed' | 'dropped' | 'failed';

/**
 * Debit ONE recovered intent (no-unbilled-usage D6). Idempotent by generation id (migration 0029).
 *
 *   - A `refundable` intent is DROPPED: its turn is refunded by policy, so the user owes nothing for it
 *     (verifier money defect 2) — debiting it now would charge for a failed turn the refund never reaches.
 *   - When the generation's row already exists (the turn anchored it), ONLY the ledger debit is written:
 *     routing through `settleGeneration` would re-anchor the row and rewrite a `failed` row as `completed`
 *     (verifier slip a). A 0029 duplicate is the EXPECTED "it had landed, only its clear was lost" case —
 *     cleared, no alert, whatever a balance read would say (slips a, b).
 *   - With no row at all, `settleGeneration` anchors it (the foreign key) and debits.
 *
 * Never throws; `failed` keeps the intent for the next try.
 */
async function debitIntent(intent: PendingDebit, context: unknown): Promise<IntentOutcome> {
  if (intent.refundable) {
    logger.warn(
      `Generation ${intent.generationId}: dropping its pending debit — the turn is refunded by policy, the user owes nothing`,
    );
    return 'dropped';
  }

  try {
    let anchored = false;

    try {
      anchored = (await getGenerationStore(context).listByIds([intent.generationId])).length > 0;
    } catch {
      anchored = false;
    }

    if (!anchored) {
      const settlement = await settleGeneration({
        userId: intent.userId,
        generationId: intent.generationId,
        model: intent.model,
        provider: 'Anthropic',
        statusKind: intent.statusKind,
        projectId: intent.projectId,
        chatId: intent.chatId,
        usage: intent.usage,
        flatCredits: intent.credits,
        rawCostOverrideUsd: intent.rawCostUsd,
        chargeLabel: intent.chargeLabel ?? MANAGED_CHARGE_LABEL,
        context,
      });

      return settlement ? (settlement.creditsCharged > 0 ? 'debited' : 'already-billed') : 'failed';
    }

    return await debitAnchoredGeneration({
      userId: intent.userId,
      generationId: intent.generationId,
      credits: intent.credits,
      note:
        `${intent.model}: ${intent.usage.promptTokens} in / ${intent.usage.completionTokens} out — ` +
        `${intent.chargeLabel ?? MANAGED_CHARGE_LABEL}`,
      context,
    });
  } catch (error) {
    logger.error(`Generation ${intent.generationId}: its pending debit failed: ${(error as Error)?.message}`);

    return 'failed';
  }
}

/**
 * Debit every pending intent a cursor carries (no-unbilled-usage D6) — a charge whose cursor was written
 * but whose debit never landed (a crash, a ledger outage). What still fails stays for the next try.
 */
async function debitPendingIntents(
  pending: PendingDebit[],
  context: unknown,
): Promise<{ remaining: PendingDebit[]; debited: number }> {
  const remaining: PendingDebit[] = [];
  let debited = 0;

  for (const intent of pending) {
    const outcome = await debitIntent(intent, context);

    if (outcome === 'failed') {
      remaining.push(intent);
      continue;
    }

    if (outcome === 'debited') {
      debited += 1;
      logger.warn(
        `Generation ${intent.generationId}: debited ${intent.credits} credits its cursor had counted but the ` +
          'ledger never received (a settlement interrupted between the two)',
      );
    }
  }

  return { remaining, debited };
}

/** The outcome of settling one cursor's pending intents. */
export interface PendingDebitsResult {
  debited: number;

  /** Intents still owed — a debit that failed again. A caller about to drop the cursor must keep it. */
  remaining: number;

  /** The cursor as it stands afterwards; `undefined` when it could not even be read. */
  cursor?: string | null;
}

/**
 * Debit the pending intents on one cursor, serialised with every other settlement of the chat. An intent is
 * a DECIDED charge and needs no session (verifier money defect 1): this is what runs before a session is
 * released, an orphan is resolved, or the sweep's pass (c) passes by. Never throws — an unreadable cursor
 * reports `cursor: undefined` and `remaining: 1` (unknown is owed).
 */
export function settlePendingDebitsDetailed(input: {
  projectId: string;
  chatId: string;
  cursorIO?: SettlementCursorIO;
  context?: unknown;
}): Promise<PendingDebitsResult> {
  return serialised(`${input.projectId}:${input.chatId}`, async () => {
    const io = input.cursorIO ?? chatCursorIO(input);
    let stored: string | null;

    try {
      stored = await io.get();
    } catch (error) {
      logger.error(`Chat ${input.chatId}: could not read its cursor for pending debits: ${(error as Error)?.message}`);
      return { debited: 0, remaining: 1 };
    }

    const parsed = parseCostCursor(stored);

    if (!parsed?.pending?.length) {
      return { debited: 0, remaining: 0, cursor: stored };
    }

    const { remaining, debited } = await debitPendingIntents(parsed.pending, input.context);
    let cursor = stored;

    if (remaining.length !== parsed.pending.length) {
      const next = serializeCostCursor({ ...parsed, pending: remaining });

      try {
        await io.set(next);
        cursor = next;
      } catch (error) {
        /* The debits landed; the next pass finds them already billed and clears them. */
        logger.warn(`Chat ${input.chatId}: could not clear its settled intents: ${(error as Error)?.message}`);
      }
    }

    return { debited, remaining: remaining.length, cursor };
  });
}

/** `settlePendingDebitsDetailed`, counting only the debits that charged — the sweep's pass (c). */
export async function settlePendingDebits(input: {
  projectId: string;
  chatId: string;
  cursorIO?: SettlementCursorIO;
  context?: unknown;
}): Promise<number> {
  return (await settlePendingDebitsDetailed(input)).debited;
}

async function settleNow(input: SettleManagedInput): Promise<ManagedSettlement> {
  let usage = emptyUsage();
  let requests = 0;
  const sessionHoursUsd = 0;
  let model = input.model;
  let charge: ManagedCharge | null = null;
  let complete = false;
  let cursorAfter: string | null | undefined;
  const io = input.cursorIO ?? chatCursorIO(input);

  /* D6: the debits the stored cursor counts and the ledger does not (yet) hold, after recovery. */
  let pendingBefore: PendingDebit[] = [];
  let intent: PendingDebit | null = null;
  let gone = false;

  try {
    if (input.requireBoundSession) {
      const bound = await io.bound();

      if (bound !== input.sessionId) {
        logger.warn(
          `Chat ${input.chatId}: no longer bound to session ${input.sessionId} — its late settlement charges nothing ` +
            '(the rebind settled that session when it released it)',
        );

        return { settlement: null, usage, requests, sessionHoursUsd, model, complete: true, unbound: true };
      }
    }

    const config = getBillingConfig(input.context);
    const billing: BillingRates = { creditUnitCostUsd: config.creditUnitCostUsd, margin: config.margin };
    const stored = await io.get();

    cursorAfter = stored;

    let parsedCursor = parseCostCursor(stored);

    /*
     * D6: a debit an earlier settlement counted on this cursor but never landed (it died between the cursor
     * write and the ledger, or the ledger refused) is debited FIRST — before this settlement can rewrite the
     * cursor. What still fails stays on the cursor for the next try.
     */
    if (parsedCursor?.pending?.length) {
      const { remaining } = await debitPendingIntents(parsedCursor.pending, input.context);

      if (remaining.length !== parsedCursor.pending.length) {
        parsedCursor = { ...parsedCursor, pending: remaining };

        const healed = serializeCostCursor(parsedCursor);

        try {
          await io.set(healed);
          cursorAfter = healed;
        } catch (error) {
          logger.warn(
            `Chat ${input.chatId}: recovered its pending debits but could not clear them from the cursor ` +
              `(a later settlement finds them already billed): ${(error as Error)?.message}`,
          );
        }
      }

      pendingBefore = parsedCursor.pending ?? [];
    }

    const session = await input.client.beta.sessions.retrieve(input.sessionId);

    model = sessionModel(session) ?? input.model;

    const ratesOf = (m: string) => ratesFor(m, 'Anthropic', input.context);
    const threads = await readThreads({ ...input, model });
    const sessionUsage = (session?.usage ?? null) as ApiUsageLike | null;
    const activeSeconds = Number(sessionUsage?.active_seconds ?? session?.stats?.active_seconds ?? 0) || 0;

    const cost = sessionCost({
      threads,
      sessionTokens: tokensOf(sessionUsage),
      activeSeconds,
      listCostCents: listCostCents(sessionUsage),
      fallbackModel: model,
      ratesOf,
      sessionHourUsd: input.sessionHourUsd,
    });

    const cursor =
      parsedCursor ??
      (await legacyBaseline(
        input,
        stored,
        (t) => ({
          trueCostUsd: trueTokenCostUsd(t, ratesOf(model)),
          warmBasisUsd: warmTokenCostUsd(t, ratesOf(model)),
        }),
        billing,
      ));

    if (cost.models.length > 1 || cost.threads > 1) {
      logger.warn(
        `Session ${input.sessionId}: ${cost.threads} thread(s) on ${cost.models.join(', ')} — billing every thread`,
      );
    }

    /*
     * Nothing new → the cursor stays put, so session-hours ride WITH model usage, never alone (a Stop tail's
     * fraction of a second is carried to the next settlement instead of `ceil`-ing into a whole credit).
     */
    const decided = decideManagedCharge(cost, cursor, billing);

    if (!decided) {
      complete = true;
    }

    if (decided) {
      try {
        /*
         * Cursor FIRST, then the debit: the other order double-charges. And the cursor carries this charge as
         * a PENDING DEBIT in the same write (D6), cleared once the debit lands — so a process that dies, or a
         * ledger that refuses, between the two leaves a record the next settlement or the sweep debits,
         * instead of usage the cursor says was billed and the ledger never saw.
         */
        const pendingIntent: PendingDebit = {
          generationId: input.generationId,
          credits: decided.credits,
          rawCostUsd: decided.trueCostUsd,
          model,
          userId: input.userId,
          projectId: input.projectId,
          chatId: input.chatId,
          statusKind: input.statusKind,
          usage: decided.usage,
          ...(input.chargeLabel ? { chargeLabel: input.chargeLabel } : {}),
          ...(input.refundable ? { refundable: true as const } : {}),
        };
        const next = serializeCostCursor({ ...decided.next, pending: [...pendingBefore, pendingIntent] });

        await io.set(next);
        intent = pendingIntent;
        cursorAfter = next;
        complete = true;
        charge = decided;
        usage = decided.usage;
        requests = 1;

        if (decided.floorApplied) {
          logger.warn(
            `Session ${input.sessionId}: the never-below-cost floor set this charge (${decided.credits} credits for ` +
              `$${decided.trueCostUsd.toFixed(4)} of cost)`,
          );
        }
      } catch (error) {
        logger.error(
          `Chat ${input.chatId}: could not advance the settlement cursor — leaving the usage unsettled for the ` +
            `next settlement: ${(error as Error)?.message}`,
        );
      }
    }
  } catch (error) {
    gone = isNotFound(error);
    logger.error(`Generation ${input.generationId}: could not read the session's usage: ${(error as Error)?.message}`);
  }

  /* A debit the cursor counts and the ledger has not received yet: not accounted for (D6). */
  const owed = () => pendingBefore.length > 0;

  if (input.anchorWhenEmpty === false && !charge) {
    return {
      settlement: null,
      usage,
      requests,
      sessionHoursUsd,
      model,
      complete: complete && !owed(),
      cursor: cursorAfter,
      ...(gone ? { gone: true as const } : {}),
    };
  }

  /*
   * Always called, even for zero: it anchors the `generations` row the route's annotations and the
   * Admin reports read, and with nothing to charge it writes no ledger row. The credits and the true cost
   * were decided above (`decideManagedCharge`), so both are passed in rather than re-derived from one model.
   */
  const settlement = await settleGeneration({
    userId: input.userId,
    generationId: input.generationId,
    model,
    provider: 'Anthropic',
    statusKind: input.statusKind,

    /* So the Postgres upsert never erases what the turn's running row recorded (verifier slip 2). */
    projectId: input.projectId,
    chatId: input.chatId,
    usage,
    ...(charge
      ? {
          flatCredits: charge.credits,
          rawCostOverrideUsd: charge.trueCostUsd,
          chargeLabel: input.chargeLabel ?? MANAGED_CHARGE_LABEL,
        }
      : {}),
    context: input.context,
  });

  /*
   * D6: the debit landed (or was already billed) — clear its intent. Best effort: an intent left behind is
   * found by the next settlement or the sweep, which sees the ledger row and charges nothing more.
   */
  let landed = !intent;

  if (charge && intent && settlement) {
    landed = true;

    const cleared = serializeCostCursor({ ...charge.next, pending: pendingBefore });

    try {
      await io.set(cleared);
      cursorAfter = cleared;
    } catch (error) {
      logger.warn(
        `Chat ${input.chatId}: the debit of ${input.generationId} landed but its pending intent could not be ` +
          `cleared — the next settlement finds it already billed: ${(error as Error)?.message}`,
      );
    }
  } else if (charge && intent && !settlement && input.refundable) {
    /*
     * Verifier money defect 2: the debit did not land, and the turn is refunded by policy — so the user owes
     * nothing for it. Its intent is DROPPED (the cursor stays advanced past the usage), never left for a later
     * recovery to debit with no refund behind it. DECISION: drop, not debit-and-refund — generation refunds are
     * not idempotent, so a recovered pair could refund twice; dropping nets the same zero with no ledger rows.
     */
    const dropped = serializeCostCursor({ ...charge.next, pending: pendingBefore });

    try {
      await io.set(dropped);
      cursorAfter = dropped;
      landed = true;
      logger.warn(
        `Chat ${input.chatId}: the debit of refunded turn ${input.generationId} did not land — its intent is dropped ` +
          '(the user owes nothing for a refunded turn)',
      );
    } catch (error) {
      /* Still marked `refundable` on the cursor: any recovery drops it too. */
      landed = true;
      logger.warn(
        `Chat ${input.chatId}: could not drop the intent of refunded turn ${input.generationId} — it is marked ` +
          `refundable, so no recovery will debit it: ${(error as Error)?.message}`,
      );
    }
  } else if (charge && intent && !settlement) {
    logger.error(
      `Chat ${input.chatId}: the debit of ${input.generationId} did not land — kept as a pending intent on the ` +
        'cursor; the next settlement or the billing sweep debits it',
    );
  }

  return {
    settlement,
    usage,
    requests,
    sessionHoursUsd,
    model,
    complete: complete && landed && !owed(),
    cursor: cursorAfter,
    ...(gone ? { gone: true as const } : {}),
  };
}

/** How long a detached turn's tail settlement waits for its session to stop running (D2). */
export const DETACH_SETTLE_WAIT_MS = 30 * 60_000;

/** How often it asks. 5 s × 30 min is at most 360 retrieves for a session that never stops. */
export const DETACH_SETTLE_POLL_MS = 5_000;

/** Consecutive failed retrieves after which the wait gives up and settles what has landed. */
const DETACH_RETRIEVE_FAILURES = 3;

/** A tail still waiting, and how to cut its wait short. */
interface PendingTail {
  job: Promise<void>;
  flush: () => void;
}

/** Pending tails by chat (the per-chat chain key) — a turn start flushes its chat's. */
const detachTails = new Map<string, Set<PendingTail>>();

const chatKey = (projectId: string, chatId: string) => `${projectId}:${chatId}`;

export interface DetachedTailInput extends Omit<SettleManagedInput, 'anchorWhenEmpty' | 'requireBoundSession'> {
  waitMs: number;
  pollMs: number;

  /** Injected for specs; production sleeps on an unref'd timer so a pending wait never holds the process. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void };

    timer.unref?.();
  });
}

/**
 * A DETACHED turn's tail, settled in the background (`_specs/managed-billing-visibility_plan.md` D2).
 *
 * A closed tab settles what had accrued at the detach — but the session keeps running until it idles on
 * the next custom tool call no browser answers, and that tail was billed only at the chat's NEXT
 * settlement (a resume, the next turn). A chat nobody reopens never paid for it. So the detach fires this,
 * fire-and-forget: wait (bounded) for the session to stop running, then run the ordinary cursor
 * settlement. It is safe against a resume settling first — settlement is by cursor and serialised per
 * chat, so whichever arrives second charges only what is new (usually nothing) — and it settles only while
 * the chat is still bound to this session (`requireBoundSession`).
 *
 * Never throws; never answers a tool call and never interrupts (a detach is not a Stop, D6). Residual,
 * accepted: a server restart inside the wait leaves the tail for the chat's next settlement.
 */
export function settleDetachedTail(input: DetachedTailInput): Promise<void> {
  const key = chatKey(input.projectId, input.chatId);
  let flushed = false;
  let wake: (() => void) | null = null;
  const signal = {
    get flushed() {
      return flushed;
    },

    /* Resolves when the tail is flushed — raced against each sleep so a flush never waits out a poll. */
    woken: new Promise<void>((resolve) => {
      wake = resolve;
    }),
  };
  const entry: PendingTail = {
    job: Promise.resolve(),
    flush: () => {
      flushed = true;
      wake?.();
    },
  };

  entry.job = runDetachedTail(input, signal).finally(() => {
    const set = detachTails.get(key);

    set?.delete(entry);

    if (set && set.size === 0) {
      detachTails.delete(key);
    }
  });

  if (!detachTails.has(key)) {
    detachTails.set(key, new Set());
  }

  detachTails.get(key)!.add(entry);

  return entry.job;
}

/**
 * A turn START settles any tail still waiting for this chat — NOW, before the new turn sends anything
 * (verifier finding). A tail left waiting would see the NEW turn as `running` and, at its deadline, bill
 * part of the new turn under the old turn's `<gen>_tail` id: a refund of the failed new turn would then
 * refund only its own share. Flushed, the tail charges exactly the old turn's post-detach usage (at most
 * one retrieve + one cursor settlement, serialised per chat), and the new turn's settlement only its own.
 * Accepted residual: old-turn usage still in flight at the flush lands in the new turn's settlement — one
 * request at most (the new turn interrupts the old one), and only ever the under-bill direction on a refund.
 * `true` when a pending tail was flushed. Never throws.
 */
export async function flushDetachedTail(input: { projectId: string; chatId: string | undefined }): Promise<boolean> {
  try {
    if (!input.chatId) {
      return false;
    }

    const pending = [...(detachTails.get(chatKey(input.projectId, input.chatId)) ?? [])];

    if (pending.length === 0) {
      return false;
    }

    pending.forEach((tail) => tail.flush());
    await Promise.allSettled(pending.map((tail) => tail.job));

    return true;
  } catch (error) {
    logger.error(`Chat ${input.chatId}: could not flush the detached turn's tail: ${(error as Error)?.message}`);
    return false;
  }
}

/**
 * Is a detached turn's tail still waiting for this chat in this process? The billing sweep treats it as a
 * turn in flight (no-unbilled-usage D3): the tail settles the chat itself when its session stops.
 */
export function hasPendingDetachTail(projectId: string, chatId: string): boolean {
  return (detachTails.get(chatKey(projectId, chatId))?.size ?? 0) > 0;
}

/** Specs: resolve once every background tail settlement started so far has finished. */
export async function waitForDetachTails(): Promise<void> {
  while (detachTails.size) {
    await Promise.allSettled([...detachTails.values()].flatMap((set) => [...set].map((tail) => tail.job)));
  }
}

async function runDetachedTail(
  input: DetachedTailInput,
  signal: { readonly flushed: boolean; woken: Promise<void> },
): Promise<void> {
  try {
    const now = input.now ?? Date.now;
    const sleep = input.sleep ?? unrefSleep;
    const deadline = now() + Math.max(0, input.waitMs);
    let failures = 0;

    for (;;) {
      if (signal.flushed) {
        break;
      }

      let status: string | undefined;

      try {
        status = (await input.client.beta.sessions.retrieve(input.sessionId))?.status;
        failures = 0;
      } catch (error) {
        failures += 1;

        if (failures >= DETACH_RETRIEVE_FAILURES) {
          logger.warn(
            `Session ${input.sessionId}: could not read its status after the detach (${(error as Error)?.message}) — ` +
              'settling what has landed',
          );
          break;
        }
      }

      if (status !== undefined && status !== 'running' && status !== 'rescheduling') {
        break;
      }

      if (now() >= deadline) {
        logger.warn(
          `Session ${input.sessionId}: still ${status ?? 'unknown'} at the detach deadline — settling what has landed`,
        );
        break;
      }

      /* Never sleep past the deadline; a flush cuts the sleep short. */
      await Promise.race([sleep(Math.max(1, Math.min(input.pollMs, deadline - now()))), signal.woken]);
    }

    const { waitMs: _waitMs, pollMs: _pollMs, sleep: _sleep, now: _now, ...settle } = input;
    const settled = await settleManagedTurn({
      ...settle,
      generationId: `${input.generationId}_tail`,
      anchorWhenEmpty: false,
      requireBoundSession: true,
    });

    if (settled.settlement && settled.settlement.creditsCharged > 0) {
      logger.info(
        `Chat ${input.chatId}: billed ${settled.settlement.creditsCharged} credits for the detached turn's tail`,
      );
    }
  } catch (error) {
    logger.error(`Chat ${input.chatId}: could not settle the detached turn's tail: ${(error as Error)?.message}`);
  }
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
 * Rebind a chat whose session is DEAD — or alive on another tier/effort (`switched`): bill what the old
 * session still owes, then release the chat's id so the next claim creates a fresh session.
 *
 * A terminated or archived session is still listable, so its unbilled tail is settled first — under its
 * own generation id, never this turn's (one generation, one settlement). A session that is GONE (404)
 * cannot be listed: that tail is unbillable, and it is reported rather than silently dropped.
 *
 * ## Release only what is accounted for (no-unbilled-usage D5, G4)
 *
 * Releasing clears the chat's cursor, and the chat row is the only record of what the old session has been
 * charged — so the session is released ONLY when its `_prior` settlement COMPLETED (or it is gone). When it
 * did not (a failed read, a cursor write that failed, a debit that did not land), or a `switched` session
 * is STILL RUNNING after the supersede wait (its later usage would be lost when it is archived), the session
 * and the cursor its settlement LEFT are first recorded as an orphan (`orphans.ts`), which the billing sweep
 * interrupts, settles and archives. DECISION: the turn still gets its new session — it needs one, and the
 * orphan record keeps the old session billable. If even the orphan cannot be written, the chat stays BOUND
 * and this throws a retryable error before anything is sent: refusing one turn is recoverable, losing the
 * old session's usage is not.
 *
 * A `switched` session that is accounted for and stopped is archived here (it was the engine's job).
 */
export async function rebindDeadSession(
  input: Omit<SettleManagedInput, 'anchorWhenEmpty'> & {
    /** `switched`: the chat's session is alive but runs another tier's agent (the user changed tier). */
    reason: 'terminated' | 'archived' | 'missing' | 'switched';
  },
): Promise<void> {
  const reportGone = () => {
    logger.error(
      `Chat ${input.chatId}: managed session ${input.sessionId} no longer exists — any usage it had not settled ` +
        'cannot be billed. Starting a new session.',
    );
    getMonitor(input.context).captureMessage(
      `Managed session ${input.sessionId} (chat ${input.chatId}) vanished; its unsettled tail could not be billed`,
      { scope: 'managed-rebind', level: 'warning' },
    );
  };

  let archive = false;
  let keep: string | null = null;
  let unbound = false;
  let kept: { cursor?: string | null; model?: string } = {};

  if (input.reason === 'missing') {
    reportGone();
  } else {
    /*
     * Keyed by the SESSION too: one turn can release two sessions (a tier switch, then a dead replacement), and
     * a generation is debited at most once (migration 0029) — a shared `_prior` id would refuse the second.
     * Bound-only (verifier slip c): a chat a concurrent turn already moved is that turn's to settle.
     */
    const settled = await settleManagedTurn({
      ...input,
      generationId: `${input.generationId}_${input.sessionId}_prior`,
      anchorWhenEmpty: false,
      requireBoundSession: true,
    });

    kept = { cursor: settled.cursor, model: settled.model };

    if (settled.gone) {
      reportGone();
    } else if (settled.unbound) {
      /* A concurrent turn already moved the chat — that turn settled the old session when it released it. */
      unbound = true;
    } else if (!settled.complete) {
      keep = 'its settlement at the rebind did not complete';
    } else if (input.reason === 'switched') {
      let status: string | undefined;

      try {
        status = (await input.client.beta.sessions.retrieve(input.sessionId))?.status;
      } catch (error) {
        if (!isNotFound(error)) {
          keep = `its status could not be read after the switch (${(error as Error)?.message})`;
        }
      }

      if (status === 'running' || status === 'rescheduling') {
        keep = `still ${status} after the supersede wait — later usage would be lost to the archive`;
      } else if (!keep && status !== undefined) {
        archive = true;
      }
    }
  }

  /*
   * Verifier money defect 1: an intent on the cursor is a DECIDED charge and needs no session — a session
   * that is gone (404) or missing still owes it. Debit it before the release clears the cursor; if it does not
   * land, the cursor (intent included) is kept as an orphan for the sweep.
   */
  if (!keep && !unbound) {
    const pending = await settlePendingDebitsDetailed({
      projectId: input.projectId,
      chatId: input.chatId,
      context: input.context,
    });

    if (pending.remaining > 0) {
      keep = 'a debit its cursor counts has not landed yet';
      kept = { ...kept, cursor: pending.cursor };
    }
  }

  /* Did an open orphan of this session exist BEFORE this keep? Then this keep only merged into it (R2). */
  const preExisting = keep ? await openOrphanOf(input) : null;
  const orphanId = keep ? await keepForSweep(input, kept, keep) : null;

  /*
   * 🔴 Let go WITHOUT a keep: an open orphan of this session (one a past failed release could not withdraw) is
   * advanced to this cursor BEFORE the release (R2-b). After it, a sweep that sees the chat unbound settles the
   * orphan from its stale cursor and bills the stretch the chat just billed a second time — under a different
   * generation id, so migration 0029 cannot stop it. Advancing first is harmless if the release then fails (a
   * merge never rewinds). DECISION (R2-b): an advance that FAILS is a keep problem — nothing is released and
   * the turn is refused, retryably; a stale owner left behind is a later double charge.
   */
  if (!keep && !unbound && !(await advanceOpenOrphan(input.context, input.sessionId, kept.cursor))) {
    throw new ManagedRebindError(
      'The previous session of this chat could not be closed out yet. Nothing was charged for this message — ' +
        'send it again in a moment.',
    );
  }

  /*
   * 🔴 EXACTLY ONE OWNER (no-unbilled-usage residual R2a). The orphan was recorded FIRST so a release can never
   * leave the session unowned. But a release that THROWS leaves the chat still bound — and then the chat and
   * the orphan would both hold the cursor. So when the chat demonstrably still holds the session, an orphan
   * THIS keep created is WITHDRAWN (deleted, never resolved — `undoKeepAfterFailedRelease`) and the turn is
   * refused (retryable): the chat stays the single owner. A pre-existing orphan stays, deferred by the sweep.
   */
  let released: boolean;

  try {
    released = await releaseManagedSession(input.projectId, input.chatId, input.sessionId, input.context);
  } catch (error) {
    await undoKeepAfterFailedRelease(
      input,
      orphanId && orphanId !== preExisting?.id ? orphanId : null,
      (error as Error)?.message ?? String(error),
    );

    throw new ManagedRebindError(
      'The previous session of this chat could not be closed out yet. Nothing was charged for this message — ' +
        'send it again in a moment.',
    );
  }

  logger.warn(
    released
      ? input.reason === 'switched'
        ? `Chat ${input.chatId}: the user changed model tier or effort — released session ${input.sessionId}; a new session will be created at the new setting`
        : `Chat ${input.chatId}: released ${input.reason} session ${input.sessionId}; a new session will be created`
      : `Chat ${input.chatId}: ${input.reason} session ${input.sessionId} was already replaced by a concurrent turn`,
  );

  if (archive) {
    await input.client.beta.sessions.archive(input.sessionId).catch((error: unknown) => {
      logger.warn(
        `Session ${input.sessionId}: could not archive it after a tier/effort switch: ${(error as Error)?.message}`,
      );
    });
  }
}

/** The open orphan of the session being rebound, or null (a failed read counts as none — never throws). */
async function openOrphanOf(input: Omit<SettleManagedInput, 'anchorWhenEmpty'>) {
  try {
    return await getManagedOrphanStore(input.context).openForSession(input.sessionId);
  } catch {
    return null;
  }
}

/**
 * The release after `keepForSweep` threw (R2a). Verifier R2: the withdrawal must not look like "billed and
 * done" — a RESOLVED orphan is never reopened, so a resend's keep would get the resolved row back and the
 * session would end with NO billing owner. So:
 *
 *  - an orphan THIS keep created is DELETED (`withdraw`) when the chat demonstrably still holds the session —
 *    the chat is the single owner, and a later keep records the orphan afresh;
 *  - an orphan that already existed (`withdrawId` null) is LEFT — it carries its own pending intents. While the
 *    chat holds the session the sweep defers it (`sweep.ts`: the chat owns the usage; intents debit
 *    idempotently under 0029), and every path that lets go of the session advances its cursor first
 *    (`advanceOpenOrphan`), so it never bills what the chat billed;
 *  - when the binding cannot be read, the orphan is kept and the possible double owner is alerted.
 *
 * DECISION (R2 verifier fix): delete-on-withdraw + defer-while-bound is the provably single-owner pair. Never
 * throws.
 */
async function undoKeepAfterFailedRelease(
  input: Omit<SettleManagedInput, 'anchorWhenEmpty'>,
  withdrawId: string | null,
  releaseError: string,
): Promise<void> {
  logger.error(`Chat ${input.chatId}: releasing session ${input.sessionId} failed: ${releaseError}`);

  if (!withdrawId) {
    return;
  }

  let bound: string | null | undefined;

  try {
    bound = await getManagedSessionId(input.projectId, input.chatId, input.context);
  } catch (error) {
    bound = undefined;
    logger.error(
      `Chat ${input.chatId}: could not read its binding after a failed release: ${(error as Error)?.message}`,
    );
  }

  if (bound === input.sessionId) {
    try {
      await getManagedOrphanStore(input.context).withdraw(withdrawId);
      logger.warn(
        `Chat ${input.chatId}: still bound to ${input.sessionId} — its new orphan ${withdrawId} was withdrawn`,
      );

      return;
    } catch (error) {
      /* Kept: the sweep defers it while the chat holds the session, so this is not a double charge. */
      logger.error(`Chat ${input.chatId}: withdrawing orphan ${withdrawId} failed: ${(error as Error)?.message}`);

      return;
    }
  }

  if (bound !== undefined) {
    /* The release DID land (the error was after the write): the orphan is now the session's only owner. */
    return;
  }

  getMonitor(input.context).alert(
    ALERT_SIGNALS.LEDGER_INTEGRITY,
    `Managed session ${input.sessionId} (chat ${input.chatId}): a release failed (${releaseError}) and the chat's ` +
      `binding could not be read, so orphan ${withdrawId} was kept. The sweep defers it while the chat holds the ` +
      'session; check it if the chat is later released without settling.',
    { severity: 'warning', scope: 'managed-rebind', userId: input.userId, tags: { sessionId: input.sessionId } },
  );
}

/** A rebind that cannot be completed safely: the chat keeps its session; the turn is refused (retryable). */
export class ManagedRebindError extends Error {
  readonly statusCode = 503;
  readonly isRetryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'ManagedRebindError';
  }
}

/**
 * Record the old session as an orphan BEFORE the chat releases it (D5), carrying the cursor its settlement
 * LEFT — the pre-settlement cursor would make the sweep charge what was just charged again (T4 defect A).
 * Throws `ManagedRebindError` when no faithful record can be kept, so the caller never releases.
 */
async function keepForSweep(
  input: Omit<SettleManagedInput, 'anchorWhenEmpty'>,
  settled: { cursor?: string | null; model?: string },
  why: string,
): Promise<string> {
  try {
    const cursor =
      settled.cursor !== undefined
        ? settled.cursor
        : await getManagedSettledAt(input.projectId, input.chatId, input.context);

    const recorded = await getManagedOrphanStore(input.context).record({
      userId: input.userId,
      projectId: input.projectId,
      chatId: input.chatId,
      sessionId: input.sessionId,
      cursor,
      model: settled.model ?? input.model,
      reason: why.slice(0, 500),
    });
    logger.warn(`Chat ${input.chatId}: session ${input.sessionId} ${why} — kept for the billing sweep`);

    return recorded.id;
  } catch (error) {
    logger.error(
      `Chat ${input.chatId}: session ${input.sessionId} ${why}, and it could not be kept for the sweep: ` +
        `${(error as Error)?.message} — the chat keeps the session`,
    );
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Managed session ${input.sessionId} (chat ${input.chatId}) could not be released safely: ${why}, and no ` +
        `orphan record could be written (${(error as Error)?.message}). The turn was refused; nothing was lost.`,
      { severity: 'warning', scope: 'managed-rebind', userId: input.userId, tags: { sessionId: input.sessionId } },
    );

    throw new ManagedRebindError(
      'The previous session of this chat could not be closed out yet. Nothing was charged for this message — ' +
        'send it again in a moment.',
    );
  }
}
