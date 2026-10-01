/**
 * The workspace tools — how the agent changes the project in the tool loop (tool-loop plan D1–D8).
 *
 * `write_file`, `edit_file`, `run_command`, `check_game` and `update_todos`. They are relay tools, the
 * same shape as `preview-tools.ts` and the §4.14 MCP relay: `execute` EMITS a `workspace-tool-call`
 * data part, the browser runs it in the user's sandbox (`agent-workspace/executor.ts`), and POSTs the
 * result to `/api/agent/tool-result`, which unblocks `execute`. One generation, one settlement.
 *
 * ## The server owns text contents during a turn (D4)
 *
 * The request carries the client's file map (`projectFiles`), and it goes stale the moment the agent
 * writes. `WorkspaceOverlay` sits over it: every successful write lands here, `read_file` reads here
 * first (read-your-writes), and `edit_file` is resolved HERE against that text — the browser only ever
 * performs full writes. One place holds the truth, so the model's edit and the file on disk cannot
 * disagree.
 *
 * 🔴 The overlay is updated ONLY after the client confirms. A relay error (timeout, Stop, the browser
 * threw) leaves it untouched, or the model would read back a write that never happened.
 *
 * ## Never regress
 *
 *  - **Validate in `execute`, never in the schema.** Every argument is `.optional()`; a zod violation
 *    kills a paid generation after the tokens are spent.
 *  - **Never throw.** Every refusal and failure is a sentence the model can act on.
 *  - **Binaries never travel here** (SPEC §1.3 principle 10) — the relay is a text channel; binary
 *    files come from the media tools.
 *  - **Results are capped on arrival** — the payload comes from a browser (the `preview-tools.ts` rule).
 *  - **Plan mode (`planOnly`) has exactly one write door, `_specs/`**, enforced here on the server,
 *    because a tool write bypasses the client-side render-only parser that walls artifact writes.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { FileMap } from '~/lib/.server/llm/constants';
import {
  type AgentWorkspaceSummary,
  CHECK_ERROR_MAX_CHARS,
  CHECK_MAX_ERRORS,
  DISALLOWED_RUN_SCRIPTS,
  type GameCheckResult,
  RUN_OUTPUT_TAIL_CHARS,
  type TodoItem,
  WORKSPACE_CHECK_TIMEOUT_MS,
  WORKSPACE_RUN_TIMEOUT_MS,
  WORKSPACE_WRITE_TIMEOUT_MS,
  type WorkspaceOp,
  type WorkspaceToolCallPart,
} from '~/lib/agent/workspace-protocol-types';
import { applyStringEdit } from '~/lib/agent/string-edit';
import { isBinaryPath } from '~/lib/binary/binary-files';
import { isPlanArtifactPath } from '~/lib/chat/plan-artifacts';
import { isSandboxAbsolutePath, toProjectRelativePath } from '~/lib/common/sandbox-paths';
import { isAllowedShellCommand } from '~/lib/runtime/shell-allowlist';
import { resolveFile } from './file-tools';
import { awaitClientToolResult } from './mcp-relay';
import { MAX_SCREENSHOT_BASE64 } from './preview-tools';

/** What the route forwards to the client as a `workspace-tool-call` data part. */
export interface WorkspaceToolCallEvent {
  toolCallId: string;
  op: WorkspaceOp;
  params: WorkspaceToolCallPart['params'];
}

/**
 * The turn's text view of the project: the client's file map with this turn's writes on top.
 * Paths are normalised project-relative on the way in, so `src/a.ts` and `/home/project/src/a.ts`
 * are one file.
 */
/**
 * Whether a write can change the running game, and so arms the done-gate (D11). Markdown (`SPEC.md`,
 * `DESIGN.md`, anything `*.md`) cannot — gating on it forces a `check_game` that verifies nothing
 * (~90 s per build). Everything else arms it, including the `package.json` a `run_command` writes.
 *
 * Only the GATE uses this. Whether the turn produced files (the outcome and the no-files refund) still
 * counts EVERY write — a markdown-only phase did produce files.
 */
export function writeArmsDoneGate(path: string): boolean {
  return !/\.md$/i.test(path.trim());
}

/**
 * The done-gate's write facts for a segment boundary — the one place `wroteThisTurn` is derived.
 * A Plan turn's only writes are `_specs/` planning artifacts, which no game check can verify, so a
 * Plan turn never arms the gate; otherwise only game-affecting writes (`writeArmsDoneGate`) do.
 */
export function doneGateWriteFacts(
  overlay: Pick<WorkspaceOverlay, 'gateWriteSeq'> | undefined,
  planTurn: boolean,
): { wroteThisTurn: boolean; lastWriteSeq: number } {
  const seq = overlay?.gateWriteSeq ?? 0;

  return { wroteThisTurn: !planTurn && seq > 0, lastWriteSeq: seq };
}

export class WorkspaceOverlay {
  /** EVERY path written this turn — the outcome's "did it produce files". */
  readonly writes = new Set<string>();
  lastWriteSeq = 0;

  /** Counts only writes that arm the done-gate (`writeArmsDoneGate`); a check records this one. */
  gateWriteSeq = 0;

  readonly #base: FileMap;
  readonly #written = new Map<string, string>();

  constructor(base: FileMap) {
    this.#base = base;
  }

  /** Project-relative; overlay first, then a base TEXT file. `undefined` if binary or missing. */
  read(path: string): string | undefined {
    const rel = toProjectRelativePath(path.trim());

    if (this.#written.has(rel)) {
      return this.#written.get(rel);
    }

    const hit = resolveFile(this.#base, rel);

    if (!hit || hit.dirent.isBinary) {
      return undefined;
    }

    return hit.dirent.content;
  }

  /** Did THIS turn write the path? (A read of the agent's own write is free — see `file-tools.ts`.) */
  wrote(path: string): boolean {
    return this.#written.has(toProjectRelativePath(path.trim()));
  }

  write(path: string, content: string): void {
    const rel = toProjectRelativePath(path.trim());
    this.#written.set(rel, content);
    this.writes.add(rel);
    this.lastWriteSeq++;

    if (writeArmsDoneGate(rel)) {
      this.gateWriteSeq++;
    }
  }
}

export interface WorkspaceTurnState {
  commands: Array<{ command: string; exitCode: number }>;
  todos: TodoItem[];
  lastCheck: { ok: boolean; errors: string[]; afterWriteSeq: number } | null;
  checkFailureSignatures: string[]; // last 3

  /** The one-per-turn "call update_todos" nudge has been given (D20b). */
  todoNudged?: boolean;
}

export interface WorkspaceToolContext {
  generationId: string;
  userId: string;
  abortSignal?: AbortSignal;
  emit: (part: WorkspaceToolCallEvent) => void;
  emitTodos: (items: TodoItem[]) => void;
  overlay: WorkspaceOverlay;
  state: WorkspaceTurnState;
  planOnly: boolean;
}

export function newWorkspaceTurnState(): WorkspaceTurnState {
  return { commands: [], todos: [], lastCheck: null, checkFailureSignatures: [], todoNudged: false };
}

export const TODO_TICK_HINT = 'check_game passed — call update_todos now and mark every finished item completed.';

export const TODO_NUDGE =
  'Before you change any file: call update_todos now with the steps you are about to take (the user watches this checklist live), then mark each item in_progress/completed as you go.';

/**
 * The checklist nudge (tool-loop plan D20b, T9 fix loops 2–3). The protocol asks for `update_todos`
 * before the first write, and live the model skipped it on every turn — while a forced `tool_choice` is
 * not an option (Anthropic rejects it with extended thinking). So the FIRST tool result of a turn with
 * no list yet — read, write, edit, run or check, whichever comes first — carries one line asking for
 * it: once per turn in total, never in plan mode, never once a list exists. Returns the bare sentence
 * (callers frame it) or ''.
 */
export function todoNudgeFor(state: WorkspaceTurnState, planOnly: boolean): string {
  if (planOnly || state.todoNudged || state.todos.length > 0) {
    return '';
  }

  state.todoNudged = true;

  return TODO_NUDGE;
}

/**
 * The checklist at the end of a turn (tool-loop plan T9, owner 2026-09-30: "i dont want unchecked items").
 *
 * The model calls `update_todos` inconsistently and almost never ticks its last items, so a FINISHED
 * turn used to leave a half-unchecked list on screen beside "Your game is ready". When the segment
 * decision was `done` — the model ended its turn and the done-gate is satisfied (verified, or nothing
 * that needs verifying was written) — every item not `completed` is completed by the platform.
 *
 * A turn that STOPPED short (ceiling, segments, breaker, a user Stop) keeps its open items exactly as
 * they are: they are the real remaining work, shown next to Keep building. Ticking them there would be
 * claiming work that did not happen.
 *
 * Pure. Returns the SAME array when nothing changes (stopped, empty, or already all completed), so a
 * caller can emit only on a real change; otherwise a new list of new items.
 */
export function finalizeTodos(todos: TodoItem[], endedDone: boolean): TodoItem[] {
  if (!endedDone || todos.every((t) => t.status === 'completed')) {
    return todos;
  }

  return todos.map((t) => ({ content: t.content, status: 'completed' as const }));
}

/**
 * Apply `finalizeTodos` to the turn's state and emit the completed list as an `agent-todos` part, so the
 * live checklist ticks. The persisted `agentWorkspace` summary is built from `state.todos` afterwards,
 * so it carries the completed list too. Returns whether anything was emitted.
 */
export function completeTodosOnDone(
  state: WorkspaceTurnState,
  endedDone: boolean,
  emitTodos: (items: TodoItem[]) => void,
): boolean {
  const next = finalizeTodos(state.todos, endedDone);

  if (next === state.todos) {
    return false;
  }

  state.todos = next;
  emitTodos(next.map((item) => ({ ...item })));

  return true;
}

/** The nudge as a trailing line of a tool result. */
function nudgeLine(state: WorkspaceTurnState, planOnly: boolean): string {
  const line = todoNudgeFor(state, planOnly);

  return line ? `\n${line}` : '';
}

/** How many failure signatures the breaker remembers, and how many equal ones trip it. */
const BREAKER_WINDOW = 3;

/** Signature of a failed check: identical errors three times running means the loop is stuck. */
function failureSignature(errors: string[]): string {
  return errors.join('\n').slice(0, 200);
}

/** Three stored signatures, all equal — the fix-check loop is not converging (D11). */
export function checkBreakerTripped(state: WorkspaceTurnState): boolean {
  const sigs = state.checkFailureSignatures;

  return sigs.length >= BREAKER_WINDOW && sigs.slice(-BREAKER_WINDOW).every((s) => s === sigs[sigs.length - 1]);
}

/** Summary errors are tighter than the check's own: 10 × 300 (it rides in history and the annotation). */
const SUMMARY_MAX_ERRORS = 10;

export function summarizeWorkspace(overlay: WorkspaceOverlay, state: WorkspaceTurnState): AgentWorkspaceSummary {
  return {
    writes: [...overlay.writes],
    commands: state.commands.map((c) => ({ ...c })),
    todos: state.todos.map((t) => ({ ...t })),
    lastCheck: state.lastCheck
      ? {
          ok: state.lastCheck.ok,
          errors: state.lastCheck.errors.slice(0, SUMMARY_MAX_ERRORS).map((e) => e.slice(0, CHECK_ERROR_MAX_CHARS)),
        }
      : null,
  };
}

/*
 * ─── path rules ────────────────────────────────────────────────────────────────────────────────────
 */

/** The starter's read-only zones (CLAUDE.md "Project file zones"; SPEC §4.4c). */
const READ_ONLY_ZONES: Array<{ test: (rel: string) => boolean; name: string }> = [
  {
    test: (rel) => rel.startsWith('src/babylon/classes/'),
    name: 'src/babylon/classes/ (read-only demo library — copy FROM it into src/scripts/)',
  },
  { test: (rel) => rel.startsWith('src/babylon/system/'), name: 'src/babylon/system/ (read-only framework internals)' },
  { test: (rel) => rel.startsWith('src/routing/'), name: 'src/routing/ (read-only app shell)' },
  { test: (rel) => rel === 'src/app.tsx', name: 'src/app.tsx (read-only app shell)' },
];

export const PLAN_ONLY_REFUSAL = 'Plan mode is read-only. Only files under _specs/ can be written.';

/**
 * The path argument of `write_file` / `edit_file`, under either spelling.
 *
 * 🔴 Found live (T9 acceptance): `read_file` takes `path` (with `file_path` as an alias), while the two
 * write tools took ONLY `file_path` — and zod strips an unknown key, so a model that carried
 * `read_file`'s spelling over had EVERY edit refused ("needs a file_path"), twice in two turns, each
 * costing a full extra round. The three file tools now accept the same two spellings; `file_path`
 * wins when both are sent.
 */
function writePathArg(args: { file_path?: unknown; path?: unknown }): unknown {
  return typeof args.file_path === 'string' && args.file_path.trim() ? args.file_path : args.path;
}

/**
 * Normalise and vet a path the model wants to WRITE. Returns the project-relative path, or a refusal
 * sentence. Shared by `write_file` and `edit_file` so the two doors cannot disagree.
 */
function vetWritePath(raw: unknown, planOnly: boolean): { rel: string } | { refusal: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { refusal: 'This tool needs a "file_path" — a project-relative path such as src/scripts/Player.ts.' };
  }

  const trimmed = raw.trim();

  /*
   * An absolute path is only acceptable when it is inside a sandbox root — `toProjectRelativePath`
   * strips ANY leading slash, so `/etc/passwd` would otherwise quietly become `etc/passwd`.
   */
  if (trimmed.startsWith('/') && !isSandboxAbsolutePath(trimmed)) {
    return { refusal: `"${trimmed}" is outside the project. Use a project-relative path such as src/pages/Home.tsx.` };
  }

  let rel = toProjectRelativePath(trimmed);

  while (rel.startsWith('./')) {
    rel = rel.slice(2);
  }

  const segments = rel.split('/');

  if (!rel || rel.includes('\\') || segments.some((s) => s === '..' || s === '.' || s === '')) {
    return {
      refusal: `"${trimmed}" is not a valid project path. Use a project-relative path such as src/pages/Home.tsx.`,
    };
  }

  if (planOnly && !isPlanArtifactPath(rel)) {
    return { refusal: PLAN_ONLY_REFUSAL };
  }

  if (isBinaryPath(rel)) {
    return {
      refusal: `"${rel}" is a binary file — binary files come from the media tools (or are already in the project), never from write_file/edit_file.`,
    };
  }

  if (segments[segments.length - 1] === 'package-lock.json') {
    return {
      refusal: 'package-lock.json is generated by npm — never write it. Use run_command with npm install instead.',
    };
  }

  const zone = READ_ONLY_ZONES.find((z) => z.test(rel));

  if (zone) {
    return { refusal: `"${rel}" is in a read-only zone: ${zone.name}. It cannot be written.` };
  }

  return { rel };
}

/*
 * ─── result shaping ────────────────────────────────────────────────────────────────────────────────
 */

/** Keep the END of command output — npm and tsc print the actionable lines last. */
function tail(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `…(earlier output truncated)\n${text.slice(text.length - max)}`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry : entry == null ? '' : JSON.stringify(entry)))
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(0, CHECK_ERROR_MAX_CHARS));
}

/** A check result from a browser is untrusted: normalise every field before believing any of it. */
function normaliseCheck(raw: unknown): GameCheckResult {
  const r = (raw ?? {}) as Record<string, any>;

  const typecheck: GameCheckResult['typecheck'] =
    r.typecheck === 'unavailable' || !r.typecheck || typeof r.typecheck !== 'object'
      ? 'unavailable'
      : { ok: r.typecheck.ok === true, errors: stringList(r.typecheck.errors) };

  const home = { errors: stringList(r.home?.errors) };

  const play: GameCheckResult['play'] =
    r.play && typeof r.play === 'object'
      ? {
          errors: stringList(r.play.errors),
          hasScene: r.play.hasScene === true,
          meshes: Number.isFinite(r.play.meshes) ? Number(r.play.meshes) : 0,
          ready: r.play.ready === true,
        }
      : null;

  const screenshot =
    r.screenshot && typeof r.screenshot.base64 === 'string' && r.screenshot.base64
      ? {
          base64: r.screenshot.base64 as string,
          mimeType: typeof r.screenshot.mimeType === 'string' ? r.screenshot.mimeType : 'image/jpeg',
        }
      : null;

  /*
   * `ok` is RE-DERIVED (D8's formula) and ANDed with the client's claim: a passing verdict needs both
   * the browser to say so and the evidence it sent to agree.
   */
  const derived =
    (typecheck === 'unavailable' || typecheck.ok) &&
    home.errors.length === 0 &&
    (play === null || (play.errors.length === 0 && play.hasScene));

  return { ok: r.ok === true && derived, typecheck, home, play, screenshot };
}

export interface CheckGameToolResult {
  verdict: string;
  screenshot?: { base64: string; mimeType: string };
}

/*
 * ─── the tools ─────────────────────────────────────────────────────────────────────────────────────
 */

type ClientOutcome = { ok: true; result: unknown } | { ok: false; message: string };

async function relay(
  ctx: WorkspaceToolContext,
  toolCallId: string,
  abortSignal: AbortSignal | undefined,
  op: WorkspaceOp,
  params: WorkspaceToolCallPart['params'],
  timeoutMs: number,
): Promise<ClientOutcome> {
  ctx.emit({ toolCallId, op, params });

  const outcome = await awaitClientToolResult({
    generationId: ctx.generationId,
    toolCallId,
    userId: ctx.userId,
    abortSignal: abortSignal ?? ctx.abortSignal,
    timeoutMs,
  });

  if (outcome.error) {
    return { ok: false, message: `The workspace could not complete this: ${outcome.error}` };
  }

  return { ok: true, result: outcome.result };
}

const lineCount = (content: string) => (content === '' ? 0 : content.split('\n').length);

const RUN_REFUSAL = 'That command is not allowed. Allowed: npm install <pkg>, npm run <script> (not dev or preview).';

/** Is the command allowed for `run_command`? The shell allow-list, minus the long-lived servers. */
function vetCommand(command: string): string | null {
  if (!isAllowedShellCommand(command).allowed) {
    return RUN_REFUSAL;
  }

  for (const segment of command.split('&&')) {
    const [program, sub, script] = segment.trim().split(/\s+/);

    if (program === 'npm' && sub === 'run' && (DISALLOWED_RUN_SCRIPTS as readonly string[]).includes(script)) {
      return `${RUN_REFUSAL} The dev server is already running — the preview updates on its own.`;
    }
  }

  return null;
}

const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed']);
const MAX_TODOS = 50;
const MAX_TODO_CHARS = 300;

export function createWorkspaceTools(ctx: WorkspaceToolContext): Record<string, ReturnType<typeof tool>> {
  const { overlay, state } = ctx;

  const writeFile = tool({
    description:
      'Create a file, or replace a whole file, in the project. Pass the COMPLETE file content — never a ' +
      'fragment or a placeholder. Paths are project-relative (e.g. `src/scripts/PlayerController.ts`). ' +
      'Prefer edit_file to change part of an existing file. Text files only: binary files (images, ' +
      'audio, models) come from the media tools.',
    parameters: z.object({
      file_path: z.string().optional().describe('Project-relative path, e.g. src/pages/Home.tsx'),

      /* `read_file`'s spelling — accepted here too (see `writePathArg`). */
      path: z.string().optional().describe('Alias of `file_path`.'),
      content: z.string().optional().describe('The complete file content'),
    }),
    execute: async (args, { toolCallId, abortSignal }) => {
      const { content } = args;
      const vetted = vetWritePath(writePathArg(args), ctx.planOnly);

      if ('refusal' in vetted) {
        return vetted.refusal;
      }

      if (typeof content !== 'string') {
        return 'write_file needs "content" — the complete text of the file.';
      }

      const outcome = await relay(
        ctx,
        toolCallId,
        abortSignal,
        'write',
        { path: vetted.rel, content },
        WORKSPACE_WRITE_TIMEOUT_MS,
      );

      if (!outcome.ok) {
        return outcome.message;
      }

      overlay.write(vetted.rel, content);

      return `Wrote ${vetted.rel} (${lineCount(content)} lines).${nudgeLine(state, ctx.planOnly)}`;
    },
  });

  const updateTodos = tool({
    description:
      'Replace your todo list for this turn — the user sees it as a live checklist. REQUIRED on any ' +
      'change that touches more than one file: call it with every step you plan BEFORE your first ' +
      'write_file/edit_file, then again as you go — mark exactly one item `in_progress` while you work ' +
      'on it and `completed` as soon as it is done.',
    parameters: z.object({
      /*
       * Loose on purpose: a bare-string item or a non-string status must reach `execute` (which coerces
       * it) rather than fail zod — a schema violation kills a paid generation after the tokens are spent.
       */
      items: z
        .array(
          z.union([
            z.string(),
            z.object({
              content: z.any().optional().describe('What this step does'),
              status: z.any().optional().describe('pending | in_progress | completed'),
            }),
          ]),
        )
        .optional()
        .describe('The whole list, in order'),
    }),
    execute: async ({ items }) => {
      const list: TodoItem[] = (Array.isArray(items) ? items : [])
        .map((item) => (typeof item === 'string' ? { content: item, status: 'pending' } : item))
        .filter((item) => item && typeof item.content === 'string' && item.content.trim())
        .slice(0, MAX_TODOS)
        .map((item) => ({
          content: (item.content as string).trim().slice(0, MAX_TODO_CHARS),
          status: TODO_STATUSES.has(item.status as TodoItem['status'])
            ? (item.status as TodoItem['status'])
            : 'pending',
        }));

      state.todos = list;
      ctx.emitTodos(list.map((item) => ({ ...item })));

      const done = list.filter((item) => item.status === 'completed').length;

      return `Todo list updated (${done}/${list.length} complete).`;
    },
  });

  if (ctx.planOnly) {
    /* Plan mode: the one write door (`_specs/`, enforced in `vetWritePath`) and the checklist. */
    return { write_file: writeFile, update_todos: updateTodos } as unknown as Record<string, ReturnType<typeof tool>>;
  }

  const editFile = tool({
    description:
      'Change part of an existing file by replacing an exact string. `old_string` must match the file ' +
      'EXACTLY (including whitespace and indentation) and be unique in it — include surrounding lines ' +
      'to make it unique, or pass `replace_all: true` to change every occurrence. Read the file with ' +
      'read_file first. Use write_file to create a new file.',
    parameters: z.object({
      file_path: z.string().optional().describe('Project-relative path, e.g. src/pages/Home.tsx'),

      /* `read_file`'s spelling — accepted here too (see `writePathArg`). */
      path: z.string().optional().describe('Alias of `file_path`.'),
      old_string: z.string().optional().describe('The exact text to replace'),
      new_string: z.string().optional().describe('The replacement text'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
    }),
    execute: async (args, { toolCallId, abortSignal }) => {
      const vetted = vetWritePath(writePathArg(args), ctx.planOnly);

      if ('refusal' in vetted) {
        return vetted.refusal;
      }

      const current = overlay.read(vetted.rel);

      if (current === undefined) {
        return `${vetted.rel} does not exist — create it with write_file.`;
      }

      if (typeof args.new_string !== 'string') {
        return 'edit_file needs "new_string" — the replacement text (it may be empty to delete).';
      }

      const edit = applyStringEdit(current, {
        old_string: typeof args.old_string === 'string' ? args.old_string : '',
        new_string: args.new_string,
        replace_all: args.replace_all === true,
      });

      if (!edit.ok) {
        return edit.error;
      }

      /* Resolved here; the browser only ever performs a full write (D4). */
      const outcome = await relay(
        ctx,
        toolCallId,
        abortSignal,
        'write',
        { path: vetted.rel, content: edit.content },
        WORKSPACE_WRITE_TIMEOUT_MS,
      );

      if (!outcome.ok) {
        return outcome.message;
      }

      overlay.write(vetted.rel, edit.content);

      return `Edited ${vetted.rel} (${edit.replacements} replacement(s)).${nudgeLine(state, ctx.planOnly)}`;
    },
  });

  const runCommand = tool({
    description:
      "Run an npm command in the project's sandbox and get its exit code and output. Allowed: " +
      '`npm install <pkg>` (add a dependency) and `npm run <script>` (e.g. `npm run build`). ' +
      'Never `npm run dev` or `npm run preview` — the dev server is already running and the preview ' +
      'updates on its own. `&&` chains run in order and stop at the first failure.',
    parameters: z.object({
      command: z.string().optional().describe('e.g. npm install @babylonjs/loaders'),
    }),
    execute: async ({ command }, { toolCallId, abortSignal }) => {
      if (typeof command !== 'string' || !command.trim()) {
        return 'run_command needs a "command", e.g. npm install <pkg>.';
      }

      const trimmed = command.trim();
      const refusal = vetCommand(trimmed);

      if (refusal) {
        return refusal;
      }

      const outcome = await relay(ctx, toolCallId, abortSignal, 'run', { command: trimmed }, WORKSPACE_RUN_TIMEOUT_MS);

      if (!outcome.ok) {
        return outcome.message;
      }

      const r = (outcome.result ?? {}) as { exitCode?: unknown; output?: unknown; packageJson?: unknown };
      const exitCode = typeof r.exitCode === 'number' && Number.isFinite(r.exitCode) ? r.exitCode : -1;
      const output = tail(typeof r.output === 'string' ? r.output : '', RUN_OUTPUT_TAIL_CHARS);

      /* An install changed package.json on disk — the overlay must show the model the new text (D4). */
      if (typeof r.packageJson === 'string') {
        overlay.write('package.json', r.packageJson);
      }

      state.commands.push({ command: trimmed, exitCode });

      return `exit ${exitCode}\n${output}${nudgeLine(state, ctx.planOnly)}`;
    },
  });

  const checkGame = tool({
    description:
      'Verify the game actually works: type-checks the project (`tsc -b`), loads the landing page, and — ' +
      'when you pass `gameMode` — enters /play with that registered GameMode, checks a Babylon scene was ' +
      'created, collects runtime errors and returns a screenshot you can SEE. Call it after you change ' +
      'files, fix what it reports, and call it again until it passes. Your turn is not done until it passes.',
    parameters: z.object({
      gameMode: z.string().optional().describe('The registered GameMode class to play, e.g. KartRacerMode'),
      sceneUrl: z.string().optional().describe('Optional scene URL to load with the GameMode'),
    }),
    execute: async ({ gameMode, sceneUrl }, { toolCallId, abortSignal }): Promise<CheckGameToolResult> => {
      const params = {
        ...(typeof gameMode === 'string' && gameMode.trim() ? { gameMode: gameMode.trim() } : {}),
        ...(typeof sceneUrl === 'string' && sceneUrl.trim() ? { sceneUrl: sceneUrl.trim() } : {}),
      };

      const outcome = await relay(ctx, toolCallId, abortSignal, 'check', params, WORKSPACE_CHECK_TIMEOUT_MS);

      if (!outcome.ok) {
        return { verdict: outcome.message };
      }

      const check = normaliseCheck(outcome.result);
      const errors = [
        ...(check.typecheck === 'unavailable' ? [] : check.typecheck.errors),
        ...check.home.errors,
        ...(check.play?.errors ?? []),
      ];

      /* A failure with nothing to read is not actionable — name the missing scene. */
      if (!check.ok && errors.length === 0 && check.play && !check.play.hasScene) {
        errors.push(`No Babylon scene was created on /play for ${params.gameMode ?? 'the game mode'}.`);
      }

      const capped = errors.slice(0, CHECK_MAX_ERRORS);

      state.lastCheck = { ok: check.ok, errors: capped, afterWriteSeq: overlay.gateWriteSeq };

      if (!check.ok) {
        state.checkFailureSignatures.push(failureSignature(capped));
        state.checkFailureSignatures.splice(0, Math.max(0, state.checkFailureSignatures.length - BREAKER_WINDOW));
      }

      let verdict = check.ok ? 'check_game: PASSED' : `check_game: FAILED\n${capped.join('\n')}`;

      verdict += nudgeLine(state, ctx.planOnly);

      /*
       * The checklist TICK (T9 re-attempt): live, the model wrote its list and never updated it, so a
       * passed check ended the turn with every box still empty. A PASSING check with unfinished items
       * says so; a failing one does not (the model is busy fixing).
       */
      if (check.ok && !ctx.planOnly && state.todos.some((t) => t.status !== 'completed')) {
        verdict += `\n${TODO_TICK_HINT}`;
      }

      if (check.typecheck === 'unavailable') {
        verdict += '\nTypecheck: unavailable in this sandbox — the runtime checks decided the verdict.';
      }

      if (check.play) {
        verdict += `\nScene: hasScene=${check.play.hasScene} meshes=${check.play.meshes} ready=${check.play.ready}`;
      }

      /* Whole or nothing — half an image decodes to nothing and reads as a broken game (preview-tools). */
      if (check.screenshot && check.screenshot.base64.length > MAX_SCREENSHOT_BASE64) {
        verdict += '\n(The screenshot was too large to attach.)';
        return { verdict };
      }

      return check.screenshot ? { verdict, screenshot: check.screenshot } : { verdict };
    },
    experimental_toToolResultContent: (result: CheckGameToolResult) =>
      result.screenshot
        ? [
            { type: 'text' as const, text: result.verdict },
            { type: 'image' as const, data: result.screenshot.base64, mimeType: result.screenshot.mimeType },
          ]
        : [{ type: 'text' as const, text: result.verdict }],
  });

  return {
    write_file: writeFile,
    edit_file: editFile,
    run_command: runCommand,
    check_game: checkGame,
    update_todos: updateTodos,
  } as unknown as Record<string, ReturnType<typeof tool>>;
}
