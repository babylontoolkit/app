/**
 * The live activity list and todo checklist for a tool-loop turn (tool-loop plan D20a/b/c).
 *
 * Three sources feed one shape (`ActivityState`):
 *   (a) `workspace-tool-call` parts plus the browser's own completion → rows ("Writing …" → "Wrote …");
 *   (b) `agent-todos` parts → the checklist (last write wins);
 *   (c) the persisted `agentWorkspace` annotation → the same rows after a reload (`rowsFromSummary`).
 *
 * The reducers are PURE (store in, store out) so the keying rules are testable without React; the
 * nanostore is only the place the chat's data effect writes them. Client-safe: no sandbox, no server.
 */
import { map } from 'nanostores';
import type {
  AgentWorkspaceSummary,
  GameCheckResult,
  TodoItem,
  WorkspaceOp,
  WorkspaceRunParams,
  WorkspaceToolCallPart,
  WorkspaceWriteParams,
} from '~/lib/agent/workspace-protocol-types';

export interface ActivityRow {
  toolCallId: string;
  kind: WorkspaceOp;
  label: string;
  status: 'running' | 'done' | 'failed';

  /** The path or command the row is about — what the finished label is rebuilt from. */
  subject?: string;
  screenshotDataUrl?: string;
}

export interface ActivityState {
  rows: ActivityRow[];
  todos: TodoItem[];
}

export interface WorkspaceActivityStore {
  /** The generation the latest part belonged to — what the streaming message renders. */
  current: string | null;
  byGeneration: Record<string, ActivityState>;
}

export interface RowOutcome {
  ok: boolean;
  problems?: number;
  screenshotDataUrl?: string;
}

/**
 * How many generations' live state to keep. Older ones fall back to their persisted annotation, which
 * renders the same rows minus the thumbnail — and a screenshot is ~100KB of base64 held in memory.
 */
export const MAX_TRACKED_GENERATIONS = 12;

const EMPTY_STATE: ActivityState = { rows: [], todos: [] };

function subjectOf(part: Pick<WorkspaceToolCallPart, 'op' | 'params'>): string {
  if (part.op === 'write') {
    return String((part.params as WorkspaceWriteParams)?.path ?? '');
  }

  if (part.op === 'run') {
    return String((part.params as WorkspaceRunParams)?.command ?? '');
  }

  return '';
}

function runningLabel(kind: WorkspaceOp, subject: string): string {
  if (kind === 'write') {
    return `Writing \`${subject}\``;
  }

  if (kind === 'run') {
    return `Running \`${subject}\``;
  }

  return 'Checking your game…';
}

function problemsLabel(n: number): string {
  return `Game check found ${n} problem${n === 1 ? '' : 's'}`;
}

function finishedLabel(kind: WorkspaceOp, subject: string, outcome: RowOutcome): string {
  if (kind === 'write') {
    return outcome.ok ? `Wrote \`${subject}\`` : `Could not write \`${subject}\``;
  }

  if (kind === 'run') {
    return outcome.ok ? `Ran \`${subject}\`` : `\`${subject}\` failed`;
  }

  if (outcome.ok) {
    return 'Game check passed';
  }

  const n = outcome.problems && outcome.problems > 0 ? outcome.problems : 1;

  return problemsLabel(n);
}

function withGeneration(
  store: WorkspaceActivityStore,
  generationId: string,
  update: (state: ActivityState) => ActivityState,
): WorkspaceActivityStore {
  const byGeneration = {
    ...store.byGeneration,
    [generationId]: update(store.byGeneration[generationId] ?? EMPTY_STATE),
  };
  const ids = Object.keys(byGeneration);

  // Insertion order is first-seen order; drop the oldest beyond the cap (never the one being updated).
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_GENERATIONS))) {
    if (id !== generationId) {
      delete byGeneration[id];
    }
  }

  return { current: generationId, byGeneration };
}

/** A tool call started. A repeated `toolCallId` (the data array is re-presented per chunk) is ignored. */
export function startRow(
  store: WorkspaceActivityStore,
  generationId: string,
  part: Pick<WorkspaceToolCallPart, 'toolCallId' | 'op' | 'params'>,
): WorkspaceActivityStore {
  if (store.byGeneration[generationId]?.rows.some((r) => r.toolCallId === part.toolCallId)) {
    return store;
  }

  const subject = subjectOf(part);
  const row: ActivityRow = {
    toolCallId: part.toolCallId,
    kind: part.op,
    label: runningLabel(part.op, subject),
    status: 'running',
    ...(subject ? { subject } : {}),
  };

  return withGeneration(store, generationId, (state) => ({ ...state, rows: [...state.rows, row] }));
}

/** A tool call finished. Unknown ids change nothing. */
export function finishRow(
  store: WorkspaceActivityStore,
  generationId: string,
  toolCallId: string,
  outcome: RowOutcome,
): WorkspaceActivityStore {
  const state = store.byGeneration[generationId];

  if (!state?.rows.some((r) => r.toolCallId === toolCallId)) {
    return store;
  }

  return {
    ...store,
    byGeneration: {
      ...store.byGeneration,
      [generationId]: {
        ...state,
        rows: state.rows.map((row) =>
          row.toolCallId === toolCallId
            ? {
                ...row,
                label: finishedLabel(row.kind, row.subject ?? '', outcome),
                status: outcome.ok ? 'done' : 'failed',
                ...(outcome.screenshotDataUrl ? { screenshotDataUrl: outcome.screenshotDataUrl } : {}),
              }
            : row,
        ),
      },
    },
  };
}

/** The agent replaced its todo list. Last write wins. */
export function setTodos(
  store: WorkspaceActivityStore,
  generationId: string,
  items: TodoItem[],
): WorkspaceActivityStore {
  const todos = (Array.isArray(items) ? items : [])
    .filter((t) => t && typeof t.content === 'string')
    .map((t) => ({ content: t.content, status: t.status }));

  return withGeneration(store, generationId, (state) => ({ ...state, todos }));
}

/** Rows rebuilt from the persisted `agentWorkspace` annotation (after a reload). No thumbnail. */
export function rowsFromSummary(summary: AgentWorkspaceSummary): ActivityState {
  const rows: ActivityRow[] = [];

  for (const [i, path] of (summary?.writes ?? []).entries()) {
    rows.push({
      toolCallId: `summary-write-${i}`,
      kind: 'write',
      label: `Wrote \`${path}\``,
      status: 'done',
      subject: path,
    });
  }

  for (const [i, c] of (summary?.commands ?? []).entries()) {
    const ok = c.exitCode === 0;
    rows.push({
      toolCallId: `summary-run-${i}`,
      kind: 'run',
      label: finishedLabel('run', c.command, { ok }),
      status: ok ? 'done' : 'failed',
      subject: c.command,
    });
  }

  if (summary?.lastCheck) {
    const ok = summary.lastCheck.ok;
    rows.push({
      toolCallId: 'summary-check',
      kind: 'check',
      label: finishedLabel('check', '', { ok, problems: summary.lastCheck.errors.length }),
      status: ok ? 'done' : 'failed',
    });
  }

  return { rows, todos: (summary?.todos ?? []).map((t) => ({ ...t })) };
}

/**
 * How a finished relay call reads as a row: ok/failed, the problem count, and the thumbnail. A
 * relay `error` (refused, timed out) is a failure; a command with a non-zero exit code is a failure.
 */
export function outcomeFromResult(op: WorkspaceOp, result: unknown, error?: string): RowOutcome {
  if (error || result === undefined || result === null) {
    return { ok: false, ...(op === 'check' ? { problems: 1 } : {}) };
  }

  if (op === 'run') {
    return { ok: (result as { exitCode?: number }).exitCode === 0 };
  }

  if (op === 'check') {
    const check = result as GameCheckResult;
    const problems =
      (check.typecheck && check.typecheck !== 'unavailable' ? (check.typecheck.errors?.length ?? 0) : 0) +
      (check.home?.errors?.length ?? 0) +
      (check.play?.errors?.length ?? 0);
    const shot = check.screenshot;

    return {
      ok: Boolean(check.ok),
      problems: check.ok ? 0 : Math.max(problems, 1),
      ...(shot?.base64 ? { screenshotDataUrl: `data:${shot.mimeType || 'image/png'};base64,${shot.base64}` } : {}),
    };
  }

  return { ok: true };
}

/** Which state an assistant message shows (D20 keying). Pure so the three branches are tested. */
export function resolveActivityState(input: {
  store: WorkspaceActivityStore;
  isLast: boolean;
  isStreaming: boolean;
  generationId: string | null;
  summary: AgentWorkspaceSummary | null;
}): ActivityState | null {
  const { store, isLast, isStreaming, generationId, summary } = input;

  if (isLast && isStreaming) {
    return store.current ? (store.byGeneration[store.current] ?? null) : null;
  }

  if (generationId && store.byGeneration[generationId]) {
    return store.byGeneration[generationId];
  }

  return summary ? rowsFromSummary(summary) : null;
}

function findAnnotation(annotations: unknown[] | undefined, type: string): { value?: unknown } | undefined {
  return annotations?.find(
    (a): a is { type: string; value?: unknown } =>
      Boolean(a) && typeof a === 'object' && (a as { type?: unknown }).type === type,
  );
}

/** `agentMeta.generationId` — the same parse `Chat.client.tsx`'s `readGenerationId` uses. */
export function readMessageGenerationId(annotations: unknown[] | undefined): string | null {
  const id = (findAnnotation(annotations, 'agentMeta')?.value as { generationId?: unknown } | undefined)?.generationId;

  return typeof id === 'string' && id ? id : null;
}

/** The persisted `agentWorkspace` annotation, shape-checked (it round-trips through storage). */
export function readWorkspaceSummary(annotations: unknown[] | undefined): AgentWorkspaceSummary | null {
  const value = findAnnotation(annotations, 'agentWorkspace')?.value as Partial<AgentWorkspaceSummary> | undefined;

  if (!value || typeof value !== 'object') {
    return null;
  }

  return {
    writes: Array.isArray(value.writes) ? value.writes.filter((w): w is string => typeof w === 'string') : [],
    commands: Array.isArray(value.commands)
      ? value.commands.filter((c) => c && typeof c.command === 'string' && typeof c.exitCode === 'number')
      : [],
    todos: Array.isArray(value.todos) ? value.todos.filter((t) => t && typeof t.content === 'string') : [],
    lastCheck:
      value.lastCheck && typeof value.lastCheck.ok === 'boolean'
        ? { ok: value.lastCheck.ok, errors: Array.isArray(value.lastCheck.errors) ? value.lastCheck.errors : [] }
        : null,
  };
}

export function hasActivity(state: ActivityState | null | undefined): state is ActivityState {
  return Boolean(state && (state.rows.length > 0 || state.todos.length > 0));
}

export const workspaceActivityStore = map<WorkspaceActivityStore>({ current: null, byGeneration: {} });

/** Apply a reducer to the live store. */
export function dispatchActivity(reduce: (store: WorkspaceActivityStore) => WorkspaceActivityStore): void {
  const before = workspaceActivityStore.get();
  const after = reduce(before);

  if (after !== before) {
    workspaceActivityStore.set(after);
  }
}

/**
 * A new request is starting: the streaming message must not show the PREVIOUS turn's rows until the
 * new generation's first part arrives. Finished messages keep theirs (keyed by generation id).
 */
export function clearCurrentGeneration(): void {
  if (workspaceActivityStore.get().current !== null) {
    workspaceActivityStore.setKey('current', null);
  }
}
