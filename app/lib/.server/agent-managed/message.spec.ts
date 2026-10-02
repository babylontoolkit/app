/**
 * The ONE `user.message` a managed turn sends (managed-agents-engine T9, T10).
 *
 * T10: the session holds the conversation, so a turn sends no history and no file bodies — only the
 * user's words, plus (on a new session) a paths-only manifest. T9: a first build appends the whole
 * phase list as guidance after the user's words, which stay byte-exact.
 */
import type { Message } from 'ai';
import { describe, expect, it } from 'vitest';
import { MANAGED_BUILD_OPEN, phaseById } from '~/lib/agent/creation-plan';
import type { FileMap } from '~/lib/.server/llm/constants';
import { buildManagedUserMessage } from './message';

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

  it('carries the user’s words, unwrapped, and nothing of earlier turns', () => {
    expect(text.endsWith('add drifting')).toBe(true);
    expect(text).not.toContain('EARLIER_TURN_QUESTION');
    expect(text).not.toContain('EARLIER_TURN_ANSWER');
    expect(text).not.toContain('[Model:');
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
