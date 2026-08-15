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
 *
 * 🔴 **And it escalates on EVIDENCE ONLY (owner, 2026-08-14).** A `/slash` skill invocation used to be
 * escalated too, on the grounds that asking for a spec or a prototype is asking for deep work. That was
 * a guess about DIFFICULTY, which is the same species as reading the prompt — one rung more abstract,
 * and still a rule that decides spend from what the user seems to want rather than from what has
 * happened. A repair is not a guess: the model is looking at an error it caused and did not fix.
 *
 * It failed the way an unstated override always does. A `medium` session ran `/bt-landing` and logged
 * `effort=high`, which read as a bug in the setting — *"is something wrong with my effort?"* A control
 * that is silently overridden on a whole class of turns is a suggestion, and the user is the last to
 * find out. Repairs are exempt from that objection because nobody chose them.
 *
 * ## The user may raise the FLOOR, and only to `high` (§4.2.9)
 *
 * `baseEffort` is the one thing a person gets to say here, and it is still not a prose classifier: the
 * user is not describing the turn, they are choosing a session-wide floor, up front, visibly, in exactly
 * two positions. `medium` (the default, every session, every reload) or `high` — never `xhigh`/`max`,
 * because those are what the escalation ladder spends on EVIDENCE, and a chosen ceiling is a floor that
 * makes every ordinary edit start where a twice-failed build ends. The floor never lowers anything and
 * never caps anything: a `high` session that hits a second repair still gets `xhigh`.
 */
import { EFFORT_LEVELS, type EffortLevel, type UserEffortLevel } from '~/lib/modules/llm/capabilities';

export interface TurnShape {
  /** A Vite compile error was fed back to the model (§4.2 self-healing). */
  isRepair: boolean;

  /** Which repair attempt this is. 1 = first try at fixing its own mistake. */
  repairAttempt: number;

  /**
   * The user's chosen base effort for this session (`/effort`, §4.2.9) — `medium` or `high` only, already
   * validated by `parseUserEffort`. `undefined` means they never chose, so the operator default stands.
   *
   * It is a FLOOR, never a cap: the escalation rules below still fire above it. A `high` session that hits
   * a second repair gets `xhigh`, exactly as a `medium` one does.
   */
  baseEffort?: UserEffortLevel;
}

/** Position in `EFFORT_LEVELS` — the ordering IS the levels array, so the two can never disagree. */
function rank(level: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(level);
}

/**
 * The higher of the policy's escalation and the user's floor.
 *
 * `undefined` from the policy means "no opinion", so the floor is the answer; `undefined` from BOTH means
 * "operator default", which is what the provider resolves. Comparing by rank rather than by a chain of
 * `if`s means adding a level to `EFFORT_LEVELS` cannot silently invert an ordering here.
 */
function atLeast(escalated: EffortLevel | undefined, floor: UserEffortLevel | undefined): EffortLevel | undefined {
  if (!escalated) {
    return floor;
  }

  if (!floor) {
    return escalated;
  }

  return rank(floor) > rank(escalated) ? floor : escalated;
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
    return atLeast(turn.repairAttempt >= 2 ? 'xhigh' : 'high', turn.baseEffort);
  }

  /*
   * 🔴 A `/slash` INVOCATION IS NOT SPECIAL (owner, 2026-08-14).
   *
   * It used to escalate to `high`, arguing that `/bt-spec`, `/bt-plan` and `/bt-prototype` are requests
   * for deep work and the cheap setting would answer a different question. Retired: *"I expected what I
   * did — type a prompt or slash command, it would be at the currently selected effort (goes up for
   * repairs)."* The setting is chosen visibly, up front, and a rule that silently overrides it on a
   * whole class of turns makes the control a suggestion — which is exactly the confusion that surfaced
   * it (a `medium` session logging `effort=high` and reading as a bug).
   *
   * That leaves EVIDENCE as the only thing this file escalates on: a repair is a turn the model has
   * already demonstrably failed, which nobody has to be told about and nobody chose. A request being
   * heavyweight is a guess about difficulty, and guessing at difficulty is the classifier the header
   * forbids — one rung up from reading the prompt, not a different kind of rule.
   *
   * `isSlashInvocation` is GONE from `TurnShape` rather than left unread: the branch that replaced it
   * returned exactly what the fallthrough below returns, so keeping either would be a field nothing
   * acts on and a branch that cannot change an answer. To restore it, take the field back and put
   * `if (turn.isSlashInvocation) return atLeast('high', turn.baseEffort);` here.
   */

  /*
   * Creation, ordinary edits and slash invocations: the user's chosen base effort (`/effort`), else the configured default
   * (`medium`). Returning `undefined` when they never chose keeps the operator's config authoritative —
   * this function must not grow a second copy of the `THINKING_EFFORT` fallback chain (see the footer).
   *
   * There is deliberately no cheaper branch to fall to. See the header.
   */
  return turn.baseEffort;
}

/*
 * There is deliberately no `resolveEffort` here.
 *
 * One existed — `effortForTurn(turn) ?? parseEffort(configured) ?? DEFAULT_EFFORT` — and nothing but
 * its own spec ever called it, because the provider already applies that exact chain where the request
 * is actually built (`providers/anthropic.ts` → `getModelInstance`). Two copies of a precedence rule
 * is one copy too many: the dead one reads as authoritative, so a future reader "wires it up" and now
 * the rule is enforced twice, in two places, free to disagree. The proxy passes this function's
 * `undefined` straight through and the provider fills in `THINKING_EFFORT`, else `medium`.
 */
