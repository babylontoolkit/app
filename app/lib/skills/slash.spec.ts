/**
 * Slash invocation parsing (SPEC §4.11).
 *
 * The failure that matters: mistaking ordinary prose or a file path for a skill invocation would
 * silently REPLACE the user's message with a skill body. So the parser has to be strict about what
 * counts as a command.
 */
import { describe, expect, it } from 'vitest';
import { getSlashAutocomplete, parseSlashInvocation, type SkillSummary } from './slash';

describe('parseSlashInvocation', () => {
  it('parses a skill name and its task', () => {
    expect(parseSlashInvocation('/bt-spec add a lap timer')).toEqual({ name: 'bt-spec', args: 'add a lap timer' });
  });

  it('parses a bare invocation with no task', () => {
    expect(parseSlashInvocation('/bt-spec')).toEqual({ name: 'bt-spec', args: '' });
  });

  it('keeps multi-line tasks intact', () => {
    expect(parseSlashInvocation('/bt-plan line one\nline two')?.args).toBe('line one\nline two');
  });

  it('ignores a slash that is not at the start — that is prose or a path, not a command', () => {
    expect(parseSlashInvocation('please edit /src/main.ts')).toBeNull();
    expect(parseSlashInvocation('use one and/or the other')).toBeNull();
  });

  it('ignores paths, which is why the name must match the skill-name grammar', () => {
    expect(parseSlashInvocation('/src/pages/Home.tsx needs a hero')).toBeNull();
    expect(parseSlashInvocation('/Users/me/thing')).toBeNull();
  });
});

describe('getSlashAutocomplete', () => {
  const skills: SkillSummary[] = [
    { name: 'bt-spec', description: 'spec' },
    { name: 'bt-plan', description: 'plan' },
    { name: 'bt-prototype', description: 'prototype' },
  ];

  it('opens on a bare slash and offers everything', () => {
    expect(getSlashAutocomplete('/', skills)?.matches).toHaveLength(3);
  });

  it('filters as the user types', () => {
    expect(getSlashAutocomplete('/bt-p', skills)?.matches.map((s) => s.name)).toEqual(['bt-plan', 'bt-prototype']);
  });

  it('ranks prefix matches above mere substring matches', () => {
    const matches = getSlashAutocomplete('/plan', [
      { name: 'bt-plan', description: '' },
      { name: 'plan-it', description: '' },
    ])?.matches;

    expect(matches?.map((s) => s.name)).toEqual(['plan-it', 'bt-plan']);
  });

  it('closes once the command is complete and the user starts typing the task', () => {
    expect(getSlashAutocomplete('/bt-spec add a timer', skills)).toBeNull();
  });

  it('never opens for ordinary prose', () => {
    expect(getSlashAutocomplete('add a lap timer', skills)).toBeNull();
  });
});
