/**
 * Session events → the chat's stream (`_specs/managed-agents-engine_plan.md` T5). Pure.
 *
 * The client already renders a turn from three things: `text` chunks (the narration), `reasoning`
 * chunks (the `g:` channel), and data parts for tool calls. This reducer turns each Managed Agents
 * event into the first two and hands custom tool calls to the caller (`turn.ts`), which runs them
 * through the legacy executes so the data parts are the ones the browser already handles.
 *
 * ## What it decides
 *
 *   - **Text.** `agent.message` arrives whole; with `event_deltas` on, its text also arrives early as
 *     `event_delta` parts. Both are accepted: the deltas stream, and the whole message then adds only
 *     what the deltas did not already show (nothing, normally). Consecutive messages are separate
 *     paragraphs — a blank line between them, never glued.
 *   - **Reasoning.** `agent.thinking` carries no text; its deltas (when the API sends any) go to the
 *     reasoning channel, never to text (text feeds the artifact parser).
 *   - **The end of the turn.** `session.status_idle` with `end_turn` ends it — but only once THIS turn
 *     has shown activity, so a stale idle event delivered ahead of our own message cannot end a turn
 *     that never started. `requires_action` is "waiting on our tool results", never an end.
 *     `budget_reached` is the credit ceiling (D13); `retries_exhausted`, `refusal`, a terminal or
 *     exhausted `session.error` and `session.status_terminated` are failures.
 *
 * Events are deduplicated by id: a reconnect replays the turn's events and the stream may repeat one.
 */
import type { AgentChunk } from '~/lib/.server/agent/proxy';

export type ManagedTerminal =
  | { kind: 'end_turn' }
  | { kind: 'budget' }
  | { kind: 'failed'; reason: string; message: string };

/** The shape of an `agent.custom_tool_use` the dispatcher needs. */
export interface CustomToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Any session event, structurally — the reducer reads only the fields it needs. */
export interface SessionEventLike {
  type?: string;
  id?: string;
  processed_at?: string | null;
  [key: string]: unknown;
}

export interface ReduceResult {
  chunks: AgentChunk[];
  toolCall?: CustomToolUse;
  terminal?: ManagedTerminal;

  /** A `span.model_request_end` — the turn made a model request. */
  modelRequest?: boolean;
}

export interface ManagedEventReducer {
  apply(event: SessionEventLike): ReduceResult;

  /** Did this turn put any narration on screen? (The empty-response verdict reads it.) */
  readonly producedText: boolean;

  /** Model requests seen by this reducer. */
  readonly modelRequests: number;
}

export interface ReducerOptions {
  /**
   * Has this turn already shown activity? `false` for a fresh send (the first `end_turn` idle must be
   * preceded by something of ours); `true` for a resume whose replay already contained the turn.
   */
  seenActivity?: boolean;
}

/** Event types that prove the turn is under way. */
const ACTIVITY_TYPES = new Set([
  'user.message',
  'session.status_running',
  'agent.message',
  'agent.thinking',
  'agent.tool_use',
  'agent.tool_result',
  'agent.custom_tool_use',
  'span.model_request_start',
  'span.model_request_end',
  'event_start',
  'event_delta',
]);

function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(
      (block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function errorTerminal(event: SessionEventLike): ManagedTerminal | undefined {
  const error = (event.error ?? {}) as { type?: string; message?: string; retry_status?: { type?: string } };
  const retry = error.retry_status?.type;

  if (retry === 'retrying') {
    return undefined;
  }

  return {
    kind: 'failed',
    reason: `session.error:${error.type ?? 'unknown'}`,
    message: error.message || 'The agent session reported an error.',
  };
}

export function createEventReducer(options: ReducerOptions = {}): ManagedEventReducer {
  const seen = new Set<string>();
  let seenActivity = options.seenActivity ?? false;

  /** Text already emitted per message event id (deltas first, then the whole message). */
  const emittedByEvent = new Map<string, string>();

  /** Which channel each started event belongs to (`event_start` names it before its deltas arrive). */
  const channelByEvent = new Map<string, 'text' | 'reasoning'>();

  let producedText = false;
  let producedReasoning = false;
  let modelRequests = 0;

  /** Open a new paragraph on a channel the first time an event writes to it. */
  function opening(channel: 'text' | 'reasoning', eventId: string): string {
    if (emittedByEvent.has(eventId)) {
      return '';
    }

    emittedByEvent.set(eventId, '');

    const already = channel === 'text' ? producedText : producedReasoning;

    return already ? '\n\n' : '';
  }

  function emit(channel: 'text' | 'reasoning', eventId: string, text: string): AgentChunk[] {
    if (!text) {
      return [];
    }

    const prefix = opening(channel, eventId);
    emittedByEvent.set(eventId, (emittedByEvent.get(eventId) ?? '') + text);

    if (channel === 'text') {
      producedText = true;
    } else {
      producedReasoning = true;
    }

    return [{ type: channel, value: prefix + text }];
  }

  return {
    get producedText() {
      return producedText;
    },
    get modelRequests() {
      return modelRequests;
    },

    apply(event: SessionEventLike): ReduceResult {
      const result: ReduceResult = { chunks: [] };
      const type = event.type ?? '';

      if (typeof event.id === 'string' && event.id) {
        if (seen.has(event.id)) {
          return result;
        }

        seen.add(event.id);
      }

      if (ACTIVITY_TYPES.has(type)) {
        seenActivity = true;
      }

      switch (type) {
        case 'event_start': {
          const preview = (event.event ?? {}) as { id?: string; type?: string };

          if (preview.id) {
            channelByEvent.set(preview.id, preview.type === 'agent.thinking' ? 'reasoning' : 'text');
          }

          break;
        }

        case 'event_delta': {
          const eventId = typeof event.event_id === 'string' ? event.event_id : '';
          const delta = (event.delta ?? {}) as { content?: { type?: string; text?: string } };
          const text = delta.content?.type === 'text' ? (delta.content.text ?? '') : '';

          /*
           * A delta whose `event_start` we never saw (a reconnect mid-message) is DROPPED, not guessed:
           * guessing "text" would put thinking into the artifact parser's channel. The whole
           * `agent.message` still delivers the text.
           */
          const channel = channelByEvent.get(eventId);

          if (eventId && text && channel) {
            result.chunks.push(...emit(channel, eventId, text));
          }

          break;
        }

        case 'agent.message': {
          const eventId = event.id ?? `message-${seen.size}`;
          const full = textOf(event.content);
          const shown = emittedByEvent.get(eventId) ?? '';

          /*
           * The deltas already showed (part of) this message: add only the rest. A whole message that
           * does not extend what was shown (an edit we cannot reconcile) adds nothing — the user has
           * already read the streamed version, and appending a second copy is the worse error.
           */
          if (!shown) {
            result.chunks.push(...emit('text', eventId, full));
          } else if (full.startsWith(shown) && full.length > shown.length) {
            result.chunks.push(...emit('text', eventId, full.slice(shown.length)));
          }

          break;
        }

        case 'agent.custom_tool_use': {
          if (typeof event.id === 'string' && typeof event.name === 'string') {
            const input =
              event.input && typeof event.input === 'object' ? (event.input as Record<string, unknown>) : {};
            result.toolCall = { id: event.id, name: event.name, input };
          }

          break;
        }

        case 'span.model_request_end':
          modelRequests++;
          result.modelRequest = true;
          break;

        case 'session.status_idle': {
          const stop = (event.stop_reason ?? {}) as { type?: string };
          const details = (event.stop_details ?? null) as { explanation?: string | null } | null;

          if (stop.type === 'end_turn') {
            if (seenActivity) {
              result.terminal = { kind: 'end_turn' };
            }
          } else if (stop.type === 'budget_reached') {
            result.terminal = { kind: 'budget' };
          } else if (stop.type === 'retries_exhausted') {
            result.terminal = {
              kind: 'failed',
              reason: 'retries_exhausted',
              message: 'The agent could not reach the model after several retries.',
            };
          } else if (stop.type === 'refusal') {
            result.terminal = {
              kind: 'failed',
              reason: 'refusal',
              message: details?.explanation
                ? `The model declined this request: ${details.explanation}`
                : 'The model declined this request.',
            };
          }

          /* `requires_action`: waiting on our tool results — the caller is already answering them. */
          break;
        }

        case 'session.status_terminated':
          result.terminal = { kind: 'failed', reason: 'terminated', message: 'The agent session was terminated.' };
          break;

        case 'session.deleted':
          result.terminal = { kind: 'failed', reason: 'deleted', message: 'The agent session was deleted.' };
          break;

        case 'session.error':
          result.terminal = errorTerminal(event);
          break;

        default:
      }

      return result;
    },
  };
}
