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
import type { MediaProvider } from '~/lib/.server/media/provider';
import { MediaRefusedError, startMediaTask, type StartedMediaTask } from '~/lib/.server/media/service';
import {
  isGoogleVideoModel,
  mediaModelDefaults,
  soundModelsFor,
  type MediaModelDefaults,
  type SoundDialect,
  type SoundModels,
} from '~/lib/media/provider-defaults';
import { SOUND_KIND_KEYS, validateSoundRequest } from '~/lib/media/sound-request';

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
  kind: 'image' | 'video' | 'audio';
  model: string;
  credits: number;
}

/**
 * 🔴 THERE IS NO MEDIA ROUND BUDGET — ONE IMAGE PER CALL, AS MANY CALLS AS THE DESIGN NEEDS
 * (2026-08-08, owner decision, replacing `MAX_MEDIA_ROUNDS = 2`).
 *
 * The cap and the "make ALL your generate calls FIRST, in ONE parallel round" instruction it enforced
 * are both gone. What they produced, live:
 *
 *   step 2: 268169ms · 25598 out · 0 chars text · tools: generate_image
 *   WARN  media tool: round budget spent (2/2), call refused   x3
 *   step 4: ANSWER
 *
 * Three images the design asked for, refused by our own budget, on a turn the user paid for. The
 * owner had asked more than once for images to be made **one at a time and spaced out**; batching was
 * argued for instead, and this is what batching cost.
 *
 * ⚠️ The justification for the cap contained a factual error worth recording, because it is why the
 * wrong fix looked right: it claimed a render was blocking the loop. It never was — `startMediaTask`
 * is async-enqueue and returns the destination path immediately (see the header). The 268 seconds
 * were the model REASONING, not waiting on KIE. A budget was applied to a cost that did not exist.
 *
 * A model that discovers art needs while designing needs more than two rounds, and each round is
 * cheap: the call returns in milliseconds and the step re-reads a WARM prefix at 0.1x. The ceiling
 * that remains is `maxSteps` (`tool-policy.ts` — `MEDIA_IMAGE_ROUNDS`), which bounds the turn without
 * ever refusing a call the model has already decided to make.
 *
 * ⚠️ Deleting the budget without raising that ceiling trades a refusal for a STARVED turn, which is
 * strictly worse — the model spends every step on art and never writes the files. The two move
 * together or not at all.
 */

export interface MediaToolContext {
  userId: string;
  projectId: string;
  provider: MediaProvider;
  objectStore: ObjectStore;
  context?: unknown;

  /** Push the started task to the client (api.agent writes it as a data part). */
  emit: (event: MediaTaskEvent) => void;

  /**
   * The gateway's defaults, injected only by tests (e.g. a gateway with `sound: null`). Production
   * reads `mediaModelDefaults(provider.name)` — the ONE table the Media panel reads too.
   */
  defaults?: MediaModelDefaults;
}

interface CommonArgs {
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  file_name?: string;
}

/**
 * The names `createMediaTools` registers — one list, read by the proxy to count how many PAID media
 * calls a turn made (`unproductive.ts` `mediaCalls`). `media-tools.spec.ts` pins it against the
 * factory's real keys, so adding a fourth tool without listing it here fails a test rather than
 * silently exempting that tool from the media-spent rescue.
 */
export const MEDIA_TOOL_NAMES = [
  'generate_image',
  'generate_video',
  'generate_google_video',
  'generate_sound',
] as const;

export function createMediaTools(ctx: MediaToolContext) {
  /*
   * 🔴 PER GATEWAY, NEVER A LITERAL (T9, 2026-08-11 — see `media/provider-defaults.ts` for the
   * measurement). These ids used to be inlined KIE models, so on another gateway every call that did not
   * name a model was refused and the turn spent a whole extra round rediscovering the catalogue. The
   * DESCRIPTIONS below are built from the same source: they ride in the cached prompt, so advertising
   * `nano-banana-2` on a fal deploy misleads the agent on every turn of every conversation.
   */
  const defaults = ctx.defaults ?? mediaModelDefaults(ctx.provider.name);
  const soundModels = defaults.sound ? soundModelsFor(ctx.provider.name) : null;
  const soundText = soundModels ? SOUND_TOOL_TEXT[soundModels.dialect](soundModels) : null;
  const googleResolutions = defaults.googleVideoResolutions;

  const start = async (input: {
    model: string;
    prompt: string;
    options: Record<string, string | number | boolean>;
    durationSeconds?: number;
    fileName?: string;
  }): Promise<string> => {
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
        `Generate an image with the built-in AI image generator (default model ${defaults.image}) and save it ` +
        'into the project under public/assets/generated/. Costs the user credits (shown in the result). ' +
        'Use for textures, sprites, backgrounds, logos, UI art.',
      parameters: z.object({
        prompt: z.string().optional().describe('What to generate. Detailed and style-specific works best.'),
        model: z.string().optional().describe(`Image model. Default ${defaults.image}.`),
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
          model: args.model?.trim() || defaults.image,
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
      /*
       * The description tells the truth about a gateway with no non-Google video: an advertised
       * default that does not exist buys a refused call and a wasted round, which is the very thing
       * the defaults table was built to stop.
       */
      description:
        'Generate a video clip with the built-in AI video generator and save it into the project ' +
        `under public/assets/generated/. ${
          defaults.video
            ? `Default model ${defaults.video}.`
            : 'This gateway serves only Google Veo video, which must be requested through ' +
              'generate_google_video — so this tool needs an explicit non-Google model here.'
        } Costs the user credits (video is expensive — hundreds of credits). Renders take minutes ` +
        'and complete in the background. Never produces Google Veo video; use generate_google_video for that.',
      parameters: z.object({
        prompt: z.string().optional().describe('What happens in the video.'),
        model: z
          .string()
          .optional()
          .describe(
            defaults.video
              ? `Video model. Default ${defaults.video}.${defaults.videoAlternatives}`
              : 'Required on this gateway — it has no non-Google default. Google Veo ids are refused ' +
                  'here; call generate_google_video for those.',
          ),

        /*
         * Gateway-scoped like the model ids above, and for the same reason: on a gateway with no such
         * knob these described a control that cannot act, in the cached prefix, forever. An empty hint
         * leaves the parameter present (the shape is shared) but says nothing about it.
         */
        mode: z.string().optional().describe(defaults.videoModeHint),
        sound: z.boolean().optional().describe('Generate audio with the video. Default false.'),
        duration_seconds: z.number().optional().describe('Clip length in seconds. Default 5.'),
        resolution: z.string().optional().describe(defaults.videoResolutionHint),
        aspect_ratio: z.string().optional().describe('16:9, 9:16 or 1:1. Default 16:9.'),
        file_name: z.string().optional().describe('Preferred file name (without extension).'),
      }),
      execute: async (
        args: CommonArgs & { mode?: string; sound?: boolean; duration_seconds?: number; resolution?: string },
      ) => {
        if (!args.prompt?.trim()) {
          return 'generate_video needs a "prompt" describing the video.';
        }

        /*
         * 🔴 THIS TOOL NEVER PRODUCES GOOGLE VIDEO (owner rule, 2026-08-11). Veo is the most expensive
         * video on either catalogue and `generate_google_video` exists so it is chosen deliberately.
         * Both doors are shut here, BEFORE any debit: no Google default to drift onto, and a Veo id
         * named on this tool is refused rather than served.
         *
         * Refusals, never fatals — a `MediaRefusedError`-shaped string the model can act on. It names
         * the other tool, so the recovery is one round and obvious.
         */
        const model = args.model?.trim() || defaults.video;

        if (!model) {
          return (
            'generate_video has no default model on this gateway, because every video model it serves ' +
            'is Google Veo — and Veo must be requested deliberately, not fallen back to. Either name a ' +
            'non-Google video model, or call generate_google_video if you actually want Veo.'
          );
        }

        if (isGoogleVideoModel(model)) {
          return (
            `"${model}" is a Google Veo model, and Veo is generated through generate_google_video so ` +
            'that its cost is chosen on purpose. Call that tool instead, or name a non-Google model here.'
          );
        }

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
        `Generate a video with Google Veo (default model ${defaults.googleVideo} on this gateway) and save ` +
        'it into the project under public/assets/generated/. Costs the user credits (video is expensive). ' +
        'Renders take minutes and complete in the background.',
      parameters: z.object({
        prompt: z.string().optional().describe('What happens in the video.'),
        model: z.string().optional().describe(`Veo model id on this gateway. Default ${defaults.googleVideo}.`),
        resolution: z
          .string()
          .optional()
          .describe(`${joinOr(googleResolutions)}. Default ${googleResolutions[0]}.`),
        aspect_ratio: z.string().optional().describe('16:9 or 9:16. Default 16:9.'),
        duration_seconds: z.number().optional().describe('4, 6 or 8 seconds. Default 8.'),
        file_name: z.string().optional().describe('Preferred file name (without extension).'),
      }),
      execute: async (args: CommonArgs & { resolution?: string; duration_seconds?: number }) => {
        if (!args.prompt?.trim()) {
          return 'generate_google_video needs a "prompt" describing the video.';
        }

        /*
         * Validated here, never with `z.enum` (a zod violation kills a paid generation): a resolution the
         * gateway cannot render is refused BEFORE the debit. fal's Veo has no 4k, and its payload drops
         * anything but 720p/1080p — so without this a "4k" request is billed as asked and rendered at 720p.
         */
        const resolution = args.resolution?.trim();

        // The gateway's OWN spelling is what is forwarded — "1080P" from the model becomes "1080p".
        const canonical = resolution
          ? googleResolutions.find((r) => r.toLowerCase() === resolution.toLowerCase())
          : googleResolutions[0];

        if (!canonical) {
          return (
            `generate_google_video was refused: resolution "${resolution}" is not rendered on this gateway. ` +
            `Use ${joinOr(googleResolutions)}.`
          );
        }

        return start({
          model: args.model?.trim() || defaults.googleVideo,
          prompt: args.prompt,
          options: {
            resolution: canonical,
            aspectRatio: args.aspect_ratio || '16:9',
          },
          durationSeconds: args.duration_seconds ?? 8,
          fileName: args.file_name,
        });
      },
    }),

    /*
     * 🔴 PRESENT ONLY ON A GATEWAY THAT SERVES AUDIO. Advertising this on a gateway with no
     * sound routes would buy a refused call on every turn that wants a sound effect — the wasted round the
     * defaults table exists to remove. `undefined` keys are stripped below, so the tool is genuinely
     * absent rather than present-and-broken.
     */
    ...(soundText
      ? {
          generate_sound: tool({
            description: soundText.description,
            parameters: z.object(soundParameters(soundModels!.dialect, soundText.params)),
            execute: async (args: Record<string, unknown>) => {
              /*
               * Every rule lives in one pure validator shared with the Media panel, and a refusal is a
               * SENTENCE, never a throw: a zod-shaped failure would kill a generation the user has
               * already paid for, where this is something the model fixes on the next round.
               */
              const request = validateSoundRequest(args, ctx.provider.name);

              if (!request.ok) {
                return `generate_sound was refused: ${request.error}`;
              }

              return start({
                model: request.model,
                prompt: request.prompt,
                options: request.options,
                durationSeconds: request.durationSeconds,
                fileName: request.fileName,
              });
            },
          }),
        }
      : {}),
  };
}

/** "a, b or c" — the shape every list in these descriptions is written in. */
function joinOr(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/** The argument types `generate_sound` takes — the validator re-checks every one in `execute`. */
const SOUND_BOOLEAN_ARGS = new Set(['loop', 'instrumental', 'custom_mode']);
const SOUND_NUMBER_ARGS = new Set(['tempo', 'stability', 'similarity_boost', 'speech_style', 'speed', 'duration']);

/**
 * `generate_sound`'s schema for a dialect: the common arguments, then each kind's own, in the
 * validator's order (`SOUND_KIND_KEYS`) — so the schema can never offer an argument the validator
 * refuses, and the key order (part of the cached prompt) is fixed per gateway.
 */
function soundParameters(dialect: SoundDialect, describe: Record<string, string>): Record<string, z.ZodTypeAny> {
  const keys = ['prompt', 'kind', 'model', 'file_name', ...Object.values(SOUND_KIND_KEYS[dialect]).flat()];

  return Object.fromEntries(
    [...new Set(keys)].map((key) => {
      const base = SOUND_BOOLEAN_ARGS.has(key) ? z.boolean() : SOUND_NUMBER_ARGS.has(key) ? z.number() : z.string();
      return [key, base.optional().describe(describe[key] ?? '')];
    }),
  );
}

interface SoundToolText {
  description: string;

  /** Per-argument descriptions, keyed by argument name. */
  params: Record<string, string>;
}

/**
 * `generate_sound`'s prose per DIALECT, built from the gateway's catalogue.
 *
 * 🔴 It sits in the CACHED prompt, so it must name only what THIS gateway serves: a Suno version or a
 * KIE voice id shown on fal is a refused call on every turn that believes it, and the reverse is the
 * same. Deterministic for a given catalogue — no clock, no config — so the prefix stays byte-stable.
 * The Suno text is the pre-T6 text, byte for byte.
 */
const SOUND_TOOL_TEXT: Record<SoundDialect, (models: SoundModels) => SoundToolText> = {
  suno: () => ({
    description:
      'Generate a sound effect, a line of speech, or a music track with the built-in audio ' +
      'generator and save it into the project under public/assets/generated/ as an MP3. ' +
      'Costs the user credits (shown in the result). ' +
      'kind=sound_effect (the default) for gameplay audio — jumps, pickups, engines, impacts, ' +
      'UI clicks, ambience; it has no exact duration control. ' +
      'kind=speech for spoken lines (announcer, narration, character voice). ' +
      'kind=music for a backing track — only when the user actually asked for music; it is ' +
      'several times the price of an effect. ' +
      'Pass ONLY the fields that belong to the chosen kind. ' +
      'Renders happen in the background: DO NOT wait or poll — reference the returned path now.',
    params: {
      prompt:
        'Effects: describe the sound (max 500 chars). Speech: the exact words to say ' +
        '(max 5000). Music: describe the track (max 3000).',
      kind: 'sound_effect (default), speech, or music.',
      model:
        'Effects/music: a Suno version (V5 default, V5_5; music also V4, V4_5, V4_5PLUS, ' +
        'V4_5ALL). Speech: an ElevenLabs model id. Leave unset for the default.',
      file_name: 'Preferred file name (without extension).',
      loop: 'Effects only: make it loopable (ambience, engines).',
      tempo: 'Effects only: requested BPM, 1-300.',
      key: 'Effects only: musical key such as C or Am. Omit for any.',
      voice: 'Speech only: ElevenLabs voice name or id.',
      stability: 'Speech only: 0-1.',
      similarity_boost: 'Speech only: 0-1.',
      speech_style: 'Speech only: style exaggeration, 0-1.',
      speed: 'Speech only: 0.7-1.2.',
      language_code: 'Speech only, turbo 2.5 model only: two-letter ISO 639-1 code.',
      instrumental: 'Music only: no vocals. Default true.',
      custom_mode: 'Music only: exact lyrics/style mode; needs style+title.',
      style: 'Custom music only: genre/mood.',
      title: 'Custom music only: track title.',
      negative_tags: 'Custom music only: styles to avoid.',
      vocal_gender: 'Custom vocal music only: m or f.',
      duration: 'Custom music only, V5_5 only: seconds, 10-360.',
    },
  }),

  'elevenlabs-minimax': (models) => {
    const seconds = models.effectSeconds;
    const voices = models.voices ?? [];

    return {
      description:
        'Generate a sound effect, a line of speech, or a music track with the built-in audio ' +
        'generator and save it into the project under public/assets/generated/ as an MP3. ' +
        'Costs the user credits (shown in the result). ' +
        'kind=sound_effect (the default) for gameplay audio — jumps, pickups, engines, impacts, ' +
        `UI clicks, ambience; it is priced per second, so set duration (${seconds?.min}-${seconds?.max} ` +
        `seconds, default ${seconds?.default}). ` +
        'kind=speech for spoken lines (announcer, narration, character voice). ' +
        'kind=music for a backing track — only when the user actually asked for music; it is ' +
        'several times the price of an effect. ' +
        'Pass ONLY the fields that belong to the chosen kind. ' +
        'Renders happen in the background: DO NOT wait or poll — reference the returned path now.',
      params: {
        prompt:
          'Effects: describe the sound (max 500 chars). Speech: the exact words to say ' +
          '(max 5000). Music: describe the style and mood of the track (10-2000 chars).',
        kind: 'sound_effect (default), speech, or music.',
        model:
          `Speech: ${joinOr(models.speech)} (default ${models.speech[0]}). Effects and music have one ` +
          'model each here. Leave unset for the default.',
        file_name: 'Preferred file name (without extension).',
        loop: 'Effects only: make it loopable (ambience, engines).',
        duration: `Effects only: length in seconds, ${seconds?.min}-${seconds?.max}. Default ${seconds?.default}.`,
        voice: `Speech only: one of ${voices.join(', ')}. Default ${voices[0]}.`,
        instrumental: 'Music only: no vocals. Default true.',
        lyrics: 'Music with vocals only (instrumental: false): the words to sing. Required then.',
      },
    };
  },
};
