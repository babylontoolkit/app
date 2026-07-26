/**
 * `/slash` invocation, end to end through the REAL resolver and a real skill store (SPEC §4.11).
 *
 * This is the regression test for a silent, total failure of the headline feature of the skills
 * subsystem: **every `/slash` invocation the product ever served was dropped.** The client wraps each
 * user message in `[Model: …]\n\n[Provider: …]\n\n` (upstream's BYOK transport, consumed only by the
 * fail-closed `/api/chat` path), and `parseSlashInvocation` anchors on a leading `/`. So the match
 * failed, `resolveSlashInvocation` returned null one branch above its own unknown-skill warning, and
 * the skill was never force-loaded — no error, no log, nothing in `skillsLoaded`.
 *
 * What the user saw (measured, `gen_ms0vcgq8_68vf4c`, 2026-07-25): the model answered
 * *"I'll load the bt-spec skill workflow so I follow it precisely, then draft the spec."* — 83 chars of
 * text on 524 output tokens — and stopped. It had no `load_skill` tool (a preloaded turn closes the
 * loop, §4.2.8) and no skill body, so there was nothing it could do. `finishReason: 'stop'`,
 * `status: 'completed'`, **316 credits charged for a promise**.
 *
 * The tests therefore assert on the ENVELOPED message — the only form the server ever actually
 * receives. A test that hand-feeds a bare `/bt-spec …` passes against the broken code, which is
 * precisely why this bug survived a green suite.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { resolveSlashInvocation } from './proxy';
import { setSkillStore, type SkillStore, type SkillVersion } from '~/lib/.server/skills/store';
import type { Message } from 'ai';

/** Byte-for-byte what `Chat.client.tsx` posts. */
function clientEnvelope(body: string, model = 'claude-opus-4-8', provider = 'KIE'): string {
  return `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${body}`;
}

function userMessage(content: string): Message {
  // The client sets BOTH, from the same string — so must the fixture, or `parts` drift goes unseen.
  return { id: '1', role: 'user', content, parts: [{ type: 'text', text: content }] } as Message;
}

const BT_SPEC: SkillVersion = {
  id: 'sv_bt-spec_test',
  name: 'bt-spec',
  description: 'Creates a feature spec file and branch from a short idea.',
  sourceCommitSha: 'abc123',
  createdAt: '2026-07-25T00:00:00.000Z',
  bodyBytes: 20,
  resourcePaths: [],
  isActive: true,
  body: '# bt-spec\n\nWrite the spec to `_specs/<feature>_spec.md`.',
};

beforeEach(() => {
  setSkillStore({
    getActive: async (name: string) => (name === BT_SPEC.name ? BT_SPEC : null),
  } as unknown as SkillStore);
});

afterEach(() => {
  setSkillStore(undefined);
  vi.restoreAllMocks();
});

describe('resolveSlashInvocation', () => {
  it('resolves the exact message that failed the investor demo', async () => {
    const resolved = await resolveSlashInvocation([
      userMessage(clientEnvelope('/bt-spec add user authentication with login and signup pages')),
    ]);

    expect(resolved?.skillName).toBe('bt-spec');
    expect(resolved?.skillBlock).toContain('# Invoked Skill: bt-spec');
    expect(resolved?.skillBlock).toContain('Write the spec to `_specs/<feature>_spec.md`.');
  });

  /*
   * 🔴 THE REWRITTEN TASK MUST STILL NAME THE SKILL.
   *
   * The first draft of this test asserted the content was the ARGS ALONE — it was written to match
   * what the code did, and the code had never run (the envelope bug meant `resolveSlashInvocation`
   * returned null every time). So it pinned a behaviour nobody had observed, and when the parse fix
   * switched the path on, the very first live `/bt-spec add a pause menu…` BUILT a pause menu
   * instead of writing a spec: the model's last user message was a bare imperative, and a system
   * block saying "follow the skill" does not outrank the user's own turn.
   *
   * The args of a planning skill read as a build order. The command has to survive the rewrite.
   */
  it('names the SKILL in the rewritten task, not just the args, with the envelope gone', async () => {
    const resolved = await resolveSlashInvocation([
      userMessage(clientEnvelope('/bt-spec add user authentication with login and signup pages')),
    ]);

    const content = String(resolved?.messages.at(-1)?.content);

    expect(content, 'the brief itself survives').toContain('add user authentication with login and signup pages');
    expect(content, 'and so does which skill is running it').toContain('bt-spec');
    expect(content).not.toContain('[Model:');
  });

  it('drops `parts`, so the AI SDK cannot prefer them over the rewritten task', async () => {
    const resolved = await resolveSlashInvocation([userMessage(clientEnvelope('/bt-spec add auth'))]);

    expect((resolved?.messages.at(-1) as { parts?: unknown }).parts).toBeUndefined();
  });

  it('CARRIES a modified-files artifact through the rewrite — the user edited those files', async () => {
    const artifact =
      '<boltArtifact id="m" title="edits"><boltAction type="file" filePath="src/a.ts">x</boltAction></boltArtifact>';

    const resolved = await resolveSlashInvocation([userMessage(clientEnvelope(`${artifact}/bt-spec add auth`))]);

    expect(resolved?.skillName).toBe('bt-spec');

    // The artifact still leads (the model reads it as the user's edits), and the task follows it.
    expect(String(resolved?.messages.at(-1)?.content).startsWith(artifact)).toBe(true);
    expect(resolved?.messages.at(-1)?.content).toContain('add auth');
    expect(resolved?.messages.at(-1)?.content).toContain('bt-spec');
  });

  it('runs the skill with no task when the user typed the bare command', async () => {
    const resolved = await resolveSlashInvocation([userMessage(clientEnvelope('/bt-spec'))]);

    expect(resolved?.skillName).toBe('bt-spec');
    expect(resolved?.messages.at(-1)?.content).toContain('Run the bt-spec skill');
  });

  it('WARNS and passes through when the skill is genuinely unknown', async () => {
    // The distinction that was lost: "not a skill" must be loud; it was reached only after a parse.
    const resolved = await resolveSlashInvocation([userMessage(clientEnvelope('/bt-nope do a thing'))]);

    expect(resolved).toBeNull();
  });

  it('does not treat a file path or prose slash as an invocation', async () => {
    expect(await resolveSlashInvocation([userMessage(clientEnvelope('edit /src/main.ts please'))])).toBeNull();
    expect(await resolveSlashInvocation([userMessage(clientEnvelope('use a light and/or dark theme'))])).toBeNull();
  });

  it('resolves against the LAST user message, not the first', async () => {
    const resolved = await resolveSlashInvocation([
      userMessage(clientEnvelope('make me a kart racer')),
      { id: '2', role: 'assistant', content: 'done' } as Message,
      userMessage(clientEnvelope('/bt-spec add auth')),
    ]);

    expect(resolved?.skillName).toBe('bt-spec');
  });
});
