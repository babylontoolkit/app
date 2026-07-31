/**
 * The unmountable-router refusal (found live 2026-07-31, SPEC §4.8).
 *
 * The sibling of the root-absolute-asset refusal, and strictly nastier: every asset loads with a 200
 * and the page is BLANK, so there is no 404 to notice and no error to read — the only trace was a
 * console warning inside the play iframe. A published game reached the owner's own link looking, from
 * the builder's side, exactly like a successful publish ("Your game is live! 🎉").
 *
 * `--base=./` is what makes the assets work under `/play/<id>/` (T17b), which is precisely what makes
 * `import.meta.env.BASE_URL` the string `"./"` — so a project that passes BASE_URL straight to
 * `<BrowserRouter basename>` mounts the router at `/./` and matches nothing. The current starter
 * resolves it at runtime (`appBasename()`); imported folders and remixes of old shares do not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnmountableRouterBasenameError, buildPrefix, publishBuild, unmountableRouterBasenames } from './publish';
import { errorResponse } from '~/lib/.server/http';
import { setObjectStore } from '~/lib/.server/storage';
import { setProjectStore } from '~/lib/.server/projects/store';
import type { ObjectStore, StoredObject } from '~/lib/.server/storage';
import type { Project, ProjectStore } from '~/lib/.server/projects/types';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

const file = (content: string, isBinary = false): SerializedFileMap[string] => ({ type: 'file', content, isBinary });

/**
 * VERBATIM from the build that shipped blank — `curl`'d back out of the published share and reduced to
 * the surrounding bytes. The detector has to survive real minifier output, not a hand-written sample.
 */
const REAL_MINIFIED =
  'rel:"noreferrer",children:"Babylon Toolkit"})]})]})]})}function v1(){return(0,x.jsx)(wy,{basename:"./",children:(0,x.jsx)(o1,{';

describe('unmountableRouterBasenames — what cannot match a prefixed share URL', () => {
  it('finds the literal in REAL minified output', () => {
    expect(unmountableRouterBasenames(REAL_MINIFIED)).toEqual(['./']);
  });

  it('finds the unminified source shape too', () => {
    expect(unmountableRouterBasenames('jsx(BrowserRouter, { basename: "./", children: x })')).toEqual(['./']);
  });

  it('handles single quotes', () => {
    expect(unmountableRouterBasenames("{basename:'./'}")).toEqual(['./']);
  });

  it('catches the bare-dot and pre-normalised forms as well', () => {
    expect(unmountableRouterBasenames('{basename:"."}')).toEqual(['.']);
    expect(unmountableRouterBasenames('{basename:"/./"}')).toEqual(['/./']);
  });

  it('reports each distinct literal once, however many times it appears', () => {
    expect(unmountableRouterBasenames('{basename:"./"} … {basename:"./"} … {basename:"."}')).toEqual(['./', '.']);
  });

  /*
   * The controls are the whole safety argument: a project using `appBasename()` computes the value at
   * runtime, so a healthy build contains NO such literal — and react-router's own internals (which ARE
   * in every bundle) must not trip it.
   */
  it('CONTROL: a runtime-resolved basename leaves no literal to match', () => {
    const healthy = 'function ay(){return new URL(zt.BASE_URL,window.location.href).pathname}jsx(wy,{basename:ay(),';

    expect(unmountableRouterBasenames(healthy)).toEqual([]);
  });

  it("CONTROL: react-router's own default and destructuring are not offences", () => {
    expect(unmountableRouterBasenames('function Mm({basename:i="/",children:f=null,')).toEqual([]);
    expect(unmountableRouterBasenames('let{basename:d,navigator:s}=p.useContext(ie)')).toEqual([]);
    expect(unmountableRouterBasenames('A=p.useMemo(()=>({basename:z,navigator:r,static:m})')).toEqual([]);
  });

  it("CONTROL: a deliberate absolute basename is the project's business, not ours", () => {
    expect(unmountableRouterBasenames('{basename:"/"}')).toEqual([]);
    expect(unmountableRouterBasenames('{basename:"/play/abc123/"}')).toEqual([]);
  });
});

describe('publishBuild refuses the blank-page build BEFORE writing anything', () => {
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

  /** Assets are all RELATIVE here — this build passes the T17b check and still renders nothing. */
  const entryHtml = file('<html><script type="module" crossorigin src="./index.js"></script></html>');

  const blankDist: SerializedFileMap = {
    'dist/index.html': entryHtml,
    'dist/index.js': file(REAL_MINIFIED),
  };

  const healthyDist: SerializedFileMap = {
    'dist/index.html': entryHtml,
    'dist/index.js': file('jsx(wy,{basename:ay(),children:z})'),
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

    // `env()` falls back to process.env and vitest loads `.env.local` — the `oauth.spec.ts` trap.
    vi.stubEnv('BUILD_MAX_MB', undefined as unknown as string);
    vi.stubEnv('BUILD_MAX_FILES', undefined as unknown as string);

    return stores;
  }

  it('throws UnmountableRouterBasenameError and WRITES NOTHING', async () => {
    const stores = install();

    await expect(publishBuild({ project, dist: blankDist })).rejects.toThrow(UnmountableRouterBasenameError);

    expect(stores.puts).toEqual([]);
    expect(stores.deletes).toEqual([]);
    expect(stores.updates).toEqual([]);
  });

  it('tells the user the exact edit — the file, the cause and the replacement', async () => {
    install();

    const error = await publishBuild({ project, dist: blankDist }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('src/app.tsx');
    expect((error as Error).message).toContain('import.meta.env.BASE_URL');
    expect((error as Error).message).toContain('appBasename');
  });

  it('checks EVERY js chunk, not just the entry — the router can live in any of them', async () => {
    const stores = install();
    const dist: SerializedFileMap = {
      'dist/index.html': entryHtml,
      'dist/index.js': file('console.log("boot")'),
      'dist/assets/app-a1b2.js': file(REAL_MINIFIED),
    };

    await expect(publishBuild({ project, dist })).rejects.toThrow(UnmountableRouterBasenameError);
    expect(stores.puts).toEqual([]);
  });

  it('CONTROL: a runtime-resolved basename publishes normally', async () => {
    const stores = install();

    const result = await publishBuild({ project, dist: healthyDist });

    expect(result.fileCount).toBe(2);
    expect(stores.puts).toContain(`${buildPrefix(result.shareId)}/index.html`);
    expect(stores.updates).toHaveLength(1);
  });

  it('CONTROL: a binary asset that happens to contain the bytes is never scanned', async () => {
    const stores = install();
    const dist: SerializedFileMap = {
      ...healthyDist,
      'dist/assets/model.glb': { type: 'file', isBinary: true, content: btoa(REAL_MINIFIED) },
    };

    const result = await publishBuild({ project, dist });

    expect(result.fileCount).toBe(3);
    expect(stores.puts).toContain(`${buildPrefix(result.shareId)}/assets/model.glb`);
  });
});

describe('UnmountableRouterBasenameError is a SAFE error the route surfaces verbatim', () => {
  it('carries a 422, is not retryable, and its message reaches the user', async () => {
    const error = new UnmountableRouterBasenameError(['./']);

    expect(error.statusCode).toBe(422);
    expect(error.isRetryable).toBe(false);

    // Behavioural pin on SAFE_ERRORS membership: an unlisted error becomes the generic sentence.
    const response = errorResponse(error);
    const body = (await response.json()) as { message: string };

    expect(response.status).toBe(422);
    expect(body.message).toContain('appBasename');
    expect(body.message).not.toContain('Something went wrong');
  });
});
