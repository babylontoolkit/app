/**
 * The prompt enhancer (✨) on Managed Agents (`_specs/managed-only_plan.md` D8–D10).
 *
 * Owner, 2026-10-03: *"MAKE the Managed Agent the only safe and reliable LLM_PROVIDER"* — so on a managed
 * deploy the enhancer no longer goes through the legacy provider path (`streamText` + a gateway chain).
 *
 * ## One short session, on the agent that already exists
 *
 * An enhancement is a one-shot rewrite with no project, no files and no tools. It runs as a single Managed
 * Agents session on the STANDARD rung's provisioned agent, created with `agent_with_overrides`:
 *
 *   - `system` — the enhancer's own prompt (the agent's build prompt does not apply);
 *   - `tools: []` and `skills: []` — nothing to call (skills need the `read` tool, so both are cleared);
 *   - `model` — `getEnhancerModel(context, 'Anthropic')`: `ANTHROPIC_ENHANCE_PROMPT_MODEL` →
 *     `ENHANCE_PROMPT_MODEL` → `LLM_MODEL`. Effort `medium` where the model takes one (Haiku 4.5 does not).
 *
 * No new agent is provisioned or stored. No reference files are mounted.
 *
 * ## Money — the same rules as a managed turn
 *
 *   1. The credit gate BEFORE the session is created (no session, no event, nothing spent on a refusal).
 *   2. A `running` generation row (engine `enhancer`, `managedSessionId` set) BEFORE the first message, so a
 *      process that dies mid-enhancement leaves a row the billing sweep prices from the session (D10).
 *   3. The session is priced by the managed engine's own functions — `sessionCost` over every thread, then
 *      `decideManagedCharge` against an EMPTY cursor (a one-shot session) — and settled once with
 *      `flatCredits` + `rawCostOverrideUsd`, under `keepAlive` (a closed tab must not cancel the debit).
 *   4. A failed enhancement (an error, or a finish with no text) is settled `failed` and REFUNDED.
 *   5. The session is archived after it is settled.
 *
 * BYOK does not apply: Managed Agents runs on the platform's Anthropic key (engine plan D8).
 */
import type { BetaManagedAgentsModel } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { getEnhancerModel } from '~/lib/.server/agent/config';
import { checkCreditGate, refundGeneration } from '~/lib/.server/billing/gate';
import { getBillingConfigSafe } from '~/lib/.server/billing/rates';
import { resolveToolLoopConfig, resolveTurnCeiling } from '~/lib/.server/agent/tool-loop';
import { trackGeneration } from '~/lib/.server/billing/in-flight';
import { ensureMarketPrices } from '~/lib/.server/billing/market-price-store';
import { openRunningGeneration } from '~/lib/.server/billing/running-generation';
import { ensureBillingSweep } from '~/lib/.server/billing/sweep';
import { NotConfiguredError } from '~/lib/.server/env';
import { keepAlive } from '~/lib/.server/runtime/keep-alive';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { supportsAdaptiveThinking } from '~/lib/modules/llm/capabilities';
import { createScopedLogger } from '~/utils/logger';
import { getManagedClient, getManagedEngineConfig } from './config';
import type { ManagedDispatcher } from './dispatch';
import { settleEnhancementSession } from './enhance-settle';
import { getManagedAgentRecord } from './provision';
import { runManagedTurn } from './turn';
import { budgetAmountCents, ceilingUsdForCredits } from './usage';

const logger = createScopedLogger('managed-enhance');

/** The enhancer's system prompt — the legacy route's wording, unchanged. */
export const ENHANCER_SYSTEM =
  'You are a senior software principal architect, you should help the user analyse the user query and enrich it ' +
  'with the necessary context and constraints to make it more specific, actionable, and effective. You should ' +
  'also ensure that the prompt is self-contained and uses professional language. Your response should ONLY ' +
  'contain the enhanced prompt text. Do not include any explanations, metadata, or wrapper tags.';

/** The one message an enhancement sends — the legacy route's instructions around the user's prompt. */
export function enhancerUserText(message: string): string {
  return [
    'You are a professional prompt engineer specializing in crafting precise, effective prompts.',
    'Your task is to enhance prompts by making them more specific, actionable, and effective.',
    '',
    'I want you to improve the user prompt that is wrapped in `<original_prompt>` tags.',
    '',
    'For valid prompts:',
    '- Make instructions explicit and unambiguous',
    '- Add relevant context and constraints',
    '- Remove redundant information',
    '- Maintain the core intent',
    '- Ensure the prompt is self-contained',
    '- Use professional language',
    '',
    'For invalid or unclear prompts:',
    '- Respond with clear, professional guidance',
    '- Keep responses concise and actionable',
    '- Maintain a helpful, constructive tone',
    '- Focus on what the user should provide',
    '- Use a standard template for consistency',
    '',
    'IMPORTANT: Your response must ONLY contain the enhanced prompt text.',
    'Do not include any explanations, metadata, or wrapper tags.',
    '',
    '<original_prompt>',
    message,
    '</original_prompt>',
  ].join('\n');
}

/** The enhancer agent is offered no tools; a call that arrives anyway is refused, never run. */
const REFUSE_ALL: ManagedDispatcher = {
  dispatch: async (call) => ({
    content: [{ type: 'text', text: `The prompt enhancer has no tools; "${call.name}" is not available.` }],
    isError: true,
  }),
};

export interface ManagedEnhancementInput {
  user: AuthUser;
  message: string;
  context?: unknown;

  /** Test seam: wait between empty usage reads. */
  usageReadDelayMs?: number;
}

/** The legacy route's gate refusal shape (402, not retryable). */
function gateRefusal(message: string | undefined): Error {
  return Object.assign(new Error(message), { statusCode: 402, isRetryable: false });
}

/**
 * Run one enhancement on Managed Agents. Resolves to the enhanced prompt as a text stream, or throws BEFORE
 * any spend: `NotConfiguredError` (503 at the route), or a 402 gate refusal.
 */
export async function runManagedEnhancement(input: ManagedEnhancementInput): Promise<ReadableStream<string>> {
  const { user, message, context } = input;

  /* Config (throws NotConfiguredError) and the price list before anything prices anything. */
  const config = getManagedEngineConfig(context);
  await ensureMarketPrices('Anthropic', context);
  ensureBillingSweep(context);

  /* 1. The credit gate — once, before the session exists. */
  const gate = await checkCreditGate({ userId: user.id, byok: false, context });

  if (!gate.allowed) {
    throw gateRefusal(gate.message);
  }

  const record = await getManagedAgentRecord(context, config.model);

  if (!record) {
    throw new NotConfiguredError(
      'The managed agent',
      'An admin must press Synchronize (it provisions) under Agent repository in the Admin panel before prompts can be enhanced.',
    );
  }

  /* Throws NotConfiguredError when a configured enhancer model cannot be priced on Anthropic. */
  const model = getEnhancerModel(context, 'Anthropic');
  const client = getManagedClient(context);
  const generationId = `gen_enh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  /* The turn's credit ceiling as the session's hard budget, exactly as a managed turn sets it (engine D13). */
  const billing = getBillingConfigSafe(context);
  const ceilingCredits = resolveTurnCeiling(gate, resolveToolLoopConfig(context));
  const ceilingUsd =
    billing && ceilingCredits !== null
      ? ceilingUsdForCredits(ceilingCredits, billing.creditUnitCostUsd, billing.margin)
      : null;

  const session = await client.beta.sessions.create({
    agent: {
      type: 'agent_with_overrides',
      id: record.agentId,
      version: record.agentVersion,
      model: supportsAdaptiveThinking(model)
        ? { id: model as BetaManagedAgentsModel, effort: 'medium' }
        : { id: model as BetaManagedAgentsModel },
      system: ENHANCER_SYSTEM,
      tools: [],
      skills: [],
    },
    environment_id: record.environmentId,
    title: 'prompt enhancement',
    ...(ceilingUsd !== null
      ? {
          budget: {
            type: 'limit' as const,
            max_list_cost: { amount: budgetAmountCents(0, ceilingUsd), currency: 'USD' as const },
          },
        }
      : {}),
  });
  const sessionId = session.id;

  /* 2. The durable record BEFORE the first message (no-unbilled-usage D2) and the in-flight mark (D3). */
  const releaseInFlight = trackGeneration(generationId);

  await openRunningGeneration({
    id: generationId,
    userId: user.id,
    model,
    provider: 'Anthropic',
    engine: 'enhancer',
    statusKind: 'enhance',
    managedSessionId: sessionId,
    context,
  });

  let controller!: ReadableStreamDefaultController<string>;
  let open = true;

  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
    cancel() {
      /* The tab went away: the session still finishes and is still billed (the pump runs under keepAlive). */
      open = false;
    },
  });

  const push = (text: string) => {
    if (!open) {
      return;
    }

    try {
      controller.enqueue(text);
    } catch {
      open = false;
    }
  };

  const pump = async () => {
    let producedText = false;
    let failed = false;

    try {
      const turn = runManagedTurn({
        client,
        sessionId,
        userMessage: { type: 'user.message', content: [{ type: 'text', text: enhancerUserText(message) }] },
        dispatcher: REFUSE_ALL,
      });
      let step = await turn.next();

      while (!step.done) {
        if (step.value.type === 'text' && step.value.value) {
          producedText = true;
          push(step.value.value);
        }

        step = await turn.next();
      }

      if (step.value.end.kind !== 'end_turn') {
        failed = true;
        logger.error(`Enhancement ${generationId} (session ${sessionId}) ended ${step.value.end.kind}`);
      }
    } catch (error) {
      failed = true;
      logger.error(`Enhancement ${generationId} (session ${sessionId}) failed: ${(error as Error)?.message}`);
    }

    /* No text is a failure however cheerfully the session finished — the user got nothing. */
    if (!producedText) {
      failed = true;
    }

    try {
      /* 3. Price and settle the whole session once; 4. refund a failure. */
      const settlement = await settleEnhancementSession({
        client,
        sessionId,
        generationId,
        userId: user.id,
        model,
        sessionHourUsd: config.sessionHourUsd,
        status: failed ? 'failed' : 'completed',
        expectUsage: producedText,
        usageReadDelayMs: input.usageReadDelayMs,
        context,
      });

      if (!settlement) {
        /* Nothing landed: leave the row `running` so the billing sweep prices it from the session (D10). */
        logger.error(`Enhancement ${generationId}: not settled — left for the billing sweep`);
      } else {
        if (failed && settlement.creditsCharged > 0) {
          await refundGeneration(
            user.id,
            generationId,
            settlement.creditsCharged,
            'Automatic refund — the prompt enhancement failed',
            context,
          );
        }

        /* 5. Archived once it is settled; a failure here only leaves an idle session behind. */
        await client.beta.sessions.archive(sessionId).catch((error: unknown) => {
          logger.warn(`Enhancement session ${sessionId}: could not archive it: ${(error as Error)?.message}`);
        });
      }
    } finally {
      releaseInFlight();

      if (open) {
        open = false;

        try {
          if (failed) {
            /* The browser restores the user's original prompt on a stream error (`usePromptEnhancer`). */
            controller.error(new Error('The prompt enhancement failed — your credits were refunded.'));
          } else {
            controller.close();
          }
        } catch {
          // Already closed by the reader.
        }
      }
    }
  };

  /* Registered with the runtime (no-unbilled-usage D1): a closed tab must not cancel the settlement. */
  void keepAlive(context, pump(), `managed enhancement ${generationId}`);

  return stream;
}
