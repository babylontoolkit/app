/**
 * History compaction (SPEC §4.2.8, `spec/context-budget.md`).
 *
 * The failure this prevents is silent and permanent: the conversation history is UNCACHED (every
 * cache breakpoint sits on the system blocks), so every byte of every previous turn is re-sent at full
 * input rate on every subsequent turn — forever, growing with the session. A regression here throws
 * nothing and breaks nothing. It just quietly multiplies the bill of every long conversation.
 *
 * The inverse regression matters just as much and is tested here too: compacting away something the
 * model NEEDS (what the user asked for, which files it touched) makes the agent stupid in a way that
 * looks like a model problem, not a context problem.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Message } from 'ai';
import {
  compactHistory,
  historySavings,
  historySize,
  HISTORY_WINDOW_TURNS,
  IMAGE_TOKENS_UPPER_BOUND,
  MAX_HISTORY_CHARS,
  stripReplayedReasoning,
} from './history';

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
  /* What the user WROTE exists NOWHERE else. Losing it is losing the requirements. */
  it("never touches the user's own words", () => {
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

/**
 * The modified-files artifact the CLIENT prepends to a user message when the user has edited files in
 * the editor (`filesToArtifacts(getModifiedFiles())`). Those bodies are machine-generated, redundant
 * with `# Current Project Files`, and — because they arrive inside a USER message — used to be the one
 * part of the history that compaction skipped and that grew without bound.
 */
describe('the modified-files artifact in a USER message', () => {
  const editedBody = 'export const speed = 42;\n'.repeat(400);

  const userWithEdits = (text: string) =>
    ({
      id: 'u1',
      role: 'user',
      content:
        `<boltArtifact id="edits" title="User edits">` +
        `<boltAction type="file" filePath="src/scripts/KartMode.ts">${editedBody}</boltAction>` +
        `</boltArtifact>${text}`,
    }) as Message;

  it('strips the file BODY the user never typed', () => {
    const [out] = compactHistory([userWithEdits('now add a boost pad')]);

    expect(out.content).not.toContain('export const speed = 42;');
    expect(out.content).toContain('Current Project Files');
  });

  it('keeps every word the user DID type, and the path they edited', () => {
    const [out] = compactHistory([userWithEdits('now add a boost pad')]);

    expect(out.content).toContain('now add a boost pad');
    expect(out.content).toContain('src/scripts/KartMode.ts');
    expect(out.content).toContain('type="file"');
  });

  it('strips the body from `parts` TOO — the SDK prefers parts over content', () => {
    const message = userWithEdits('now add a boost pad');
    const withParts = { ...message, parts: [{ type: 'text', text: message.content }] } as Message;

    const [out] = compactHistory([withParts]);
    const text = (out.parts?.[0] as { text: string }).text;

    expect(text).not.toContain('export const speed = 42;');
    expect(text).toContain('now add a boost pad');
  });

  it('leaves image parts untouched', () => {
    const image = { type: 'file', mimeType: 'image/png', data: 'AAA' };
    const message = userWithEdits('look at this');
    const withParts = { ...message, parts: [{ type: 'text', text: message.content }, image] } as unknown as Message;

    const [out] = compactHistory([withParts]);

    expect(out.parts?.[1]).toBe(image);
  });

  it('saves the overwhelming majority of a file-sync turn', () => {
    const history = [userWithEdits('now add a boost pad')];
    const before = historySavings(history, []);

    expect(historySavings(history, compactHistory(history)) / before).toBeGreaterThan(0.9);
  });
});

/**
 * `historySize` feeds the §4.5.6 `/context` meter, and it measures `content` ONLY — while every user
 * message carries a duplicate of that text in `parts` (the client sets both from one string) and the AI
 * SDK's `convertToCoreMessages` prefers `parts`. So the number on the user's screen is only honest
 * while the two agree.
 *
 * They agree today, and compaction keeps them agreeing. Nothing else enforces it — hence this test: a
 * future change that compacts one and not the other would leave the meter quietly reporting a size that
 * is not what went on the wire, which is the class of silent-measurement failure this codebase keeps
 * rediscovering (`wastedOutput`, `tool_rounds`, the doubled `finishReason`).
 */
describe('`parts` and `content` stay mirrored, so /context stays honest', () => {
  const mirrored = (text: string) =>
    ({ id: 'u1', role: 'user', content: text, parts: [{ type: 'text', text }] }) as Message;

  it('keeps the text part byte-identical to content after compaction', () => {
    const withBody =
      `<boltArtifact id="edits"><boltAction type="file" filePath="a.ts">${bigFile}</boltAction></boltArtifact>` +
      'now add a boost pad';

    const [out] = compactHistory([mirrored(withBody)]);

    expect((out.parts?.[0] as { text: string }).text).toBe(out.content);
  });

  it('and on a message with nothing to compact', () => {
    const [out] = compactHistory([mirrored('make it faster')]);

    expect((out.parts?.[0] as { text: string }).text).toBe(out.content);
  });

  it('so historySize describes what actually goes on the wire', () => {
    const [out] = compactHistory([mirrored('make it faster')]);
    const measured = historySize([out]);

    expect(measured.messages).toBe(1);
    expect(measured.chars).toBe((out.parts?.[0] as { text: string }).text.length);
  });
});

/**
 * The blind spot the chars-only meter had: an attachment carries ZERO characters, so an image sent
 * five turns ago measured as free while it was re-sent, uncached, at full rate, on every turn after.
 * The `/context` panel's `promptTokens` did show the spend — which is exactly why this was hard to
 * see, and why it had to be fixed in the number the traffic light reads.
 */
describe('historySize prices the attachments riding in the history', () => {
  const png = (bytes: number) => `data:image/png;base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;

  const withAttachments = (attachments: Array<{ contentType: string; url: string }>) =>
    ({ id: 'u1', role: 'user', content: 'look at this', experimental_attachments: attachments }) as unknown as Message;

  it('counts an image at the per-image upper bound, not at its byte size', () => {
    const small = historySize([withAttachments([{ contentType: 'image/png', url: png(2_000) }])]);
    const large = historySize([withAttachments([{ contentType: 'image/png', url: png(4_000_000) }])]);

    expect(small.attachments).toBe(1);
    expect(small.attachmentTokens).toBe(IMAGE_TOKENS_UPPER_BOUND);

    // base64 length is a terrible proxy for vision tokens — a 2,000× bigger file is not 2,000× the cost.
    expect(large.attachmentTokens).toBe(IMAGE_TOKENS_UPPER_BOUND);
  });

  it('prices a TEXT attachment by its decoded bytes — it really is text on the wire', () => {
    const text = `data:text/plain;base64,${btoa('x'.repeat(400))}`;
    const size = historySize([withAttachments([{ contentType: 'text/plain', url: text }])]);

    expect(size.attachments).toBe(1);
    expect(size.attachmentTokens).toBe(100); // 400 bytes / 4 chars-per-token
  });

  it('sees `file` parts too, so the meter survives the SDK moving off experimental_attachments', () => {
    const message = {
      id: 'u1',
      role: 'user',
      content: 'look',
      parts: [
        { type: 'text', text: 'look' },
        { type: 'file', mimeType: 'image/png', data: png(1_000) },
      ],
    } as unknown as Message;

    expect(historySize([message]).attachmentTokens).toBe(IMAGE_TOKENS_UPPER_BOUND);
  });

  it('a text-only conversation reports zero, never NaN', () => {
    const size = historySize([{ id: 'u1', role: 'user', content: 'hello' } as Message]);

    expect(size).toEqual({ messages: 1, chars: 5, attachments: 0, attachmentTokens: 0 });
  });

  it('accumulates across the whole re-sent history — that is the cost being paid every turn', () => {
    const size = historySize([
      withAttachments([{ contentType: 'image/png', url: png(1_000) }]),
      { id: 'a1', role: 'assistant', content: 'ok' } as Message,
      withAttachments([
        { contentType: 'image/png', url: png(1_000) },
        { contentType: 'image/jpeg', url: png(1_000) },
      ]),
    ]);

    expect(size.attachments).toBe(3);
    expect(size.attachmentTokens).toBe(3 * IMAGE_TOKENS_UPPER_BOUND);
  });

  it('an unparseable attachment url contributes zero rather than a guess', () => {
    const size = historySize([withAttachments([{ contentType: 'text/plain', url: 'not-a-data-url' }])]);

    expect(size.attachments).toBe(1);
    expect(size.attachmentTokens).toBe(0);
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

/**
 * The strip is FAMILY-INDEPENDENT, and that is the whole finding of the 2026-08-04 SDK audit
 * (`stripReasoning`'s doc block).
 *
 * When KIE became three families, the open question was whether a codex (OpenAI Responses) or gemini
 * turn round-trips a reasoning artifact this strip would miss. It does not — neither vendor SDK emits
 * anything but `{type:'reasoning'}` parts, their zod schemas discard the vendor-specific fields at the
 * parse boundary, and our `drain` is a three-branch whitelist. No code extension was needed. These
 * tests pin that conclusion so a future change cannot quietly make the strip conditional.
 *
 * ⚠️ Every fixture here carries `details`, which the fixture above deliberately does not. `@ai-sdk/ui-utils`
 * ALWAYS produces `details` on a reasoning part, so a strip that filtered on the CONTENTS of `details`
 * instead of on `part.type` would pass every test above and fail every one below.
 */
describe('reasoning is stripped identically for every model family', () => {
  /** Shape-identical across families: only the model named in `annotations` differs. */
  const assistantWithReasoning = (model: string): Message =>
    ({
      id: 'a1',
      role: 'assistant',
      content: 'Built the boost pad.',
      reasoning: 'The track mesh needs a trigger volume...',
      annotations: [{ agentMeta: { model } }],
      parts: [
        { type: 'step-start' },
        {
          type: 'reasoning',
          reasoning: 'The track mesh needs a trigger volume...',
          details: [{ type: 'text', text: 'The track mesh needs a trigger volume...' }],
        },
        { type: 'text', text: 'Built the boost pad.' },
      ],
    }) as unknown as Message;

  const compactOne = (message: Message) => compactHistory([message])[0] as Message & { reasoning?: string };

  it.each(['gpt-5-6-sol', 'gemini-3-5-flash', 'claude-opus-5'])(
    'leaves no reasoning artifact on a %s turn',
    (model) => {
      const out = compactOne(assistantWithReasoning(model));

      expect(out.reasoning).toBeUndefined();
      expect(out.parts?.some((part) => part.type === 'reasoning')).toBe(false);

      // And the answer itself survives — the inverse regression.
      expect(out.content).toBe('Built the boost pad.');
    },
  );

  /*
   * THE EQUIVALENCE IS THE FINDING. Three shape-identical turns differing only in which family produced
   * them compact to byte-identical output, because the strip is keyed on ROLE and nothing else.
   */
  it('produces the SAME compacted message for codex, gemini and claude', () => {
    const withoutModel = (model: string) => {
      const out = compactOne(assistantWithReasoning(model)) as Message & { annotations?: unknown };
      return { ...out, annotations: undefined };
    };

    const codex = withoutModel('gpt-5-6-sol');

    expect(withoutModel('gemini-3-5-flash')).toEqual(codex);
    expect(withoutModel('claude-opus-5')).toEqual(codex);
  });

  /*
   * Structural pin on the NON-CONDITIONALITY. `compactHistory`'s signature takes only `{maxTurns}`, so
   * the module has no way to learn this turn's family — and it must never grow one: a conversation's
   * earlier turns may have run family A while this turn resolves to family B (a tier decline, an
   * `LLM_MODEL` change, a resumed cross-device chat), which is precisely the case a family-keyed strip
   * would break.
   */
  it('history.ts never references the model-family machinery', () => {
    const source = readFileSync(fileURLToPath(new URL('./history.ts', import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // CONTROL: the scanner reads real code. A scan that silently matches nothing is not a test.
    expect(code).toContain('function stripReasoning');
    expect(code).not.toContain('/*');

    for (const forbidden of ['familyOf', 'model-families', 'ModelFamily']) {
      expect(code).not.toContain(forbidden);
    }
  });
});

/**
 * States the product cannot currently produce, but that the SDK's `ReasoningUIPart` type permits — a
 * `@ai-sdk/provider` bump or a change to `drain`'s three-branch whitelist could start producing any of
 * them. Each must still be removed COMPLETELY, because a reasoning artifact that survives into the next
 * turn is a hard 400 before a single token is generated.
 */
describe('defensive reasoning shapes are removed completely', () => {
  const stringify = (message: Message) => JSON.stringify(message);

  it('removes a reasoning part carrying a signature on its text detail', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      content: 'Done.',
      parts: [
        {
          type: 'reasoning',
          reasoning: 'thinking...',
          details: [{ type: 'text', text: 'thinking...', signature: 'ErUBCkYIBRgCIkD0mfPz' }],
        },
        { type: 'text', text: 'Done.' },
      ],
    } as unknown as Message;

    const [out] = compactHistory([message]);

    expect(out.parts?.some((part) => part.type === 'reasoning')).toBe(false);
    expect(stringify(out)).not.toContain('ErUBCkYIBRgCIkD0mfPz');
  });

  it('removes a REDACTED reasoning detail', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      content: 'Done.',
      parts: [
        { type: 'reasoning', reasoning: '', details: [{ type: 'redacted', data: 'EroBCkYIBRgCKkCq7x' }] },
        { type: 'text', text: 'Done.' },
      ],
    } as unknown as Message;

    const [out] = compactHistory([message]);

    expect(out.parts?.some((part) => part.type === 'reasoning')).toBe(false);
    expect(stringify(out)).not.toContain('EroBCkYIBRgCKkCq7x');
  });

  /*
   * The reload path: `fillMessageParts` reconstructs `parts` from a persisted message, so a stored
   * `reasoning` string can arrive with no reasoning PART at all. `hadReasoning` must still catch it —
   * that field alone is enough to make the next request a 400.
   */
  it('removes a top-level `reasoning` field even with no reasoning part present', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      content: 'Done.',
      reasoning: 'restored from storage...',
      parts: [{ type: 'text', text: 'Done.' }],
    } as unknown as Message;

    const [out] = compactHistory([message]) as Array<Message & { reasoning?: string }>;

    expect(out.reasoning).toBeUndefined();
    expect(stringify(out)).not.toContain('restored from storage');
    expect(out.content).toBe('Done.');
  });
});

/**
 * 🔴 THE REPLAYED-THINKING 400 (2026-08-14) — `stripReplayedReasoning`.
 *
 * Reported live, mid-creation, on Comet → Bedrock:
 *
 *     ValidationException: ***.***.content.0: Invalid `signature` in `thinking` block
 *
 * Three passes replay the provider's own assistant messages inside one generation (the forced
 * continuation, the unproductive rescue, the creation completeness pass). Those messages open with a
 * `reasoning` block carrying a signature scoped to the backend that minted it — and on a gateway
 * chain the second request need not land on the same backend.
 *
 * ⚠️ These fixtures are `CoreMessage`-shaped (`content[]`), NOT `Message`-shaped (`parts[]`). Every
 * other fixture in this file is the latter, which is exactly why a strip that only understood UI
 * messages looked complete: no test in the repo had ever held the shape the failing path passes.
 */
describe('stripReplayedReasoning — the provider messages a continuation replays', () => {
  const reasoning = { type: 'reasoning', text: 'Let me think about the landing page', signature: 'sig_abc' };

  it('drops the reasoning block that carries the signature', () => {
    const [message] = stripReplayedReasoning([
      { role: 'assistant', content: [reasoning, { type: 'text', text: 'Writing the files now.' }] },
    ]);

    expect(message.content).toEqual([{ type: 'text', text: 'Writing the files now.' }]);
  });

  it('drops redacted reasoning too — it carries the same signature problem', () => {
    const [message] = stripReplayedReasoning([
      {
        role: 'assistant',
        content: [
          { type: 'redacted-reasoning', data: 'xxx' },
          { type: 'text', text: 'ok' },
        ],
      },
    ]);

    expect(message.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  /**
   * 🔴 THE LOAD-BEARING HALF. The continuation exists BECAUSE the model was mid-tool-loop; one that
   * cannot see what its tools returned re-runs them, which on the media tools means paying twice.
   */
  it('leaves tool calls and tool results completely alone', () => {
    const toolCall = { type: 'tool-call', toolCallId: 't1', toolName: 'generate_image', args: {} };
    const messages = [
      { role: 'assistant', content: [reasoning, toolCall] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'generate_image', result: {} }] },
    ];

    const stripped = stripReplayedReasoning(messages);

    expect(stripped[0].content).toEqual([toolCall]);
    expect(stripped[1]).toBe(messages[1]);
  });

  /**
   * An empty `content: []` is itself a 400 on several providers, so a thinking-only message is
   * dropped rather than emptied — trading a turn the model cannot see for a request it can send.
   */
  it('drops a message that was nothing but thinking', () => {
    expect(stripReplayedReasoning([{ role: 'assistant', content: [reasoning] }])).toEqual([]);
  });

  it('leaves string content and user messages untouched, by identity', () => {
    const messages = [
      { role: 'assistant', content: 'plain text answer' },
      { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    ];

    const stripped = stripReplayedReasoning(messages);

    expect(stripped[0]).toBe(messages[0]);
    expect(stripped[1]).toBe(messages[1]);
  });

  /**
   * CONTROL — without this the whole block passes for a function that returns `[]`, which would
   * silently strip the continuation's entire context and is the failure mode pointing the other way.
   */
  it('CONTROL — a message with no reasoning survives intact and identical', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Writing the files now.' }] }];
    const stripped = stripReplayedReasoning(messages);

    expect(stripped).toHaveLength(1);
    expect(stripped[0]).toBe(messages[0]);
  });
});

/**
 * 🔴 DEFAULT-DENY: no pass may replay provider messages RAW (2026-08-14).
 *
 * The behavioural tests above prove `stripReplayedReasoning` works. They cannot prove the three call
 * sites use it, and they say nothing at all about the FOURTH one somebody adds next — which is the
 * shape this repo keeps rediscovering (`execution-queue`, `sandbox-seam`, `isSecretPath`): one rule,
 * several doors, and a test that only knows about the doors someone enumerated.
 *
 * Every rescue pass in the proxy exists because a generation went wrong, so a new one is written on a
 * bad day, by someone copying the pass above it. `(await first.response).messages` is what they will
 * copy. This fails if they copy it unwrapped.
 */
describe('CONTROL — every replay of provider messages is stripped', () => {
  const proxy = readFileSync(join(process.cwd(), 'app/lib/.server/agent/proxy.ts'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  /* CONTROL — the scan can see the code it judges. A scan matching nothing is all-clear forever. */
  it('reads a real proxy.ts that really does replay provider messages', () => {
    expect(proxy).toContain('export async function runAgentGeneration');
    expect(proxy).toContain('first.response');
  });

  it('never reads response messages without stripping replayed thinking', () => {
    const replays = [...proxy.matchAll(/\(await first\.response\)\.messages/g)];

    /* CONTROL — the three known passes are still here, so the assertion below is about something. */
    expect(replays.length).toBeGreaterThanOrEqual(3);

    for (const replay of replays) {
      const line = proxy.slice(proxy.lastIndexOf('\n', replay.index) + 1, replay.index! + replay[0].length);

      expect(line).toContain('stripReplayedReasoning(');
    }
  });
});
