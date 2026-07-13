import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  fileEntryFromBuffer,
  isBinaryBuffer,
  serializeFileMap,
  writeSerializedFileMap,
  type BinaryFs,
  type SerializedFileMap,
} from './binary-files';
import type { FileMap } from '~/lib/stores/files';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A real PNG header + high-bytes payload — the shape that UTF-8 decoding destroys. */
function makePng(payloadSize = 4096): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const bytes = new Uint8Array(header.length + payloadSize);
  bytes.set(header, 0);

  for (let i = 0; i < payloadSize; i++) {
    // Cycle the full byte range, including 0x00 and everything above 0x7F.
    bytes[header.length + i] = i % 256;
  }

  return bytes;
}

/** In-memory stand-in for the WebContainer FS, with WebContainer's string semantics. */
function createMemFs() {
  const disk = new Map<string, Uint8Array>();
  const dirs = new Set<string>();

  const fs: BinaryFs = {
    async readFile(path: string) {
      const bytes = disk.get(path);

      if (!bytes) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }

      return bytes;
    },
    async writeFile(path: string, data: string | Uint8Array) {
      // WebContainer UTF-8 encodes a string body. Writing binary as a string corrupts it.
      disk.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
    },
    async mkdir(path: string) {
      dirs.add(path);
    },
  };

  return { fs, disk, dirs };
}

const identity = (p: string) => p;

describe('binary codec', () => {
  it('round-trips arbitrary bytes through base64 without loss', () => {
    const png = makePng();
    expect(sha256(base64ToBytes(bytesToBase64(png)))).toBe(sha256(png));
  });

  it('detects binary buffers and leaves text alone', () => {
    expect(isBinaryBuffer(makePng())).toBe(true);
    expect(isBinaryBuffer(new TextEncoder().encode('export const x = 1;\n'))).toBe(false);
    expect(isBinaryBuffer(undefined)).toBe(false);
  });
});

describe('fileEntryFromBuffer', () => {
  it('keeps binary CONTENT out of the file map but records isBinary + size', () => {
    const png = makePng();
    const entry = fileEntryFromBuffer(png);

    // SPEC §1.3 principle 10: binary content never enters the editor's text map.
    expect(entry.content).toBe('');
    expect(entry.isBinary).toBe(true);
    expect(entry.size).toBe(png.byteLength);
  });

  it('decodes text files normally', () => {
    const entry = fileEntryFromBuffer(new TextEncoder().encode('hello world'));
    expect(entry).toEqual({ type: 'file', content: 'hello world', isBinary: false, size: 11 });
  });

  it('treats an undecodable "text" file as binary rather than emptying it', () => {
    // Latin-1 bytes that sniff as text but fail a strict UTF-8 decode.
    const latin1 = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0xf8, 0x21]);
    const entry = fileEntryFromBuffer(latin1);

    expect(entry.isBinary).toBe(true);
    expect(entry.size).toBe(latin1.byteLength);
  });
});

describe('snapshot -> restore round-trip', () => {
  it('preserves PNG bytes hash-identically (the Stage 0 blocker)', async () => {
    const png = makePng(36882 - 8);
    const originalHash = sha256(png);

    // The container holds the real bytes; the store holds only metadata.
    const source = createMemFs();
    await source.fs.writeFile('public/babylon.png', png);
    await source.fs.writeFile('src/main.tsx', 'console.log("hi")');

    const files: FileMap = {
      '/home/project/public': { type: 'folder' },
      '/home/project/public/babylon.png': fileEntryFromBuffer(png),
      '/home/project/src/main.tsx': fileEntryFromBuffer(new TextEncoder().encode('console.log("hi")')),
    };

    const toRelative = (p: string) => p.replace('/home/project/', '');

    // Egress: bytes are read back from the container, not from the (empty) store content.
    const snapshot = await serializeFileMap(files, source.fs, toRelative);

    expect(snapshot['/home/project/public/babylon.png']).toMatchObject({ isBinary: true, size: png.byteLength });

    // The snapshot must survive JSON transport (S3 tar / IndexedDB / share build).
    const transported: SerializedFileMap = JSON.parse(JSON.stringify(snapshot));

    // Ingress: restore into a brand-new container.
    const target = createMemFs();
    await writeSerializedFileMap(transported, target.fs, toRelative);

    const restored = await target.fs.readFile('public/babylon.png');

    expect(restored.byteLength).toBe(png.byteLength);
    expect(sha256(restored)).toBe(originalHash);

    // Text still round-trips as text.
    expect(new TextDecoder().decode(await target.fs.readFile('src/main.tsx'))).toBe('console.log("hi")');
  });

  it('preserves a REAL PNG file from disk through the production snapshot path', async () => {
    // A genuine PNG, not a synthetic one — the exact class of file the bug destroyed.
    const png = new Uint8Array(readFileSync(resolve(process.cwd(), 'public/apple-touch-icon.png')));
    expect(png.byteLength).toBeGreaterThan(1000);

    const source = createMemFs();
    await source.fs.writeFile('public/babylon.png', png);

    const files: FileMap = { '/home/project/public/babylon.png': fileEntryFromBuffer(png) };
    const toRelative = (p: string) => p.replace('/home/project/', '');

    const snapshot = JSON.parse(JSON.stringify(await serializeFileMap(files, source.fs, toRelative)));

    const target = createMemFs();
    await writeSerializedFileMap(snapshot, target.fs, toRelative);

    const restored = await target.fs.readFile('public/babylon.png');

    expect(sha256(restored)).toBe(sha256(png));

    // And it is still a real PNG, magic bytes intact.
    expect([...restored.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('omits unreadable binaries instead of silently zeroing them', async () => {
    const { fs } = createMemFs();
    const onError = vi.fn();

    const files: FileMap = {
      '/home/project/public/missing.png': { type: 'file', content: '', isBinary: true, size: 100 },
    };

    const snapshot = await serializeFileMap(files, fs, identity, onError);

    expect(onError).toHaveBeenCalledOnce();
    expect(snapshot['/home/project/public/missing.png']).toBeUndefined();
  });

  it('never writes binary content as a string (the corruption path)', async () => {
    const png = makePng(512);
    const target = createMemFs();

    await writeSerializedFileMap(
      { 'public/babylon.png': { type: 'file', content: bytesToBase64(png), isBinary: true } },
      target.fs,
      identity,
    );

    const written = target.disk.get('public/babylon.png')!;

    // If this were written as a string, UTF-8 expansion would inflate it past its true size.
    expect(written.byteLength).toBe(png.byteLength);
    expect(sha256(written)).toBe(sha256(png));
  });
});
