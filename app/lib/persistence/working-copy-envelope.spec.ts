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

/**
 * 🔴 THE BRANCH STAMP, AND THE BYTES OF AN ENVELOPE THAT HAS NONE (§4.13a T17).
 *
 * `branch` says which branch these files came from. There is ONE copy per project, overwritten in
 * place, so without it the copy is stale-by-branch the instant a switch lands and `selectMountSource`
 * has no way to see that — a recovery on a fresh browser with an unreachable remote would restore
 * another branch's tree over the project.
 *
 * The half that is easy to break while adding it is COMPATIBILITY IN BOTH DIRECTIONS. The route and
 * the stored object are shared with every copy written before the field existed, so:
 *
 *   - a body with no branch must be BYTE-IDENTICAL to what the old builder produced (`JSON.stringify`
 *     drops an `undefined` value entirely — asserting `parsed.branch === undefined` alone would also
 *     pass for a builder emitting `"branch": null`, which is a value the server would then coerce and
 *     store, i.e. a real difference hiding behind an equal-looking read);
 *   - an old stored object with no `branch` key must still parse — pinned against the real server
 *     reader in `app/lib/.server/projects/working-copy.spec.ts`, which is the only place the actual
 *     parse path lives.
 */
describe('the envelope carries the branch its files came from (§4.13a)', () => {
  const entries: WorkingCopyEntry[] = [{ path: '/a.ts', isBinary: false, text: 'x' }];

  it('includes branch when given one', () => {
    const body = JSON.parse(buildWorkingCopyBody(7, entries, 'msg-9', 'feature/hud'));

    expect(body.branch).toBe('feature/hud');
    expect(body.messageId).toBe('msg-9');
    expect(body.seq).toBe(7);
  });

  /*
   * 🔴 BYTE-COMPATIBILITY. A caller that passes no branch must put exactly the pre-T17 bytes on the
   * wire — no `branch` key at all, not `null`, not `""`. Asserted as the whole string rather than
   * field-by-field, because the failure this guards is an EXTRA key appearing, which no assertion
   * about the keys you thought to check can ever see.
   */
  it('omits the key entirely when there is no branch — the pre-T17 body, unchanged', () => {
    const body = buildWorkingCopyBody(7, entries, 'msg-9');

    expect(body).toBe(JSON.stringify({ seq: 7, messageId: 'msg-9', files: assembleSerializedMap(entries) }));
    expect(body).not.toContain('branch');

    const parsed = JSON.parse(body);
    expect(parsed.seq).toBe(7);
    expect(parsed.files).toBeTruthy();
    expect(parsed.branch).toBeUndefined();
    expect('branch' in parsed).toBe(false);
  });

  /*
   * CONTROL for the assertion above: `not.toContain('branch')` would also pass for a builder that had
   * quietly stopped emitting the field at all. This is the same string WITH a branch, so the two
   * together say "present when given, absent when not" rather than merely "absent".
   */
  it('CONTROL — the same call WITH a branch really does change the bytes', () => {
    expect(buildWorkingCopyBody(7, entries, 'msg-9', 'feature/hud')).toBe(
      JSON.stringify({ seq: 7, messageId: 'msg-9', branch: 'feature/hud', files: assembleSerializedMap(entries) }),
    );
  });

  /*
   * The two optional fields are independent facts about the copy — the turn it holds, and the branch
   * it came from — and they arrive from different places (`messageId` from the checkpoint, `branch`
   * from `repoStatus`). A builder that positionally confused them, or that dropped one when the other
   * was absent, would be invisible to any test that always passes both.
   */
  it('carries either field without the other, both directions', () => {
    const branchOnly = JSON.parse(buildWorkingCopyBody(1, entries, undefined, 'feature/hud'));
    expect(branchOnly.branch).toBe('feature/hud');
    expect(branchOnly.messageId).toBeUndefined();

    const messageOnly = JSON.parse(buildWorkingCopyBody(1, entries, 'msg-9'));
    expect(messageOnly.messageId).toBe('msg-9');
    expect(messageOnly.branch).toBeUndefined();

    const neither = JSON.parse(buildWorkingCopyBody(1, entries));
    expect(neither.messageId).toBeUndefined();
    expect(neither.branch).toBeUndefined();
    expect(neither.seq).toBe(1);
  });

  /* The stamp must not disturb the payload it rides with — binaries stay byte-faithful. */
  it('leaves the files map untouched', () => {
    const bytes = makeBytes(64);
    const parsed = JSON.parse(
      buildWorkingCopyBody(7, [{ path: '/a.png', isBinary: true, size: 64, bytes }], undefined, 'feature/hud'),
    );

    expect(parsed.branch).toBe('feature/hud');
    expect(base64ToBytes(parsed.files['/a.png'].content)).toEqual(bytes);
  });
});
