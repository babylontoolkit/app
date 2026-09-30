/**
 * 🔴 A failed load from the user's LOCAL dev server must not raise the paid preview alert (D27).
 *
 * The alert is `source:'preview'`, which the auto-repair loop accepts inside its window, so a stopped
 * Unity dev server right after a generation would spend a billed repair turn on something no code change
 * can fix. The local-scene explainer owns those entries; they still land in `previewErrorsStore`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const alertSet = vi.fn();

vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: { actionAlert: { set: (v: unknown) => alertSet(v) } } }));

vi.mock('./bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge')>();

  return { ...actual, installPreviewAgent: vi.fn(async () => true) };
});

import { previewErrorsStore } from './bridge';
import { installPreviewDevTools, raisesPreviewAlert } from './install';
import {
  beginWorkspaceCheck,
  CHECK_WINDOW_GRACE_MS,
  endWorkspaceCheck,
  resetWorkspaceCheckWindow,
} from '~/lib/agent-workspace/check-window';
import type { PreviewErrorEntry } from './protocol';

const entry = (over: Partial<PreviewErrorEntry>): PreviewErrorEntry => ({
  type: 'error',
  message: 'boom',
  at: 1,
  ...over,
});

beforeAll(async () => {
  await installPreviewDevTools({ capabilities: { previewScript: true }, setPreviewScript: async () => undefined });
});

beforeEach(() => {
  alertSet.mockClear();
});

describe('watchForErrors — which preview errors raise the alert', () => {
  it('CONTROL: an error-type entry still raises the alert', () => {
    previewErrorsStore.set([entry({ type: 'error', message: 'GetKeyDown is not a function', at: 10 })]);

    expect(alertSet).toHaveBeenCalledTimes(1);
    expect(alertSet.mock.calls[0][0]).toMatchObject({ source: 'preview', description: 'GetKeyDown is not a function' });
  });

  it('a network entry does not raise the alert, and stays in the store for get_game_errors', () => {
    const local = entry({ type: 'network', message: 'Network request failed', url: 'http://localhost:8899/x', at: 20 });
    previewErrorsStore.set([local]);

    expect(alertSet).not.toHaveBeenCalled();
    expect(previewErrorsStore.get()).toContainEqual(local);
  });

  it('a resource entry does not raise the alert', () => {
    previewErrorsStore.set([entry({ type: 'resource', url: 'http://localhost:8899/a.png', at: 30 })]);

    expect(alertSet).not.toHaveBeenCalled();
  });

  it('a real error after a local failure still raises it (the network entry is skipped, not the batch)', () => {
    previewErrorsStore.set([
      entry({ type: 'network', url: 'http://localhost:8899/x', at: 40 }),
      entry({ type: 'rejection', message: 'late', at: 41 }),
    ]);

    expect(alertSet).toHaveBeenCalledTimes(1);
    expect(alertSet.mock.calls[0][0]).toMatchObject({ description: 'late' });
  });

  it('the predicate', () => {
    expect(raisesPreviewAlert(entry({ type: 'error' }))).toBe(true);
    expect(raisesPreviewAlert(entry({ type: 'rejection' }))).toBe(true);
    expect(raisesPreviewAlert(entry({ type: 'network' }))).toBe(false);
    expect(raisesPreviewAlert(entry({ type: 'resource' }))).toBe(false);
  });
});

describe("a game check's own navigation never raises the alert (T9 fix loop)", () => {
  beforeEach(() => resetWorkspaceCheckWindow());

  it('an error while check_game drives the preview stays out of the alert (and in the store)', () => {
    beginWorkspaceCheck();

    const during = entry({
      type: 'error',
      message: "Cannot read properties of null (reading 'focus')",
      at: Date.now(),
    });
    previewErrorsStore.set([during]);

    expect(alertSet).not.toHaveBeenCalled();
    expect(previewErrorsStore.get()).toContainEqual(during);

    endWorkspaceCheck();
  });

  it('CONTROL: the same error well after the check ends raises it', () => {
    // `at` must be newer than anything the watcher has seen (the spec above stamps Date.now()).
    const endedAt = Date.now() + 60_000;
    beginWorkspaceCheck();
    endWorkspaceCheck(endedAt);

    previewErrorsStore.set([
      entry({ type: 'error', message: 'real bug', at: endedAt + CHECK_WINDOW_GRACE_MS + 5_000 }),
    ]);

    expect(alertSet).toHaveBeenCalledTimes(1);
    expect(alertSet.mock.calls[0][0]).toMatchObject({ description: 'real bug' });
  });
});
