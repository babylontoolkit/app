/**
 * One user turn on a Managed Agents session — the I/O loop (`_specs/managed-agents-engine_plan.md`
 * D6, T5, T6).
 *
 *   1. **Stream first.** The event stream is opened BEFORE the user message is sent, so not one event
 *      of the turn can fall in the gap between "sent" and "listening".
 *   2. Each event goes through the pure reducer (`events.ts`); its text and reasoning are yielded to the
 *      route, and every `agent.custom_tool_use` is answered CONCURRENTLY (the session can ask for
 *      several at once) through the dispatcher, then sent back as `user.custom_tool_result`.
 *   3. A dropped stream reconnects and catches up by listing the turn's events — every event is
 *      deduplicated by id, so the overlap costs nothing.
 *   4. The turn ends at a terminal event (`end_turn`, the budget pause, a failure) — or DETACHES when the
 *      request is aborted: the stream is closed, nothing is answered and nothing is interrupted, and the
 *      session waits at `requires_action` for a reopened tab (D6).
 *
 * ## Resume (T6)
 *
 * With no user message, the turn RE-ATTACHES: it replays the current turn's events (everything since
 * the latest `user.message`) so the reopened chat shows the narration and the checklist again, answers
 * ONLY the custom tool calls that have no `user.custom_tool_result` yet, and then follows the live
 * stream to the end. An already-answered call is never dispatched again — no duplicate writes.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaManagedAgentsUserMessageEventParams } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { AgentChunk } from '~/lib/.server/agent/proxy';
import { createScopedLogger } from '~/utils/logger';
import type { ManagedDispatcher, ToolAnswer } from './dispatch';
import { createEventReducer, type CustomToolUse, type ManagedTerminal, type SessionEventLike } from './events';

const logger = createScopedLogger('managed-turn');

/** Custom tools that change the project (or the turn's checklist) — serialised per turn (`answer`). */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'project_write',
  'project_edit',
  'project_run',
  'check_game',
  'update_todos',
]);

/** How many times a dropped stream is reopened before the turn gives up. */
export const MAX_STREAM_RECONNECTS = 6;

/** The most events a catch-up / replay lists — a turn is never this long, a runaway listing could be. */
export const MAX_TURN_EVENTS = 5000;

export type ManagedTurnEnd = ManagedTerminal | { kind: 'detached' };

export interface ManagedTurnResult {
  end: ManagedTurnEnd;
  producedText: boolean;

  /** Model requests seen on THIS request's view of the turn. */
  modelRequests: number;

  /** Custom tool calls this request answered. */
  toolCallsAnswered: number;
}

export interface ManagedTurnInput {
  client: Anthropic;
  sessionId: string;

  /** The message to send. `null` = resume (T6): re-attach to the turn already in the session. */
  userMessage: BetaManagedAgentsUserMessageEventParams | null;
  dispatcher: ManagedDispatcher;

  /** The request's signal. Aborted = detached (D6). */
  abortSignal?: AbortSignal;

  reconnectDelayMs?: number;

  /**
   * The session event id of this turn's `user.message`, reported once, as soon as it is known — from the
   * send's response, the stream's echo, or (on resume) the replay. It names the TURN across requests: a
   * detached request and the resume that finishes it see the same id (T10's transcript key).
   */
  onTurnId?: (userMessageEventId: string) => void;
}

/**
 * The CURRENT turn's events: everything since (and including) the latest `user.message`, oldest first.
 * Listed newest-first so a long session is not read from its beginning.
 */
export async function listCurrentTurnEvents(
  client: Anthropic,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionEventLike[]> {
  const events: SessionEventLike[] = [];

  for await (const event of client.beta.sessions.events.list(sessionId, { order: 'desc' }, { signal })) {
    events.push(event as unknown as SessionEventLike);

    if ((event as { type?: string }).type === 'user.message' || events.length >= MAX_TURN_EVENTS) {
      break;
    }
  }

  return events.reverse();
}

/**
 * The id a result event answers, or null. Two shapes answer a custom call: our `user.custom_tool_result`,
 * and the `agent.tool_result` the API writes ITSELF for a pending call when the turn is interrupted
 * (measured live 2026-10-01: interrupt at `requires_action` → `agent.tool_result` → idle `end_turn`).
 */
export function answeredCallId(event: SessionEventLike): string | null {
  if (event.type === 'user.custom_tool_result' && typeof event.custom_tool_use_id === 'string') {
    return event.custom_tool_use_id;
  }

  if (event.type === 'agent.tool_result' && typeof event.tool_use_id === 'string') {
    return event.tool_use_id;
  }

  return null;
}

/** Custom tool calls in `events` that nothing has answered. */
export function unansweredToolCalls(events: SessionEventLike[]): CustomToolUse[] {
  const answered = new Set(events.map(answeredCallId).filter((id): id is string => id !== null));

  return events
    .filter((e) => e.type === 'agent.custom_tool_use' && typeof e.id === 'string' && !answered.has(e.id))
    .map((e) => ({
      id: e.id as string,
      name: String(e.name ?? ''),
      input: e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : {},
    }));
}

/**
 * Is the current turn WAITING on our tool results? Its latest idle says `requires_action` and a custom
 * call is still unanswered. An interrupted or finished turn (latest idle `end_turn`) is not, even if a
 * stale call in it never got a result of ours.
 */
export function awaitingToolResults(events: SessionEventLike[]): boolean {
  const lastIdle = [...events].reverse().find((e) => e.type === 'session.status_idle');
  const reason = (lastIdle?.stop_reason as { type?: string } | undefined)?.type;

  return reason === 'requires_action' && unansweredToolCalls(events).length > 0;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function* runManagedTurn(input: ManagedTurnInput): AsyncGenerator<AgentChunk, ManagedTurnResult> {
  const { client, sessionId, dispatcher, abortSignal } = input;
  const resume = input.userMessage === null;
  const reducer = createEventReducer({ seenActivity: false });

  /** Tool calls already answered — by this request, or (on resume) before it. */
  const answered = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let toolCallsAnswered = 0;

  const detached = () => Boolean(abortSignal?.aborted);

  let turnId: string | undefined;
  const noteTurnId = (id: unknown) => {
    if (!turnId && typeof id === 'string' && id) {
      turnId = id;
      input.onTurnId?.(id);
    }
  };

  async function sendAnswer(call: CustomToolUse, answer: ToolAnswer): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (detached()) {
        return;
      }

      try {
        await client.beta.sessions.events.send(
          sessionId,
          {
            events: [
              {
                type: 'user.custom_tool_result',
                custom_tool_use_id: call.id,
                content: answer.content,
                ...(answer.isError ? { is_error: true } : {}),
              },
            ],
          },
          { signal: abortSignal },
        );
        toolCallsAnswered++;

        return;
      } catch (error) {
        if (detached()) {
          return;
        }

        logger.warn(
          `Could not send the result of ${call.name} (${call.id}), attempt ${attempt}: ${(error as Error)?.message}`,
        );
        await sleep(500 * attempt, abortSignal);
      }
    }
  }

  /*
   * MUTATING calls run ONE AT A TIME, in arrival order. The session can emit several tool calls at once,
   * and two `project_edit`s on one file dispatched concurrently both resolve against the same base — the
   * second write clobbers the first (seen live twice: "the first edit didn't take effect"). Reads,
   * preview calls and media do not touch the project's text, so they stay concurrent. Every call in a
   * batch still gets its result sent.
   */
  let mutationChain: Promise<unknown> = Promise.resolve();

  function dispatchInOrder(call: CustomToolUse) {
    if (!MUTATING_TOOLS.has(call.name)) {
      return dispatcher.dispatch(call);
    }

    /*
     * A call still queued when the turn detaches never runs: dispatching it would send a write to a
     * browser the session will never hear back from, and a resume re-runs it anyway.
     */
    const run = mutationChain.then(() => (detached() ? null : dispatcher.dispatch(call)));

    mutationChain = run.catch(() => undefined);

    return run;
  }

  function answer(call: CustomToolUse): void {
    if (answered.has(call.id)) {
      return;
    }

    answered.add(call.id);

    const job = (async () => {
      const result = await dispatchInOrder(call);

      if (result) {
        await sendAnswer(call, result);
      }
    })().catch((error) => logger.error(`Tool call ${call.name} (${call.id}) failed: ${(error as Error)?.message}`));

    inFlight.add(job);
    void job.finally(() => inFlight.delete(job));
  }

  const result = (end: ManagedTurnEnd): ManagedTurnResult => ({
    end,
    producedText: reducer.producedText,
    modelRequests: reducer.modelRequests,
    toolCallsAnswered,
  });

  /** Fold one event: returns its chunks and, when it ends the turn, the terminal. */
  function fold(event: SessionEventLike, replaying: boolean): { chunks: AgentChunk[]; terminal?: ManagedTerminal } {
    if (event.type === 'user.message') {
      noteTurnId(event.id);
    }

    const r = reducer.apply(event);

    if (r.toolCall) {
      if (replaying && answered.has(r.toolCall.id)) {
        /* Already answered before this request: never re-run — except the checklist, shown again, unanswered. */
        if (r.toolCall.name === 'update_todos') {
          void dispatcher.dispatch(r.toolCall, { reply: false });
        }
      } else {
        answer(r.toolCall);
      }
    }

    return { chunks: r.chunks, terminal: r.terminal };
  }

  const openStream = () =>
    client.beta.sessions.events.stream(
      sessionId,
      { event_deltas: ['agent.message', 'agent.thinking'] },
      { signal: abortSignal },
    );

  let stream: AsyncIterable<unknown>;

  try {
    stream = await openStream();

    if (resume) {
      const replay = await listCurrentTurnEvents(client, sessionId, abortSignal);

      for (const event of replay) {
        const answeredId = answeredCallId(event);

        if (answeredId) {
          answered.add(answeredId);
        }
      }

      for (const event of replay) {
        const { chunks, terminal } = fold(event, true);

        if (chunks.length) {
          yield* chunks;
        }

        if (terminal) {
          return result(terminal);
        }
      }
    } else {
      const sent = await client.beta.sessions.events.send(
        sessionId,
        { events: [input.userMessage!] },
        { signal: abortSignal },
      );

      noteTurnId(sent?.data?.find((event) => event.type === 'user.message')?.id);
    }
  } catch (error) {
    if (detached()) {
      return result({ kind: 'detached' });
    }

    throw error;
  }

  let reconnects = 0;

  for (;;) {
    try {
      for await (const raw of stream) {
        const { chunks, terminal } = fold(raw as SessionEventLike, false);

        if (chunks.length) {
          yield* chunks;
        }

        if (terminal) {
          return result(terminal);
        }
      }

      throw new Error('the event stream closed before the turn ended');
    } catch (error) {
      if (detached()) {
        return result({ kind: 'detached' });
      }

      if (++reconnects > MAX_STREAM_RECONNECTS) {
        logger.error(
          `Session ${sessionId}: giving up after ${MAX_STREAM_RECONNECTS} reconnects: ${(error as Error)?.message}`,
        );

        return result({
          kind: 'failed',
          reason: 'stream',
          message: 'The connection to the agent kept dropping. Your project is saved — send the message again.',
        });
      }

      logger.warn(`Session ${sessionId}: stream dropped (${(error as Error)?.message}) — reconnecting (${reconnects})`);
      await sleep(input.reconnectDelayMs ?? 1000 * reconnects, abortSignal);

      try {
        stream = await openStream();

        /* Catch up on whatever the session emitted while we were away; ids already seen are skipped. */
        for (const event of await listCurrentTurnEvents(client, sessionId, abortSignal)) {
          const { chunks, terminal } = fold(event, false);

          if (chunks.length) {
            yield* chunks;
          }

          if (terminal) {
            return result(terminal);
          }
        }
      } catch (reopenError) {
        if (detached()) {
          return result({ kind: 'detached' });
        }

        logger.warn(`Session ${sessionId}: reconnect failed: ${(reopenError as Error)?.message}`);
        stream = (async function* () {
          throw reopenError;
        })();
      }
    }
  }
}
