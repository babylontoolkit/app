/**
 * Dev-tools for the agent — asking the RUNNING game questions (owner, 2026-08-09).
 *
 * *"As long as it gives me in App Builder some DEV TOOLS to fix bugs and drive the session and the same
 * types of things the AI would use chrome dev tools for."* And, on `bt-execute`'s self-verification:
 * *"can it take screenshots and verify its work… if not we need to make it do that."*
 *
 * These are relay tools, exactly like the §4.14 MCP ones: `execute` EMITS the request to the client and
 * AWAITS the answer, because the game runs in the user's browser and the server can never touch it (§5).
 * One generation, one credit gate, one settlement — the round-trip is invisible to the model.
 *
 * ## Why this is stronger evidence than a screenshot, and why that matters most for verification
 *
 * `bt-execute` is instructed to confirm a task's Acceptance before it ticks a checkbox, and on this
 * platform it has no subagents — so it self-verifies. Without a channel into the running game, every
 * "PASS" it writes is narration about code it read, which is the exact reason `bt-gauntlet` is excluded
 * from the platform (`skills/exclusions.ts`).
 *
 * A screenshot only half-fixes that: it proves pixels changed, not that the thing under test works, and
 * on a Babylon canvas it can come back BLANK for a reason that has nothing to do with the game (see
 * `agent-script.ts`). `evaluate_in_game` is the real answer — the agent asks the scene directly ("did
 * the kart mesh load?", "is the rigidbody registered?", "what is the player's Y?") and gets a fact.
 * That is also precisely the failure class this project keeps hitting: code that compiles, runs in dev,
 * and dies at runtime on an API that does not exist.
 *
 * ## The rules
 *
 * 🔴 **Never fatal.** Every failure — no preview running, an expression that throws, a timeout — comes
 * back as a readable tool_result. A thrown error here kills a paid generation after the tokens are
 * spent (`tools.ts`, and the zod-schema lesson it records).
 *
 * 🔴 **Budgeted, because a tool result is billed on every remaining step of the turn.** The document
 * caps what it returns (`capValue`), and this file caps again on arrival — the client is a browser and
 * its payload is not trustworthy just because we wrote the code that usually sends it.
 *
 * 🔴 **Read-mostly by construction.** There is no `click` or `type` tool here, and that is a decision,
 * not an omission: synthetic events are `isTrusted: false`, so anything gated on user activation
 * (pointer lock above all) silently does not happen, and a tool that appears to drive the game while
 * quietly failing to is worse than no tool. Driving is done through the game's own API via
 * `evaluate_in_game`, which is deterministic and reports what actually happened.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { awaitClientToolResult } from './mcp-relay';

/** What the client is being asked to do in the preview. Mirrors `lib/preview/protocol.ts`'s methods. */
export type PreviewToolMethod = 'evaluate' | 'console' | 'errors' | 'screenshot';

export interface PreviewToolCallEvent {
  toolCallId: string;
  method: PreviewToolMethod;
  params?: Record<string, unknown>;
}

export interface PreviewToolContext {
  generationId: string;
  userId: string;
  abortSignal?: AbortSignal;
  emit: (event: PreviewToolCallEvent) => void;
}

/**
 * Ceiling on a tool result once it reaches the server.
 *
 * The document already caps (`PREVIEW_VALUE_LIMITS.total`). This is the SECOND wall, and it exists
 * because the first one runs in a browser: the payload arrives over an HTTP POST that anyone with the
 * user's session can shape, and an unbounded one is an unbounded prompt on our key (`attachments.ts`
 * makes the same argument for uploads).
 */
export const MAX_PREVIEW_RESULT_CHARS = 20_000;

/** How long to wait for the browser to answer. Well under the relay default; a live page is fast. */
export const PREVIEW_TOOL_TIMEOUT_MS = 20_000;

function clip(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);

  if (!text || text.length <= MAX_PREVIEW_RESULT_CHARS) {
    return value;
  }

  /*
   * Truncation is ANNOUNCED. A model handed a silently-shortened result reads it as the whole answer —
   * the same rule `capValue` follows one layer down.
   */
  return `${text.slice(0, MAX_PREVIEW_RESULT_CHARS)}\n…(truncated — ask a narrower question)`;
}

async function relay(
  ctx: PreviewToolContext,
  toolCallId: string,
  abortSignal: AbortSignal | undefined,
  method: PreviewToolMethod,
  params?: Record<string, unknown>,
): Promise<unknown> {
  ctx.emit({ toolCallId, method, params });

  const outcome = await awaitClientToolResult({
    generationId: ctx.generationId,
    toolCallId,
    userId: ctx.userId,
    abortSignal: abortSignal ?? ctx.abortSignal,
    timeoutMs: PREVIEW_TOOL_TIMEOUT_MS,
  });

  if (outcome.error) {
    /* A sentence the model can act on — usually "start the dev server" or "the expression threw". */
    return `The preview could not answer: ${outcome.error}`;
  }

  /*
   * 🔴 A SCREENSHOT IS NOT TEXT AND MUST NOT BE CLIPPED AS TEXT.
   *
   * The character clip exists to stop a prose/JSON answer becoming an unbounded prompt. Applied to an
   * image it is silently destructive: a base64 frame is tens of thousands of characters, so clipping
   * produces a truncated payload that decodes to nothing — and the model, handed a broken image,
   * reports that the game renders nothing. The image is bounded at SOURCE instead (downscaled and
   * JPEG-encoded in the page, `agent-script.ts`) and again by `MAX_SCREENSHOT_BASE64` below.
   */
  if (method === 'screenshot') {
    return capScreenshot(outcome.result);
  }

  return clip(outcome.result);
}

/**
 * The ceiling on a captured frame, as base64.
 *
 * The page already downscales to a 1024px long edge and encodes JPEG, which lands well under this. This
 * is the SECOND wall, for the `MAX_PREVIEW_RESULT_CHARS` reason: the payload arrives from a browser, and
 * "we wrote the code that usually sends it" is not a bound.
 */
export const MAX_SCREENSHOT_BASE64 = 400_000;

/** A screenshot payload as it comes back from the page. */
interface ScreenshotResult {
  base64?: string | null;
  mimeType?: string;
  width?: number;
  height?: number;
  blank?: boolean;
  capturedDuringRender?: boolean;
  note?: string;
}

/**
 * Keep a capture whole or REFUSE it — never truncate.
 *
 * A half-image is worse than no image: it decodes to nothing and reads as evidence that the game is
 * broken. Over the ceiling, the model gets a sentence explaining what happened.
 */
function capScreenshot(result: unknown): unknown {
  const shot = (result ?? {}) as ScreenshotResult;

  if (typeof shot.base64 !== 'string' || !shot.base64) {
    return {
      ...shot,
      base64: undefined,
      note: shot.note ?? 'No frame could be captured. Use evaluate_in_game to check the scene instead.',
    };
  }

  if (shot.base64.length > MAX_SCREENSHOT_BASE64) {
    return {
      ...shot,
      base64: undefined,
      note: 'The captured frame was too large to attach. Use evaluate_in_game to check the scene instead.',
    };
  }

  return shot;
}

export function createPreviewTools(ctx: PreviewToolContext): Record<string, ReturnType<typeof tool>> {
  /*
   * Cast for the same reason `mcp-tools.ts` does: the AI SDK's `tool()` overloads infer a very narrow
   * type per call site, and the proxy only needs the structural shape to merge these into its tool set.
   */
  const tools = {
    evaluate_in_game: tool({
      description:
        'Run a JavaScript expression inside the RUNNING game in the preview and return its value. ' +
        'This is how you verify that something actually works, rather than inferring it from the code — ' +
        'use it to CHECK acceptance criteria before claiming a task is done. ' +
        '`await` is supported. ' +
        'IMPORTANT: the project is ESM, so there are no game globals — `GameManager` is a module ' +
        'export, not a `window` property. Reach the live module through the dev server instead: ' +
        "`(await import('/src/babylon/globals')).default` is GameManager, with the running game's " +
        'state. Examples: ' +
        "`(await import('/src/babylon/globals')).default.GetScene().meshes.length`; " +
        "`(await import('/src/babylon/globals')).default.GetScene().getMeshByName('kart') !== null`; " +
        '`document.querySelector("canvas") !== null`. ' +
        'Large objects are truncated, so ask one narrow question rather than dumping a scene.',
      parameters: z.object({
        /* Optional + validated in `execute`: a schema rejection kills the generation after it has paid. */
        expression: z.string().optional().describe('A JavaScript expression, e.g. scene.meshes.length'),
      }),
      execute: async ({ expression }, { toolCallId, abortSignal }) => {
        if (!expression || !expression.trim()) {
          return 'evaluate_in_game needs an "expression" — a JavaScript expression to run in the game.';
        }

        return relay(ctx, toolCallId, abortSignal, 'evaluate', { expression });
      },
    }),

    get_game_errors: tool({
      description:
        'Uncaught exceptions and unhandled promise rejections thrown by the running game, newest last, ' +
        'with stack traces. Check this FIRST when a game looks broken — a runtime crash (a method that ' +
        'does not exist, a null scene) does not fail the build and is invisible in the source.',
      parameters: z.object({}),
      execute: async (_args, { toolCallId, abortSignal }) => relay(ctx, toolCallId, abortSignal, 'errors'),
    }),

    get_game_console: tool({
      description:
        'Console output from the running game (log/info/warn/error/debug), newest last. Use it to read ' +
        "the project's own diagnostics and any warnings the Toolkit prints at startup.",
      parameters: z.object({
        level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional().describe('Filter to one level.'),
      }),
      execute: async ({ level }, { toolCallId, abortSignal }) =>
        relay(ctx, toolCallId, abortSignal, 'console', level ? { level } : undefined),
    }),

    capture_game_screenshot: tool({
      description:
        'Capture the game canvas as a PNG data URL. Useful as visual evidence that something renders. ' +
        '⚠️ On the current starter this frame is USUALLY BLANK: the template creates its engine with ' +
        'no `preserveDrawingBuffer`, so a WebGL canvas reads back empty after the frame is presented. ' +
        'The result says `blank: true` when that happens. A blank capture is NOT evidence that the ' +
        'game renders nothing — never report it as a failure. Verify with evaluate_in_game instead.',
      parameters: z.object({}),
      execute: async (_args, { toolCallId, abortSignal }) => relay(ctx, toolCallId, abortSignal, 'screenshot'),

      /*
       * 🔴 THIS IS WHAT MAKES THE SCREENSHOT ACTUALLY VISIBLE.
       *
       * A tool result is TEXT by default, so without this the model receives a base64 string it cannot
       * look at — it can describe the string, not the picture. `experimental_toToolResultContent` is the
       * AI SDK's seam for handing back a real vision part, so the model SEES the frame the same way it
       * sees an attached image.
       *
       * The text part rides alongside deliberately: dimensions, whether the frame came from inside the
       * render task, and any `note` are facts about the CAPTURE that an image cannot carry — and the
       * blank-frame caveat has to be readable, or a blank picture gets reported as a broken game.
       */
      experimental_toToolResultContent: (result: unknown) => {
        const shot = (result ?? {}) as ScreenshotResult;
        const summary =
          typeof result === 'string'
            ? result
            : [
                shot.width && shot.height ? `Frame ${shot.width}x${shot.height}.` : 'Frame captured.',
                shot.blank ? 'BLANK — see the note.' : undefined,
                shot.note,
              ]
                .filter(Boolean)
                .join(' ');

        if (typeof shot.base64 !== 'string' || !shot.base64) {
          return [{ type: 'text' as const, text: summary }];
        }

        return [
          { type: 'image' as const, data: shot.base64, mimeType: shot.mimeType ?? 'image/jpeg' },
          { type: 'text' as const, text: summary },
        ];
      },
    }),
  };

  return tools as unknown as Record<string, ReturnType<typeof tool>>;
}
