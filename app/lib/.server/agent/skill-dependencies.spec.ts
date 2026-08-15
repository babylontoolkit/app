/**
 * 🔴 AN INVOKED SKILL'S DECLARED PREREQUISITES COME WITH IT (owner-reported live, 2026-08-14).
 *
 * *"I used bt-landing the last blank canvas build, but it did not pull in bt-design as it should
 * have."* The skill had asked for it in its own body — *"Prerequisite — load bt-design FIRST, before
 * anything else… call `load_skill('bt-design')`"* — the tool was offered, and the model did not call
 * it. Prose is not a mechanism; the pipeline satisfies the prerequisite now.
 *
 * The edge is DATA, read from the skills repo's `dependencies:` frontmatter. A hardcoded
 * `bt-landing → bt-design` table in this repo would be a second copy of a fact authored elsewhere —
 * the shape the 2026-07-26 keyword-router deletion exists to prevent, and the shape of the `scene_url`
 * defect two commits ago.
 *
 * Every assertion here is mutation-verified.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillDependencyNames } from './preload-skills';
import { MAX_SKILL_DEPENDENCIES, parseSkillDependencies } from '~/lib/.server/skills/frontmatter';

describe('parseSkillDependencies — frontmatter is scalar-only', () => {
  it('reads a single name', () => {
    expect(parseSkillDependencies('bt-design')).toEqual(['bt-design']);
  });

  /* The parser cannot represent a YAML sequence, so a list is comma- or space-separated. */
  it('reads a comma- or space-separated list', () => {
    expect(parseSkillDependencies('bt-design, bt-copycat')).toEqual(['bt-design', 'bt-copycat']);
    expect(parseSkillDependencies('bt-design bt-copycat')).toEqual(['bt-design', 'bt-copycat']);
    expect(parseSkillDependencies('"bt-design"')).toEqual(['bt-design']);
  });

  /* Absent is the overwhelmingly common case and must be exactly today's behaviour. */
  it('is empty when the field is absent or blank', () => {
    expect(parseSkillDependencies(undefined)).toEqual([]);
    expect(parseSkillDependencies('')).toEqual([]);
    expect(parseSkillDependencies('   ')).toEqual([]);
  });

  /**
   * 🔴 A WALL, NOT TIDINESS. This string reaches `getActive(name)`, which resolves an object-store
   * key — so a traversal here is a path the store was never asked to serve. Dropped rather than
   * rejected: one malformed entry must not stop the skill loading.
   */
  it('drops anything that is not a valid skill name', () => {
    expect(parseSkillDependencies('../../secrets')).toEqual([]);
    expect(parseSkillDependencies('BT-Design')).toEqual([]);
    expect(parseSkillDependencies('bt_design')).toEqual([]);
    expect(parseSkillDependencies('../x, bt-design')).toEqual(['bt-design']);
  });

  /**
   * A bound on a value from an EXTERNAL repository: each dependency is 15–25KB inlined into the
   * cached prefix of a turn nobody asked to pay extra for.
   */
  it('caps the list, and de-duplicates', () => {
    expect(parseSkillDependencies('a-one, b-two, c-three, d-four')).toHaveLength(MAX_SKILL_DEPENDENCIES);
    expect(parseSkillDependencies('bt-design, bt-design')).toEqual(['bt-design']);
  });
});

describe('skillDependencyNames — what this turn actually loads', () => {
  it('loads the prerequisite of the invoked skill', () => {
    expect(
      skillDependencyNames({
        invoked: { name: 'bt-landing', dependencies: ['bt-design'] },
        alreadyInContext: [],
      }),
    ).toEqual(['bt-design']);
  });

  /* No slash invocation, or a skill that declares nothing — every ordinary turn is unchanged. */
  it('loads nothing when there is no invocation or no declaration', () => {
    expect(skillDependencyNames({ alreadyInContext: [] })).toEqual([]);
    expect(skillDependencyNames({ invoked: { name: 'bt-landing' }, alreadyInContext: [] })).toEqual([]);
    expect(skillDependencyNames({ invoked: { name: 'bt-landing', dependencies: [] }, alreadyInContext: [] })).toEqual(
      [],
    );
  });

  /**
   * 🔴 NEVER PAY FOR THE SAME BODY TWICE IN ONE PROMPT. A carried skill (`stickyLoadedSkills`) is
   * already inlined beside the invoked one — this is the same waste `carriedSkillNames` drops the
   * invoked skill to avoid, arriving through the other door.
   */
  it('skips a prerequisite that is already in context', () => {
    expect(
      skillDependencyNames({
        invoked: { name: 'bt-landing', dependencies: ['bt-design'] },
        alreadyInContext: ['bt-design'],
      }),
    ).toEqual([]);
  });

  /**
   * A skill declaring ITSELF is inlined already by `resolveSlashInvocation`. Cheap to guard, and the
   * failure is a 20KB duplicate rather than anything that throws.
   */
  it('never re-loads the invoked skill itself', () => {
    expect(
      skillDependencyNames({
        invoked: { name: 'bt-landing', dependencies: ['bt-landing', 'bt-design'] },
        alreadyInContext: [],
      }),
    ).toEqual(['bt-design']);
  });
});

/**
 * 🔴 WIRED — the decider is pure and does nothing until the proxy sends it.
 *
 * The bug being fixed IS a mechanism that only ran on one turn shape, so "correct in isolation" is
 * precisely the state that produced the live report.
 */
describe('the prerequisite reaches the prompt', () => {
  const PROXY = readFileSync(join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf8');
  const SYNC = readFileSync(join(process.cwd(), 'app/lib/.server/skills/sync.ts'), 'utf8');

  /* Without this the frontmatter is parsed by nobody and every skill has no dependencies forever. */
  it('sync carries the declaration off the bundle', () => {
    expect(SYNC).toMatch(/dependencies: parseSkillDependencies\(result\.skill\.frontmatter\.dependencies\)/);
  });

  it('the slash resolver reports them and the proxy loads them', () => {
    expect(PROXY).toMatch(/dependencies: skill\.dependencies \?\? \[\]/);
    expect(PROXY).toMatch(/skillDependencyNames\(\{/);
    expect(PROXY).toMatch(/dependencies: slash\.dependencies/);
  });

  /**
   * 🔴 THE SAME MERGED BREAKPOINT. Anthropic allows exactly FOUR `cache_control` blocks; a `/slash`
   * turn that also carries a skill would be the fifth and a hard HTTP 400 before a single token —
   * the defect `MAX_CACHE_BREAKPOINTS` exists for, which shipped once already.
   */
  it('rides in skillBlocks rather than pushing its own cached entry', () => {
    const blocks = PROXY.slice(PROXY.indexOf('const skillBlocks = ['));
    const body = blocks.slice(0, blocks.indexOf('];'));

    expect(body).toMatch(/buildPreloadedSkillBlock\(dependencies, true\)/);
    expect(body, 'no breakpoint of its own').not.toContain('CACHE_CONTROL');
  });

  /**
   * Resource paths TRAVEL (`true`). `bt-design` is the documented case where withholding them breaks
   * the skill — its instructions say to read `references/…` before writing code, and a model with no
   * list of files has an instruction it cannot follow.
   */
  it('gives the prerequisite its resource paths', () => {
    expect(PROXY).toMatch(/buildPreloadedSkillBlock\(dependencies, true\)/);
  });

  /**
   * 🔴 DEFAULT-DENY on a hardcoded edge. The whole point is that the skills repo declares this; a
   * table here goes stale the day the skill changes, and nothing would say so.
   *
   * `CREATION_SKILLS` is the ONE sanctioned constant naming skills (the creation brief is a prompt we
   * wrote), and it lives in `preload-skills.ts` — not here.
   */
  it('CONTROL — the proxy names no skill it pairs by hand', () => {
    /*
     * ⚠️ COMMENTS STRIPPED FIRST. Both files DISCUSS `bt-design` and `bt-landing` at length — the
     * post-mortems are the reason the rule exists — so a raw scan fails on the prose explaining why
     * the code is right. Caught on this spec's first run; `legacy-credentials.spec.ts` had already
     * derived the same helper for the same reason.
     */
    const code = PROXY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    expect(code).not.toMatch(/'bt-design'/);
    expect(code).not.toMatch(/'bt-landing'/);

    /* And the stripper did not simply empty the file. */
    expect(code).toContain('skillDependencyNames({');
  });

  it('CONTROL — the scanner is reading real files', () => {
    expect(PROXY.length).toBeGreaterThan(10_000);
    expect(PROXY).toContain('resolveSlashInvocation');
    expect(SYNC).toContain('validateSkill');
  });
});
