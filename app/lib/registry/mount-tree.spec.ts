/**
 * The atomic-mount tree builder (SPEC §4.4, §4.2.8, `spec/binary-files.md`).
 *
 * The one invariant that MUST NOT regress is binary byte-identity: a PNG/GLB mounted into the sandbox
 * must be the exact bytes it came from, never a UTF-8 re-encoding of its base64. That is the upstream
 * defect the binary work exists to make impossible, and it is why the tree building is a PURE function
 * — so this file can prove it with hostile bytes and no sandbox.
 */
import { describe, expect, it } from 'vitest';
import type { DirectoryNode, FileNode } from '@webcontainer/api';
import { bytesToBase64 } from '~/lib/binary/binary-files';
import type { TemplateFile } from '~/types/template';
import { buildFileSystemTree, withFrameworkPublicAssets } from './mount-tree';

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

  it('decodes a binary to the EXACT bytes — hostile values, byte-for-byte', () => {
    // Every byte a naive UTF-8 round-trip corrupts: NUL, 0xFF, a lone high byte, 0x80.
    const original = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x80, 0x0d, 0x0a, 0x1a, 0x0a]);
    const files: TemplateFile[] = [
      { name: 'logo.png', path: 'public/logo.png', content: bytesToBase64(original), isBinary: true },
    ];

    const contents = fileContents(dir(buildFileSystemTree(files).public)['logo.png']);

    expect(contents).toBeInstanceOf(Uint8Array);
    expect(Array.from(contents as Uint8Array)).toEqual(Array.from(original));
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
