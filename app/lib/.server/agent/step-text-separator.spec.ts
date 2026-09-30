import { describe, expect, it } from 'vitest';
import { createStepTextSeparator, STEP_TEXT_SEPARATOR } from './step-text-separator';

/** Feed a sequence of deltas and step boundaries ('|'), return the text the user sees. */
function render(events: string[]): string {
  const sep = createStepTextSeparator();
  let out = '';

  for (const e of events) {
    if (e === '|') {
      sep.stepFinished();
    } else {
      out += sep.beforeText(e) + e;
    }
  }

  return out;
}

describe('step text separator', () => {
  it('puts a paragraph break between two steps that both wrote text (the live defect)', () => {
    expect(render(['never imports game code.', '|', 'Those calls were rejected.'])).toBe(
      `never imports game code.${STEP_TEXT_SEPARATOR}Those calls were rejected.`,
    );
  });

  it('never inserts one inside a step, or before the first text', () => {
    expect(render(['Hello ', 'world.'])).toBe('Hello world.');
    expect(render(['|', 'First text.'])).toBe('First text.');
  });

  it('carries across a silent (tools-only) step, and fires once', () => {
    expect(render(['A.', '|', '|', 'B', ' more.'])).toBe(`A.${STEP_TEXT_SEPARATOR}B more.`);
  });

  it('does not double a break the model already wrote, and ignores empty deltas', () => {
    expect(render(['A.', '|', '', '\nB.'])).toBe('A.\nB.');
  });
});
