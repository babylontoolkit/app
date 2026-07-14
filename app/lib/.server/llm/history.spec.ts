/**
 * History compaction (SPEC §4.2.8, `spec/context-budget.md`).
 *
 * The failure this prevents is silent and permanent: the conversation history is UNCACHED (all four
 * cache breakpoints sit on the system blocks), so every byte of every previous turn is re-sent at full
 * input rate on every subsequent turn — forever, growing with the session. A regression here throws
 * nothing and breaks nothing. It just quietly multiplies the bill of every long conversation.
 *
 * The inverse regression matters just as much and is tested here too: compacting away something the
 * model NEEDS (what the user asked for, which files it touched) makes the agent stupid in a way that
 * looks like a model problem, not a context problem.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from 'ai';
import { compactHistory, historySavings, MAX_HISTORY_CHARS } from './history';

const bigFile = 'const x = 1;\n'.repeat(400); // ~5KB, the size of a real generated source file

const assistantTurn = (path: string, body: string): Message =>
  ({
    id: `a-${path}`,
    role: 'assistant',
    content: [
      "I've built the racing game.",
      `<boltArtifact id="race" title="Race">`,
      `<boltAction type="file" filePath="${path}">${body}</boltAction>`,
      `<boltAction type="shell">npm run dev</boltAction>`,
      `</boltArtifact>`,
    ].join('\n'),
  }) as Message;

const userTurn = (text: string): Message => ({ id: `u-${text.slice(0, 6)}`, role: 'user', content: text }) as Message;

describe('what compaction REMOVES', () => {
  /*
   * The whole point. 83-87% of a real history is file bodies, and every one is a STALE duplicate of
   * something sent correctly, and fresh, in `# Current Project Files` on the same turn.
   */
  it('strips file-action bodies from assistant turns', () => {
    const history = [userTurn('make a racing game'), assistantTurn('src/scripts/RaceMode.ts', bigFile)];
    const compacted = compactHistory(history);

    expect(compacted[1].content).not.toContain('const x = 1;');
    expect(historySavings(history, compacted)).toBeGreaterThan(4000);
  });

  it('strips edit-action bodies too', () => {
    const edit = {
      id: 'a1',
      role: 'assistant',
      content: `<boltAction type="edit" filePath="src/pages/Home.css">${bigFile}</boltAction>`,
    } as Message;

    expect(compactHistory([userTurn('hi'), edit])[1].content).not.toContain('const x = 1;');
  });

  /* Real measurement: the reason this module exists. */
  it('removes the great majority of a realistic creation turn', () => {
    const history = [
      userTurn('make me a kart racer'),
      assistantTurn('src/scripts/KartMode.ts', bigFile),
      assistantTurn('src/pages/Home.tsx', bigFile),
    ];

    const before = historySavings(history, []);
    const saved = historySavings(history, compactHistory(history));

    expect(saved / before).toBeGreaterThan(0.8);
  });
});

describe('what compaction MUST KEEP', () => {
  /* What the user said exists NOWHERE else. Losing it is losing the requirements. */
  it('never touches user messages', () => {
    const user = userTurn('make a racing game with boost pads and a lap timer');
    const compacted = compactHistory([user, assistantTurn('a.ts', bigFile)]);

    expect(compacted[0].content).toBe(user.content);
  });

  /*
   * The model must still know WHICH files it created and edited — that is the part of the history that
   * carries meaning. Only the bodies are redundant.
   */
  it('keeps the action tags and file paths', () => {
    const compacted = compactHistory([userTurn('go'), assistantTurn('src/scripts/RaceMode.ts', bigFile)]);
    const content = compacted[1].content as string;

    expect(content).toContain('type="file"');
    expect(content).toContain('src/scripts/RaceMode.ts');
    expect(content).toContain("I've built the racing game.");
  });

  /* And it must be told where the real content is, or it will assume the file is empty. */
  it('points the model at the file-context block instead of the omitted body', () => {
    const compacted = compactHistory([userTurn('go'), assistantTurn('a.ts', bigFile)]);

    expect(compacted[1].content).toContain('Current Project Files');
  });

  /* A shell command IS the information — one line, nothing to strip. */
  it('never strips shell actions', () => {
    const compacted = compactHistory([userTurn('go'), assistantTurn('a.ts', bigFile)]);

    expect(compacted[1].content).toContain('<boltAction type="shell">npm run dev</boltAction>');
  });

  it('leaves a body that is already smaller than the marker alone', () => {
    const tiny = { id: 'a', role: 'assistant', content: '<boltAction type="file" filePath="a">x</boltAction>' };
    expect(compactHistory([tiny as Message])[0].content).toContain('>x<');
  });
});

describe('the windowing backstop', () => {
  /*
   * Compaction removes growth that scales with FILE size. This bounds growth that scales with
   * CONVERSATION length — a very long session of pure prose would still creep up forever.
   */
  it('drops the oldest turns once the history exceeds the ceiling', () => {
    const history: Message[] = [userTurn('make me a kart racer')];

    for (let i = 0; i < 40; i++) {
      history.push(userTurn(`change ${i}: ${'x'.repeat(2000)}`));
    }

    const compacted = compactHistory(history);

    expect(historySavings(compacted, [])).toBeLessThanOrEqual(MAX_HISTORY_CHARS + 2100);
    expect(compacted.length).toBeLessThan(history.length);
  });

  /*
   * THE ONE MESSAGE THAT MAY NEVER BE DROPPED. It is the original brief — the request the whole project
   * exists to satisfy. Drop it and the agent forgets what it is building, while still sounding fluent.
   */
  it('never drops the first user message — the original brief', () => {
    const brief = userTurn('make me a kart racer with boost pads');
    const history: Message[] = [brief];

    for (let i = 0; i < 40; i++) {
      history.push(userTurn(`change ${i}: ${'x'.repeat(2000)}`));
    }

    expect(compactHistory(history)[0].content).toBe(brief.content);
  });

  /* And it keeps the most recent turns, which are what the current request actually refers to. */
  it('keeps the most recent turns', () => {
    const history: Message[] = [userTurn('brief')];

    for (let i = 0; i < 40; i++) {
      history.push(userTurn(`change ${i}: ${'x'.repeat(2000)}`));
    }

    const compacted = compactHistory(history);

    expect(compacted[compacted.length - 1].content).toContain('change 39');
  });

  it('leaves a short conversation completely alone', () => {
    const history = [userTurn('hi'), { id: 'a', role: 'assistant', content: 'hello' } as Message];

    expect(compactHistory(history)).toEqual(history);
  });
});
