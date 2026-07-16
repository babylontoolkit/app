/**
 * The project's `CLAUDE.md` as a system block (SPEC §4.2).
 *
 * Two classes of failure, both silent. **Authority**: the file is promoted but the model is not told
 * what outranks what — so a `CLAUDE.md` imported from another host tells it to fetch a URL it cannot
 * reach, or to write where the file zones forbid, and the project quietly breaks. **Duplication**: the
 * block is added but the file is not removed from the file context, so every turn pays for the same
 * bytes twice, forever, and the two copies disagree the moment it is edited.
 */
import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/.server/llm/constants';
import { createFilesContext } from '~/lib/.server/llm/utils';
import { buildProjectInstructions, instructionsKey, MAX_INSTRUCTIONS_CHARS } from './project-instructions';

const file = (content: string, isBinary = false) => ({ type: 'file' as const, content, isBinary });

const project = (extra: FileMap = {}): FileMap => ({
  '/home/project/package.json': file('{"name":"game"}'),
  '/home/project/src/pages/Home.tsx': file('export const Home = () => null;'),
  ...extra,
});

describe('finding the project instructions', () => {
  it('finds a root CLAUDE.md', () => {
    const files = project({ '/home/project/CLAUDE.md': file('# House rules') });
    expect(instructionsKey(files)).toBe('/home/project/CLAUDE.md');
  });

  it('returns null when the project has none', () => {
    expect(buildProjectInstructions(project())).toBeNull();
    expect(buildProjectInstructions(undefined)).toBeNull();
  });

  /*
   * Root only. A nested file addresses a subtree, and merging every one of them would put unbounded
   * user text in the system prompt on every turn.
   */
  it('ignores a nested CLAUDE.md', () => {
    expect(instructionsKey(project({ '/home/project/src/CLAUDE.md': file('# nested') }))).toBeNull();
  });

  it('ignores files that merely look like it', () => {
    const files = project({
      '/home/project/AGENTS.md': file('# for a different tool'),
      '/home/project/docs/CLAUDE.md': file('# docs'),
      '/home/project/CLAUDE.md.bak': file('# old'),
    });
    expect(instructionsKey(files)).toBeNull();
  });

  it('treats an empty or whitespace-only file as no instructions', () => {
    expect(buildProjectInstructions(project({ '/home/project/CLAUDE.md': file('') }))).toBeNull();
    expect(buildProjectInstructions(project({ '/home/project/CLAUDE.md': file('   \n\n  ') }))).toBeNull();
  });

  it('never reads a binary as instructions', () => {
    expect(instructionsKey(project({ '/home/project/CLAUDE.md': file('AAAA', true) }))).toBeNull();
  });
});

describe('the instructions block', () => {
  const built = buildProjectInstructions(project({ '/home/project/CLAUDE.md': file('# House rules\n\nUse tabs.') }))!;

  it('carries the file verbatim, fenced and attributed', () => {
    expect(built.block).toContain('<project_instructions path="CLAUDE.md">');
    expect(built.block).toContain('# House rules\n\nUse tabs.');
    expect(built.block).toContain('</project_instructions>');
    expect(built.truncated).toBe(false);
  });

  it('states the precedence explicitly — the platform first, then this file, then defaults', () => {
    /*
     * Without this, a CLAUDE.md that says "put game code in src/babylon/classes" is obeyed and the
     * project stops running. `CLAUDE.md` must never be able to waive a rule the runtime depends on.
     */
    expect(built.block).toMatch(/non-negotiables/i);
    expect(built.block).toMatch(/cannot waive/i);
    expect(built.block).toMatch(/SPEC\.md/);
  });

  /*
   * The concrete case this exists for: a CLAUDE.md written for Lovable/Claude Code says "always fetch
   * the Agent Reference at <url> before doing anything else; if the fetch fails, stop and tell the
   * user". Obeyed here, the agent stalls on turn one — there is no network at generation time.
   */
  it('tells the model to disregard directives aimed at other hosts', () => {
    expect(built.block).toMatch(/no network access/i);
    expect(built.block).toMatch(/already scaffolded/i);
    expect(built.block).toMatch(/host-setup/i);
  });

  it('reports the file-map key so the caller can lift it out of the file context', () => {
    expect(built.key).toBe('/home/project/CLAUDE.md');
  });

  it('caps a huge file rather than paying for it on every turn, and says that it did', () => {
    const huge = buildProjectInstructions(project({ '/home/project/CLAUDE.md': file('x'.repeat(50_000)) }))!;

    expect(huge.truncated).toBe(true);
    expect(huge.block.length).toBeLessThan(MAX_INSTRUCTIONS_CHARS + 2000);
    expect(huge.block).toContain('truncated');
  });
});

/**
 * The duplication guard, asserted the way the proxy actually does it: lift the key out of the map, then
 * build the file context from what remains. If this regresses, nothing throws — the bill just doubles
 * for that file on every turn of every conversation, and an edit leaves two disagreeing copies in front
 * of the model.
 */
describe('one copy, never two', () => {
  it('the file context no longer carries CLAUDE.md once it has been lifted', () => {
    const files = project({ '/home/project/CLAUDE.md': file('# House rules\n\nUse tabs.') });
    const built = buildProjectInstructions(files)!;

    const { [built.key]: _lifted, ...rest } = files;
    const context = createFilesContext(rest, true);

    expect(context).not.toContain('CLAUDE.md');
    expect(context).not.toContain('Use tabs.');

    // ...and the rest of the project is untouched.
    expect(context).toContain('src/pages/Home.tsx');
  });

  it('leaves the file context alone when there is no CLAUDE.md', () => {
    const files = project();
    expect(buildProjectInstructions(files)).toBeNull();
    expect(createFilesContext(files, true)).toContain('package.json');
  });
});
