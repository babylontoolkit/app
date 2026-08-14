/**
 * Skill tools for the server-side tool loop (SPEC §4.2 step 3, §4.11, spec/skills.md).
 *
 * These execute ENTIRELY on the server, inside a single generation. The client never sees the tool
 * calls — its stream stays pure text + actions. That is deliberate: a user watching their game get
 * built should not be reading our progressive-disclosure bookkeeping.
 *
 * We NEVER execute a skill's `scripts/` server-side. A skill that ships project files instructs the
 * agent to emit them as normal file actions into the user's WebContainer instead.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import { getSkillStore } from '~/lib/.server/skills/store';
import { DEFAULT_AGENT_BUDGETS } from './budgets';

const logger = createScopedLogger('agent-tools');

/**
 * Tool rounds per generation. On cap, the model proceeds with whatever it has loaded.
 *
 * 🔴 **DERIVED, NOT DECLARED (2026-08-14) — this was a SECOND WRITER of a number `budgets.ts` already
 * owns.** It read `= 7`, hand-maintained, with a comment explaining why it had been raised from 6.
 * Meanwhile `resolveAgentBudgets` computes `maxToolRounds = max(BASELINE_TOOL_ROUNDS,
 * creationToolRounds)` precisely so the ceiling can never be lower than what a creation needs.
 *
 * The two agreed only by coincidence, and the coincidence ended the moment `CREATION_FILE_READ_ROUNDS`
 * went 3 → 6: the derived ceiling became 9 while this constant still said 7, so a creation was
 * suddenly entitled to more rounds than the "maximum" — inverting the one relationship
 * `tool-policy.spec.ts` pins. That spec caught it, which is the whole reason it asserts a
 * RELATIONSHIP rather than a literal.
 *
 * ⚠️ It is the shipped DEFAULT, not a per-request value: the budgets an actual turn runs with arrive
 * on `ToolPolicyInput.budgets` (an operator can raise them). Reading this constant on a hot path would
 * ignore the operator silently — same trap as `CREATION_TOOL_ROUNDS` next door. It exists for the
 * `MAX_SKILL_LOADS < MAX_TOOL_ROUNDS` calibration and for the prompt's advertised number.
 */
export const MAX_TOOL_ROUNDS = DEFAULT_AGENT_BUDGETS.maxToolRounds;

/**
 * How many skill BODIES one generation may pull in (§4.11, `spec/skills.md`).
 *
 * 🔴 This is the structural ceiling on the six-round pathology, and it exists because the alternative
 * is an instruction. The measured disaster — 6 tool rounds, 29,173 output tokens, 350 seconds, to end
 * up with ONE distinct skill — was not the cost of loading skills (a `load_skill` call is ~50 tokens
 * of JSON); it was the model calling for skills again and again *between drafts of the artifact*, and
 * paying 5× output rate to redraft each time. A cap on ROUNDS could not stop it, because each of those
 * rounds looked individually reasonable.
 *
 * So the budget is spent on BODIES, enforced inside `execute` where a bad value is recoverable: past
 * the cap the tool stops handing over instructions and tells the model to proceed with what it has.
 * Six (raised from two, owner, 2026-08-08): with the creation-brief preload disabled for the
 * reliability debugging, the first build turn must CHOOSE `bt-design` + `bt-landing` itself rather
 * than having them inlined, and the owner wants headroom for prompts that legitimately span more
 * skills (and, later, user-authored ones). The ceiling's real job — bounding the six-round redraft
 * pathology — is carried by the ROUNDS cap and the refusal wording, not by this number being small;
 * the invariant that must survive any retune is `MAX_SKILL_LOADS < MAX_TOOL_ROUNDS` (test-pinned).
 *
 * Not counted: an already-loaded re-request (answered with one sentence) and an unknown name (answered
 * with the index). Neither hands over a body, and charging for them would spend the budget on the
 * model's mistakes rather than on its work.
 */
export const MAX_SKILL_LOADS = 6;

export interface SkillToolContext {
  /** Skills loaded during this generation — recorded on the `generations` row (§4.11 metrics). */
  loaded: Set<string>;

  /**
   * Skills the model asked for ON THIS TURN — what the budget actually spends.
   *
   * Separate from `loaded`, which is seeded with everything already IN CONTEXT (the `/slash` skill, and
   * the skills this conversation loaded on earlier turns — `stickyLoadedSkills`). Charging the budget
   * for those would mean a conversation that has carried two skills can never load a third, which is
   * the "withdraw the tool" failure returning through the budget instead of the tool set.
   */
  loadedThisTurn?: Set<string>;

  /**
   * Offer `load_skill`? False once the router has already pre-loaded the turn's skills.
   *
   * A tool the model is TOLD not to use is a trap, not a redundancy. With `bt-design` pre-loaded into
   * the cached prefix, under a heading reading "ALREADY LOADED — do NOT call load_skill", the model
   * called `load_skill({name: 'bt-design'})` five times in a row. Each call answered "already loaded,
   * proceed with the task". Each time it called again. Six tool rounds, ~11,000 output tokens, two
   * minutes — and then an empty response.
   *
   * `read_skill_resource` stays available regardless: a pre-loaded skill's BUNDLED FILES are still out
   * of context (only its instructions are inlined), and `bt-design` tells the model to read one before
   * writing code. Removing that tool would leave an instruction it cannot obey.
   */
  offerLoadSkill: boolean;
}

export function createSkillTools(context: SkillToolContext) {
  const store = getSkillStore();

  const loadSkill = {
    load_skill: tool({
      description:
        'Load the full instructions for a skill listed in the Available Skills index. ' +
        "Call this before implementing anything in that skill's domain.",
      parameters: z.object({
        /*
         * `.optional()`, even though a nameless load_skill is meaningless — see the note on
         * `read_skill_resource.paths` below. A REQUIRED field is enforced by the AI SDK before
         * `execute` runs, and a violation throws `InvalidToolArgumentsError`, which kills the entire
         * generation. We watched a real edit turn die on a literal `load_skill({})`: 45 seconds and
         * ~3,500 output tokens spent, the user's file untouched, an error string in the chat.
         *
         * The tool's own contract (see the `!skill` branch below) is that a bad argument is a model
         * mistake it should RECOVER from inside the same generation. A required schema field silently
         * opts out of that contract. So: accept anything, validate here.
         */
        name: z.string().optional().describe('The skill name exactly as it appears in the Available Skills index.'),
      }),
      execute: async ({ name }) => {
        if (!name) {
          const available = (await store.listActive()).map((s) => s.name);
          return `load_skill needs a "name". Available skills: ${available.join(', ')}.`;
        }

        /*
         * Already loaded — return a cheap acknowledgement instead of re-injecting the body.
         *
         * Models DO re-request a skill that is already in context (observed: a `/bt-spec` invocation
         * calling load_skill('bt-spec') twice, 17KB each). Re-sending it burns a tool round from the
         * cap AND the tokens, and the cap is what stands between the model and never reaching its
         * final answer.
         */
        if (context.loaded.has(name)) {
          return `The "${name}" skill is already loaded and its instructions are in your context. Proceed with the task — do not load it again.`;
        }

        /*
         * The budget (see `MAX_SKILL_LOADS`) — checked BEFORE the store read, so an over-budget call
         * cannot even pay for a lookup. It is a refusal the model can act on, not an error: it names
         * what it already has and tells it to get on with the task, which is the recovery the tool
         * contract is built around everywhere else in this file.
         */
        const thisTurn = context.loadedThisTurn;

        if (thisTurn && thisTurn.size >= MAX_SKILL_LOADS) {
          logger.warn(`load_skill: budget spent (${thisTurn.size}/${MAX_SKILL_LOADS}), refused "${name}"`);

          return (
            `You have already loaded ${thisTurn.size} skills in this response (${[...context.loaded].join(', ')}), ` +
            `which is the limit. Proceed with the task using those instructions — do not call load_skill again.`
          );
        }

        const skill = await store.getActive(name);

        if (!skill) {
          /*
           * A friendly tool_result string, never a thrown exception: an unknown skill name is a
           * model mistake, and the right response is to let it recover inside the same generation.
           */
          const available = (await store.listActive()).map((s) => s.name);

          logger.warn(`load_skill: unknown skill "${name}"`);

          return `No skill named "${name}" exists. Available skills: ${available.join(', ') || '(none)'}.`;
        }

        context.loaded.add(name);
        context.loadedThisTurn?.add(name);
        logger.info(`load_skill: ${name} (${skill.bodyBytes} bytes)`);

        const resources = skill.resourcePaths.length
          ? `\n\nBundled resources (read with read_skill_resource):\n${skill.resourcePaths
              .map((p) => `- ${p}`)
              .join('\n')}`
          : '';

        return `# Skill: ${skill.name}\n\n${skill.body}${resources}`;
      },
    }),
  };

  const rest = {
    read_skill_resource: tool({
      /*
       * The description has to say what this tool is NOT, because the obvious misreading is costly:
       * models reach for it as a general file reader (observed: burning every tool round trying to
       * read SPEC.md / FEATURE.md through it, then hitting the cap with no answer written). It only
       * ever reads files SHIPPED INSIDE a skill bundle.
       */
      description:
        'Read supporting files bundled inside a skill (e.g. references/foo.md), for a skill you have loaded. ' +
        "Paths come from that skill's own instructions — do not guess at them. " +
        'ALWAYS request every resource you need in ONE call by passing them all in `paths` — each call is a ' +
        'slow round trip, and there is a hard cap on how many you get. ' +
        "This is NOT a filesystem: it cannot read the user's project files. The project's files are already " +
        'in your context under "Current Project Files"; there is no tool to read more of them.',

      /*
       * ---- Every field here is optional, and every one is validated in `execute`. ----
       *
       * NOT a style choice, and NOT laziness about schemas. A zod constraint on a tool argument is
       * enforced by the AI SDK BEFORE `execute` runs, and a violation throws
       * `InvalidToolArgumentsError` — which aborts the whole stream and kills the generation.
       *
       * We watched BOTH of this tool's original constraints do exactly that, on real edit turns:
       *   - `paths: z.array(z.string()).min(1)` → the model called it with `paths: []`
       *   - `skill: z.string()` (required)      → the model called `load_skill` with `{}`
       * Each one burned the user's tokens, left their file untouched, and put a zod dump in the chat.
       *
       * A tool argument the model can plausibly get wrong must be validated WHERE A BAD VALUE IS
       * RECOVERABLE — in `execute`, which returns a message the model reads and corrects on the next
       * step — not in the schema, where it is fatal. Constrain the schema only where a violation is
       * genuinely impossible.
       */
      parameters: z.object({
        skill: z.string().optional().describe('The skill that bundles the files.'),

        /*
         * A LIST, not a path. One-path-per-call made N resources cost N sequential LLM round trips —
         * and a round trip is not cheap: it re-prefills the entire (133K-token) prompt before the
         * model can so much as name the next file. We measured a generation that spent all six of its
         * tool rounds paging in a single skill's resources and had none left to answer with. Batching
         * collapses that to one round.
         */
        paths: z
          .array(z.string())
          .optional()
          .describe(
            'Every resource path you need from this skill, exactly as listed in its instructions. ' +
              'Pass them ALL at once rather than calling this tool repeatedly.',
          ),
      }),
      execute: async ({ skill, paths }) => {
        if (!skill) {
          return 'read_skill_resource needs a "skill" — the name of a skill you have already loaded.';
        }

        const version = await store.getActive(skill);

        if (!version) {
          return `No skill named "${skill}" exists.`;
        }

        if (!paths || paths.length === 0) {
          return (
            `You called read_skill_resource for "${skill}" without naming any paths, so there is nothing to read. ` +
            `You already have that skill's instructions — proceed with the task, and only call this again if you ` +
            `need one of its bundled resources by name.`
          );
        }

        const sections: string[] = [];
        const missing: string[] = [];

        for (const path of paths) {
          /*
           * Resolves strictly through the version's manifest by exact match — no path semantics at
           * all, which removes the entire traversal class of bugs rather than trying to filter for it.
           */
          const contents = await store.readResource(skill, path);

          if (contents === null) {
            missing.push(path);
            continue;
          }

          sections.push(`## ${path}\n\n${contents}`);
        }

        if (missing.length > 0) {
          logger.warn(`read_skill_resource: [${missing.join(', ')}] not in ${skill}'s manifest`);

          /*
           * Tell it to STOP, not just that it failed. A bare "not found" invites the model to try the
           * next plausible path, and a handful of those retries exhausts the tool-round cap. Report
           * misses ALONGSIDE the hits so a single bad path does not cost a whole extra round.
           */
          sections.push(
            `## Not found: ${missing.join(', ')}\n\n` +
              `These are not resources of skill "${skill}". Its bundled resources are: ` +
              `${version.resourcePaths.join(', ') || '(none — this skill bundles no files)'}.\n\n` +
              "Do not retry with a different path. If you were looking for a file in the user's PROJECT " +
              '(SPEC.md, source files, …), this tool cannot read it: the project files available to you ' +
              'are already in your context. Proceed with what you have.',
          );
        }

        logger.info(`read_skill_resource: ${skill} [${paths.join(', ')}] (${missing.length} missing)`);

        return sections.join('\n\n---\n\n');
      },
    }),
  };

  /*
   * The tool set contains exactly the capabilities that are still REACHABLE and NOT already satisfied.
   * Anything else is an invitation to thrash — see the note on `offerLoadSkill`.
   *
   * `load_skill` is genuinely OPTIONAL in the returned shape, and the type says so on purpose: a
   * caller that assumes it is always there is making the mistake this whole mechanism exists to stop.
   */
  const all = { ...loadSkill, ...rest };

  return (context.offerLoadSkill ? all : rest) as Partial<typeof loadSkill> & typeof rest;
}
