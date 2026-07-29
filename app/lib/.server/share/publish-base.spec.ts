/**
 * The root-absolute-asset refusal (T17b, SPEC §4.8).
 *
 * A share is served under a PREFIX — `/play/<shareId>/` — in every deployment, so a built `index.html`
 * that asks for `<script src="/index.js">` resolves the script to the BUILDER's own 404 page: the game
 * publishes fine and renders nothing, silently. The share build passes `--base=./`
 * (`SHARE_BUILD_COMMAND`), so this refusal is a regression tripwire — and it must fire BEFORE anything
 * is written, because a broken game on a public URL is worse than a refused publish.
 *
 * Deliberately narrow: only the boot-breaking refs (entry scripts, stylesheets, modulepreload). A
 * root-absolute favicon merely misses an icon, and refusing a working game over it would be a veto the
 * user cannot understand. Protocol-relative (`//cdn…`) is not root-absolute.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RootAbsoluteAssetError, buildPrefix, publishBuild, rootAbsoluteEntryRefs } from './publish';
import { errorResponse } from '~/lib/.server/http';
import { setObjectStore } from '~/lib/.server/storage';
import { setProjectStore } from '~/lib/.server/projects/store';
import type { ObjectStore, StoredObject } from '~/lib/.server/storage';
import type { Project, ProjectStore } from '~/lib/.server/projects/types';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const file = (content: string, isBinary = false): SerializedFileMap[string] => ({ type: 'file', content, isBinary });

describe('rootAbsoluteEntryRefs — what breaks a boot and what does not', () => {
  it('detects the vite-shaped entry script', () => {
    expect(rootAbsoluteEntryRefs('<script type="module" crossorigin src="/index.js"></script>')).toEqual(['/index.js']);
  });

  it('detects a root-absolute stylesheet', () => {
    expect(rootAbsoluteEntryRefs('<link rel="stylesheet" crossorigin href="/index.css">')).toEqual(['/index.css']);
  });

  it('detects a root-absolute modulepreload', () => {
    expect(rootAbsoluteEntryRefs('<link rel="modulepreload" crossorigin href="/assets/vendor-a1b2.js">')).toEqual([
      '/assets/vendor-a1b2.js',
    ]);
  });

  it('is not fooled by attribute order (href before rel)', () => {
    expect(rootAbsoluteEntryRefs('<link href="/x.css" rel="stylesheet">')).toEqual(['/x.css']);
  });

  it('collects every offending ref, not just the first', () => {
    const html =
      '<script type="module" src="/index.js"></script>' +
      '<link rel="stylesheet" href="/index.css">' +
      '<link rel="modulepreload" href="/assets/chunk.js">';

    expect(rootAbsoluteEntryRefs(html)).toEqual(['/index.js', '/index.css', '/assets/chunk.js']);
  });

  it('passes a relative-base build — the healthy output of SHARE_BUILD_COMMAND', () => {
    const html =
      '<script type="module" crossorigin src="./assets/index-a1b2.js"></script>' +
      '<link rel="stylesheet" crossorigin href="./assets/index-c3d4.css">' +
      '<link rel="modulepreload" href="./assets/vendor.js">';

    expect(rootAbsoluteEntryRefs(html)).toEqual([]);
  });

  it('ignores protocol-relative URLs — //cdn is a host, not a root path', () => {
    expect(rootAbsoluteEntryRefs('<script src="//cdn.example/x.js"></script>')).toEqual([]);
    expect(rootAbsoluteEntryRefs('<link rel="stylesheet" href="//cdn.example/x.css">')).toEqual([]);
  });

  it('ignores non-entry links — a root-absolute favicon does not stop a game booting', () => {
    expect(rootAbsoluteEntryRefs('<link rel="icon" href="/favicon.ico">')).toEqual([]);
    expect(rootAbsoluteEntryRefs('<link rel="apple-touch-icon" href="/touch.png">')).toEqual([]);
  });
});

/**
 * publishBuild refuses BEFORE writing — a half-published broken game is the worst outcome.
 *
 * Store doubles via the standing test seams (`setObjectStore`/`setProjectStore`, the
 * `template-pin.spec.ts` pattern). The fakes RECORD; the assertions are on what was (not) written.
 */
describe('publishBuild — the refusal is pre-write, and the control publishes', () => {
  function makeStores() {
    const puts: string[] = [];
    const deletes: string[] = [];
    const objects: ObjectStore = {
      backend: 'filesystem',
      put: async (key: string) => {
        puts.push(key);
      },
      get: async () => null,
      delete: async (key: string) => {
        deletes.push(key);
      },
      list: async (): Promise<StoredObject[]> => [],
    };

    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const projects = {
      update: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return { id } as Project;
      },
    } as unknown as ProjectStore;

    return { objects, projects, puts, deletes, updates };
  }

  const project = { id: 'prj_1', userId: 'user_1', name: 'Kart Racer' } as Project;

  const brokenDist: SerializedFileMap = {
    'dist/index.html': file('<html><script type="module" crossorigin src="/index.js"></script></html>'),
    'dist/index.js': file('console.log("game")'),
  };

  const healthyDist: SerializedFileMap = {
    'dist/index.html': file(
      '<html><script type="module" crossorigin src="./assets/index.js"></script>' +
        '<link rel="stylesheet" href="./assets/index.css"></html>',
    ),
    'dist/assets/index.js': file('console.log("game")'),
    'dist/assets/index.css': file('body{}'),
  };

  afterEach(() => {
    setObjectStore(undefined);
    setProjectStore(undefined);
    vi.unstubAllEnvs();
  });

  function install() {
    const stores = makeStores();
    setObjectStore(stores.objects);
    setProjectStore(stores.projects);

    /*
     * ⚠️ `env()` falls back to `process.env` and vitest loads `.env.local` — a developer's local cap
     * override must not shape these assertions (the `oauth.spec.ts` trap).
     */
    vi.stubEnv('BUILD_MAX_MB', undefined as unknown as string);
    vi.stubEnv('BUILD_MAX_FILES', undefined as unknown as string);

    return stores;
  }

  it('throws RootAbsoluteAssetError on a root-absolute index.html and WRITES NOTHING', async () => {
    const stores = install();

    await expect(publishBuild({ project, dist: brokenDist })).rejects.toThrow(RootAbsoluteAssetError);

    expect(stores.puts).toEqual([]);
    expect(stores.deletes).toEqual([]);
    expect(stores.updates).toEqual([]);
  });

  it('names the offending ref in the error message — the user has to be able to act on it', async () => {
    install();

    await expect(publishBuild({ project, dist: brokenDist })).rejects.toThrow('/index.js');
  });

  it('CONTROL: a relative-base build publishes normally', async () => {
    const stores = install();

    const result = await publishBuild({ project, dist: healthyDist });

    expect(result.fileCount).toBe(3);
    expect(stores.puts).toContain(`${buildPrefix(result.shareId)}/index.html`);
    expect(stores.puts).toContain(`${buildPrefix(result.shareId)}/assets/index.js`);
    expect(stores.updates).toHaveLength(1);
    expect(stores.updates[0].patch.shareId).toBe(result.shareId);
  });

  it('does not refuse over a root-absolute ref in some OTHER html file — only the entry html gates', async () => {
    const stores = install();
    const dist: SerializedFileMap = {
      ...healthyDist,
      'dist/help.html': file('<script src="/not-the-entry.js"></script>'),
    };

    const result = await publishBuild({ project, dist });

    expect(result.fileCount).toBe(4);
    expect(stores.puts).toContain(`${buildPrefix(result.shareId)}/help.html`);
  });
});

describe('RootAbsoluteAssetError is a SAFE error the route surfaces verbatim', () => {
  it('carries a 422, is not retryable, and errorResponse passes its message through', async () => {
    const error = new RootAbsoluteAssetError(['/index.js']);

    expect(error.statusCode).toBe(422);
    expect(error.isRetryable).toBe(false);
    expect(error.name).toBe('RootAbsoluteAssetError');

    // Behavioural pin on the SAFE_ERRORS membership: an unsafe error becomes the generic sentence.
    const response = errorResponse(error);
    const body = (await response.json()) as { message: string; statusCode: number; isRetryable: boolean };

    expect(response.status).toBe(422);
    expect(body.message).toContain('/index.js');
    expect(body.message).not.toContain('Something went wrong');
    expect(body.isRetryable).toBe(false);
  });
});
