/**
 * Unity Bridge tools (SPEC §4.17, D17, D21) — the model-facing half of the bridge.
 *
 * Each tool builds a `BridgeOperation` and hands it to `runBridgeOperation` (`bridge/service.ts`), which
 * owns everything that matters: validation, the tier (consent / scripts / refused) and dispatch to the
 * user's helper. Bridge operations are not billed per operation (D53).
 *
 * 🔴 **Never fatal.** Every parameter is optional in zod and validated in `execute` — a schema rejection
 * kills a paid generation after the tokens are spent (`tools.ts`). A missing value comes back as a
 * sentence the model can act on, and nothing is dispatched.
 *
 * Offered only in toolset `'all'` on a turn where one of the user's paired devices is present
 * (`resolveBridgeTurn`, D19/D54) — never on a discuss (Plan) turn or the first build turn (D18). There is
 * no project link (D54): `unity_project` opens or creates the Unity project, and every other Unity tool
 * works on the one opened or created last (the helper's "current project").
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { BridgeOperation } from '~/lib/bridge/protocol';
import { isValidProjectName } from '~/lib/bridge/validate';
import {
  jobControl,
  runBridgeOperation,
  type BridgeRunContext,
  type BridgeToolOutcome,
} from '~/lib/.server/bridge/service';

type ToolOptions = { toolCallId: string; abortSignal?: AbortSignal };

const needs = (toolName: string, param: string, what: string) => `${toolName} needs ${param} — ${what}.`;

/** Only `unity_capture` returns a picture; everything else answers in text. */
const asText = (outcome: BridgeToolOutcome): string => (typeof outcome === 'string' ? outcome : outcome.text);

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/*
 * 🔴 NO `z.enum`, NO bare `z.number()` / `z.boolean()` in these schemas (D17). The AI SDK enforces the
 * schema BEFORE `execute` runs, and a violation kills a generation the user has already paid for — a
 * model sending `"Game"` or `"1024"` is ordinary, not exotic. So choices are strings normalised here,
 * numbers and booleans also accept their string spellings, and anything unusable is a sentence.
 */
const numberish = () => z.union([z.number(), z.string()]).optional();
const booleanish = () => z.union([z.boolean(), z.string()]).optional();

const oneOf = (toolName: string, param: string, allowed: readonly string[]) =>
  `${toolName} ${param} must be one of: ${allowed.join(', ')}.`;

/** undefined/blank → the default; a case-insensitive match → the canonical value; anything else → null. */
function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return fallback;
  }

  const wanted = String(value).trim().toLowerCase();

  return allowed.find((option) => option === wanted) ?? null;
}

/** undefined/blank → the default; a finite number or numeric string → the number; anything else → null. */
function numberArg(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number(String(value).trim());

  return Number.isFinite(parsed) ? parsed : null;
}

/** undefined → undefined; a boolean or "true"/"false" → the boolean; anything else → null. */
function booleanArg(value: unknown): boolean | undefined | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const wanted = String(value).trim().toLowerCase();

  return wanted === 'true' ? true : wanted === 'false' ? false : null;
}

/** A list of strings, or a string holding a JSON array (or, for `splitWords`, space-separated words). */
const stringListish = () => z.union([z.array(z.unknown()), z.string()]).optional();

function stringList(value: unknown, splitWords: boolean): string[] | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }

  let list: unknown = value;

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (!trimmed) {
      return undefined;
    }

    try {
      list = JSON.parse(trimmed);
    } catch {
      list = splitWords ? trimmed.split(/\s+/) : [trimmed];
    }
  }

  return Array.isArray(list) && list.every((item) => typeof item === 'string') ? (list as string[]) : null;
}

/** A JSON object, or a string holding one. */
function objectArg(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return undefined;
  }

  let parsed: unknown = value;

  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

const notANumber = (toolName: string, param: string) => `${toolName} ${param} must be a number.`;

const VIEWS = ['game', 'scene'] as const;
const DEV_SERVER_ACTIONS = ['start', 'status'] as const;
const EDITOR_ACTIONS = ['status', 'open', 'close'] as const;
const JOB_ACTIONS = ['status', 'wait', 'cancel'] as const;
const PROJECT_ACTIONS = ['list', 'open', 'create'] as const;

export function createBridgeTools(ctx: Omit<BridgeRunContext, 'toolCallId'>): Record<string, ReturnType<typeof tool>> {
  const run = (op: BridgeOperation, label: string, { toolCallId, abortSignal }: ToolOptions) =>
    runBridgeOperation(op, label, { ...ctx, toolCallId, abortSignal: abortSignal ?? ctx.abortSignal });

  const tools = {
    unity_project: tool({
      description:
        "List, open or create the Unity project on the user's computer (inside the helper's projects folder). Every other Unity tool works on the project opened or created last. Create makes an empty Unity project — add the Babylon Toolkit package with unity_command package_add afterwards.",
      parameters: z.object({
        action: z.string().optional().describe('"list" (default), "open" or "create".'),
        name: z
          .string()
          .optional()
          .describe('The Unity project folder name inside the projects folder (for open and create).'),
      }),
      execute: async ({ action, name }, options) => {
        const a = choice(action, PROJECT_ACTIONS, 'list');

        if (a === null) {
          return oneOf('unity_project', 'action', PROJECT_ACTIONS);
        }

        if (a === 'list') {
          return asText(await run({ kind: 'unity.project', action: 'list' }, 'unity_project list', options));
        }

        if (!nonEmpty(name)) {
          return needs(
            'unity_project',
            'name',
            `the Unity project to ${a} (a folder name inside the projects folder — call unity_project with action "list" to see them)`,
          );
        }

        const projectName = name.trim();

        if (!isValidProjectName(projectName)) {
          return `unity_project name "${projectName.slice(0, 80)}" is not allowed — use a plain folder name inside the projects folder (letters, digits, spaces, "_", "-" and "."; up to 64 characters; no "/" or "..").`;
        }

        return asText(
          await run(
            { kind: 'unity.project', action: a, name: projectName },
            `unity_project ${a} ${projectName}`,
            options,
          ),
        );
      },
    }),

    unity_list_commands: tool({
      description:
        'List the Unity Editor commands available on the current Unity project (filter with query). Use before unity_command — never guess a command name.',
      parameters: z.object({
        query: z.string().optional().describe('Filter the command list, e.g. "transform".'),
      }),
      execute: async ({ query }, options) => {
        const op: BridgeOperation = nonEmpty(query) ? { kind: 'unity.list', query } : { kind: 'unity.list' };
        return asText(await run(op, nonEmpty(query) ? `unity_list_commands ${query}` : 'unity_list_commands', options));
      },
    }),

    unity_command: tool({
      description:
        "Run one Unity Editor command (unity command <name>) on the current Unity project, e.g. create_gameobject, set_component_properties, save_all, bt_export_level. params are the command's parameters. Paths are relative to the Unity project. Destructive commands ask the user first.",
      parameters: z.object({
        name: z.string().optional().describe('The command name, e.g. "set_transform".'),
        params: z
          .union([z.record(z.unknown()), z.string()])
          .optional()
          .describe("The command's parameters as a JSON object."),
      }),
      execute: async ({ name, params }, options) => {
        if (!nonEmpty(name)) {
          return needs('unity_command', 'name', 'the Unity command to run (call unity_list_commands to see them)');
        }

        const parsed = objectArg(params);

        if (parsed === null) {
          return 'unity_command params must be a JSON object, e.g. {"path": "Player"}.';
        }

        const commandName = name.trim();

        return asText(
          await run(
            { kind: 'unity.command', name: commandName, params: parsed ?? {} },
            `unity_command ${commandName}`,
            options,
          ),
        );
      },
    }),

    unity_cli: tool({
      description:
        'Run a top-level unity CLI operation (args after "unity", e.g. ["status"] or ["projects","info"]). Account, licence and install operations ask the user first.',
      parameters: z.object({
        args: stringListish().describe('The arguments after "unity" as a list of strings, e.g. ["status"].'),
      }),
      execute: async ({ args: rawArgs }, options) => {
        const args = stringList(rawArgs, true);

        if (args === null) {
          return 'unity_cli args must be a list of strings, e.g. ["projects", "info"].';
        }

        if (!args || args.length === 0) {
          return needs('unity_cli', 'args', 'the arguments after "unity", e.g. ["status"]');
        }

        return asText(await run({ kind: 'unity.cli', args }, `unity_cli ${args.join(' ')}`.slice(0, 160), options));
      },
    }),

    unity_run_script: tool({
      description:
        'Run a C# script in the Unity Editor of the current project (run_script). entry is "Class.Method". Needs the user\'s "Allow scripts" switch.',
      parameters: z.object({
        source: z.string().optional().describe('The C# source of the script.'),
        entry: z.string().optional().describe('The static method to call, as "Class.Method".'),
      }),
      execute: async ({ source, entry }, options) => {
        if (!nonEmpty(source)) {
          return needs('unity_run_script', 'source', 'the C# source of the script');
        }

        if (!nonEmpty(entry)) {
          return needs('unity_run_script', 'entry', 'the static method to call, as "Class.Method"');
        }

        return asText(await run({ kind: 'unity.script', source, entry }, `unity_run_script ${entry}`, options));
      },
    }),

    blender_run_script: tool({
      description:
        'Run a Python (bpy) script in headless Blender on the user\'s machine. BRIDGE_INPUTS/BRIDGE_OUTPUTS hold absolute paths for the declared inputs/outputs (relative to the Unity project). Every declared output must be written or the run fails. Needs "Allow scripts".',
      parameters: z.object({
        source: z.string().optional().describe('The Python (bpy) source of the script.'),
        inputs: stringListish().describe('Input files (a list), relative to the Unity project.'),
        outputs: stringListish().describe(
          'Output files the script must write (a list), relative to the Unity project.',
        ),
        timeoutSeconds: numberish().describe('Timeout in seconds (default 600).'),
      }),
      execute: async ({ source, inputs, outputs, timeoutSeconds }, options) => {
        if (!nonEmpty(source)) {
          return needs('blender_run_script', 'source', 'the Python (bpy) source of the script');
        }

        const timeout = numberArg(timeoutSeconds, 600);

        if (timeout === null) {
          return notANumber('blender_run_script', 'timeoutSeconds');
        }

        const ins = stringList(inputs, false);
        const outList = stringList(outputs, false);

        if (ins === null) {
          return 'blender_run_script inputs must be a list of paths relative to the Unity project.';
        }

        if (outList === null) {
          return 'blender_run_script outputs must be a list of paths relative to the Unity project.';
        }

        const outs = outList ?? [];

        return asText(
          await run(
            {
              kind: 'blender.script',
              source,
              inputs: ins ?? [],
              outputs: outs,
              timeoutSeconds: timeout,
            },
            `blender_run_script (${outs.length} outputs)`,
            options,
          ),
        );
      },
    }),

    unity_capture: tool({
      description: 'Capture the Unity Game or Scene view and see it (max 1024 px).',
      parameters: z.object({
        view: z.string().optional().describe('Which view to capture: "game" (default) or "scene".'),
        width: numberish().describe('Width in pixels (default 1024, max 1024).'),
        height: numberish().describe('Height in pixels (default 576, max 1024).'),
      }),
      execute: async ({ view, width, height }, options) => {
        const v = choice(view, VIEWS, 'game');

        if (v === null) {
          return oneOf('unity_capture', 'view', VIEWS);
        }

        const w = numberArg(width, 1024);
        const h = numberArg(height, 576);

        if (w === null) {
          return notANumber('unity_capture', 'width');
        }

        if (h === null) {
          return notANumber('unity_capture', 'height');
        }

        return run({ kind: 'unity.capture', view: v, width: w, height: h }, `unity_capture ${v}`, options);
      },

      // The picture reaches the model as a real vision part, the text alongside it (preview-tools' pattern).
      experimental_toToolResultContent: (r: BridgeToolOutcome) =>
        typeof r === 'string'
          ? [{ type: 'text' as const, text: r }]
          : [
              { type: 'image' as const, data: r.image.base64, mimeType: r.image.mimeType },
              { type: 'text' as const, text: r.text },
            ],
    }),

    unity_dev_server: tool({
      description: 'Start or check the Babylon Toolkit dev server for the current Unity project.',
      parameters: z.object({
        action: z.string().optional().describe('"status" (default) or "start".'),
        port: numberish().describe('Port for start (optional).'),
        auto: booleanish().describe('Let the dev server pick a free port (optional, true or false).'),
      }),
      execute: async ({ action, port, auto }, options) => {
        const a = choice(action, DEV_SERVER_ACTIONS, 'status');

        if (a === null) {
          return oneOf('unity_dev_server', 'action', DEV_SERVER_ACTIONS);
        }

        const p = port === undefined ? undefined : numberArg(port, Number.NaN);
        const au = booleanArg(auto);

        if (p === null || (p !== undefined && Number.isNaN(p))) {
          return notANumber('unity_dev_server', 'port');
        }

        if (au === null) {
          return 'unity_dev_server auto must be true or false.';
        }

        const op: BridgeOperation =
          a === 'start'
            ? {
                kind: 'devserver.start',
                ...(p === undefined ? {} : { port: p }),
                ...(au === undefined ? {} : { auto: au }),
              }
            : { kind: 'devserver.status' };

        return asText(await run(op, `unity_dev_server ${a}`, options));
      },
    }),

    unity_editor: tool({
      description:
        'Check, open or close the Unity Editor for the current project. close refuses if there are unsaved changes.',
      parameters: z.object({
        action: z.string().optional().describe('"status" (default), "open" or "close".'),
      }),
      execute: async ({ action }, options) => {
        const a = choice(action, EDITOR_ACTIONS, 'status');

        if (a === null) {
          return oneOf('unity_editor', 'action', EDITOR_ACTIONS);
        }

        return asText(await run({ kind: 'unity.editor', action: a }, `unity_editor ${a}`, options));
      },
    }),

    bridge_job: tool({
      description: 'Check, wait for (up to 90 s per call) or cancel a Unity Bridge job by id.',
      parameters: z.object({
        action: z.string().optional().describe('"status" (default), "wait" or "cancel".'),
        jobId: z.string().optional().describe('The job id, e.g. "brg_…".'),
        maxSeconds: numberish().describe('How long to wait, in seconds (default 60, max 90).'),
      }),
      execute: async ({ action, jobId, maxSeconds }, { abortSignal }) => {
        if (!nonEmpty(jobId)) {
          return needs('bridge_job', 'jobId', 'the id of the Unity Bridge job, e.g. "brg_…"');
        }

        const a = choice(action, JOB_ACTIONS, 'status');

        if (a === null) {
          return oneOf('bridge_job', 'action', JOB_ACTIONS);
        }

        const seconds = numberArg(maxSeconds, 60);

        if (seconds === null) {
          return notANumber('bridge_job', 'maxSeconds');
        }

        return asText(
          await jobControl(a, jobId.trim(), seconds, {
            userId: ctx.userId,
            context: ctx.context,
            abortSignal: abortSignal ?? ctx.abortSignal,
          }),
        );
      },
    }),
  };

  return tools as unknown as Record<string, ReturnType<typeof tool>>;
}
