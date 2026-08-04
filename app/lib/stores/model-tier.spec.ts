/**
 * DISPLAY NAMES FOR THE TRI-FAMILY LADDER (§4.6.1a, FR8 of `_specs/kie-tri-api-models_spec.md`).
 *
 * `parseModel` is the single choke point through which every rung's model id becomes words on screen —
 * the pill's label and tooltip, and every row of the picker. Its ONE rule is that it derives those words
 * from the id's SHAPE and never from a table of ids the build was taught at compile time.
 *
 * That is not tidiness. The id arrives from the server (`modelTiersSessionHint` sends a per-tier `model`
 * resolved from the operator's `*_MODEL` selectors, §4.2a — swapping a rung's model is a CONFIG
 * operation with no redeploy), so a client-side table is guaranteed to be out of date on the day a
 * family ships a model and there is nothing to notice: the pill goes on rendering, just wrongly or
 * blankly, on the one control whose whole job is naming what the user is spending on.
 *
 * So this file pins three things that can each fail silently:
 *
 * 1. the CLAUDE regression bar — the names that shipped before the tri-family change are byte-identical;
 * 2. the derivation for all three families, including the dash-to-dot version rule;
 * 3. structurally, that the store holds no hardcoded model-id list — with CONTROLS proving the scanner
 *    reads real content and would actually catch one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasModelChoice, parseModel } from './model-tier';

describe('parseModel — the CLAUDE regression bar', () => {
  /**
   * 🔴 THE NAMES THAT ALREADY SHIPPED DO NOT MOVE.
   *
   * Every one of these is on a live pill today. Generalising the parser to read `gpt-*`/`gemini-*` is
   * only safe if the family it already read comes out byte-identical — a regression here renames the
   * model on the most-looked-at control in the toolbar, and nothing throws.
   */
  it('renders the shipped Claude ladder ids exactly as before', () => {
    expect(parseModel('claude-fable-5')).toEqual({ short: 'Fable', full: 'Fable 5' });
    expect(parseModel('claude-opus-4-8')).toEqual({ short: 'Opus', full: 'Opus 4.8' });
    expect(parseModel('claude-opus-5')).toEqual({ short: 'Opus', full: 'Opus 5' });
    expect(parseModel('claude-sonnet-5')).toEqual({ short: 'Sonnet', full: 'Sonnet 5' });
    expect(parseModel('claude-haiku-4-5')).toEqual({ short: 'Haiku', full: 'Haiku 4.5' });
  });

  /**
   * The vendor word is DROPPED for Claude and KEPT for the other two, and that asymmetry is deliberate:
   * Anthropic's marketing name is "Opus 5", Google's is "Gemini 3.5 Flash". The parser follows the
   * names, not a uniform rule, and this pins that it has not been "tidied" into `Claude Opus 5` — which
   * would be both wrong and the widest label the toolbar has ever had to fit.
   */
  it('drops the Claude vendor word and keeps the GPT/Gemini family word', () => {
    expect(parseModel('claude-opus-5').full).not.toContain('Claude');
    expect(parseModel('gpt-5-6-sol').full).toContain('GPT');
    expect(parseModel('gemini-3-5-flash').full).toContain('Gemini');
  });
});

describe('parseModel — the three families', () => {
  /** The acceptance names these directly: `gpt-5-6-sol` → "GPT 5.6 Sol". */
  it('renders the GPT family, initialism uppercased and the version dotted', () => {
    expect(parseModel('gpt-5-6-sol')).toEqual({ short: 'GPT', full: 'GPT 5.6 Sol' });
    expect(parseModel('gpt-5-6-luna')).toEqual({ short: 'GPT', full: 'GPT 5.6 Luna' });
    expect(parseModel('gpt-5-6-terra')).toEqual({ short: 'GPT', full: 'GPT 5.6 Terra' });
  });

  it('renders the Gemini family', () => {
    expect(parseModel('gemini-3-5-flash')).toEqual({ short: 'Gemini', full: 'Gemini 3.5 Flash' });
    expect(parseModel('gemini-3-5-pro').full).toBe('Gemini 3.5 Pro');
  });

  /**
   * 🔴 THE DASH-TO-DOT RULE IS THE WHOLE DERIVATION, so it is pinned on its own.
   *
   * KIE's API ids cannot carry a `.`, so a marketing "5.6" reaches us as two segments. A RUN of numeric
   * segments is one version number; a numeric segment that follows a word starts a new one. Get this
   * wrong in the obvious way (join everything with spaces) and the pill reads "GPT 5 6 Sol" — which
   * looks like two models, and is exactly the kind of wrong that reads as a rendering glitch rather
   * than as a lie about what is running.
   */
  it('joins a RUN of numeric segments with dots and never across a word', () => {
    expect(parseModel('gpt-5-6-sol').full).toBe('GPT 5.6 Sol');
    expect(parseModel('gpt-5-6-sol').full).not.toContain('5 6');
    expect(parseModel('acme-1-2-3-turbo').full).toBe('Acme 1.2.3 Turbo');

    // A second version AFTER a word is its own number, not a continuation of the first.
    expect(parseModel('acme-1-2-turbo-3').full).toBe('Acme 1.2 Turbo 3');
  });

  /** A vowel-less segment is an initialism; anything else is a word. Derived, never a list of acronyms. */
  it('uppercases a vowel-less segment and title-cases the rest', () => {
    expect(parseModel('gpt-5').full).toBe('GPT 5');
    expect(parseModel('xyz-2-nova').full).toBe('XYZ 2 Nova');
    expect(parseModel('nova-2-flash').full).toBe('Nova 2 Flash');
  });
});

describe('parseModel — an id it cannot read', () => {
  /**
   * 🔴 AN UNRECOGNISED ID RETURNS ITSELF — it must never blank the pill or throw.
   *
   * `LLM_MODEL` and the rung selectors are operator config that can name a model this build has never
   * heard of, in a shape no convention here covers. A parser that returned `''` for one would leave the
   * one control whose whole job is naming the model in use showing nothing at all; one that guessed
   * would name the wrong thing with the same confidence as the right thing.
   */
  it('returns an unparseable id verbatim rather than throwing or blanking', () => {
    for (const id of ['', 'claude', 'gpt', 'some-vendor/model:1', 'us.anthropic.claude', 'model_5_6', 'a--b']) {
      expect(parseModel(id), id).toEqual({ short: id, full: id });
    }
  });

  /** No version segment at all → not a model name shape we can read, so it is left alone. */
  it('leaves a dashed id with no numeric segment alone', () => {
    expect(parseModel('some-fast-model')).toEqual({ short: 'some-fast-model', full: 'some-fast-model' });
  });
});

/**
 * 🔴 STRUCTURAL: THE STORE KNOWS NO MODEL IDS.
 *
 * Every assertion above is satisfied by a hardcoded `Record<string, string>` of the six ids the ladder
 * happens to ship today — which is precisely the implementation FR8 forbids, because its failure mode is
 * invisible: the seventh model renders as a raw id, or (worse, if someone adds a fuzzy match) as the
 * sixth model's name. So the source itself is scanned.
 *
 * The scan is default-deny on the id SHAPE rather than on a list of known ids: a list would have to be
 * updated in lockstep with the thing it is policing, which is the same defect one level up.
 */
describe('model-tier.ts holds no model-id table', () => {
  const source = readFileSync(fileURLToPath(new URL('./model-tier.ts', import.meta.url)), 'utf8');

  /** Comments legitimately quote ids as EXAMPLES (`gpt-5-6-sol` → 'GPT 5.6 Sol'); only code is policed. */
  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** A quoted string that looks like a versioned model id — `'gpt-5-6-sol'`, `"claude-opus-5"`. */
  const idLiterals = (text: string) => text.match(/['"`][a-z]+(-[a-z0-9]+)*-[0-9][a-z0-9-]*['"`]/gi) ?? [];

  it('CONTROL — the scanner reads real content, and the comment strip does not eat the code', () => {
    const code = stripComments(source);

    expect(code, 'the strip left no code behind').toContain('export function parseModel');
    expect(code, 'the doc-comment examples were stripped').not.toContain('marketed "GPT 5.6 Sol"');
  });

  it('CONTROL — the detector really does flag a hardcoded id table', () => {
    const planted = stripComments(`const MODELS = { 'gpt-5-6-sol': 'GPT 5.6 Sol', "claude-opus-5": 'Opus 5' };`);

    expect(idLiterals(planted)).toEqual(["'gpt-5-6-sol'", '"claude-opus-5"']);
  });

  it('has no model-id string literals in its code', () => {
    expect(idLiterals(stripComments(source))).toEqual([]);
  });

  /**
   * The one family word the code is allowed to know is `claude`, and only as the vendor prefix its
   * branch strips. The moment a `gpt`/`gemini` branch appears in code, the parser has become the
   * per-family table this rule exists to prevent — so the DISTINCT set is pinned, not a count (a count
   * moves whenever the Claude branch is refactored, and a test that has to be retuned gets retuned).
   */
  it('names exactly one family word in code, and it is the Claude prefix it strips', () => {
    const code = stripComments(source);
    const families = code.match(/\b(claude|gpt|gemini|codex|opus|sonnet|fable|haiku|luna|terra)\b/gi) ?? [];

    expect([...new Set(families.map((f) => f.toLowerCase()))]).toEqual(['claude']);
  });
});

describe('hasModelChoice', () => {
  it('is a choice only when more than one rung is serveable', () => {
    expect(hasModelChoice([{ serveable: true }])).toBe(false);
    expect(hasModelChoice([{ serveable: true }, { serveable: false }])).toBe(false);
    expect(hasModelChoice([{ serveable: true }, { serveable: true }])).toBe(true);
    expect(hasModelChoice([])).toBe(false);
  });
});
