/**
 * WHO CHOOSES A SKILL (SPEC §4.11, `spec/skills.md`) — the structural guard, 2026-07-26.
 *
 * The answer must be: **the model, from the descriptions**, on every turn except creation. That is the
 * agentskills.io contract, it is what `buildSkillsIndex` promises the model in the cached prompt, and
 * it is the only version of "skills" that is a skill system rather than a prompt library with extra
 * steps.
 *
 * It was not that. A `Record<string, string[]>` of substrings, hardcoded in THIS repo, picked the
 * skills — and every failure it produced was silent:
 *
 *   - `'ui'` matched as a bare substring, so `"why is my build failing"` (b-**ui**-ld) inlined
 *     `bt-design`: 24KB into the cached prefix, on a debugging question.
 *   - Three of the ten synced skills had no keyword entry and could NEVER load — `bt-copycat`,
 *     `bt-plan`, `bt-execute` — the last two being two-thirds of the product's own
 *     spec → plan → execute workflow.
 *   - The `description` field, which the index documents as THE trigger, was never read by the code
 *     doing the choosing. Improving a description in the skills repo changed nothing.
 *   - The router's input included the invoked skill's own BODY, so `/bt-spec` inlined `bt-landing`
 *     because bt-spec's SKILL.md contains the word "landing" — and routing was sticky, so it stayed
 *     wrong for the whole conversation.
 *
 * Each of those is a one-line change away from returning, and none of them would fail a behavioural
 * test — the platform kept working, it just fed the model the wrong instructions. So the guard is
 * structural, in the `outbound-enumerate.spec.ts` / `no-server-storage.spec.ts` shape: it reads the
 * source, and it carries CONTROLS proving the reader still sees anything at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_DIR = join(process.cwd(), 'app/lib/.server/agent');

/** Comments are documentation, not behaviour: the post-mortems quote the old keywords by name. */
function sourceWithoutComments(file: string): string {
  return readFileSync(join(AGENT_DIR, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the skill router is gone, and cannot grow back', () => {
  const preload = sourceWithoutComments('preload-skills.ts');
  const proxy = sourceWithoutComments('proxy.ts');

  /** The control: the reader must actually be reading something. Without this the file could be empty. */
  it('CONTROL — the source scan sees real code', () => {
    expect(preload).toContain('export async function preloadSkills');
    expect(preload.length).toBeGreaterThan(500);
    expect(proxy).toContain('preloadSkills(');
  });

  it('CONTROL — comments are stripped, so a post-mortem naming the old keywords does not count', () => {
    const raw = readFileSync(join(AGENT_DIR, 'preload-skills.ts'), 'utf-8');

    // The doc comment quotes the dead keyword by name; the stripped source must not.
    expect(raw).toContain("'ui'");
    expect(preload).not.toContain("'ui'");
  });

  it('holds no keyword table — no map from a skill name to trigger words', () => {
    expect(preload).not.toMatch(/SKILL_KEYWORDS/);
    expect(preload).not.toMatch(/Record<string, string\[\]>/);
  });

  /*
   * The only skill names allowed in server source are the CREATION brief's two. Any other hardcoded
   * name is a routing decision made in this repo about a file that lives in another one.
   */
  it('names no skill except the two the creation brief was written against', () => {
    const named = new Set([...preload.matchAll(/'(bt-[a-z-]+)'/g)].map((m) => m[1]));

    expect([...named].sort()).toEqual(['bt-design', 'bt-landing']);
  });

  it("does not feed the invoked skill's own body into any router", () => {
    // `skillText` was the variable that carried it; both routers read it.
    expect(proxy).not.toMatch(/skillText/);
  });

  it("routes doc blocks from the user's words only", () => {
    expect(proxy).toMatch(/selectStickyBlocks\(userTexts\)/);
  });
});

describe('preloadSkills — only the creation turn inlines anything', () => {
  it('returns nothing for an ordinary turn, whatever the user typed', async () => {
    vi.doMock('~/lib/.server/skills/store', () => ({
      getSkillStore: () => ({
        getActive: async (name: string) => ({ name, body: 'x', resourcePaths: [] }),
        listActive: async () => [],
      }),
    }));

    const { preloadSkills } = await import('./preload-skills');

    expect(await preloadSkills(undefined, false)).toEqual([]);
    expect(await preloadSkills('bt-spec', false)).toEqual([]);
  });

  it("inlines the creation brief's two skills on a creation turn", async () => {
    vi.doMock('~/lib/.server/skills/store', () => ({
      getSkillStore: () => ({
        getActive: async (name: string) => ({ name, body: `body of ${name}`, resourcePaths: [] }),
        listActive: async () => [],
      }),
    }));

    const { preloadSkills } = await import('./preload-skills');
    const loaded = await preloadSkills(undefined, true);

    expect(loaded.map((s) => s.name)).toEqual(['bt-landing', 'bt-design']);
  });
});

/*
 * CARRYING SKILLS FORWARD (§4.11) — the last gap against Claude Code, closed 2026-07-26.
 *
 * In Claude Code a loaded skill stays in context for the session. Our tool loop is server-side and
 * internal, so its call and result never enter the saved conversation — a skill loaded on turn 1 was
 * GONE on turn 2, and a spec → plan → execute workflow paid a fresh round trip every single turn for
 * instructions it had already been given.
 *
 * The carried set rides in the CACHED prefix, which makes it cheaper than the thing it copies. That is
 * only true while two properties hold, and BOTH fail silently — as a bigger bill, never as an error:
 *
 *   - **append-only, first-seen order.** A name inserted at the FRONT shifts every byte behind it and
 *     rewrites the whole prefix at 2x.
 *   - **read from the FULL message list.** Reading the windowed history would make the set SHRINK as a
 *     conversation ages, rewriting the prefix on the turn the window slides.
 */
describe('stickyLoadedSkills — what the conversation already loaded', () => {
  const turn = (...names: string[]) => ({
    role: 'assistant',
    annotations: [{ type: 'agentMeta', value: { skillsLoaded: names } }],
  });

  it('finds what the model loaded on earlier turns', async () => {
    const { stickyLoadedSkills } = await import('./preload-skills');

    expect(stickyLoadedSkills([turn('bt-plan')])).toEqual(['bt-plan']);
  });

  it('ignores messages with no annotations, and annotations of other types', async () => {
    const { stickyLoadedSkills } = await import('./preload-skills');

    expect(
      stickyLoadedSkills([
        { role: 'user' } as never,
        { role: 'assistant', annotations: [{ type: 'credits', value: { charged: 12 } }] } as never,
        turn('bt-design'),
      ]),
    ).toEqual(['bt-design']);
  });

  it("is APPEND-ONLY in first-seen order — every turn's list is a prefix of the next turn's", async () => {
    const { stickyLoadedSkills } = await import('./preload-skills');

    /*
     * ⚠️ The names are deliberately in REVERSE alphabetical order of first appearance. An earlier draft
     * used bt-spec → bt-plan → bt-execute, whose first-seen order happens to match what `.sort()` would
     * produce closely enough that a sorting mutation still passed. A test for an ORDER property has to
     * use inputs whose correct order differs from every plausible wrong one.
     */
    const conversation = [turn('zeta-skill'), turn('zeta-skill', 'mid-skill'), turn('mid-skill', 'alpha-skill')];

    const afterTurn1 = stickyLoadedSkills(conversation.slice(0, 1));
    const afterTurn2 = stickyLoadedSkills(conversation.slice(0, 2));
    const afterTurn3 = stickyLoadedSkills(conversation);

    expect(afterTurn1).toEqual(['zeta-skill']);
    expect(afterTurn2).toEqual(['zeta-skill', 'mid-skill']);
    expect(afterTurn3).toEqual(['zeta-skill', 'mid-skill', 'alpha-skill']);

    // The byte-level property: earlier lists are literal prefixes, so the block only ever grows at the end.
    expect(afterTurn2.slice(0, afterTurn1.length)).toEqual(afterTurn1);
    expect(afterTurn3.slice(0, afterTurn2.length)).toEqual(afterTurn2);
  });

  it('never lets the same skill appear twice, however many turns re-report it', async () => {
    const { stickyLoadedSkills } = await import('./preload-skills');

    expect(stickyLoadedSkills([turn('bt-design'), turn('bt-design'), turn('bt-design')])).toEqual(['bt-design']);
  });

  it('caps the carried set — a long conversation cannot grow the prefix without limit', async () => {
    const { stickyLoadedSkills, MAX_STICKY_SKILLS } = await import('./preload-skills');

    const many = stickyLoadedSkills([turn('a', 'b', 'c', 'd', 'e', 'f')]);

    expect(many).toHaveLength(MAX_STICKY_SKILLS);

    // Capping must TRUNCATE the tail, never rotate: the surviving head is what the prefix already holds.
    expect(many).toEqual(['a', 'b', 'c'].slice(0, MAX_STICKY_SKILLS));
  });

  it('survives malformed annotations rather than failing the generation', async () => {
    const { stickyLoadedSkills } = await import('./preload-skills');

    expect(
      stickyLoadedSkills([
        { role: 'assistant', annotations: null } as never,
        { role: 'assistant', annotations: [null, 'nonsense', 42] } as never,
        { role: 'assistant', annotations: [{ type: 'agentMeta', value: { skillsLoaded: 'not-an-array' } }] } as never,
        {
          role: 'assistant',
          annotations: [{ type: 'agentMeta', value: { skillsLoaded: [1, '', 'bt-hero'] } }],
        } as never,
      ]),
    ).toEqual(['bt-hero']);
  });
});
