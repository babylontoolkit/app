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
