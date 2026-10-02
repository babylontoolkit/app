/**
 * A scripted, in-memory Managed Agents client for the managed engine's specs. NEVER imported by app code.
 *
 * Models what the engine relies on, and nothing more:
 *   - `sessions.create/retrieve/update/archive` over an in-memory session (status, budget, usage);
 *   - `events.send` records every sent event, appends it to the session log, and drives the SCRIPT: a
 *     `user.message` starts it, a `user.custom_tool_result` resolves the call it waits on, a
 *     `user.interrupt` ends it;
 *   - `events.stream` yields only events emitted AFTER it was opened (a live stream), and rejects when
 *     its request signal aborts;
 *   - `events.list` honours `order`, `types` and `created_at[gt]`.
 *
 * Every event gets an id and monotonically increasing `processed_at` / `created_at` from a fake clock.
 */
import type Anthropic from '@anthropic-ai/sdk';

export type FakeEvent = Record<string, unknown> & {
  type: string;
  id?: string;
  processed_at?: string;
  created_at?: string;
};

export interface ScriptApi {
  /** Append an agent/session event (id + timestamps assigned unless given). Returns the stored event. */
  emit(event: Record<string, unknown> & { type: string }): FakeEvent;

  /** Emit `agent.custom_tool_use` + idle `requires_action`, then wait for its result. */
  callTool(name: string, input: Record<string, unknown>): Promise<FakeEvent>;

  /** Emit a `span.model_request_end` with this usage. */
  modelRequest(
    usage: Partial<
      Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens', number>
    >,
  ): void;

  /** Emit `session.status_idle` with `end_turn` and mark the session idle. */
  endTurn(): void;

  /** Add active seconds to the session's running total. */
  addActiveSeconds(seconds: number): void;
}

export type Script = (api: ScriptApi, message: FakeEvent) => Promise<void>;

export interface FakeSessionState {
  id: string;
  status: 'idle' | 'running' | 'terminated';
  archivedAt: string | null;
  events: FakeEvent[];
  budget: unknown;
  listCostCents: number;
  activeSeconds: number;
  createParams: Record<string, unknown>;
}

export interface FakeClient {
  client: Anthropic;
  sessions: Map<string, FakeSessionState>;

  /** Every `events.send` call, in order: `{ sessionId, events }`. */
  sends: Array<{ sessionId: string; events: Array<Record<string, unknown>> }>;

  /** Every `sessions.update` call. */
  updates: Array<{ sessionId: string; params: Record<string, unknown> }>;

  /** The script run on each `user.message`. Replaceable per test. */
  script: Script;

  /**
   * What `user.interrupt` does to a call the session is waiting on. `true` (default) mirrors the live
   * API (measured 2026-10-01): it writes an `agent.tool_result` for it and idles at `end_turn`. `false`
   * leaves the call pending — the fallback path a superseding turn must handle itself.
   */
  interruptAnswersCalls: boolean;

  /**
   * Agent id → model. When a session's agent is listed here, `retrieve` reports `agent.model.id` like the
   * live API (a session's model is its agent's, fixed for its life). Unlisted agents report no agent.
   */
  agentModels: Record<string, string>;

  /** Every `sessions.archive` call, in order. */
  archived: string[];

  /** Seed a session directly (for resume / settlement specs). */
  seed(id: string, events?: Array<Record<string, unknown> & { type: string }>): FakeSessionState;

  /** Wait until the scripts started by `user.message` sends have finished. */
  idle(): Promise<void>;
}

export function createFakeManagedClient(script: Script = async (api) => api.endTurn()): FakeClient {
  const sessions = new Map<string, FakeSessionState>();
  const sends: FakeClient['sends'] = [];
  const updates: FakeClient['updates'] = [];
  const listeners = new Map<string, Set<(event: FakeEvent) => void>>();
  const waiting = new Map<
    string,
    { sessionId: string; resolve: (event: FakeEvent) => void; reject: (e: Error) => void }
  >();
  const running = new Set<Promise<void>>();
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  let seq = 0;

  const state: FakeClient = {
    client: undefined as unknown as Anthropic,
    sessions,
    sends,
    updates,
    script,
    interruptAnswersCalls: true,
    agentModels: {},
    archived: [],
    seed,
    idle: async () => {
      while (running.size) {
        await Promise.allSettled([...running]);
      }
    },
  };

  function stamp(event: Record<string, unknown> & { type: string }): FakeEvent {
    clock += 1000;

    const at = new Date(clock).toISOString();

    return { id: `sevt_${++seq}`, processed_at: at, created_at: at, ...event } as FakeEvent;
  }

  function append(session: FakeSessionState, raw: Record<string, unknown> & { type: string }): FakeEvent {
    const event = stamp(raw);
    session.events.push(event);
    listeners.get(session.id)?.forEach((listener) => listener(event));

    return event;
  }

  function seed(id: string, events: Array<Record<string, unknown> & { type: string }> = []): FakeSessionState {
    const session: FakeSessionState = {
      id,
      status: 'idle',
      events: [],
      budget: null,
      archivedAt: null,
      listCostCents: 0,
      activeSeconds: 0,
      createParams: {},
    };
    sessions.set(id, session);

    for (const event of events) {
      append(session, event);
    }

    return session;
  }

  function apiFor(session: FakeSessionState): ScriptApi {
    return {
      emit: (event) => append(session, event),
      callTool: (name, input) => {
        const call = append(session, { type: 'agent.custom_tool_use', name, input });
        append(session, {
          type: 'session.status_idle',
          stop_reason: { type: 'requires_action', event_ids: [call.id] },
          stop_details: null,
        });
        session.status = 'idle';

        return new Promise<FakeEvent>((resolve, reject) =>
          waiting.set(call.id as string, { sessionId: session.id, resolve, reject }),
        );
      },
      modelRequest: (usage) => {
        append(session, {
          type: 'span.model_request_end',
          is_error: false,
          model_request_start_id: 'start',
          model_usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            ...usage,
          },
        });
      },
      endTurn: () => {
        session.status = 'idle';
        append(session, { type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null });
      },
      addActiveSeconds: (seconds) => {
        session.activeSeconds += seconds;
      },
    };
  }

  function requireSession(id: string): FakeSessionState {
    const session = sessions.get(id);

    if (!session) {
      throw Object.assign(new Error(`no session ${id}`), { status: 404 });
    }

    return session;
  }

  const retrieve = async (id: string) => {
    const s = requireSession(id);
    const agentId = (s.createParams.agent as { id?: string } | undefined)?.id;
    const model = agentId ? state.agentModels[agentId] : undefined;

    return {
      id: s.id,
      ...(model ? { agent: { type: 'agent', id: agentId, model: { id: model, effort: 'medium' } } } : {}),
      status: s.status,
      archived_at: s.archivedAt,
      budget: s.budget,
      usage: { active_seconds: s.activeSeconds, list_cost: { amount: String(s.listCostCents), currency: 'USD' } },
      stats: { active_seconds: s.activeSeconds },
    };
  };

  const client = {
    beta: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          const id = `sesn_${sessions.size + 1}`;
          const session = seed(id);
          session.createParams = params;
          session.budget = params.budget ?? null;

          return { id };
        },
        retrieve,
        update: async (id: string, params: Record<string, unknown>) => {
          updates.push({ sessionId: id, params });
          requireSession(id).budget = params.budget ?? null;

          return retrieve(id);
        },
        archive: async (id: string) => {
          state.archived.push(id);
          requireSession(id).archivedAt = new Date(clock).toISOString();

          return retrieve(id);
        },
        events: {
          send: async (id: string, params: { events: Array<Record<string, unknown> & { type: string }> }) => {
            const session = requireSession(id);
            sends.push({ sessionId: id, events: params.events });

            for (const raw of params.events) {
              const event = append(session, raw);

              if (raw.type === 'user.message') {
                session.status = 'running';
                append(session, { type: 'session.status_running' });

                /* A script cut short by an interrupt rejects; that is the script ending, not a test error. */
                const job = state
                  .script(apiFor(session), event)
                  .catch(() => undefined)
                  .finally(() => running.delete(job));
                running.add(job);
              } else if (raw.type === 'user.custom_tool_result') {
                const waiter = waiting.get(raw.custom_tool_use_id as string);
                waiting.delete(raw.custom_tool_use_id as string);
                session.status = 'running';
                waiter?.resolve(event);
              } else if (raw.type === 'user.interrupt') {
                const pending = [...waiting.entries()].filter(([, w]) => w.sessionId === id);

                if (pending.length && !state.interruptAnswersCalls) {
                  /* The API left the calls pending: the session stays waiting on them. */
                  continue;
                }

                for (const [callId, waiter] of pending) {
                  waiting.delete(callId);
                  append(session, { type: 'agent.tool_result', tool_use_id: callId, content: [] });
                  waiter.reject(new Error('interrupted'));
                }

                session.status = 'idle';
                append(session, { type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null });
              }
            }

            return { data: [] };
          },
          stream: async (id: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
            requireSession(id);

            const queue: FakeEvent[] = [];
            let wake: (() => void) | null = null;
            const listener = (event: FakeEvent) => {
              queue.push(event);
              wake?.();
            };

            if (!listeners.has(id)) {
              listeners.set(id, new Set());
            }

            listeners.get(id)!.add(listener);

            const signal = options?.signal;

            return (async function* () {
              try {
                for (;;) {
                  if (signal?.aborted) {
                    throw Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
                  }

                  if (queue.length) {
                    yield queue.shift()!;
                    continue;
                  }

                  await new Promise<void>((resolve) => {
                    wake = resolve;
                    signal?.addEventListener('abort', () => resolve(), { once: true });
                  });
                  wake = null;
                }
              } finally {
                listeners.get(id)?.delete(listener);
              }
            })();
          },
          list: (id: string, params: Record<string, unknown> = {}) => {
            const session = requireSession(id);
            const types = params.types as string[] | undefined;
            const after = params['created_at[gt]'] as string | undefined;
            let events = session.events.filter(
              (e) => (!types || types.includes(e.type)) && (!after || Date.parse(e.created_at!) > Date.parse(after)),
            );

            if (params.order === 'desc') {
              events = [...events].reverse();
            }

            return (async function* () {
              yield* events;
            })();
          },
        },
      },
    },
  };

  state.client = client as unknown as Anthropic;

  return state;
}
