/**
 * Minimal YAML frontmatter parser + agentskills.io bundle validation (SPEC §4.11, spec/skills.md).
 *
 * Deliberately NOT a YAML library. agentskills frontmatter is a flat map of scalars
 * (`name`, `description`, `allowed-tools`, …); supporting the full YAML grammar here would add a
 * dependency and an attack surface for zero benefit. Anything this parser cannot represent is a
 * bundle we should reject rather than half-understand.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: string;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;

  /** SKILL.md with the frontmatter block stripped — the instructions handed to the model. */
  body: string;
}

export type ValidationResult = { ok: true; skill: ParsedSkill } | { ok: false; reason: string };

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/** Strip one layer of matching quotes, if present. */
function unquote(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function parseFrontmatter(source: string): ParsedSkill | null {
  // Tolerate a leading BOM/blank lines, then require the opening `---` on its own line.
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^\s*---\n([\s\S]*?)\n---\n?/.exec(text);

  if (!match) {
    return null;
  }

  const frontmatter: Record<string, string> = {};
  let lastKey: string | null = null;

  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);

    if (kv) {
      lastKey = kv[1];
      frontmatter[lastKey] = unquote(kv[2]);
      continue;
    }

    // A continuation line (YAML folded scalar) — append to the previous key.
    if (lastKey && /^\s+\S/.test(line)) {
      frontmatter[lastKey] = `${frontmatter[lastKey]} ${line.trim()}`.trim();
      continue;
    }

    // Anything else (nested maps, sequences) is outside what we claim to support.
    return null;
  }

  return {
    frontmatter: frontmatter as SkillFrontmatter,
    body: text.slice(match[0].length).trim(),
  };
}

/**
 * How many skills one skill may declare as prerequisites.
 *
 * A bound on a value that arrives from an EXTERNAL repository. Each dependency is a 15–25KB body
 * inlined into the cached prefix of a turn the user did not ask to pay extra for, so a bundle
 * declaring eight of them would quietly multiply the cost of invoking it.
 */
export const MAX_SKILL_DEPENDENCIES = 2;

/**
 * 🔴 A SKILL MAY DECLARE THE SKILLS IT IS BUILT ON — `dependencies: bt-design` (2026-08-14).
 *
 * `bt-landing`'s own body opens with *"Prerequisite — load bt-design FIRST, before anything else…
 * call `load_skill('bt-design')`"*, and on a live `/bt-landing` run the model simply did not. That is
 * this codebase's oldest recurring lesson — **prose does not stop, or start, a model** (`protocol-strip`,
 * the `load_skill` thrash, the "ALREADY LOADED" heading it ignored five times) — so the prerequisite
 * has to be satisfied by the pipeline rather than requested of the model.
 *
 * Read from FRONTMATTER, never from a table in this repo. Skills are authored in
 * `babylontoolkit/skills` and this codebase only consumes them: a hardcoded `bt-landing → bt-design`
 * edge here would be a second copy of a fact that lives there, free to go stale silently the day the
 * skill changes — the two-writers shape this repo keeps rediscovering. It is also why the 2026-07-26
 * rewrite deleted the keyword router: a new skill must never need a TypeScript edit to work.
 *
 * Absent or unparseable → no dependencies, i.e. exactly today's behaviour. Accepts a comma- or
 * space-separated list (`dependencies: bt-design, bt-copycat`), since the frontmatter parser is
 * deliberately scalar-only and cannot represent a YAML sequence.
 */
export function parseSkillDependencies(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  const names: string[] = [];

  for (const token of raw.split(/[,\s]+/)) {
    const name = unquote(token).trim();

    /*
     * Same validation as a skill's own `name`, and it is a WALL, not tidiness: this string reaches
     * `getActive(name)`, which resolves an object-store key. A `../` here is a path the store was
     * never asked to serve. Anything unrecognised is dropped rather than rejected — one malformed
     * entry must not stop a skill loading (spec/skills.md §2).
     */
    if (!name || name.length > MAX_NAME || !NAME_PATTERN.test(name) || names.includes(name)) {
      continue;
    }

    names.push(name);

    if (names.length === MAX_SKILL_DEPENDENCIES) {
      break;
    }
  }

  return names;
}

/**
 * Validate one bundle against the agentskills.io contract.
 *
 * An invalid bundle is SKIPPED with a warning, never fatal: one bad skill in the repo must not take
 * down the whole skill set (spec/skills.md §2).
 */
export function validateSkill(folderName: string, source: string): ValidationResult {
  const parsed = parseFrontmatter(source);

  if (!parsed) {
    return { ok: false, reason: 'missing or unparseable YAML frontmatter' };
  }

  const { name, description } = parsed.frontmatter;

  if (!name) {
    return { ok: false, reason: 'frontmatter is missing `name`' };
  }

  if (name.length > MAX_NAME) {
    return { ok: false, reason: `name exceeds ${MAX_NAME} chars` };
  }

  if (!NAME_PATTERN.test(name)) {
    return { ok: false, reason: `name "${name}" must be lowercase alphanumeric with single hyphens` };
  }

  if (name !== folderName) {
    return { ok: false, reason: `name "${name}" does not match its folder "${folderName}"` };
  }

  if (!description?.trim()) {
    return { ok: false, reason: 'frontmatter is missing `description`' };
  }

  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, reason: `description exceeds ${MAX_DESCRIPTION} chars` };
  }

  if (!parsed.body.trim()) {
    return { ok: false, reason: 'SKILL.md body is empty' };
  }

  return { ok: true, skill: parsed };
}
