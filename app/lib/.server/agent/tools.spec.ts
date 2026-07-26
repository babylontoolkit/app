/**
 * Tool-argument schemas (§4.2, §4.6) — a MONEY path, which is not obvious from looking at them.
 *
 * The AI SDK validates tool arguments against these zod schemas BEFORE `execute` runs. A violation is
 * not handed to the model as a tool result it can correct — it throws `InvalidToolArgumentsError`,
 * which aborts the stream and kills the generation. The user is billed for every token spent up to
 * that point, their project is untouched, and what they get back is a zod dump.
 *
 * Both of these were observed on real edit turns, against the real model:
 *
 *   load_skill({})                          → required `name`   → 45s and ~3,500 output tokens, dead
 *   read_skill_resource({skill, paths: []}) → `.min(1)` on paths → 185s and 15,881 output tokens, 497 credits, dead
 *
 * Neither is a bug in the model's reasoning worth defending against upstream — models emit degenerate
 * tool calls, and always will. The bug is that we made a recoverable mistake fatal.
 *
 * So the rule these tests exist to enforce: **a tool argument the model can plausibly get wrong is
 * validated in `execute`, never in the schema.** The schema accepts it; `execute` returns a sentence
 * the model reads and corrects on its next step, inside the same generation.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/.server/skills/store', () => ({
  getSkillStore: () => ({
    getActive: async (name: string) =>
      name === 'bt-design' ? { name, body: 'Design guidance.', bodyBytes: 17, resourcePaths: [] } : null,
    listActive: async () => [{ name: 'bt-design' }, { name: 'bt-hero' }],
  }),
}));

const { createSkillTools, MAX_SKILL_LOADS, MAX_TOOL_ROUNDS } = await import('./tools');

/** The default: nothing pre-loaded, so the model may still fetch skills itself. */
function tools() {
  return createSkillTools({ loaded: new Set<string>(), offerLoadSkill: true });
}

describe('load_skill arguments', () => {
  /** The exact call that killed a generation. It must now parse. */
  it('accepts an empty argument object instead of throwing', () => {
    const parsed = tools().load_skill!.parameters.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('answers a nameless call with something the model can act on', async () => {
    const result = await tools().load_skill!.execute!({}, { toolCallId: 't', messages: [] });

    expect(result).toMatch(/needs a "name"/i);
    expect(result).toContain('bt-design');
  });

  it('still loads a skill when the name is there', async () => {
    const result = await tools().load_skill!.execute!({ name: 'bt-design' }, { toolCallId: 't', messages: [] });
    expect(result).toContain('Design guidance.');
  });
});

/**
 * The trap, closed. With `bt-design` pre-loaded into the cached prefix and a heading above it saying
 * "ALREADY LOADED — do NOT call load_skill", the model called `load_skill({name: 'bt-design'})` five
 * times in a row, burned all six tool rounds and ~11,000 output tokens, and returned an empty string.
 *
 * Telling it not to did not work. The tool has to be GONE.
 */
describe('the tool set offered to the model', () => {
  it('drops load_skill entirely once the router has pre-loaded the skills', () => {
    const set = createSkillTools({ loaded: new Set(['bt-design']), offerLoadSkill: false });

    expect(set.load_skill).toBeUndefined();
  });

  /**
   * But NOT read_skill_resource. Pre-loading inlines a skill's instructions, not its bundled files —
   * and `bt-design`'s instructions say to read `references/3d-hero-scroll.md` before writing code.
   * Removing this tool would leave the model an instruction it cannot obey.
   */
  it('keeps read_skill_resource, because bundled files are still not in context', () => {
    const set = createSkillTools({ loaded: new Set(['bt-design']), offerLoadSkill: false });

    expect(set.read_skill_resource).toBeDefined();
  });
});

describe('read_skill_resource arguments', () => {
  /** The other call that killed a generation — `paths: []` against a `.min(1)` constraint. */
  it('accepts an empty paths array instead of throwing', () => {
    const parsed = tools().read_skill_resource.parameters.safeParse({ skill: 'bt-design', paths: [] });
    expect(parsed.success).toBe(true);
  });

  it('accepts a wholly empty argument object', () => {
    const parsed = tools().read_skill_resource.parameters.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('tells the model to get on with the task when it asks for no paths', async () => {
    const result = await tools().read_skill_resource.execute!(
      { skill: 'bt-design', paths: [] },
      { toolCallId: 't', messages: [] },
    );

    expect(result).toMatch(/nothing to read/i);
    expect(result).toMatch(/proceed with the task/i);
  });

  it('asks for a skill name when none was given', async () => {
    const result = await tools().read_skill_resource.execute!({}, { toolCallId: 't', messages: [] });
    expect(result).toMatch(/needs a "skill"/i);
  });
});

/*
 * The skill-load BUDGET (§4.11, `MAX_SKILL_LOADS`) — the structural ceiling that replaced "take the
 * tool away" when skill selection was handed back to the model (2026-07-26).
 *
 * The old design bounded skill thrash by WITHDRAWING `load_skill` whenever the keyword router had
 * pre-loaded something. That bounded the tokens and destroyed the feature: the model could not choose
 * its own skills, could not correct a bad routing decision, and was told in the cached prompt to call a
 * tool it did not have. The budget bounds the same cost without any of that — the tool is always there,
 * it just stops handing over BODIES past the cap.
 *
 * These are money tests. Each `load_skill` body is 15–25KB of prompt on every subsequent step of the
 * generation, so an unbounded budget is an unbounded bill, and the failure is silent: it looks like a
 * slightly more expensive turn.
 */
describe('the skill-load budget', () => {
  it('hands over the body while the budget lasts', async () => {
    const set = createSkillTools({
      loaded: new Set<string>(),
      loadedThisTurn: new Set<string>(),
      offerLoadSkill: true,
    });
    const result = await set.load_skill!.execute!({ name: 'bt-design' }, {} as never);

    expect(result).toContain('Design guidance.');
  });

  it('refuses a body once MAX_SKILL_LOADS skills have been loaded THIS TURN, and says what it has', async () => {
    const loaded = new Set(Array.from({ length: MAX_SKILL_LOADS }, (_, i) => `skill-${i}`));
    const set = createSkillTools({ loaded, loadedThisTurn: new Set(loaded), offerLoadSkill: true });

    const result = (await set.load_skill!.execute!({ name: 'bt-design' }, {} as never)) as string;

    expect(result).not.toContain('Design guidance.');
    expect(result).toContain('limit');

    // Naming what it already has is the recovery: the model needs to know what to proceed WITH.
    expect(result).toContain('skill-0');
  });

  /*
   * The budget buys BODIES, never mistakes. An already-loaded re-request and an unknown name each
   * return a sentence, so charging them would spend a real skill slot on the model's error — and the
   * already-loaded answer is precisely what stops the five-identical-calls thrash.
   */
  it('does not spend the budget on an already-loaded re-request', async () => {
    const set = createSkillTools({ loaded: new Set(['bt-design']), offerLoadSkill: true });

    const result = (await set.load_skill!.execute!({ name: 'bt-design' }, {} as never)) as string;

    expect(result).toContain('already loaded');
    expect(result).not.toContain('limit');
  });

  it('is small enough to make the six-round pathology unreachable', () => {
    expect(MAX_SKILL_LOADS).toBeGreaterThanOrEqual(1);
    expect(MAX_SKILL_LOADS).toBeLessThan(MAX_TOOL_ROUNDS);
  });
});

/*
 * The budget spends NEW loads, never carried ones (§4.11).
 *
 * `loaded` is seeded with everything already in context — the `/slash` skill and whatever this
 * conversation carried forward (`stickyLoadedSkills`). If the budget counted that set, a workflow that
 * had already accumulated two skills could never load a third: the "withdraw the tool" failure this
 * design exists to remove, returning through the budget instead of the tool set.
 */
describe('the budget and the carried set', () => {
  it('lets a conversation carrying its cap-worth of skills still load a NEW one', async () => {
    const set = createSkillTools({
      loaded: new Set(['carried-a', 'carried-b', 'carried-c']),
      loadedThisTurn: new Set<string>(),
      offerLoadSkill: true,
    });

    const result = (await set.load_skill!.execute!({ name: 'bt-design' }, {} as never)) as string;

    expect(result).toContain('Design guidance.');
  });

  it('still refuses once THIS TURN has spent the budget', async () => {
    const loadedThisTurn = new Set(Array.from({ length: MAX_SKILL_LOADS }, (_, i) => `fresh-${i}`));
    const set = createSkillTools({
      loaded: new Set([...loadedThisTurn, 'carried-a']),
      loadedThisTurn,
      offerLoadSkill: true,
    });

    const result = (await set.load_skill!.execute!({ name: 'bt-design' }, {} as never)) as string;

    expect(result).not.toContain('Design guidance.');
    expect(result).toContain('limit');
  });

  it('a carried skill is answered as already-loaded, costing no budget', async () => {
    const loadedThisTurn = new Set<string>();
    const set = createSkillTools({ loaded: new Set(['bt-plan']), loadedThisTurn, offerLoadSkill: true });

    const result = (await set.load_skill!.execute!({ name: 'bt-plan' }, {} as never)) as string;

    expect(result).toContain('already loaded');
    expect(loadedThisTurn.size).toBe(0);
  });
});
