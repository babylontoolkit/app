/**
 * THE GUARDS ARE THE ONLY THING COMPARING THE REQUEST TO THE RECORD, SO THEY NEED CONTROLS.
 *
 * `request-invariants.ts` exists because three incidents in this codebase had the same shape and none
 * of them threw: the model was shown 7 files of a 78-file tree; every agent-written file was listed
 * twice for weeks; the history carried stale file bodies at 83-87% of a re-sent conversation. In all
 * three the request was wrong, the record was right about everything it recorded, and nothing compared
 * the two.
 *
 * 🔴 **A DE-DUP ASSERTION ALONE PASSES FOR A FUNCTION THAT COLLAPSES EVERYTHING TO ONE ENTRY** — the
 * same bug pointing the other way, and strictly worse, because it deletes files from the model's view
 * instead of showing one twice (`files-context.spec.ts:43` records this). So every predicate here is
 * pinned by a PAIR: a case that must flag, and a control that must NOT. A guard that fires on
 * everything is muted in week one, which is the same as no guard at all.
 *
 * The shared-rule table is the load-bearing part. `dedupeByProjectPath` was extracted precisely
 * because the de-dup rule lived twice — once in `buildFileManifest` (the agent path), once in
 * `createFilesContext` (the inherited path) — and this codebase's own `isSecretPath` rule says two
 * implementations of one rule drift, and you find out when a file is collapsed on one path and listed
 * twice on the other. The table runs one set of `FileMap` fixtures through BOTH and asserts they agree,
 * including a case where nothing collapses at all.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { CoreMessage } from 'ai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileMap } from '~/lib/.server/llm/constants';
import type { ManifestEntry } from '~/lib/context/file-manifest';
import { buildFileManifestWithCollapses } from '~/lib/context/file-manifest';
import { createFilesContext } from '~/lib/.server/llm/utils';
import type { CollapsedPath } from '~/lib/common/sandbox-paths';
import {
  checkFirstBuildManifest,
  checkHandoffRecorded,
  checkManifestShrink,
  checkNoDuplicatePaths,
  checkNoFileBodies,
  OMITTED_MARKER_CHARS,
  resetManifestShrinkState,
} from './request-invariants';

const text = (content: string): FileMap[string] => ({ type: 'file' as const, content, isBinary: false });
const binary = (size: number): FileMap[string] => ({ type: 'file' as const, content: '', isBinary: true, size });

/*
 * What the history compactor leaves behind (`llm/history.ts`). COPIED, not imported: `history.ts` owns
 * the text and does not export it, and the predicate deliberately duplicates it as a LENGTH rather than
 * as a string. A drift test below reads `history.ts` and fails if this literal stops matching it —
 * because the "realistic post-compaction body" control is worthless if it is testing a marker the
 * compactor no longer emits.
 */
const OMITTED = '\n[body omitted — this file\'s CURRENT contents are in the "Current Project Files" section]\n';

const userText = (text: string): CoreMessage => ({ role: 'user', content: text });
const assistantText = (text: string): CoreMessage => ({ role: 'assistant', content: text });

/** What `convertToCoreMessages` actually produces: text in `parts`, not in a bare string. */
const assistantParts = (...texts: string[]): CoreMessage => ({
  role: 'assistant',
  content: texts.map((text) => ({ type: 'text' as const, text })),
});

const fileAction = (path: string, body: string) => `<boltAction type="file" filePath="${path}">${body}</boltAction>`;

const entries = (...paths: string[]): ManifestEntry[] =>
  paths.map((path) => ({ path, size: 10, kind: 'text' as const }));

describe('INV-1 — no two manifest entries normalise to the same project-relative path', () => {
  it('🔴 flags a file that arrived under BOTH spellings, and NAMES both', () => {
    const collapsed: CollapsedPath[] = [
      { path: 'src/pages/Home.tsx', kept: 'src/pages/Home.tsx', dropped: '/home/project/src/pages/Home.tsx' },
    ];

    const violation = checkNoDuplicatePaths(collapsed);

    expect(violation?.invariant).toBe('INV-1');

    /*
     * "a duplicate was collapsed" is not actionable; the two spellings say which ingest path wrote the
     * wrong one. If the detail ever stops carrying them this alert becomes a number nobody can act on.
     */
    expect(violation?.detail).toContain('src/pages/Home.tsx');
    expect(violation?.detail).toContain('/home/project/src/pages/Home.tsx');
  });

  it('CONTROL — nothing collapsed means nothing to report', () => {
    expect(checkNoDuplicatePaths([])).toBeNull();
  });

  it('names at most five and counts the rest, so an alert stays alertable', () => {
    const collapsed: CollapsedPath[] = Array.from({ length: 7 }, (_, i) => ({
      path: `src/f${i}.ts`,
      kept: `src/f${i}.ts`,
      dropped: `/home/project/src/f${i}.ts`,
    }));

    const detail = checkNoDuplicatePaths(collapsed)?.detail ?? '';

    expect(detail).toContain('7 file(s)');
    expect(detail).toContain('(+2 more)');
    expect(detail).not.toContain('src/f6.ts');
  });
});

/**
 * 🔴 THE SHARED-RULE TABLE.
 *
 * One rule, two callers. These fixtures go through both and the counts must agree — that is the only
 * thing standing between "extracted to one function" and the two copies quietly growing back.
 *
 * ⚠️ Every path is chosen to survive `IGNORE_PATTERNS` (`createFilesContext` filters, the manifest does
 * not — see the findings note). A `package-lock.json` in a fixture would make the two disagree for a
 * reason that has nothing to do with de-duplication.
 */
describe('the de-dup rule is ONE rule — the manifest and the file context agree', () => {
  /** Every entry the inherited path emits, whichever tag it used (`<boltAction>` for text, `<boltFile>` for binary/opaque). */
  const contextEntryCount = (context: string) => context.match(/<bolt(?:Action|File)\b/g)?.length ?? 0;

  const cases: { name: string; files: FileMap; entries: number; collapses: number }[] = [
    {
      name: 'both spellings of one file collapse to one',
      files: {
        'src/pages/Home.tsx': text('const Home = 1;'),
        '/home/project/src/pages/Home.tsx': text('const Home = 1;'),
      },
      entries: 1,
      collapses: 1,
    },
    {
      name: 'two genuinely different files stay two',
      files: {
        '/home/project/src/pages/Home.tsx': text('a'),
        '/home/project/src/pages/About.tsx': text('b'),
      },
      entries: 2,
      collapses: 0,
    },
    {
      name: 'the OTHER sandbox root collapses too (a working copy written under a different provider)',
      files: {
        'src/scripts/KartMode.ts': text('export default 1;'),
        '/project/workspace/src/scripts/KartMode.ts': text('export default 1;'),
      },
      entries: 1,
      collapses: 1,
    },
    {
      name: 'a binary listed under both spellings collapses to one',
      files: {
        'public/assets/havok.wasm': binary(2_000_000),
        '/home/project/public/assets/havok.wasm': binary(2_000_000),
      },
      entries: 1,
      collapses: 1,
    },
    {
      /*
       * 🔴 THE CONTROL FOR THE WHOLE TABLE. Without it every assertion above is satisfied by two
       * functions that both return exactly one entry whatever they are handed.
       */
      /*
       * 🔴 THE FIXTURE THAT MAKES THE ORDERING FIX TESTABLE — and without it that fix is free to be
       * reverted with nothing turning red (mutation-verified: it was).
       *
       * `createFilesContext` used to de-duplicate BEFORE dropping folders, so a folder dirent could
       * win the slot for a path a FILE dirent also occupies (`/home/project/src/pages` sorts before
       * `src/pages`), after which the trailing `type === 'file'` filter dropped the folder and the
       * FILE disappeared from the context entirely — one file in the map, zero shown to the model.
       * `buildFileManifest` always filtered first, so the two paths agreed about the RULE and
       * disagreed about the ORDER it runs in, which is precisely the drift that sharing one
       * implementation is supposed to make impossible. Every other fixture here is `type: 'file'`
       * and therefore cannot reach it.
       */
      name: 'a folder sharing a normalised path with a file never displaces the file',
      files: {
        '/home/project/src/pages': { type: 'folder' } as FileMap[string],
        'src/pages': text('const Home = 1;'),
      },
      entries: 1,
      collapses: 0,
    },
    {
      name: 'CONTROL — four distinct files collapse to NOTHING and stay four on both paths',
      files: {
        '/home/project/src/pages/Home.tsx': text('a'),
        '/home/project/src/pages/About.tsx': text('b'),
        '/home/project/src/babylon/globals.ts': text('c'),
        '/home/project/src/scripts/KartMode.ts': text('d'),
      },
      entries: 4,
      collapses: 0,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const manifest = buildFileManifestWithCollapses(testCase.files);

      expect(manifest.entries).toHaveLength(testCase.entries);
      expect(manifest.collapsed).toHaveLength(testCase.collapses);

      /* The inherited path must land on the same count, or the rule has two behaviours again. */
      expect(contextEntryCount(createFilesContext(testCase.files, true))).toBe(testCase.entries);

      /* And whatever the manifest collapsed is exactly what INV-1 has to report on. */
      const violation = checkNoDuplicatePaths(manifest.collapsed);
      expect(violation === null).toBe(testCase.collapses === 0);
    });
  }
});

describe('INV-2 — no file body survives compaction into the request', () => {
  const body = 'x'.repeat(4000);

  it('🔴 flags a file body carried as a plain string `content`', () => {
    const violation = checkNoFileBodies([assistantText(`Done.\n${fileAction('src/pages/Home.tsx', body)}`)]);

    expect(violation?.invariant).toBe('INV-2');
    expect(violation?.detail).toContain('4000 chars');
  });

  /*
   * 🔴 The shape that matters. `convertToCoreMessages` PREFERS `parts`, and a content-only fix once
   * passed every test in `history.spec.ts` while changing nothing on the wire. Running the predicate
   * post-conversion is the whole point of this invariant, so both carriers are pinned.
   */
  it('🔴 flags a file body carried in an array of text parts', () => {
    const violation = checkNoFileBodies([assistantParts('Here you go.', fileAction('src/pages/Home.tsx', body))]);

    expect(violation?.invariant).toBe('INV-2');
    expect(violation?.detail).toContain('assistant');
  });

  it('flags a type="edit" body too — an edit body is a file body', () => {
    const edit = `<boltAction type="edit" filePath="src/pages/Home.tsx">${body}</boltAction>`;

    expect(checkNoFileBodies([assistantText(edit)])?.invariant).toBe('INV-2');
  });

  it('flags a body that arrived on a USER message (the client prepends an artifact of editor edits)', () => {
    expect(checkNoFileBodies([userText(fileAction('src/pages/Home.tsx', body))])?.invariant).toBe('INV-2');
  });

  it('CONTROL — a shell action is untouched: the command IS the action, not a body', () => {
    const shell = '<boltAction type="shell">npm install @babylonjs/havok && npm run dev</boltAction>';

    expect(checkNoFileBodies([assistantText(shell)])).toBeNull();
  });

  it('CONTROL — a body SHORTER than the marker is not a body', () => {
    expect(checkNoFileBodies([assistantText(fileAction('src/x.ts', 'const a = 1;'))])).toBeNull();
  });

  /*
   * 🔴 THE REALISTIC CASE. Every compacted turn in every conversation carries exactly this. If it ever
   * flags, the invariant fires on every single request and the channel is dead the day it ships.
   */
  it('CONTROL — the actual OMITTED marker from history.ts must NOT flag', () => {
    const compacted = [
      assistantText(fileAction('src/pages/Home.tsx', OMITTED)),
      assistantParts(fileAction('src/pages/Home.css', OMITTED)),
    ];

    expect(checkNoFileBodies(compacted)).toBeNull();
  });

  it('CONTROL — the copied marker is EXACTLY the one history.ts emits, in both directions', () => {
    const history = readFileSync(join(process.cwd(), 'app/lib/.server/llm/history.ts'), 'utf8');

    /*
     * 🔴 EXACT, not `toContain`. A substring check passes for a marker that GREW — and growth is the
     * dangerous direction: a marker longer than `OMITTED_MARKER_CHARS` makes INV-2 fire on every
     * compacted request in the product, flooding the signal rather than tightening it. A containment
     * assertion here would go green on precisely that change, which is the vacuous-guard shape this
     * whole feature exists to remove.
     *
     * The source escapes the apostrophe inside its single-quoted literal, so the comparison is made on
     * the unescaped text.
     */
    const emitted = history.replace(/\\'/g, "'").match(/^const OMITTED = '([\s\S]*?)';$/m)?.[1];

    expect(emitted, 'the OMITTED literal could not be located in history.ts').toBeTruthy();
    expect(emitted?.replace(/\\n/g, '\n').trim()).toBe(OMITTED.trim());

    /* …and it still fits under the floor the predicate uses, which is the property that matters. */
    expect(OMITTED.trim().length).toBeLessThan(OMITTED_MARKER_CHARS);
  });

  it('CONTROL — an attachment part has no text and does not crash the predicate', () => {
    const withImage: CoreMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'make it look like this' },
        { type: 'image', image: new Uint8Array([137, 80, 78, 71]) },
      ],
    };

    expect(checkNoFileBodies([withImage])).toBeNull();
  });

  it('CONTROL — an empty request has nothing to flag', () => {
    expect(checkNoFileBodies([])).toBeNull();
  });
});

describe('INV-3(a) — a first build turn can see the framework it is asked to build on', () => {
  const scaffolded = 'src/scripts/KartRacerMode.ts';

  it('🔴 flags a first build turn whose manifest lacks src/babylon/globals.ts', () => {
    const violation = checkFirstBuildManifest({
      isFirstBuildTurn: true,
      entries: entries('package.json', 'src/pages/Home.tsx', scaffolded),
      scaffoldedClassPath: scaffolded,
    });

    expect(violation?.invariant).toBe('INV-3a');
    expect(violation?.detail).toContain('src/babylon/globals.ts');
  });

  it('🔴 flags a first build turn whose manifest lacks the scaffolded class', () => {
    const violation = checkFirstBuildManifest({
      isFirstBuildTurn: true,
      entries: entries('src/babylon/globals.ts', 'src/pages/Home.tsx'),
      scaffoldedClassPath: scaffolded,
    });

    expect(violation?.invariant).toBe('INV-3a');
    expect(violation?.detail).toContain(scaffolded);
  });

  it('names BOTH when both are missing', () => {
    const detail =
      checkFirstBuildManifest({
        isFirstBuildTurn: true,
        entries: entries('package.json'),
        scaffoldedClassPath: scaffolded,
      })?.detail ?? '';

    expect(detail).toContain('src/babylon/globals.ts');
    expect(detail).toContain(scaffolded);
  });

  it('does not flag when both required paths are present', () => {
    expect(
      checkFirstBuildManifest({
        isFirstBuildTurn: true,
        entries: entries('src/babylon/globals.ts', scaffolded, 'src/pages/Home.tsx'),
        scaffoldedClassPath: scaffolded,
      }),
    ).toBeNull();
  });

  /*
   * 🔴 An IMPORTED or remixed project legitimately has no scaffolded class, and so does a degraded
   * creation that failed to scaffold one. Treating "we do not know the class name" as "the class is
   * missing" fires on every import — the fastest way to get an alert channel muted.
   */
  it('CONTROL — an imported project (no scaffolded class) with globals present does NOT flag', () => {
    expect(
      checkFirstBuildManifest({
        isFirstBuildTurn: true,
        entries: entries('src/babylon/globals.ts', 'src/main.ts'),
        scaffoldedClassPath: undefined,
      }),
    ).toBeNull();
  });

  it('CONTROL — a NON-first-build turn never flags, whatever the manifest looks like', () => {
    expect(
      checkFirstBuildManifest({ isFirstBuildTurn: false, entries: [], scaffoldedClassPath: scaffolded }),
    ).toBeNull();

    expect(checkFirstBuildManifest({ isFirstBuildTurn: false, entries: entries('README.md') })).toBeNull();
  });
});

describe('INV-3(b) — the manifest shrank sharply within one chat', () => {
  /* Module state. A spec that cannot clear it is order-dependent, and order-dependence here is silent. */
  beforeEach(() => {
    resetManifestShrinkState();
  });

  it('🔴 flags a chat whose manifest went 90 -> 20', () => {
    expect(checkManifestShrink('chat-a', 90)).toBeNull();

    const violation = checkManifestShrink('chat-a', 20);

    expect(violation?.invariant).toBe('INV-3b');
    expect(violation?.detail).toContain('90');
    expect(violation?.detail).toContain('20');
  });

  it('CONTROL — the first turn of a chat is not a shrink', () => {
    expect(checkManifestShrink('chat-b', 3)).toBeNull();
  });

  it('CONTROL — a legitimately tiny project (3 -> 3) never flags', () => {
    expect(checkManifestShrink('chat-c', 3)).toBeNull();
    expect(checkManifestShrink('chat-c', 3)).toBeNull();
    expect(checkManifestShrink('chat-c', 3)).toBeNull();
  });

  it('CONTROL — a mild shrink above the threshold (90 -> 60) does not flag', () => {
    expect(checkManifestShrink('chat-d', 90)).toBeNull();
    expect(checkManifestShrink('chat-d', 60)).toBeNull();
  });

  it('CONTROL — growth never flags', () => {
    expect(checkManifestShrink('chat-e', 20)).toBeNull();
    expect(checkManifestShrink('chat-e', 90)).toBeNull();
  });

  /* Two tabs on one project interleave through this process; keying by chat is what keeps them apart. */
  it('CONTROL — two different chatIds do not contaminate each other', () => {
    expect(checkManifestShrink('chat-big', 90)).toBeNull();
    expect(checkManifestShrink('chat-small', 20)).toBeNull();
    expect(checkManifestShrink('chat-small', 20)).toBeNull();
    expect(checkManifestShrink('chat-big', 88)).toBeNull();
  });

  it('CONTROL — no chatId means no state and no flag', () => {
    expect(checkManifestShrink(undefined, 90)).toBeNull();
    expect(checkManifestShrink(undefined, 1)).toBeNull();
  });

  it('the reset seam really clears the map', () => {
    expect(checkManifestShrink('chat-f', 90)).toBeNull();
    resetManifestShrinkState();

    /* Without the clear this would be a 90 -> 20 shrink and would flag. */
    expect(checkManifestShrink('chat-f', 20)).toBeNull();
  });

  /*
   * 🔴 RECORDING-ONLY BY CONSTRUCTION (Open Question 1, owner 2026-08-21). A branch switch is a
   * legitimate large file-map change on EVERY use of the `github-branch-client` feature, so promoting
   * this to an alert before that feature can suppress it makes the channel noisy in week one for
   * exactly the users adopting it. The predicate must therefore RETURN a violation and reach nothing.
   */
  it('🔴 returns a violation object and alerts nobody', () => {
    checkManifestShrink('chat-g', 90);
    expect(checkManifestShrink('chat-g', 20)).toMatchObject({ invariant: 'INV-3b' });

    const source = readFileSync(join(process.cwd(), 'app/lib/.server/agent/request-invariants.ts'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');

    /* CONTROL for the scanner: if this stops matching, the assertions below prove nothing. */
    expect(code).toContain('export function checkManifestShrink');

    expect(code).not.toMatch(/getMonitor|captureError|trackEvent|monitoring|logger\.(error|warn)/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});

/**
 * INV-3(b)'s suppression signal (§4.13a T15).
 *
 * 🔴 A branch switch is a legitimate large file-map change on EVERY single use — a feature branch with
 * 90 files to a default branch with 60 is exactly the shape this check flags, and it is correct. So the
 * promotion of INV-3(b) from recording-only to an alert had to land WITH a way for the client to say
 * "that one was deliberate", or the channel is noisy in week one for precisely the users adopting the
 * new feature, and a muted channel is the same as no guard.
 *
 * The suppression can only ever make this SAY LESS: it arrives in a browser body, spends no credit,
 * selects no model, reaches no file, and cannot make a violation appear.
 */
describe('INV-3(b) — a deliberate tree replacement suppresses the shrink', () => {
  beforeEach(() => {
    resetManifestShrinkState();
  });

  /* The measured shape: 90 files on a feature branch, 60 on the default, no delete action anywhere. */
  it('🔴 a halved manifest reports nothing when the tree was replaced on purpose', () => {
    expect(checkManifestShrink('chat-switch', 90)).toBeNull();
    expect(checkManifestShrink('chat-switch', 40, { treeReplaced: true })).toBeNull();
  });

  /*
   * 🔴 THE CONTROL THAT MAKES THE TEST ABOVE MEAN ANYTHING. Without it, a `checkManifestShrink` that
   * had simply been deleted — or whose threshold had been loosened to nothing — passes, which is the
   * cheerful way a noise fix removes the guard it was tuning.
   */
  it('🔴 CONTROL — the identical halving WITHOUT the flag still reports', () => {
    expect(checkManifestShrink('chat-plain', 90)).toBeNull();

    const violation = checkManifestShrink('chat-plain', 40);

    expect(violation?.invariant).toBe('INV-3b');
    expect(violation?.detail).toContain('90');
    expect(violation?.detail).toContain('40');
  });

  /* An absent options object is the ordinary call and must behave exactly like `{}`. */
  it('CONTROL — an explicit `treeReplaced: false` is the same as not passing it', () => {
    expect(checkManifestShrink('chat-false', 90)).toBeNull();
    expect(checkManifestShrink('chat-false', 40, { treeReplaced: false })?.invariant).toBe('INV-3b');
  });

  /*
   * 🔴 THE RE-BASELINE HAPPENS ON THE SUPPRESSED TURN, and this is the assertion that would otherwise
   * be missed entirely.
   *
   * A suppressed turn that did not update the baseline would compare the NEXT turn against the
   * PRE-switch count too — so one switch suppresses one turn and then fires on the one after it. The
   * noise arrives a turn late instead of not arriving, which is strictly worse than not suppressing at
   * all, because the signal now points at an innocent turn that changed nothing.
   */
  it('🔴 the suppressed turn re-baselines, so the NEXT turn is measured against the new tree', () => {
    /*
     * ⚠️ The counts have to CROSS the threshold, and the first draft of this test did not — it used
     * 90 -> 60 -> 60, and 60 is 67% of 90, so a stale baseline returns null for the innocent reason
     * rather than the intended one. It passed with the re-baseline moved below the early return, i.e.
     * it went green on the exact regression it is named for. 40 is under half of 90, so the stale
     * comparison genuinely fires and the correct one genuinely does not.
     */
    expect(checkManifestShrink('chat-rebase', 90)).toBeNull();
    expect(checkManifestShrink('chat-rebase', 40, { treeReplaced: true })).toBeNull();

    /* 40 -> 40 is no shrink. Against the stale 90 it is a 56% drop and would flag. */
    expect(checkManifestShrink('chat-rebase', 40)).toBeNull();
  });

  /* The suppression covers ONE turn — the turn that first sees the new tree — not the rest of the chat. */
  it('CONTROL — the suppression does not persist: a real shrink after it still reports', () => {
    expect(checkManifestShrink('chat-once', 90)).toBeNull();
    expect(checkManifestShrink('chat-once', 60, { treeReplaced: true })).toBeNull();
    expect(checkManifestShrink('chat-once', 10)?.invariant).toBe('INV-3b');
  });

  /*
   * The re-baseline also happens when a violation IS returned. Without it, one genuine shrink would
   * re-report on every subsequent turn of the chat at the same unchanged count — a single incident
   * turned into a permanent alarm, which mutes the channel just as effectively as noise does.
   */
  it('a reported violation re-baselines too, so it fires once rather than forever', () => {
    expect(checkManifestShrink('chat-report', 90)).toBeNull();
    expect(checkManifestShrink('chat-report', 10)?.invariant).toBe('INV-3b');
    expect(checkManifestShrink('chat-report', 10)).toBeNull();
  });
});

describe('INV-4 — a model handoff that happened reached the record', () => {
  it('🔴 flags a handoff observed on the wire that never reached the record', () => {
    const violation = checkHandoffRecorded(['claude-opus-5'], []);

    expect(violation?.invariant).toBe('INV-4');
    expect(violation?.detail).toContain('claude-opus-5');
  });

  it('flags a partial record — two observed, one recorded', () => {
    expect(checkHandoffRecorded(['claude-opus-5', 'claude-opus-4-8'], ['claude-opus-5'])?.invariant).toBe('INV-4');
  });

  it('flags when the record field is missing entirely (the pre-migration-0023 state)', () => {
    expect(checkHandoffRecorded(['claude-opus-5'], undefined)?.invariant).toBe('INV-4');
  });

  it('CONTROL — no handoff at all is not a violation', () => {
    expect(checkHandoffRecorded([], [])).toBeNull();
    expect(checkHandoffRecorded(undefined, undefined)).toBeNull();
  });

  /*
   * 🔴 A handoff is NOT itself a violation. Recording the REQUESTED model is correct — that is what the
   * turn bills at. The violation is losing the other half.
   */
  it('CONTROL — a handoff observed AND recorded is the system working', () => {
    expect(checkHandoffRecorded(['claude-opus-5'], ['claude-opus-5'])).toBeNull();
  });
});
