/**
 * Skills money/safety paths (spec/skills.md "Tests").
 *
 * Two guarantees under test:
 *  1. One malformed bundle can never take down the skill set (validation matrix + skip).
 *  2. `read_skill_resource` resolves ONLY through the manifest — no path traversal is reachable,
 *     because no path semantics exist in the lookup at all.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, validateSkill } from './frontmatter';
import { buildSkillsIndex } from './sync';
import { MAX_SKILL_LOADS } from '~/lib/.server/agent/tools';
import { FsSkillStore } from './store';

const VALID = `---
name: bt-spec
description: Creates a feature spec from a short idea.
---

Do the spec workflow.`;

describe('frontmatter parsing', () => {
  it('parses name, description, and body', () => {
    const parsed = parseFrontmatter(VALID);

    expect(parsed?.frontmatter.name).toBe('bt-spec');
    expect(parsed?.frontmatter.description).toBe('Creates a feature spec from a short idea.');
    expect(parsed?.body).toBe('Do the spec workflow.');
  });

  it('unquotes values — descriptions are routinely quoted because they contain colons', () => {
    const parsed = parseFrontmatter('---\nname: a\ndescription: "Use when: you need it."\n---\n\nBody');
    expect(parsed?.frontmatter.description).toBe('Use when: you need it.');
  });

  it('keeps extra keys (allowed-tools, license) without choking on them', () => {
    const parsed = parseFrontmatter(
      '---\nname: a\ndescription: d\nallowed-tools: Read, Grep, Bash(git switch:*)\n---\n\nB',
    );
    expect(parsed?.frontmatter['allowed-tools']).toBe('Read, Grep, Bash(git switch:*)');
  });

  it('returns null when there is no frontmatter at all', () => {
    expect(parseFrontmatter('# Just a heading\n\nbody')).toBeNull();
  });
});

describe('bundle validation matrix', () => {
  it('accepts a well-formed bundle', () => {
    expect(validateSkill('bt-spec', VALID).ok).toBe(true);
  });

  it.each([
    ['no frontmatter', 'bt-spec', 'just a body', /frontmatter/i],
    ['missing name', 'bt-spec', '---\ndescription: d\n---\n\nB', /name/i],
    ['missing description', 'bt-spec', '---\nname: bt-spec\n---\n\nB', /description/i],
    ['empty body', 'bt-spec', '---\nname: bt-spec\ndescription: d\n---\n', /empty/i],
    ['name does not match folder', 'bt-plan', VALID, /does not match/i],
    ['uppercase name', 'BtSpec', '---\nname: BtSpec\ndescription: d\n---\n\nB', /lowercase/i],
    ['underscored name', 'bt_spec', '---\nname: bt_spec\ndescription: d\n---\n\nB', /lowercase/i],
  ])('rejects %s', (_label, folder, source, reason) => {
    const result = validateSkill(folder, source);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(reason);
  });

  it('rejects an over-long description rather than blowing the prompt budget', () => {
    const source = `---\nname: a\ndescription: ${'x'.repeat(1100)}\n---\n\nB`;
    const result = validateSkill('a', source);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/1024/);
  });
});

describe('skills index', () => {
  const skill = (name: string, description: string) =>
    ({
      id: `sv_${name}`,
      name,
      description,
      sourceCommitSha: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
      bodyBytes: 1,
      resourcePaths: [],
      isActive: true,
      body: 'b',
    }) as const;

  /*
   * The index is part of the CACHED prompt prefix. If its bytes wobble between builds — say because
   * the skill order follows a directory listing — every generation pays full input rates instead of
   * cached rates. Stable bytes are a margin lever, not a cosmetic detail.
   */
  it('is byte-stable regardless of input order', () => {
    const a = buildSkillsIndex([skill('bt-spec', 'one'), skill('bt-plan', 'two')] as any);
    const b = buildSkillsIndex([skill('bt-plan', 'two'), skill('bt-spec', 'one')] as any);

    expect(a).toBe(b);
  });

  it('lists every skill with its description', () => {
    const index = buildSkillsIndex([skill('bt-spec', 'Creates a spec.')] as any);

    expect(index).toContain('**bt-spec**');
    expect(index).toContain('Creates a spec.');
  });

  it('degrades gracefully when nothing is synced', () => {
    expect(buildSkillsIndex([])).toMatch(/No skills/i);
  });

  /*
   * 🔴 The index is the ONLY thing that tells the model how to choose a skill, now that nothing routes
   * for it (2026-07-26). Two sentences in it are load-bearing money:
   *
   *   - "load them BEFORE you begin writing" is what the 29,173-token / six-round measurement was
   *     really about. A `load_skill` call is ~50 tokens; what cost tens of thousands was the model
   *     starting the artifact, wanting a skill mid-draft, and discarding the draft — at 5x input rate,
   *     over and over. Loading is cheap; INTERLEAVING is not.
   *   - the load limit, so the model spends its two slots deliberately rather than discovering the
   *     refusal by hitting it.
   *
   * Neither can be verified by any behavioural test we can run offline, and both fail silently and
   * expensively. Pinning the text is the only guard available.
   */
  it('tells the model to choose and load skills BEFORE it starts writing', () => {
    const index = buildSkillsIndex([skill('bt-spec', 'Creates a spec.')] as any);

    expect(index).toMatch(/before you begin writing/i);
    expect(index).toMatch(/do not interleave/i);
  });

  it('states the per-response load limit, and states the REAL one', () => {
    const index = buildSkillsIndex([skill('bt-spec', 'Creates a spec.')] as any);

    // Not a hardcoded number: it must track the budget the tool actually enforces.
    expect(index).toContain(`at most ${MAX_SKILL_LOADS} skills`);
  });
});

describe('skill store — manifest-only resource resolution', () => {
  let root: string;
  let store: FsSkillStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-store-'));
    store = new FsSkillStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const put = () =>
    store.put({
      name: 'bt-design',
      description: 'Design skill.',
      body: 'Design instructions.',
      sourceCommitSha: 'sha',
      resources: { 'references/3d-hero-scroll.md': 'HERO DOC' },
    });

  it('serves a resource listed in the manifest', async () => {
    const version = await put();
    await store.activate('bt-design', version.id);

    expect(await store.readResource('bt-design', 'references/3d-hero-scroll.md')).toBe('HERO DOC');
  });

  /*
   * Traversal is not "blocked" here — it is unreachable. The lookup is an exact-match key into a
   * manifest object, so `../../etc/passwd` is simply a key that does not exist, exactly like any
   * other typo. There is no filesystem path to escape from.
   */
  it('returns null for any path not in the manifest, traversal attempts included', async () => {
    const version = await put();
    await store.activate('bt-design', version.id);

    for (const attempt of [
      '../../../../etc/passwd',
      '/etc/passwd',
      'references/../../../secrets.env',
      './references/3d-hero-scroll.md',
      'references/3d-hero-scroll.md/../../x',
    ]) {
      expect(await store.readResource('bt-design', attempt), attempt).toBeNull();
    }
  });

  it('returns null for an unknown skill rather than throwing', async () => {
    expect(await store.readResource('nope', 'anything')).toBeNull();
  });

  it('rolls a skill back to a previous version', async () => {
    const v1 = await store.put({
      name: 'bt-spec',
      description: 'v1',
      body: 'ONE',
      sourceCommitSha: 'a',
      resources: {},
    });
    await store.activate('bt-spec', v1.id);

    const v2 = await store.put({
      name: 'bt-spec',
      description: 'v2',
      body: 'TWO',
      sourceCommitSha: 'b',
      resources: {},
    });
    await store.activate('bt-spec', v2.id);
    expect((await store.getActive('bt-spec'))?.body).toBe('TWO');

    await store.activate('bt-spec', v1.id);
    expect((await store.getActive('bt-spec'))?.body).toBe('ONE');
  });

  it('refuses to activate a version under the wrong skill name', async () => {
    const version = await put();
    await expect(store.activate('bt-spec', version.id)).rejects.toThrow(/belongs to/i);
  });
});
