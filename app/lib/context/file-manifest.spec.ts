/**
 * The file manifest (`file-manifest.ts`) — the replacement for the 155k-token file dump.
 *
 * Money-path tests. Every property here is one that, if it breaks, costs tokens on EVERY turn of
 * every project and throws nothing (§4.2.8's silent failure mode: the number goes DOWN or UP and
 * nothing reports it).
 */
import { describe, expect, it } from 'vitest';
import { buildFileManifest, renderFileManifest } from './file-manifest';
import type { FileMap } from '~/lib/.server/llm/constants';

const text = (content: string) => ({ type: 'file' as const, content, isBinary: false });
const binary = (size: number) => ({ type: 'file' as const, content: '', isBinary: true, size });

describe('buildFileManifest', () => {
  /*
   * 🔴 SORTED — the cache property. `Object.keys` is watcher-arrival order, which differs between a
   * fresh mount, a reload and a device switch. Unsorted, the same project with the same bytes yields
   * a different prefix and rewrites the entry at the 2x cache-WRITE rate for content that did not
   * change. This is the exact defect that cost 22.5k tokens/turn in the dump it replaces.
   */
  it('sorts by path so the bytes are a pure function of the map content', () => {
    const a = buildFileManifest({
      '/home/project/src/z.ts': text('z'),
      '/home/project/src/a.ts': text('a'),
      '/home/project/README.md': text('r'),
    } as unknown as FileMap);

    const b = buildFileManifest({
      '/home/project/README.md': text('r'),
      '/home/project/src/z.ts': text('z'),
      '/home/project/src/a.ts': text('a'),
    } as unknown as FileMap);

    expect(a.map((e) => e.path)).toEqual(['README.md', 'src/a.ts', 'src/z.ts']);
    expect(renderFileManifest(a)).toBe(renderFileManifest(b));
  });

  /*
   * 🔴 The map is CLIENT-SUPPLIED. A stale bundle or a working copy written before the
   * `toSandboxStoreKey` fix can carry a file under both spellings; listing both shows the model two
   * copies of one file, and it can edit one while the other goes stale.
   *
   * ⚠️ The CONTROL below matters as much as the assertion: a de-dupe test alone passes for a function
   * that collapses EVERYTHING to one entry, which is the same bug pointing the other way.
   */
  it('lists each file once, keyed on the project-relative path', () => {
    const entries = buildFileManifest({
      '/home/project/src/pages/Home.tsx': text('absolute'),
      'src/pages/Home.tsx': text('relative'),
    } as unknown as FileMap);

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('src/pages/Home.tsx');
  });

  it('CONTROL: distinct files are not collapsed', () => {
    const entries = buildFileManifest({
      'src/pages/Home.tsx': text('a'),
      'src/pages/About.tsx': text('b'),
    } as unknown as FileMap);

    expect(entries).toHaveLength(2);
  });

  /*
   * A binary body may never enter context (SPEC §1.3 principle 10) — the map holds `isBinary` + a
   * size and an EMPTY content, so reporting `content.length` would tell the model every texture is
   * 0 bytes.
   */
  it('reports a binary file by its recorded size, never its empty content', () => {
    const entries = buildFileManifest({
      'public/player.png': binary(107_000),
    } as unknown as FileMap);

    expect(entries[0]).toEqual({ path: 'public/player.png', size: 107_000, kind: 'binary' });
  });

  /*
   * Opaque files are text for which no correct edit exists (lockfiles, vendored runtime shims, svg).
   * Marking them stops the model spending a tool round to discover that — `public/scripts/` alone was
   * HALF the starter's text payload in the dump.
   */
  it('marks opaque files so they are never read', () => {
    const entries = buildFileManifest({
      'public/scripts/babylon.js': text('x'.repeat(500_000)),
      'src/scripts/GameMode.ts': text('real source'),
    } as unknown as FileMap);

    expect(entries.find((e) => e.path === 'public/scripts/babylon.js')?.kind).toBe('opaque');
    expect(entries.find((e) => e.path === 'src/scripts/GameMode.ts')?.kind).toBe('text');
  });

  it('skips folders', () => {
    const entries = buildFileManifest({
      src: { type: 'folder' },
      'src/main.ts': text('m'),
    } as unknown as FileMap);

    expect(entries.map((e) => e.path)).toEqual(['src/main.ts']);
  });
});

describe('renderFileManifest', () => {
  /*
   * 🔴 THE POINT OF THE WHOLE CHANGE, asserted as a ratio rather than a literal.
   *
   * 88 files of real source came to ~155k tokens as a dump. The manifest must stay proportional to
   * the FILE COUNT, not to the byte count — if a bigger file makes the manifest bigger, the dump has
   * crept back in under a new name.
   */
  it('costs bytes proportional to the file COUNT, not the file SIZE', () => {
    const small = renderFileManifest(buildFileManifest({ 'src/a.ts': text('x'.repeat(100)) } as unknown as FileMap));
    const large = renderFileManifest(
      buildFileManifest({ 'src/a.ts': text('x'.repeat(100_000)) } as unknown as FileMap),
    );

    // Same file, 1000x the content — the listing grows only by the digits in the size.
    expect(Math.abs(large.length - small.length)).toBeLessThan(10);
  });

  it('renders one line per file with its size', () => {
    const rendered = renderFileManifest(
      buildFileManifest({
        'src/main.ts': text('hello'),
        'public/logo.png': binary(2048),
      } as unknown as FileMap),
    );

    expect(rendered).toBe('public/logo.png  (2048  [binary])\nsrc/main.ts  (5)');
  });

  /*
   * A listing must not look like a set of pending writes. The dump wrapped every body in
   * `<boltAction type="file">` — simultaneously the transport AND the instruction to write — and
   * that conflation is half of why the artifact protocol is being retired.
   */
  it('emits no artifact or action tags', () => {
    const rendered = renderFileManifest(buildFileManifest({ 'src/main.ts': text('x') } as unknown as FileMap));

    expect(rendered).not.toContain('boltAction');
    expect(rendered).not.toContain('boltArtifact');
    expect(rendered).not.toContain('boltFile');
  });
});
