/**
 * The agent's per-turn READ budgets, resolved from config in ONE place.
 *
 * ## Why this module exists (owner, 2026-08-09)
 *
 * Reported as *"I am getting a lot of read budget issues"* — a `/bt-execute` turn spent its budget on
 * eleven system-API files, was refused the 28KB plan it was executing against, and correctly declined
 * to tick an acceptance box it could no longer verify. The ceilings were right in spirit and wrong in
 * two ways: they were **hardcoded**, so the only way to move one was a code edit and a deploy; and the
 * planning document the turn exists to execute was spending the same pool as the source it was reading.
 *
 * ## Why they resolve TOGETHER and not as four independent variables
 *
 * These numbers are not independent, and three of them are only correct RELATIVE to a fourth. The
 * chain, each link of which is load-bearing and documented where it is enforced:
 *
 *   - `creationToolRounds = maxReferenceLoads + CREATION_FILE_READ_ROUNDS` — a creation must be able to
 *     spend its whole reference budget and still have rounds left to read files.
 *   - `creationToolRounds <= maxToolRounds` — a creation must never get MORE rounds than an ordinary
 *     turn (`tool-policy.spec.ts` asserts this as a relationship, not as two numbers).
 *   - `MAX_SKILL_LOADS < maxToolRounds` — the strict inequality is what guarantees a round is left for
 *     the ANSWER (`tools.ts`).
 *
 * 🔴 **So a bare `AGENT_MAX_REFERENCE_LOADS` env var would be a trap.** At the shipped values the chain
 * reads `3 + 3 = 6 <= 7` with one round to spare; set that variable to `6` and it becomes `6 + 3 = 9`
 * against a ceiling of `7`, and a creation silently gets ten steps where an ordinary turn gets eight —
 * inverting the one relationship the spec pins. Nothing would throw. So `maxToolRounds` is **DERIVED
 * upward** from whatever the operator sets rather than being a fifth number they have to remember to
 * keep in sync. That is this codebase's own rule, from `storage/limits.ts`: *a limit that is only
 * correct relative to another limit must be derived from it or asserted against it, because nothing
 * else will ever notice.*
 *
 * The headroom this spends is genuinely cheap and the asymmetry is well measured: an extra
 * in-generation step re-reads the WARM prefix at 0.1x, where the forced continuation that step
 * starvation causes rewrites the whole prefix at 2x AND risks truncating the project
 * (`gen_msixapaq_i871b6`, 1,489 credits, no game).
 *
 * ## Floors, and why they are not politeness
 *
 * Every value is floored at a usable minimum. `envNumber` returns its fallback for junk but happily
 * accepts `0` and `-1`, and a budget of zero does not "read less" — it **withdraws the tool through
 * the budget**, which is the precise mistake `spec/skills.md` records for `load_skill` and which
 * `reference-tools.ts` opens by warning against. A model that is shown a file manifest and refused
 * every file in it is the dangling-instruction failure in its purest form, and it would arrive from a
 * typo in an env var.
 */
import { envNumber } from '~/lib/.server/env';

/** Files one turn may read. Count is the secondary ceiling; bytes bind first in practice. */
export const DEFAULT_MAX_FILE_READS = 24;

/**
 * The real ceiling: total characters of project source one turn may pull in.
 *
 * 24 reads of ordinary source is a few thousand tokens; 24 reads that each happen to be a 100KB
 * generated file is the whole-project dump this tool replaced, reassembled one call at a time.
 */
export const DEFAULT_MAX_READ_CHARS = 120_000;

/**
 * A SEPARATE allowance for `_specs/**` planning artifacts — the second half of the reported fix.
 *
 * 🔴 A plan document is not project source; it is the turn's own working instructions. `bt-execute`
 * reads `_specs/<feature>_plan.md` to know what to build AND to verify its Acceptance clause before
 * ticking a box, so charging it to the same pool as the code it is reading means the deeper the turn
 * looks at the project, the less able it is to check its own work — precisely backwards, and it is
 * what produced the report.
 *
 * Reserved rather than exempt. An unbounded read path is a hole no matter how sensible its folder
 * looks, so `_specs/` gets its own pool instead of a free pass: the exemption cannot grow into the
 * dump, and the general budget cannot starve the plan. 80k is a few plan documents; a plan measured on
 * the reported turn was 28KB.
 */
export const DEFAULT_MAX_PLAN_READ_CHARS = 80_000;

/**
 * Reference documents (`load_reference`) one turn may pull in.
 *
 * Three, where skills get six, and the difference is not taste — a reference is DOMAIN KNOWLEDGE and a
 * real build spans a few areas, but each load is its OWN round, which is why this one is step-hungry
 * where file reads are not (the model parallelises reads; it discovers references one at a time).
 */
export const DEFAULT_MAX_REFERENCE_LOADS = 3;

/**
 * The floor under `maxToolRounds`, and the shipped value. Never lowered by config — this is the number
 * `MAX_SKILL_LOADS < maxToolRounds` is calibrated against, and lowering it would let the skill budget
 * eat the answer step.
 */
export const BASELINE_TOOL_ROUNDS = 7;

/**
 * File-read rounds a creation needs ON TOP of its reference loads.
 *
 * Reads are cheap in TOKENS and expensive in STEPS: a live creation parallelised eight reads into one
 * step but still took three rounds, because it discovers what it needs incrementally.
 */
export const CREATION_FILE_READ_ROUNDS = 3;

export interface AgentBudgets {
  /** Distinct project files one turn may read. */
  maxFileReads: number;

  /** Total characters of project source one turn may read. */
  maxReadChars: number;

  /** Total characters of `_specs/**` planning artifacts one turn may read — a SEPARATE pool. */
  maxPlanReadChars: number;

  /** Reference documents one turn may load. */
  maxReferenceLoads: number;

  /** Tool rounds an ordinary turn gets. DERIVED — never below the baseline, raised to fit the budgets. */
  maxToolRounds: number;

  /** Tool rounds a creation turn gets. DERIVED, and `<= maxToolRounds` by construction. */
  creationToolRounds: number;
}

/** The shipped values — what every turn gets when the operator has configured nothing. */
export const DEFAULT_AGENT_BUDGETS: AgentBudgets = resolveFrom({
  maxFileReads: DEFAULT_MAX_FILE_READS,
  maxReadChars: DEFAULT_MAX_READ_CHARS,
  maxPlanReadChars: DEFAULT_MAX_PLAN_READ_CHARS,
  maxReferenceLoads: DEFAULT_MAX_REFERENCE_LOADS,
});

/**
 * Resolve the turn's budgets from config.
 *
 * Every variable is optional and every one falls back to the shipped default, so an operator who has
 * set nothing gets byte-identical behaviour to before this module existed — asserted, not assumed.
 */
export function resolveAgentBudgets(context: unknown): AgentBudgets {
  return resolveFrom({
    maxFileReads: envNumber(context, 'AGENT_MAX_FILE_READS', DEFAULT_MAX_FILE_READS),
    maxReadChars: envNumber(context, 'AGENT_MAX_READ_CHARS', DEFAULT_MAX_READ_CHARS),
    maxPlanReadChars: envNumber(context, 'AGENT_MAX_PLAN_READ_CHARS', DEFAULT_MAX_PLAN_READ_CHARS),
    maxReferenceLoads: envNumber(context, 'AGENT_MAX_REFERENCE_LOADS', DEFAULT_MAX_REFERENCE_LOADS),
  });
}

/**
 * The invariant chain, applied once. Exported shape only — callers use `resolveAgentBudgets`.
 *
 * Floors first (a zero budget withdraws a tool), then the derived ceilings, so a configured value can
 * only ever make the loop ROOMIER and never break the "a creation gets no more rounds than an ordinary
 * turn" relationship.
 */
function resolveFrom(raw: {
  maxFileReads: number;
  maxReadChars: number;
  maxPlanReadChars: number;
  maxReferenceLoads: number;
}): AgentBudgets {
  const maxFileReads = atLeast(raw.maxFileReads, 1);
  const maxReadChars = atLeast(raw.maxReadChars, 1_000);

  /*
   * Floored at 0, not 1: `_specs/` is a reserved pool, and an operator who genuinely wants plan
   * artifacts to compete with source again should be able to say so. Zero here does not withdraw a
   * tool — `read_file` still reads the file, it just spends the general budget, which is exactly the
   * behaviour this pool was split out of.
   */
  const maxPlanReadChars = atLeast(raw.maxPlanReadChars, 0);
  const maxReferenceLoads = atLeast(raw.maxReferenceLoads, 1);

  const creationToolRounds = maxReferenceLoads + CREATION_FILE_READ_ROUNDS;

  return {
    maxFileReads,
    maxReadChars,
    maxPlanReadChars,
    maxReferenceLoads,

    /*
     * 🔴 Derived, and this line is the whole reason the module exists: raising the reference budget
     * raises the ceiling WITH it, so `creationToolRounds <= maxToolRounds` can never be violated by
     * configuration. Also never below the baseline, which `MAX_SKILL_LOADS` is calibrated against.
     */
    maxToolRounds: Math.max(BASELINE_TOOL_ROUNDS, creationToolRounds),
    creationToolRounds,
  };
}

/** An integer at or above `floor`. Junk (`NaN`, `Infinity`, a fraction) resolves to the floor. */
function atLeast(value: number, floor: number): number {
  if (!Number.isFinite(value)) {
    return floor;
  }

  return Math.max(floor, Math.floor(value));
}
