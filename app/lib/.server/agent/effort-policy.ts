/**
 * How hard should the model think on THIS turn? (SPEC §4.2a, spec/anthropic-models.md §3.5)
 *
 * ## The rule: decide by turn KIND, never by reading the prompt
 *
 * The tempting design is a classifier — look at the user's words, guess whether the task is "hard",
 * pick an effort. Don't. It is wrong in both directions, it is impossible to debug ("why did my build
 * cost double?"), and it puts a language model in charge of the bill. Every signal below is one the
 * proxy already computes deterministically, for free, before a single token is spent.
 *
 * ## This policy only ever ESCALATES — there is no cheap tier
 *
 * The original plan was to save money by dropping edit turns to `low`. We measured it, and `low` was
 * not cheaper — it was WRONG (it breached a read-only project zone; see the note above `EFFORT_LEVELS`
 * in `capabilities.ts`, which is why `low` is no longer even representable). So the floor is `medium`
 * and this file can only move effort UP.
 *
 * That inverts the value proposition, honestly: not paying less on easy turns, but paying MORE on the
 * turns that have already demonstrated they need it. A repair turn otherwise thinks exactly as hard as
 * the turn that just failed — which is precisely backwards.
 */
import type { EffortLevel } from '~/lib/modules/llm/capabilities';
import { DEFAULT_EFFORT, parseEffort } from '~/lib/modules/llm/capabilities';

export interface TurnShape {
  /** A Vite compile error was fed back to the model (§4.2 self-healing). */
  isRepair: boolean;

  /** Which repair attempt this is. 1 = first try at fixing its own mistake. */
  repairAttempt: number;

  /** The user explicitly invoked a skill (`/bt-spec`, `/bt-prototype`) — a heavyweight workflow. */
  isSlashInvocation: boolean;
}

/**
 * The per-turn effort, or `undefined` to take the configured default (`THINKING_EFFORT`, else
 * `medium`). Returning `undefined` rather than the default itself keeps the operator's config
 * authoritative for every ordinary turn — the policy only speaks up when it has a reason to.
 */
export function effortForTurn(turn: TurnShape): EffortLevel | undefined {
  /*
   * A repair that has already failed once is the strongest signal in the system that the model needs
   * to think harder — it is looking at a compile error IT caused and did not fix. Repairs are capped
   * (MAX_REPAIR_TURNS) and rare, so the extra spend is bounded and it buys the thing the user most
   * wants: a project that actually builds.
   */
  if (turn.isRepair) {
    return turn.repairAttempt >= 2 ? 'xhigh' : 'high';
  }

  /*
   * `/bt-spec`, `/bt-prototype`, `/bt-plan` — the user asked for architecture, a spec, or a fan-out of
   * design prototypes. They have explicitly requested deep work; giving them the cheap setting would
   * be answering a different question than the one they asked.
   */
  if (turn.isSlashInvocation) {
    return 'high';
  }

  /*
   * Creation and ordinary edits: the configured default (`medium`).
   *
   * There is deliberately no cheaper branch to fall to. See the header.
   */
  return undefined;
}

/**
 * Resolve the effort actually sent: the turn policy, else the operator's config, else the default.
 *
 * The policy WINS over config on purpose. If an operator sets `THINKING_EFFORT=medium` to save money,
 * a second consecutive repair still runs at `xhigh` — a build that has already failed twice is not the
 * place to economise, and the repair budget is capped (`MAX_REPAIR_TURNS`) so the spend is bounded.
 */
export function resolveEffort(turn: TurnShape, configured?: string): EffortLevel {
  return effortForTurn(turn) ?? parseEffort(configured) ?? DEFAULT_EFFORT;
}
