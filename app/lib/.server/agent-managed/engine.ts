/**
 * The managed agent engine's turn entry point (`_specs/managed-agents-engine_plan.md` T2, T5–T7).
 *
 * `runManagedGeneration` is the managed engine's twin of `runAgentGeneration` (`agent/proxy.ts`): the
 * route (`api.agent.ts`) calls one or the other after the SAME walls, attachment caps and in-flight
 * claim, and both return the SAME `AgentGeneration`, so `streamGeneration` and the client do not know
 * which engine ran (T5 acceptance).
 *
 * ## Order (pinned by `engine-seam.spec.ts`)
 *
 *   1. Config — an absent Anthropic key is `NotConfiguredError` (a 503 with a sentence), never a crash.
 *   2. The CREDIT GATE — before anything that can spend: no session is created, no event is sent, no
 *      stream is opened until it has allowed the turn. A refusal is the legacy engine's refusal, byte for
 *      byte (402, not retryable, the gate's sentence).
 *   3. The model tier (§4.6.1a, `decideModelTier` — the legacy engine's decision, unchanged) and that
 *      rung's provisioned agent (T3). A paid rung never provisioned is provisioned on demand; if that
 *      fails the turn runs Standard and says so. Standard never provisioned is "not configured", naming
 *      the admin's button.
 *   4. The chat's session (T4), its budget for this turn (D13), and the event bridge (`turn.ts`).
 *
 * ## Money (T7)
 *
 * The turn settles in the generator's `finally` through `settleManagedTurn` — the chat's usage since
 * its cursor, plus session-hours — whatever ended it: `end_turn`, a budget pause, a failure, a Stop or a
 * closed tab. Only a FAILED turn that wrote no files refunds (`shouldRefundManagedTurn`).
 */
import type { Message } from 'ai';
import { managedBuildPhases, type CreationPhaseId, type CreationPlan } from '~/lib/agent/creation-plan';
import { userTypedText } from '~/lib/chat/message-envelope';
import { checkCreditGate } from '~/lib/.server/billing/gate';
import { ensureMarketPrices, LLM_PRICE_PROVIDERS } from '~/lib/.server/billing/market-price-store';
import { decideModelTier, tierDeclinedNotice, type ModelTierDecision } from '~/lib/.server/billing/premium';
import { getBillingConfigSafe, getModelTiers, ratesFor } from '~/lib/.server/billing/rates';
import type { ManagedAgentRecord } from './record';
import { envNumber, NotConfiguredError } from '~/lib/.server/env';
import {
  carriesCreationBrief,
  isFirstBuildTurnFor,
  statusKindFor,
  type AgentChunk,
  type AgentGeneration,
  type AgentSettlement,
} from '~/lib/.server/agent/proxy';
import type { GenerationUsage } from '~/lib/.server/agent/step-usage';
import { cancelGenerationToolCalls } from '~/lib/.server/agent/mcp-relay';
import type { McpLiveTool, McpToolCallEvent } from '~/lib/.server/agent/mcp-tools';
import { NO_REPLAY, PLAN_MODE } from '~/types/message-marks';
import type { PreviewToolCallEvent } from '~/lib/.server/agent/preview-tools';
import { EMPTY_RESPONSE_ERROR } from '~/lib/.server/agent/retry-policy';
import { resolveToolLoopConfig, resolveTurnCeiling } from '~/lib/.server/agent/tool-loop';
import { getGenerationLog } from '~/lib/.server/agent/usage';
import type { MediaTaskEvent } from '~/lib/.server/agent/media-tools';
import { managedAssistantId, planManagedTranscript } from '~/lib/.server/agent/transcript-recovery';
import { buildTurnAnnotations } from '~/lib/.server/agent/turn-annotations';
import { resolveMediaProvider } from '~/lib/.server/media/provider';
import { getChat, putChat } from '~/lib/.server/projects/message-store';
import { getObjectStore } from '~/lib/.server/storage';
import { getPromptStore } from '~/lib/.server/prompt/store';
import {
  completeTodosOnDone,
  doneGateWriteFacts,
  newWorkspaceTurnState,
  summarizeWorkspace,
  WorkspaceOverlay,
  type WorkspaceToolCallEvent,
} from '~/lib/.server/agent/workspace-tools';
import type { TurnOutcomeFacts } from '~/lib/agent/turn-outcome';
import type { AgentWorkspaceSummary, TodoItem } from '~/lib/agent/workspace-protocol-types';
import type { FileMap } from '~/lib/.server/llm/constants';
import type { AuthUser } from '~/lib/.server/supabase/auth';
import { offeredUserEffortLevels } from '~/lib/.server/agent/effort-offer';
import { parseUserEffort, servableEffort, type EffortLevel } from '~/lib/modules/llm/capabilities';
import { createScopedLogger } from '~/utils/logger';
import { getManagedClient, getManagedEngineConfig } from './config';
import { createManagedDispatcher } from './dispatch';
import { buildManagedUserMessage } from './message';
import { createStepTracker } from './step';
import { createCreditsEstimator, type CreditsEstimator } from './credits-estimate';
import type { ApiUsageLike } from './session-cost';
import { recordManagedBuildPhases } from './build-complete';
import { ensureManagedAgentRecord, getManagedAgentRecord } from './provision';
import { REFERENCE_MOUNT_PATH } from './system-prompt';
import { MANAGED_BUILTIN_TOOLSET, MANAGED_CUSTOM_TOOLS } from './tools';
import { getManagedSettledAt, getOrCreateManagedSession, ManagedSessionError } from './sessions';
import { inspectSession, SUPERSEDE_WAIT_MS, supersedePendingTurn } from './session-health';
import {
  DETACH_SETTLE_POLL_MS,
  DETACH_SETTLE_WAIT_MS,
  flushDetachedTail,
  rebindDeadSession,
  refundManagedTurn,
  settleDetachedTail,
  MANAGED_CHARGE_LABEL,
  settleManagedTurn,
  shouldRefundManagedTurn,
} from './settle';
import { keepAlive } from '~/lib/.server/runtime/keep-alive';
import { trackGeneration, trackManagedTurn } from '~/lib/.server/billing/in-flight';
import { openRunningGeneration } from '~/lib/.server/billing/running-generation';
import { ensureBillingSweep } from '~/lib/.server/billing/sweep';
import { runManagedTurn, type ManagedTurnEnd, type ManagedTurnResult } from './turn';
import { budgetAmountCents, ceilingUsdForCredits } from './usage';

const logger = createScopedLogger('managed-engine');

/** The ledger note's label for usage a turn carried over from before it started (no-unbilled-usage D5). */
const CARRIED_CHARGE_LABEL = `${MANAGED_CHARGE_LABEL} — carried over`;

/**
 * What a managed turn needs — the subset of `AgentRequest` that means something on this engine.
 *
 * Absent on purpose: BYOK (`apiKeys`/`providerSettings`/`model` — Managed Agents runs on the platform's
 * Anthropic key only, D8), and the legacy prompt-assembly inputs (`toolkitSystems`, `creationPhase`,
 * `gameBackend`, `assetNotes`) that T9 re-introduces as first-message guidance where they still apply.
 * `chatMode` and `mcpTools` arrived 2026-10-03 (`_specs/managed-only_plan.md`): Plan turns and MCP turns
 * run here too.
 */
export interface ManagedTurnRequest {
  messages: Message[];
  files?: FileMap;

  /** The server chat id — the key of the chat's session (T4). */
  chatId?: string;

  /** Resolved by the ROUTE (`requireVerifiedUser`), never by the client. */
  user: AuthUser;

  /** Ownership already proven by the route (`requireOwnedProject`). */
  projectId?: string;

  /** The turn's signal (a closed tab, or a superseding send from the same tab). D6: never an interrupt. */
  abortSignal?: AbortSignal;

  errors?: string[];
  repairOf?: string;
  repairAttempt?: number;

  /** The model tier the user asked for — a request, re-derived server-side (§4.6.1a). */
  tier?: string;

  /**
   * The user's chosen effort — untrusted, validated where it is used (`parseUserEffort` against the levels
   * this deploy offers). On this engine it is the session's effort, set at create (`agent_with_overrides`);
   * a change MOVES the chat to a new session, like a tier change (`_specs/effort-selector_plan.md` D3).
   */
  effort?: string;

  /** Derived by the route from the project ROW (`projectOwesBuild`), never the body. */
  owesBuild?: boolean;

  /**
   * The project ROW's creation plan (`CreationHandoff.plan`) — which phases a first build still owes
   * (T9, `managedBuildPhases`). The body's `creationPhase` is deliberately NOT read on this engine.
   */
  creationPlan?: CreationPlan;

  /** The project's starter (`Project.templateId`) — the row, never the body. */
  starterId?: string;

  useAssetLibrary?: boolean;

  /** Remix context — the only source of server env. */
  context?: unknown;

  /** T6: re-attach to a session waiting on tool results rather than sending a new user message. */
  resume?: boolean;

  /**
   * The chat's Build/Plan toggle (§4.2.9) — untrusted; only the exact `'discuss'` is a Plan turn, which is
   * read-only by the dispatcher's wall (`planMode`, managed-only plan D1). Anything else is a Build turn.
   */
  chatMode?: string;

  /**
   * The project's MCP tools running in the user's sandbox (§4.14) — untrusted and third-party; reached through
   * `mcp_list_tools` / `mcp_call` (managed-only plan D4). The sandbox's own server validates every call.
   */
  mcpTools?: McpLiveTool[];
}

/**
 * The tool list every NEW session is created with (managed-only plan D7) — the agent's own, current as of this
 * deploy, so a tool added since the last Synchronize (`mcp_*`) works before an admin re-provisions.
 */
export function currentSessionTools() {
  return [
    {
      ...MANAGED_BUILTIN_TOOLSET,
      default_config: { ...MANAGED_BUILTIN_TOOLSET.default_config },
      configs: MANAGED_BUILTIN_TOOLSET.configs.map((config) => ({ ...config })),
    },
    ...MANAGED_CUSTOM_TOOLS.map((tool) => ({ ...tool })),
  ];
}

/**
 * Why a chat's live session cannot serve this turn, or `null` when it can (D3). A session's model and
 * effort are fixed for its life, so either differing MOVES the chat. A session that does not report its
 * effort (created as plain `agent`, before per-session overrides) runs at its agent's provisioned effort.
 * Exported for the spec; the caller never asks on a RESUME.
 */
export function sessionSwitchReason(
  inspection: { kind: string; model?: string; effort?: EffortLevel },
  agentRecord: Pick<ManagedAgentRecord, 'model' | 'effort'>,
  effort: EffortLevel,
): string | null {
  if (inspection.kind !== 'live') {
    return null;
  }

  if (inspection.model && inspection.model !== agentRecord.model) {
    return `model ${inspection.model} → ${agentRecord.model}`;
  }

  const current = inspection.effort ?? agentRecord.effort;

  if (current && current !== effort) {
    return `effort ${current} → ${effort}`;
  }

  return null;
}

/** The legacy engine's gate refusal, reproduced exactly (`proxy.ts`, "2. Credit gate"). */
function gateRefusal(message: string | undefined): Error {
  const error = new Error(message) as Error & { statusCode: number; isRetryable: boolean };
  error.statusCode = 402;
  error.isRetryable = false;

  return error;
}

export const NOT_PROVISIONED_HINT =
  'An admin must press Synchronize (it provisions) or "Provision managed agent" (Settings → Admin → Prompt) before the managed engine can run a turn.';

/**
 * The turn's outcome facts (`describeTurnOutcome`). Pure.
 *
 * Anthropic runs the loop, so the legacy segment/nudge/breaker machinery does not apply — but the
 * done-gate SIGNAL does: a turn that wrote game-affecting files and has no passing `check_game` after
 * its last such write reports `lastCheckOk: false`, i.e. "built, but not verified", with Fix the errors.
 */
export function managedOutcomeFacts(input: {
  end: ManagedTurnEnd['kind'];
  isFirstBuildTurn: boolean;
  overlay: WorkspaceOverlay;
  lastCheck: { ok: boolean; afterWriteSeq: number } | null;

  /** The request detached because the browser stopped answering (a relay TIMEOUT), not a closed tab. */
  browserTimedOut?: boolean;
}): TurnOutcomeFacts {
  const wroteFiles = input.overlay.writes.size > 0;
  const gate = doneGateWriteFacts(input.overlay, false);
  const verified = Boolean(input.lastCheck?.ok && input.lastCheck.afterWriteSeq >= gate.lastWriteSeq);
  const lastCheckOk = gate.wroteThisTurn && input.end === 'end_turn' ? verified : (input.lastCheck?.ok ?? null);

  return {
    isFirstBuildTurn: input.isFirstBuildTurn,
    finishReason:
      input.end === 'end_turn'
        ? 'stop'
        : input.end === 'budget'
          ? 'budget'
          : input.end === 'detached'
            ? 'aborted'
            : 'error',
    forcedContinuation: false,
    unproductiveRescue: false,
    completionPassWroteFiles: false,
    wroteFiles,
    aborted: input.end === 'detached',
    stopReason:
      input.end === 'budget'
        ? 'budget'
        : input.end === 'detached'
          ? input.browserTimedOut
            ? 'browser'
            : 'aborted'
          : 'none',
    lastCheckOk,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

export async function runManagedGeneration(request: ManagedTurnRequest): Promise<AgentGeneration> {
  /* 1. Config — throws `NotConfiguredError` when the Anthropic key is missing. */
  const config = getManagedEngineConfig(request.context);

  /*
   * The price lists, before anything prices anything (the tier ladder and settlement read them
   * synchronously). Never throws: a failed refresh serves the last-loaded or baked list.
   */
  await Promise.all(LLM_PRICE_PROVIDERS.map((provider) => ensureMarketPrices(provider, request.context)));

  /* The billing sweep (no-unbilled-usage D3): started lazily at a request doorway. Never throws, never blocks. */
  ensureBillingSweep(request.context);

  /*
   * 2. Credit gate — once, up front, the ONE moment a turn may be refused for balance (§4.2.1). Never
   * BYOK: Managed Agents runs on the platform's key (D8), so the balance always applies.
   */
  const gate = await checkCreditGate({
    userId: request.user.id,
    byok: false,
    context: request.context,
  });

  if (!gate.allowed) {
    throw gateRefusal(gate.message);
  }

  const isFirstBuildTurn = isFirstBuildTurnFor({
    carriesBrief: carriesCreationBrief(request.messages),
    owesBuild: request.owesBuild === true,
  });

  /*
   * A Plan turn (§4.2.9, managed-only plan D1–D3): read-only by the dispatcher's wall, and never a build —
   * no build phases, no finished build recorded, not judged as a first build that "wrote nothing" — even on a
   * project that still owes its first build ("Plan my brief" plans that build instead of running it).
   */
  const isDiscussTurn = request.chatMode === 'discuss';
  const isBuildingFirst = isFirstBuildTurn && !isDiscussTurn;

  /*
   * 3. The model tier the user picked (§4.6.1a) — the SAME decision the legacy engine makes: a request,
   * honoured only when the rung is servable and the balance clears its threshold, else resolved DOWN to
   * Standard. Each rung is its own provisioned agent (a session's model is fixed for its life).
   */
  const tiers = getModelTiers(config.model, request.context);

  for (const broken of tiers.filter((row) => !row.serveable)) {
    logger.warn(`Model tier "${broken.id}" cannot be served: ${broken.reason ?? 'unknown reason'}`);
  }

  let tierDecision: ModelTierDecision = decideModelTier({
    requested: request.tier ?? 'standard',
    balance: gate.mode === 'byok' ? 0 : gate.balance,
    tiers,
    isFirstBuildTurn,
  });
  const requestedRow = tiers.find((row) => row.id === request.tier);
  let tierNotice =
    tierDecision.reason === 'below_minimum' && requestedRow
      ? tierDeclinedNotice(requestedRow.label, requestedRow.minimumCredits)
      : undefined;

  let record: ManagedAgentRecord | null = null;

  if (tierDecision.tier !== 'standard') {
    const row = tiers.find((candidate) => candidate.id === tierDecision.tier);

    record = row ? await ensureManagedAgentRecord(request.context, row.model) : null;

    if (!record) {
      logger.error(
        `The ${row?.label ?? tierDecision.tier} agent (${row?.model ?? 'unknown model'}) is not provisioned and could not be — running Standard`,
      );
      tierNotice = `The ${row?.label ?? tierDecision.tier} model is not available right now — this turn used the standard model.`;
      tierDecision = { tier: 'standard', reason: 'unavailable' };
    }
  }

  /* The Standard agent. Never provisioned is a describable state, never a crash. */
  record ??= await getManagedAgentRecord(request.context, config.model);

  if (!record) {
    throw new NotConfiguredError('The managed agent', NOT_PROVISIONED_HINT);
  }

  const agentRecord = record;

  /*
   * The effort this turn's session runs at (`_specs/effort-selector_plan.md` D1/D8/D11): the user's choice
   * when it is a level this deploy OFFERS (exact match — `low`, typos and `max` with the switch off are no
   * choice), else the operator default (`MANAGED_AGENT_EFFORT`), clamped to what the rung's model serves.
   * There is NO repair escalation here (D4): escalating per repair would move the session per repair.
   */
  const effort: EffortLevel = servableEffort(
    agentRecord.model,
    parseUserEffort(request.effort, offeredUserEffortLevels(request.context)) ?? config.effort,
  );
  const activeVersionId = (await getPromptStore().getActive())?.id ?? null;

  if (!request.projectId) {
    throw new ManagedSessionError(
      'The managed agent engine builds into a project, and this turn names none. Open a project and send the message again.',
    );
  }

  const projectId = request.projectId;
  const userId = request.user.id;
  const generationId = `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const isRepair = Boolean(request.errors?.length);
  const statusKind = statusKindFor({ isRepair, isFirstBuildTurn, isDiscussTurn });

  /*
   * T9: a first build is ONE managed turn that runs every owed phase, in order (design → game → front
   * end), listed as guidance in its message — not three requests. Read from the ROW's plan.
   */
  const buildPhases: CreationPhaseId[] = isBuildingFirst && !isRepair ? managedBuildPhases(request.creationPlan) : [];

  /*
   * The turn's credit ceiling as a session budget (D13): credits → USD list cost through the inverse of
   * the credit formula. Unknown billing config = no budget change (the session keeps its last one).
   */
  const billing = getBillingConfigSafe(request.context);
  const ceilingCredits = gate.mode === 'byok' ? null : resolveTurnCeiling(gate, resolveToolLoopConfig(request.context));
  const ceilingUsd =
    billing && ceilingCredits !== null
      ? ceilingUsdForCredits(ceilingCredits, billing.creditUnitCostUsd, billing.margin)
      : null;
  const budgetFor = (listCostCents: number) =>
    ceilingUsd === null
      ? undefined
      : {
          type: 'limit' as const,
          max_list_cost: { amount: budgetAmountCents(listCostCents, ceilingUsd), currency: 'USD' as const },
        };

  /* 4. The chat's session — created on the chat's first managed turn, reused after (T4). */
  const client = getManagedClient(request.context);

  /*
   * A detached turn's tail still waiting in the background (D2) is settled NOW, before this turn claims,
   * inspects or messages the session — otherwise it would bill part of THIS turn under the old turn's id,
   * and a refund of this turn would miss it. Bounded (one retrieve + one settlement); never throws.
   */
  await flushDetachedTail({ projectId, chatId: request.chatId });

  const claimSession = () =>
    getOrCreateManagedSession({
      userId,
      projectId,
      chatId: request.chatId,
      context: request.context,
      create: async () => {
        /*
         * `agent_with_overrides` pins the session's effort at create (D2) — the agent is provisioned once
         * per rung, and a session cannot change effort later. `budget` MUST stay on create: a session
         * created without one can never gain one (T1 Finding).
         */
        const created = await client.beta.sessions.create({
          agent: {
            type: 'agent_with_overrides',
            id: agentRecord.agentId,
            version: agentRecord.agentVersion,
            model: { id: agentRecord.model, effort },

            /* The CURRENT tool list (managed-only plan D7), not whatever the provisioned version carries. */
            tools: currentSessionTools(),
          },
          environment_id: agentRecord.environmentId,
          title: `project ${projectId}`,
          ...(budgetFor(0) ? { budget: budgetFor(0) } : {}),
          resources: agentRecord.referenceFiles.map((file) => ({
            type: 'file' as const,
            file_id: file.fileId,
            mount_path: `${REFERENCE_MOUNT_PATH}/${file.rel}`,
          })),
        });

        return created.id;
      },
      discard: async (id) => {
        await client.beta.sessions.archive(id);
      },
    });

  let sessionRef = await claimSession();

  /*
   * An EXISTING session must be usable before this turn touches it (`session-health.ts`):
   *   - dead (terminated / archived / gone) → settle what it still owes, release the chat's id
   *     (compare-and-clear) and start a fresh session — whose first message then carries the manifest;
   *   - mid-turn (running a detached turn, or waiting on tool results no browser answered) → a NEW
   *     message supersedes it: interrupt, wait, clear anything still pending. A resume never does this —
   *     resuming that turn is its whole point.
   */
  let liveListCost: number | null = null;

  /* The model the turn actually runs: this tier's agent — or, on a resume, whatever the session runs. */
  let servedModel = agentRecord.model;

  /* Likewise the effort: a resume runs at whatever the session was created with. */
  let servedEffort: EffortLevel = effort;

  /* Inspected ONCE; a session created by this turn needs no inspection. */
  let inspection = sessionRef.created ? null : await inspectSession(client, sessionRef.sessionId);

  if (inspection) {
    /*
     * The user changed model tier or effort: the chat's session runs ANOTHER rung's agent, or the same
     * agent at another effort, and a session's model and effort cannot be changed. The old turn (if any) is superseded, its unbilled tail settled at ITS model,
     * the session released and archived, and a new session is created on this tier's agent — whose
     * first message carries the conversation so far (`conversationRecap`). A RESUME never switches:
     * re-attaching to the waiting turn is its whole point.
     */
    const switchReason = request.resume ? null : sessionSwitchReason(inspection, agentRecord, effort);

    if (inspection.kind === 'live' && switchReason) {
      logger.info(`Session ${sessionRef.sessionId}: ${switchReason} — moving the chat to a new session`);
      await supersedePendingTurn(client, sessionRef.sessionId, inspection.status, {
        signal: request.abortSignal,
        waitMs: Math.max(0, envNumber(request.context, 'MANAGED_SUPERSEDE_WAIT_MS', SUPERSEDE_WAIT_MS)),
        pollMs: 250,
      });
      await rebindDeadSession({
        client,
        sessionId: sessionRef.sessionId,
        reason: 'switched',
        projectId,
        chatId: request.chatId as string,
        userId,
        generationId,
        model: inspection.model ?? agentRecord.model,
        statusKind,
        sessionHourUsd: config.sessionHourUsd,
        context: request.context,
      });

      /*
       * `rebindDeadSession` archives the old session itself once it is accounted for and stopped — and keeps
       * it for the billing sweep, unarchived, when it is not (no-unbilled-usage D5).
       */
      sessionRef = await claimSession();
      inspection = sessionRef.created ? null : await inspectSession(client, sessionRef.sessionId);
    } else if (inspection.kind === 'live' && request.resume) {
      servedModel = inspection.model ?? servedModel;
      servedEffort = inspection.effort ?? agentRecord.effort;
    }
  }

  if (inspection) {
    if (inspection.kind === 'dead') {
      if (request.resume) {
        throw Object.assign(new Error('There is no managed turn to resume.'), { statusCode: 409, isRetryable: false });
      }

      await rebindDeadSession({
        client,
        sessionId: sessionRef.sessionId,
        reason: inspection.reason,
        projectId,
        chatId: request.chatId as string,
        userId,
        generationId,
        model: servedModel,
        statusKind,
        sessionHourUsd: config.sessionHourUsd,
        context: request.context,
      });
      sessionRef = await claimSession();
    } else {
      liveListCost = inspection.listCostCents;

      if (!request.resume) {
        await supersedePendingTurn(client, sessionRef.sessionId, inspection.status, {
          signal: request.abortSignal,
          waitMs: Math.max(0, envNumber(request.context, 'MANAGED_SUPERSEDE_WAIT_MS', SUPERSEDE_WAIT_MS)),
          pollMs: 250,
        });
      }
    }
  }

  const sessionId = sessionRef.sessionId;
  const chatId = request.chatId as string;

  /*
   * no-unbilled-usage D5 (G3): bill what the session ran BEFORE this turn — a tail nobody settled, a Stop
   * tail that was killed, a settlement whose read failed — under its own id, NOW, before this turn sends
   * anything. This turn's settlement (and so its refund, if it fails) then covers only its own usage.
   * After the supersede above, so an interrupted old turn has stopped and its usage has landed. A session
   * this turn just created has nothing to carry. A resume carries too: what the detached turn ran since its
   * last settlement is billed here, and the resumed request bills only what it runs.
   *
   * DECISION: when the old turn is STILL running past the supersede wait, what has landed is billed here and
   * what lands after it falls into this turn's settlement — bounded (the interrupt was sent; at most the
   * request in flight), and only in the under-refund direction. A carry that cannot complete is logged and
   * the turn proceeds: refusing the turn over our bookkeeping is the wrong trade, and the usage stays on the
   * cursor for this turn's settlement.
   */
  if (!sessionRef.created) {
    const carried = await keepAlive(
      request.context,
      settleManagedTurn({
        client,
        sessionId,
        projectId,
        chatId,
        userId,
        generationId: `${generationId}_carry`,
        model: servedModel,

        /* Verifier slip d: a carry is not this turn's build or repair — an edit, labelled as carried over. */
        statusKind: 'edit',
        chargeLabel: CARRIED_CHARGE_LABEL,
        sessionHourUsd: config.sessionHourUsd,
        context: request.context,
        anchorWhenEmpty: false,
        requireBoundSession: true,
      }),
      `carry ${generationId}`,
    );

    if (carried.settlement && carried.settlement.creditsCharged > 0) {
      logger.info(
        `Managed turn ${generationId}: billed ${carried.settlement.creditsCharged} credits of earlier usage before it started`,
      );
    } else if (!carried.complete) {
      logger.warn(
        `Managed turn ${generationId}: the usage carried from earlier could not be settled before it started — ` +
          "it is billed with this turn's own settlement",
      );
    }
  }

  /*
   * An EXISTING session created before `mcp_*` existed has no MCP tools (managed-only plan D7): give it the
   * current list on the first turn that carries MCP tools. The session is idle here (any pending turn was
   * superseded above). Best effort — a failure leaves the session as it was and the turn runs without them.
   */
  if (
    !request.resume &&
    !sessionRef.created &&
    (request.mcpTools?.length ?? 0) > 0 &&
    inspection?.kind === 'live' &&
    inspection.toolNames &&
    !inspection.toolNames.includes('mcp_call')
  ) {
    try {
      await client.beta.sessions.update(sessionRef.sessionId, { agent: { tools: currentSessionTools() } });
      logger.info(`Session ${sessionRef.sessionId}: given the current tool list (it had no MCP tools)`);
    } catch (error) {
      logger.warn(`Session ${sessionRef.sessionId}: could not add the MCP tools: ${(error as Error)?.message}`);
    }
  }

  const userMessage = request.resume
    ? null
    : buildManagedUserMessage({
        messages: request.messages,
        errors: request.errors,
        files: request.files,
        newSession: sessionRef.created,
        buildPhases,
        planMode: isDiscussTurn,
        mcpTools: request.mcpTools,
      });

  if (!request.resume && !userMessage) {
    throw new ManagedSessionError('This turn has no message to send.');
  }

  /*
   * This turn's budget on an EXISTING session: what it has cost so far plus the ceiling. Best effort —
   * a failed update leaves the previous budget, which still bounds the session.
   */
  if (!sessionRef.created && ceilingUsd !== null) {
    try {
      await client.beta.sessions.update(sessionId, { budget: budgetFor(liveListCost ?? 0) });
    } catch (error) {
      logger.warn(`Session ${sessionId}: could not set this turn's budget: ${(error as Error)?.message}`);
    }
  }

  /* The relay listeners — same shapes as the legacy engine's, so the route and the browser are unchanged. */
  const workspaceListeners: Array<(event: WorkspaceToolCallEvent) => void> = [];
  const previewListeners: Array<(event: PreviewToolCallEvent) => void> = [];
  const todoListeners: Array<(items: TodoItem[]) => void> = [];
  const mediaListeners: Array<(event: MediaTaskEvent) => void> = [];
  const mcpListeners: Array<(event: McpToolCallEvent) => void> = [];

  /*
   * T8: the media tools, answered by the SERVER exactly as the legacy engine answers them (debit → task
   * → path); `media-task` reaches the route through `onMediaTask` and the browser writes the bytes.
   * `resolveMediaProvider` never throws — no provider means "not available" answers, never a failed turn.
   */
  const mediaProvider = resolveMediaProvider(request.context);

  const overlay = new WorkspaceOverlay(request.files ?? {});
  const wsState = newWorkspaceTurnState();
  const emitTodos = (items: TodoItem[]) => todoListeners.forEach((listener) => listener(items));

  /*
   * Dispatch stops forwarding when the REQUEST is aborted (detach, D6) or when this turn's generator
   * has finished — the relay's "generation ended" cancellation is about our request, never the project.
   */
  const turnEnded = new AbortController();

  /*
   * The browser stopped answering (a relay TIMEOUT on one of its calls): treated exactly like a closed
   * tab — the turn DETACHES, the call stays unanswered at `requires_action`, and a live tab re-attaches
   * through the resume path (its outcome says `resume`). Never forwarded to the model as a failure.
   */
  const browserGone = new AbortController();
  const turnSignal = request.abortSignal
    ? AbortSignal.any([request.abortSignal, browserGone.signal])
    : browserGone.signal;
  const dispatchSignal = AbortSignal.any([turnSignal, turnEnded.signal]);

  const dispatcher = createManagedDispatcher({
    generationId,
    userId,
    abortSignal: dispatchSignal,
    files: request.files ?? {},
    overlay,
    state: wsState,
    emitWorkspace: (event) => workspaceListeners.forEach((listener) => listener(event)),
    emitPreview: (event) => previewListeners.forEach((listener) => listener(event)),
    emitTodos,
    planMode: isDiscussTurn,
    mcp: request.mcpTools?.length
      ? { tools: request.mcpTools, emit: (event) => mcpListeners.forEach((listener) => listener(event)) }
      : null,
    onBrowserTimeout: (call) => {
      if (!browserGone.signal.aborted) {
        logger.warn(
          `Managed turn ${generationId}: the browser did not answer ${call.name} (${call.id}) in time — detaching; ` +
            'the session waits for a tab to re-attach',
        );
        browserGone.abort('browser-timeout');
      }
    },
    media: mediaProvider
      ? {
          userId,
          projectId,
          provider: mediaProvider,
          objectStore: getObjectStore(request.context),
          context: request.context,
          emit: (event) => mediaListeners.forEach((listener) => listener(event)),
        }
      : null,
  });

  const usage = deferred<GenerationUsage>();
  const outcome = deferred<TurnOutcomeFacts>();
  const settlementPromise = deferred<AgentSettlement | null>();
  const workspaceSummary = deferred<AgentWorkspaceSummary | null>();
  const phasesCompleted = deferred<CreationPhaseId[] | undefined>();

  /* What the turn is doing right now, from the session's own events — the status panel's step label. */
  const steps = createStepTracker();

  /*
   * And what it has cost so far (managed-billing-visibility D1): the session's own cumulative usage priced
   * by settlement's functions against the cursor as it stands now, at turn start. Writes nothing. A billing
   * config that cannot be read leaves the panel without a cost line, never the turn without a heartbeat.
   */
  const estimateBilling = getBillingConfigSafe(request.context);
  const credits: CreditsEstimator | null = estimateBilling
    ? createCreditsEstimator({
        cursor: () => getManagedSettledAt(projectId, chatId, request.context),
        model: servedModel,
        ratesOf: (m) => ratesFor(m, 'Anthropic', request.context),
        billing: { creditUnitCostUsd: estimateBilling.creditUnitCostUsd, margin: estimateBilling.margin },
        sessionHourUsd: config.sessionHourUsd,
        refresh: async () => ((await client.beta.sessions.retrieve(sessionId)) as { usage?: ApiUsageLike }).usage,
      })
    : null;

  /* This turn's identity across requests (the session's `user.message` event id) and its narration. */
  let turnId: string | undefined;
  let narration = '';
  const assistantIdListeners: Array<(messageId: string) => void> = [];

  async function* run(): AsyncGenerator<AgentChunk> {
    /*
     * no-unbilled-usage D3: this chat has a turn in flight HERE — the billing sweep must not settle it under
     * its own id (a failed turn's refund would then miss that part) — and so does this GENERATION, whose
     * `running` row the sweep's stale-row pass must not flip to `interrupted` mid-turn (verifier slip 1).
     * Released in a `finally` of their own once the turn has settled and any detached tail is registered
     * (which the sweep also respects); a mark that is never released expires.
     */
    const releaseChat = trackManagedTurn(chatId);
    const releaseGeneration = trackGeneration(generationId);

    try {
      yield* runTurn();
    } finally {
      releaseGeneration();
      releaseChat();
    }
  }

  async function* runTurn(): AsyncGenerator<AgentChunk> {
    let result: ManagedTurnResult | null = null;
    let end: ManagedTurnEnd['kind'] = 'failed';
    let failed = false;

    try {
      /*
       * D2: the durable record BEFORE the session receives this turn — a process that dies mid-turn leaves a
       * row the sweep can find. Never throws; the turn's settlement finishes this same row.
       */
      await openRunningGeneration({
        id: generationId,
        userId,
        model: servedModel,
        provider: 'Anthropic',
        engine: 'managed',
        projectId,
        chatId,
        statusKind,
        managedSessionId: sessionId,
        context: request.context,
      });

      const turn = runManagedTurn({
        client,
        sessionId,
        userMessage,
        dispatcher,
        abortSignal: turnSignal,
        onEvent: (event) => {
          steps.observe(event);
          credits?.observe(event);
        },
        onTurnId: (id) => {
          turnId = id;
          assistantIdListeners.forEach((listener) => listener(managedAssistantId(id)));
        },
      });
      let step = await turn.next();

      while (!step.done) {
        if (step.value.type === 'text') {
          narration += step.value.value;
        }

        yield step.value;
        step = await turn.next();
      }

      result = step.value;
      end = result.end.kind;

      if (result.end.kind === 'failed') {
        failed = true;
        throw new Error(result.end.message);
      }

      if (result.end.kind === 'end_turn') {
        if (!result.producedText && result.toolCallsAnswered === 0 && overlay.writes.size === 0) {
          failed = true;
          throw new Error(EMPTY_RESPONSE_ERROR);
        }

        /* A finished, verified turn leaves no unchecked items (tool-loop T9, owner rule). */
        const facts = managedOutcomeFacts({
          end,
          isFirstBuildTurn: isBuildingFirst,
          overlay,
          lastCheck: wsState.lastCheck,
          browserTimedOut: browserGone.signal.aborted && !request.abortSignal?.aborted,
        });

        completeTodosOnDone(wsState, facts.lastCheckOk !== false, emitTodos);
      }
    } catch (error) {
      if (turnSignal.aborted) {
        end = 'detached';
        failed = false;
      } else {
        failed = true;
        end = 'failed';
        logger.error(`Managed turn ${generationId} (session ${sessionId}) failed: ${(error as Error)?.message}`);
      }

      throw error;
    } finally {
      turnEnded.abort();
      cancelGenerationToolCalls(generationId);

      const facts = managedOutcomeFacts({
        end,
        isFirstBuildTurn: isBuildingFirst,
        overlay,
        lastCheck: wsState.lastCheck,
        browserTimedOut: browserGone.signal.aborted && !request.abortSignal?.aborted,
      });

      outcome.resolve(facts);

      const summary = summarizeWorkspace(overlay, wsState);

      workspaceSummary.resolve(summary);

      /* T9: a first build that FINISHED its turn (verified or not — never failed, paused or detached) did every phase. */
      const completedPhases = !failed && end === 'end_turn' && buildPhases.length > 0 ? buildPhases : undefined;

      phasesCompleted.resolve(completedPhases);

      /*
       * The SERVER records the finished build on the row — never only the tab that pressed Build, whose
       * state a dropped stream or a reload loses (owner, 2026-10-02: the plan sat on Step 1 forever over
       * a build that had finished). Never throws.
       */
      if (completedPhases) {
        await recordManagedBuildPhases({
          projectId,
          phases: completedPhases,
          generationId,
          context: request.context,
        });
      }

      /*
       * Whether this turn is REFUNDED by policy — decided BEFORE settling (every fact it needs is known), so
       * the settlement can mark its pending intent refundable: a refunded turn whose debit does not land must
       * never be debited later with no refund behind it (verifier money defect 2).
       */
      const refund =
        failed &&
        shouldRefundManagedTurn({
          end: 'failed',
          wroteFiles: overlay.writes.size > 0,
          producedText: result?.producedText ?? false,
          toolCalls: result?.toolCallsAnswered ?? 0,
        });

      /* Kept alive (no-unbilled-usage D1): a workerd disconnect must not cancel the turn-end debit. */
      const settled = await keepAlive(
        request.context,
        settleManagedTurn({
          client,
          sessionId,
          projectId,
          chatId,
          userId,
          generationId,
          model: servedModel,
          statusKind,
          sessionHourUsd: config.sessionHourUsd,
          context: request.context,

          /* Bound-only (verifier slip c): a chat a concurrent turn moved is that turn's to settle. */
          requireBoundSession: true,
          refundable: refund,
        }),
        `managed settlement ${generationId}`,
      );

      usage.resolve(settled.usage);

      /*
       * D2 (`_specs/managed-billing-visibility_plan.md`): a detached session keeps running until it idles on
       * a call no browser answers — bill that tail in the background instead of only at the chat's next
       * settlement, which a chat nobody reopens never has. Fire-and-forget, never throws.
       */
      if (end === 'detached') {
        /*
         * Registered with the runtime (no-unbilled-usage D1): a detach IS a disconnect, and under workerd
         * an unregistered fire-and-forget promise dies with the request — this tail would never run.
         */
        void keepAlive(
          request.context,
          settleDetachedTail({
            client,
            sessionId,
            projectId,
            chatId,
            userId,
            generationId,
            model: servedModel,
            statusKind,
            sessionHourUsd: config.sessionHourUsd,
            context: request.context,
            waitMs: envNumber(request.context, 'MANAGED_DETACH_SETTLE_WAIT_MS', DETACH_SETTLE_WAIT_MS),
            pollMs: envNumber(request.context, 'MANAGED_DETACH_SETTLE_POLL_MS', DETACH_SETTLE_POLL_MS),
          }),
          `detached tail ${generationId}`,
        );
      }

      if (refund) {
        await keepAlive(
          request.context,
          refundManagedTurn(userId, generationId, settled.settlement, request.context),
          `managed refund ${generationId}`,
        );
      }

      const charged = settled.settlement && !refund ? settled.settlement.creditsCharged : 0;
      const agentSettlement: AgentSettlement | null = settled.settlement
        ? {
            creditsCharged: charged,
            balanceAfter: refund
              ? settled.settlement.balanceAfter + settled.settlement.creditsCharged
              : settled.settlement.balanceAfter,
            savings: null,
          }
        : null;

      settlementPromise.resolve(agentSettlement);

      try {
        await getGenerationLog(request.context).record({
          id: generationId,
          chatId,
          userId,
          projectId,
          model: settled.model ?? servedModel,
          provider: 'Anthropic',
          effort: servedEffort,
          creditsCharged: charged,
          rawCostUsd: settled.settlement?.rawCostUsd ?? 0,
          promptVersionId: activeVersionId,
          skillsLoaded: [],
          promptTokens: settled.usage.promptTokens,
          completionTokens: settled.usage.completionTokens,
          totalTokens: settled.usage.totalTokens,
          cacheReadTokens: settled.usage.cacheReadTokens,
          cacheCreationTokens: settled.usage.cacheCreationTokens,
          toolRounds: settled.requests,
          statusKind,
          durationMs: Date.now() - startedAt,
          repairOf: request.repairOf,
          finishReason: `managed:${end}${request.resume ? '+resumed' : ''}`,
          status: failed ? 'failed' : 'completed',
        });
      } catch (error) {
        logger.warn(`Could not record managed generation ${generationId}: ${(error as Error)?.message}`);
      }

      /*
       * T10: the turn's record, written by the SERVER at the end of every request — a managed turn can
       * finish with nobody listening (a closed tab), and the browser used to be the only writer. Never
       * throws (`writeManagedTranscript`).
       */
      await writeManagedTranscript({
        generation,
        projectId,
        chatId,
        turnId,
        narration,
        didWork: overlay.writes.size > 0 || (result?.toolCallsAnswered ?? 0) > 0,
        messages: request.messages,
        context: request.context,
        facts: {
          usage: settled.usage,
          outcome: facts,
          workspaceSummary: summary,
          settlement: agentSettlement,
          creationPhasesCompleted: completedPhases,
        },
        fallbackTurnId: generationId,
      });
    }
  }

  const generation: AgentGeneration = {
    engine: 'managed',
    creationPhasesCompleted: phasesCompleted.promise,
    textStream: run(),
    generationId,
    promptVersionId: activeVersionId ?? '',
    model: servedModel,
    provider: 'Anthropic',

    /* The effort the session runs at — shown in `/context` and recorded on the row (D9). */
    effort: servedEffort,

    /* One provisioned agent per rung (D10, §4.6.1a): the rung that RAN and why. */
    tier: tierDecision.tier,
    tierReason: tierDecision.reason,
    notice: tierNotice,
    blocksLoaded: [],

    /* The session holds the history on Anthropic's side; nothing is re-sent, so there is nothing to meter. */
    historyStats: { messages: 0, chars: 0, attachments: 0, attachmentTokens: 0, maxTurns: 0 },

    /* A Plan turn: the route writes PLAN_MODE then NO_REPLAY before any text (managed-only plan D3). */
    discussMode: isDiscussTurn,
    statusKind,
    deliveryMode: 'streamed',
    currentActivity: () => null,
    currentStep: () => steps.current(),
    currentCreditsEstimate: () => credits?.current() ?? null,
    toolContext: { loaded: new Set<string>(), offerLoadSkill: false },
    usage: usage.promise,
    outcome: outcome.promise,
    settlement: settlementPromise.promise,
    workspaceSummary: workspaceSummary.promise,
    onMcpToolCall: (listener) => mcpListeners.push(listener),
    onPreviewToolCall: (listener) => previewListeners.push(listener),
    onWorkspaceToolCall: (listener) => workspaceListeners.push(listener),
    onAgentTodos: (listener) => todoListeners.push(listener),
    onMediaTask: (listener) => mediaListeners.push(listener),
    onAssistantMessageId: (listener) => assistantIdListeners.push(listener),
    onBridgeEvent: () => undefined,
  };

  return generation;
}

/**
 * Store this request's view of the turn in the chat's transcript (T10, `planManagedTranscript`): the
 * agent's narration only — never a tool input, never a file body — with the same annotations the route
 * streams. Idempotent per TURN: the reply's id comes from the session's `user.message` event id, so a
 * resume replaces the detached request's partial reply instead of adding a second one. Never throws.
 */
function firstUserTitle(messages: Message[]): string | undefined {
  const first = messages.find((m) => m.role === 'user');
  const text = first
    ? userTypedText(String(first.content ?? ''))
        .trim()
        .replace(/\s+/g, ' ')
    : '';

  return text ? text.slice(0, 80) : undefined;
}

async function writeManagedTranscript(input: {
  generation: AgentGeneration;
  projectId: string;
  chatId: string;
  turnId?: string;
  fallbackTurnId: string;
  narration: string;
  didWork: boolean;
  messages: Message[];
  context?: unknown;
  facts: Parameters<typeof buildTurnAnnotations>[1];
}): Promise<void> {
  try {
    const annotations = buildTurnAnnotations(input.generation, input.facts);
    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const existing = await getChat(input.projectId, input.chatId, input.context);

    const plan = planManagedTranscript({
      serverChatId: input.chatId,
      existing,
      requestMessages: input.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.role === 'user' ? userTypedText(String(m.content ?? '')) : String(m.content ?? ''),
      })),
      userMessage: lastUser ? { id: lastUser.id, content: userTypedText(String(lastUser.content ?? '')) } : null,
      assistant: {
        id: managedAssistantId(input.turnId ?? input.fallbackTurnId),
        role: 'assistant',
        content: input.narration,
        annotations: [
          /* A Plan turn's marks, in the route's order, so its follow-up button survives a reload (D3). */
          ...(input.generation.discussMode ? [PLAN_MODE, NO_REPLAY] : []),
          annotations.usage,
          annotations.agentMeta,
          ...(annotations.agentWorkspace ? [annotations.agentWorkspace] : []),
          annotations.credits,
        ],
      },
      didWork: input.didWork,

      /* Only used when nothing is stored yet; the client renames it as it always has. */
      title: firstUserTitle(input.messages),
      now: new Date().toISOString(),
    });

    if (plan) {
      await putChat(input.projectId, plan, input.context);
    }
  } catch (error) {
    logger.error(`Could not store the transcript of ${input.generation.generationId}: ${(error as Error)?.message}`);
  }
}
