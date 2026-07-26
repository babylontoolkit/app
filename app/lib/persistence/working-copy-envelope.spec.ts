import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '~/lib/binary/binary-files';
import { assembleSerializedMap, buildWorkingCopyBody, type WorkingCopyEntry } from './working-copy-envelope';

/** A payload with high bytes — the shape that UTF-8 re-encoding corrupts. */
function makeBytes(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);

  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 37) % 256;
  }

  return bytes;
}

describe('assembleSerializedMap', () => {
  it('base64-encodes binaries byte-faithfully (matches the shared encoder) and keeps text verbatim', () => {
    const bytes = makeBytes();
    const entries: WorkingCopyEntry[] = [
      { path: '/home/project/public/hero.jpg', isBinary: true, size: bytes.byteLength, bytes },
      { path: '/home/project/src/main.ts', isBinary: false, text: 'console.log(1)' },
    ];

    const map = assembleSerializedMap(entries);

    const hero = map['/home/project/public/hero.jpg'];
    expect(hero).toEqual({
      type: 'file',
      content: bytesToBase64(bytes),
      isBinary: true,
      size: bytes.byteLength,
    });

    // Round-trips back to the exact bytes.
    expect(base64ToBytes(hero!.type === 'file' ? hero!.content : '')).toEqual(bytes);

    expect(map['/home/project/src/main.ts']).toEqual({
      type: 'file',
      content: 'console.log(1)',
      isBinary: false,
      size: undefined,
    });
  });

  it('handles a binary entry with no bytes as empty rather than throwing', () => {
    const map = assembleSerializedMap([{ path: '/x.png', isBinary: true }]);
    expect(map['/x.png']).toEqual({ type: 'file', content: '', isBinary: true, size: 0 });
  });
});

describe('buildWorkingCopyBody', () => {
  it('produces the { seq, files } envelope the working-copy route expects', () => {
    const bytes = makeBytes(64);
    const body = buildWorkingCopyBody(7, [{ path: '/a.png', isBinary: true, size: 64, bytes }]);
    const parsed = JSON.parse(body) as { seq: number; files: Record<string, { content: string; isBinary: boolean }> };

    expect(parsed.seq).toBe(7);
    expect(parsed.files['/a.png'].isBinary).toBe(true);
    expect(base64ToBytes(parsed.files['/a.png'].content)).toEqual(bytes);
  });
});

describe('the envelope carries the turn it contains', () => {
  /**
   * Without `messageId` a recovery mount cannot say which turn its files hold, and
   * `detectUnappliedTurn` reads "cannot say" as "does not have it" — which raised the §4.5.4c dialog
   * on every single recovery, about work sitting in that very envelope.
   */
  it('includes messageId when given one', () => {
    const body = JSON.parse(buildWorkingCopyBody(7, [{ path: '/a.ts', isBinary: false, text: 'x' }], 'msg-9'));

    expect(body.messageId).toBe('msg-9');
    expect(body.seq).toBe(7);
  });

  it('omits it when there is none, rather than inventing one', () => {
    const body = JSON.parse(buildWorkingCopyBody(7, [{ path: '/a.ts', isBinary: false, text: 'x' }]));

    expect(body.messageId).toBeUndefined();
  });
});
