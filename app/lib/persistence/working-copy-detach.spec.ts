/**
 * 🔴 A WORKING-COPY SAVE MUST LEAVE THE SANDBOX'S OWN BYTES READABLE (found live, 2026-08-09).
 *
 * Reported as: the FIRST attempt to save or link to GitHub after a build fails, every binary at once —
 *
 *   FilesStore Failed to read 22 binary file(s) for serialization
 *   (last error: TypeError: Cannot perform Construct on a detached or out-of-bounds ArrayBuffer)
 *
 * — and a page refresh makes it work again. The chain, proven at every link:
 *
 *   1. Nodepod's VFS returns its OWN storage. `memory-volume.ts` `readFileSync` ends with
 *      `return inode.content` — the live `Uint8Array` the file is stored in, not a copy. Every other
 *      provider hands back a fresh buffer decoded off a transport, so this is invisible until Nodepod.
 *   2. `writeWorkingCopyFromStore` TRANSFERRED `bytes.buffer` to the encode worker (zero-copy, §4.16).
 *      Transferring detaches the buffer in the sending thread — so it detached **the VFS's own storage**
 *      for every binary in the project.
 *   3. The next `serializeFiles` (Save, Link to GitHub, ZIP, deploy, share) re-reads those files, gets
 *      the detached views back, and `bytesToBase64` → `Buffer.from` → `new Uint8Array(view)` throws.
 *      That `new Uint8Array` is literally `buffer@5.7.1`'s `fromArrayView`, which is where the user's
 *      error text comes from.
 *   4. A refresh reboots the pod and rehydrates the VFS, which is why refreshing "fixes" it.
 *
 * The rule the fix encodes is not about Nodepod: **you may only transfer memory you allocated.** A
 * buffer that came out of a provider is on loan.
 *
 * ## Why this test can see it when the others could not
 *
 * The existing working-copy specs assert the ENVELOPE (`working-copy-envelope.spec.ts`) and the size
 * gate — they never run a real transfer, because a stubbed `postMessage` does nothing to a buffer. The
 * fake worker here calls `structuredClone(message, { transfer })`, which detaches for real, exactly as
 * `Worker.postMessage` does. Without that the whole file passes against the broken code.
 *
 * ⚠️ The assertion is `new Uint8Array(bytes)`, not `Buffer.from(bytes)`: Node's native `Buffer.from`
 * returns an EMPTY buffer for a detached view instead of throwing, so an assertion written against it
 * would go green here while the browser threw. `new Uint8Array` is the operation the browser polyfill
 * actually performs, and it is also the honest question — are these bytes still usable?
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The project's binaries, held the way Nodepod holds them: one live array per file. */
let vfs: Map<string, Uint8Array>;

/** Every `{ entries }` the fake worker received, so a test can prove the bytes still travelled. */
let posted: Array<{ entries: Array<{ path: string; bytes?: Uint8Array; text?: string }> }>;

const HAVOK = '/home/project/public/scripts/havok.wasm';
const HERO = '/home/project/public/assets/generated/hero-keyart.png';

function bytesFor(seed: number, length = 64): Uint8Array {
  return new Uint8Array(Array.from({ length }, (_, i) => (seed + i) % 256));
}

/**
 * A Worker double that transfers FOR REAL.
 *
 * `structuredClone(value, { transfer })` is the same underlying operation `postMessage` performs, so
 * anything listed in `transfer` is genuinely detached in this thread when it returns. That is the whole
 * point of the file.
 */
class TransferringWorker {
  onmessage: ((event: { data: { requestId: number; ok: boolean } }) => void) | null = null;
  onerror: (() => void) | null = null;

  postMessage(message: any, transfer?: Transferable[]) {
    const delivered = structuredClone(message, transfer ? { transfer } : undefined);
    posted.push(delivered);

    queueMicrotask(() => this.onmessage?.({ data: { requestId: message.requestId, ok: true } }));
  }

  terminate() {}
}

async function loadWriter() {
  vi.resetModules();

  vi.doMock('~/lib/stores/workbench', () => ({
    workbenchStore: {
      files: {
        get: () => ({
          [HAVOK]: { type: 'file', content: '', isBinary: true, size: vfs.get(HAVOK)!.byteLength },
          [HERO]: { type: 'file', content: '', isBinary: true, size: vfs.get(HERO)!.byteLength },
          '/home/project/src/main.ts': { type: 'file', content: 'export const go = 1;', isBinary: false, size: 20 },
        }),
      },

      /*
       * 🔴 Returns the STORED array itself — Nodepod's `readFileSync` semantics, and the entire reason
       * the bug exists. A double that returned `stored.slice()` would make this file pass against the
       * broken writer, which is the shape of every test that drove around this defect.
       */
      readBinaryFile: async (path: string) => {
        const stored = vfs.get(path);

        if (!stored) {
          throw new Error(`ENOENT: ${path}`);
        }

        return stored;
      },
    },
  }));

  return import('./working-copy-writer');
}

beforeEach(() => {
  vfs = new Map([
    [HAVOK, bytesFor(1)],
    [HERO, bytesFor(200)],
  ]);
  posted = [];

  vi.stubGlobal('Worker', TransferringWorker);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('writeWorkingCopyFromStore does not consume the sandbox it read from', () => {
  it('leaves every binary readable afterwards — the reported failure', async () => {
    const { writeWorkingCopyFromStore } = await loadWriter();

    expect(await writeWorkingCopyFromStore('proj_kart', 3)).toBe('saved');

    for (const [path, stored] of vfs) {
      /*
       * `new Uint8Array(view)` is what `Buffer.from` does in the browser (buffer@5.7.1 `fromArrayView`),
       * i.e. the exact call that produced "Cannot perform Construct on a detached or out-of-bounds
       * ArrayBuffer" for all 22 of this project's binaries.
       */
      expect(() => new Uint8Array(stored), `${path} was detached by the save`).not.toThrow();
      expect(stored.byteLength).toBe(64);
    }
  });

  /*
   * The property one level down, and the one that generalises past this provider: what we hand the
   * worker must be memory we allocated. Identity is the whole assertion — a copy may hold the same
   * bytes, but only a copy is ours to give away.
   */
  it('hands the worker its own copy, never the array the sandbox lent us', async () => {
    const { writeWorkingCopyFromStore } = await loadWriter();
    await writeWorkingCopyFromStore('proj_kart', 3);

    expect(vfs.get(HAVOK)!.buffer.byteLength).toBeGreaterThan(0);
    expect(vfs.get(HERO)!.buffer.byteLength).toBeGreaterThan(0);
  });

  /*
   * 🔴 CONTROL. Every assertion above passes for a writer that stopped sending binaries at all — which
   * is the silent way to "fix" a detachment bug and lose the user's art from their only crash-recovery
   * copy. This proves the bytes still arrive, and arrive intact.
   */
  it('CONTROL — the worker still receives the real bytes', async () => {
    const { writeWorkingCopyFromStore } = await loadWriter();
    await writeWorkingCopyFromStore('proj_kart', 3);

    expect(posted).toHaveLength(1);

    const delivered = new Map(posted[0].entries.map((entry) => [entry.path, entry]));

    expect(Array.from(delivered.keys()).sort()).toEqual([HERO, HAVOK, '/home/project/src/main.ts'].sort());
    expect(Array.from(delivered.get(HAVOK)!.bytes!)).toEqual(Array.from(bytesFor(1)));
    expect(Array.from(delivered.get(HERO)!.bytes!)).toEqual(Array.from(bytesFor(200)));
    expect(delivered.get('/home/project/src/main.ts')!.text).toBe('export const go = 1;');
  });
});
