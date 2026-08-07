/**
 * Built-in media generation tools for the server-side tool loop (SPEC §4.16).
 *
 * `generate_image` / `generate_video` / `generate_google_video` — the platform-native answer to an
 * external image MCP: same names and defaults as the owner's `kie-image-mcp`, but billed through the
 * ledger at the Marketplace price and landing bytes in the user's project.
 *
 * **Async-enqueue, the defining design choice.** Unlike an MCP relay tool (which BLOCKS the loop
 * awaiting the client), a render takes minutes — parking the tool loop would re-send the ~110k-token
 * prefix per round and hold the generation open for a Kling render (§4.2.8). So `execute` debits,
 * creates the KIE task, EMITS a `media-task` data part (the client polls and writes the bytes when
 * they land), and returns IMMEDIATELY with the destination path. The model needs the PATH to write
 * code against, not the pixels.
 *
 * Schema rule (`tools.ts`): every parameter optional, validated in `execute` — a zod violation kills
 * the whole generation, and a missing prompt should be a friendly tool_result the model corrects.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from '~/utils/logger';
import type { ObjectStore } from '~/lib/.server/storage';
import type { MediaProvider } from '~/lib/.server/media/kie-client';
import { MediaRefusedError, startMediaTask, type StartedMediaTask } from '~/lib/.server/media/service';

const logger = createScopedLogger('media-tools');

/**
 * The URL the model should write into project code for a generated asset.
 *
 * 🔴 RELATIVE, never root-absolute — this is the difference between a published game showing its art
 * and showing empty boxes (found live 2026-08-01 on a real share).
 *
 * Generated media lands in `public/`, which Vite copies to the build ROOT, and a share is served under
 * a PREFIX (`/play/<id>/`). So `/assets/generated/x.png` resolves to the app origin's root and 404s for
 * every visitor. It survived this long because it is correct in the two places anyone looks:
 *
 * - **dev**, where the app IS served at the origin root; and
 * - **CSS**, because Vite rewrites `url()` at build time and fixes the path for you.
 *
 * Only a JS/JSX string literal — which Vite cannot rewrite, because it cannot know a string is a URL —
 * carries the broken path into the shipped bundle. Measured on one published game: the CSS hero loaded
 * 200 while all four `<img>` tiles written from `Home.tsx` 404'd, in the same build.
 *
 * `./assets/…` resolves against the document, so it is correct at the origin root AND under any share
 * prefix, in CSS and in JSX alike. `import.meta.env.BASE_URL` would also work, but it is awkward inside
 * a JSX attribute and reads as boilerplate the model drops under pressure; a plain relative path is the
 * form that survives being copied around.
 */
export function mediaReferenceUrl(destPath: string): string {
  return `./${destPath.replace(/^public\//, '')}`;
}

/** What the client needs to start polling — written to the stream as a `media-task` data part. */
export interface MediaTaskEvent {
  taskId: string;
  projectId: string;
  destPath: string;
  kind: 'image' | 'video';
  model: string;
  credits: number;
}

/**
 * 🔴 THE ONE-PARALLEL-ROUND RULE IS A BUDGET NOW, NOT PROSE (2026-08-07, gen_msixapaq_i871b6).
 *
 * The brief has always said "make ALL your generate calls FIRST, in ONE parallel round" — and a live
 * first build turn ignored it: 3 images, then 1, then 1, each in its own round, spending every step
 * of the media turn with the game never written. This repo's standing lesson (protocol-strip,
 * MAX_SKILL_LOADS): no prompt wording reliably stops a model — the pipeline has to refuse. Two rounds,
 * not one, because a failed/refused render legitimately earns one retry round (the "slack" the step
 * cap was designed with); the third round is where the measured thrash lived. The check runs BEFORE
 * `startMediaTask`, so a refused call debits nothing and costs one instant tool_result.
 */
export const MAX_MEDIA_ROUNDS = 2;

/**
 * Mutable round counter, owned by the proxy: incremented in `onStepFinish` for each finished step
 * that contained a generate_* call. Execute reads it, so calls in the SAME parallel round all see the
 * same count (the SDK runs a round's calls before any of their results advance the step) — a burst of
 * parallel calls in round one is always allowed, which is exactly the shape the brief asks for.
 */
export interface MediaRoundTracker {
  used: number;
}

export interface MediaToolContext {
  userId: string;
  projectId: string;
  provider: MediaProvider;
  objectStore: ObjectStore;
  context?: unknown;

  /** Push the started task to the client (api.agent writes it as a data part). */
  emit: (event: MediaTaskEvent) => void;

  /** Absent (tests, callers predating the budget) = unlimited rounds — the cap only binds when wired. */
  rounds?: MediaRoundTracker;
}

interface CommonArgs {
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  file_name?: string;
}

export function createMediaTools(ctx: MediaToolContext) {
  const start = async (input: {
    model: string;
    prompt: string;
    options: Record<string, string | number | boolean>;
    durationSeconds?: number;
    fileName?: string;
  }): Promise<string> => {
    /*
     * The round budget, BEFORE any debit (see MAX_MEDIA_ROUNDS above). The refusal is instructive on
     * purpose: the model that hits it is mid-thrash with the project unwritten, and "write the game
     * NOW" is the recovery — the answer step (+1 in tool-policy) is still ahead of it.
     */
    if (ctx.rounds && ctx.rounds.used >= MAX_MEDIA_ROUNDS) {
      logger.warn(`media tool: round budget spent (${ctx.rounds.used}/${MAX_MEDIA_ROUNDS}), call refused`);

      return (
        `REFUSED — you have already used your ${MAX_MEDIA_ROUNDS} media rounds this turn (nothing was charged ` +
        `for this call). Do NOT call generate tools again. Write the COMPLETE project code NOW — the full ` +
        `<boltArtifact> with every file — referencing the assets already started. More art can be generated ` +
        `on a later turn if needed.`
      );
    }

    let started: StartedMediaTask;

    try {
      started = await startMediaTask({
        ...input,
        userId: ctx.userId,
        projectId: ctx.projectId,
        provider: ctx.provider,
        objectStore: ctx.objectStore,
        context: ctx.context,
      });
    } catch (error) {
      if (error instanceof MediaRefusedError) {
        // A friendly tool_result the model can react to (wrong option name, out of credits) — never fatal.
        return `The media generation was refused: ${error.message}`;
      }

      logger.error(`media tool failed: ${(error as Error).message}`);

      return `The media generation could not start: ${(error as Error).message}`;
    }

    ctx.emit({
      taskId: started.taskId,
      projectId: ctx.projectId,
      destPath: started.destPath,
      kind: started.kind,
      model: started.model,
      credits: started.credits,
    });

    return (
      `Started (${started.model}, ${started.credits} credits). The ${started.kind} will be saved to ` +
      `${started.destPath} when the render finishes (renders take seconds for images, minutes for video — ` +
      `it happens in the background, DO NOT wait for it or poll for it). Reference "${mediaReferenceUrl(started.destPath)}" ` +
      `in the project's code now; the file will appear there automatically.`
    );
  };

  return {
    generate_image: tool({
      description:
        'Generate an image with the built-in AI image generator (default model nano-banana-2) and save it ' +
        'into the project under public/assets/generated/. Costs the user credits (shown in the result). ' +
        'Use for textures, sprites, backgrounds, logos, UI art.',
      parameters: z.object({
        prompt: z.string().optional().describe('What to generate. Detailed and style-specific works best.'),
        model: z.string().optional().describe('Image model. Default nano-banana-2.'),
        resolution: z.string().optional().describe('1K, 2K or 4K. Default 2K. 1K is cheaper; 4K costs more.'),
        aspect_ratio: z.string().optional().describe('e.g. 16:9, 1:1, 9:16, 4:3. Default 16:9.'),
        transparent: z
          .boolean()
          .optional()
          .describe(
            'Set true when the art must sit OVER other content with nothing behind it — a logo or ' +
              'wordmark over a hero, an emblem, a sprite, a cut-out character, a UI icon. The image is ' +
              'then rendered and automatically cut out into a real RGBA PNG, which costs a couple of ' +
              'extra credits. Leave unset/false for anything with its own background (heroes, ' +
              'backdrops, textures, scenery, panels). NEVER ask for a transparent background in the ' +
              'prompt text — the generator cannot make one and will paint a fake checkerboard instead; ' +
              'this flag is the only thing that produces real transparency.',
          ),
        output_format: z
          .string()
          .optional()
          .describe(
            'png or jpg. Normally leave unset — opaque art defaults to "jpg" (~10× smaller than png ' +
              'for no visible difference at the same price) and transparent art is always delivered as ' +
              'png. Use `transparent` to ask for transparency; this field only picks a container.',
          ),
        file_name: z.string().optional().describe('Preferred file name (without extension).'),
      }),
      execute: async (args: CommonArgs & { resolution?: string; output_format?: string; transparent?: boolean }) => {
        if (!args.prompt?.trim()) {
          return 'generate_image needs a "prompt" describing the image.';
        }

        return start({
          model: args.model?.trim() || 'nano-banana-2',
          prompt: args.prompt,
          options: {
            resolution: args.resolution || '2K',
            aspectRatio: args.aspect_ratio || '16:9',

            /*
             * Both included ONLY when the model set them; left unset, `resolveImageDelivery` decides
             * (jpg for ordinary art, render-then-cut-out for art whose name or prompt reads as a logo
             * or sprite). A STATED `transparent: false` is honoured over those hints — that is why it
             * is forwarded even when false.
             */
            ...(args.output_format ? { outputFormat: args.output_format } : {}),
            ...(args.transparent !== undefined ? { transparent: args.transparent } : {}),
          },
          fileName: args.file_name,
        });
      },
    }),

    generate_video: tool({
      description:
        'Generate a video clip with the built-in AI video generator (default model kling-3.0/video) and ' +
        'save it into the project under public/assets/generated/. Costs the user credits (video is ' +
        'expensive — hundreds of credits). Renders take minutes and complete in the background.',
      parameters: z.object({
        prompt: z.string().optional().describe('What happens in the video.'),
        model: z
          .string()
          .optional()
          .describe('Video model. Default kling-3.0/video. Also: kling-2.6, bytedance/seedance-2, …'),
        mode: z.string().optional().describe('kling-3.0 tier: std (720p), pro (1080p) or 4K. Default std.'),
        sound: z.boolean().optional().describe('Generate audio with the video. Default false.'),
        duration_seconds: z.number().optional().describe('Clip length in seconds. Default 5.'),
        resolution: z.string().optional().describe('For seedance/grok models: 480p, 720p, 1080p, 4K.'),
        aspect_ratio: z.string().optional().describe('16:9, 9:16 or 1:1. Default 16:9.'),
        file_name: z.string().optional().describe('Preferred file name (without extension).'),
      }),
      execute: async (
        args: CommonArgs & { mode?: string; sound?: boolean; duration_seconds?: number; resolution?: string },
      ) => {
        if (!args.prompt?.trim()) {
          return 'generate_video needs a "prompt" describing the video.';
        }

        const model = args.model?.trim() || 'kling-3.0/video';
        const options: Record<string, string | number | boolean> = {
          sound: args.sound ?? false,
          aspectRatio: args.aspect_ratio || '16:9',

          // Pricing keys: kling-3.0 prices on mode; seedance/grok on resolution + no image input (v1).
          ...(model.startsWith('kling-3.0') ? { mode: args.mode || 'std' } : {}),
          ...(args.resolution ? { resolution: args.resolution } : {}),
          ...(model.startsWith('bytedance/') ? { imageInput: false } : {}),
        };

        return start({
          model,
          prompt: args.prompt,
          options,
          durationSeconds: args.duration_seconds ?? 5,
          fileName: args.file_name,
        });
      },
    }),

    generate_google_video: tool({
      description:
        'Generate a video with Google Veo 3.1 (models veo3_fast / veo3 / veo3_lite) and save it into the ' +
        'project under public/assets/generated/. Costs the user credits (a Veo clip is a flat per-video ' +
        'price). Renders take minutes and complete in the background.',
      parameters: z.object({
        prompt: z.string().optional().describe('What happens in the video.'),
        model: z.string().optional().describe('veo3 (quality), veo3_fast (default) or veo3_lite.'),
        resolution: z.string().optional().describe('720p, 1080p or 4k. Default 720p.'),
        aspect_ratio: z.string().optional().describe('16:9 or 9:16. Default 16:9.'),
        duration_seconds: z.number().optional().describe('4, 6 or 8 seconds. Default 8.'),
        file_name: z.string().optional().describe('Preferred file name (without extension).'),
      }),
      execute: async (args: CommonArgs & { resolution?: string; duration_seconds?: number }) => {
        if (!args.prompt?.trim()) {
          return 'generate_google_video needs a "prompt" describing the video.';
        }

        return start({
          model: args.model?.trim() || 'veo3_fast',
          prompt: args.prompt,
          options: {
            resolution: args.resolution || '720p',
            aspectRatio: args.aspect_ratio || '16:9',
          },
          durationSeconds: args.duration_seconds ?? 8,
          fileName: args.file_name,
        });
      },
    }),
  };
}
