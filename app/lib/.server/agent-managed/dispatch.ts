/**
 * Custom tool calls → today's executes (`_specs/managed-agents-engine_plan.md` D3, T5).
 *
 * The managed agent calls `project_write`, `check_game`, `evaluate_in_game`, …; this module answers
 * each through the SAME execute the legacy tool loop runs — `createWorkspaceTools` and
 * `createPreviewTools` — so the browser sees the same `workspace-tool-call` / `preview-tool-call` data
 * parts, runs them in the same executor, and posts to the same `/api/agent/tool-result`. Nothing about
 * the browser's half changes. The relay's tool-call id is the session event id, so a result maps back
 * to the `agent.custom_tool_use` it answers.
 *
 * `project_read` / `project_list` / `project_grep` are answered here on the server (`project-files.ts`).
 *
 * ## A detached turn sends NOTHING back (D6)
 *
 * When the request is aborted (a closed tab, a superseding send), the relay resolves every pending
 * call with "the generation was stopped". That sentence is about OUR request, not the user's project,
 * and forwarding it would tell the agent its write failed — so `dispatch` returns `null` and the call
 * stays unanswered. The session idles at `requires_action` until a reopened tab resumes it (T6).
 */
import type {
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsTextBlock,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { createPreviewTools, type PreviewToolCallEvent } from '~/lib/.server/agent/preview-tools';
import {
  createWorkspaceTools,
  type WorkspaceOverlay,
  type WorkspaceToolCallEvent,
  type WorkspaceTurnState,
} from '~/lib/.server/agent/workspace-tools';
import type { TodoItem } from '~/lib/agent/workspace-protocol-types';
import type { FileMap } from '~/lib/.server/llm/constants';
import { projectGrep, projectList, projectRead } from './project-files';
import type { CustomToolUse } from './events';

export type ManagedResultBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock;

export interface ToolAnswer {
  content: ManagedResultBlock[];
  isError: boolean;
}

export interface DispatchContext {
  generationId: string;
  userId: string;

  /** The request's signal. Aborted = detached: nothing is forwarded. */
  abortSignal?: AbortSignal;
  files: FileMap;
  overlay: WorkspaceOverlay;
  state: WorkspaceTurnState;
  emitWorkspace: (event: WorkspaceToolCallEvent) => void;
  emitPreview: (event: PreviewToolCallEvent) => void;
  emitTodos: (items: TodoItem[]) => void;
}

/** The managed tool name → the legacy execute it runs. */
export const WORKSPACE_TOOL_FOR: Readonly<Record<string, string>> = Object.freeze({
  project_write: 'write_file',
  project_edit: 'edit_file',
  project_run: 'run_command',
  check_game: 'check_game',
  update_todos: 'update_todos',
});

export const PREVIEW_TOOLS: readonly string[] = Object.freeze([
  'evaluate_in_game',
  'capture_game_screenshot',
  'get_game_errors',
  'get_game_console',
]);

export const MEDIA_TOOLS: readonly string[] = Object.freeze(['generate_image', 'generate_video', 'generate_sound']);

type Executable = {
  execute: (
    args: unknown,
    options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal },
  ) => Promise<unknown>;
  experimental_toToolResultContent?: (
    result: unknown,
  ) => Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }>;
};

const text = (value: string): BetaManagedAgentsTextBlock => ({ type: 'text', text: value });

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

/** A legacy execute's result → Managed Agents content blocks, images included (check_game, screenshots). */
export function toResultBlocks(tool: Executable, result: unknown): ManagedResultBlock[] {
  if (tool.experimental_toToolResultContent) {
    const parts = tool.experimental_toToolResultContent(result);
    const blocks: ManagedResultBlock[] = [];

    for (const part of parts) {
      if (part.type === 'text') {
        blocks.push(text(part.text || ' '));
      } else if (part.type === 'image' && part.data) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mimeType ?? 'image/jpeg', data: part.data },
        });
      }
    }

    return blocks.length ? blocks : [text(stringify(result))];
  }

  return [text(stringify(result) || '(no output)')];
}

/**
 * The legacy executes return failures as SENTENCES (they never throw — a throw kills a paid generation).
 * This is how a sentence is told apart from a success, for `is_error`: the relay's failure prefixes and
 * the refusal shapes the executes use.
 */
const ERROR_SHAPES = [
  /^The workspace could not complete this:/,
  /^The preview could not answer:/,
  /^REFUSED/,
  /needs (a|an) "/,
  /is (outside the project|not a valid project path|in a read-only zone|a binary file)/,
  /^That command is not allowed/,
  /^Plan mode is read-only/,
  /does not exist — create it with write_file/,
];

function looksLikeFailure(blocks: ManagedResultBlock[]): boolean {
  const first = blocks.find((b): b is BetaManagedAgentsTextBlock => b.type === 'text');

  return Boolean(first && ERROR_SHAPES.some((shape) => shape.test(first.text)));
}

export interface ManagedDispatcher {
  /**
   * Answer one call. `null` means "send nothing" — the request was detached while the call ran.
   * `reply: false` runs a call for its SIDE EFFECTS only (a replayed `update_todos` that was already
   * answered: the checklist is restored on screen, no second result is sent).
   */
  dispatch(call: CustomToolUse, options?: { reply?: boolean }): Promise<ToolAnswer | null>;
}

export function createManagedDispatcher(ctx: DispatchContext): ManagedDispatcher {
  const workspace = createWorkspaceTools({
    generationId: ctx.generationId,
    userId: ctx.userId,
    abortSignal: ctx.abortSignal,
    emit: ctx.emitWorkspace,
    emitTodos: ctx.emitTodos,
    overlay: ctx.overlay,
    state: ctx.state,
    planOnly: false,
  }) as unknown as Record<string, Executable>;

  const preview = createPreviewTools({
    generationId: ctx.generationId,
    userId: ctx.userId,
    abortSignal: ctx.abortSignal,
    emit: ctx.emitPreview,
  }) as unknown as Record<string, Executable>;

  const view = { files: ctx.files, overlay: ctx.overlay };

  async function run(call: CustomToolUse): Promise<ToolAnswer> {
    const input = call.input ?? {};

    switch (call.name) {
      case 'project_read': {
        const r = projectRead(view, input);
        return { content: [text(r.text)], isError: r.isError };
      }

      case 'project_list': {
        const r = projectList(view, input);
        return { content: [text(r.text)], isError: r.isError };
      }

      case 'project_grep': {
        const r = projectGrep(view, input);
        return { content: [text(r.text)], isError: r.isError };
      }

      default:
    }

    const legacyName = WORKSPACE_TOOL_FOR[call.name];
    const tool = legacyName
      ? workspace[legacyName]
      : PREVIEW_TOOLS.includes(call.name)
        ? preview[call.name]
        : undefined;

    if (!tool) {
      if (MEDIA_TOOLS.includes(call.name)) {
        return {
          content: [
            text(
              `${call.name} is not available on this engine yet. Build the game without generated media for now — ` +
                'use CSS, procedural geometry or the starter assets already in public/.',
            ),
          ],
          isError: true,
        };
      }

      return { content: [text(`Unknown tool "${call.name}".`)], isError: true };
    }

    const result = await tool.execute(input, { toolCallId: call.id, messages: [], abortSignal: ctx.abortSignal });
    const content = toResultBlocks(tool, result);

    return { content, isError: looksLikeFailure(content) };
  }

  return {
    async dispatch(call, options = {}) {
      let answer: ToolAnswer;

      try {
        answer = await run(call);
      } catch (error) {
        /* The executes never throw by contract; this is the belt to that brace. */
        answer = { content: [text(`The tool failed: ${(error as Error)?.message ?? 'unknown error'}`)], isError: true };
      }

      if (options.reply === false || ctx.abortSignal?.aborted) {
        return null;
      }

      return answer;
    },
  };
}
