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
  model: string;
  provider: string;

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

  /** Set when this is a self-healing repair turn; points at the generation it repairs (§4.2.7). */
  repairOf?: string;
  finishReason?: string;
}

export type CreditGateResult =
  | { allowed: true; mode: 'unmetered' }
  | { allowed: true; mode: 'credits'; balance: number }
  | { allowed: false; mode: 'credits'; balance: number; message: string };

/**
 * Check that a user can afford a generation BEFORE it starts.
 *
 * In-flight generations are never killed for balance (§4.2.1) — this gate runs once, up front.
 * Until the ledger exists there is nothing to debit, so every request is `unmetered`.
 */
export async function checkCreditGate(_userId?: string): Promise<CreditGateResult> {
  // Stage 2 (§4.6): resolve balance from the append-only ledger and block at <= 0 with an upsell.
  return { allowed: true, mode: 'unmetered' };
}

export class GenerationLog {
  private readonly _dir: string;

  constructor(dir?: string) {
    this._dir = dir ?? path.join(platformDataDir(), 'generations');
  }

  async record(entry: Omit<GenerationRecord, 'id' | 'createdAt'>): Promise<GenerationRecord> {
    const createdAt = new Date().toISOString();
    const record: GenerationRecord = {
      id: `gen_${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
      ...entry,
    };

    try {
      await fs.mkdir(this._dir, { recursive: true });
      await fs.writeFile(path.join(this._dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');
    } catch (error) {
      // Never fail a user's generation because we could not write our own bookkeeping.
      logger.error(`Failed to record generation: ${(error as Error).message}`);
    }

    logger.info(
      `Generation ${record.id}: ${record.promptTokens} in (+${record.cacheReadTokens} cached, ` +
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
