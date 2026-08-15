/**
 * AC-5 — THE BINARY PREVIEW READS NO BYTES, AND THAT IS A STRUCTURAL RULE (SPEC §4.1b, T6).
 *
 * The whole design of the Code-view binary preview is that it points an element at the project's own
 * running dev server instead of pulling bytes into the tab. Everything good about it follows from that
 * one property: video and audio arrive over HTTP RANGE REQUESTS (a 200 MB capture seeks instantly and
 * never enters the heap), there is no object-URL lifetime to leak, §4.2.8 is untouched because nothing
 * reaches the model, and the `readFile`-bytes-are-on-loan detachment class — Nodepod's `readFile`
 * returns a live view into its own VFS, and transferring it detached the store out from under every
 * later serialization — cannot be re-entered because no read happens at all.
 *
 * 🔴 **A `Blob` is the obvious spelling, and it works.** That is exactly what makes this worth pinning:
 * someone adding a "download this asset" button, or a cache, or a thumbnail, reaches for
 * `readBinaryFile` → `new Blob` → `createObjectURL` and gets a working feature with none of the four
 * properties above, and nothing throws. `BinaryPreview.tsx`'s doc comment states the rule — and a rule
 * that lives only in a comment is one nobody is keeping (`sandbox-seam.spec.ts`'s opening lesson: the
 * "no new WebContainer coupling" rule was prose for the whole build, and by the time anyone tested it
 * twenty modules had broken it).
 *
 * The scan is written the way this codebase's other scans are written, and every clause is there
 * because its absence has burned this repo before:
 *
 *   - **Comments are stripped first.** Not a nicety here: `BinaryPreview.tsx`'s doc comment *genuinely
 *     names all three forbidden APIs*, deliberately, because stating the rule where the code is edited
 *     is worth more than the scan's convenience. So the strip is load-bearing on real source, and the
 *     CONTROL below asserts precisely that — raw source contains the needle, stripped source does not.
 *   - **`SELF` is excluded BY EXACT PATH, never by a `*.spec.ts` pattern.** This file names all five
 *     forbidden strings as data, so it would flag itself. Excluding by pattern is the documented bug
 *     that let `mount-tree.spec.ts` sit on a real `@webcontainer/api` import unnoticed.
 *   - **The scan set is DISCOVERED, not typed out.** An explicit three-file list is a list of the doors
 *     someone thought of, and the third door walks past it (`coversWorkspace`'s lesson). A new
 *     `BinaryPreviewVideo.tsx`, or a `media-kind-2.ts`, is scanned the day it lands — but ONLY because
 *     it matches one of the name stems below. A differently-named sibling (`MediaPane.tsx`) is not, and
 *     neither is `CodeMirrorEditor.tsx`, the PARENT that renders this component and could read bytes
 *     and hand them down as a prop (verified zero occurrences today, and unscanned tomorrow). The
 *     narrowness is deliberate — an over-broad wall gets silenced by appending to its allow-list — but
 *     it is a tradeoff, not a proof.
 *   - **CONTROLS.** A scan that silently matches nothing reports a clean bill of health forever. That
 *     trap has now been hit three times in this codebase, so every needle here is paired with a proof
 *     that it is findable at all, and every scanned file with a proof that it was really read.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_DIR = join(process.cwd(), 'app');

/**
 * Comments are documentation, not behaviour. Same helper as `sandbox-seam.spec.ts` — deliberately the
 * same two-line shape rather than a better one, so there is one strip in this repo and not two.
 *
 * ⚠️ **The controls below catch a strip that eats EVERYTHING, not a strip that eats a little.** They
 * assert length and a marker, so a wholesale failure is caught and a LOCALISED swallow is not: a
 * string literal containing an unterminated block-comment opener starts a comment that runs to the
 * next closer and takes real code with it. Demonstrated, not theorised — a `readBinaryFile` call
 * hidden in that window passes every assertion in this file. Stated because the earlier draft of this
 * sentence claimed the controls covered it, and a false claim in a comment is how three defects in
 * this codebase survived review.
 */
function sourceWithoutComments(absPath: string): string {
  return readFileSync(absPath, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') {
      continue;
    }

    const abs = join(dir, entry);

    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (/\.tsx?$/.test(abs)) {
      out.push(abs);
    }
  }

  return out;
}

const toRepoPath = (abs: string) => relative(process.cwd(), abs).replace(/\\/g, '/');

/**
 * The feature's surface, by NAME rather than by a fixed list.
 *
 * Deliberately narrow: `app/lib/preview/` also holds the §preview-tools debugging channel
 * (`agent-script.ts`, `bridge.ts`, `protocol.ts`, `install.ts`), which is a different feature that may
 * legitimately need a `Blob` one day. Scanning a whole directory because the files happen to be
 * adjacent would produce a wall that an unrelated author trips and silences by appending — and an
 * allow-list entry added to make a red test green is how a real regression hides.
 */
const FEATURE_PATTERNS: RegExp[] = [
  /^app\/components\/editor\/codemirror\/BinaryPreview[^/]*\.tsx?$/,
  /^app\/lib\/preview\/media-kind[^/]*\.tsx?$/,
  /^app\/lib\/preview\/project-file-url[^/]*\.tsx?$/,
  /^app\/lib\/preview\/binary-preview-guards[^/]*\.tsx?$/,
];

/** This file. Excluded by EXACT PATH — see the header for why a pattern is not good enough. */
const SELF = join(APP_DIR, 'lib/preview/binary-preview-guards.spec.ts');

/**
 * Files the scan discovers but does not enforce, each with a written reason.
 *
 * Empty today, and it must be argued into rather than appended to: an entry here is a statement that
 * this particular file may read binary bytes, which is the one thing the feature is defined by not
 * doing. The list exists so that the answer to a red test is a decision, not a deletion.
 */
const EXEMPT: Record<string, string> = {};

/**
 * The production modules that MUST be under the scan. Discovery is the wall; this is the tripwire on
 * the wall — a rename or a move would otherwise empty the scan set and every assertion below would
 * pass by looking at nothing.
 *
 * The value is a marker that must survive comment stripping, which is how each file proves it was
 * actually read as CODE rather than as an empty string.
 */
const REQUIRED: Record<string, string> = {
  'app/components/editor/codemirror/BinaryPreview.tsx': 'export function BinaryPreview',
  'app/lib/preview/project-file-url.ts': 'export function previewUrlForProjectFile',
  'app/lib/preview/media-kind.ts': 'export function mediaKindForPath',
};

/**
 * The five spellings of "this component pulled the bytes into the tab".
 *
 * `readBinaryFile` subsumes `workbenchStore.readBinaryFile`, and both are listed on purpose: the
 * qualified form is what a reader searching for the rule will actually type, and a needle list is
 * documentation as much as it is a matcher.
 */
const FORBIDDEN = [
  'readBinaryFile',
  'workbenchStore.readBinaryFile',
  'sandbox.fs.readFile',
  'createObjectURL',
  'new Blob',
] as const;

const SCANNED: string[] = walk(APP_DIR)
  .filter((abs) => abs !== SELF)
  .map(toRepoPath)
  .filter((file) => FEATURE_PATTERNS.some((pattern) => pattern.test(file)))
  .filter((file) => !(file in EXEMPT))
  .sort();

const strippedOf = (file: string) => sourceWithoutComments(join(process.cwd(), file));

describe('AC-5 — the binary preview never reads bytes', () => {
  it.each(FORBIDDEN)('no file in the feature calls %s', (needle) => {
    const offenders = SCANNED.filter((file) => strippedOf(file).includes(needle));

    expect(offenders).toEqual([]);
  });

  it('every production module of the feature is actually under the scan', () => {
    /*
     * Without this the scan is only as good as the glob: rename `media-kind.ts` and the set silently
     * shrinks, the `it.each` above passes on whatever is left, and the guard reports success while
     * guarding two files. The same shape as `map-exclusions.spec.ts`'s membership pin — a
     * parameterized test over a list cannot notice the list shrinking.
     */
    for (const file of Object.keys(REQUIRED)) {
      expect(SCANNED, `${file} is no longer being scanned — did it move?`).toContain(file);
    }
  });

  it('every exemption still names a file that exists and is still discovered', () => {
    /*
     * An exemption for a file that no longer exists is a wall guarding nothing, and the next reader
     * takes it as precedent that this area is exempt (`sandbox-seam.spec.ts`'s stale-entry rule).
     */
    const discovered = walk(APP_DIR)
      .map(toRepoPath)
      .filter((file) => FEATURE_PATTERNS.some((pattern) => pattern.test(file)));

    for (const file of Object.keys(EXEMPT)) {
      expect(discovered, `${file} is exempt but no longer part of the feature — drop the entry`).toContain(file);
    }
  });
});

/*
 * ── THE EDITOR'S HALF OF THE WIRING (owner, 2026-08-15 — the SVG source toggle) ────────────────────
 *
 * `BinaryPreview.spec.tsx` proves the component behaves correctly GIVEN its props. Nothing there can
 * see whether the editor passes them, and this repo's own record is that the defects live in exactly
 * that gap: `applyCreationDraft`'s options object was dropped at the call site with every pure test
 * green, and `budgets-wiring.spec.ts` exists because every seam takes its budgets OPTIONALLY, so a
 * caller that forgets one runs on the default with the constant still perfectly correct.
 *
 * Both halves here fail silently and in opposite directions:
 *
 *   - drop `isPreviewableTextMedia` from the mount condition → `doc.isBinary` is false for markup, so
 *     the viewer never mounts and SVG quietly goes back to opening as source. The owner's request is
 *     undone by a deletion that reads like a simplification.
 *   - drop `sourceAvailable={!doc.isBinary}` → it defaults to `false`, the toggle disappears, and an
 *     SVG becomes a picture you cannot edit. Worse the other way: hardcode it `true` and every binary
 *     offers a Source button onto the CodeMirror that `if (doc.isBinary) return;` never populated.
 *
 * ⚠️ This does NOT put `CodeMirrorEditor.tsx` under the FORBIDDEN byte-reading scan above — that set is
 * deliberately narrow, and its header already records the parent as scanned-nowhere. These are separate
 * assertions about separate strings; widening the other scan is its own decision.
 */
const EDITOR = 'app/components/editor/codemirror/CodeMirrorEditor.tsx';

/** Whitespace-normalised so a Prettier reflow of the JSX is not a red test. */
const editorSource = () => strippedOf(EDITOR).replace(/\s+/g, ' ');

describe('the editor wires the preview — props, not just presence', () => {
  it('mounts BinaryPreview for a binary OR a previewable text medium', () => {
    /*
     * The condition is asserted as a WHOLE. `toContain('isPreviewableTextMedia')` would pass for an
     * import that is never called, and for a call whose result is discarded — the same "a guard whose
     * result is ignored" case that `outbound-enumerate.spec.ts` needs a second, behavioural spec to
     * catch.
     */
    expect(editorSource()).toContain('doc.isBinary || isPreviewableTextMedia(doc.filePath)');
  });

  it('🔴 passes sourceAvailable derived from isBinary, never a literal', () => {
    const source = editorSource();

    expect(source).toContain('sourceAvailable={!doc.isBinary}');

    /*
     * And the two literals are absent by name. A `sourceAvailable` hardcoded either way type-checks,
     * renders, and is wrong for half the files in the project — which is the shape this assertion
     * exists for, since the positive above passes if a second, later prop overrides it.
     */
    expect(source).not.toContain('sourceAvailable={true}');
    expect(source).not.toContain('sourceAvailable={false}');
    expect(source).not.toContain('sourceAvailable ');
  });

  it('imports isPreviewableTextMedia from the one module that defines it', () => {
    /* A local re-implementation is the two-writers drift this codebase keeps rediscovering. */
    expect(editorSource()).toMatch(/import \{ isPreviewableTextMedia \} from '~\/lib\/preview\/media-kind'/);
  });

  it('CONTROL: the editor was really read, as code', () => {
    /*
     * Every assertion above is a string match on a file this test locates by a hardcoded path. Rename
     * or move `CodeMirrorEditor.tsx` and `strippedOf` throws — but a comment-strip regression, or a
     * file that has become a re-export stub, would return something short and the `not.toContain`
     * assertions would pass on it forever.
     */
    const stripped = strippedOf(EDITOR);

    expect(stripped.length).toBeGreaterThan(2000);
    expect(stripped).toContain('<BinaryPreview');
    expect(stripped).toContain('export default CodeMirrorEditor');
  });

  it('CONTROL: the needles really are absent-by-fact, not absent-by-typo', () => {
    /*
     * The `not.toContain` assertions above are the kind that pass for a misspelled needle. Proven here
     * against a synthetic source that genuinely contains the wrong spellings — if `toContain` were
     * somehow not matching at all, this fails.
     */
    const wrong = '<BinaryPreview filePath={doc.filePath} sourceAvailable={true} />';

    expect(wrong).toContain('sourceAvailable={true}');
    expect(wrong).not.toContain('sourceAvailable={!doc.isBinary}');
  });
});

/*
 * CONTROLS.
 *
 * Every assertion above is of the form "this string is absent", and *every one of them passes for a
 * reader that returns the empty string*. These are the only tests in this file that can tell a clean
 * feature apart from a broken scanner.
 */
describe('CONTROLS — the scanner is not reporting a clean bill of health on nothing', () => {
  it('CONTROL: the scan set is non-empty and holds exactly the feature files', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(Object.keys(REQUIRED).length);

    /* And it never swept in the neighbours: preview-tools lives in the same directory. */
    expect(SCANNED).not.toContain('app/lib/preview/agent-script.ts');
    expect(SCANNED).not.toContain('app/lib/preview/protocol.ts');

    /* SELF is excluded by exact path — it names all five needles as data, one screen up. */
    expect(SCANNED).not.toContain('app/lib/preview/binary-preview-guards.spec.ts');
  });

  it.each(Object.entries(REQUIRED))('CONTROL: %s was really read, as code', (file, marker) => {
    const stripped = strippedOf(file);

    /*
     * >200 chars rules out the failure that matters: a `sourceWithoutComments` whose block-comment
     * regex went greedy would return a near-empty string for every file in this feature — all three of
     * which OPEN with a long block comment — and the scan would pass forever.
     */
    expect(stripped.length).toBeGreaterThan(200);
    expect(stripped).toContain(marker);
  });

  it.each(FORBIDDEN)('CONTROL: the needle %s is findable at all', (needle) => {
    /*
     * A typo in a needle ("readBinaryFiles") is invisible: it matches nothing, and matching nothing is
     * what passing looks like here. Each needle is proven against a file that really contains it.
     *
     * `app/lib/stores/files.ts` is the canonical byte reader — it DEFINES `readBinaryFile` and calls
     * `sandbox.fs.readFile` inside it — which is exactly the code path this feature must never enter.
     */
    const haystack = walk(APP_DIR)
      .filter((abs) => abs !== SELF)
      .map(toRepoPath)
      .filter((file) => strippedOf(file).includes(needle));

    expect(haystack, `nothing in app/ contains ${needle} — the needle no longer matches anything`).not.toEqual([]);
  });

  it('CONTROL: readBinaryFile is found in the store that defines it', () => {
    /* The specific positive case the header names, pinned by path rather than by "something, somewhere". */
    const stripped = strippedOf('app/lib/stores/files.ts');

    expect(stripped).toContain('readBinaryFile');
    expect(stripped).toContain('sandbox.fs.readFile');
  });

  it('CONTROL: a commented mention does not trip the scan (synthetic)', () => {
    /*
     * The fixture case: both comment shapes, both stripped, and the code between them survives.
     */
    const fixture = [
      '/** never call readBinaryFile, never mint a createObjectURL */',
      '// and never `new Blob`',
      "const kept = 'real code';",
      '/* sandbox.fs.readFile */ const alsoKept = 1;',
    ].join('\n');

    const stripped = fixture.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const needle of FORBIDDEN) {
      expect(stripped).not.toContain(needle);
    }

    expect(stripped).toContain("const kept = 'real code';");
    expect(stripped).toContain('const alsoKept = 1;');
  });

  it('🔴 CONTROL: the strip is load-bearing on REAL source, not just on a fixture', () => {
    /*
     * The strongest control available here. `BinaryPreview.tsx`'s doc comment deliberately names the
     * three APIs it must never call — stating the rule where the code is edited is worth more than the
     * scanner's convenience — so this file is a genuine, shipped instance of "the needle is present in
     * prose and absent from code". Delete the comment strip and the scan above goes red on it.
     *
     * A synthetic fixture alone would not prove that: it tests the regex, not the coupling between the
     * regex and the source it is pointed at.
     */
    const file = 'app/components/editor/codemirror/BinaryPreview.tsx';
    const raw = readFileSync(join(process.cwd(), file), 'utf-8');
    const stripped = strippedOf(file);

    for (const needle of ['readBinaryFile', 'new Blob', 'createObjectURL']) {
      expect(raw, `${file}'s doc comment no longer states the rule for ${needle}`).toContain(needle);
      expect(stripped, `${needle} survived the comment strip — the scan is reading prose as code`).not.toContain(
        needle,
      );
    }

    /* And the strip did not simply empty the file: the component is still there. */
    expect(stripped).toContain('export function BinaryPreview');
  });
});
