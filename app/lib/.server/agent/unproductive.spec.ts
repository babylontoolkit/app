/**
 * `shouldRescueUnproductiveTurn` spends the user's credits without them asking, so it is tested the
 * way `decidePremium` and `decideAutoRepair` are: every guard is a way this could go wrong, and each
 * one gets a case proving it holds ALONE (flip one field on an otherwise-firing input).
 *
 * The anchor case is the real generation this was written for — `gen_ms0vcgq8_68vf4c`, pinned to its
 * measured numbers so the arithmetic is tied to a fact rather than to the thresholds' own definition.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_BILLED_OUTPUT_TOKENS,
  MIN_PRODUCTIVE_TEXT_CHARS,
  shouldRescueUnproductiveTurn,
  UNPRODUCTIVE_RESCUE_PROMPT,
  type UnproductiveTurnInput,
} from './unproductive';

/** The demo failure, verbatim: 524 output tokens bought 83 characters and stopped. */
const DEMO_FAILURE: UnproductiveTurnInput = {
  aborted: false,
  alreadyContinued: false,
  emittedAction: false,
  toolCalls: 0,
  textChars: 83,
  outTokens: 524,
};

describe('shouldRescueUnproductiveTurn', () => {
  it('fires on the generation that failed the investor demo', () => {
    expect(shouldRescueUnproductiveTurn(DEMO_FAILURE)).toBe(true);
  });

  describe('every guard holds on its own', () => {
    it("never on a user Stop — those tokens were the user's own decision", () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, aborted: true })).toBe(false);
    });

    it('never twice — one extra pass per generation, ever', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, alreadyContinued: true })).toBe(false);
    });

    it('never when an action was emitted — writing a file IS the work', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, emittedAction: true })).toBe(false);
    });

    it('never when a tool was called — that is the tool-cap case, not this one', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, toolCalls: 1 })).toBe(false);
    });

    it('never on zero text — that is the existing hard failure, which refunds', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 0 })).toBe(false);
    });
  });

  describe('the shapes that are legitimate and must be left alone', () => {
    it('a terse but real answer — few tokens, few chars, healthy ratio', () => {
      // "Yes — `globals.ts` already exports it." — 38 chars on ~20 output tokens.
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 38, outTokens: 20 })).toBe(false);
    });

    it('a long prose answer that wrote no files (a plan-mode turn)', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 4_000, outTokens: 1_200 })).toBe(false);
    });

    it('a think-heavy turn that STILL delivered a real answer', () => {
      // Density 0.8 — under the floor — but 2,000 chars is a delivered answer, so the length gate saves it.
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 2_000, outTokens: 2_500 })).toBe(false);
    });

    it('a code artifact at the measured code density (~2.0 ch/tok)', () => {
      expect(shouldRescueUnproductiveTurn({ ...DEMO_FAILURE, textChars: 15_049, outTokens: 8_037 })).toBe(false);
    });
  });

  describe('the thresholds themselves', () => {
    it('leaves a short answer alone until it is billing real output', () => {
      const justUnder = { ...DEMO_FAILURE, textChars: 100, outTokens: MIN_BILLED_OUTPUT_TOKENS - 1 };
      const atFloor = { ...DEMO_FAILURE, textChars: 100, outTokens: MIN_BILLED_OUTPUT_TOKENS };

      expect(shouldRescueUnproductiveTurn(justUnder)).toBe(false);
      expect(shouldRescueUnproductiveTurn(atFloor)).toBe(true);
    });

    it('needs BOTH a short answer and a poor density, never one alone', () => {
      // Short enough, but the ratio says the tokens became text: a real (if brief) answer.
      const dense = { ...DEMO_FAILURE, textChars: MIN_PRODUCTIVE_TEXT_CHARS - 1, outTokens: 220 };

      expect(dense.textChars / dense.outTokens).toBeGreaterThan(1);
      expect(shouldRescueUnproductiveTurn(dense)).toBe(false);
    });
  });
});

describe('UNPRODUCTIVE_RESCUE_PROMPT', () => {
  it('is mode-neutral — a plan turn is prose by GUARANTEE and must not be told to write files', () => {
    expect(UNPRODUCTIVE_RESCUE_PROMPT).not.toMatch(/\bwrite the files?\b|boltAction|boltArtifact/i);
  });

  it('names the failure so the model does not repeat it', () => {
    expect(UNPRODUCTIVE_RESCUE_PROMPT).toMatch(/announced/i);
    expect(UNPRODUCTIVE_RESCUE_PROMPT).toMatch(/no skill-loading tools/i);
  });
});
