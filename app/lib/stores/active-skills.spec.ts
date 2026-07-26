/**
 * The early skills signal (SPEC §4.11) — the two rules that fail silently.
 *
 * `useChat` re-scans its entire data array on every stream chunk, so this part is presented to the
 * client dozens of times per turn. That is the same trap `agent-status.ts` documents, and both of its
 * failure modes are invisible: a badge that inherits the PREVIOUS turn's skills is simply wrong on
 * screen with nothing to indicate it, and a store that ignores a genuinely new generation shows a
 * stale list forever.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { activeSkillsStore, resetActiveSkills, updateActiveSkills } from './active-skills';

const part = (generationId: string, skills: string[]) => ({ type: 'skills-loaded', generationId, skills });

beforeEach(() => resetActiveSkills());

describe('the live skills signal', () => {
  it('takes the skills for a turn', () => {
    updateActiveSkills(part('gen_1', ['bt-spec', 'bt-design']));
    expect(activeSkillsStore.get()).toEqual({ generationId: 'gen_1', skills: ['bt-spec', 'bt-design'] });
  });

  it('is idempotent under replay — the same part arriving 50 times changes nothing', () => {
    updateActiveSkills(part('gen_1', ['bt-spec']));

    for (let i = 0; i < 50; i++) {
      updateActiveSkills(part('gen_1', ['bt-spec']));
    }

    expect(activeSkillsStore.get()).toEqual({ generationId: 'gen_1', skills: ['bt-spec'] });
  });

  /*
   * 🔴 REPLACE, NEVER MERGE. A turn that loads no skill after one that loaded `bt-spec` must not
   * inherit it — the badge would claim a skill ran when none did, which is worse than showing
   * nothing at all.
   */
  it('replaces outright on a new generation, never merging the previous turn', () => {
    updateActiveSkills(part('gen_1', ['bt-spec', 'bt-design']));
    updateActiveSkills(part('gen_2', ['bt-landing']));

    expect(activeSkillsStore.get()).toEqual({ generationId: 'gen_2', skills: ['bt-landing'] });
  });

  it('resets between turns, so a skill-less turn shows nothing', () => {
    updateActiveSkills(part('gen_1', ['bt-spec']));
    resetActiveSkills();

    expect(activeSkillsStore.get()).toBeNull();
  });

  it('ignores every other data part on the stream', () => {
    for (const other of [
      { type: 'agent-status', generationId: 'gen_1', seq: 1 },
      { type: 'media-task', taskId: 't1' },
      { type: 'skills-loaded', generationId: 'gen_1' },
      { type: 'skills-loaded', skills: ['x'] },
      null,
      'nonsense',
      42,
    ]) {
      updateActiveSkills(other);
    }

    expect(activeSkillsStore.get()).toBeNull();
  });

  it('keeps only string entries — the badge renders whatever it is handed', () => {
    updateActiveSkills({ type: 'skills-loaded', generationId: 'g', skills: ['bt-spec', 7, null, 'bt-design'] });
    expect(activeSkillsStore.get()?.skills).toEqual(['bt-spec', 'bt-design']);
  });
});
