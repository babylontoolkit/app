/**
 * Unity Bridge billing (SPEC §4.17, §4.6, `spec/billing.md`, `spec/fail-loud.md`) — the money path for
 * operations run on the user's own machine.
 *
 * The billing shape is the MEDIA shape (`media/service.ts`), not the LLM one: the price is exact before
 * anything runs (config, D11), so:
 *
 *   price → anchor (generations row, id = the job id, D12) → DEBIT (reason 'bridge', never negative,
 *   D10) → dispatch
 *
 * Four terminal states (`spec/fail-loud.md`):
 *   - delivered — the helper reported `started`; the charge stands whatever the result (D13);
 *   - refused before spend — insufficient balance with billing enforced: `BridgeRefusedError(402)`,
 *     nothing debited, nothing dispatched;
 *   - failed after debit — never started (pickup timeout, cancel, revoke, generation end, helper
 *     refusal): refunded EXACTLY ONCE by `refundBridgeJob`, which only `settleNotStarted` (service.ts)
 *     calls. The refund note is exactly `bridge:<jobId>` — migration 0025's partial unique index keys
 *     on it, so a second refund is a unique violation, logged as "already recorded", never alerted;
 *   - a refund that cannot land — `LEDGER_INTEGRITY` alert, never a throw.
 *
 * Unmetered mode (billing not enforced) records the debit when the balance covers it and otherwise
 * charges nothing — it must not block and must not overdraw. The job row stores what was ACTUALLY
 * debited, so a zero-debit job never writes a refund.
 */
import { createScopedLogger } from '~/utils/logger';
import { envNumber } from '~/lib/.server/env';
import { DuplicateRefundError, getLedger } from '~/lib/.server/billing/ledger';
import { getGenerationStore } from '~/lib/.server/billing/generations';
import { getBillingConfig } from '~/lib/.server/billing/rates';
import { getMonitor } from '~/lib/.server/monitoring';
import { ALERT_SIGNALS } from '~/lib/.server/monitoring/events';
import { recordRefundOutcome } from '~/lib/.server/monitoring/paid-path-rates';
import { DEFAULT_BRIDGE_PRICES, type BridgePrices } from '~/lib/bridge/pricing';
import { BridgeRefusedError } from './auth';

const logger = createScopedLogger('bridge.billing');

/**
 * One price, sanitised like `projectCreateCredits` (`billing/rates.ts`): `0` is a real value (free), a
 * negative or non-finite override is IGNORED in favour of the default — obeying a negative would CREDIT
 * the user for every operation.
 */
function price(context: unknown, key: string, fallback: number): number {
  const configured = envNumber(context, key, fallback);

  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : fallback;
}

export function bridgePrices(context: unknown): BridgePrices {
  return {
    command: price(context, 'BRIDGE_COMMAND_CREDITS', DEFAULT_BRIDGE_PRICES.command),
    script: price(context, 'BRIDGE_SCRIPT_CREDITS', DEFAULT_BRIDGE_PRICES.script),
    job: price(context, 'BRIDGE_JOB_CREDITS', DEFAULT_BRIDGE_PRICES.job),
  };
}

/** The refund's EXACT note — migration 0025's partial unique index keys on it (D13 latch 2). */
export const bridgeRefundNote = (jobId: string) => `bridge:${jobId}`;

/**
 * Anchor, then debit. Throws `BridgeRefusedError(402)` when billing is enforced and the balance does not
 * cover the price; otherwise returns what was actually debited (0 when unmetered and the append failed).
 */
export async function anchorAndDebit(input: {
  jobId: string;
  userId: string;
  projectId: string;
  credits: number;
  label: string;
  context: unknown;
}): Promise<{ debited: number }> {
  /*
   * The FK anchor, before the debit — `credit_ledger.generation_id` references `generations(id)`.
   * Without the row Postgres rejects the debit and the catch would read as "insufficient credits".
   */
  await getGenerationStore(input.context).upsert({
    id: input.jobId,
    userId: input.userId,
    projectId: input.projectId,
    model: 'unity-bridge',
    provider: 'bridge',
    creditsCharged: input.credits,
    rawCostUsd: 0,
    status: 'running',
  });

  try {
    await getLedger(input.context).append({
      userId: input.userId,
      delta: -input.credits,
      reason: 'bridge',
      generationId: input.jobId,
      note: input.label.slice(0, 160),
    });

    return { debited: input.credits };
  } catch (error) {
    if (getBillingConfig(input.context).enforced) {
      throw new BridgeRefusedError('Not enough credits', 402);
    }

    logger.warn(`Unmetered bridge job ${input.jobId} not debited (${(error as Error).message}) — proceeding.`);

    return { debited: 0 };
  }
}

/**
 * The compensating row for a job that never started. ONLY `settleNotStarted` (service.ts) calls this —
 * one refund writer (D13). Never throws.
 */
export async function refundBridgeJob(input: {
  jobId: string;
  userId: string;
  credits: number;
  reason: string;
  context: unknown;
}): Promise<void> {
  if (input.credits <= 0) {
    return;
  }

  try {
    await getLedger(input.context).append({
      userId: input.userId,
      delta: input.credits,
      reason: 'refund',
      generationId: input.jobId,
      note: bridgeRefundNote(input.jobId),
    });
    logger.info(`Refunded ${input.credits} credits to ${input.userId} for bridge job ${input.jobId} (${input.reason})`);
  } catch (error) {
    const message = (error as Error).message ?? String(error);

    /*
     * Latch 2 fired: the refund is already on the ledger. That is the SUCCESS path, not an incident.
     * Both backends raise `DuplicateRefundError` for a `bridge:` note (`isSingleRefundNote`); the raw
     * unique-violation text is kept as a fallback for a store that surfaces the Postgres error as-is.
     */
    if (error instanceof DuplicateRefundError || /duplicate key|unique/i.test(message)) {
      logger.info(`bridge refund for ${input.jobId} already recorded`);
      return;
    }

    // The user paid for an operation that never ran. Nothing downstream can see this — so alert.
    logger.error(`FAILED TO REFUND bridge job ${input.jobId}: ${message}`);
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Refund of ${input.credits} credits for bridge job ${input.jobId} did NOT land — the user is still ` +
        `charged for an operation that never ran: ${message}`,
      {
        severity: 'critical',
        scope: 'bridge-refund',
        userId: input.userId,
        tags: { jobId: input.jobId, credits: input.credits },
      },
    );
  }

  recordRefundOutcome(getMonitor(input.context), 'bridge', true);
}
