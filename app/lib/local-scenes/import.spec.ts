import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshPreviews = vi.fn();

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    refreshPreviews: () => refreshPreviews(),
    files: { get: () => ({}) },
    createFile: vi.fn(async () => true),
  },
}));

import { WORK_DIR } from '~/utils/constants';
import { handleLocalSceneCall, importLocalScene } from './import';

const SCENE = 'http://localhost:8888/scenes/Level01.gltf';
const BIN = new Uint8Array([0, 1, 2, 255, 254, 128, 7]);
const GLTF = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'Level01.bin' }] }));

function server(routes: Record<string, Uint8Array | number>) {
  return vi.fn(async (input: unknown) => {
    const route = routes[String(input)];

    if (route === undefined) {
      throw new TypeError('Failed to fetch');
    }

    if (typeof route === 'number') {
      return new Response('nope', { status: route });
    }

    return new Response(route.slice(), { status: 200 });
  }) as unknown as typeof fetch;
}

function recorder() {
  const writes = new Map<string, Uint8Array>();
  const write = vi.fn(async (path: string, bytes: Uint8Array) => {
    writes.set(path, bytes);
    return true;
  });

  return { writes, write };
}

beforeEach(() => {
  refreshPreviews.mockClear();
});

describe('importLocalScene', () => {
  it('writes byte-identical copies of what the server sent (D22)', async () => {
    const { writes, write } = recorder();
    const result = await importLocalScene(
      { url: SCENE, overwrite: false },
      { fetch: server({ [SCENE]: GLTF, 'http://localhost:8888/scenes/Level01.bin': BIN }), exists: () => false, write },
    );

    expect(result.ok).toBe(true);
    expect(result.written).toEqual(['public/scenes/Level01/Level01.gltf', 'public/scenes/Level01/Level01.bin']);
    expect(Array.from(writes.get(`${WORK_DIR}/public/scenes/Level01/Level01.bin`)!)).toEqual(Array.from(BIN));
    expect(Array.from(writes.get(`${WORK_DIR}/public/scenes/Level01/Level01.gltf`)!)).toEqual(Array.from(GLTF));
    expect(result.message).toContain('Imported 2 file(s) into public/scenes/Level01/');
    expect(result.message).toContain('"scenes/Level01/Level01.gltf"');
    expect(refreshPreviews).toHaveBeenCalledTimes(1);
  });

  it('an existing dest + overwrite:false → ok:false and zero writes', async () => {
    const { write } = recorder();
    const result = await importLocalScene(
      { url: SCENE, overwrite: false },
      {
        fetch: server({ [SCENE]: GLTF, 'http://localhost:8888/scenes/Level01.bin': BIN }),
        exists: (path) => path === `${WORK_DIR}/public/scenes/Level01/Level01.bin`,
        write,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('already exist');
    expect(result.message).toContain('overwrite');
    expect(write).not.toHaveBeenCalled();
    expect(refreshPreviews).not.toHaveBeenCalled();
  });

  it('overwrite:true → writes', async () => {
    const { write } = recorder();
    const result = await importLocalScene(
      { url: SCENE, overwrite: true },
      { fetch: server({ [SCENE]: GLTF, 'http://localhost:8888/scenes/Level01.bin': BIN }), exists: () => true, write },
    );

    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a 404 on the scene → ok:false with the status in the message', async () => {
    const { write } = recorder();
    const result = await importLocalScene(
      { url: SCENE, overwrite: false },
      { fetch: server({ [SCENE]: 404 }), exists: () => false, write },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('404');
    expect(write).not.toHaveBeenCalled();
  });

  it('a failed referenced file → ok:false, keeping what was already written', async () => {
    const { write } = recorder();
    const result = await importLocalScene(
      { url: SCENE, overwrite: false },
      { fetch: server({ [SCENE]: GLTF }), exists: () => false, write },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not fetch Level01.bin');
    expect(result.written).toEqual(['public/scenes/Level01/Level01.gltf']);
  });

  it('a scene URL whose basename decodes to ../../src/app.tsx → ok:false, no fetch, no write', async () => {
    const { write } = recorder();
    const fetchSpy = server({});
    const result = await importLocalScene(
      { url: 'http://localhost:8888/..%2F..%2Fsrc%2Fapp.tsx', overwrite: true },
      { fetch: fetchSpy, exists: () => false, write },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Refusing to import');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('CONTROL: Level%2001.glb imports as "Level 01.glb"', async () => {
    const { writes, write } = recorder();
    const url = 'http://localhost:8888/scenes/Level%2001.glb';
    const result = await importLocalScene(
      { url, overwrite: false },
      { fetch: server({ [url]: BIN }), exists: () => false, write },
    );

    expect(result.ok).toBe(true);
    expect([...writes.keys()]).toEqual([`${WORK_DIR}/public/scenes/Level-01/Level 01.glb`]);
  });

  it('a file named only in extras that the server does not have → skipped with a reason, import still ok', async () => {
    const { write } = recorder();
    const gltf = new TextEncoder().encode(
      JSON.stringify({
        buffers: [{ uri: 'Level01.bin' }],
        scenes: [{ extras: { metadata: { project: 'game.js', skybox: { url: 'assets/sky.env' } } } }],
      }),
    );
    const JS = new Uint8Array([47, 47, 10]);
    const result = await importLocalScene(
      { url: SCENE, overwrite: false },
      {
        fetch: server({
          [SCENE]: gltf,
          'http://localhost:8888/scenes/Level01.bin': BIN,
          'http://localhost:8888/scenes/game.js': JS,
          'http://localhost:8888/scenes/assets/sky.env': 404,
        }),
        exists: () => false,
        write,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.written).toEqual([
      'public/scenes/Level01/Level01.gltf',
      'public/scenes/Level01/Level01.bin',
      'public/scenes/Level01/game.js',
    ]);
    expect(result.skipped).toEqual([
      { uri: 'assets/sky.env', reason: 'named in the scene metadata, but the server answered 404' },
    ]);
    expect(result.message).toContain('assets/sky.env');
  });
});

describe('handleLocalSceneCall (the import_local_scene client half)', () => {
  it('imports and posts {message, ok}', async () => {
    const importScene = vi.fn(async () => ({ ok: true, written: ['a'], skipped: [], message: 'Imported 1 file(s).' }));
    const post = vi.fn(async () => undefined);

    await handleLocalSceneCall(
      { generationId: 'gen_1', toolCallId: 'call_1', url: 'http://localhost:8888/scenes/A.gltf', overwrite: false },
      { importScene, post },
    );

    expect(importScene).toHaveBeenCalledWith({ url: 'http://localhost:8888/scenes/A.gltf', overwrite: false });
    expect(post).toHaveBeenCalledWith({
      generationId: 'gen_1',
      toolCallId: 'call_1',
      result: { message: 'Imported 1 file(s).', ok: true },
    });
  });

  it('posts error when the import throws', async () => {
    const post = vi.fn(async () => undefined);

    await handleLocalSceneCall(
      { generationId: 'gen_1', toolCallId: 'call_2', url: 'http://localhost:8888/scenes/A.gltf', overwrite: true },
      {
        importScene: vi.fn(async () => {
          throw new Error('boom');
        }),
        post,
      },
    );

    expect(post).toHaveBeenCalledWith({ generationId: 'gen_1', toolCallId: 'call_2', error: 'boom' });
  });
});
