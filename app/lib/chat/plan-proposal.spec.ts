import { describe, it, expect } from 'vitest';
import {
  NO_REPLAY,
  PLAN_MODE,
  isPlanModeMessage,
  messageProposesWrite,
  shouldOfferBuildAndApply,
} from './plan-proposal';

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
