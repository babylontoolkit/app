import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewErrorsStore } from '~/lib/preview/bridge';
import type { PreviewErrorEntry } from '~/lib/preview/protocol';
import { localSceneExplainerStore, resetLocalSceneExplainerForTests, startLocalSceneExplainer } from './explainer';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: (() => void) | undefined;

beforeEach(() => {
  resetLocalSceneExplainerForTests();
  previewErrorsStore.set([]);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  previewErrorsStore.set([]);
  resetLocalSceneExplainerForTests();
});

const entry = (over: Partial<PreviewErrorEntry>): PreviewErrorEntry => ({
  type: 'network',
  message: 'Network request failed',
  url: 'http://localhost:8899/nope.gltf',
  at: 1,
  ...over,
});

describe('startLocalSceneExplainer', () => {
  it('two network errors for the same origin & cause → store set once', async () => {
    const check = vi.fn(async () => 'not-running' as const);
    const sets: unknown[] = [];
    stop = startLocalSceneExplainer({ check });

    const unwatch = localSceneExplainerStore.listen((value) => sets.push(value));

    previewErrorsStore.set([entry({ at: 1 })]);
    await flush();
    previewErrorsStore.set([entry({ at: 1 }), entry({ at: 2, url: 'http://localhost:8899/nope.bin' })]);
    await flush();
    unwatch();

    expect(sets).toEqual([{ cause: 'not-running', origin: 'http://localhost:8899' }]);

    /* The ring is REPLACED on every push — an entry already seen is never re-checked. */
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('an error-type entry → ignored', async () => {
    const check = vi.fn(async () => 'not-running' as const);
    stop = startLocalSceneExplainer({ check });

    previewErrorsStore.set([entry({ type: 'error' })]);
    await flush();

    expect(check).not.toHaveBeenCalled();
    expect(localSceneExplainerStore.get()).toBeNull();
  });

  it('a running server → nothing shown', async () => {
    stop = startLocalSceneExplainer({ check: async () => 'running' });

    previewErrorsStore.set([entry({})]);
    await flush();

    expect(localSceneExplainerStore.get()).toBeNull();
  });
});
