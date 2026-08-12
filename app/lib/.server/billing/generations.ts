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

  /**
   * The gateway that served and billed this generation.
   *
   * ⚠️ OPTIONAL, because "unknown" is a real state and pretending otherwise is what this replaced.
   * Rows written before migration 0021 have no provider on record, and `toGenerationRecord` maps a
   * NULL column to `undefined` rather than substituting a name. It was typed `string` (required)
   * while the mapper hardcoded `'Anthropic'` — the type was satisfied by a fabricated value, and
   * because the row arrives as `any` the compiler could not have caught the difference either way.
   * A reader must handle absence; it must never default.
   */
  provider?: string;

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
   * WHAT KIND of turn this was — `creation` | `repair` | `plan` | `edit` (`statusKindFor`).
   *
   * Recorded because `durationMs` alone cannot answer "how long does a typical edit take?": without
   * this, every duration lands in one undifferentiated pile where a five-minute creation sits beside
   * a seven-second edit. That is not hypothetical — it is why the liveness panel's expectation
   * baseline (`agent/delivery.ts`, 2026-08-03) had to ship as a hand-picked constant.
   *
   * ⚠️ Optional, and an unknown kind stays UNKNOWN. Defaulting it to `edit` (the most common) would
   * silently poison the percentile this field exists to make possible — see migration 0019.
   */
  statusKind?: string;

  /**
   * RAW wire `stop_reason` strings observed during this turn (stop-reason-tap), in order.
   * Exists because `@ai-sdk/anthropic` collapses unrecognized stop reasons (pause_turn, refusal, …)
   * into `finishReason: 'unknown'`, which made the Fable 5 first-build hang undiagnosable (2026-08-06).
   * FS store only — the Supabase store maps named columns and drops it.
   */
  rawStops?: string[];

  /**
   * Refusal-fallback handoffs (`refusal-fallback.ts`), as `from→to` strings: the requested model
   * declined via safety classifier and the named model served the turn on the same stream. The
   * turn bills at the REQUESTED model's rates, so this field is what keeps that visible.
   * FS store only — the Supabase store maps named columns and drops it.
   */
  fallbackHandoffs?: string[];

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

    /**
     * Characters of TEXT this step actually streamed, and of reasoning summary — the only exact way to
     * attribute a step's output.
     *
     * A step's billed `outTokens` is thinking + tool-call JSON + text, and Anthropic reports them as one
     * number. Only `text` can ever reach the user. So `textChars` is what makes "we were billed 44,308
     * output tokens" answerable: at ~3.5–4 chars per token, a step whose text is 36,000 chars spent its
     * budget on the artifact, and a step whose text is 9,000 chars spent ~35k of it somewhere else.
     * Without this the two are indistinguishable in a total, which is exactly how ~35k of output went
     * unexplained.
     */
    textChars?: number;
    reasoningChars?: number;
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

  /**
   * The rows a page of ledger entries points at, by id (SPEC §4.6).
   *
   * Exists so the credits panel can say what a debit was FOR — every generation debit carries the
   * reason `'generation'` (the SQL `CHECK` constraint owns that vocabulary), so the ledger alone
   * renders a creation build, a one-line edit, an auto-repair and a plan as four identical rows
   * labelled "Generation". `status_kind` has recorded the difference on every turn since migration
   * 0019 and nothing has ever read it.
   *
   * Batched deliberately: the alternative is a lookup per row, i.e. up to 100 round trips to decorate
   * one dropdown. Ids not found are simply absent from the result — a ledger row whose generation row
   * has been swept must still render, as itself.
   */
  listByIds(ids: string[]): Promise<GenerationRecord[]>;

  /**
   * Has this project ever had a generation the user was actually CHARGED for? (§4.4a, migration 0015.)
   *
   * The observable definition of "the flat creation charge bought something": the project-create refund
   * on delete asks exactly this. `credits_charged > 0` rather than "a row exists" on purpose — a failed
   * generation is auto-refunded (§4.6), so its row records an attempt the user got nothing for, and
   * treating that as delivery would keep the creation charge for a project that never built anything.
   *
   * A BYOK or unmetered generation charges zero and so reads as "not delivered" — harmless, because
   * neither ever paid the creation charge either (`decideProjectCreateCharge` frees both), so there is
   * nothing to refund and the answer is never consulted.
   */
  hasBilledGeneration(projectId: string): Promise<boolean>;
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

  async hasBilledGeneration(projectId: string): Promise<boolean> {
    /*
     * Local mode has no index to lean on, so this is a directory scan — acceptable because it runs once
     * per project DELETE and never on a hot path. It stops at the first match.
     */
    let files: string[];

    try {
      files = await fs.readdir(this._dir);
    } catch {
      return false;
    }

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(this._dir, file), 'utf8')) as GenerationRecord;

        if (record.projectId === projectId && (record.creditsCharged ?? 0) > 0) {
          return true;
        }
      } catch {
        // A corrupt record cannot prove delivery; keep looking.
      }
    }

    return false;
  }

  async listByIds(ids: string[]): Promise<GenerationRecord[]> {
    const records: GenerationRecord[] = [];

    for (const id of new Set(ids)) {
      try {
        records.push(JSON.parse(await fs.readFile(this._file(id), 'utf8')) as GenerationRecord);
      } catch {
        /* Missing or corrupt: the caller renders the ledger row undecorated rather than not at all. */
      }
    }

    return records;
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

        /*
         * ⚠️ `?? null` and NOT `?? 'Anthropic'`. Every field in this payload is optional because
         * `undefined` means "not known yet" and must not clobber an earlier upsert — but a DEFAULT
         * here would be worse than absent: it would record a gateway that did not serve the turn,
         * indistinguishable from one that did. Migration 0021 leaves history NULL for the same reason.
         */
        provider: row.provider ?? null,
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

        /* NULL when unknown — never defaulted, or the percentile this enables is poisoned (0019). */
        status_kind: row.statusKind ?? null,
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

  async hasBilledGeneration(projectId: string): Promise<boolean> {
    const db = await createAdminClient(this._context);
    const { data, error } = await db
      .from('generations')
      .select('id')
      .eq('project_id', projectId)
      .gt('credits_charged', 0)
      .limit(1);

    /*
     * A read failure must answer TRUE, not false: the caller uses this to decide whether to hand credits
     * BACK, so an outage that reads as "nothing was ever built" refunds projects that were. Failing
     * closed here costs a user one refund they can ask for; failing open pays out on every deletion.
     */
    if (error) {
      logger.warn(`Could not check billed generations for project ${projectId}: ${error.message}`);
      return true;
    }

    return (data ?? []).length > 0;
  }

  async listByIds(ids: string[]): Promise<GenerationRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const db = await createAdminClient(this._context);
    const { data, error } = await db
      .from('generations')
      .select()
      .in('id', [...new Set(ids)]);

    if (error) {
      /*
       * A DECORATION, never the row itself. This lookup only adds a label and a savings figure to a
       * ledger entry the caller already has, so an outage here must degrade to plain rows — the
       * balance and the history are what that panel exists for, and neither depends on this.
       */
      logger.warn(`Could not load generations for the ledger view: ${error.message}`);
      return [];
    }

    return (data ?? []).map(toGenerationRecord);
  }

  async list(limit = 100): Promise<GenerationRecord[]> {
    const db = await createAdminClient(this._context);
    const { data } = await db.from('generations').select().order('created_at', { ascending: false }).limit(limit);

    return (data ?? []).map(toGenerationRecord);
  }
}

/*
 * The one row -> record mapping. It was inline in `list()`; a second reader (`listByIds`) made a
 * second copy the obvious move, and two mappings of one table drift silently — a column read by one
 * caller and not the other looks like a feature that works on some screens.
 *
 * ✅ `provider` is a REAL COLUMN as of migration 0021 (2026-08-11). It was hardcoded to `'Anthropic'`
 * since this store was written, so a Postgres deploy reported every row as Anthropic — confidently
 * wrong rather than absent, on the one view an operator would use to check a gateway cutover.
 *
 * ⚠️ **NULL means UNKNOWN, and must never be read as a default.** Rows written before the column
 * existed have no gateway on record; `settleGeneration` had always been handed one and always PRICED
 * with it, but never stored it. `undefined` is the honest value for those, and a reader that
 * substitutes a provider name re-creates exactly the defect this replaced.
 */
function toGenerationRecord(r: any): GenerationRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    userId: r.user_id,
    projectId: r.project_id ?? undefined,
    model: r.model,
    provider: r.provider ?? undefined,
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
    statusKind: r.status_kind ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    finishReason: r.finish_reason ?? undefined,
    repairOf: r.repair_of ?? undefined,
    steps: r.steps ?? undefined,
    status: r.status,
    error: r.error ?? undefined,
  };
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
