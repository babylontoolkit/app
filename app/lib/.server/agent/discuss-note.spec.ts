import { describe, expect, it } from 'vitest';
import { discussModeNote } from './discuss-note';

describe('discussModeNote', () => {
  it('emits the instruction on an ordinary plan-mode turn', () => {
    const note = discussModeNote({ chatMode: 'discuss', isCreationTurn: false });
    expect(note).toContain('PLAN mode');
    expect(note).toContain('Do NOT emit `<boltArtifact>`');
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
