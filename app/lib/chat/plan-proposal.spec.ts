import { describe, it, expect } from 'vitest';
import {
  NO_REPLAY,
  PLAN_MODE,
  decidePlanFollowUp,
  executePlanMessage,
  isPlanModeMessage,
  messageProposesWrite,
  planArtifactToExecute,
  shouldOfferBuildAndApply,
} from './plan-proposal';
import { parseSlashInvocation } from '~/lib/skills/slash';

const FILE_ACTION = '<boltArtifact id="x"><boltAction type="file" filePath="SPEC.md">hello</boltAction></boltArtifact>';
const SHELL_ACTION = '<boltAction type="shell">npm install</boltAction>';
const START_ACTION = '<boltAction type="start">npm run dev</boltAction>';

describe('isPlanModeMessage', () => {
  it('is true only when the PLAN_MODE mark is present', () => {
    expect(isPlanModeMessage([PLAN_MODE])).toBe(true);
    expect(isPlanModeMessage([NO_REPLAY, PLAN_MODE])).toBe(true);
  });

  it('is false for a restored message that carries NO_REPLAY but is not a plan turn', () => {
    // The whole reason PLAN_MODE exists: a restored build message gets NO_REPLAY too (§4.5.4b).
    expect(isPlanModeMessage([NO_REPLAY])).toBe(false);
  });

  it('is false for missing / non-array annotations', () => {
    expect(isPlanModeMessage(undefined)).toBe(false);
    expect(isPlanModeMessage(null)).toBe(false);
    expect(isPlanModeMessage('plan-mode')).toBe(false);
    expect(isPlanModeMessage([])).toBe(false);
  });
});

describe('messageProposesWrite', () => {
  it('detects file, shell, and start actions', () => {
    expect(messageProposesWrite(FILE_ACTION)).toBe(true);
    expect(messageProposesWrite(SHELL_ACTION)).toBe(true);
    expect(messageProposesWrite(START_ACTION)).toBe(true);
  });

  it('is tolerant of single quotes and extra attributes/whitespace', () => {
    expect(messageProposesWrite("<boltAction  type = 'file'  filePath='a.ts'>x</boltAction>")).toBe(true);
  });

  it('is false for a discussion-only plan turn (no actionable tags)', () => {
    expect(messageProposesWrite('Here is the plan:\n1. Update SPEC.md\n2. Rename the class.')).toBe(false);
  });

  it('does not match a mention of boltAction in prose', () => {
    expect(messageProposesWrite('I would emit a boltAction of type file, but I am planning.')).toBe(false);
  });

  /*
   * §4.2.9's writable folder: a `_specs/` write on a plan turn actually APPLIED (the bt-spec/bt-plan
   * bypass), so it is not an unapplied proposal — offering "Build & Apply" for it is the exact false
   * positive the doc comment warns about.
   */
  it('does not count a planning artifact — that write applied', () => {
    expect(messageProposesWrite('<boltAction type="file" filePath="_specs/racing_spec.md"># Spec</boltAction>')).toBe(
      false,
    );
  });

  it('still counts a project write even when a planning artifact rides alongside it', () => {
    const mixed = [
      '<boltAction type="file" filePath="_specs/racing_spec.md"># Spec</boltAction>',
      '<boltAction type="file" filePath="src/scripts/RacerMode.ts">code</boltAction>',
    ].join('\n');
    expect(messageProposesWrite(mixed)).toBe(true);
  });
});

describe('shouldOfferBuildAndApply', () => {
  it('is true only for a plan turn that proposed a concrete change', () => {
    expect(shouldOfferBuildAndApply([PLAN_MODE], FILE_ACTION)).toBe(true);
  });

  it('is false for a plan turn that only discussed', () => {
    expect(shouldOfferBuildAndApply([PLAN_MODE], 'Here is what I would do.')).toBe(false);
  });

  it('is false for a build message with file actions (already applied)', () => {
    // No PLAN_MODE mark → never offered, even though it contains a file action.
    expect(shouldOfferBuildAndApply([], FILE_ACTION)).toBe(false);
    expect(shouldOfferBuildAndApply([NO_REPLAY], FILE_ACTION)).toBe(false);
  });

  it('is false for a bt-spec turn that only wrote its planning artifact (that write applied)', () => {
    const specOnly = '<boltAction type="file" filePath="_specs/racing_spec.md"># Spec</boltAction>';
    expect(shouldOfferBuildAndApply([NO_REPLAY, PLAN_MODE], specOnly)).toBe(false);
  });
});

/**
 * 🔴 "BUILD THIS PLAN" — THE OTHER END OF THE HANDOFF CARD (owner, 2026-08-09).
 *
 * **Plan my brief** turns the first turn into `/bt-plan …`; this closes the loop. A `bt-plan` turn
 * leaves NOTHING unapplied — its `_specs/` write is the one write plan mode performs — so
 * `shouldOfferBuildAndApply` is correctly silent, and until now the flow simply ended: the plan on
 * disk, the toggle still reading Plan, and the user needing to know both to flip it and to type a
 * slash command.
 *
 * Every rule below fails silently, and two of them spend credits doing it.
 */
describe('planArtifactToExecute', () => {
  const planWrite = '<boltAction type="file" filePath="_specs/kart-racer_plan.md"># Plan</boltAction>';

  it('finds the plan file a plan turn wrote', () => {
    expect(planArtifactToExecute(planWrite)).toBe('_specs/kart-racer_plan.md');
  });

  /*
   * 🔴 A SPEC IS NOT A PLAN. `bt-spec` writes `<feature>_spec.md`, and the next step there is `bt-plan`
   * — offering to BUILD it would skip the planning step the spec exists to feed and spend a build's
   * worth of credits doing it.
   */
  it('ignores a spec file — the next step after a spec is planning, not building', () => {
    expect(planArtifactToExecute('<boltAction type="file" filePath="_specs/kart_spec.md"># Spec</boltAction>')).toBe(
      undefined,
    );
  });

  it('ignores writes outside the planning folder', () => {
    expect(planArtifactToExecute('<boltAction type="file" filePath="src/scripts/Kart_plan.md">x</boltAction>')).toBe(
      undefined,
    );
  });

  /* A spec-then-plan turn ends on the plan — the artifact the user just watched appear. */
  it('takes the LAST plan file when a turn wrote several', () => {
    const both = [
      '<boltAction type="file" filePath="_specs/kart_spec.md"># Spec</boltAction>',
      '<boltAction type="file" filePath="_specs/kart_plan.md"># Plan</boltAction>',
    ].join('\n');
    expect(planArtifactToExecute(both)).toBe('_specs/kart_plan.md');
  });

  it('finds nothing in a discussion-only turn', () => {
    expect(planArtifactToExecute('Here is how I would break this up: first the track, then the karts.')).toBe(
      undefined,
    );
  });
});

describe('executePlanMessage', () => {
  /*
   * 🔴 THE SKILL'S OWN GRAMMAR, EXACTLY: `/bt-execute <plan> <task-id>` with `ALL` as the literal token
   * for every remaining task. Asserted whole rather than by `toContain`, because this string is PARSED
   * positionally — extra prose around the two tokens is not a stylistic difference, it is a different
   * command. `bt-execute`'s SKILL.md is explicit that a missing task id means "list the task ids and
   * ask the user what to run, DO NOT guess", so a friendlier sentence buys a clarifying round trip
   * instead of a build.
   */
  it('is exactly the bt-execute invocation the skill parses', () => {
    expect(executePlanMessage('_specs/kart-racer_plan.md')).toBe('/bt-execute _specs/kart-racer_plan.md ALL');
  });

  /* And it must survive `parseSlashInvocation` as a bt-execute call carrying both positions. */
  it('parses as a bt-execute invocation carrying the plan and the task id', () => {
    const invocation = parseSlashInvocation(executePlanMessage('_specs/kart_plan.md'));

    expect(invocation?.name).toBe('bt-execute');
    expect(invocation?.args).toBe('_specs/kart_plan.md ALL');
  });
});

describe('decidePlanFollowUp', () => {
  const planWrite = '<boltAction type="file" filePath="_specs/kart_plan.md"># Plan</boltAction>';

  it('offers execute for a plan turn that wrote a plan', () => {
    expect(decidePlanFollowUp([NO_REPLAY, PLAN_MODE], planWrite)).toEqual({
      kind: 'execute',
      planPath: '_specs/kart_plan.md',
    });
  });

  it('offers apply for a plan turn that proposed an unapplied write', () => {
    expect(decidePlanFollowUp([PLAN_MODE], FILE_ACTION)).toEqual({ kind: 'apply' });
  });

  /*
   * 🔴 ONE BUTTON, AND APPLY WINS. A proposed write is a concrete change the model just showed and the
   * read-only wall blocked; executing a whole plan is many turns of work the user can ask for straight
   * afterwards. Two accent buttons under one reply is the §4.1a row problem in miniature, and it also
   * keeps every plan turn that existed before this change behaving exactly as it did.
   */
  it('prefers apply when a turn both proposed a write and wrote a plan', () => {
    expect(decidePlanFollowUp([PLAN_MODE], `${planWrite}\n${FILE_ACTION}`)).toEqual({ kind: 'apply' });
  });

  it('offers nothing for a discussion-only plan turn', () => {
    expect(decidePlanFollowUp([PLAN_MODE], 'Here is what I would do.')).toBeNull();
  });

  /*
   * 🔴 CONTROL — never on an ordinary build message. Those file actions ALREADY RAN; a button there
   * would re-run a landed change, on the user's credits, for nothing.
   */
  it('offers nothing on a build message, whatever it contains', () => {
    expect(decidePlanFollowUp([], planWrite)).toBeNull();
    expect(decidePlanFollowUp([NO_REPLAY], FILE_ACTION)).toBeNull();
    expect(decidePlanFollowUp(undefined, planWrite)).toBeNull();
  });
});
