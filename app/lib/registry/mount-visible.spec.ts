/**
 * The model may not be asked to build a project it cannot see (SPEC §4.4, §4.2.8).
 *
 * 🔴 **This is written because creation shipped flying the model blind, and nothing anywhere noticed.**
 *
 * `writeTextFiles` awaits `container.fs.writeFile`, so when creation resolved, the bytes were
 * unquestionably on disk. But the model never reads the disk — it reads `workbenchStore.files`, a map a
 * WATCHER fills asynchronously afterwards. Creation fired the generation the instant the writes
 * resolved. Measured live, "make me a kart racer where the cars are shopping carts":
 *
 *     agent request fired at  5405ms  →   7 files sent
 *     store filled at         5531ms  →  0 → 78 files
 *
 * 126 milliseconds. The model wrote a racing game having been shown seven files, none of them source:
 * no `src/scripts/KartRacerMode.ts` (the class §4.4b had just scaffolded FOR it), no
 * `src/babylon/classes/`, no `globals.ts`. It said so in the product — "I can't see its source" — and
 * that was read as caution rather than as a bug report.
 *
 * Nothing threw, and the token count went DOWN, which reads as a cheaper turn. Only quality suffered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom } from 'nanostores';

const files = atom<Record<string, unknown>>({});

vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: { files } }));
vi.mock('~/lib/webcontainer', () => ({ webcontainer: Promise.resolve({}) }));

const { waitForMountVisible } = await import('./mount');

const asFile = (paths: string[]) =>
  Object.fromEntries(paths.map((p) => [p, { type: 'file', content: '', isBinary: false }]));

const GAME_MODE = '/home/project/src/scripts/KartRacerMode.ts';
const GLOBALS = '/home/project/src/babylon/globals.ts';
const SOURCE = '/home/project/src/babylon/classes/VehicleControllerDemo.ts';
const ALL = [GAME_MODE, GLOBALS, SOURCE];

beforeEach(() => {
  files.set({});
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('waiting for the mount to be visible', () => {
  it('returns immediately when the files are already there', async () => {
    files.set(asFile(ALL));

    await expect(waitForMountVisible(ALL, 1000)).resolves.toBe(true);
  });

  /** The real shape: the watcher reports the whole mount in one batch, slightly late. */
  it('waits for a watcher that reports late, then succeeds', async () => {
    setTimeout(() => files.set(asFile(ALL)), 120);

    await expect(waitForMountVisible(ALL, 3000)).resolves.toBe(true);
  });

  /**
   * 🔴 The bug, as a test. A partially-filled store is exactly what creation used to generate against:
   * some `public/` binaries had landed, no source had.
   */
  it('does NOT return while the store holds only some of the mount', async () => {
    files.set(asFile(['/home/project/public/favicon.ico', GLOBALS]));

    await expect(waitForMountVisible(ALL, 250)).resolves.toBe(false);
  });

  it('does not mistake a DIRECTORY entry for the file', async () => {
    files.set({ ...asFile([GLOBALS, SOURCE]), [GAME_MODE]: { type: 'folder' } });

    await expect(waitForMountVisible(ALL, 250)).resolves.toBe(false);
  });

  /**
   * Degrade, never hang (§1.3 principle 0). A thin context is bad; a New Project button that never
   * returns is worse. The `false` is the caller's signal that it happened, and it is logged loudly.
   */
  it('gives up after the timeout and reports it, rather than hanging', async () => {
    const started = Date.now();

    await expect(waitForMountVisible(ALL, 200)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waits for every path, not just the first', async () => {
    files.set(asFile([GAME_MODE]));

    await expect(waitForMountVisible(ALL, 200)).resolves.toBe(false);

    files.set(asFile(ALL));

    await expect(waitForMountVisible(ALL, 1000)).resolves.toBe(true);
  });

  it('is trivially satisfied by an empty requirement', async () => {
    await expect(waitForMountVisible([], 200)).resolves.toBe(true);
  });
});
