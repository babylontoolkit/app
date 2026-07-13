/**
 * Synced skills, for the chat input's `/` autocomplete (SPEC §4.11, invocation path 1).
 *
 * Name + description only — the same progressive-disclosure surface the model gets from the index.
 * Skill BODIES are never served to the client: they are prompt content, and the client has no use
 * for them.
 */
import { type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { getSkillStore } from '~/lib/.server/skills/store';
import type { SkillSummary } from '~/lib/skills/slash';

export async function loader(_args: LoaderFunctionArgs) {
  const skills: SkillSummary[] = (await getSkillStore().listActive()).map((skill) => ({
    name: skill.name,
    description: skill.description,
  }));

  return new Response(JSON.stringify({ skills }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
