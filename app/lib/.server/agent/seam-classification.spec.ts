/**
 * `spec/agent-seams.md` MUST STAY TRUE, AND THE ONLY THING THAT CAN MAKE IT STAY TRUE IS A TEST.
 *
 * The document names three phases — ASSEMBLE, STREAM, TOOL — and files every module the agent
 * pipeline invokes under one of them. It is worth having for exactly one reason: `request-invariants`
 * evaluates at every ASSEMBLE point, and three of those points are reached from STREAM output
 * (`stripReplayedReasoning`, the retry, the completeness pass). A reader who files those wrong builds
 * a verifier that only ever sees the first request.
 *
 * 🔴 **DEFAULT-DENY, AND ENUMERATED FROM THE IMPORTS.** The list of participants is read out of
 * `proxy.ts` and `api.agent.ts` themselves, never from a roster in this file. A roster is precisely
 * how the original outbound-spend sweep missed five routes: it enumerated the doors somebody had
 * thought of, and the sixth door walked straight past it. A module that appears in an import and not
 * in the document is a FAILING TEST, not a footnote.
 *
 * ⚠️ **Do not silence a failure by adding an allow-list entry.** `NOT_A_PARTICIPANT` is for modules
 * genuinely outside the request pipeline — a logger, a constants file, a marker string. Each entry
 * carries a prose reason with a length floor (`outbound-enumerate.spec.ts`'s rule), and a staleness
 * check fails when an entry names a module nothing imports any more, so the list cannot quietly
 * accumulate. A real participant parked there is a lie with a passing test in front of it.
 *
 * ⚠️ CONTROLS at the bottom: a scanner whose pattern silently stops matching reports a clean bill of
 * health forever.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The two modules that BUILD and RUN a generation. Everything either of them invokes is in scope. */
const PIPELINE = ['app/lib/.server/agent/proxy.ts', 'app/routes/api.agent.ts'];

const DOC = 'spec/agent-seams.md';

/** The ONE reference form the document is allowed to use, because it is the one that can be checked. */
const CHECKED_REFERENCE = /`((?:proxy|api\.agent)\.ts):(\d+)` \(`(\w+)`\)/g;

/** Comments in both files quote module names constantly; a scan that counts prose proves nothing. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

/**
 * Modules that are imported but are not part of the pipeline. The reason must say WHY, and the
 * staleness check below fails if one stops being imported — an allow-list nobody prunes is how a
 * default-deny scan turns back into an allow-list.
 */
const NOT_A_PARTICIPANT: Record<string, string> = {
  'app/utils/logger.ts':
    'A logger. It observes the pipeline and participates in none of its phases; classifying it would make the phase column meaningless.',
  'app/utils/constants.ts':
    'A constants module (`PROVIDER_LIST`). It is data the assembly reads, not a step the assembly runs.',
  'app/types/creation.ts':
    'A marker string (`CREATION_BRIEF_MARKER`) compared against message text. Data, not a participant.',
  'app/types/message-marks.ts':
    'Two annotation marker constants written onto the stream by the route. Data, not a participant.',
  'app/lib/.server/env.ts':
    'The environment reader. Every phase reads config through it, which is the same as saying it belongs to none of them.',
};

/** Resolve an import specifier the way the bundler does, to a repo-relative file that exists. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;

  if (spec.startsWith('~/')) {
    base = `app/${spec.slice(2)}`;
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = normalize(join(dirname(fromFile), spec));
  } else {
    /* A package. Not ours to classify. */
    return null;
  }

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(join(root, candidate))) {
      return candidate;
    }
  }

  return null;
}

/**
 * Every module the pipeline imports a VALUE from.
 *
 * ⚠️ Type-only imports are excluded on purpose: a `type` import cannot run, so it cannot participate
 * in a phase. That exclusion is asserted by a CONTROL below, because "we skipped some" is exactly the
 * shape a scan uses to under-report.
 */
function participants(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();

  for (const file of PIPELINE) {
    const source = read(file);

    for (const match of source.matchAll(/^import\s+(type\s+)?([\s\S]*?)from\s+['"]([^'"]+)['"];/gm)) {
      const [, typeOnly, clause, spec] = match;

      if (typeOnly) {
        continue;
      }

      const names = clause
        .replace(/[{}]/g, ' ')
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0 && !n.startsWith('type '));

      if (names.length === 0) {
        continue;
      }

      const resolved = resolveSpecifier(spec, file);

      if (!resolved) {
        continue;
      }

      found.set(resolved, new Set([...(found.get(resolved) ?? []), ...names]));
    }
  }

  return found;
}

/** The prose floor `outbound-enumerate.spec.ts` uses: a reason short enough to be a label is not one. */
const MIN_REASON_CHARS = 30;

describe('every agent-pipeline participant is classified in spec/agent-seams.md', () => {
  it('classifies every module the pipeline invokes', () => {
    const doc = read(DOC);
    const unclassified = [...participants().keys()]
      .filter((module) => !(module in NOT_A_PARTICIPANT))
      .filter((module) => !doc.includes(module));

    expect(
      unclassified,
      'a new participant must be filed under a phase in spec/agent-seams.md — do NOT add it to NOT_A_PARTICIPANT',
    ).toEqual([]);
  });

  /*
   * 🔴 THE LINE NUMBERS ARE VERIFIED, NOT TRUSTED — and this test exists because they rotted once
   * already, in the branch that shipped them.
   *
   * The table was generated correctly against `proxy.ts` and was then invalidated by this very
   * feature's own tasks, which added ~220 lines to that file. 64 of 75 references were wrong on the
   * day the document shipped: `effortForTurn @ :1788` pointed at a comment terminator and
   * `getGenerationLog @ :2841` at a `} finally {`. That is precisely the failure the document's own
   * header names — *"a document
   * that rots is worse than no document, because it is read as current"* — arriving inside the
   * document that names it.
   *
   * A line number cannot be kept correct by intention. Every claimed `file:line (symbol)` is checked
   * here against the real file, so the table fails loudly the moment it drifts instead of quietly
   * becoming fiction. ⚠️ Do NOT "fix" a failure here by deleting the reference: regenerate it.
   */
  it('every invocation line it claims really contains the symbol it claims', () => {
    const doc = read(DOC);
    const claims = [...doc.matchAll(CHECKED_REFERENCE)];

    expect(claims.length, 'the reference format changed — this scan is reading nothing').toBeGreaterThan(40);

    /*
     * 🔴 EVERY reference in the document, not the ones that happen to match. The first version of this
     * scan anchored on a markdown TABLE CELL, so it checked 68 references and silently ignored 20 more
     * living in prose — 17 of which were stale at exactly the offsets that failed this task the first
     * time. The guard had been fitted to the subset somebody had already fixed.
     *
     * That is the "a detector that decides which routes matter reproduces the original bug with a
     * regex" failure this repo has recorded before. So the count of CHECKED references must equal the
     * count of references that EXIST — otherwise a reference can be exempted forever by rephrasing the
     * sentence around it, which a verifier demonstrated by smuggling `proxy.ts:99999` past the scan
     * with two extra words.
     */
    /*
     * ⚠️ NO leading backtick in this pattern: requiring one left `(proxy.ts:99999)` able to evade the
     * count entirely, which is the same hole one character narrower. It must match a reference however
     * it is written.
     */
    const everyReference = doc.match(/(?:proxy|api\.agent)\.ts:\d+/g) ?? [];

    expect(
      claims.length,
      'a file:line reference exists that this scan does not check — put it in the `file:NNN` (`symbol`) form',
    ).toBe(everyReference.length);

    /* A bare `:NNN` continuation names no symbol, so nothing can verify it. They are not allowed. */
    expect(doc.match(/`:\d+(?:-\d+)?`/g), 'a bare line-number continuation cannot be checked').toBeNull();

    const wrong: string[] = [];

    for (const [, file, lineNumber, symbol] of claims) {
      const path = file === 'proxy.ts' ? PIPELINE[0] : PIPELINE[1];
      const line = read(path).split('\n')[Number(lineNumber) - 1] ?? '';

      if (!new RegExp(`\\b${symbol}\\b`).test(line)) {
        wrong.push(`${file}:${lineNumber} claims \`${symbol}\` but reads: ${line.trim().slice(0, 70)}`);
      }
    }

    expect(wrong, 'regenerate these references — do not delete them').toEqual([]);
  });

  it('names all three phases and defines their boundary', () => {
    const doc = read(DOC);

    expect(doc).toContain('ASSEMBLE');
    expect(doc).toContain('STREAM');
    expect(doc).toContain('TOOL');
    expect(doc).toMatch(/## The three phases/);
  });

  /*
   * The straddlers are the whole reason the document is worth writing — they are the rows a reader
   * would file wrong. Each must be named WITH its reason, not merely listed.
   */
  it('names the straddlers and says why each one straddles', () => {
    const doc = read(DOC);

    for (const straddler of [
      'stripReplayedReasoning',
      'agent/tool-policy.ts',
      'agent/budgets.ts',
      'agent/delivery.ts',
      'agent/preload-skills.ts',
      'prompt/cache-warmer.ts',
    ]) {
      expect(doc, `${straddler} must be named as a straddler`).toContain(straddler);
    }

    expect(doc).toMatch(/## The straddlers/);
    expect(doc).toMatch(/two different exports/);
  });

  it('records what was rejected, with a reason', () => {
    const doc = read(DOC);

    expect(doc).toMatch(/## What is deliberately REJECTED/);

    for (const rejected of ['plugin registry', 'event emitter', 'Reversible effects', 'Cordis']) {
      expect(doc, `${rejected} must be recorded as rejected`).toContain(rejected);
    }

    expect(doc, "§4.2's stance is the reason, and it must be quoted").toMatch(/do not re-architect/);
    expect(doc, "the brief's own sentence is the decision").toMatch(/not worth a rewrite now/i);
  });

  /*
   * ⚠️ `MAX_MEDIA_ROUNDS` was deleted 2026-08-08 by owner decision. A classification asserting the
   * constant would describe a budget that does not exist — the class of false-claim-in-a-document
   * this whole file is here to prevent.
   */
  it('does not assert a constant that no longer exists', () => {
    expect(read(DOC)).not.toMatch(/MAX_MEDIA_ROUNDS(?!\` does not exist| no longer exists)/);
    expect(codeOnly(read('app/lib/.server/agent/media-tools.ts'))).not.toContain('MAX_MEDIA_ROUNDS');
  });
});

describe('the allow-list stays an exception, not a second roster', () => {
  it('gives every entry a reason long enough to be one', () => {
    for (const [module, reason] of Object.entries(NOT_A_PARTICIPANT)) {
      expect(reason.trim().length, `${module}'s reason is too short to be a reason`).toBeGreaterThan(MIN_REASON_CHARS);
    }
  });

  /* An allow-list nobody prunes is how a default-deny scan turns back into an allow-list. */
  it('has no stale entry — every allow-listed module is still imported', () => {
    const imported = new Set(participants().keys());
    const stale = Object.keys(NOT_A_PARTICIPANT).filter((module) => !imported.has(module));

    expect(stale, 'these modules are no longer imported; remove them from NOT_A_PARTICIPANT').toEqual([]);
  });

  it('stays small — it is an exception list', () => {
    expect(Object.keys(NOT_A_PARTICIPANT).length).toBeLessThan(10);
  });
});

/**
 * CONTROLS. Every assertion above rests on a regex over files that are edited constantly, and on a
 * resolver that silently returns `null` for anything it cannot find.
 */
describe('CONTROLS — the scanner still reads the modules it thinks it does', () => {
  it('found the real pipeline modules', () => {
    for (const file of PIPELINE) {
      const source = read(file);

      expect(source.length, `${file} reads as suspiciously small`).toBeGreaterThan(5_000);
    }

    expect(read(PIPELINE[0])).toContain('runAgentGeneration');
    expect(read(PIPELINE[1])).toContain('runAgentGeneration');
  });

  /*
   * 🔴 THE CONTROL THAT MATTERS. The resolver returns `null` for a package or a path it cannot find,
   * and every `null` silently drops a module from the scan. If the resolver broke, `participants()`
   * would return a handful of entries and this suite would pass on a pipeline it never read.
   */
  it('resolved a realistic number of participants, and known ones are among them', () => {
    const found = participants();

    expect(found.size, 'the resolver is dropping modules').toBeGreaterThan(50);

    for (const known of [
      'app/lib/.server/agent/tool-policy.ts',
      'app/lib/.server/agent/budgets.ts',
      'app/lib/.server/agent/delivery.ts',
      'app/lib/.server/llm/history.ts',
      'app/lib/.server/billing/gate.ts',
      'app/lib/.server/agent/shell-strip.ts',
    ]) {
      expect([...found.keys()], `${known} must be enumerated`).toContain(known);
    }
  });

  it('resolves the two specifier spellings of ONE module to the same path', () => {
    /*
     * `proxy.ts` writes `./delivery` and `api.agent.ts` writes `~/lib/.server/agent/delivery`. If the
     * resolver kept them apart, the document would need two rows for one module and the phase
     * classification would disagree with itself.
     */
    expect(resolveSpecifier('./delivery', PIPELINE[0])).toBe('app/lib/.server/agent/delivery.ts');
    expect(resolveSpecifier('~/lib/.server/agent/delivery', PIPELINE[1])).toBe('app/lib/.server/agent/delivery.ts');
  });

  it('returns null for a package and for a path that does not exist', () => {
    expect(resolveSpecifier('ai', PIPELINE[0])).toBeNull();
    expect(resolveSpecifier('~/lib/.server/agent/no-such-module', PIPELINE[0])).toBeNull();
  });

  it('excludes type-only imports, and that exclusion is doing real work', () => {
    const found = participants();

    /* `~/types/model` is imported `import type` by both files and must not appear. */
    expect([...found.keys()]).not.toContain('app/types/model.ts');

    /* …but a VALUE import from a sibling path does appear, so the filter is not eating everything. */
    expect([...found.keys()]).toContain('app/types/message-marks.ts');
  });

  it('strips comments rather than matching prose', () => {
    const stripped = codeOnly(['/* MAX_MEDIA_ROUNDS */', 'const real = 1;', '// MAX_MEDIA_ROUNDS'].join('\n'));

    expect(stripped).toContain('const real = 1;');
    expect(stripped).not.toContain('MAX_MEDIA_ROUNDS');
  });

  it('reads the document, and it is a real document', () => {
    const doc = read(DOC);

    expect(doc.length).toBeGreaterThan(3_000);
    expect(doc).toContain('Adding a participant');
    expect(doc).toMatch(/## The participants/);
  });
});
