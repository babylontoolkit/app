/**
 * `generate_sound`'s argument rules (SPEC §4.16), ported from the owner's `kie-sound` MCP
 * (`buildSoundRequest`) with its error sentences kept verbatim.
 *
 * ## Why this is a function and not a zod schema
 *
 * The three kinds share one tool and have almost disjoint option sets — `voice` is meaningless for a
 * sound effect, `tempo` for speech — and the prompt limit itself depends on the kind and (for music)
 * on the mode and the Suno version. A schema expressive enough for that is a schema the model gets
 * wrong, and `tools.ts`'s rule is absolute: **every parameter optional, validated in `execute`**,
 * because a zod violation kills a generation the user has already paid for, where a returned sentence
 * is something the model simply corrects on the next round.
 *
 * ## Why it is client-safe
 *
 * The Media panel and the agent tool are two doors onto the same request. One validator means the
 * panel cannot offer a combination the tool would refuse, and neither can send KIE a body it rejects
 * after the debit has been taken.
 *
 * It returns a RESULT rather than throwing: both callers want the sentence, not a stack trace.
 *
 * ## Per gateway (`_specs/media-gateways_plan.md` T6)
 *
 * The rules come from the gateway's sound catalogue (`SOUND_MODELS` in `provider-defaults.ts`), chosen
 * by its DIALECT rather than by a provider-name check: KIE speaks Suno + ElevenLabs (versions, any voice
 * id), fal speaks ElevenLabs + MiniMax (a fixed voice list, an effect length, music lyrics). A KIE voice
 * id sent to fal, or a 30-second effect, is refused here — before the debit — with a sentence naming
 * what is valid, instead of being refused at the gateway after the user has paid.
 */
import { soundModelsFor, type SoundDialect, type SoundKind, type SoundModels } from './provider-defaults';
import type { ImageProviderName } from './image-capabilities';

/** Tool/panel argument names (snake_case — the MCP's vocabulary, which the model already knows). */
const COMMON_KEYS = ['prompt', 'kind', 'model', 'file_name'];

/**
 * The arguments each kind accepts, per dialect, in the order the tool schema lists them.
 *
 * Exported because `generate_sound`'s schema is built from it: a parameter the schema offers but the
 * validator refuses is a refused call on every turn that uses it.
 */
export const SOUND_KIND_KEYS: Readonly<Record<SoundDialect, Readonly<Record<SoundKind, readonly string[]>>>> = {
  suno: {
    sound_effect: ['loop', 'tempo', 'key'],
    speech: ['voice', 'stability', 'similarity_boost', 'speech_style', 'speed', 'language_code'],
    music: ['instrumental', 'custom_mode', 'style', 'title', 'negative_tags', 'vocal_gender', 'duration'],
  },
  'elevenlabs-minimax': {
    sound_effect: ['loop', 'duration'],
    speech: ['voice'],
    music: ['instrumental', 'lyrics'],
  },
};

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Major and minor; `Cm` style, as KIE documents it. */
export const SOUND_KEYS = [...NOTES, ...NOTES.map((note) => `${note}m`)];

/** Prompt length bounds per dialect and kind (`min` only where the gateway documents one). */
const PROMPT_LIMIT: Record<SoundDialect, Record<SoundKind, { min?: number; max: number }>> = {
  suno: { sound_effect: { max: 500 }, speech: { max: 5000 }, music: { max: 3000 } },

  /* MiniMax Music v2.6 takes a 10–2000 character prompt (fal's schema). */
  'elevenlabs-minimax': { sound_effect: { max: 500 }, speech: { max: 5000 }, music: { min: 10, max: 2000 } },
};

/** Custom-mode music takes longer lyrics — except on V4, which did not raise the limit. */
const CUSTOM_MUSIC_PROMPT_LIMIT = 5000;

/** MiniMax lyrics cap — an ASSUMPTION (fal documents the field, not its limit); generous on purpose. */
const LYRICS_LIMIT = 3000;

export interface SoundRequestInput {
  [key: string]: unknown;
}

export type SoundRequestResult =
  | {
      ok: true;
      kind: SoundKind;

      /** The PRICED model id — what the ledger, the quote and `endpointFor` all key on. */
      model: string;

      prompt: string;

      /** The normalised option record the price lookup and the provider payload both read. */
      options: Record<string, string | number | boolean>;

      /**
       * A sound effect's requested length in seconds, where the gateway has a length control. Unset
       * means "the gateway's default" — resolved once, in `soundEffectSeconds`, by the quote.
       */
      durationSeconds?: number;

      fileName?: string;
    }
  | { ok: false; error: string };

function refuse(error: string): SoundRequestResult {
  return { ok: false, error };
}

/** The typed readers both dialects use; the first failure wins and is reported. */
function readerFor(args: SoundRequestInput) {
  const state: { failure?: string } = {};

  const str = (key: string, max = Infinity): string | undefined => {
    const value = args[key];

    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      state.failure ??= `${key} must be a nonempty string${Number.isFinite(max) ? ` of at most ${max} characters` : ''}`;
      return undefined;
    }

    return value;
  };

  const bool = (key: string, fallback: boolean): boolean => {
    if (args[key] === undefined) {
      return fallback;
    }

    if (typeof args[key] !== 'boolean') {
      state.failure ??= `${key} must be a boolean`;
      return fallback;
    }

    return args[key] as boolean;
  };

  const num = (key: string, min: number, max: number, integer = false): number | undefined => {
    const value = args[key];

    if (value === undefined) {
      return undefined;
    }

    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      state.failure ??= `${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`;
      return undefined;
    }

    return value;
  };

  return { state, str, bool, num };
}

type Reader = ReturnType<typeof readerFor>;

export function validateSoundRequest(
  args: SoundRequestInput,
  provider: ImageProviderName | string,
): SoundRequestResult {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return refuse('Expected an object of sound arguments.');
  }

  const models = soundModelsFor(provider);

  if (!models) {
    return refuse(`The ${provider} media gateway serves no sound.`);
  }

  const kind = (args.kind === undefined ? 'sound_effect' : args.kind) as SoundKind;
  const kindKeys = SOUND_KIND_KEYS[models.dialect];

  if (typeof kind !== 'string' || !Object.hasOwn(kindKeys, kind)) {
    return refuse('kind must be sound_effect, speech or music');
  }

  /*
   * An option belonging to ANOTHER kind is refused by name rather than ignored. Silently dropping
   * `voice` from a speech request the caller spelled as an effect produces a render that is not what
   * was asked for, at full price — the refusal costs a round and nothing else.
   */
  const allowed = new Set([...COMMON_KEYS, ...kindKeys[kind]]);

  for (const key of Object.keys(args)) {
    if (args[key] !== undefined && !allowed.has(key)) {
      return refuse(`${key} is not supported for ${kind}`);
    }
  }

  const reader = readerFor(args);
  const requestedModel = reader.str('model');

  if (reader.state.failure) {
    return refuse(reader.state.failure);
  }

  return DIALECT_VALIDATORS[models.dialect](args, { kind, models, requestedModel, reader });
}

interface DialectInput {
  kind: SoundKind;
  models: SoundModels;
  requestedModel: string | undefined;
  reader: Reader;
}

const DIALECT_VALIDATORS: Record<SoundDialect, (args: SoundRequestInput, input: DialectInput) => SoundRequestResult> = {
  suno: validateSuno,
  'elevenlabs-minimax': validateElevenLabsMiniMax,
};

/** KIE: Suno effects and music (a VERSION in `model`), ElevenLabs speech (any voice id). */
function validateSuno(
  args: SoundRequestInput,
  { kind, models, requestedModel, reader }: DialectInput,
): SoundRequestResult {
  const { str, bool, num, state } = reader;
  const limits = PROMPT_LIMIT.suno;
  const options: Record<string, string | number | boolean> = {};

  if (kind === 'speech') {
    const model = requestedModel ?? models.speech[0];

    if (!models.speech.includes(model)) {
      return refuse(`Unsupported speech model: ${model}. Use ${models.speech.join(', ')}`);
    }

    const prompt = str('prompt', limits.speech.max);

    if (!prompt) {
      return refuse(state.failure ?? 'generate_sound needs a "prompt" — for speech it is the exact text to say.');
    }

    const voice = str('voice');

    if (voice !== undefined) {
      options.voice = voice;
    }

    for (const [key, min, max] of [
      ['stability', 0, 1],
      ['similarity_boost', 0, 1],
      ['speech_style', 0, 1],
      ['speed', 0.7, 1.2],
    ] as const) {
      const value = num(key, min, max);

      if (value !== undefined) {
        options[key === 'similarity_boost' ? 'similarityBoost' : key === 'speech_style' ? 'speechStyle' : key] = value;
      }
    }

    const language = str('language_code', 2);

    if (language !== undefined) {
      if (!/^[a-z]{2}$/.test(language)) {
        return refuse('language_code must be a two-letter ISO 639-1 code');
      }

      // The turbo model is the one that takes a language code; named from the catalogue, never typed.
      const turbo = models.speech.find((id) => id.includes('turbo'));

      if (model !== turbo) {
        return refuse(`language_code is only supported by ${turbo}`);
      }

      options.languageCode = language;
    }

    // Read BEFORE the guard, or a bad file_name sets `failure` too late to be reported.
    const fileName = str('file_name');

    return state.failure ? refuse(state.failure) : { ok: true, kind, model, prompt, options, fileName };
  }

  /*
   * Effects and music both run on Suno, where `model` names a VERSION rather than a priced model id.
   * Keeping the tool's vocabulary identical to the MCP's matters more than the mismatch reads: the
   * version rides in `options.sunoModel` and the priced id comes from the kind.
   */
  const versions: readonly string[] =
    (kind === 'music' ? models.musicOptions?.musicVersions : models.musicOptions?.effectVersions) ?? [];
  const version = requestedModel ?? 'V5';

  if (!versions.includes(version)) {
    return refuse(`Unsupported ${kind} model: ${version}. Use ${versions.join(', ')}`);
  }

  options.sunoModel = version;

  if (kind === 'sound_effect') {
    const prompt = str('prompt', limits.sound_effect.max);

    if (!prompt) {
      return refuse(state.failure ?? 'generate_sound needs a "prompt" describing the sound.');
    }

    options.loop = bool('loop', false);

    const tempo = num('tempo', 1, 300, true);

    if (tempo !== undefined) {
      options.tempo = tempo;
    }

    const key = str('key');

    if (key !== undefined) {
      if (!SOUND_KEYS.includes(key)) {
        return refuse(`key must be one of: ${SOUND_KEYS.join(', ')}; omit it for any key`);
      }

      options.key = key;
    }

    const fileName = str('file_name');

    return state.failure ? refuse(state.failure) : { ok: true, kind, model: models.effect, prompt, options, fileName };
  }

  const customMode = bool('custom_mode', false);
  const limit = customMode && version !== 'V4' ? CUSTOM_MUSIC_PROMPT_LIMIT : limits.music.max;
  const prompt = str('prompt', limit);

  if (!prompt) {
    return refuse(state.failure ?? 'generate_sound needs a "prompt" describing the music.');
  }

  options.customMode = customMode;
  options.instrumental = bool('instrumental', true);

  const customOnly = ['style', 'title', 'negative_tags', 'vocal_gender', 'duration'];

  if (!customMode && customOnly.some((key) => args[key] !== undefined)) {
    return refuse('style, title, negative_tags, vocal_gender and duration require custom_mode: true');
  }

  if (customMode) {
    const style = str('style', version === 'V4' ? 200 : 1000);
    const title = str('title', 80);

    if (!style || !title) {
      return refuse(state.failure ?? 'custom_mode music requires both style and title');
    }

    options.style = style;
    options.title = title;

    const negative = str('negative_tags');

    if (negative !== undefined) {
      options.negativeTags = negative;
    }

    const gender = str('vocal_gender');

    if (gender !== undefined) {
      if (gender !== 'm' && gender !== 'f') {
        return refuse('vocal_gender must be m or f');
      }

      if (options.instrumental) {
        return refuse('vocal_gender requires instrumental: false');
      }

      options.vocalGender = gender;
    }

    const duration = num('duration', 10, 360);

    if (duration !== undefined) {
      if (version !== 'V5_5') {
        return refuse('duration is only supported for custom-mode music with model V5_5');
      }

      options.duration = duration;
    }
  }

  const musicFileName = str('file_name');

  return state.failure
    ? refuse(state.failure)
    : { ok: true, kind, model: models.music, prompt, options, fileName: musicFileName };
}

/**
 * fal: ElevenLabs effects (with a LENGTH) and speech (a fixed voice list), MiniMax music (lyrics).
 *
 * `model` names a priced id here, never a version — effects and music have one model each, so naming
 * any other id is refused with the one that exists.
 */
function validateElevenLabsMiniMax(
  args: SoundRequestInput,
  { kind, models, requestedModel, reader }: DialectInput,
): SoundRequestResult {
  const { str, bool, num, state } = reader;
  const limits = PROMPT_LIMIT['elevenlabs-minimax'];
  const options: Record<string, string | number | boolean> = {};

  if (kind === 'speech') {
    const model = requestedModel ?? models.speech[0];

    if (!models.speech.includes(model)) {
      return refuse(`Unsupported speech model: ${model}. Use ${models.speech.join(', ')}`);
    }

    const prompt = str('prompt', limits.speech.max);

    if (!prompt) {
      return refuse(state.failure ?? 'generate_sound needs a "prompt" — for speech it is the exact text to say.');
    }

    const voice = str('voice');

    if (voice !== undefined) {
      /*
       * Matched case-insensitively and stored in its CANONICAL spelling — fal takes the name, and
       * "rachel" is not a different voice. An unknown name is refused here because fal would only
       * refuse it after the render was paid for.
       */
      const known = models.voices?.find((name) => name.toLowerCase() === voice.trim().toLowerCase());

      if (models.voices && !known) {
        return refuse(
          `voice "${voice}" is not available on this gateway. Use one of: ${models.voices.join(', ')} ` +
            `(default ${models.voices[0]}).`,
        );
      }

      options.voice = known ?? voice;
    }

    const fileName = str('file_name');

    return state.failure ? refuse(state.failure) : { ok: true, kind, model, prompt, options, fileName };
  }

  const pricedModel = kind === 'music' ? models.music : models.effect;

  if (requestedModel !== undefined && requestedModel !== pricedModel) {
    return refuse(`Unsupported ${kind} model: ${requestedModel}. Use ${pricedModel} (or leave model unset)`);
  }

  if (kind === 'sound_effect') {
    const prompt = str('prompt', limits.sound_effect.max);

    if (!prompt) {
      return refuse(state.failure ?? 'generate_sound needs a "prompt" describing the sound.');
    }

    options.loop = bool('loop', false);

    const range = models.effectSeconds;
    let durationSeconds: number | undefined;

    if (args.duration !== undefined && range) {
      durationSeconds = num('duration', range.min, range.max);

      if (durationSeconds === undefined) {
        return refuse(
          `duration must be a number of seconds between ${range.min} and ${range.max} — sound effects here are ` +
            `capped at ${range.max} seconds (default ${range.default}).`,
        );
      }
    }

    const fileName = str('file_name');

    return state.failure
      ? refuse(state.failure)
      : { ok: true, kind, model: pricedModel, prompt, options, durationSeconds, fileName };
  }

  const prompt = str('prompt', limits.music.max);

  if (!prompt) {
    return refuse(state.failure ?? 'generate_sound needs a "prompt" describing the music.');
  }

  if (limits.music.min && prompt.trim().length < limits.music.min) {
    return refuse(
      `prompt must be ${limits.music.min}-${limits.music.max} characters for music — describe the style and mood.`,
    );
  }

  options.instrumental = bool('instrumental', true);

  const lyrics = str('lyrics', LYRICS_LIMIT);

  if (lyrics !== undefined) {
    if (options.instrumental) {
      return refuse('lyrics requires instrumental: false');
    }

    options.lyrics = lyrics;
  } else if (!options.instrumental && !state.failure) {
    return refuse(
      'music with vocals needs "lyrics" (the words to sing) — pass lyrics, or set instrumental: true for a ' +
        'track without vocals.',
    );
  }

  const fileName = str('file_name');

  return state.failure ? refuse(state.failure) : { ok: true, kind, model: pricedModel, prompt, options, fileName };
}
