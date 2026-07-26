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
    { name: 'bt-design', body: 'Design guidance here.', resourcePaths: ['references/3d-hero-scroll.md'] },
    { name: 'bt-hero', body: 'Hero guidance here.', resourcePaths: [] },
  ];

  it('carries every skill body', () => {
    const block = buildPreloadedSkillBlock(skills);

    expect(block).toContain('Design guidance here.');
    expect(block).toContain('Hero guidance here.');
  });

  /**
   * The block must make the STATE clear — these instructions are already here — and must NOT issue an
   * order the tool set contradicts.
   *
   * The original text shouted "**Do NOT call load_skill**", and we watched the model call
   * `load_skill('bt-design')` five times in a row against that heading: six rounds, ~11,000 output
   * tokens, an empty response, 405 credits. Prose cannot enforce this. What enforces it is the
   * already-loaded reply in `execute` (one sentence, no budget spent), and since 2026-07-26 the fact
   * that an ordinary turn inlines nothing the model did not itself ask for.
   */
  it('tells the model these skills are already in context', () => {
    const block = buildPreloadedSkillBlock(skills);

    expect(block).toMatch(/already in context/i);
    expect(block).toContain('bt-design, bt-hero');
  });

  /**
   * Carried skills (`stickyLoadedSkills`) run on a turn WITH tools, so their bundled paths are honest
   * information rather than a dangling instruction — withholding them would recreate `bt-design`'s
   * "read `references/…` before writing code" as unfollowable. The flag tracks whether the tools exist,
   * and nothing else may decide it.
   */
  it('names bundled resources ONLY when the turn has the tool to open them', () => {
    expect(buildPreloadedSkillBlock(skills, true)).toContain('references/3d-hero-scroll.md');
    expect(buildPreloadedSkillBlock(skills, false)).not.toContain('references/3d-hero-scroll.md');
  });

  /**
   * Counter-intuitive, and we got it wrong in both directions before landing here — so it is pinned.
   *
   * `load_skill` returns a skill's bundled-resource paths, so the instinct is that a PRE-loaded skill
   * should list them too ("a pre-loaded skill should be indistinguishable from a fetched one"). We
   * tried exactly that, together with keeping `read_skill_resource` available so the paths meant
   * something. The model then spent all six tool rounds and 160 seconds pulling in `bt-design`'s
   * 101KB of hero-scroll templates — in order to change a button's colour — and returned an empty
   * response.
   *
   * A pre-loaded turn has NO TOOLS. Naming a file the model cannot open is not information, it is a
   * dangling instruction, and it will spend the whole turn trying to follow it.
   */
  it('does not name bundled resources on a tool-less (creation) turn, which could not open them', () => {
    const block = buildPreloadedSkillBlock(skills);

    expect(block).not.toContain('references/3d-hero-scroll.md');
    expect(block).not.toMatch(/read_skill_resource/);
  });
});
