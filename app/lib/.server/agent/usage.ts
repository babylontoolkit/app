/**
 * Generation recording + the credit gate seam (SPEC §4.2 steps 1 & 6, §4.6).
 *
 * The `generations` ROW itself — and the foreign key the ledger holds on it — lives in
 * `~/lib/.server/billing/generations`, next to the ledger that depends on it. What lives here is the
 * seam the agent proxy calls: mint an id, persist the rich record, and log the one line that tells us
 * whether a slow generation was slow because of tool rounds or because of decode.
 *
 * With billing unconfigured the gate reports `unmetered` and generation proceeds — the graceful
 * degradation the spec requires (§1.3 principle 0), NOT a stub: the record is written for real, so
 * when the ledger lands it has history to debit against and the call sites do not change.
 */
import { createScopedLogger } from '~/utils/logger';
import { getGenerationStore, type GenerationRecord, type GenerationUpsert } from '~/lib/.server/billing/generations';

const logger = createScopedLogger('agent-usage');

export type { GenerationRecord } from '~/lib/.server/billing/generations';

/**
 * The credit gate now lives with the ledger it reads (`~/lib/.server/billing/gate`). It is
 * re-exported here because the agent proxy has always reached for it through this module, and
 * `checkCreditGate` + `getGenerationLog` are two halves of the same story: gate before, record after.
 */
export { checkCreditGate, settleGeneration, refundGeneration, type CreditGateResult } from '~/lib/.server/billing/gate';

export class GenerationLog {
  constructor(private readonly _context?: unknown) {}

  /**
   * `id` is optional but usually SUPPLIED by the caller, because the ledger debit references it — the
   * generation id has to exist before we can charge for the generation (§4.5.4: every debit is
   * attributable). We mint one only when nobody cared enough to.
   *
   * This is an UPSERT. Settlement has already anchored a minimal row under this id (it must — see
   * `generations.ts`); this call enriches it with everything the row could not know until the
   * generation finished.
   */
  async record(entry: Omit<GenerationRecord, 'id' | 'createdAt'> & { id?: string }): Promise<GenerationRecord> {
    const createdAt = new Date().toISOString();
    const record: GenerationRecord = {
      ...entry,
      id: entry.id ?? `gen_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
    };

    /*
     * NEVER throws. This is the ENRICHMENT write, and the proxy awaits it inside a `finally` — so an
     * exception here would escape and replace the outcome of an otherwise successful generation with a
     * spurious error the user cannot act on. Settlement has already happened by this point (the debit's
     * FK anchor is written in `settleGeneration`, not here), so a failure costs us diagnostics, never
     * money. Loud in the log, silent to the user.
     */
    if (record.userId) {
      try {
        await getGenerationStore(this._context).upsert(record as GenerationUpsert);
      } catch (error) {
        logger.error(`Failed to enrich generation ${record.id}: ${(error as Error).message}`);
      }
    }

    /*
     * The decode rate is the punchline. Output tokens leave the model serially, so a generation that
     * writes 44k tokens simply CANNOT finish in under several minutes — and seeing tok/s next to the
     * wall-clock is what stops us from trying to cache our way out of a decode problem.
     */
    const seconds = (record.durationMs ?? 0) / 1000;
    const timing = record.durationMs
      ? `${seconds.toFixed(1)}s (${(record.completionTokens / Math.max(seconds, 0.001)).toFixed(0)} out tok/s), `
      : '';

    logger.info(
      `Generation ${record.id}: ${timing}${record.promptTokens} in (+${record.cacheReadTokens} cached, ` +
        `${record.cacheCreationTokens} written) / ${record.completionTokens} out, ` +
        `${record.toolRounds} tool rounds, finish=${record.finishReason}, ` +
        `skills=[${record.skillsLoaded.join(',')}]`,
    );

    return record;
  }

  async list(limit = 100): Promise<GenerationRecord[]> {
    return getGenerationStore(this._context).list(limit);
  }
}

export function getGenerationLog(context?: unknown): GenerationLog {
  return new GenerationLog(context);
}
