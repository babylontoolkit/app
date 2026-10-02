/**
 * What a managed turn is doing RIGHT NOW, for the status panel (§4.2a heartbeat). Pure.
 *
 * Reported live (2026-10-02, owner): *"long periods where it's just sitting there… no progress or
 * anything, for minutes… hard to tell if it's just stuck, and I wanna hit reload or leave the page."*
 * Measured on that session (Opus 5.5): silences of 101 s and 122 s while the model THOUGHT, and 64 s while
 * it generated a 21 KB `project_write`. Neither can be streamed — Managed Agents sends thinking as
 * start-only previews with no text, and a custom tool call arrives only once its whole input exists — so
 * the panel could only say "Working on your changes" with a clock, which reads exactly like a hang.
 *
 * What the session DOES tell us is which step it is in, as events: a model request started, thinking
 * started, thinking ended, a tool call arrived (with its name and path), its result went back. Each label
 * here is an OBSERVATION of one of those events — never an inference about what the model is "really"
 * doing — which is the standing rule of the status panel (`agent-status.ts`): "Writing src/Kart.ts" is
 * shown only after the session asked us to write that file.
 *
 * `since` is when the step began, so the panel can say "Thinking · 1m 40s": a step clock that keeps
 * resetting is visible progress, where one turn-wide clock is not.
 */
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import type { SessionEventLike } from './events';

export interface ManagedStep {
  label: string;

  /** `Date.now()` when this step began. */
  since: number;
}

/** A path argument, shortened for one line of UI. */
function shortPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const path = toProjectRelativePath(value.trim());

  return path.length > 60 ? `…${path.slice(-59)}` : path;
}

/** The label for a custom tool call the session asked us to run. */
export function labelForToolCall(name: string, input: Record<string, unknown> | undefined): string | null {
  const path = shortPath(input?.path);

  switch (name) {
    case 'project_write':
      return path ? `Writing ${path}` : 'Writing a file';
    case 'project_edit':
      return path ? `Editing ${path}` : 'Editing a file';
    case 'project_read':
      return path ? `Reading ${path}` : 'Reading a file';
    case 'project_list':
    case 'project_grep':
      return 'Looking through the project';
    case 'project_run':
      return typeof input?.command === 'string' ? `Running ${input.command.slice(0, 60)}` : 'Running a command';
    case 'check_game':
      return 'Checking the game — type-check and play test';
    case 'evaluate_in_game':
    case 'capture_game_screenshot':
    case 'get_game_errors':
      return 'Inspecting the running game';
    case 'generate_image':
      return 'Generating art';
    case 'generate_video':
      return 'Generating video';
    case 'generate_sound':
      return 'Generating sound';
    case 'update_todos':
      return null;
    default:
      return `Running ${name}`;
  }
}

/**
 * The step an event starts, or `null` when the event does not change the step (usage reports, deltas of a
 * message already shown, the checklist).
 */
export function stepLabelForEvent(event: SessionEventLike): string | null {
  switch (event.type) {
    case 'span.model_request_start':
      return 'Working out the next step';

    case 'event_start': {
      const preview = (event as { event?: { type?: string } }).event?.type;

      if (preview === 'agent.thinking') {
        return 'Thinking';
      }

      return preview === 'agent.message' ? 'Writing a reply' : null;
    }

    /*
     * The buffered thinking event concludes the think. What follows in the same model request is output:
     * a reply streams (and the panel hides while text flows), otherwise it is a tool call being composed —
     * which, for a whole-file write, is the long one.
     */
    case 'agent.thinking':
      return 'Preparing the next change';

    case 'agent.custom_tool_use': {
      const name = typeof event.name === 'string' ? event.name : '';

      return name ? labelForToolCall(name, event.input as Record<string, unknown> | undefined) : null;
    }

    case 'agent.tool_use':
      return 'Reading the Toolkit docs';

    case 'user.custom_tool_result':
    case 'agent.tool_result':
      return 'Working out the next step';

    case 'session.status_rescheduled':
      return 'Waiting for the agent service to resume';

    default:
      return null;
  }
}

export interface ManagedStepTracker {
  observe(event: SessionEventLike, now?: number): void;
  current(): ManagedStep | null;
}

export function createStepTracker(): ManagedStepTracker {
  let step: ManagedStep | null = null;

  return {
    observe(event, now = Date.now()) {
      const label = stepLabelForEvent(event);

      /* The same label again (two reads in a row of one file) keeps its clock — it is one step. */
      if (label && label !== step?.label) {
        step = { label, since: now };
      }
    },
    current: () => step,
  };
}
