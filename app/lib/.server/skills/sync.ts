/**
 * Skills sync (SPEC §4.11, spec/skills.md).
 *
 * Fetches `babylontoolkit/skills` at `main`, validates each agentskills.io bundle, stores a new
 * version per skill, and rebuilds the index text that doc-sync bakes into the system prompt.
 *
 * Failure guarantees (the whole point of this design):
 *  - One invalid bundle is SKIPPED with a warning. It never blocks the other skills.
 *  - A wholesale fetch failure throws, and the caller keeps the PREVIOUS skill set + prompt active.
 *    A broken push to the skills repo can never take down generation.
 */
import { createScopedLogger } from '~/utils/logger';
import { githubJson, githubText } from '~/lib/.server/prompt/github';
import { SKILLS_REPO } from '~/lib/.server/prompt/sources';
import { parseSkillDependencies, validateSkill } from './frontmatter';
import { isExcludedSkill } from './exclusions';
import { getSkillStore, type SkillVersion } from './store';
import { MAX_SKILL_LOADS } from '~/lib/.server/agent/tools';

const logger = createScopedLogger('skills-sync');

/** Files we never treat as skill resources. */
const IGNORED_RESOURCE = (p: string) => p.startsWith('.') || p.endsWith('/.DS_Store');

export interface SyncResult {
  sourceCommitSha: string;
  synced: string[];
  skipped: Array<{ name: string; reason: string }>;
  skillsIndex: string;
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
}

async function fetchRaw(sha: string, filePath: string, token?: string): Promise<string> {
  // Pin every file read to the tree SHA — a push mid-sync can't give us a torn, half-updated bundle.
  return githubText(`https://raw.githubusercontent.com/${SKILLS_REPO}/${sha}/${filePath}`, token);
}

/**
 * The index text baked into the cached system prompt: name + description per active skill.
 *
 * This is the ONLY thing the model sees about a skill until it calls `load_skill` — which is exactly
 * the agentskills.io progressive-disclosure contract. It also means the `description` IS the trigger:
 * a skill that never auto-fires almost always has a weak description. Fix it in the repo and resync.
 *
 * Sorted by name and rendered deterministically: unstable bytes here would bust the prompt cache on
 * every generation, which is a direct hit to margin.
 */
export function buildSkillsIndex(skills: SkillVersion[]): string {
  if (skills.length === 0) {
    return '# Available Skills\n\nNo skills are currently available.';
  }

  const rows = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => `- **${skill.name}** — ${skill.description.replace(/\s+/g, ' ').trim()}`);

  return [
    '# Available Skills',
    '',
    'Call `load_skill(name)` to load one of these before working in its domain.',
    'The user can also invoke one directly by typing `/<name> <task>` in chat.',
    '',

    /*
     * 🔴 "DECIDE FIRST, THEN WRITE" is the load-bearing sentence, and it is what the 29,173-token
     * six-round measurement was actually about (`preload-skills.ts`). A `load_skill` call costs ~50
     * tokens; what cost tens of thousands was the model beginning the artifact, realising mid-draft
     * that it wanted a skill, calling for it, and discarding the draft — at 5x input rate, repeatedly.
     * Loading is cheap; INTERLEAVING loading with writing is not.
     */
    'Decide which skills you need and load them BEFORE you begin writing code, files or an artifact.',
    'Loading is cheap; abandoning a half-written answer to load one is not. Do not interleave the two.',
    `You may load at most ${MAX_SKILL_LOADS} skills in one response, so choose by the descriptions below.`,
    '',
    ...rows,
  ].join('\n');
}

export async function syncSkills(githubToken?: string): Promise<SyncResult> {
  const store = getSkillStore();

  logger.info(`Syncing skills from ${SKILLS_REPO}@main`);

  const head = await githubJson<{ sha: string }>(
    `https://api.github.com/repos/${SKILLS_REPO}/commits/main`,
    githubToken,
  );

  // One recursive tree call gives us every path in the repo — cheaper and more atomic than walking.
  const tree = await githubJson<{ tree: TreeEntry[]; truncated: boolean }>(
    `https://api.github.com/repos/${SKILLS_REPO}/git/trees/${head.sha}?recursive=1`,
    githubToken,
  );

  if (tree.truncated) {
    throw new Error('skills-sync: repo tree was truncated by the GitHub API — cannot sync reliably');
  }

  // Group blobs under `skills/<name>/…` by skill.
  const bundles = new Map<string, string[]>();

  for (const entry of tree.tree) {
    if (entry.type !== 'blob') {
      continue;
    }

    const match = /^skills\/([^/]+)\/(.+)$/.exec(entry.path);

    if (!match) {
      continue;
    }

    const [, name, relative] = match;

    if (IGNORED_RESOURCE(relative)) {
      continue;
    }

    const existing = bundles.get(name) ?? [];
    existing.push(relative);
    bundles.set(name, existing);
  }

  const synced: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const [name, files] of [...bundles.entries()].sort()) {
    /*
     * Platform-excluded (exclusions.ts): skip before any fetch, so the bundle's bytes are never
     * even downloaded. The store's read seam enforces the same rule for versions synced BEFORE the
     * skill was excluded — this branch just keeps the sync honest about what it brought in.
     */
    if (isExcludedSkill(name)) {
      logger.info(`Skipping skill "${name}": excluded on this platform (see skills/exclusions.ts)`);
      skipped.push({ name, reason: 'excluded on this platform' });
      continue;
    }

    if (!files.includes('SKILL.md')) {
      skipped.push({ name, reason: 'no SKILL.md' });
      continue;
    }

    try {
      const source = await fetchRaw(head.sha, `skills/${name}/SKILL.md`, githubToken);
      const result = validateSkill(name, source);

      if (!result.ok) {
        // One bad bundle must not block the set.
        logger.warn(`Skipping skill "${name}": ${result.reason}`);
        skipped.push({ name, reason: result.reason });

        continue;
      }

      const resources: Record<string, string> = {};

      for (const relative of files.filter((f) => f !== 'SKILL.md')) {
        resources[relative] = await fetchRaw(head.sha, `skills/${name}/${relative}`, githubToken);
      }

      const version = await store.put({
        name,
        description: result.skill.frontmatter.description,
        body: result.skill.body,

        /* `dependencies: bt-design` — the skills repo declares what a skill is built on (§4.11). */
        dependencies: parseSkillDependencies(result.skill.frontmatter.dependencies),
        sourceCommitSha: head.sha,
        resources,
      });

      await store.activate(name, version.id);
      synced.push(name);
    } catch (error) {
      logger.warn(`Skipping skill "${name}": ${(error as Error).message}`);
      skipped.push({ name, reason: (error as Error).message });
    }
  }

  const skillsIndex = buildSkillsIndex(await store.listActive());

  logger.info(`Synced ${synced.length} skills (${skipped.length} skipped) at ${head.sha.slice(0, 8)}`);

  return { sourceCommitSha: head.sha, synced, skipped, skillsIndex };
}

/** The index for whatever is already stored — used when rebuilding a prompt without resyncing. */
export async function currentSkillsIndex(): Promise<string> {
  return buildSkillsIndex(await getSkillStore().listActive());
}
