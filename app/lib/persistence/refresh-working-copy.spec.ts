/**
 * The post-checkpoint working-copy refresh (SPEC §4.5.4c, §4.16).
 *
 * Both rules here fail silently. Minting a fresh `seq` invents a state the local history has no
 * counterpart for, which corrupts the resume comparison; running before the first checkpoint would
 * store a copy that is a top-up of nothing. And the coalescing is what stops four images landing
 * together from uploading the whole project four times.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Typed args, so the seq assertion below reads `calls[0][1]` rather than indexing an empty tuple. */
const saveWorkingCopy = vi.fn(async (_projectId: string, _seq: number, _files: unknown) => undefined);
const serializeFiles = vi.fn(async () => ({ 'a.ts': { type: 'file', content: 'x', isBinary: false } }));
const readCurrentLocalSnapshot = vi.fn(async () => ({ id: 's1', seq: 12 }) as unknown);
const projectIdGet = vi.fn(() => 'prj_1' as string | undefined);

vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: { serializeFiles: () => serializeFiles() } }));
vi.mock('~/lib/persistence/useChatHistory', () => ({
  projectId: { get: () => projectIdGet() },
  db: {} as IDBDatabase,
}));
vi.mock('~/lib/persistence/local-snapshots', () => ({
  readCurrentLocalSnapshot: (...args: unknown[]) => readCurrentLocalSnapshot(...(args as [])),
}));
vi.mock('~/lib/persistence/projects', () => ({
  saveWorkingCopy: (...args: unknown[]) => saveWorkingCopy(...(args as [string, number, unknown])),
}));

let refreshWorkingCopySoon: (reason: string) => void;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();

  /*
   * Implementations, not just call counts. `clearAllMocks` clears `mock.calls` and leaves
   * implementations in place, so the empty-map case below otherwise leaks into every test after it —
   * which reads as "the refresh never fires" rather than as pollution.
   */
  projectIdGet.mockReturnValue('prj_1');
  readCurrentLocalSnapshot.mockResolvedValue({ id: 's1', seq: 12 });
  serializeFiles.mockResolvedValue({ 'a.ts': { type: 'file', content: 'x', isBinary: false } });
  saveWorkingCopy.mockResolvedValue(undefined as never);
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

    expect(saveWorkingCopy).toHaveBeenCalledTimes(1);
    expect(saveWorkingCopy.mock.calls[0][1]).toBe(12);
  });

  it('does nothing before the first checkpoint — there is no seq to borrow', async () => {
    readCurrentLocalSnapshot.mockResolvedValue(undefined);

    refreshWorkingCopySoon('media 1');
    await settle();

    expect(saveWorkingCopy).not.toHaveBeenCalled();
  });

  it('does nothing without a project', async () => {
    projectIdGet.mockReturnValue(undefined);

    refreshWorkingCopySoon('media 1');
    await settle();

    expect(saveWorkingCopy).not.toHaveBeenCalled();
  });

  /* A client mid-mount reports zero files; storing that would overwrite a good copy with an empty one. */
  it('never stores an empty file map', async () => {
    serializeFiles.mockResolvedValue({} as never);

    refreshWorkingCopySoon('media 1');
    await settle();

    expect(saveWorkingCopy).not.toHaveBeenCalled();
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

    expect(saveWorkingCopy).toHaveBeenCalledTimes(1);
  });

  /* Control: the coalescing must not be swallowing writes that are genuinely separate. */
  it('still writes again for a delivery after the window closes', async () => {
    refreshWorkingCopySoon('media 1');
    await settle();

    refreshWorkingCopySoon('media 2');
    await settle();

    expect(saveWorkingCopy).toHaveBeenCalledTimes(2);
  });
});

describe('it is best-effort', () => {
  /* The local checkpoint is the copy that makes the data safe — a failed top-up must stay quiet. */
  it('swallows an upload failure rather than surfacing it', async () => {
    saveWorkingCopy.mockRejectedValueOnce(new Error('offline'));

    refreshWorkingCopySoon('media 1');
    await expect(settle()).resolves.not.toThrow();
  });
});
