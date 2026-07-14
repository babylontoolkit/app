/**
 * The `generations` row — the thing every ledger debit POINTS AT (SPEC §4.6, §4.5.4).
 *
 * This module exists because of one line of SQL:
 *
 * ```sql
 * generation_id text references public.generations(id) on delete set null
 * ```
 *
 * `credit_ledger.generation_id` is a FOREIGN KEY. Postgres will not accept a debit whose generation
 * row does not exist yet — it raises `23503 foreign_key_violation`. And `settleGeneration` is (by
 * design, §4.6) forbidden from throwing: it catches, logs, and returns null. Put those two facts
 * together and a missing generation row does not crash, does not fail a build, and does not break a
 * single feature — it just means **every generation on the platform bills zero, forever**, and we eat
 * the entire model spend. That is the most expensive silent failure in the codebase.
 *
 * So the row is written BEFORE the debit, at the same choke point as the debit (`gate.ts`), and every
 * caller that settles gets the anchor for free rather than having to remember the ordering.
 *
 * Writes are UPSERTS: settlement anchors a minimal row up front, and the agent proxy fills in the
 * rich fields (skills, prompt version, per-step timings) once the generation is done.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '~/utils/logger';
import { platformDataDir } from '~/lib/.server/prompt/store';
import { createAdminClient, isSupabaseConfigured } from '~/lib/.server/supabase/client';

const logger = createScopedLogger('generations');

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
   * The ledger math MUST use 2x here. Assuming the 1.25x default would systematically under-charge
   * every generation (SPEC §4.2.8, §4.6).
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

  /** `running` is what settlement anchors; the proxy resolves it to `completed` / `failed`. */
  status?: 'running' | 'completed' | 'failed';
  error?: string;
}

/** An upsert. Only the identity fields are required — everything else fills in as it becomes known. */
export type GenerationUpsert = Partial<GenerationRecord> & { id: string; userId: string; model: string };

export interface GenerationStore {
  /** Create or update the row. MUST have completed before a ledger debit naming this id is appended. */
  upsert(row: GenerationUpsert): Promise<void>;

  list(limit?: number): Promise<GenerationRecord[]>;
}

/*
 * ---------------------------------------------------------------------------------------------
 * Filesystem (local mode)
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Local mode has no foreign key to satisfy, but it writes the row anyway — because the point of local
 * mode is that the money path is exercised for REAL (see `auth.ts`), and a store that no-ops locally
 * would mean the ordering bug above is only ever reachable in production.
 */
export class FsGenerationStore implements GenerationStore {
  private readonly _dir: string;

  constructor(dir?: string) {
    this._dir = dir ?? path.join(platformDataDir(), 'generations');
  }

  private _file(id: string): string {
    // The id becomes a filename — never let one traverse.
    return path.join(this._dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  async upsert(row: GenerationUpsert): Promise<void> {
    try {
      await fs.mkdir(this._dir, { recursive: true });

      // Read-merge-write: settlement anchors first, the proxy enriches after. Neither may clobber.
      let existing: Partial<GenerationRecord> = {};

      try {
        existing = JSON.parse(await fs.readFile(this._file(row.id), 'utf8'));
      } catch {
        // First write for this generation.
      }

      const merged = { createdAt: new Date().toISOString(), ...existing, ...row };
      await fs.writeFile(this._file(row.id), JSON.stringify(merged, null, 2), 'utf8');
    } catch (error) {
      // Never fail a user's generation because we could not write our own bookkeeping.
      logger.error(`Failed to record generation ${row.id}: ${(error as Error).message}`);
    }
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

    return records.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, limit);
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Postgres (production) — the backend the foreign key actually lives in
 * ---------------------------------------------------------------------------------------------
 */

export class SupabaseGenerationStore implements GenerationStore {
  constructor(private readonly _context?: unknown) {}

  async upsert(row: GenerationUpsert): Promise<void> {
    const db = await createAdminClient(this._context);

    /*
     * The diagnostics columns (`tool_rounds`, `duration_ms`, `finish_reason`, `repair_of`, `steps`)
     * are what let us answer WHY a generation was expensive, not merely THAT it was — see migration
     * 0002 and `spec/context-budget.md` §"Wasted tokens and dead time". They arrive on the enrichment
     * write (the proxy, once the generation is over), not on the settlement anchor, which is why every
     * field here is optional: `undefined` means "not known yet", and must not clobber a value an
     * earlier upsert already wrote.
     */
    const { error } = await db.from('generations').upsert(
      {
        id: row.id,
        user_id: row.userId,
        project_id: row.projectId ?? null,
        message_id: row.chatId ?? null,
        model: row.model,
        prompt_version_id: row.promptVersionId ?? null,
        input_tokens: row.promptTokens ?? 0,
        cached_input_tokens: row.cacheReadTokens ?? 0,
        cache_write_tokens: row.cacheCreationTokens ?? 0,
        output_tokens: row.completionTokens ?? 0,
        skills_loaded: row.skillsLoaded ?? [],
        credits_charged: row.creditsCharged ?? 0,
        raw_cost_usd: row.rawCostUsd ?? 0,
        status: row.status ?? 'completed',
        error: row.error ?? null,

        // Diagnostics (migration 0002).
        tool_rounds: row.toolRounds ?? 0,
        duration_ms: row.durationMs ?? null,
        finish_reason: row.finishReason ?? null,
        repair_of: row.repairOf ?? null,
        steps: row.steps ?? null,
      },
      { onConflict: 'id' },
    );

    if (error) {
      /*
       * LOUD. If this fails, the ledger debit that follows will fail too (foreign key), and the
       * generation will silently bill zero. This log line is the only thing standing between that and
       * an invisible month of free generations.
       */
      logger.error(`FAILED TO WRITE generation row ${row.id} — the ledger debit will be REJECTED: ${error.message}`);
      throw new Error(`Generation row write failed: ${error.message}`);
    }
  }

  async list(limit = 100): Promise<GenerationRecord[]> {
    const db = await createAdminClient(this._context);
    const { data } = await db.from('generations').select().order('created_at', { ascending: false }).limit(limit);

    return (data ?? []).map(
      (r: any): GenerationRecord => ({
        id: r.id,
        createdAt: r.created_at,
        userId: r.user_id,
        projectId: r.project_id ?? undefined,
        model: r.model,
        provider: 'Anthropic',
        creditsCharged: r.credits_charged,
        rawCostUsd: Number(r.raw_cost_usd),
        promptVersionId: r.prompt_version_id,
        skillsLoaded: r.skills_loaded ?? [],
        blocksLoaded: [],
        promptTokens: r.input_tokens,
        completionTokens: r.output_tokens,
        totalTokens: r.input_tokens + r.output_tokens,
        cacheReadTokens: r.cached_input_tokens,
        cacheCreationTokens: r.cache_write_tokens,
        toolRounds: r.tool_rounds ?? 0,
        durationMs: r.duration_ms ?? undefined,
        finishReason: r.finish_reason ?? undefined,
        repairOf: r.repair_of ?? undefined,
        steps: r.steps ?? undefined,
        status: r.status,
        error: r.error ?? undefined,
      }),
    );
  }
}

let _store: GenerationStore | undefined;

export function getGenerationStore(context?: unknown): GenerationStore {
  if (!_store) {
    _store = isSupabaseConfigured(context) ? new SupabaseGenerationStore(context) : new FsGenerationStore();
  }

  return _store;
}

/** Test seam. */
export function setGenerationStore(store: GenerationStore | undefined) {
  _store = store;
}
