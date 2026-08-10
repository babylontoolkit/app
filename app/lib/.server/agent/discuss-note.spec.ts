import { describe, expect, it } from 'vitest';
import { discussModeNote } from './discuss-note';

describe('discussModeNote', () => {
  it('emits the instruction on an ordinary plan-mode turn', () => {
    const note = discussModeNote({ chatMode: 'discuss' });
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
    const note = discussModeNote({ chatMode: 'discuss' });
    expect(note).toContain('`_specs/`');
    expect(note).toContain('_spec.md');
    expect(note).toContain('_plan.md');
    expect(note).toContain('bt-spec');
  });

  it('is silent in build mode and when the mode is absent (every existing caller)', () => {
    expect(discussModeNote({ chatMode: 'build' })).toBeNull();
    expect(discussModeNote({})).toBeNull();
  });

  /*
   * 🔴 THE FIRST-BUILD EXEMPTION IS GONE, ON PURPOSE (owner, 2026-08-09).
   *
   * It used to return `null` for a creation turn — "the user asked for a game, not an essay". The
   * handoff card's **Plan my brief** button (§4.4a) makes that wrong: planning the build BEFORE
   * writing it is a thing the user can now explicitly choose on turn one, and dropping the note there
   * would compose a `/bt-plan` command and then run it with full write access. Nothing would throw;
   * the turn would simply not be read-only.
   *
   * Pinned as a PROPERTY, not as the absence of a parameter: an extra field on the input must not
   * change the answer, so a re-added creation guard fails here rather than passing unnoticed.
   */
  it('honours plan mode on a first build turn — extra input fields cannot suppress it', () => {
    expect(discussModeNote({ chatMode: 'discuss', isFirstBuildTurn: true } as any)).toContain('PLAN mode');
    expect(discussModeNote({ chatMode: 'discuss', creationPhase: 'game' } as any)).toContain('PLAN mode');
  });
});
