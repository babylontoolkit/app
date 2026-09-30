/**
 * `import_local_scene` (SPEC §4.17, D22) — copy a glTF/GLB scene served by a local dev server into the
 * project's `public/scenes/<name>/`, so the game still works once it is published (a localhost URL works
 * only while developing).
 *
 * A relay tool like `preview-tools.ts`: `execute` EMITS the request and AWAITS the browser's answer,
 * because only the browser can reach the user's local dev server and write into the sandbox. It needs no
 * Unity Bridge and costs nothing. The client refuses to overwrite unless `overwrite: true`, and asks the
 * user itself; this tool's description tells the model to ask first too.
 *
 * Never fatal: a bad URL, a timeout or a client error comes back as a sentence.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { awaitClientToolResult } from './mcp-relay';

export interface LocalSceneCallEvent {
  toolCallId: string;
  url: string;
  overwrite: boolean;
}

export interface LocalSceneToolContext {
  generationId: string;
  userId: string;
  abortSignal?: AbortSignal;
  emit: (e: LocalSceneCallEvent) => void;
}

/** A scene import copies several files over the local network into the sandbox — allow it time. */
export const LOCAL_SCENE_IMPORT_TIMEOUT_MS = 120_000;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createLocalSceneTools(ctx: LocalSceneToolContext): Record<string, ReturnType<typeof tool>> {
  const tools = {
    import_local_scene: tool({
      description:
        "Copy a glTF/GLB scene (and its .bin and textures) from a local dev server URL into the project's public/scenes/<name>/ so the game can be published. Runs in the user's browser. If files already exist it will say so — ask the user, then call again with overwrite true. Free.",
      parameters: z.object({
        /* Optional + validated in `execute`: a schema rejection kills the generation after it has paid. */
        url: z
          .string()
          .optional()
          .describe('The scene URL on the local dev server, e.g. http://localhost:8888/scenes/Level.gltf'),
        overwrite: z.boolean().optional().describe('Replace files that already exist (only after the user agreed).'),
      }),
      execute: async ({ url, overwrite }, { toolCallId, abortSignal }) => {
        if (!isHttpUrl(url)) {
          return 'import_local_scene needs url — an http:// or https:// URL of a .gltf or .glb scene on the local dev server.';
        }

        ctx.emit({ toolCallId, url, overwrite: overwrite === true });

        const { result, error } = await awaitClientToolResult({
          generationId: ctx.generationId,
          toolCallId,
          userId: ctx.userId,
          abortSignal: abortSignal ?? ctx.abortSignal,
          timeoutMs: LOCAL_SCENE_IMPORT_TIMEOUT_MS,
        });

        if (error) {
          return `The scene import could not run: ${error}`;
        }

        return (result as { message?: string } | undefined)?.message ?? 'Import finished.';
      },
    }),
  };

  return tools as unknown as Record<string, ReturnType<typeof tool>>;
}
