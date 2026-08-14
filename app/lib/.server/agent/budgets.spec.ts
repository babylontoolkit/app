/**
 * THE READ BUDGETS, AND THE INVARIANT CHAIN THAT MAKES THEM CONFIGURABLE (owner, 2026-08-09).
 *
 * Reported as *"I am getting a lot of read budget issues… where do I control that?"* Making four
 * hardcoded ceilings into four env vars would have been the obvious answer and a trap: three of them
 * are only correct RELATIVE to a fourth, so an operator raising the reference budget on its own would
 * silently give a creation MORE tool rounds than an ordinary turn — inverting the one relationship
 * `tool-policy.spec.ts` pins, with nothing throwing.
 *
 * So the tests that matter here are not "does the env var arrive". They are:
 *
 *   1. **Defaults are byte-identical to the constants that shipped**, or this refactor silently
 *      re-tuned every generation in the product.
 *   2. **The derivation holds for values nobody has tried** — the chain is enforced by code, not by
 *      an operator having read a comment first.
 *   3. **A junk or zero value floors instead of withdrawing a tool.** `envNumber` happily accepts `0`
 *      and `-1`, and a zero read budget does not read less; it shows the model a file manifest and
 *      then refuses every file in it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASELINE_TOOL_ROUNDS,
  CREATION_FILE_READ_ROUNDS,
  DEFAULT_AGENT_BUDGETS,
  DEFAULT_MAX_FILE_READS,
  DEFAULT_MAX_PLAN_READ_CHARS,
  DEFAULT_MAX_READ_CHARS,
  DEFAULT_MAX_REFERENCE_LOADS,
  resolveAgentBudgets,
} from './budgets';

/**
 * 🔴 `env()` falls back to `process.env`, and vitest loads `.env.local` — so an "empty" context is not
 * empty. Without this scrub a developer who has set any of these would see assertions about the
 * DEFAULT state fail on their machine only, with CI green (the `oauth.spec.ts` trap, which this
 * codebase has now recorded firing three separate times).
 */
const KEYS = ['AGENT_MAX_FILE_READS', 'AGENT_MAX_READ_CHARS', 'AGENT_MAX_PLAN_READ_CHARS', 'AGENT_MAX_REFERENCE_LOADS'];

const ctx = (env: Record<string, string> = {}) => ({ cloudflare: { env } });

beforeEach(() => {
  for (const key of KEYS) {
    vi.stubEnv(key, undefined as unknown as string);
  }
});

describe('resolveAgentBudgets — an unconfigured platform is unchanged', () => {
  /* 🔴 The regression guard for the whole refactor. */
  it('returns exactly the shipped constants when nothing is set', () => {
    expect(resolveAgentBudgets(ctx())).toEqual({
      maxFileReads: DEFAULT_MAX_FILE_READS,
      maxReadChars: DEFAULT_MAX_READ_CHARS,
      maxPlanReadChars: DEFAULT_MAX_PLAN_READ_CHARS,
      maxReferenceLoads: DEFAULT_MAX_REFERENCE_LOADS,

      /*
       * ⚠️ Derived, and since CREATION_FILE_READ_ROUNDS went 3 -> 6 (2026-08-14) it sits ABOVE the
       * baseline even with nothing configured — a creation needs 3 + 6 = 9 rounds, so the ordinary
       * ceiling rises to meet it rather than a creation quietly exceeding the maximum. Written as the
       * relationship, not as `9`: a literal here is what let `tools.ts` drift into a second writer.
       */
      maxToolRounds: Math.max(BASELINE_TOOL_ROUNDS, DEFAULT_MAX_REFERENCE_LOADS + CREATION_FILE_READ_ROUNDS),
      creationToolRounds: DEFAULT_MAX_REFERENCE_LOADS + CREATION_FILE_READ_ROUNDS,
    });
  });

  it('DEFAULT_AGENT_BUDGETS is that same resolution', () => {
    expect(DEFAULT_AGENT_BUDGETS).toEqual(resolveAgentBudgets(ctx()));
  });

  it('reads each variable', () => {
    expect(
      resolveAgentBudgets(
        ctx({
          AGENT_MAX_FILE_READS: '40',
          AGENT_MAX_READ_CHARS: '200000',
          AGENT_MAX_PLAN_READ_CHARS: '150000',
          AGENT_MAX_REFERENCE_LOADS: '4',
        }),
      ),
    ).toMatchObject({
      maxFileReads: 40,
      maxReadChars: 200_000,
      maxPlanReadChars: 150_000,
      maxReferenceLoads: 4,
    });
  });
});

/**
 * 🔴 THE REASON THIS IS ONE RESOLVER AND NOT FOUR VARIABLES.
 *
 * At the shipped values the chain reads `3 + 3 = 6 <= 7` with a round to spare, so a naive env var
 * looks correct right up to the first operator who sets it to 5.
 */
describe('the round ceilings are DERIVED, never left to the operator', () => {
  it.each([1, 2, 3, 4, 5, 8, 20])('keeps creation <= ordinary at maxReferenceLoads=%i', (loads) => {
    const budgets = resolveAgentBudgets(ctx({ AGENT_MAX_REFERENCE_LOADS: String(loads) }));

    expect(budgets.creationToolRounds).toBeLessThanOrEqual(budgets.maxToolRounds);
  });

  it('raises the ordinary ceiling to fit a raised reference budget', () => {
    const budgets = resolveAgentBudgets(ctx({ AGENT_MAX_REFERENCE_LOADS: '6' }));

    /*
     * 6 + CREATION_FILE_READ_ROUNDS exceeds the baseline, so the ceiling moves with it rather than
     * starving the turn. Expressed as the SUM rather than a literal: this assertion was written as
     * `toBe(9)` when the read budget happened to be 3, so raising that constant failed a test whose
     * subject is the DERIVATION, not the value — a false alarm that invites someone to re-point the
     * number instead of reading what broke.
     */
    expect(budgets.creationToolRounds).toBe(6 + CREATION_FILE_READ_ROUNDS);
    expect(budgets.maxToolRounds).toBe(6 + CREATION_FILE_READ_ROUNDS);
    expect(budgets.maxToolRounds).toBeGreaterThan(BASELINE_TOOL_ROUNDS);
  });

  /*
   * The other direction: a LOWERED reference budget must not drag the ordinary ceiling down with it.
   * `MAX_SKILL_LOADS < maxToolRounds` is calibrated against the baseline, and a turn that cannot spend
   * its skill budget and still answer is the truncation the `+ 1` rule exists to prevent.
   */
  it('never falls below the baseline', () => {
    expect(resolveAgentBudgets(ctx({ AGENT_MAX_REFERENCE_LOADS: '1' })).maxToolRounds).toBe(BASELINE_TOOL_ROUNDS);
  });

  it('always leaves the skill budget a round to answer in', () => {
    /* The invariant `tools.ts` states: MAX_SKILL_LOADS (6) < maxToolRounds. */
    for (const loads of ['1', '3', '6']) {
      expect(resolveAgentBudgets(ctx({ AGENT_MAX_REFERENCE_LOADS: loads })).maxToolRounds).toBeGreaterThan(6);
    }
  });
});

/**
 * 🔴 A budget of zero does not read less — it WITHDRAWS THE TOOL, which is the mistake `spec/skills.md`
 * records for `load_skill` and which `reference-tools.ts` opens by warning against. It would arrive
 * from a typo, and the model would be shown a file manifest and refused every file in it.
 */
describe('floors — a typo must not disable a tool', () => {
  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['junk', 'lots'],
    ['empty', ''],
  ])('floors file reads at 1 for %s', (_label, raw) => {
    expect(resolveAgentBudgets(ctx({ AGENT_MAX_FILE_READS: raw })).maxFileReads).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-2'],
    ['junk', 'three'],
  ])('floors reference loads at 1 for %s', (_label, raw) => {
    expect(resolveAgentBudgets(ctx({ AGENT_MAX_REFERENCE_LOADS: raw })).maxReferenceLoads).toBeGreaterThanOrEqual(1);
  });

  it('floors the char budget well above zero', () => {
    expect(resolveAgentBudgets(ctx({ AGENT_MAX_READ_CHARS: '0' })).maxReadChars).toBeGreaterThan(0);
  });

  /*
   * The plan pool is the ONE that may legitimately be zero: that does not withdraw a tool, it merely
   * returns `_specs/` reads to the general budget — the behaviour this pool was split out of.
   */
  it('allows the plan pool to be switched off, and never negative', () => {
    expect(resolveAgentBudgets(ctx({ AGENT_MAX_PLAN_READ_CHARS: '0' })).maxPlanReadChars).toBe(0);
    expect(resolveAgentBudgets(ctx({ AGENT_MAX_PLAN_READ_CHARS: '-9' })).maxPlanReadChars).toBe(0);
  });

  it('truncates a fractional value rather than passing it through', () => {
    expect(resolveAgentBudgets(ctx({ AGENT_MAX_FILE_READS: '7.9' })).maxFileReads).toBe(7);
  });
});
