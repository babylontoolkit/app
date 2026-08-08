/**
 * `createFilesContext` — the block that carries the user's project to the model, and the single
 * largest cached entry in the prefix (SPEC §4.2.8, `spec/context-budget.md`).
 *
 * These pin the two properties that cost real money when they regress, both silently: the block is a
 * pure function of the map's CONTENT (sorted), and it emits **one entry per file** however that file
 * happens to be spelled in the map.
 *
 * The de-duplication is a backstop, not the fix. The fix is `toSandboxStoreKey` — one writer, one key
 * spelling — and it is pinned in `app/lib/stores/files-store-keys.spec.ts`. But this map arrives in a
 * CLIENT-SUPPLIED request body, so a stale bundle or a working copy written before that fix can still
 * carry both spellings, and this is the last place before the bytes are billed.
 */
import { describe, expect, it } from 'vitest';
import type { FileMap } from '~/lib/stores/files';
import { createFilesContext } from './utils';

const text = (content: string) => ({ type: 'file' as const, content, isBinary: false });

/** How many `<boltAction type="file">` blocks the context carries. */
const actionCount = (context: string) => context.match(/<boltAction type="file"/g)?.length ?? 0;

/** The `filePath` attribute of every emitted block, in order. */
const emittedPaths = (context: string) =>
  [...context.matchAll(/<boltAction type="file" filePath="([^"]+)"/g)].map((m) => m[1]);

describe('createFilesContext emits one entry per file', () => {
  it('🔴 collapses a file present under BOTH its relative and its absolute key', () => {
    const files: FileMap = {
      'src/pages/Home.tsx': text('const Home = 1;'),
      '/home/project/src/pages/Home.tsx': text('const Home = 1;'),
    };

    const context = createFilesContext(files, true);

    /*
     * Two entries here is ~22.5k tokens of duplicated game code on a real project, re-sent at the 2×
     * cache-write rate on every turn — and two copies of one file in front of the model.
     */
    expect(actionCount(context)).toBe(1);
    expect(emittedPaths(context)).toEqual(['src/pages/Home.tsx']);
  });

  it('CONTROL — two genuinely different files still emit two entries', () => {
    const files: FileMap = {
      '/home/project/src/pages/Home.tsx': text('a'),
      '/home/project/src/pages/About.tsx': text('b'),
    };

    /*
     * Without this the assertion above passes for a function that emits ONE block no matter what —
     * broken in the other direction, and far worse.
     */
    expect(actionCount(createFilesContext(files, true))).toBe(2);
  });

  it('CONTROL — files that merely share a basename are not collapsed', () => {
    const files: FileMap = {
      '/home/project/src/pages/Home.tsx': text('a'),
      '/home/project/src/chrome/Home.tsx': text('b'),
    };

    // De-duplication is on the whole project-relative path, never on the file name.
    expect(actionCount(createFilesContext(files, true))).toBe(2);
  });

  it('collapses across DIFFERENT provider roots — a working copy outlives its provider', () => {
    const files: FileMap = {
      '/home/project/src/main.ts': text('x'),
      '/project/workspace/src/main.ts': text('x'),
    };

    expect(actionCount(createFilesContext(files, true))).toBe(1);
  });

  it('is deterministic: the surviving spelling does not depend on map insertion order', () => {
    const relativeFirst: FileMap = {
      'src/pages/Home.tsx': text('a'),
      '/home/project/src/pages/Home.tsx': text('a'),
    };
    const absoluteFirst: FileMap = {
      '/home/project/src/pages/Home.tsx': text('a'),
      'src/pages/Home.tsx': text('a'),
    };

    /*
     * `filePaths` is sorted before the de-duplication, so the winner is a pure function of the key
     * SET. If it were insertion-ordered, a reload that discovered files in a different order would
     * rewrite the whole cached block at 2× for content that did not change — the exact defect the
     * `.sort()` above it was added to fix.
     */
    expect(createFilesContext(relativeFirst, true)).toBe(createFilesContext(absoluteFirst, true));
  });

  it('still sorts — same content, different key order, identical bytes', () => {
    const a: FileMap = {
      '/home/project/src/b.ts': text('b'),
      '/home/project/src/a.ts': text('a'),
    };
    const b: FileMap = {
      '/home/project/src/a.ts': text('a'),
      '/home/project/src/b.ts': text('b'),
    };

    expect(createFilesContext(a, true)).toBe(createFilesContext(b, true));
  });
});
