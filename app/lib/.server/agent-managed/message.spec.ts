/**
 * The ONE `user.message` a managed turn sends (managed-agents-engine T9, T10).
 *
 * T10: the session holds the conversation, so a turn on an EXISTING session sends no history and no file
 * bodies — only the user's words. A NEW session holds nothing, so its first message adds a paths-only
 * manifest and, when the chat already had turns (a model-tier switch, a dead session), a recap of the
 * WORDS said so far — never a file body. T9: a first build appends the whole
 * phase list as guidance after the user's words, which stay byte-exact.
 */
import type { Message } from 'ai';
import { describe, expect, it } from 'vitest';
import { MANAGED_BUILD_OPEN, phaseById } from '~/lib/agent/creation-plan';
import type { FileMap } from '~/lib/.server/llm/constants';
import { PLAN_MODE } from '~/types/message-marks';
import {
  buildManagedUserMessage,
  conversationRecap,
  managedPlanNote,
  mcpToolsNote,
  PLAN_MODE_ENDED_NOTE,
  RECAP_MAX_CHARS,
} from './message';

const SECRET_BODY = 'const KART_SECRET_BODY_7731 = "never sent";';

const FILES = {
  '/home/project/src/main.ts': { type: 'file', content: SECRET_BODY, isBinary: false },
  '/home/project/src/scripts/Kart.ts': { type: 'file', content: `export ${SECRET_BODY}`, isBinary: false },
  '/home/project/node_modules/x/index.js': { type: 'file', content: 'x', isBinary: false },
} as unknown as FileMap;

const HISTORY: Message[] = [
  { id: 'u1', role: 'user', content: 'EARLIER_TURN_QUESTION make a racer' },
  {
    id: 'a1',
    role: 'assistant',
    content: `EARLIER_TURN_ANSWER <boltAction type="file" filePath="src/a.ts">${SECRET_BODY}</boltAction>`,
  },
];

const textOf = (message: ReturnType<typeof buildManagedUserMessage>) =>
  (message?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

describe('a managed turn sends ONE message — no history, no file bodies (T10)', () => {
  const message = buildManagedUserMessage({
    messages: [...HISTORY, { id: 'u2', role: 'user', content: '[Model: x]\n\n[Provider: y]\n\nadd drifting' }],
    files: FILES,
    newSession: true,
  });
  const text = textOf(message);

  it('carries the user’s words, unwrapped, last', () => {
    expect(text.endsWith('add drifting')).toBe(true);
    expect(text).not.toContain('[Model:');
  });

  it('a NEW session in a chat with earlier turns recaps what was SAID — never a file body', () => {
    expect(text).toContain('User: EARLIER_TURN_QUESTION make a racer');
    expect(text).toContain('You: EARLIER_TURN_ANSWER');
    expect(text).not.toContain('KART_SECRET_BODY_7731 = "never sent"');
    expect(text).not.toContain('boltAction');

    /* The recap precedes the words; the current message is never repeated inside it. */
    expect(text.indexOf('EARLIER_TURN_QUESTION')).toBeLessThan(text.indexOf('add drifting'));
    expect(text.split('add drifting').length).toBe(2);
  });

  it('CONTROL: an EXISTING session gets no recap — it already holds the conversation', () => {
    const next = buildManagedUserMessage({
      messages: [...HISTORY, { id: 'u2', role: 'user', content: 'add drifting' }],
      files: FILES,
      newSession: false,
    });

    expect(textOf(next)).toBe('add drifting');
  });

  it('the recap is capped, keeps the NEWEST turns and says what it cut', () => {
    const long: Message[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `TURN_${i} ${'x'.repeat(1000)}`,
    }));
    const recap = conversationRecap([...long, { id: 'last', role: 'user', content: 'now' }]);

    expect(recap.length).toBeLessThan(RECAP_MAX_CHARS + 1000);
    expect(recap).toContain('TURN_39');
    expect(recap).not.toContain('TURN_0 ');
    expect(recap).toMatch(/\d+ earlier message\(s\) omitted/);
  });

  it('the first message of a brand-new chat has no recap', () => {
    expect(conversationRecap([{ id: 'u1', role: 'user', content: 'make a racer' }])).toBe('');
  });

  it('the manifest is PATHS ONLY — no file body reaches the session', () => {
    expect(text).toContain('src/main.ts\n');
    expect(text).toContain('src/scripts/Kart.ts\n');
    expect(text).not.toContain('KART_SECRET_BODY_7731');
    expect(text).not.toContain('node_modules/');
  });

  it('CONTROL: an existing session gets no manifest at all — just the words', () => {
    const next = buildManagedUserMessage({
      messages: [{ id: 'u3', role: 'user', content: 'faster' }],
      files: FILES,
      newSession: false,
    });

    expect(textOf(next)).toBe('faster');
  });
});

describe('a managed FIRST BUILD carries every phase as guidance (T9)', () => {
  const WORDS = 'Make me a simple 3D coin collector:  a ball you roll with WASD\n\nwith a score HUD';

  it('the user’s words come first, byte-exact, then the phases in order', () => {
    const text = textOf(
      buildManagedUserMessage({
        messages: [{ id: 'u1', role: 'user', content: WORDS }],
        newSession: false,
        buildPhases: ['design', 'game', 'frontend'],
      }),
    );

    expect(text.startsWith(`${WORDS}\n\n${MANAGED_BUILD_OPEN}`)).toBe(true);

    const order = ['design', 'game', 'frontend'].map((id) => text.indexOf(phaseById(id as 'game').task));

    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('CONTROL: an ordinary turn has no guidance; a repair never carries it either', () => {
    expect(
      textOf(buildManagedUserMessage({ messages: [{ id: 'u', role: 'user', content: WORDS }], newSession: false })),
    ).toBe(WORDS);

    const repair = textOf(
      buildManagedUserMessage({
        messages: [{ id: 'u', role: 'user', content: WORDS }],
        errors: ['src/x.ts:1 TS2304'],
        newSession: false,
        buildPhases: ['design', 'game', 'frontend'],
      }),
    );

    expect(repair).not.toContain(MANAGED_BUILD_OPEN);
  });
});

describe('Plan mode and MCP notes (managed-only plan D2, D6)', () => {
  const ask = (content: string): Message => ({ id: `u-${content}`, role: 'user', content });

  it('a Plan turn is prefixed with the Plan note, before the words, and runs no build phases', () => {
    const text = textOf(
      buildManagedUserMessage({
        messages: [ask('how should drifting work?')],
        newSession: false,
        planMode: true,
        buildPhases: ['design', 'game', 'frontend'],
      }),
    );

    expect(text.startsWith(managedPlanNote())).toBe(true);
    expect(text.endsWith('how should drifting work?')).toBe(true);
    expect(text).toContain('_specs/');
    expect(text).not.toContain(MANAGED_BUILD_OPEN);
  });

  it('the first Build turn after a Plan turn says Plan mode has ended; a later one does not', () => {
    const afterPlan: Message[] = [
      ask('plan it'),
      { id: 'a1', role: 'assistant', content: 'Here is the plan', annotations: [PLAN_MODE, 'no-replay'] } as Message,
      ask('build it now'),
    ];
    const afterBuild: Message[] = [
      ask('plan it'),
      { id: 'a1', role: 'assistant', content: 'done', annotations: [] } as Message,
      ask('tweak it'),
    ];

    expect(textOf(buildManagedUserMessage({ messages: afterPlan, newSession: false }))).toBe(
      `${PLAN_MODE_ENDED_NOTE}\n\nbuild it now`,
    );
    expect(textOf(buildManagedUserMessage({ messages: afterBuild, newSession: false }))).toBe('tweak it');
  });

  it('MCP tools are announced in ONE line (servers named), never listed', () => {
    const tools = [
      { name: 'search', server: 'docs', description: 'LONG_DESCRIPTION_NEVER_SENT', inputSchema: { type: 'object' } },
      { name: 'read_file', server: 'fs' },
    ];
    const text = textOf(
      buildManagedUserMessage({ messages: [ask('use the docs')], newSession: false, mcpTools: tools }),
    );

    expect(text).toBe(`${mcpToolsNote(tools)}\n\nuse the docs`);
    expect(text).toContain('2 MCP tool(s)');
    expect(text).toContain('docs, fs');
    expect(text).not.toContain('LONG_DESCRIPTION_NEVER_SENT');
    expect(mcpToolsNote([])).toBe('');
  });

  it('CONTROL: an ordinary Build turn carries no note at all', () => {
    expect(textOf(buildManagedUserMessage({ messages: [ask('add a boost pad')], newSession: false }))).toBe(
      'add a boost pad',
    );
  });
});
