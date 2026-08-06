/**
 * Skills excluded from THIS platform (SPEC §4.11, spec/skills.md §"Platform-excluded skills").
 *
 * Some skills in `babylontoolkit/skills` are authored for native-client hosts (Claude Code, VS Code
 * agent plugins) and depend on capabilities the App Builder's server-side tool loop does not have.
 * The canonical case is `bt-gauntlet` (owner decision, 2026-08-05): its Gauntlet Loop requires
 * subagent fan-out (fresh-context critics), running-game evidence (browser screenshots captured into
 * `evidence/`), and blind A/B against reference media — none of which exist here (the loop offers
 * skill/media/MCP/web tools, bounded at `MAX_TOOL_ROUNDS`, and binaries are opaque to the model).
 * Syncing it anyway would advertise a skill whose every "PASS" is self-graded narration — the exact
 * failure the skill's own instructions forbid. The owner runs it from Claude Code against a
 * GitHub-synced clone of the project instead.
 *
 * This is NOT a routing table (`skill-selection.spec.ts`'s ban): it never picks a skill for a turn.
 * It is a capability decision — "this skill cannot run on this host" — enforced where the skill set
 * is DEFINED, so the model never sees the name at all.
 *
 * One rule, one place: the store's read seam (`getActive` / `listActive` / `readResource`) AND sync
 * both consult `isExcludedSkill`. The store-side check is load-bearing, not belt-and-braces — a
 * deployed store may already hold a synced version of an excluded skill, and a sync-time skip alone
 * would leave that version active, indexed, and loadable.
 *
 * `SKILLS_EXCLUDE` (comma-separated names) REPLACES the default list when set — replacement, not
 * merge, because two writers of one list is the drift this repo keeps rediscovering, and an operator
 * who sets the var is taking ownership of the whole list. Note `env()` collapses an empty string to
 * unset, so "no exclusions" is expressed by setting it to a name no skill has (e.g. `none`).
 */
import { env } from '~/lib/.server/env';

/** Skills that must never be servable on the hosted platform. Baked default; see header. */
export const DEFAULT_EXCLUDED_SKILLS: readonly string[] = ['bt-gauntlet'];

/**
 * The effective exclusion set. Read through the standard env door with no loader context — the
 * skill store has none (it is reached from the tool loop and sync, not from a route), so the
 * override comes from the process environment (SSM → container env in deploys, DEPLOY.md).
 */
export function excludedSkillNames(): Set<string> {
  const raw = env(undefined, 'SKILLS_EXCLUDE');

  if (raw === undefined) {
    return new Set(DEFAULT_EXCLUDED_SKILLS);
  }

  return new Set(
    raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function isExcludedSkill(name: string): boolean {
  return excludedSkillNames().has(name);
}
