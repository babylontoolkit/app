/**
 * Taking (and giving back) the flat New Project charge (SPEC §4.4a, §4.6, `spec/billing.md`,
 * `spec/fail-loud.md`).
 *
 * The pure decision lives in `project-create.ts`; this is the half that touches the ledger. Kept apart
 * because the decision is the money rule and the I/O is not — the same split as `decideCredits` vs
 * `settleGeneration`.
 *
 * ## The four terminal states (`spec/fail-loud.md` §"When you add a paid path")
 *
 * - **Refused** — `quoteProjectCreate` returns `{ok: false}` and the route 402s. Nothing is provisioned
 *   and no ledger row is written. This is the ONLY thing permitted to stop a creation, and it is
 *   permitted precisely because it happens before there is anything to leave half-made.
 * - **Delivered** — the project row is created, then one `project_create` debit names it.
 * - **Free** — the price is 0, the caller is BYOK, or billing is unmetered. No row: a zero-value ledger
 *   entry is noise in an audit, not evidence.
 * - **Refunded** — `refundProjectCreate`, when a project is deleted having never had a generation the
 *   user was charged for. Compensating `refund` row, never an edit (the ledger is append-only).
 *
 * 🔴 **The REFUSAL must land before the project row exists, and the refund must run on the SERVER's
 * delete path.** The client's `rollbackRegisteredProject` is fire-and-forget and never rejects, so a
 * refund hung off it is a refund that can silently not happen. The debit itself lands just after the row
 * (it needs the id to be attributable) and rolls the row back if the ledger refuses it.
 */
import { DuplicateRefundError, getLedger } from './ledger';
import { ALERT_SIGNALS, getMonitor } from '~/lib/.server/monitoring';
import { getGenerationStore } from './generations';
import { getBillingConfig } from './rates';
import { decideProjectCreateCharge } from './project-create';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('project-create-billing');

/**
 * The audit note, and the ONLY link between a `project_create` row and the project it paid for.
 *
 * `credit_ledger` has no project column and `generation_id` is null for this reason (there is no
 * generation), so the note is what makes the charge attributable — and what the refund path matches on.
 * Machine-readable prefix first so a scan cannot mistake it for prose.
 */
export function projectCreateNote(projectId: string): string {
  return `project_create:${projectId}`;
}

export type ProjectCreateQuote =
  | { ok: true; charge: number; balance: number }
  | { ok: false; message: string; balance: number };

/**
 * Step 1 — can this user create a project, and what does it cost?
 *
 * Deliberately separate from the debit, because the two happen either side of `store.create`: a refusal
 * must leave NOTHING behind (so it has to run before the row exists), while the debit's audit note is
 * the project id (which only exists after). Ordering the route any other way trades one of those two
 * properties away.
 */
export async function quoteProjectCreate(input: {
  userId: string;
  byok?: boolean;
  context?: unknown;
}): Promise<ProjectCreateQuote> {
  const config = getBillingConfig(input.context);
  const balance = await getLedger(input.context).balance(input.userId);

  const decision = decideProjectCreateCharge({
    credits: config.projectCreateCredits,
    balance,
    enforced: config.enforced,
    byok: input.byok,
  });

  if (decision.refuse) {
    logger.info(`Refused project creation for ${input.userId}: ${decision.message}`);
    return { ok: false, message: decision.message!, balance };
  }

  return { ok: true, charge: decision.charge, balance };
}

/**
 * Step 2 — take the quoted charge, now that the project has an id to attribute it to.
 *
 * Returns the post-charge balance so the caller can hand it back on the response: a settled charge the
 * UI cannot see reads to the user as a leak (the enhancer's drifted-balance defect, CLAUDE.md).
 *
 * THROWS if the ledger refuses (a concurrent debit landed between the quote and here, and
 * `project_create` may not overdraw). The caller must undo the project row on that path — an unpaid
 * project is the one outcome worse than a refused one, because nothing later will ever notice it.
 */
export async function debitProjectCreate(input: {
  userId: string;
  projectId: string;
  charge: number;
  context?: unknown;
}): Promise<number | undefined> {
  if (input.charge <= 0) {
    return undefined;
  }

  const row = await getLedger(input.context).append({
    userId: input.userId,
    delta: -input.charge,
    reason: 'project_create',
    note: projectCreateNote(input.projectId),
  });

  logger.info(`Charged ${input.charge} credits to ${input.userId} for project ${input.projectId}`);

  return row.balanceAfter;
}

/**
 * Give the creation charge back when a project is deleted having never delivered a build.
 *
 * "Delivered" is `hasBilledGeneration` — a generation the user was actually charged for. A generation
 * that FAILED was already auto-refunded (§4.6), so it bought nothing and must not keep the creation
 * charge alive.
 *
 * 🔴 **Idempotency is ENFORCED IN THE DATABASE, and must stay there.** The tempting argument — "`requireOwnedProject`
 * 404s once the row is gone, so a second DELETE never reaches here" — is true only when `store.delete`
 * SUCCEEDED. It does not hold for the two reachable failures, and both pay the user real money:
 *
 *   1. `store.delete` throws (a DB blip). The dashboard toasts "Failed to delete project" and LEAVES
 *      THE CARD IN PLACE, so the user's natural next action is to click Delete again — and that click
 *      refunds them a second time. A credit faucet reachable by repeating a failed delete.
 *   2. Two concurrent DELETEs. Nothing on this path serialises them.
 *
 * So: the refund is appended only AFTER the project row is actually gone (the caller's ordering), and
 * uniqueness is enforced STRUCTURALLY — migration 0015's partial unique index on
 * `(user_id, note) where reason = 'refund' and note like 'project\_create:%'`, surfacing as
 * `DuplicateRefundError`, which is this function's SUCCESS path. The ordering closes (1) and the index
 * closes (2); neither closes both, so keep both. ⚠️ The read below is a fast path, NOT the guarantee —
 * do not delete the index and lean on it, that is the read-then-write race CLAUDE.md forbids on money.
 *
 * The charge is found by an EXACT note lookup, never by scanning a page of recent rows: a heavy user's
 * creation row falls off the end of any window, so a paged scan silently declines to refund exactly the
 * users with the most history.
 *
 * Best-effort by design — a refund failure must not make a project undeletable (the user pressed
 * Delete) — but LOUD, never swallowed: the ledger is the only record that the money moved.
 */
export async function refundProjectCreate(input: {
  userId: string;
  projectId: string;
  context?: unknown;
}): Promise<number> {
  try {
    if (await getGenerationStore(input.context).hasBilledGeneration(input.projectId)) {
      return 0;
    }

    const note = projectCreateNote(input.projectId);
    const ledger = getLedger(input.context);
    const related = await ledger.listByNote(input.userId, note);

    const charge = related.find((entry) => entry.reason === 'project_create');

    if (!charge) {
      return 0;
    }

    // Fast path only. The index below is what actually makes this true under concurrency.
    if (related.some((entry) => entry.reason === 'refund')) {
      logger.info(`Project ${input.projectId} was already refunded; not refunding again.`);
      return 0;
    }

    await ledger.append({
      userId: input.userId,
      delta: Math.abs(charge.delta),
      reason: 'refund',
      note,
    });

    logger.info(
      `Refunded ${Math.abs(charge.delta)} credits to ${input.userId} for undelivered project ${input.projectId}`,
    );

    return Math.abs(charge.delta);
  } catch (error) {
    /* The index caught a concurrent delete. The user has their credits back — that IS the success path. */
    if (error instanceof DuplicateRefundError) {
      return 0;
    }

    /*
     * LOUD, and ALERTED — not merely logged.
     *
     * The project is gone and the user is down the creation price with no automatic path back, so this
     * is the platform keeping money for work it did not deliver. A `logger.error` is invisible in a
     * deployed environment, which is exactly why `settleGeneration` and `refundGeneration` alert here
     * too (`spec/fail-loud.md` rule 4: if nobody is told, nobody ever finds out).
     */
    logger.error(
      `FAILED TO REFUND project creation for ${input.projectId} (user ${input.userId}): ${(error as Error)?.message}`,
    );
    getMonitor(input.context).alert(
      ALERT_SIGNALS.LEDGER_INTEGRITY,
      `Project ${input.projectId} was deleted without delivering a build, and its creation charge could ` +
        `not be refunded: ${(error as Error)?.message}`,
      {
        severity: 'critical',
        scope: 'refund-project-create',
        userId: input.userId,
        tags: { projectId: input.projectId },
      },
    );

    return 0;
  }
}
