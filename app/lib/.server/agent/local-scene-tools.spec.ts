/**
 * `import_local_scene` (§4.17, D22) — a relay tool: it emits the request to the browser and awaits the
 * answer through the same registry as the MCP relay (`/api/agent/tool-result`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelGenerationToolCalls, deliverClientToolResult } from './mcp-relay';
import { createLocalSceneTools, type LocalSceneCallEvent } from './local-scene-tools';

type Exec = { execute: (args: unknown, options: unknown) => Promise<unknown> };

afterEach(() => {
  cancelGenerationToolCalls('gen_1');
});

function setup() {
  const emitted: LocalSceneCallEvent[] = [];
  const tools = createLocalSceneTools({ generationId: 'gen_1', userId: 'u1', emit: (e) => void emitted.push(e) });
  const run = (args: unknown) =>
    (tools.import_local_scene as unknown as Exec).execute(args, { toolCallId: 'call_1', abortSignal: undefined });

  return { emitted, run };
}

describe('import_local_scene', () => {
  it('emits the call and returns the browser’s message', async () => {
    const { emitted, run } = setup();
    const pending = run({ url: 'http://localhost:8888/scenes/Level.gltf' });

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toEqual({
      toolCallId: 'call_1',
      url: 'http://localhost:8888/scenes/Level.gltf',
      overwrite: false,
    });

    expect(
      deliverClientToolResult({
        generationId: 'gen_1',
        toolCallId: 'call_1',
        userId: 'u1',
        result: { message: 'Imported 3 files into public/scenes/Level/.' },
      }),
    ).toBe(true);
    expect(await pending).toBe('Imported 3 files into public/scenes/Level/.');
  });

  it('a client error comes back as a sentence', async () => {
    const { emitted, run } = setup();
    const pending = run({ url: 'https://localhost:8888/Level.glb', overwrite: true });

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0].overwrite).toBe(true);
    deliverClientToolResult({ generationId: 'gen_1', toolCallId: 'call_1', userId: 'u1', error: 'unreachable' });
    expect(await pending).toBe('The scene import could not run: unreachable');
  });

  it('an ftp:// url → a sentence and no emit', async () => {
    const { emitted, run } = setup();

    expect(await run({ url: 'ftp://localhost/scene.gltf' })).toMatch(/^import_local_scene needs url — /);
    expect(emitted).toHaveLength(0);
  });
});
