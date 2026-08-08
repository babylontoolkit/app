/**
 * The project's `CLAUDE.md` as a system block (SPEC §4.2).
 *
 * Three classes of failure, all silent. **Authority**: the file is promoted but the model is not told
 * what outranks what — so a `CLAUDE.md` imported from another host has it scaffold a second project
 * over the one that exists, or write where the file zones forbid. **Duplication**: the block is added
 * but the file is not removed from the file context, so every turn pays for the same bytes twice,
 * forever, and the two copies disagree the moment it is edited. **Over-suppression** (2026-08-08): the
 * precedence text goes on describing a capability the platform no longer lacks, and neutralises a
 * user instruction that would now work — see the `load_reference` test below.
 */
import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/.server/llm/constants';
import { createFilesContext } from '~/lib/.server/llm/utils';
import { SANDBOX_ROOTS } from '~/lib/common/sandbox-paths';
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
   * What still has to be inert: a host's SETUP steps — clone this starter, run the installer, copy
   * skills into `.claude/skills`. Obeyed here they scaffold a second project over the one that exists.
   */
  it('tells the model to disregard SETUP directives aimed at other hosts', () => {
    expect(built.block).toMatch(/different tool or host/i);
    expect(built.block).toMatch(/already scaffolded/i);
    expect(built.block).toMatch(/host-setup/i);
  });

  /*
   * 🔴 And what must NOT be inert any more. The single most common real `CLAUDE.md` for this stack is
   * the Babylon Toolkit persona — "you must always fetch and read the Agent Reference at <url> before
   * doing anything else" — and until 2026-08-08 this block told the model to disregard exactly that,
   * on the grounds that the docs were already in the prompt and there was no fetch tool. Phase 2 made
   * both false (`load_reference` serves the docs on demand; `web_fetch` reaches the open web), so the
   * platform was suppressing the user's own instruction to protect against a dead failure mode.
   *
   * Nothing throws when this regresses — the model just skips the document it was told to read and
   * writes worse code. Hence an assertion rather than a comment.
   */
  it('🔴 tells the model to FOLLOW an instruction to read the Agent Reference, via load_reference', () => {
    expect(built.block).toMatch(/load_reference/);
    expect(built.block).toMatch(/agent reference/i);

    // The old wording, in either of its two halves. Neither may come back.
    expect(built.block).not.toMatch(/already in this prompt/i);
    expect(built.block).not.toMatch(/fetching a URL or an "Agent/i);
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

/**
 * PROMOTION IS KEYED ON THE PROJECT-RELATIVE PATH, NOT ON ONE PROVIDER'S ROOT (T7b, SPEC §8).
 *
 * `instructionsKey` used to strip a `/home/project/` literal. On a CodeSandbox build the map is keyed
 * under `/project/workspace`, the strip matched nothing, and `CLAUDE.md` was simply never FOUND — no
 * Project Instructions block, no `MAX_INSTRUCTIONS_CHARS` cap, no precedence statement. The §4.2 money
 * path back to its pre-2026-07-16 state on one provider and correct on the other, with nothing throwing
 * on either. The file still reached the model as an anonymous file-context entry, so even the token
 * count barely moved — which is exactly the §4.2.8 failure shape (cheaper-looking, quietly worse).
 *
 * Root-ONLY promotion is asserted under every root too: it is a real property (a nested file addresses
 * a subtree, and merging every one of them puts unbounded user text in the prompt on every turn), and a
 * root-blind "does the path END with CLAUDE.md" fix would pass the promotion test while breaking it.
 */
describe.each(SANDBOX_ROOTS)('project instructions under the %s root', (root) => {
  const under = (extra: FileMap = {}): FileMap => ({
    [`${root}/package.json`]: file('{"name":"game"}'),
    [`${root}/src/pages/Home.tsx`]: file('export const Home = () => null;'),
    ...extra,
  });

  it('promotes the root CLAUDE.md', () => {
    const files = under({ [`${root}/CLAUDE.md`]: file('# House rules\n\nUse tabs.') });
    const built = buildProjectInstructions(files)!;

    expect(instructionsKey(files)).toBe(`${root}/CLAUDE.md`);
    expect(built.key).toBe(`${root}/CLAUDE.md`);
    expect(built.block).toContain('Use tabs.');
    expect(built.block).toMatch(/non-negotiables/i);
  });

  it('still ignores a NESTED CLAUDE.md — root-only is the rule, not an artefact of the prefix', () => {
    const files = under({ [`${root}/src/CLAUDE.md`]: file('# nested') });

    expect(instructionsKey(files)).toBeNull();
    expect(buildProjectInstructions(files)).toBeNull();
  });

  it('still ignores files that merely look like it', () => {
    const files = under({
      [`${root}/AGENTS.md`]: file('# for a different tool'),
      [`${root}/CLAUDE.md.bak`]: file('# old'),
    });

    expect(instructionsKey(files)).toBeNull();
  });

  /*
   * Moved, not copied. The lift is by KEY, so a key found under one root must be the key the proxy can
   * delete — otherwise the block is added, the file stays, and every turn pays for it twice forever.
   */
  it('reports a key the caller can lift, leaving no second copy in the file context', () => {
    const files = under({ [`${root}/CLAUDE.md`]: file('# House rules\n\nUse tabs.') });
    const built = buildProjectInstructions(files)!;

    const { [built.key]: _lifted, ...rest } = files;
    const context = createFilesContext(rest, true);

    expect(context).not.toContain('Use tabs.');
    expect(context).toContain('src/pages/Home.tsx');
  });

  it('still caps a huge file under this root', () => {
    const built = buildProjectInstructions(under({ [`${root}/CLAUDE.md`]: file('x'.repeat(50_000)) }))!;

    expect(built.truncated).toBe(true);
    expect(built.block).toContain('truncated');
  });
});
