/**
 * THE FIRST BUILD TURN — the composition (T10).
 *
 * `composeNewProjectTurn` decides what reaches the model on the most expensive turn in the product, and
 * every way it can be wrong is silent:
 *
 *   - a MANGLED brief (trimmed, prefixed, re-wrapped) loses `CREATION_BRIEF_MARKER`, and with it the ten
 *     server behaviours that hang off that one string — the generation still runs, worse and dearer;
 *   - a MANGLED user message changes the sidebar title, the transcript, and every later turn's history;
 *   - a MISSING `annotations: ['hidden']` puts the machine-written brief in the user's face as if they
 *     had typed it;
 *   - the WRONG ORDER makes the brief the thing the project is named after.
 *
 * So the assertions here are byte-level and exhaustive, not shape-level.
 */
import { describe, expect, it } from 'vitest';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import { composeNewProjectTurn } from './new-project-send';

/** A realistic brief: the marker, then the facts creation knew at the moment they were true. */
const BRIEF = [
  CREATION_BRIEF_MARKER,
  '',
  'Scaffolded class: ArcadeRacingMode (src/scripts/ArcadeRacingMode.ts)',
  'Images on disk: public/assets/track.png, public/assets/car.png',
  'Enter gameplay ONLY via navigate("/play", { gameMode: "ArcadeRacingMode" }).',
].join('\n');

describe('composeNewProjectTurn', () => {
  it('returns the user’s words first and the hidden brief second', () => {
    const composed = composeNewProjectTurn({ userText: 'build my kart racer', brief: BRIEF });

    expect(composed).toHaveLength(2);
    expect(composed[0].content).toBe('build my kart racer');
    expect(composed[1].content).toBe(BRIEF);
  });

  /**
   * 🔴 The marker is the whole contract with the server. Not "contains something like it" — the exact
   * string, unmoved and unaltered, inside the message that is actually posted.
   */
  it('carries CREATION_BRIEF_MARKER verbatim in the brief message', () => {
    const [, brief] = composeNewProjectTurn({ userText: 'build my kart racer', brief: BRIEF });

    expect(brief.content).toContain(CREATION_BRIEF_MARKER);
    expect(brief.content.indexOf(CREATION_BRIEF_MARKER)).toBe(BRIEF.indexOf(CREATION_BRIEF_MARKER));
  });

  it('never leaks the marker into the visible message', () => {
    const [visible] = composeNewProjectTurn({ userText: 'build my kart racer', brief: BRIEF });

    expect(visible.content).not.toContain(CREATION_BRIEF_MARKER);
  });

  /** The brief is passed through byte-for-byte — no trim, no re-wrap, no separator injected. */
  it('passes the brief through byte-exact, including its own surrounding whitespace', () => {
    const padded = `\n\n  ${BRIEF}  \n`;
    const [, brief] = composeNewProjectTurn({ userText: 'go', brief: padded });

    expect(brief.content).toBe(padded);
  });

  describe('the user’s text is preserved byte-exact', () => {
    it.each([
      ['plain', 'build my kart racer'],
      ['leading and trailing whitespace', '   build my kart racer\n\n'],
      ['a model/provider envelope', '[Model: claude-opus-5]\n\n[Provider: Anthropic]\n\nbuild my kart racer'],
      ['newlines and tabs', 'line one\n\tline two\r\nline three'],
      ['a lone slash-prefixed sentence', '/clear the obstacles from the track'],
      ['unicode and emoji', 'un jeu de course 🏎️ — très rapide'],
      ['markup that must not be escaped', '<boltArtifact id="x">& < > "quoted"</boltArtifact>'],
    ])('%s', (_label, userText) => {
      const [visible] = composeNewProjectTurn({ userText, brief: BRIEF });

      expect(visible.content).toBe(userText);
    });
  });

  describe('annotations', () => {
    it('marks ONLY the brief hidden', () => {
      const [visible, brief] = composeNewProjectTurn({ userText: 'build my kart racer', brief: BRIEF });

      expect(visible.annotations).toBeUndefined();
      expect(brief.annotations).toEqual(['hidden']);
    });

    /** A brief posted alone is still hidden — the transcript must never show machine text as the user's. */
    it('keeps the brief hidden even when it is the only message', () => {
      const composed = composeNewProjectTurn({ userText: '', brief: BRIEF });

      expect(composed).toHaveLength(1);
      expect(composed[0].annotations).toEqual(['hidden']);
    });
  });

  describe('empty inputs', () => {
    it('empty user text posts the brief alone — no blank bubble', () => {
      const composed = composeNewProjectTurn({ userText: '', brief: BRIEF });

      expect(composed.map((message) => message.content)).toEqual([BRIEF]);
    });

    it('an empty brief posts the user’s words alone', () => {
      const composed = composeNewProjectTurn({ userText: 'build my kart racer', brief: '' });

      expect(composed).toEqual([{ content: 'build my kart racer' }]);
    });

    /** Whitespace is not a brief. Sending it would spend a wire slot on nothing at all. */
    it('a whitespace-only brief is treated as no brief', () => {
      const composed = composeNewProjectTurn({ userText: 'build my kart racer', brief: '  \n\t\n ' });

      expect(composed).toEqual([{ content: 'build my kart racer' }]);
    });

    /**
     * Whitespace IS a user message, though — it is bytes the user typed, and the caller (not this
     * function) decides whether an all-whitespace send happens at all.
     */
    it('a whitespace-only user message is still posted, unaltered', () => {
      const composed = composeNewProjectTurn({ userText: '   ', brief: BRIEF });

      expect(composed).toHaveLength(2);
      expect(composed[0].content).toBe('   ');
    });

    it('both empty composes nothing', () => {
      expect(composeNewProjectTurn({ userText: '', brief: '' })).toEqual([]);
    });
  });

  it('is pure — it invents nothing and returns a fresh array each call', () => {
    const input = { userText: 'build my kart racer', brief: BRIEF };
    const first = composeNewProjectTurn(input);
    const second = composeNewProjectTurn(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(input).toEqual({ userText: 'build my kart racer', brief: BRIEF });
  });
});
