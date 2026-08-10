/**
 * THE HANDOFF BRANCH (§4.4a) — which of two genuinely different moments the card is looking at.
 *
 * Two properties are asserted here, and each one fails silently in a different direction:
 *
 *   - **`build` carries the prompt BYTE-EXACT.** The card displays these bytes and the Build button
 *     sends them. A trim here would be invisible on screen (the blockquote is `whitespace-pre-wrap`, so
 *     a stripped leading newline just looks like a tidier card) while quietly editing the one prompt in
 *     the product the user did not just type and cannot retype from memory. Nothing would throw; the
 *     model would simply be sent something the user never wrote.
 *
 *   - **Whitespace-only is NOT a brief.** A box holding a stray newline passes a naive `if (userPrompt)`
 *     and would put "Build my game" on screen with nothing to send — posting an empty turn, or inviting
 *     the model to invent a brief, on the most expensive generation in the product. This is the reason
 *     the branch is a pure function instead of a JSX conditional: it is one character away from wrong
 *     and there is no other place to pin it.
 */
import { describe, expect, it } from 'vitest';
import { briefFromRegistryEntry, decideCreationHandoff, planCommandFor } from './creation-handoff';
import { parseSlashInvocation } from '~/lib/skills/slash';

describe('decideCreationHandoff — there are words to send', () => {
  it('offers build for typed words', () => {
    expect(decideCreationHandoff({ userPrompt: 'a kart racer with boost pads' })).toEqual({
      kind: 'build',
      prompt: 'a kart racer with boost pads',
    });
  });

  /*
   * The bytes travel untouched. Leading/trailing whitespace and interior newlines are all preserved —
   * a multi-line brief is the normal shape for a considered one, and reformatting it is editing the
   * user's words.
   */
  it('carries the prompt byte-exact, preserving leading, trailing and interior whitespace', () => {
    const typed = '\n  a kart racer\n\n  with boost pads on the second lap  \n';

    const decision = decideCreationHandoff({ userPrompt: typed });

    expect(decision.kind).toBe('build');
    expect(decision.prompt).toBe(typed);
  });

  /* Words with whitespace around them are still words — the trim decides, it never edits. */
  it('treats padded words as a brief and still does not trim them', () => {
    expect(decideCreationHandoff({ userPrompt: '   build me a platformer   ' })).toEqual({
      kind: 'build',
      prompt: '   build me a platformer   ',
    });
  });
});

describe('decideCreationHandoff — there is nothing to send', () => {
  /*
   * The card path: a genre was picked from a card and the box was left empty, so there were never any
   * words. `describe` points the user at the chat box rather than pretending it can build from nothing.
   */
  it('offers describe when there was no prompt at all', () => {
    expect(decideCreationHandoff({})).toEqual({ kind: 'describe', prompt: '' });
    expect(decideCreationHandoff({ userPrompt: undefined })).toEqual({ kind: 'describe', prompt: '' });
  });

  it('offers describe for an empty string', () => {
    expect(decideCreationHandoff({ userPrompt: '' })).toEqual({ kind: 'describe', prompt: '' });
  });

  /*
   * 🔴 The load-bearing case. Every one of these renders as an empty card and passes `if (userPrompt)`.
   * Offering Build on any of them spends a real generation on nothing.
   */
  it.each([[' '], ['   '], ['\n'], ['\n\n  \t'], ['\t'], ['\r\n']])(
    'treats whitespace-only (%j) as no brief and normalises it away',
    (blank) => {
      expect(decideCreationHandoff({ userPrompt: blank })).toEqual({ kind: 'describe', prompt: '' });
    },
  );

  /*
   * `describe` reports an EMPTY prompt, never the whitespace it rejected. The card's describe action
   * calls back with this value, and handing the chat box a stray newline to "edit" would reintroduce the
   * leftover-state feeling the card exists to remove.
   */
  it('never leaks the rejected whitespace back out as the prompt', () => {
    expect(decideCreationHandoff({ userPrompt: '\n \t ' }).prompt).toBe('');
  });
});

describe('briefFromRegistryEntry — a picked GAME TYPE card is a brief', () => {
  const RACING = {
    title: 'Arcade Racing',
    description: 'Drive fast. Karts, cars, drifting, laps and boost — a racer you can play in a minute.',
  };

  /*
   * The behaviour the owner asked for. Before this, clicking a card and typing nothing reached the
   * handoff with no words, so the card offered "Describe your game" — asking the user to type out the
   * genre they had just picked from a menu.
   */
  it('carries the card title and its copy, verbatim', () => {
    expect(briefFromRegistryEntry(RACING)).toBe(
      'Arcade Racing — Drive fast. Karts, cars, drifting, laps and boost — a racer you can play in a minute.',
    );
  });

  /*
   * 🔴 The fallback row means "I do not have a brief yet". Turning it into one would build a random game
   * out of a request for a blank page — and it is exactly the case the describe path exists for.
   */
  it('returns nothing for the fallback row, so Blank Canvas still offers Describe', () => {
    expect(
      briefFromRegistryEntry({
        title: 'Blank Canvas',
        description: 'An empty scene that always compiles. Total creative freedom.',
        is_fallback: true,
      }),
    ).toBeUndefined();
  });

  /*
   * `undefined`, never `''`. The caller passes the result straight through as `visiblePrompt`, and an
   * empty string is a value that has to be re-checked at every downstream step instead of being absent.
   */
  it('reports absence as undefined rather than an empty string', () => {
    expect(briefFromRegistryEntry({ title: '   ', description: '  ' })).toBeUndefined();
  });

  it('degrades to whichever half exists', () => {
    expect(briefFromRegistryEntry({ title: 'Physics Playground', description: '' })).toBe('Physics Playground');
    expect(briefFromRegistryEntry({ title: '', description: 'Total freedom.' })).toBe('Total freedom.');
  });

  /*
   * The result feeds `decideCreationHandoff`, so the two must agree: a carried card brief has to reach
   * the BUILD branch, or the fix changes nothing the user can see.
   */
  it('produces a brief that the handoff decision routes to Build', () => {
    expect(decideCreationHandoff({ userPrompt: briefFromRegistryEntry(RACING) }).kind).toBe('build');
  });

  it('leaves the fallback row on the describe branch', () => {
    const brief = briefFromRegistryEntry({ title: 'Blank Canvas', description: 'Empty.', is_fallback: true });
    expect(decideCreationHandoff({ userPrompt: brief }).kind).toBe('describe');
  });
});

/**
 * 🔴 A CARD WITH MISSING COPY MUST NOT STOP THE PROJECT BEING CREATED.
 *
 * The registry is data, so a row with no `description` is a content mistake — but the first draft of
 * `briefFromRegistryEntry` called `.trim()` on it directly, and the `TypeError` escaped through
 * `handleSelectEntry`, so clicking that card created NOTHING. Caught by 26 unrelated wiring tests going
 * red, which is the only reason it was not shipped: no pure test had a reason to pass a partial row.
 */
describe('briefFromRegistryEntry never throws on an incomplete registry row', () => {
  it.each([
    ['no description', { title: 'Arcade Racing' }],
    ['no title', { description: 'Drive fast.' }],
    ['neither', {}],
    ['fallback with neither', { is_fallback: true }],
  ])('survives a row with %s', (_label, entry) => {
    expect(() => briefFromRegistryEntry(entry)).not.toThrow();
  });

  it('still returns the title when only the copy is missing', () => {
    expect(briefFromRegistryEntry({ title: 'Arcade Racing' })).toBe('Arcade Racing');
  });
});

/**
 * THE PLAN COMMAND (owner, 2026-08-09) — the card's third action.
 *
 * The button that used to save the untouched starter to GitHub now writes `/bt-plan <brief>` into the
 * chat box, so the user can plan the build instead of one-shotting it. It is asserted against the REAL
 * `parseSlashInvocation` rather than against a string shape, because the only thing that matters about
 * the composed text is what the server makes of it: a command the parser does not recognise falls
 * through as ordinary prose, which builds the game exactly as if the button had not been pressed —
 * silently, and on the most expensive turn in the product.
 */
describe('planCommandFor', () => {
  it('addresses the brief to the planning skill', () => {
    expect(planCommandFor('a kart racer with boost pads')).toBe('/bt-plan a kart racer with boost pads');
  });

  /*
   * The carried prompt comes out of a textarea and routinely has leading whitespace. `parseSlashInvocation`
   * trims the args itself, so this changes nothing on the wire — it stops the chat box showing `/bt-plan`
   * alone on the first line, which reads as a command that lost its argument.
   */
  it('does not leave the command dangling above its brief', () => {
    expect(planCommandFor('\n  a kart racer\n')).toBe('/bt-plan a kart racer');
  });

  it.each([
    ['plain', 'a kart racer'],
    ['padded', '\n  a kart racer\n\n  with boost pads  \n'],
    ['multi-line', 'a kart racer\n\nwith boost pads on the second lap'],
  ])('parses as a bt-plan invocation carrying the whole brief (%s)', (_label, brief) => {
    const invocation = parseSlashInvocation(planCommandFor(brief));

    expect(invocation?.name).toBe('bt-plan');
    expect(invocation?.args).toBe(brief.trim());
  });

  /*
   * Unreachable from the card — Plan only exists on the `build` branch, which is defined by having words
   * — and pinned so it can never become the thing that turns an empty box into a bare invocation.
   */
  it('still leaves the caret after the command when there is no brief', () => {
    expect(planCommandFor('   ')).toBe('/bt-plan ');
  });
});
