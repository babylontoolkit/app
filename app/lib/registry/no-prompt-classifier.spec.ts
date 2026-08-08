/**
 * WHO DECIDES WHETHER A CREATION DOES THE LANDING/CHROME PASS (§4.4c, T11) — the structural guard.
 *
 * The answer must be: **the model, from the user's own request**, resolved against an instruction with a
 * stated default that lives in the creation brief. Never a keyword table, a substring check or a regex in
 * THIS repo.
 *
 * That is not a style preference. This family of bug has already cost real money twice, and both times it
 * failed silently — nothing threw, the platform kept working, the model was just fed the wrong
 * instructions:
 *
 *   - The skills router was a hardcoded `Record<string, string[]>` of substrings. `'ui'` matched as a bare
 *     substring, so `"why is my build failing"` (b-**ui**-ld) inlined a 24KB design skill on a debugging
 *     question, while three synced skills had no entry and could never load at all. The owner's verdict:
 *     *"what we have now I'd be better off making a prompt library… which defeats the whole point of
 *     skills."*
 *   - `effort-policy.ts` states the same rule for spend — decide by turn KIND, never by reading the
 *     prompt, *"because a prose classifier puts the model in charge of the bill"*.
 *
 * A behavioural test cannot see this coming back: a keyword table produces a perfectly working creation
 * that redesigns the wrong projects. So the guard is structural, in the `skill-selection.spec.ts` /
 * `outbound-enumerate.spec.ts` shape — it reads the source, and it carries CONTROLS proving the reader
 * still sees anything at all. A scan that silently matches nothing forever is worse than no scan.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every file on the creation path that touches the user's words: where the brief is written, where the
 * prompt is carried back to the textbox, where the first build turn is composed, and where the brief is
 * stored in between.
 */
const CREATION_PATH = [
  'app/lib/registry/create-project.ts',
  'app/lib/chat/new-project-send.ts',
  'app/lib/chat/new-project-draft.ts',
  'app/lib/stores/new-project-mode.ts',
];

/**
 * 🔴 **DELIBERATELY OUT OF SCOPE: `app/lib/registry/match.ts`.**
 *
 * It keyword-scores the prompt against `match_keywords` on purpose — that is §4.4a genre seeding, which
 * picks which STARTER a "make me a kart racer" clones, and it is explicit user input being matched against
 * a curated registry the owner controls. It decides no model behaviour, spends no tokens, and is visible
 * to the user (they can override it in the wizard). The rule this file enforces is narrower: nothing on
 * the creation path may read the user's words to decide what the MODEL is told to do.
 *
 * This exemption is written down because an omission that is only in someone's head is how a default-deny
 * scan becomes decorative — the next reader finds `match.ts` unscanned, assumes the list is arbitrary, and
 * adds their own file to the "obviously fine" pile.
 */
const DELIBERATELY_UNSCANNED = ['app/lib/registry/match.ts'];

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf-8');
}

/**
 * Strip comments and string/template literals, leaving executable code.
 *
 * Both halves are load-bearing. **Comments** are documentation: the post-mortems above quote the dead
 * keywords by name, and `create-project.ts`'s own header explains the rule using the words it forbids.
 * **String and template literals** are the BRIEF ITSELF — prose telling the model to decide, which
 * necessarily contains "landing", "game" and "narrow change". Scanning either would flag the fix as the
 * bug.
 *
 * Hand-written rather than a regex because the brief nests a template literal inside an interpolation
 * (`${images.map((p) => `- ${p}`)}`), which no single regex handles. Regex literals are deliberately left
 * intact — a planted `/game|racing/.test(prompt)` must remain visible — which is safe only while no regex
 * in these files contains a quote character; the CONTROLS below prove the scanner did not run away.
 */
function codeOnly(source: string, options: { keepQuoted?: boolean } = {}): string {
  const { keepQuoted = false } = options;

  let out = '';
  let i = 0;

  // Template-literal `${…}` nesting: each entry is the brace depth inside the current interpolation.
  const templateStack: number[] = [];

  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (two === '/*') {
      i += 2;

      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        i++;
      }
      i += 2;
      continue;
    }

    const char = source[i];

    if (char === "'" || char === '"') {
      const quote = char;
      const start = i;
      i++;

      while (i < source.length && source[i] !== quote) {
        i += source[i] === '\\' ? 2 : 1;
      }
      i++;

      /*
       * The literal's CONTENT is dropped; the empty quotes stay so the surrounding call is still visible.
       * `keepQuoted` is the exception, and exists for exactly one check: a word list is only recognisable
       * as a word list by its WORDS. Template literals are still stripped even then — the brief is a
       * template literal, and its prose is the instruction this scan protects, not a violation.
       */
      out += keepQuoted ? source.slice(start, i) : `${quote}${quote}`;
      continue;
    }

    if (char === '`') {
      i++;

      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }

        if (source[i] === '`') {
          i++;
          break;
        }

        if (source.slice(i, i + 2) === '${') {
          // Interpolations are CODE — keep scanning them, and remember to return to the literal.
          templateStack.push(0);
          out += ' ';
          i += 2;
          break;
        }

        i++;
      }

      continue;
    }

    if (templateStack.length > 0 && char === '{') {
      templateStack[templateStack.length - 1]++;
    }

    if (templateStack.length > 0 && char === '}') {
      if (templateStack[templateStack.length - 1] === 0) {
        // End of the interpolation — back into the surrounding template literal's prose.
        templateStack.pop();
        i++;

        while (i < source.length) {
          if (source[i] === '\\') {
            i += 2;
            continue;
          }

          if (source[i] === '`') {
            i++;
            break;
          }

          if (source.slice(i, i + 2) === '${') {
            templateStack.push(0);
            i += 2;
            break;
          }

          i++;
        }

        out += ' ';
        continue;
      }

      templateStack[templateStack.length - 1]--;
    }

    out += char;
    i++;
  }

  return out;
}

/**
 * Identifiers that hold the user's words on this path.
 *
 * `title` is in the list deliberately: on the New Project path the title is DERIVED from the prompt
 * (`project.ts` names the project from what the user typed), so `title.includes('racing')` is the same
 * classifier wearing a different variable name — and it is the one a well-meaning edit reaches for first,
 * because the title is right there in `createProjectFromRegistry`'s options. Verified safe: no file on
 * this path calls a method on `title` at all.
 */
const PROMPT_ID = '(?:user|visible|project)?(?:prompt|text|message|request|brief|words|title)';

/** Operations that only make sense if you are CLASSIFYING that text. */
const CLASSIFY_OP = '(?:includes|indexOf|search|match|matchAll|startsWith|endsWith|test|exec|split)';

/**
 * 🔴 **ONE LEVEL OF ALIASING IS ALL IT TAKES TO HIDE FROM A NAME-BASED SCAN.**
 *
 * Matching only calls made DIRECTLY on a prompt-named identifier means this walks straight past:
 *
 * ```ts
 * const lower = userText.toLowerCase();
 * if (lower.includes('racing') || /shooter|platformer/.test(lower)) { … }
 * ```
 *
 * That is not an exotic evasion — it is how anyone would naturally write the check, because lower-casing
 * once and testing many times is the obvious shape. A scan that a reasonable refactor defeats is a scan
 * that reports "clean" forever.
 *
 * So any local assigned from something prompt-ish becomes prompt-TAINTED for the rest of its file, and
 * classifying it is the same violation as classifying the original. Deliberately one hop and file-local:
 * this is a regex, not a type checker, and a scan whose own logic nobody can follow gets deleted the
 * first time it is inconvenient. Two hops is the honest limit of what a reader can verify by eye — and a
 * classifier laundered through two variables still has to CALL something, on a name this file can see.
 */
function taintedIdentifiers(code: string): string[] {
  const promptish = new RegExp(`\\b${PROMPT_ID}\\b`, 'i');
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]+)/g;

  const tainted = new Set<string>();

  // Two passes so `const a = prompt…; const b = a…;` is caught — the second hop, and no further.
  for (let pass = 0; pass < 2; pass++) {
    for (const [, name, rhs] of code.matchAll(declaration)) {
      const carriesPromptText = promptish.test(rhs) || [...tainted].some((id) => new RegExp(`\\b${id}\\b`).test(rhs));

      if (carriesPromptText) {
        tainted.add(name);
      }
    }
  }

  return [...tainted];
}

/** Words that only appear in a list because someone is sorting requests into genres. */
const GENRE_WORD =
  /\b(?:game|games|racing|racer|kart|shooter|platformer|rpg|puzzle|shmup|landing|website|webpage|homepage|splash|preloader|chrome|redesign|design)\b/i;

/** An array literal holding two or more quoted strings — read with `keepQuoted`, so the words are visible. */
const STRING_ARRAY = /\[\s*(?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))+\s*,?\s*\]/g;

/**
 * Every violation the scanner can see in a file, named.
 *
 * Takes RAW source and does its own stripping, because the checks need two different views of it: the
 * classification checks read code with ALL literals removed (the brief's prose must never be scanned),
 * while the word-list check needs the quoted strings kept — a genre list is only recognisable by its
 * words.
 */
function findClassifiers(source: string): string[] {
  const code = codeOnly(source);
  const withWords = codeOnly(source, { keepQuoted: true });

  // The prompt itself, plus everything one or two assignments downstream of it.
  const subjects = [PROMPT_ID, ...taintedIdentifiers(code)].join('|');
  const subject = `(?:${subjects})`;

  const violations: { name: string; hit: boolean }[] = [
    {
      name: "a substring/regex check ON the prompt or an alias of it (`lower.includes('racing')`)",
      hit: new RegExp(`\\b${subject}\\b(?:\\s*\\.\\s*\\w+\\s*\\([^)]*\\))*\\s*\\.\\s*${CLASSIFY_OP}\\s*\\(`, 'i').test(
        code,
      ),
    },
    {
      name: 'a check run AGAINST the prompt or an alias (`/game|racing/.test(lower)`, `WORDS.includes(lower)`)',
      hit: new RegExp(`\\.\\s*${CLASSIFY_OP}\\s*\\(\\s*[\\w.?[\\]]*\\b${subject}\\b`, 'i').test(code),
    },
    {
      name: 'a keyword table (`const LANDING_KEYWORDS = [...]`)',
      hit: /\b[A-Z][A-Z0-9_]*_(?:KEYWORDS?|WORDS|TRIGGERS?|PHRASES)\b/.test(code),
    },
    {
      name: "a genre/keyword word list (`const landingWords = ['landing', 'game']`) — casing is not the tell",
      hit: [...withWords.matchAll(STRING_ARRAY)].some((match) => GENRE_WORD.test(match[0])),
    },
    {
      name: 'a skill/behaviour router keyed by trigger words (`Record<string, string[]>`)',
      hit: /Record\s*<\s*string\s*,\s*string\s*\[\s*\]\s*>/.test(code),
    },
  ];

  return violations.filter(({ hit }) => hit).map(({ name }) => name);
}

describe('CONTROLS — the scanner works, and is looking at the right thing', () => {
  it('reads real code from every file on the creation path', () => {
    for (const file of CREATION_PATH) {
      const code = codeOnly(read(file));

      expect(code.length, file).toBeGreaterThan(200);
      expect(code, file).toMatch(/export (async )?(function|const|interface)/);
    }

    // The brief lives here; if this import ever moves, the scan is pointed at the wrong file.
    expect(codeOnly(read('app/lib/registry/create-project.ts'))).toContain('buildCreationBrief');
  });

  it('strips comments — a post-mortem naming the dead keywords does not count as one', () => {
    const raw = read('app/lib/registry/create-project.ts');
    const code = codeOnly(raw);

    // The module header quotes the substring that matched b-ui-ld, and the rule it broke.
    expect(raw).toContain("`'ui'`");
    expect(raw).toContain('keyword table');
    expect(code).not.toContain("'ui'`");
    expect(code).not.toContain('keyword table');
  });

  it('strips the brief prose — the INSTRUCTION telling the model to decide is not a classifier', () => {
    const code = codeOnly(read('app/lib/registry/create-project.ts'));

    // These words are in the brief, and only in the brief.
    expect(read('app/lib/registry/create-project.ts')).toContain('A single narrow change');
    expect(code).not.toContain('A single narrow change');
    expect(code).not.toContain('bt-landing skill');

    // ...but the code around the prose survived, so the strip did not swallow the file.
    expect(code).toContain('function buildCreationBrief');
    expect(code).toContain('scaffolded');
    expect(code).toContain('listAvailableImages');
  });

  it('DETECTS a planted violation — each shape of the bug that has actually shipped here', () => {
    const planted = [
      "const wantsLanding = prompt.toLowerCase().includes('landing');",
      'if (/game|racing|shooter/i.test(userText)) { designTheFrontend(); }',
      "const LANDING_KEYWORDS = ['landing', 'website', 'page'];",
      "const ROUTER: Record<string, string[]> = { 'bt-landing': ['ui', 'design'] };",
      'if (userMessage.match(/rotating cube/)) { skipChrome(); }',
      "const narrow = ['just', 'only'].some((word) => visiblePrompt.includes(word));",

      // The same classifier through the DERIVED title — the variable a creation-path edit reaches first.
      "const isRacer = title.toLowerCase().includes('racing');",
    ];

    for (const snippet of planted) {
      expect(findClassifiers(snippet), snippet).not.toHaveLength(0);
    }
  });

  /*
   * The two shapes that defeated the FIRST draft of this scan, both found by review rather than by the
   * scan itself — which is the whole argument for keeping planted controls: a scanner is only as good as
   * the evasions someone has actually tried against it.
   */
  it('DETECTS the evasions a name-based scan walks past: an alias, and a lowercase word list', () => {
    const aliased = [
      'const lower = userText.toLowerCase();',
      "if (lower.includes('racing') || /shooter|platformer/.test(lower)) { designTheFrontend(); }",
    ].join('\n');

    expect(findClassifiers(aliased), 'one intermediate variable must not hide a classifier').not.toHaveLength(0);

    // Two hops, the honest limit — still caught.
    const twoHops = [
      'const words = prompt.trim();',
      'const lower = words.toLowerCase();',
      "lower.includes('kart');",
    ].join('\n');

    expect(findClassifiers(twoHops), 'two hops must not hide a classifier').not.toHaveLength(0);

    // A word list in lower camelCase — SCREAMING_CASE was never the tell, the WORDS are.
    const lowercaseTable = [
      "const landingWords = ['racing', 'shooter', 'platformer'];",
      'const wantsLanding = landingWords.some((word) => lower.includes(word));',
    ].join('\n');

    expect(findClassifiers(lowercaseTable), 'a lowercase genre list must be caught').not.toHaveLength(0);

    // The list consulted the other way round — the prompt as the ARGUMENT, not the receiver.
    expect(findClassifiers('const isGame = landingWords.includes(userText.toLowerCase());')).not.toHaveLength(0);
  });

  it('does NOT flag the legitimate code these files really contain', () => {
    const legitimate = [
      // `listAvailableImages` — a regex over FILE PATHS, which is not the user's words.
      'files.filter((file) => /^(src\\/assets|public)\\//.test(file.path) && /\\.(png|svg)$/i.test(file.path));',

      // `new-project-draft.ts` — measuring the carried text is not classifying it.
      "const text = seed?.visiblePrompt ?? seed?.prompt ?? ''; return text.trim().length === 0 ? '' : text;",

      // `new-project-send.ts` — deciding whether there is anything to send is not reading what it says.
      'if (userText.length > 0) { messages.push({ content: userText }); }',
      "if (brief.trim().length > 0) { messages.push({ content: brief, annotations: ['hidden'] }); }",

      // A list of strings that is not a genre list: file extensions, phase names, reserved words.
      "const IMAGE_EXTENSIONS = ['.png', '.jpg', '.webp'];",
      "bootProgress.set({ step: 'creating-mount' }); const phases = ['creating-starter', 'creating-mount'];",
    ];

    for (const snippet of legitimate) {
      expect(findClassifiers(snippet), snippet).toEqual([]);
    }
  });
});

describe('the creation path classifies nothing — the model decides, from the request', () => {
  for (const file of CREATION_PATH) {
    it(`${file} contains no keyword or regex classification of the user's prompt`, () => {
      expect(findClassifiers(read(file))).toEqual([]);
    });
  }

  /*
   * The exemption is asserted, not just asserted-in-a-comment: `match.ts` must still exist and must still
   * be the genre seeder it is exempted for. If it is ever deleted or repurposed, this fails and the next
   * reader re-decides the exemption instead of inheriting it.
   */
  it('exempts only the §4.4a genre seeder, and says so out loud', () => {
    for (const file of DELIBERATELY_UNSCANNED) {
      expect(CREATION_PATH).not.toContain(file);

      const source = read(file);
      expect(source).toContain('match_keywords');
      expect(findClassifiers(source), `${file} is exempt precisely BECAUSE it classifies`).not.toHaveLength(0);
    }
  });

  /*
   * The brief must still SAY it, or there is nothing for the model to resolve — a scan that only proves
   * the absence of a keyword table would pass just as happily on a brief that had lost the instruction.
   */
  it('states the decision as an instruction the model resolves', () => {
    const brief = read('app/lib/registry/create-project.ts');

    expect(brief).toMatch(/user's own message above is the request/i);
    expect(brief).toMatch(/it is the DEFAULT whenever the request is not plainly narrow/i);
    expect(brief).toMatch(/A single narrow change/);
  });
});

/**
 * 🔴 WHO DECIDES WHICH DOCUMENTATION THE MODEL GETS (§4.3, Phase 2, 2026-08-08).
 *
 * The same rule, one subsystem over, and it is here because the doc router was the FOURTH instance of
 * this bug and the only one that survived the previous three fixes. It also failed the most expensively:
 *
 *   - it matched `'touch'` inside `"untouched defaults"` and `'video'` inside `generate_video`;
 *   - the text it actually ran against was the platform's own HIDDEN creation brief, not the user's
 *     request — so measured on the live prompt version, `"mario kart racer clone"` and
 *     `"a chess puzzle game"` received **byte-identical sets of ten documents, 61.6k tokens**, and the
 *     user's own words contributed nothing at all;
 *   - the phrase `"make me a kart racing game"`, added to that brief as an EXAMPLE, dragged the racing
 *     corpus into every project on the platform by itself.
 *
 * Documents are now chosen by the model from `description` fields via `load_reference`. This scan is what
 * stops a keyword table growing back — including the tempting "small" version, a fixed set of documents
 * picked by matching a couple of words, which is how the last one started.
 */
const DOC_SELECTION_PATH = [
  'app/lib/.server/prompt/sources.ts',
  'app/lib/.server/prompt/reference-index.ts',
  'app/lib/.server/agent/reference-tools.ts',
];

describe('the documentation path classifies nothing either — the model chooses from descriptions', () => {
  it('CONTROL — reads real code from every file on the doc-selection path', () => {
    for (const file of DOC_SELECTION_PATH) {
      const code = codeOnly(read(file));

      expect(code.length, file).toBeGreaterThan(200);
      expect(code, file).toMatch(/export (async )?(function|const|interface)/);
    }
  });

  for (const file of DOC_SELECTION_PATH) {
    it(`${file} contains no keyword or regex classification of the user's request`, () => {
      expect(findClassifiers(read(file))).toEqual([]);
    });
  }

  /*
   * The router's own remains. `keywords:` was a FIELD on every block, so its absence is the single
   * cheapest proof that the table is gone and has not been rebuilt under a new name — and unlike the
   * `findClassifiers` scan above, this one cannot be satisfied by moving the table to another file,
   * because the blocks themselves live here.
   */
  it('holds no keyword field on any reference document', () => {
    const code = codeOnly(read('app/lib/.server/prompt/sources.ts'));

    expect(code).not.toMatch(/\bkeywords\b/);
    expect(code).not.toMatch(/selectOnDemandBlocks|selectStickyBlocks/);
  });

  /*
   * And the positive half, for the same reason the creation brief's instruction is asserted above: a scan
   * proving only the ABSENCE of a keyword table would pass just as happily on a system that had lost the
   * descriptions too — which is not "the model decides", it is "nobody decides", and the failure is
   * silent (the model writes Toolkit code from general knowledge and nothing throws).
   */
  it('replaces it with a description the model reads, and a tool that returns the document', () => {
    const sources = read('app/lib/.server/prompt/sources.ts');
    const tools = read('app/lib/.server/agent/reference-tools.ts');

    expect(codeOnly(sources)).toMatch(/\bdescription\b/);
    expect(tools).toContain('load_reference');

    /*
     * The budget is enforced in `execute` (never a zod constraint — that kills the generation AFTER the
     * tokens are spent) and CHECKED BEFORE the store read, so an over-budget call cannot even pay for a
     * lookup. Asserting the ORDER is what makes this about the rule rather than about the message.
     */
    const code = codeOnly(tools);
    const budget = code.indexOf('>= MAX_REFERENCE_LOADS');
    const storeRead = code.indexOf('readOnDemand');

    expect(budget, 'the budget check is gone').toBeGreaterThan(-1);
    expect(storeRead, 'the store read is gone').toBeGreaterThan(-1);
    expect(budget, 'the budget must be checked BEFORE the store read').toBeLessThan(storeRead);
  });
});
