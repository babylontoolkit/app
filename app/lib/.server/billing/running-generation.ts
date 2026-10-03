/**
 * A durable record BEFORE spend (`_specs/no-unbilled-usage_plan.md` D2).
 *
 * Until this, a `generations` row was written only at the END of a turn — by `settleGeneration`, in a
 * `finally`. A process that died mid-stream (a deploy, a crash, an OOM, a workerd context torn down) left
 * no row, no usage and no debit: the provider billed us and the ledger never knew. So every model turn —
 * legacy, managed and the prompt enhancer — now opens its row `status: 'running'` before its first provider
 * call, the legacy engine checkpoints its CUMULATIVE usage onto that row after every finished step, and the
 * turn's own settlement finishes the same row (same id, so an upsert, never a second row). A row left
 * `running` past the sweep's stale threshold is a turn whose process died; the sweep (`sweep.ts`, D3) bills
 * it from its last checkpoint as `interrupted` — never refunded.
 *
 * Nothing here throws. A failed open or checkpoint is logged and alerted and the turn PROCEEDS: blocking a
 * paying user's turn on our bookkeeping is the wrong trade, and the end-of-turn settlement still anchors the
 * row — what is lost is only the crash-recovery record, which the alert makes visible.
 */
import type { GenerationUsage } from '~/lib/.server/agent/step-usage';
import { getMonitor, ALERT_SIGNALS } from '~/lib/.server/monitoring';
import { keepAlive } from '~/lib/.server/runtime/keep-alive';
import { createScopedLogger } from '~/utils/logger';
import { settleGeneration, type Settlement } from './gate';
import { getGenerationStore, type GenerationEngine, type GenerationRecord } from './generations';

const logger = createScopedLogger('running-generation');

export interface RunningGenerationInput {
  id: string;
  userId: string;
  model: string;

  /** The gateway that will be billed — required, because the sweep prices the row with it. */
  provider: string;
  engine: GenerationEngine;
  projectId?: string;
  chatId?: string;
  statusKind?: string;
  managedSessionId?: string;
  context?: unknown;
}

/**
 * Open the generation's row as `running`, before the first provider call. `true` when it was written.
 * Never throws (see the module comment).
 */
export async function openRunningGeneration(input: RunningGenerationInput): Promise<boolean> {
  try {
    await getGenerationStore(input.context).upsert({
      id: input.id,
      userId: input.userId,
      model: input.model,
      provider: input.provider,
      engine: input.engine,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.statusKind ? { statusKind: input.statusKind } : {}),
      ...(input.managedSessionId ? { managedSessionId: input.managedSessionId } : {}),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      status: 'running',
      checkpointAt: new Date().toISOString(),
    });

    return true;
  } catch (error) {
    logger.error(
      `Could not open the running row of ${input.id} — if this process dies mid-turn, its usage cannot be ` +
        `recovered: ${(error as Error)?.message}`,
    );
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Generation ${input.id} runs without a durable record: a crash before it settles would lose its usage ` +
        `(${(error as Error)?.message})`,
      { severity: 'warning', scope: 'running-generation', userId: input.userId, tags: { engine: input.engine } },
    );

    return false;
  }
}

export interface UsageCheckpointer {
  /** Record the turn's CUMULATIVE usage so far. Fire-and-forget; serialised; never throws. */
  checkpoint(usage: GenerationUsage, extra?: { toolRounds?: number }): void;

  /**
   * Resolve once every checkpoint issued so far has been written (or failed) — or after `timeoutMs`
   * (default `CHECKPOINT_FLUSH_TIMEOUT_MS`), whichever is first. Never rejects. Bounded because settlement
   * waits on it, and a hung store must never be what keeps a turn from settling (the checkpoint write is
   * guarded on `running`, so one that lands after settlement changes nothing).
   */
  flush(timeoutMs?: number): Promise<void>;
}

/** How long settlement waits for outstanding checkpoints before it settles anyway. */
export const CHECKPOINT_FLUSH_TIMEOUT_MS = 5_000;

/**
 * A serialised checkpoint writer for one running generation (legacy engine, D2).
 *
 * Serialised so two steps' writes can never land out of order — an older total written after a newer one
 * would roll the row's usage BACK, and the sweep would under-bill by exactly the difference. Each write is
 * registered with the runtime (`keepAlive`): under workerd an unregistered promise stops with its request.
 * The store's own guard (`checkpoint` writes only while the row is `running`) means a write that lands
 * after settlement changes nothing.
 */
export function createUsageCheckpointer(input: { id: string; context?: unknown }): UsageCheckpointer {
  let chain: Promise<void> = Promise.resolve();
  let warned = false;

  return {
    checkpoint(usage, extra) {
      const snapshot = {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        ...(extra?.toolRounds !== undefined ? { toolRounds: extra.toolRounds } : {}),
        at: new Date().toISOString(),
      };

      chain = chain.then(async () => {
        try {
          await getGenerationStore(input.context).checkpoint(input.id, snapshot);
        } catch (error) {
          if (!warned) {
            warned = true;
            logger.warn(`Could not checkpoint generation ${input.id}: ${(error as Error)?.message}`);
          }
        }
      });

      void keepAlive(input.context, chain, `checkpoint ${input.id}`);
    },

    flush(timeoutMs = CHECKPOINT_FLUSH_TIMEOUT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`Checkpoints of ${input.id} still pending after ${timeoutMs}ms — settling anyway`);
          resolve();
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      });

      return Promise.race([chain, timeout]).finally(() => clearTimeout(timer));
    },
  };
}

/**
 * Settle a `running` row whose process died (D3 (a), D4): bill the usage of its last checkpoint and end it
 * `interrupted`. NEVER refunded — the provider billed us for every token the checkpoint records, and the
 * user's work up to that step may well have reached their project. A row with no usage writes no ledger row
 * (`decideCredits` charges nothing for nothing) and is simply marked `interrupted`.
 *
 * Never throws (`settleGeneration` alerts its own failures).
 */
export async function settleInterruptedGeneration(
  row: GenerationRecord,
  context?: unknown,
): Promise<Settlement | null> {
  try {
    const store = getGenerationStore(context);

    /*
     * 🔴 CLAIM FIRST (verifier defect B). `markStatus` moves the row `running` → `interrupted` only while it
     * is still `running` — atomic in SQL (`.eq('status', 'running')`), serialised per row on the FS store —
     * so exactly ONE settler wins: the sweep or a delete, never both; and never a sweep that listed a row
     * whose turn has since settled itself (that row is `completed`, the claim fails, nothing is written).
     * A claim that loses debits nothing and writes nothing. Migration 0029 refuses a second debit anyway.
     */
    const claimed = await store.markStatus(row.id, 'interrupted');

    if (!claimed) {
      logger.info(`Generation ${row.id} is no longer running — another settler finished it; nothing to do`);
      return null;
    }

    if (!row.userId) {
      logger.error(`Running generation ${row.id} names no user — it cannot be billed; marked interrupted`);
      return null;
    }

    /* The row as it stands AT the claim — no checkpoint can land after it (they are guarded on `running`). */
    const current = (await store.listByIds([row.id]).catch(() => []))[0] ?? row;

    const usage: GenerationUsage = {
      promptTokens: current.promptTokens ?? 0,
      completionTokens: current.completionTokens ?? 0,
      cacheReadTokens: current.cacheReadTokens ?? 0,
      cacheCreationTokens: current.cacheCreationTokens ?? 0,
      totalTokens: (current.promptTokens ?? 0) + (current.completionTokens ?? 0),
    };

    const settlement = await settleGeneration({
      userId: row.userId,
      generationId: row.id,
      model: row.model,

      /* Every row this module opens names its gateway; an older row without one prices at the default. */
      provider: row.provider ?? 'Anthropic',
      usage,
      statusKind: row.statusKind,
      status: 'interrupted',
      projectId: row.projectId,
      chatId: row.chatId,
      chargeLabel: 'interrupted turn (recovered by the billing sweep)',
      context,
    });

    logger.warn(
      `Generation ${row.id} (${row.engine ?? 'unknown engine'}) was left running — settled from its last checkpoint: ` +
        `${settlement?.creditsCharged ?? 0} credits`,
    );

    return settlement;
  } catch (error) {
    logger.error(`Could not settle interrupted generation ${row.id}: ${(error as Error)?.message}`);
    return null;
  }
}
