/**
 * Pricing and settling ONE prompt-enhancement session (`_specs/managed-only_plan.md` D9, D10).
 *
 * Its own module because two callers need it and one of them sits below the other: the enhancer
 * (`enhance.ts`) settles its session when the turn ends, and the billing sweep (`billing/sweep.ts`) settles
 * the session of an enhancement whose process died — and `enhance.ts` imports the sweep (to start it lazily),
 * so the sweep importing `enhance.ts` would be a cycle.
 *
 * The session is billed WHOLE and ONCE: the managed engine's own `sessionCost` over every thread, then
 * `decideManagedCharge` against an EMPTY cursor (an enhancement session serves one request), settled through
 * `settleGeneration` with `flatCredits` + `rawCostOverrideUsd`. The debit is idempotent by generation id
 * (migration 0029), so the turn's own settlement and a sweep's can never both charge.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { settleGeneration, type Settlement } from '~/lib/.server/billing/gate';
import { getBillingConfigSafe, ratesFor } from '~/lib/.server/billing/rates';
import { createScopedLogger } from '~/utils/logger';
import {
  decideManagedCharge,
  EMPTY_COST_CURSOR,
  listCostCents,
  sessionCost,
  tokensOf,
  type ApiUsageLike,
  type ThreadUsage,
} from './session-cost';
import { sessionModel } from './session-health';
import { MANAGED_CHARGE_LABEL } from './settle';

const logger = createScopedLogger('managed-enhance-settle');

/** How many times an EMPTY usage read is retried after the turn ends (the usage can land a moment late). */
const USAGE_READ_ATTEMPTS = 4;
const USAGE_READ_DELAY_MS = 500;

/**
 * The session's cumulative usage across every thread, priced (`session-cost.ts`). `null` when the session
 * cannot be read. Shared with the billing sweep's recovery of a dead enhancement (D10).
 */
export async function priceEnhancementSession(input: {
  client: Anthropic;
  sessionId: string;
  model: string;
  sessionHourUsd: number;
  context?: unknown;
}): Promise<{ cost: ReturnType<typeof sessionCost>; model: string; status?: string } | null> {
  try {
    const session = await input.client.beta.sessions.retrieve(input.sessionId);
    const threads: ThreadUsage[] = [];

    for await (const thread of input.client.beta.sessions.threads.list(input.sessionId)) {
      const model = (thread.agent as { model?: { id?: unknown } } | undefined)?.model?.id;

      threads.push({
        id: thread.id,
        model: typeof model === 'string' && model ? model : input.model,
        tokens: thread.usage ? tokensOf(thread.usage as ApiUsageLike) : null,
      });
    }

    const usage = (session as { usage?: ApiUsageLike }).usage;
    const model = sessionModel(session) ?? input.model;

    return {
      cost: sessionCost({
        threads,
        sessionTokens: tokensOf(usage),
        activeSeconds: Number(usage?.active_seconds ?? 0) || 0,
        listCostCents: listCostCents(usage),
        fallbackModel: model,
        ratesOf: (m) => ratesFor(m, 'Anthropic', input.context),
        sessionHourUsd: input.sessionHourUsd,
      }),
      model,
      status: (session as { status?: string }).status,
    };
  } catch (error) {
    logger.error(`Could not read enhancement session ${input.sessionId}: ${(error as Error)?.message}`);
    return null;
  }
}

/**
 * Settle one enhancement session under `generationId` — the whole session, once (an EMPTY cursor; the debit
 * is idempotent by generation id, migration 0029). Never throws. `null` means NOTHING was written — the
 * session or the billing config could not be read, or the write failed — and the row stays `running` for the
 * billing sweep (D10).
 */
export async function settleEnhancementSession(input: {
  client: Anthropic;
  sessionId: string;
  generationId: string;
  userId: string;
  model: string;
  sessionHourUsd: number;
  status: 'completed' | 'failed' | 'interrupted';
  context?: unknown;
  expectUsage?: boolean;
  usageReadDelayMs?: number;
}): Promise<Settlement | null> {
  const billing = getBillingConfigSafe(input.context);
  let priced = await priceEnhancementSession(input);

  /* The usage can land a moment after the idle event; a model that answered cannot have cost nothing. */
  for (
    let attempt = 1;
    input.expectUsage && attempt < USAGE_READ_ATTEMPTS && priced && priced.cost.tokens.output === 0;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, input.usageReadDelayMs ?? USAGE_READ_DELAY_MS));
    priced = await priceEnhancementSession(input);
  }

  /*
   * A session that cannot be read (or a billing config that cannot be) is NOT settled as zero — that would
   * anchor the row `completed` at 0 credits and lose the usage for good. It stays `running` for the sweep.
   */
  if (!priced || !billing) {
    return null;
  }

  const charge = decideManagedCharge(priced.cost, EMPTY_COST_CURSOR, {
    creditUnitCostUsd: billing.creditUnitCostUsd,
    margin: billing.margin,
  });

  try {
    return await settleGeneration({
      userId: input.userId,
      generationId: input.generationId,
      model: priced.model,
      provider: 'Anthropic',
      statusKind: 'enhance',
      usage: charge?.usage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      ...(charge ? { flatCredits: charge.credits, rawCostOverrideUsd: charge.trueCostUsd } : {}),
      chargeLabel: MANAGED_CHARGE_LABEL,
      status: input.status,
      byok: false,
      context: input.context,
    });
  } catch (error) {
    logger.error(`Enhancement ${input.generationId}: settlement failed: ${(error as Error)?.message}`);
    return null;
  }
}

export type EnhancementRecovery =
  | { outcome: 'settled'; credits: number }
  | { outcome: 'running' }
  | { outcome: 'gone' }
  | { outcome: 'failed' };

/**
 * The billing sweep's recovery of an enhancement whose process died (D10): a stale `running` row naming a
 * session. A session still running is interrupted and left for the next sweep; one that is idle is priced and
 * settled `interrupted` (billed for what it consumed, never refunded — the no-unbilled-usage rule for a turn
 * whose process died) and archived; one that no longer exists cannot be billed and its row is closed.
 * Never throws.
 */
export async function recoverEnhancementSession(input: {
  client: Anthropic;
  generationId: string;
  sessionId: string;
  userId: string;
  model: string;
  sessionHourUsd: number;
  markInterrupted: () => Promise<void>;
  context?: unknown;
}): Promise<EnhancementRecovery> {
  let status: string | undefined;

  try {
    status = (await input.client.beta.sessions.retrieve(input.sessionId)).status;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) {
      logger.error(
        `Enhancement ${input.generationId}: its session ${input.sessionId} no longer exists — what it used cannot be billed`,
      );
      await input.markInterrupted().catch(() => undefined);

      return { outcome: 'gone' };
    }

    logger.warn(`Enhancement ${input.generationId}: could not read its session: ${(error as Error)?.message}`);

    return { outcome: 'failed' };
  }

  if (status === 'running' || status === 'rescheduling') {
    await input.client.beta.sessions.events
      .send(input.sessionId, { events: [{ type: 'user.interrupt' }] })
      .catch(() => undefined);

    return { outcome: 'running' };
  }

  const settlement = await settleEnhancementSession({
    client: input.client,
    sessionId: input.sessionId,
    generationId: input.generationId,
    userId: input.userId,
    model: input.model,
    sessionHourUsd: input.sessionHourUsd,
    status: 'interrupted',
    context: input.context,
  });

  if (!settlement) {
    return { outcome: 'failed' };
  }

  await input.client.beta.sessions.archive(input.sessionId).catch(() => undefined);

  return { outcome: 'settled', credits: settlement.creditsCharged };
}
