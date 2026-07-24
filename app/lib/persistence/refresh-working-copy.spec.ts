/**
 * The post-checkpoint working-copy refresh (SPEC §4.5.4c, §4.16).
 *
 * Three rules here fail silently. Minting a fresh `seq` invents a state the local history has no
 * counterpart for, which corrupts the resume comparison; running before the first checkpoint would
 * store a copy that is a top-up of nothing; and serializing MID-STREAM competes with the live
 * generation for the main thread and memory — the shape that froze the tab on a media-heavy run. The
 * coalescing is what stops four images landing together from uploading the whole project four times.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Typed args, so the seq assertion below reads `calls[0][1]` rather than indexing an empty tuple. */
const writeWorkingCopyFromStore = vi.fn(async (_projectId: string, _seq: number) => 'saved' as string);
const readCurrentLocalSnapshot = vi.fn(async () => ({ id: 's1', seq: 12 }) as unknown);
const projectIdGet = vi.fn(() => 'prj_1' as string | undefined);
let streaming = false;

vi.mock('~/lib/stores/streaming', () => ({ streamingState: { get: () => streaming } }));
vi.mock('~/lib/persistence/useChatHistory', () => ({
  projectId: { get: () => projectIdGet() },
  db: {} as IDBDatabase,
}));
vi.mock('~/lib/persistence/local-snapshots', () => ({
  readCurrentLocalSnapshot: (...args: unknown[]) => readCurrentLocalSnapshot(...(args as [])),
}));
vi.mock('~/lib/persistence/working-copy-writer', () => ({
  writeWorkingCopyFromStore: (...args: unknown[]) => writeWorkingCopyFromStore(...(args as [string, number])),
}));

let refreshWorkingCopySoon: (reason: string) => void;
const COALESCE_MS = 4_000;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  /*
   * Implementations, not just call counts. `clearAllMocks` clears `mock.calls` and leaves
   * implementations in place, so a per-test override below otherwise leaks into every test after it.
   */
  projectIdGet.mockReturnValue('prj_1');
  readCurrentLocalSnapshot.mockResolvedValue({ id: 's1', seq: 12 });
  writeWorkingCopyFromStore.mockResolvedValue('saved');
  streaming = false;
  ({ refreshWorkingCopySoon } = await import('./refresh-working-copy'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** Run the debounce out and let the async push settle. */
async function settle() {
  await vi.runAllTimersAsync();
}

describe('it tops up the LAST checkpoint rather than inventing a new state', () => {
  /*
   * 🔴 A late asset completes the checkpoint that referenced it; it is not a new logical state. A
   * fresh seq here would invent an ordering, and inventing an ordering is how a stale copy wins a
   * comparison it should have lost.
   */
  it('reuses the current local checkpoint seq', async () => {
    refreshWorkingCopySoon('media 1');
    await settle();

    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
    expect(writeWorkingCopyFromStore.mock.calls[0][1]).toBe(12);
  });

  it('does nothing before the first checkpoint — there is no seq to borrow', async () => {
    readCurrentLocalSnapshot.mockResolvedValue(undefined);

    refreshWorkingCopySoon('media 1');
    await settle();

    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
  });

  it('does nothing without a project', async () => {
    projectIdGet.mockReturnValue(undefined);

    refreshWorkingCopySoon('media 1');
    await settle();

    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();
  });
});

describe('it never serializes mid-generation (§4.16 — the freeze)', () => {
  /*
   * 🔴 The refresh fired 4s after the first media render landed — squarely mid-stream, while more
   * renders were still arriving — and serializing the project there is what pinned the main thread.
   * While the stream is live it must reschedule, never serialize.
   */
  it('defers while streaming, then writes once the stream ends', async () => {
    streaming = true;
    refreshWorkingCopySoon('media 1');

    // The window elapses; push runs, sees the live stream, and reschedules WITHOUT serializing.
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(writeWorkingCopyFromStore).not.toHaveBeenCalled();

    // Stream ends; the rescheduled window fires and the save finally happens — exactly once.
    streaming = false;
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 1);
    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
  });
});

describe('coalescing', () => {
  /*
   * A creation commissions up to four images that land seconds apart, and every write is the WHOLE
   * project. One upload per image is four uploads of the same project for one logical change.
   */
  it('collapses a burst of deliveries into a single write', async () => {
    refreshWorkingCopySoon('media 1');
    refreshWorkingCopySoon('media 2');
    refreshWorkingCopySoon('media 3');
    refreshWorkingCopySoon('media 4');
    await settle();

    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(1);
  });

  /* Control: the coalescing must not be swallowing writes that are genuinely separate. */
  it('still writes again for a delivery after the window closes', async () => {
    refreshWorkingCopySoon('media 1');
    await settle();

    refreshWorkingCopySoon('media 2');
    await settle();

    expect(writeWorkingCopyFromStore).toHaveBeenCalledTimes(2);
  });
});

describe('it is best-effort', () => {
  /* The local checkpoint is the copy that makes the data safe — a failed top-up must stay quiet. */
  it('swallows an upload failure rather than surfacing it', async () => {
    writeWorkingCopyFromStore.mockRejectedValueOnce(new Error('offline'));

    refreshWorkingCopySoon('media 1');
    await expect(settle()).resolves.not.toThrow();
  });

  /* A 'skipped-too-large' result is a normal degradation, not an error — it must not throw either. */
  it('handles a size-gated skip without surfacing it', async () => {
    writeWorkingCopyFromStore.mockResolvedValueOnce('skipped-too-large');

    refreshWorkingCopySoon('media 1');
    await expect(settle()).resolves.not.toThrow();
  });
});
