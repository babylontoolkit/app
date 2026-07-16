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
import { compactHistory, historySavings, HISTORY_WINDOW_TURNS, MAX_HISTORY_CHARS } from './history';

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

describe('the turn-count window (HISTORY_WINDOW_TURNS)', () => {
  /*
   * The char cap bounds by SIZE; the turn cap bounds by COUNT. A long session of many SMALL messages
   * stays under the char cap forever, so without a turn cap it would still re-send an unbounded number
   * of turns every turn. This bounds that.
   */
  it('keeps the brief + the most-recent N messages when the turn count is exceeded', () => {
    const brief = userTurn('make me a kart racer');
    const history: Message[] = [brief];

    // Many small messages: well under MAX_HISTORY_CHARS in total, so only the TURN cap can bite.
    for (let i = 0; i < 20; i++) {
      history.push(userTurn(`small change ${i}`));
    }

    const compacted = compactHistory(history, { maxTurns: 5 });

    // First brief + exactly the 5 most-recent messages.
    expect(compacted).toHaveLength(6);
    expect(compacted[0].content).toBe(brief.content);
    expect(compacted[compacted.length - 1].content).toContain('small change 19');
    expect(compacted[1].content).toContain('small change 15');
  });

  /* The first brief is never dropped, even by the turn cap. */
  it('never drops the first user message via the turn cap', () => {
    const brief = userTurn('the original brief that must survive');
    const history: Message[] = [brief];

    for (let i = 0; i < 30; i++) {
      history.push(userTurn(`msg ${i}`));
    }

    expect(compactHistory(history, { maxTurns: 4 })[0].content).toBe(brief.content);
  });

  /* Disabled (0) → only the char cap applies, so a short conversation is untouched. */
  it('is disabled when maxTurns is 0', () => {
    const history: Message[] = [userTurn('brief')];

    for (let i = 0; i < 10; i++) {
      history.push(userTurn(`m${i}`));
    }

    expect(compactHistory(history, { maxTurns: 0 })).toHaveLength(history.length);
  });

  /* Never duplicates the first message when it is already inside the recent window. */
  it('does not duplicate the brief when the whole conversation fits the window', () => {
    const history = [userTurn('brief'), userTurn('a'), userTurn('b')];

    expect(compactHistory(history, { maxTurns: 5 })).toHaveLength(3);
  });

  /* The exported default is a sane positive number, so the proxy has a real turn cap out of the box. */
  it('defaults to a positive turn cap', () => {
    expect(HISTORY_WINDOW_TURNS).toBeGreaterThan(0);
  });
});

/**
 * Thinking must not survive into the next turn — a CORRECTNESS rule, not a budget one.
 *
 * Measured live, 2026-07-16: every edit turn died with
 *
 *   Custom error: messages.2.content.0.thinking.signature: Field required
 *
 * 0 in, 0 out, ~0.3s, `finish=error` — the API refused the request before generating a token. The
 * proxy streams reasoning to the client as plain text (`AgentChunk` has no signature field), so the
 * saved message carries thinking WITHOUT the signature Anthropic issued, and posting it back is
 * rejected. Creations were fine (no history); every turn after the first was broken, on every project.
 */
describe('compactHistory — thinking never survives the turn', () => {
  const withReasoning = (): Message =>
    ({
      id: 'a1',
      role: 'assistant',
      content: 'Built it.',
      reasoning: 'Let me think about the character controller...',
      parts: [
        { type: 'reasoning', reasoning: 'Let me think about the character controller...' },
        { type: 'text', text: 'Built it.' },
      ],
    }) as unknown as Message;

  it('strips the reasoning part that the API rejects without a signature', () => {
    const [out] = compactHistory([withReasoning()]) as Array<Message & { reasoning?: string }>;

    expect(out.parts?.some((p) => p.type === 'reasoning')).toBe(false);
    expect(out.reasoning).toBeUndefined();
  });

  it('keeps the answer itself — only the thinking goes', () => {
    const [out] = compactHistory([withReasoning()]);

    expect(out.content).toBe('Built it.');
    expect(out.parts?.some((p) => p.type === 'text')).toBe(true);
  });

  it('leaves a message with no reasoning untouched (same object, no needless copy)', () => {
    const plain = userTurn('add a boost');
    const [out] = compactHistory([plain]);

    expect(out).toBe(plain);
  });

  it('strips reasoning even when content is not a plain string', () => {
    const message = {
      id: 'a2',
      role: 'assistant',
      content: undefined,
      parts: [
        { type: 'reasoning', reasoning: 'thinking...' },
        { type: 'text', text: 'done' },
      ],
    } as unknown as Message;

    const [out] = compactHistory([message]);

    expect(out.parts?.some((p) => p.type === 'reasoning')).toBe(false);
    expect(out.parts?.some((p) => p.type === 'text')).toBe(true);
  });

  it('never touches a user message', () => {
    const user = { id: 'u1', role: 'user', content: 'make it faster' } as Message;
    const [out] = compactHistory([user]);

    expect(out).toBe(user);
  });
});
