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
import { refundGeneration, settleGeneration, type Settlement } from '~/lib/.server/billing/gate';
import type { GenerationUsage } from '~/lib/.server/agent/step-usage';
import { createScopedLogger } from '~/utils/logger';
import { sessionModel } from './session-health';
import { getManagedSessionId, getManagedSettledAt, releaseManagedSession, setManagedSettledAt } from './sessions';
import { getMonitor } from '~/lib/.server/monitoring';
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
async function settleNow(input: SettleManagedInput): Promise<ManagedSettlement> {
  let usage = emptyUsage();
  let requests = 0;
  const sessionHoursUsd = 0;
  let model = input.model;
  let charge: ManagedCharge | null = null;

  try {
    if (input.requireBoundSession) {
      const bound = await getManagedSessionId(input.projectId, input.chatId, input.context);

      if (bound !== input.sessionId) {
        logger.warn(
          `Chat ${input.chatId}: no longer bound to session ${input.sessionId} — its late settlement charges nothing ` +
            '(the rebind settled that session when it released it)',
        );

        return { settlement: null, usage, requests, sessionHoursUsd, model };
      }
    }

    const config = getBillingConfig(input.context);
    const billing: BillingRates = { creditUnitCostUsd: config.creditUnitCostUsd, margin: config.margin };
    const stored = await getManagedSettledAt(input.projectId, input.chatId, input.context);
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
      parseCostCursor(stored) ??
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

    if (decided) {
      try {
        /* Cursor FIRST, then the debit: a lost debit under-bills and alerts; the other order double-charges. */
        await setManagedSettledAt(input.projectId, input.chatId, serializeCostCursor(decided.next), input.context);
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
    logger.error(`Generation ${input.generationId}: could not read the session's usage: ${(error as Error)?.message}`);
  }

  if (input.anchorWhenEmpty === false && !charge) {
    return { settlement: null, usage, requests, sessionHoursUsd, model };
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
    usage,
    ...(charge
      ? { flatCredits: charge.credits, rawCostOverrideUsd: charge.trueCostUsd, chargeLabel: MANAGED_CHARGE_LABEL }
      : {}),
    context: input.context,
  });

  return { settlement, usage, requests, sessionHoursUsd, model };
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
 * Rebind a chat whose session is DEAD (`session-health.ts`): bill what the old session still owes, then
 * release the chat's id so the next claim creates a fresh session.
 *
 * A terminated or archived session is still listable, so its unbilled tail is settled first — under its
 * own generation id, never this turn's (one generation, one settlement). A session that is GONE (404)
 * cannot be listed: that tail is unbillable, and it is reported rather than silently dropped.
 */
export async function rebindDeadSession(
  input: Omit<SettleManagedInput, 'anchorWhenEmpty'> & {
    /** `switched`: the chat's session is alive but runs another tier's agent (the user changed tier). */
    reason: 'terminated' | 'archived' | 'missing' | 'switched';
  },
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
      ? input.reason === 'switched'
        ? `Chat ${input.chatId}: the user changed model tier or effort — released session ${input.sessionId}; a new session will be created at the new setting`
        : `Chat ${input.chatId}: released ${input.reason} session ${input.sessionId}; a new session will be created`
      : `Chat ${input.chatId}: ${input.reason} session ${input.sessionId} was already replaced by a concurrent turn`,
  );
}
