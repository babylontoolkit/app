/**
 * Generation recording + the credit gate seam (SPEC §4.2 steps 1 & 6, §4.6).
 *
 * The credit LEDGER itself is Stage 2 (§4.6, spec/billing.md) and depends on Supabase. What lives
 * here is the seam the agent proxy calls, plus the `generations` record that everything downstream
 * (cost badges, per-prompt-version regression charts, per-skill usage) is derived from.
 *
 * With billing unconfigured the gate reports `unmetered` and generation proceeds — the graceful
 * degradation the spec requires (§1.3 principle 0), NOT a stub: the record is written for real, so
 * when the ledger lands it has history to debit against and the call sites do not change.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';
import { platformDataDir } from '~/lib/.server/prompt/store';

const logger = createScopedLogger('agent-usage');

export interface GenerationRecord {
  id: string;
  createdAt: string;
  chatId?: string;

  /** Every generation is attributable to a user — the ledger debit points back at this row (§4.5.4). */
  userId?: string;
  projectId?: string;

  model: string;
  provider: string;

  /** What we actually charged. Zero for BYOK and for unmetered beta mode — but always recorded. */
  creditsCharged?: number;

  /** Raw model spend in USD, before margin. The honest number for the admin cost dashboards (§4.10). */
  rawCostUsd?: number;

  /** Traceability: which synced doc snapshot produced this generation (§4.3.7). */
  promptVersionId: string | null;

  /** Skill fires — slash and auto (§4.11 metrics). */
  skillsLoaded: string[];

  /** On-demand doc blocks routed into this generation. */
  blocksLoaded: string[];

  /**
   * UNCACHED input only. Anthropic reports cached input separately, and `@ai-sdk/anthropic` maps
   * only `input_tokens` here — so this alone systematically under-counts what a generation cost.
   * Billing must read the two cache columns below alongside it (§4.6).
   */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;

  /** Input served from the prompt cache — billed at 0.1x (§4.3.5, a primary margin lever). */
  cacheReadTokens: number;

  /**
   * Input written INTO the cache — paid once per prefix change.
   *
   * **Billed at 2x, NOT 1.25x.** We use the 1-hour cache tier (`ttl: '1h'`, see `proxy.ts`), because
   * the 5-minute default expires while the user is playing the game we just built — turning the cache
   * into a thing we re-create on every turn rather than read. The 1h tier's write premium is the price
   * of that, and it repays itself on the second cached turn.
   *
   * Stage 3's ledger math MUST use 2x here. Assuming the 1.25x default would systematically
   * under-charge every generation (SPEC §4.2.8, §4.6).
   */
  cacheCreationTokens: number;

  /** Tool rounds the server ran inside this generation. */
  toolRounds: number;

  /**
   * Wall-clock for the whole generation.
   *
   * Recorded because "it feels slow" is not actionable and the two causes have opposite fixes:
   * sequential tool rounds (fix: batch the tool calls) vs. decode of a large answer (fix: emit fewer
   * output tokens — caching cannot help, decode is serial at ~60-90 tok/s). With this alongside
   * `completionTokens` and `toolRounds`, the two are told apart by arithmetic instead of by guessing.
   */
  durationMs?: number;

  /**
   * Per-step breakdown of the tool loop — the only way to tell the two latency causes apart.
   *
   * Aggregate numbers hide the thing you need: a generation billed for 44,308 output tokens whose
   * final visible answer was ~9k tokens means ~35k output tokens were spent on steps that produced
   * nothing the user ever saw (re-generated answers after a tool-round cap, abandoned attempts,
   * verbose tool preambles). You cannot see that in a total, and you cannot fix what you cannot see.
   */
  steps?: Array<{
    ms: number;
    outTokens: number;
    inTokens: number;
    cacheRead: number;
    cacheWrite: number;
    tools: string[];
  }>;

  /** Set when this is a self-healing repair turn; points at the generation it repairs (§4.2.7). */
  repairOf?: string;
  finishReason?: string;
}

/**
 * The credit gate now lives with the ledger it reads (`~/lib/.server/billing/gate`). It is
 * re-exported here because the agent proxy has always reached for it through this module, and
 * `checkCreditGate` + `getGenerationLog` are two halves of the same story: gate before, record after.
 */
export { checkCreditGate, settleGeneration, refundGeneration, type CreditGateResult } from '~/lib/.server/billing/gate';

export class GenerationLog {
  private readonly _dir: string;

  constructor(dir?: string) {
    this._dir = dir ?? path.join(platformDataDir(), 'generations');
  }

  /**
   * `id` is optional but usually SUPPLIED by the caller, because the ledger debit references it — the
   * generation id has to exist before we can charge for the generation (§4.5.4: every debit is
   * attributable). We mint one only when nobody cared enough to.
   */
  async record(entry: Omit<GenerationRecord, 'id' | 'createdAt'> & { id?: string }): Promise<GenerationRecord> {
    const createdAt = new Date().toISOString();
    const record: GenerationRecord = {
      ...entry,
      id: entry.id ?? `gen_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
    };

    try {
      await fs.mkdir(this._dir, { recursive: true });
      await fs.writeFile(path.join(this._dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');
    } catch (error) {
      // Never fail a user's generation because we could not write our own bookkeeping.
      logger.error(`Failed to record generation: ${(error as Error).message}`);
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
    let files: string[];

    try {
      files = await fs.readdir(this._dir);
    } catch {
      return [];
    }

    const records: GenerationRecord[] = [];

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        records.push(JSON.parse(await fs.readFile(path.join(this._dir, file), 'utf8')) as GenerationRecord);
      } catch {
        // A corrupt record is not worth failing a listing over.
      }
    }

    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
}

let _log: GenerationLog | undefined;

export function getGenerationLog(): GenerationLog {
  if (!_log) {
    _log = new GenerationLog();
  }

  return _log;
}
