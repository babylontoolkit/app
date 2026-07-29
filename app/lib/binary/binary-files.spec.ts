import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  base64ByteLength,
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

/**
 * `base64ByteLength` (T9b) — the restore write-through's answer to "how big is this binary?".
 *
 * The number it returns is the ONLY thing anyone — the editor, an egress path, the model — is ever
 * told about a binary's contents (`content` is empty by SPEC §1.3 principle 10). A serialized entry
 * usually carries `size`, but it is optional in `SerializedDirent`, and the tempting fallback is
 * `content.length` — the BASE64 length, which overstates every binary by ~4/3, silently, since
 * nothing in the product compares the two. Hence a derived length, and hence these tests: the
 * agreement with a real decode is the property, the edge cases are how it goes wrong.
 */
describe('base64ByteLength', () => {
  it('handles the empty string, and every padding shape', () => {
    expect(base64ByteLength('')).toBe(0);

    // 4 chars, no padding → 3 bytes; one '=' → 2 bytes; two '==' → 1 byte.
    expect(base64ByteLength('QUJD')).toBe(3); // "ABC"
    expect(base64ByteLength('QUI=')).toBe(2); // "AB"
    expect(base64ByteLength('QQ==')).toBe(1); // "A"
  });

  it('ignores embedded newlines — a wrapped base64 body is still the same bytes', () => {
    /*
     * base64 that has travelled through a JSON/MIME-ish pipe can arrive line-wrapped. Counting the
     * newlines as payload would inflate the reported size of exactly the files that took that route.
     */
    const wrapped = 'QUJD\nQUJD\r\nQUJD';
    expect(base64ByteLength(wrapped)).toBe(9);
    expect(base64ByteLength(wrapped)).toBe(base64ToBytes(wrapped).byteLength);
  });

  it('agrees with base64ToBytes(...).byteLength on real bytes of every length-mod-3', () => {
    /*
     * The property that matters: the derived number and the decoded number are the same number. Run
     * over sizes covering all three padding classes plus a real PNG, so a future "optimization" of
     * the arithmetic cannot drift for one residue class only.
     */
    const samples: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0x00]),
      new Uint8Array([0x00, 0xff]),
      new Uint8Array([0x89, 0x50, 0x4e]),
      makePng(1),
      makePng(2),
      makePng(3),
      makePng(4095),
    ];

    for (const bytes of samples) {
      const encoded = bytesToBase64(bytes);

      expect(base64ByteLength(encoded)).toBe(bytes.byteLength);
      expect(base64ByteLength(encoded)).toBe(base64ToBytes(encoded).byteLength);
    }
  });

  it('is smaller than the base64 length it is derived from — the whole reason it exists', () => {
    const encoded = bytesToBase64(makePng(4096));

    // ~4/3 inflation is what reporting `content.length` would have shipped.
    expect(base64ByteLength(encoded)).toBeLessThan(encoded.length);
    expect(base64ByteLength(encoded)).toBe(4104);
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

  /**
   * T17a — one bad entry must not kill the whole restore. Measured live: a stale checkpoint carried
   * an entry whose on-disk path is now a DIRECTORY, the provider threw a raw
   * `21: Os { code: 21, kind: IsADirectory }`, and the entire primary open path silently degraded to
   * the legacy mount, losing every file plus the wake hook.
   */
  describe('per-entry containment (T17a)', () => {
    const EISDIR = '21: Os { code: 21, kind: IsADirectory, message: "Is a directory" }';

    /** A memfs whose writeFile throws the MEASURED wire error for one chosen path. */
    function throwingFs(badPath: string) {
      const mem = createMemFs();
      const writeFile = mem.fs.writeFile.bind(mem.fs);

      mem.fs.writeFile = async (path: string, data: string | Uint8Array) => {
        if (path === badPath) {
          throw new Error(EISDIR);
        }

        await writeFile(path, data);
      };

      return mem;
    }

    const payload: SerializedFileMap = {
      '.codesandbox/tasks.json': { type: 'file', content: '{}', isBinary: false },
      'src/main.tsx': { type: 'file', content: 'export {};\n', isBinary: false },
      'public/babylon.png': { type: 'file', content: bytesToBase64(makePng(64)), isBinary: true },
    };

    it('with onError: the throwing path is reported and the REST of the map still lands', async () => {
      const target = throwingFs('.codesandbox/tasks.json');
      const onError = vi.fn();

      await writeSerializedFileMap(payload, target.fs, identity, { onError });

      // The failure is reported for exactly that path, with the provider's error attached.
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBe('.codesandbox/tasks.json');
      expect((onError.mock.calls[0][1] as Error).message).toBe(EISDIR);

      // Containment: every OTHER file was written anyway.
      expect(new TextDecoder().decode(target.disk.get('src/main.tsx'))).toBe('export {};\n');
      expect(target.disk.get('public/babylon.png')!.byteLength).toBe(makePng(64).byteLength);
      expect(target.disk.has('.codesandbox/tasks.json')).toBe(false);
    });

    it('without onError: the error still throws out (regression pin on historical behaviour)', async () => {
      const target = throwingFs('.codesandbox/tasks.json');

      await expect(writeSerializedFileMap(payload, target.fs, identity)).rejects.toThrow(EISDIR);
    });

    it('onProgress counts FILE entries only — folders are excluded from the total', async () => {
      const target = createMemFs();
      const ticks: Array<[number, number]> = [];

      await writeSerializedFileMap(
        {
          public: { type: 'folder' },
          'public/nested': { type: 'folder' },
          'src/main.tsx': { type: 'file', content: 'export {};\n', isBinary: false },
          'public/babylon.png': { type: 'file', content: bytesToBase64(makePng(64)), isBinary: true },
        },
        target.fs,
        identity,
        { onProgress: (done, total) => ticks.push([done, total]) },
      );

      // Two files → (1,2), (2,2). Four entries would have read as a stalled 2-of-4 forever.
      expect(ticks).toEqual([
        [1, 2],
        [2, 2],
      ]);
    });
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
