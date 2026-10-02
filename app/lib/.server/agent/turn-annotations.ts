/**
 * The message annotations a finished generation carries — `usage`, `agentMeta`, `agentWorkspace`,
 * `credits` — built ONCE, for both writers (`_specs/managed-agents-engine_plan.md` T10).
 *
 * The route (`api.agent.ts`) writes them onto the stream, and the client persists them with the
 * message. The managed engine ALSO writes the turn's transcript server-side (a managed turn can finish
 * with no browser listening), and that record must carry the same annotations or a reopened chat would
 * render a turn with no outcome, no activity list and no charge. Two hand-built copies would drift — so
 * both build them here. Pure.
 */
import type { CreationPhaseId } from '~/lib/agent/creation-plan';
import { describeTurnOutcome, type TurnOutcomeFacts } from '~/lib/agent/turn-outcome';
import type { AgentWorkspaceSummary } from '~/lib/agent/workspace-protocol-types';
import type { AgentGeneration, AgentSettlement } from './proxy';
import type { GenerationUsage } from './step-usage';

export type AnnotatedGeneration = Pick<
  AgentGeneration,
  | 'generationId'
  | 'promptVersionId'
  | 'model'
  | 'provider'
  | 'tier'
  | 'tierReason'
  | 'toolContext'
  | 'blocksLoaded'
  | 'historyStats'
  | 'notice'
  | 'engine'
>;

export interface TurnAnnotationFacts {
  usage: GenerationUsage;
  outcome: TurnOutcomeFacts;
  workspaceSummary: AgentWorkspaceSummary | null;
  settlement: AgentSettlement | null;

  /** Managed first build only (T9) — the phases this one turn completed. */
  creationPhasesCompleted?: CreationPhaseId[];
}

export interface TurnAnnotations {
  usage: { type: 'usage'; value: Record<string, unknown> };
  agentMeta: { type: 'agentMeta'; value: Record<string, unknown> };

  /** Absent with the tool loop off — the route then writes nothing. */
  agentWorkspace: { type: 'agentWorkspace'; value: AgentWorkspaceSummary } | null;
  credits: { type: 'credits'; value: Record<string, unknown> };
}

export function buildTurnAnnotations(generation: AnnotatedGeneration, facts: TurnAnnotationFacts): TurnAnnotations {
  const { usage, settlement } = facts;

  return {
    usage: {
      type: 'usage',
      value: {
        completionTokens: usage.completionTokens,
        promptTokens: usage.promptTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
      },
    },
    agentMeta: {
      type: 'agentMeta',
      value: {
        generationId: generation.generationId,
        promptVersionId: generation.promptVersionId,
        model: generation.model,
        provider: generation.provider,

        /*
         * The rung that actually RAN, and why — never the one that was requested (§4.6.1a): a declined
         * Premium turn and a plain Standard turn can run the same model and are very different facts.
         */
        tier: generation.tier,
        tierReason: generation.tierReason,
        skillsLoaded: [...generation.toolContext.loaded],
        blocksLoaded: generation.blocksLoaded,
        history: generation.historyStats,
        outcome: { ...describeTurnOutcome(facts.outcome) },

        /* Which engine ran the turn — the eval harness (T11) and `/context` read it. */
        engine: generation.engine ?? 'legacy',

        /* Present only on a managed first build that finished (T9); the client completes its plan from it. */
        ...(facts.creationPhasesCompleted ? { creationPhasesCompleted: facts.creationPhasesCompleted } : {}),
      },
    },
    agentWorkspace: facts.workspaceSummary ? { type: 'agentWorkspace', value: facts.workspaceSummary } : null,
    credits: {
      type: 'credits',
      value: {
        creditsCharged: settlement?.creditsCharged ?? 0,
        balanceAfter: settlement?.balanceAfter ?? null,
        notice: generation.notice ?? null,
        savings: settlement?.savings
          ? {
              basis: settlement.savings.basis,
              referenceCredits: settlement.savings.referenceCredits,
              savedCredits: settlement.savings.savedCredits,
              percent: settlement.savings.percent,
            }
          : null,
      },
    },
  };
}
