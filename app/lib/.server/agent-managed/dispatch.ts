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
 * ## Plan mode (`planMode`, `_specs/managed-only_plan.md` D1)
 *
 * A Plan turn is READ-ONLY, and the wall is HERE, on the server — never only in the message note. The agent's
 * tool list stays constant (one provisioned agent per rung), so the dispatcher refuses what a Plan turn may
 * not do: a write or edit outside `_specs/` (the legacy `planOnly` rule, `isPlanArtifactPath`, the same
 * sentence), and every command, game check, in-game eval, media render (refused BEFORE any debit) and MCP
 * call. Reads, the checklist and the read-only preview tools stay.
 *
 * ## MCP (`mcp_list_tools` / `mcp_call`, managed-only plan D4–D6)
 *
 * The project's MCP servers run in the user's sandbox (§4.14, §5). `mcp_list_tools` is answered here from the
 * request's live list; `mcp_call` resolves the tool by `(server, tool)` EXACTLY — never by name alone (two
 * servers may expose the same name, and a name-only lookup runs the call against the wrong process) — emits
 * the same `mcp-tool-call` data part the legacy relay emits, and awaits the same `/api/agent/tool-result`.
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
import { createMediaTools, type MediaToolContext } from '~/lib/.server/agent/media-tools';
import { awaitClientToolResult } from '~/lib/.server/agent/mcp-relay';
import type { McpLiveTool, McpToolCallEvent } from '~/lib/.server/agent/mcp-tools';
import { createPreviewTools, type PreviewToolCallEvent } from '~/lib/.server/agent/preview-tools';
import {
  createWorkspaceTools,
  PLAN_ONLY_REFUSAL,
  type WorkspaceOverlay,
  type WorkspaceToolCallEvent,
  type WorkspaceTurnState,
} from '~/lib/.server/agent/workspace-tools';
import type { TodoItem } from '~/lib/agent/workspace-protocol-types';
import { isPlanArtifactPath } from '~/lib/chat/plan-artifacts';
import type { FileMap } from '~/lib/.server/llm/constants';
import { isGoogleVideoModel, mediaModelDefaults } from '~/lib/media/provider-defaults';
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

  /**
   * The media tools' context (T8) — `null` when this deploy has no media provider (or the turn names no
   * project). The SERVER answers `generate_*` through today's `createMediaTools`: debit → task → path,
   * and `emit` hands the started task to the route's `media-task` part so the browser polls and writes
   * the bytes, exactly as on the legacy engine.
   */
  media?: MediaToolContext | null;

  /**
   * A Plan-mode turn (§4.2.9): read-only, with `_specs/` as the one write door (managed-only plan D1).
   * Absent = a Build turn.
   */
  planMode?: boolean;

  /**
   * The project's MCP tools running in the user's sandbox (§4.14) and the relay emitter — `null`/absent when
   * the turn carries none, in which case `mcp_call` says so (managed-only plan D4).
   */
  mcp?: { tools: McpLiveTool[]; emit: (event: McpToolCallEvent) => void } | null;

  /**
   * A relayed call the browser did not answer in time (the relay's TIMER, `ClientToolResult.timedOut`).
   * The browser is treated as GONE, exactly like a closed tab (D6): the call is NOT answered — the session
   * waits at `requires_action` — and the engine detaches the request so a live tab can re-attach.
   */
  onBrowserTimeout?: (call: CustomToolUse) => void;
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

export const MCP_TOOLS: readonly string[] = Object.freeze(['mcp_list_tools', 'mcp_call']);

/**
 * What a Plan turn may NOT call at all (managed-only plan D1) — refused before anything runs or is debited.
 * `project_write` / `project_edit` are not here: they are allowed inside `_specs/` and refused elsewhere.
 */
export const PLAN_REFUSED_TOOLS: ReadonlySet<string> = new Set([
  'project_run',
  'check_game',
  'evaluate_in_game',
  ...MEDIA_TOOLS,
  'mcp_call',
]);

/** The refusal a Plan turn gets for a tool it may not call. Starts like `PLAN_ONLY_REFUSAL`, so it is an error. */
export function planToolRefusal(name: string): string {
  return (
    `Plan mode is read-only: ${name} is not available on a Plan turn. Read the project, discuss, and write ` +
    'planning files under _specs/ — the user switches back to Build mode to make changes.'
  );
}

/** How much of one MCP tool's JSON Schema `mcp_list_tools` shows — the legacy relay's cap (`mcp-tools.ts`). */
export const MCP_SCHEMA_MAX_CHARS = 1500;

/** The most of one MCP result returned to the agent. A tool result is billed on every later request. */
export const MCP_RESULT_MAX_CHARS = 50_000;

/** `mcp_list_tools`'s answer. Pure. */
export function describeMcpTools(tools: readonly McpLiveTool[]): string {
  if (tools.length === 0) {
    return "This project has no MCP tools running in the user's sandbox.";
  }

  const lines = tools.map((t) => {
    const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : '';
    const shown =
      schema.length > MCP_SCHEMA_MAX_CHARS ? `${schema.slice(0, MCP_SCHEMA_MAX_CHARS)}… (schema truncated)` : schema;

    return (
      `- server "${t.server}", tool "${t.name}": ${t.description?.trim() || 'A project MCP tool.'}` +
      (shown ? `\n  input schema (JSON Schema): ${shown}` : '')
    );
  });

  return (
    `${tools.length} MCP tool(s) are running in the user's sandbox. Call one with mcp_call, passing its exact ` +
    `server and tool names and its arguments:\n${lines.join('\n')}`
  );
}

/**
 * The live tool `mcp_call` names, by `(server, tool)` EXACTLY, or a refusal sentence. Never resolves by name
 * alone — a name that exists only on ANOTHER server is named in the refusal, not run. Pure.
 */
export function resolveMcpCall(
  tools: readonly McpLiveTool[],
  input: Record<string, unknown>,
): { tool: McpLiveTool; args: unknown } | { refusal: string } {
  const server = typeof input.server === 'string' ? input.server.trim() : '';
  const name = typeof input.tool === 'string' ? input.tool.trim() : '';

  if (tools.length === 0) {
    return { refusal: "The MCP tool could not run: this project has no MCP tools running in the user's sandbox." };
  }

  if (!server || !name) {
    return {
      refusal: 'The MCP tool could not run: mcp_call needs both "server" and "tool" — call mcp_list_tools to see them.',
    };
  }

  const tool = tools.find((t) => t.server === server && t.name === name);

  if (!tool) {
    const elsewhere = tools.filter((t) => t.name === name).map((t) => `"${t.server}"`);

    return {
      refusal:
        `The MCP tool "${name}" could not run: there is no tool "${name}" on server "${server}".` +
        (elsewhere.length ? ` It exists on server ${elsewhere.join(', ')} — call it there.` : '') +
        ' Call mcp_list_tools to see what is running.',
    };
  }

  const args = input.arguments;

  return { tool, args: args && typeof args === 'object' ? args : {} };
}

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
  /^The media generation (was refused|could not start)/,
  /^The MCP tool .*could not run/,
  /^generate_\w+ (was refused|has no default model|needs a ")/,
  /is a Google Veo model, and Veo is generated through/,
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
  /* Relayed calls whose relay TIMER fired — answered by nobody; the browser is gone (D6). */
  const timedOut = new Set<string>();

  const workspaceFor = (planOnly: boolean) =>
    createWorkspaceTools({
      generationId: ctx.generationId,
      userId: ctx.userId,
      abortSignal: ctx.abortSignal,
      emit: ctx.emitWorkspace,
      emitTodos: ctx.emitTodos,
      overlay: ctx.overlay,
      state: ctx.state,
      planOnly,
      onRelayTimeout: (id) => timedOut.add(id),
    }) as unknown as Record<string, Executable>;

  const workspace = workspaceFor(false);

  /* Plan mode's `write_file` refuses every path outside `_specs/` on the server (`vetWritePath`). */
  const planWorkspace = ctx.planMode ? workspaceFor(true) : null;

  const preview = createPreviewTools({
    generationId: ctx.generationId,
    userId: ctx.userId,
    abortSignal: ctx.abortSignal,
    emit: ctx.emitPreview,
    onRelayTimeout: (id) => timedOut.add(id),
  }) as unknown as Record<string, Executable>;

  const view = { files: ctx.files, overlay: ctx.overlay };

  /*
   * The media tools exist only where a media provider does. Their DEFINITIONS are static on the agent
   * (hashed for provisioning, `tools.ts`), so availability is answered here, per call, without a debit.
   */
  const media = (ctx.media ? createMediaTools(ctx.media) : {}) as unknown as Record<string, Executable>;

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

    if (call.name === 'mcp_list_tools') {
      return { content: [text(describeMcpTools(ctx.mcp?.tools ?? []))], isError: false };
    }

    if (ctx.planMode) {
      if (PLAN_REFUSED_TOOLS.has(call.name)) {
        return { content: [text(planToolRefusal(call.name))], isError: true };
      }

      if (call.name === 'project_write') {
        return runWorkspace(planWorkspace!.write_file, call, input);
      }

      if (call.name === 'project_edit') {
        const raw = typeof input.file_path === 'string' && input.file_path.trim() ? input.file_path : input.path;

        /* The `_specs/` door only: an edit anywhere else is refused with the legacy sentence. */
        if (typeof raw !== 'string' || !isPlanArtifactPath(raw)) {
          return { content: [text(PLAN_ONLY_REFUSAL)], isError: true };
        }
      }
    }

    if (call.name === 'mcp_call') {
      return runMcp(call, input);
    }

    const legacyName = WORKSPACE_TOOL_FOR[call.name];
    const tool = legacyName
      ? workspace[legacyName]
      : PREVIEW_TOOLS.includes(call.name)
        ? preview[call.name]
        : undefined;

    if (!tool) {
      if (MEDIA_TOOLS.includes(call.name)) {
        return runMedia(call, input);
      }

      return { content: [text(`Unknown tool "${call.name}".`)], isError: true };
    }

    return runWorkspace(tool, call, input);
  }

  async function runWorkspace(tool: Executable, call: CustomToolUse, input: Record<string, unknown>) {
    const result = await tool.execute(input, { toolCallId: call.id, messages: [], abortSignal: ctx.abortSignal });
    const content = toResultBlocks(tool, result);

    return { content, isError: looksLikeFailure(content) };
  }

  /**
   * `mcp_call` (managed-only plan D4, D5): run one project MCP tool in the user's sandbox through the §4.14
   * relay. A relay TIMEOUT is answered to the agent as a failure (a slow third-party server is the usual
   * cause) — unlike a workspace timeout, which detaches; a detached request still answers nothing
   * (`dispatch` drops the answer when the signal is aborted).
   */
  async function runMcp(call: CustomToolUse, input: Record<string, unknown>): Promise<ToolAnswer> {
    const resolved = resolveMcpCall(ctx.mcp?.tools ?? [], input);

    if ('refusal' in resolved) {
      return { content: [text(resolved.refusal)], isError: true };
    }

    const { tool, args } = resolved;

    ctx.mcp!.emit({ toolCallId: call.id, toolName: tool.name, server: tool.server, args });

    const outcome = await awaitClientToolResult({
      generationId: ctx.generationId,
      toolCallId: call.id,
      userId: ctx.userId,
      abortSignal: ctx.abortSignal,
    });

    if (outcome.error) {
      return { content: [text(`The MCP tool "${tool.name}" could not run: ${outcome.error}`)], isError: true };
    }

    const body = stringify(outcome.result ?? null) || '(no output)';
    const shown =
      body.length > MCP_RESULT_MAX_CHARS
        ? `${body.slice(0, MCP_RESULT_MAX_CHARS)}\n… (result truncated: ${body.length} characters, the first ${MCP_RESULT_MAX_CHARS} shown)`
        : body;

    /* Untrusted (§4.14) — the sandbox server's own answer, returned for the agent to read. */
    return { content: [text(shown)], isError: false };
  }

  /**
   * `generate_image` / `generate_video` / `generate_sound` (T8). Unavailable = an error RESULT and no
   * debit — never a thrown turn. The managed agent has ONE video tool; a Google Veo model named on it is
   * a deliberate choice of Veo, so it runs through the legacy `generate_google_video` execute (the
   * legacy split exists to stop Veo being FALLEN BACK to, which an explicit model id is not).
   */
  async function runMedia(call: CustomToolUse, input: Record<string, unknown>): Promise<ToolAnswer> {
    if (!ctx.media) {
      return {
        content: [
          text(
            `${call.name} is not available on this server (no media provider is configured). Build without ` +
              'generated media — use CSS, procedural geometry or the starter assets already in public/.',
          ),
        ],
        isError: true,
      };
    }

    let name = call.name;

    if (name === 'generate_video') {
      const model = typeof input.model === 'string' ? input.model.trim() : '';

      if (model && isGoogleVideoModel(model)) {
        name = 'generate_google_video';
      } else if (!model && !mediaModelDefaults(ctx.media.provider.name).video) {
        const veo = mediaModelDefaults(ctx.media.provider.name).googleVideo;

        return {
          content: [
            text(
              `generate_video needs an explicit \`model\` on ${ctx.media.provider.name}: every video model it serves ` +
                `is Google Veo (e.g. "${veo}"), which is never chosen by default because it is the most expensive ` +
                'video there is. Name it only if the user asked for video.',
            ),
          ],
          isError: true,
        };
      }
    }

    const tool = media[name];

    if (!tool) {
      return {
        content: [
          text(
            `${call.name} is not available on ${ctx.media.provider.name} (this media gateway does not serve it). ` +
              'Carry on without it.',
          ),
        ],
        isError: true,
      };
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

      if (timedOut.has(call.id)) {
        ctx.onBrowserTimeout?.(call);

        return null;
      }

      if (options.reply === false || ctx.abortSignal?.aborted) {
        return null;
      }

      return answer;
    },
  };
}
