/**
 * The atomic-mount tree builder (SPEC §4.4, §4.2.8, `spec/binary-files.md`).
 *
 * The one invariant that MUST NOT regress is binary byte-identity: a PNG/GLB/WASM in the sandbox must
 * be the exact bytes it came from. `container.mount` CANNOT carry those bytes — it JSON-serializes a
 * `Uint8Array` body through a browser `TextDecoder('latin1')` (= windows-1252), which corrupts every
 * byte `0x80`–`0x9F` (see the `mount-tree.ts` header). So the invariant here is STRUCTURAL, not a
 * byte round-trip: binaries are partitioned OUT of the tree and `buildFileSystemTree` refuses them, so
 * no binary can ever reach the corrupting path. A byte-identity round-trip test would be worse than
 * useless — Node's `TextDecoder('latin1')` is byte-identity, so it would PASS while the browser
 * corrupts, the exact reason the original bug shipped.
 */
import { describe, expect, it } from 'vitest';
import type { DirectoryNode, FileNode } from '@webcontainer/api';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import type { TemplateFile } from '~/types/template';
import { buildFileSystemTree, partitionForMount, withFrameworkPublicAssets } from './mount-tree';

const dir = (node: unknown): DirectoryNode['directory'] => (node as DirectoryNode).directory;
const fileContents = (node: unknown): string | Uint8Array => (node as FileNode).file.contents;

describe('buildFileSystemTree', () => {
  it('nests files under their directories', () => {
    const files: TemplateFile[] = [
      { name: 'package.json', path: 'package.json', content: '{}' },
      { name: 'main.ts', path: 'src/main.ts', content: 'export {}' },
      { name: 'globals.ts', path: 'src/babylon/globals.ts', content: '// globals' },
    ];

    const tree = buildFileSystemTree(files);

    expect(fileContents(tree['package.json'])).toBe('{}');
    expect(fileContents(dir(tree.src)['main.ts'])).toBe('export {}');
    expect(fileContents(dir(dir(tree.src).babylon)['globals.ts'])).toBe('// globals');
  });

  it('keeps text content as a string, never re-encoded', () => {
    const files: TemplateFile[] = [{ name: 'a.ts', path: 'a.ts', content: 'const x = "héllo";' }];
    expect(fileContents(buildFileSystemTree(files)['a.ts'])).toBe('const x = "héllo";');
  });

  it('REFUSES a binary file rather than routing it through the corrupting mount path', () => {
    // container.mount would windows-1252-mangle these bytes in the browser; the throw is the guard.
    const original = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x80, 0x0d, 0x0a, 0x1a, 0x0a]);
    const files: TemplateFile[] = [
      { name: 'logo.png', path: 'public/logo.png', content: bytesToBase64(original), isBinary: true },
    ];

    expect(() => buildFileSystemTree(files)).toThrow(/binary/i);
  });

  it('places a directory-shaped entry without clobbering siblings, order-independent', () => {
    // The deep file arrives BEFORE its sibling — the second insertion must not reset `src/`.
    const files: TemplateFile[] = [
      { name: 'deep.ts', path: 'src/a/deep.ts', content: 'a' },
      { name: 'shallow.ts', path: 'src/shallow.ts', content: 'b' },
    ];

    const tree = buildFileSystemTree(files);

    expect(fileContents(dir(dir(tree.src).a)['deep.ts'])).toBe('a');
    expect(fileContents(dir(tree.src)['shallow.ts'])).toBe('b');
  });

  it('ignores empty paths rather than producing a malformed node', () => {
    expect(buildFileSystemTree([{ name: '', path: '', content: 'x' }])).toEqual({});
  });
});

describe('partitionForMount', () => {
  it('routes binaries away from the text mount tree by the isBinary flag', () => {
    const files: TemplateFile[] = [
      { name: 'package.json', path: 'package.json', content: '{}' },
      { name: 'main.ts', path: 'src/main.ts', content: 'export {}' },
      { name: 'havok.wasm', path: 'public/scripts/havok.wasm', content: 'AAA=', isBinary: true },
      { name: 'logo.png', path: 'public/logo.png', content: 'AAA=', isBinary: true },
    ];

    const { textFiles, binaryFiles } = partitionForMount(files);

    expect(textFiles.map((f) => f.path)).toEqual(['package.json', 'src/main.ts']);
    expect(binaryFiles.map((f) => f.path)).toEqual(['public/scripts/havok.wasm', 'public/logo.png']);
  });

  it('produces a tree that buildFileSystemTree accepts (the text half never throws)', () => {
    const files: TemplateFile[] = [
      { name: 'a.png', path: 'a.png', content: 'AAA=', isBinary: true },
      { name: 'b.ts', path: 'b.ts', content: 'x' },
    ];

    const { textFiles } = partitionForMount(files);
    expect(() => buildFileSystemTree(textFiles)).not.toThrow();
  });
});

describe('withFrameworkPublicAssets', () => {
  const bundled = (name: string): TemplateFile => ({
    name,
    path: `src/babylon/assets/${name}`,
    content: bytesToBase64(new Uint8Array([1, 2, 3])),
    isBinary: true,
  });

  it('copies bundled babylon.png/spinner.png into public/ when absent', () => {
    const out = withFrameworkPublicAssets([bundled('babylon.png'), bundled('spinner.png')]);

    const babylon = out.find((f) => f.path === 'public/babylon.png');
    const spinner = out.find((f) => f.path === 'public/spinner.png');

    expect(babylon?.isBinary).toBe(true);
    expect(babylon?.content).toBe(bundled('babylon.png').content);
    expect(spinner).toBeDefined();
  });

  it('leaves an existing public/ copy untouched (no duplicate)', () => {
    const existing: TemplateFile = {
      name: 'babylon.png',
      path: 'public/babylon.png',
      content: bytesToBase64(new Uint8Array([9])),
      isBinary: true,
    };

    const out = withFrameworkPublicAssets([existing, bundled('babylon.png'), bundled('spinner.png')]);

    expect(out.filter((f) => f.path === 'public/babylon.png')).toHaveLength(1);
    expect(out.find((f) => f.path === 'public/babylon.png')?.content).toBe(existing.content);
  });

  it('skips an asset whose bundled source is missing rather than fabricating it', () => {
    const out = withFrameworkPublicAssets([bundled('babylon.png')]); // no spinner source
    expect(out.some((f) => f.path === 'public/spinner.png')).toBe(false);
    expect(out.some((f) => f.path === 'public/babylon.png')).toBe(true);
  });

  it('returns the same array reference when nothing needs adding', () => {
    const files = [{ name: 'a.ts', path: 'a.ts', content: 'x' }];
    expect(withFrameworkPublicAssets(files)).toBe(files);
  });
});
