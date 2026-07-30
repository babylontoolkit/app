import { describe, expect, it, vi } from 'vitest';
import { applyCreationDraft, draftTextForSeed, type CreationDraftDeps } from './new-project-draft';

/**
 * A recording harness. The ORDER is the feature (a prefill written before `clearDraftPrompt` is wiped by
 * a debounced timer, not by the next statement), so every dep appends to one shared log and the tests
 * assert on the log rather than on call counts alone.
 */
function harness() {
  const calls: string[] = [];
  const applied: string[] = [];
  const carets: number[] = [];

  const deps: CreationDraftDeps = {
    clearDraft: vi.fn(() => {
      calls.push('clear');
    }),
    applyDraft: vi.fn((text: string) => {
      calls.push('apply');
      applied.push(text);
    }),
    focusDraft: vi.fn((caret: number) => {
      calls.push('focus');
      carets.push(caret);
    }),
  };

  return { calls, applied, carets, deps };
}

describe('draftTextForSeed', () => {
  it('carries a typed prompt byte-exactly — the user gets their OWN words back', () => {
    const typed = '  Make a  neon racing game with "drift" boost pads\n';
    expect(draftTextForSeed({ prompt: typed })).toBe(typed);
  });

  /*
   * The wizard compiles a long brief into `prompt` and shows a short line in its place. A textbox holds
   * what the user saw, never the machine's compiled brief.
   */
  it('prefers visiblePrompt when it differs from the compiled prompt', () => {
    expect(
      draftTextForSeed({ prompt: 'COMPILED BRIEF: genre=racing; track=city; …', visiblePrompt: 'A city racer' }),
    ).toBe('A city racer');
  });

  it('is empty for the card path and for whitespace-only or absent input', () => {
    expect(draftTextForSeed({})).toBe('');
    expect(draftTextForSeed(null)).toBe('');
    expect(draftTextForSeed(undefined)).toBe('');
    expect(draftTextForSeed({ prompt: '   \n\t ' })).toBe('');
    expect(draftTextForSeed({ prompt: 'typed', visiblePrompt: '   ' })).toBe('');
  });
});

describe('applyCreationDraft', () => {
  // "Edit brief" on the handoff card.
  it('clears, then fills, then focuses with the caret at the end', () => {
    const { calls, applied, carets, deps } = harness();
    const typed = 'A city racer with drift boost pads';

    expect(applyCreationDraft(typed, deps, { focus: true })).toBe(typed);

    // 🔴 The mutation-critical assertion: moving the fill before the clear must fail here.
    expect(calls).toEqual(['clear', 'apply', 'focus']);
    expect(applied).toEqual([typed]);
    expect(carets).toEqual([typed.length]);
  });

  /*
   * The card's X. Dismissing a panel is not a request to start typing: the text is preserved in the box,
   * but the caret is left wherever the user had it.
   */
  it('fills without focusing when focus is false', () => {
    const { calls, applied, deps } = harness();

    expect(applyCreationDraft('A city racer', deps, { focus: false })).toBe('A city racer');
    expect(calls).toEqual(['clear', 'apply']);
    expect(applied).toEqual(['A city racer']);
    expect(deps.focusDraft).not.toHaveBeenCalled();
  });

  /*
   * "Describe your game" — the card path, where there are no words. Nothing is written over the input
   * the clear just emptied, but focus IS taken: the user pressed a button asking to type.
   */
  it.each([
    ['empty string', ''],
    ['nothing at all', null],
    ['undefined', undefined],
  ])('%s: clears and focuses an empty box, writing nothing', (_label, text) => {
    const { calls, carets, deps } = harness();

    expect(applyCreationDraft(text, deps, { focus: true })).toBe('');
    expect(calls).toEqual(['clear', 'focus']);
    expect(carets).toEqual([0]);
    expect(deps.applyDraft).not.toHaveBeenCalled();
  });

  it('focuses by default — only the X opts out', () => {
    const { calls, deps } = harness();

    applyCreationDraft('A city racer', deps);
    expect(calls).toEqual(['clear', 'apply', 'focus']);
  });

  it('the caret offset is the full length even when the text has trailing whitespace', () => {
    const { carets, deps } = harness();
    const typed = 'a racer\n\n';

    applyCreationDraft(typed, deps, { focus: true });
    expect(carets).toEqual([typed.length]);
  });
});
