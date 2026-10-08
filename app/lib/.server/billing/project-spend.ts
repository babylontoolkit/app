/**
 * What creating a project cost, in total, at the moment its first build finished (owner, 2026-10-04:
 * *"some end of project creation system message of the total cost of initial project creation"* —
 * replacing the running "~N credits so far" in the status panel).
 *
 * The total is everything the ledger charged THIS project up to now: the flat `project_create` fee, every
 * build turn, every media render, net of their refunds. Called when the first build finishes, so "up to
 * now" IS the creation. Read-only — it writes nothing and is never a balance.
 *
 * The ledger is indexed by user, not project, so the project is joined through the generation rows
 * (every `generation`/`media`/`refund` row carries a `generationId`, and every generation row carries
 * its `projectId`); the create fee has no generation and is found by its exact audit note.
 */
import { createScopedLogger } from '~/utils/logger';
import { getGenerationStore } from './generations';
import { getLedger, type LedgerEntry } from './ledger';
import { projectCreateNote } from './project-create-service';

const logger = createScopedLogger('project-spend');

/** Plenty for one creation (create fee + a handful of turns + renders); older rows predate the project. */
const RECENT_ROWS = 500;

/**
 * Net credits charged to the project across `entries`: debits minus refunds, never below zero. Pure.
 *
 * A row counts when it is the project's create fee (or its refund — both carry the note) or when its
 * generation belongs to the project. Grants, purchases and admin adjustments carry neither and never count.
 */
export function sumProjectSpend(input: {
  entries: readonly LedgerEntry[];
  projectId: string;
  projectGenerationIds: ReadonlySet<string>;
}): number {
  const note = projectCreateNote(input.projectId);
  let delta = 0;

  for (const entry of input.entries) {
    const belongs =
      entry.note === note || (entry.generationId !== undefined && input.projectGenerationIds.has(entry.generationId));

    if (belongs) {
      delta += entry.delta;
    }
  }

  return Math.max(0, -delta);
}

/**
 * The project's total spend so far, or `null` when it cannot be read. Never throws — this decorates a
 * banner and must never fail the turn that is finishing.
 */
export async function readProjectSpend(input: {
  userId: string;
  projectId: string;
  context?: unknown;
}): Promise<number | null> {
  try {
    const ledger = getLedger(input.context);
    const [recent, createRows] = await Promise.all([
      ledger.list(input.userId, RECENT_ROWS),
      ledger.listByNote(input.userId, projectCreateNote(input.projectId)),
    ]);

    const ids = [...new Set(recent.map((e) => e.generationId).filter((id): id is string => Boolean(id)))];
    const generations = ids.length > 0 ? await getGenerationStore(input.context).listByIds(ids) : [];
    const projectGenerationIds = new Set(generations.filter((g) => g.projectId === input.projectId).map((g) => g.id));

    /* The create fee can be older than the recent page; `listByNote` finds it exactly. De-duplicated by id. */
    const byId = new Map<string, LedgerEntry>();

    for (const entry of [...recent, ...createRows]) {
      byId.set(entry.id, entry);
    }

    return sumProjectSpend({ entries: [...byId.values()], projectId: input.projectId, projectGenerationIds });
  } catch (error) {
    logger.warn(`Could not total spend for project ${input.projectId}: ${(error as Error)?.message}`);
    return null;
  }
}
