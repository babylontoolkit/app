import { describe, expect, it } from 'vitest';
import { discussModeNote } from './discuss-note';

describe('discussModeNote', () => {
  it('emits the instruction on an ordinary plan-mode turn', () => {
    const note = discussModeNote({ chatMode: 'discuss', isCreationTurn: false });
    expect(note).toContain('PLAN mode');
    expect(note).toContain('Do NOT emit `<boltArtifact>`');
  });

  /*
   * §4.2.9's writable folder: without this exception stated, the model obeys the blanket "write
   * nothing" and bt-spec/bt-plan never even EMIT their `_specs/` artifacts — the client bypass
   * (`useMessageParser`'s plan parser) then has nothing to apply. The note and the parser must
   * agree on the folder, which is why both read `PLAN_ARTIFACTS_DIR`.
   */
  it('states the _specs planning-artifact exception so the skills still write their files', () => {
    const note = discussModeNote({ chatMode: 'discuss', isCreationTurn: false });
    expect(note).toContain('`_specs/`');
    expect(note).toContain('_spec.md');
    expect(note).toContain('_plan.md');
    expect(note).toContain('bt-spec');
  });

  it('is silent in build mode and when the mode is absent (every existing caller)', () => {
    expect(discussModeNote({ chatMode: 'build', isCreationTurn: false })).toBeNull();
    expect(discussModeNote({ isCreationTurn: false })).toBeNull();
  });

  /*
   * The creation turn MUST build (§4.4): the user asked for a game, and the whole creation context has
   * been assembled and billed. A discuss note here would buy an essay instead of a game, silently.
   */
  it('is ignored on the creation turn, like the premium toggle', () => {
    expect(discussModeNote({ chatMode: 'discuss', isCreationTurn: true })).toBeNull();
  });
});
