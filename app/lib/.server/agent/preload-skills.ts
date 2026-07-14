/**
 * Pre-load the skills a request obviously needs, instead of making the model fetch them (SPEC §4.2, §4.11).
 *
 * ## Why this exists — measured, not theorised
 *
 * Progressive disclosure (model calls `load_skill` when it decides it needs one) is the textbook
 * design, and on this workload it is catastrophic. A real "make me a kart racer" build:
 *
 *   step 1:  28s |  2,570 out | load_skill
 *   step 2:  27s |  2,015 out | read_skill_resource
 *   step 3:  52s |  4,074 out | load_skill
 *   step 4:  51s |  4,275 out | load_skill
 *   step 5:  51s |  4,221 out | read_skill_resource
 *   step 6:  53s |  4,250 out | load_skill
 *   step 7:  86s |  7,768 out | load_skill
 *   step 8: 118s | 13,813 out | ANSWER
 *
 * The ANSWER — the actual game — is 13,813 tokens and about two minutes. The tool steps burned
 * **29,173 output tokens over 350 seconds**: 68% of the bill and 75% of the wall clock. A tool CALL is
 * a JSON argument worth ~50 tokens, so those tens of thousands of tokens are not tool calls. They are
 * the model DRAFTING the game, realising it wants a skill, calling for it, and then throwing the draft
 * away and redrafting. Six times. It loaded exactly ONE distinct skill (`bt-design`) across four
 * `load_skill` calls.
 *
 * So the tool loop is not paying for itself: it costs far more than the context it saves. Handing the
 * model the skill up front, inside the CACHED prefix (cache reads bill at 0.1x), removes the round
 * trips, the redrafts, and the risk of hitting the tool-round cap — which triggers a forced
 * re-answer and doubles the output again.
 *
 * `load_skill` stays, for anything the router does not anticipate. It just stops being the common path.
 */
import { getSkillStore } from '~/lib/.server/skills/store';
import type { SkillVersion } from '~/lib/.server/skills/store';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('preload-skills');

/**
 * Keywords that mean "this build will need this skill".
 *
 * Deliberately literal and boring. A false positive costs cached tokens (0.1x — cheap); a false
 * negative costs a tool round trip (~50s and thousands of redrafted output tokens — expensive). The
 * asymmetry is enormous, so lean toward loading.
 */
const SKILL_KEYWORDS: Record<string, string[]> = {
  'bt-design': [
    'design',
    'landing',
    'page',
    'ui',
    'menu',
    'hud',
    'screen',
    'style',
    'theme',
    'look',
    'game',
    'make me',
    'build me',
    'create',
  ],
  'bt-prototype': ['prototype', 'scaffold', 'starter', 'boilerplate'],
  'bt-spec': ['spec', 'specification', 'requirements', 'plan'],
  'bt-atlas': ['atlas', 'texture', 'skin', 'uv', 'material'],
  'bt-convert': ['convert', 'import model', 'gltf', 'glb', 'fbx'],
  'bt-hero': ['hero', 'scroll', 'showcase', 'marketing'],
};

/** Cap the pre-load so a keyword-soup prompt cannot drag the entire skill library into the prefix. */
const MAX_PRELOADED = 2;

export interface PreloadedSkill {
  name: string;
  body: string;

  /**
   * The skill's bundled resources — the paths ONLY, never the bodies.
   *
   * Load-bearing, and its absence caused a two-minute failure. `load_skill`'s return value appends
   * this list, so a model that fetches a skill the normal way learns what else it can ask for. The
   * pre-loaded block used to omit it — and `bt-design`'s instructions say, in as many words, "read
   * `references/3d-hero-scroll.md` BEFORE writing any code". So the model had an instruction to read a
   * file and no idea what files existed. It called `load_skill` five times trying to get the list, then
   * guessed a path called `"placeholder"`.
   *
   * Pre-loading a skill means giving the model everything `load_skill` would have — including this.
   */
  resourcePaths: string[];
}

/**
 * Choose the skills to inline for this request.
 *
 * `slashSkill` is the skill the user explicitly invoked (`/bt-design`). It is already injected by the
 * proxy, so it must not be pre-loaded twice.
 */
export async function preloadSkills(
  routingText: string,
  slashSkill?: string,
  isCreation = false,
): Promise<PreloadedSkill[]> {
  const haystack = routingText.toLowerCase();

  /*
   * A creation turn gets exactly ONE skill: the design skill.
   *
   * Two reasons. The routing text on a creation turn is the BRIEF, not the user's words — it is full of
   * incidental vocabulary ("created", "starter", "scaffold") that keyword-matches skills the model has
   * no use for; we watched it drag in `bt-prototype` for a project that was already scaffolded. And a
   * creation turn writes a landing page from scratch (§4.4c), which is the one part of the job where
   * the design skill genuinely changes the output. Everything else it needs is in the brief.
   */
  const candidates = isCreation
    ? ['bt-design'].filter((name) => name !== slashSkill)
    : Object.entries(SKILL_KEYWORDS)
        .filter(([name]) => name !== slashSkill)
        .filter(([, keywords]) => keywords.some((keyword) => haystack.includes(keyword)))
        .map(([name]) => name);

  const wanted = candidates.slice(0, MAX_PRELOADED);

  if (wanted.length === 0) {
    return [];
  }

  const store = getSkillStore();

  const loaded = await Promise.all(
    wanted.map(async (name): Promise<PreloadedSkill | null> => {
      const skill: SkillVersion | null = await store.getActive(name);

      /*
       * A skill named here but missing from the synced snapshot is not an error worth failing a
       * generation over — the model still has `load_skill`, and the doc-sync log is where a missing
       * skill should be noticed.
       */
      if (!skill) {
        logger.warn(`Pre-load skipped: no active skill named "${name}"`);
        return null;
      }

      return { name: skill.name, body: skill.body, resourcePaths: skill.resourcePaths ?? [] };
    }),
  );

  const result = loaded.filter((s): s is PreloadedSkill => s !== null);

  if (result.length > 0) {
    logger.info(`Pre-loaded skills (no tool round needed): ${result.map((s) => s.name).join(', ')}`);
  }

  return result;
}

/**
 * The system block carrying the pre-loaded skills.
 *
 * A pre-loaded turn runs with NO TOOLS (see `allowTools` in the proxy), so this block is everything
 * the model will get. Two consequences, and the second one is counter-intuitive:
 *
 *   - It says the skills are already loaded, so the model does not go looking for them.
 *
 *   - It deliberately does NOT list a skill's bundled resource paths, even though `load_skill` does.
 *     Naming a file the model has no tool to open is not information, it is a dangling instruction —
 *     and a dangling instruction is what caused the thrash in the first place: with the paths listed
 *     and `read_skill_resource` available, the model spent all six tool rounds and 160 seconds pulling
 *     in `bt-design`'s hero-scroll templates in order to change a button's colour, then returned
 *     nothing. Tell it about a door it cannot open and it will spend the whole turn pushing on it.
 *
 * The corollary — a pre-loaded skill's bundled files are unreachable — is a real limitation, recorded
 * in the proxy and in spec/skills.md rather than papered over.
 */
export function buildPreloadedSkillBlock(skills: PreloadedSkill[]): string {
  const names = skills.map((s) => s.name).join(', ');

  return (
    `# Skills — ALREADY LOADED\n\n` +
    `The following skills are loaded and their full instructions are below: ${names}.\n` +
    `**Do NOT call load_skill for them** — you already have them. Calling it wastes a slow round trip.\n\n` +
    skills.map((skill) => `## Skill: ${skill.name}\n\n${skill.body}`).join('\n\n---\n\n')
  );
}
