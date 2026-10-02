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
 *   3. The provisioned agent (T3) — never provisioned is "not configured", naming the admin's button.
 *   4. The chat's session (T4), its budget for this turn (D13), and the event bridge (`turn.ts`).
 *
 * ## Money (T7)
 *
 * The turn settles in the generator's `finally` through `settleManagedTurn` — the chat's usage since
 * its cursor, plus session-hours — whatever ended it: `end_turn`, a budget pause, a failure, a Stop or a
 * closed tab. Only a FAILED turn that wrote no files refunds (`shouldRefundManagedTurn`).
 */
import type { Message } from 'ai';
import { checkCreditGate } from '~/lib/.server/billing/gate';
import { getBillingConfigSafe } from '~/lib/.server/billing/rates';
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
import type { PreviewToolCallEvent } from '~/lib/.server/agent/preview-tools';
import { EMPTY_RESPONSE_ERROR } from '~/lib/.server/agent/retry-policy';
import { resolveToolLoopConfig, resolveTurnCeiling } from '~/lib/.server/agent/tool-loop';
import { getGenerationLog } from '~/lib/.server/agent/usage';
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
import { createScopedLogger } from '~/utils/logger';
import { getManagedClient, getManagedEngineConfig } from './config';
import { createManagedDispatcher } from './dispatch';
import { buildManagedUserMessage } from './message';
import { getManagedAgentStatus } from './provision';
import { REFERENCE_MOUNT_PATH } from './system-prompt';
import { getOrCreateManagedSession, ManagedSessionError } from './sessions';
import { inspectSession, SUPERSEDE_WAIT_MS, supersedePendingTurn } from './session-health';
import { rebindDeadSession, refundManagedTurn, settleManagedTurn, shouldRefundManagedTurn } from './settle';
import { runManagedTurn, type ManagedTurnEnd, type ManagedTurnResult } from './turn';
import { budgetAmountCents, ceilingUsdForCredits } from './usage';

const logger = createScopedLogger('managed-engine');

/**
 * What a managed turn needs — the subset of `AgentRequest` that means something on this engine.
 *
 * Absent on purpose: BYOK (`apiKeys`/`providerSettings`/`model` — Managed Agents runs on the platform's
 * Anthropic key only, D8), `chatMode` (a Plan turn never reaches this engine, `engine-select.ts`), MCP
 * tools (same), and the legacy prompt-assembly inputs (`toolkitSystems`, `creationPhase`, `gameBackend`,
 * `assetNotes`) that T9 re-introduces as first-message guidance where they still apply.
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

  /** The user's effort floor — untrusted, validated where it is used. */
  effort?: string;

  /** Derived by the route from the project ROW (`projectOwesBuild`), never the body. */
  owesBuild?: boolean;

  /** The project's starter (`Project.templateId`) — the row, never the body. */
  starterId?: string;

  useAssetLibrary?: boolean;

  /** Remix context — the only source of server env. */
  context?: unknown;

  /** T6: re-attach to a session waiting on tool results rather than sending a new user message. */
  resume?: boolean;
}

/** The legacy engine's gate refusal, reproduced exactly (`proxy.ts`, "2. Credit gate"). */
function gateRefusal(message: string | undefined): Error {
  const error = new Error(message) as Error & { statusCode: number; isRetryable: boolean };
  error.statusCode = 402;
  error.isRetryable = false;

  return error;
}

export const NOT_PROVISIONED_HINT =
  'An admin must press "Provision managed agent" (Settings → Admin → Prompt) before the managed engine can run a turn — or set AGENT_ENGINE=legacy.';

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
    stopReason: input.end === 'budget' ? 'budget' : input.end === 'detached' ? 'aborted' : 'none',
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

  /* 3. The provisioned agent. Never provisioned is a describable state, never a crash. */
  const agent = await getManagedAgentStatus(request.context);
  const record = agent.record;

  if (!record) {
    throw new NotConfiguredError('The managed agent', NOT_PROVISIONED_HINT);
  }

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
  const isFirstBuildTurn = isFirstBuildTurnFor({
    carriesBrief: carriesCreationBrief(request.messages),
    owesBuild: request.owesBuild === true,
  });
  const statusKind = statusKindFor({ isRepair, isFirstBuildTurn, isDiscussTurn: false });

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

  const claimSession = () =>
    getOrCreateManagedSession({
      userId,
      projectId,
      chatId: request.chatId,
      context: request.context,
      create: async () => {
        const created = await client.beta.sessions.create({
          agent: { type: 'agent', id: record.agentId, version: record.agentVersion },
          environment_id: record.environmentId,
          title: `project ${projectId}`,
          ...(budgetFor(0) ? { budget: budgetFor(0) } : {}),
          resources: record.referenceFiles.map((file) => ({
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

  if (!sessionRef.created) {
    const inspection = await inspectSession(client, sessionRef.sessionId);

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
        model: config.model,
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

  const userMessage = request.resume
    ? null
    : buildManagedUserMessage({
        messages: request.messages,
        errors: request.errors,
        files: request.files,
        newSession: sessionRef.created,
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

  const overlay = new WorkspaceOverlay(request.files ?? {});
  const wsState = newWorkspaceTurnState();
  const emitTodos = (items: TodoItem[]) => todoListeners.forEach((listener) => listener(items));

  /*
   * Dispatch stops forwarding when the REQUEST is aborted (detach, D6) or when this turn's generator
   * has finished — the relay's "generation ended" cancellation is about our request, never the project.
   */
  const turnEnded = new AbortController();
  const dispatchSignal = request.abortSignal
    ? AbortSignal.any([request.abortSignal, turnEnded.signal])
    : turnEnded.signal;

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
  });

  const usage = deferred<GenerationUsage>();
  const outcome = deferred<TurnOutcomeFacts>();
  const settlementPromise = deferred<AgentSettlement | null>();
  const workspaceSummary = deferred<AgentWorkspaceSummary | null>();

  async function* run(): AsyncGenerator<AgentChunk> {
    let result: ManagedTurnResult | null = null;
    let end: ManagedTurnEnd['kind'] = 'failed';
    let failed = false;

    try {
      const turn = runManagedTurn({ client, sessionId, userMessage, dispatcher, abortSignal: request.abortSignal });
      let step = await turn.next();

      while (!step.done) {
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
        const facts = managedOutcomeFacts({ end, isFirstBuildTurn, overlay, lastCheck: wsState.lastCheck });

        completeTodosOnDone(wsState, facts.lastCheckOk !== false, emitTodos);
      }
    } catch (error) {
      if (request.abortSignal?.aborted) {
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

      const facts = managedOutcomeFacts({ end, isFirstBuildTurn, overlay, lastCheck: wsState.lastCheck });

      outcome.resolve(facts);
      workspaceSummary.resolve(summarizeWorkspace(overlay, wsState));

      const settled = await settleManagedTurn({
        client,
        sessionId,
        projectId,
        chatId,
        userId,
        generationId,
        model: config.model,
        statusKind,
        sessionHourUsd: config.sessionHourUsd,
        context: request.context,
      });

      usage.resolve(settled.usage);

      const refund =
        failed &&
        shouldRefundManagedTurn({
          end: 'failed',
          wroteFiles: overlay.writes.size > 0,
          producedText: result?.producedText ?? false,
          toolCalls: result?.toolCallsAnswered ?? 0,
        });

      if (refund) {
        await refundManagedTurn(userId, generationId, settled.settlement, request.context);
      }

      const charged = settled.settlement && !refund ? settled.settlement.creditsCharged : 0;

      settlementPromise.resolve(
        settled.settlement
          ? {
              creditsCharged: charged,
              balanceAfter: refund
                ? settled.settlement.balanceAfter + settled.settlement.creditsCharged
                : settled.settlement.balanceAfter,
              savings: null,
            }
          : null,
      );

      try {
        await getGenerationLog(request.context).record({
          id: generationId,
          chatId,
          userId,
          projectId,
          model: config.model,
          provider: 'Anthropic',
          creditsCharged: charged,
          rawCostUsd: settled.settlement?.rawCostUsd ?? 0,
          promptVersionId: agent.activeVersionId,
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
    }
  }

  return {
    textStream: run(),
    generationId,
    promptVersionId: agent.activeVersionId ?? '',
    model: config.model,
    provider: 'Anthropic',

    /* One provisioned agent per (model, effort) — the paid rungs are separate agents not provisioned yet (D10). */
    tier: 'standard',
    tierReason: 'standard_requested',
    blocksLoaded: [],

    /* The session holds the history on Anthropic's side; nothing is re-sent, so there is nothing to meter. */
    historyStats: { messages: 0, chars: 0, attachments: 0, attachmentTokens: 0, maxTurns: 0 },
    discussMode: false,
    statusKind,
    deliveryMode: 'streamed',
    currentActivity: () => null,
    toolContext: { loaded: new Set<string>(), offerLoadSkill: false },
    usage: usage.promise,
    outcome: outcome.promise,
    settlement: settlementPromise.promise,
    workspaceSummary: workspaceSummary.promise,
    onMcpToolCall: () => undefined,
    onPreviewToolCall: (listener) => previewListeners.push(listener),
    onWorkspaceToolCall: (listener) => workspaceListeners.push(listener),
    onAgentTodos: (listener) => todoListeners.push(listener),
    onMediaTask: () => undefined,
    onBridgeEvent: () => undefined,
  };
}
