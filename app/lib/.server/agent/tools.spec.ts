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

const { createSkillTools } = await import('./tools');

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
