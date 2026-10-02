/**
 * Getting a chat's EXISTING session ready for a new turn (`_specs/managed-agents-engine_plan.md` D5, D6).
 *
 * Two states a stored session can be in that a plain `user.message` would trip over:
 *
 *   1. **Dead** — terminated, archived, or gone (404). Nothing can be sent to it, and the chat's id is set
 *      once (`claimManagedSession`), so without a rebind every later turn of the chat fails the same way.
 *      `inspectSession` reports it; the engine settles the old session's unbilled tail (when it is still
 *      listable), releases the id (compare-and-clear, `releaseManagedSession`) and creates a fresh one.
 *   2. **Mid-turn** — still running a detached turn, or idle at `requires_action` waiting on tool results
 *      no browser answered (the tab closed and the user typed instead of waiting for the auto-resume).
 *      The user's NEW message supersedes it: `supersedePendingTurn` sends `user.interrupt` and waits,
 *      bounded, for the session to settle. Measured live (2026-10-01): an interrupt at `requires_action`
 *      makes the API answer the pending call itself (`agent.tool_result`) and idle at `end_turn`, after
 *      which a `user.message` is accepted. If calls are STILL unanswered after the wait, each gets an
 *      error `user.custom_tool_result` — the documented way to clear a pending call.
 *
 * The old turn's usage is not settled here: the new turn's settlement reads the chat's cursor, so the
 * tail is billed once, with the next settlement, like any detached tail.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { createScopedLogger } from '~/utils/logger';
import { awaitingToolResults, listCurrentTurnEvents, unansweredToolCalls } from './turn';

const logger = createScopedLogger('managed-session-health');

export type SessionInspection =
  | { kind: 'live'; status: string; listCostCents: number }
  | { kind: 'dead'; reason: 'terminated' | 'archived' | 'missing' };

const isNotFound = (error: unknown) => (error as { status?: number })?.status === 404;

/** Is the stored session usable? A 404 is "missing"; any OTHER error is thrown (not a reason to rebind). */
export async function inspectSession(client: Anthropic, sessionId: string): Promise<SessionInspection> {
  try {
    const session = await client.beta.sessions.retrieve(sessionId);

    if (session.status === 'terminated') {
      return { kind: 'dead', reason: 'terminated' };
    }

    if (session.archived_at) {
      return { kind: 'dead', reason: 'archived' };
    }

    const cents = Number(session.usage?.list_cost?.amount ?? 0);

    return { kind: 'live', status: session.status, listCostCents: Number.isFinite(cents) ? cents : 0 };
  } catch (error) {
    if (isNotFound(error)) {
      return { kind: 'dead', reason: 'missing' };
    }

    throw error;
  }
}

export const SUPERSEDED_RESULT = 'Superseded: the user sent a new message.';

/** How long a superseding turn waits for the old one to stop. */
export const SUPERSEDE_WAIT_MS = 15_000;

export interface SupersedeResult {
  /** A `user.interrupt` was sent. */
  interrupted: boolean;

  /** Calls still unanswered after the wait, answered here with an error result. */
  answeredWithError: number;
}

/**
 * Make a mid-turn session ready for a new `user.message`. A session that is idle with nothing pending is
 * left alone (no interrupt). Never throws for a slow session: after `waitMs` it proceeds.
 */
export async function supersedePendingTurn(
  client: Anthropic,
  sessionId: string,
  status: string,
  options: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<SupersedeResult> {
  const waitMs = options.waitMs ?? SUPERSEDE_WAIT_MS;
  const pollMs = options.pollMs ?? 500;
  const running = status === 'running' || status === 'rescheduling';

  if (!running && !awaitingToolResults(await listCurrentTurnEvents(client, sessionId, options.signal))) {
    return { interrupted: false, answeredWithError: 0 };
  }

  logger.info(`Session ${sessionId}: a new message supersedes the unfinished turn — interrupting it`);

  const interrupt = () =>
    client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] }, { signal: options.signal });

  /** Poll until the session is idle with nothing awaited (and our interrupt in the turn), or the deadline. */
  const settle = async (deadline: number) => {
    for (;;) {
      const events = await listCurrentTurnEvents(client, sessionId, options.signal);
      const session = await client.beta.sessions.retrieve(sessionId);

      if (
        session.status === 'idle' &&
        events.some((e) => e.type === 'user.interrupt') &&
        !awaitingToolResults(events)
      ) {
        return { events, settled: true };
      }

      if (Date.now() >= deadline || options.signal?.aborted) {
        logger.warn(`Session ${sessionId}: still ${session.status} after the interrupt — continuing`);
        return { events, settled: false };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };

  await interrupt();

  const first = await settle(Date.now() + waitMs);

  if (!awaitingToolResults(first.events)) {
    return { interrupted: true, answeredWithError: 0 };
  }

  /*
   * The API did not resolve the pending calls itself: answer each with an error — the documented way to
   * clear a pending call — then interrupt again so the agent does not start a new round on those errors.
   */
  const stillPending = unansweredToolCalls(first.events);

  await client.beta.sessions.events.send(
    sessionId,
    {
      events: stillPending.map((call) => ({
        type: 'user.custom_tool_result' as const,
        custom_tool_use_id: call.id,
        content: [{ type: 'text' as const, text: SUPERSEDED_RESULT }],
        is_error: true,
      })),
    },
    { signal: options.signal },
  );
  await interrupt();
  await settle(Date.now() + waitMs);

  return { interrupted: true, answeredWithError: stillPending.length };
}
