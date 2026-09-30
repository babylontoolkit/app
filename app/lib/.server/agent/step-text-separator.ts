/**
 * Keeps each tool-loop step's narration its own paragraph (tool-loop plan D20).
 *
 * The AI SDK streams every step's text into ONE text channel with nothing between them, so a turn
 * that narrates, calls tools, then narrates again reached the user as "…game code.Those calls were
 * rejected…" — two sentences glued at the step boundary (found live, T9 acceptance). The fix is a
 * paragraph break before the first text of a step that follows a step which already wrote text.
 *
 * A state machine rather than a flag in `proxy.ts` so the rule is testable: text only, never
 * inserted before the first step's text, never doubled when the model already opened with a newline.
 */
export const STEP_TEXT_SEPARATOR = '\n\n';

export interface StepTextSeparator {
  /** Call on each `text-delta`; returns what to emit BEFORE the delta ('' or the separator). */
  beforeText(delta: string): string;

  /** Call on each `step-finish`. */
  stepFinished(): void;
}

export function createStepTextSeparator(): StepTextSeparator {
  let anyText = false;
  let stepText = false;
  let pending = false;

  return {
    beforeText(delta) {
      if (delta.length === 0) {
        return '';
      }

      let prefix = '';

      if (pending) {
        pending = false;

        if (!/^\s/.test(delta)) {
          prefix = STEP_TEXT_SEPARATOR;
        }
      }

      anyText = true;
      stepText = true;

      return prefix;
    },
    stepFinished() {
      /* A step that wrote nothing leaves the previous step's pending break in place. */
      if (stepText && anyText) {
        pending = true;
      }

      stepText = false;
    },
  };
}
