/**
 * WHAT A USER MESSAGE SAYS — and therefore what Copy puts on the clipboard (owner, 2026-08-09).
 *
 * The rule worth pinning is a single one: **the clipboard gets what the user can SEE.** A user message
 * on the wire is not what the user typed — the client prepends a machine-generated `<boltArtifact>` of
 * every file edited in the workbench, and upstream's BYOK path adds `[Model: …]` / `[Provider: …]` tags.
 * The bubble has always hidden all of that. A Copy button that read the raw content instead would put
 * tens of kilobytes of file bodies on the clipboard from a message that reads as one line — and the
 * user would only discover it when they pasted it somewhere.
 */
import { describe, expect, it } from 'vitest';
import { copyableUserMessageText, userMessageText } from './user-message-text';

const ARTIFACT =
  '<boltArtifact id="restored-files" title="Modified files">' +
  '<boltAction type="file" filePath="src/scripts/KartMode.ts">export class KartMode {}</boltAction>' +
  '</boltArtifact>';

describe('userMessageText', () => {
  it('returns a plain message untouched', () => {
    expect(userMessageText('/bt-execute _specs/kart_plan.md ALL')).toBe('/bt-execute _specs/kart_plan.md ALL');
  });

  /*
   * 🔴 The one that matters. This is the shape the client actually sends after the user has edited a
   * file in the workbench: the artifact rides in front of their words, invisible in the chat.
   */
  it('drops a machine-prepended artifact and keeps the words', () => {
    expect(copyableUserMessageText(`${ARTIFACT}\n\nadd a boost pad to the second lap`)).toBe(
      'add a boost pad to the second lap',
    );
  });

  it('drops an artifact that landed in the middle of the message', () => {
    expect(copyableUserMessageText(`before\n${ARTIFACT}\nafter`)).toBe('before\n\nafter');
  });

  it('drops the model and provider tags', () => {
    expect(copyableUserMessageText('[Model: claude-opus-5]\n\n[Provider: Anthropic]\n\nmake it faster')).toBe(
      'make it faster',
    );
  });

  it('reads the text item out of multimodal content', () => {
    expect(
      copyableUserMessageText([
        { type: 'text', text: `${ARTIFACT}\n\nlike this reference` },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ]),
    ).toBe('like this reference');
  });

  /*
   * An image-only message renders a bubble with no words in it. Empty is how the component knows not to
   * offer a Copy button there — one that reported success over an empty clipboard is worse than none.
   */
  it.each([
    ['no text item', [{ type: 'image', image: 'data:image/png;base64,AAAA' }]],
    ['an empty array', []],
    ['an artifact and nothing else', ARTIFACT],
    ['whitespace only', '   \n\n  '],
  ])('is empty for %s', (_label, content) => {
    expect(copyableUserMessageText(content as any)).toBe('');
  });
});

/*
 * The display string is deliberately NOT trimmed — `Markdown` has received it untrimmed since upstream,
 * and quietly changing what is RENDERED was not part of adding a copy button. Only the clipboard copy
 * trims, where a trailing blank line left by a stripped artifact is pure noise in whatever the user
 * pastes into.
 */
describe('display vs clipboard', () => {
  it('trims for the clipboard and not for the bubble', () => {
    const raw = `${ARTIFACT}\n\nadd a boost pad\n`;

    expect(userMessageText(raw)).toBe('\n\nadd a boost pad\n');
    expect(copyableUserMessageText(raw)).toBe('add a boost pad');
  });

  /* CONTROL — one function feeds both, so they can only ever differ by that trim. */
  it('otherwise copies exactly what is displayed', () => {
    const raw = `${ARTIFACT}\n\nline one\n\nline two`;

    expect(copyableUserMessageText(raw)).toBe(userMessageText(raw).trim());
  });
});
