/**
 * Skill pre-loading + the creation-turn contract (§4.2, §4.4b).
 *
 * This is a PERFORMANCE path, and its failure mode is silent: nothing throws, nothing breaks, the
 * build just quietly goes back to taking eight minutes and costing 3x. Measured on a real kart-racer
 * creation, letting the model fetch skills itself cost 350s and 29,173 output tokens across six tool
 * rounds — it drafted the game, abandoned the draft to call `load_skill`, and redrafted. Six times.
 */
import { describe, expect, it } from 'vitest';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import { buildPreloadedSkillBlock } from './preload-skills';

describe('the creation-turn marker', () => {
  /**
   * `create-project.ts` (client) writes this sentence into the brief; the proxy (server) matches on it
   * to run the turn WITHOUT tools. They cannot import each other, so the constant is the only thing
   * holding the two halves together. Reword the brief without updating the constant and creation
   * silently regresses to the slow path — with no error anywhere.
   */
  it('is the exact sentence the creation brief opens with', () => {
    expect(CREATION_BRIEF_MARKER).toBe('The project has been created and is installing.');
  });

  it('matches a real brief, and does not match an ordinary follow-up', () => {
    const brief = `${CREATION_BRIEF_MARKER} Do not re-create it.\n\n**This project**\n- Title: Kart Racer`;
    const followUp = 'make the karts faster and add a boost pad';

    expect(brief.includes(CREATION_BRIEF_MARKER)).toBe(true);
    expect(followUp.includes(CREATION_BRIEF_MARKER)).toBe(false);
  });
});

describe('buildPreloadedSkillBlock', () => {
  const skills = [
    { name: 'bt-design', body: 'Design guidance here.' },
    { name: 'bt-hero', body: 'Hero guidance here.' },
  ];

  it('carries every skill body', () => {
    const block = buildPreloadedSkillBlock(skills);

    expect(block).toContain('Design guidance here.');
    expect(block).toContain('Hero guidance here.');
  });

  /**
   * Load-bearing. Without an explicit "do not call load_skill", the model calls it anyway for a skill
   * it can already see — we watched it do that four times in one generation, drafting thousands of
   * output tokens before each call and throwing them away.
   */
  it('tells the model these skills are already loaded and not to fetch them', () => {
    const block = buildPreloadedSkillBlock(skills);

    expect(block).toMatch(/ALREADY LOADED/i);
    expect(block).toMatch(/do NOT call load_skill/i);
    expect(block).toContain('bt-design, bt-hero');
  });
});
