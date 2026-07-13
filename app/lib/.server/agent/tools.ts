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

const logger = createScopedLogger('agent-tools');

/** Tool rounds per generation. On cap, the model proceeds with whatever it has loaded. */
export const MAX_TOOL_ROUNDS = 6;

export interface SkillToolContext {
  /** Skills loaded during this generation — recorded on the `generations` row (§4.11 metrics). */
  loaded: Set<string>;
}

export function createSkillTools(context: SkillToolContext) {
  const store = getSkillStore();

  return {
    load_skill: tool({
      description:
        'Load the full instructions for a skill listed in the Available Skills index. ' +
        "Call this before implementing anything in that skill's domain.",
      parameters: z.object({
        name: z.string().describe('The skill name exactly as it appears in the Available Skills index.'),
      }),
      execute: async ({ name }) => {
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
        logger.info(`load_skill: ${name} (${skill.bodyBytes} bytes)`);

        const resources = skill.resourcePaths.length
          ? `\n\nBundled resources (read with read_skill_resource):\n${skill.resourcePaths
              .map((p) => `- ${p}`)
              .join('\n')}`
          : '';

        return `# Skill: ${skill.name}\n\n${skill.body}${resources}`;
      },
    }),

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
      parameters: z.object({
        skill: z.string().describe('The skill that bundles the files.'),

        /*
         * A LIST, not a path. One-path-per-call made N resources cost N sequential LLM round trips —
         * and a round trip is not cheap: it re-prefills the entire (133K-token) prompt before the
         * model can so much as name the next file. We measured a generation that spent all six of its
         * tool rounds paging in a single skill's resources and had none left to answer with. Batching
         * collapses that to one round.
         */
        paths: z
          .array(z.string())
          .min(1)
          .describe(
            'Every resource path you need from this skill, exactly as listed in its instructions. ' +
              'Pass them ALL at once rather than calling this tool repeatedly.',
          ),
      }),
      execute: async ({ skill, paths }) => {
        const version = await store.getActive(skill);

        if (!version) {
          return `No skill named "${skill}" exists.`;
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
}
