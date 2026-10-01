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
 */
import {
  SOUND_MODELS,
  SPEECH_MODELS,
  SUNO_EFFECT_VERSIONS,
  SUNO_MUSIC_VERSIONS,
  type SoundKind,
} from './provider-defaults';

/** Tool/panel argument names (snake_case — the MCP's vocabulary, which the model already knows). */
const COMMON_KEYS = ['prompt', 'kind', 'model', 'file_name'];

const KIND_KEYS: Record<SoundKind, string[]> = {
  sound_effect: ['loop', 'tempo', 'key'],
  speech: ['voice', 'stability', 'similarity_boost', 'speech_style', 'speed', 'language_code'],
  music: ['instrumental', 'custom_mode', 'style', 'title', 'negative_tags', 'vocal_gender', 'duration'],
};

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Major and minor; `Cm` style, as KIE documents it. */
export const SOUND_KEYS = [...NOTES, ...NOTES.map((note) => `${note}m`)];

const PROMPT_LIMIT: Record<SoundKind, number> = { sound_effect: 500, speech: 5000, music: 3000 };

/** Custom-mode music takes longer lyrics — except on V4, which did not raise the limit. */
const CUSTOM_MUSIC_PROMPT_LIMIT = 5000;

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

      fileName?: string;
    }
  | { ok: false; error: string };

function refuse(error: string): SoundRequestResult {
  return { ok: false, error };
}

export function validateSoundRequest(args: SoundRequestInput): SoundRequestResult {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return refuse('Expected an object of sound arguments.');
  }

  const kind = (args.kind === undefined ? 'sound_effect' : args.kind) as SoundKind;

  if (typeof kind !== 'string' || !Object.hasOwn(KIND_KEYS, kind)) {
    return refuse('kind must be sound_effect, speech or music');
  }

  /*
   * An option belonging to ANOTHER kind is refused by name rather than ignored. Silently dropping
   * `voice` from a speech request the caller spelled as an effect produces a render that is not what
   * was asked for, at full price — the refusal costs a round and nothing else.
   */
  const allowed = new Set([...COMMON_KEYS, ...KIND_KEYS[kind]]);

  for (const key of Object.keys(args)) {
    if (args[key] !== undefined && !allowed.has(key)) {
      return refuse(`${key} is not supported for ${kind}`);
    }
  }

  const options: Record<string, string | number | boolean> = {};
  let failure: string | undefined;

  const str = (key: string, max = Infinity): string | undefined => {
    const value = args[key];

    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      failure ??= `${key} must be a nonempty string${Number.isFinite(max) ? ` of at most ${max} characters` : ''}`;
      return undefined;
    }

    return value;
  };

  const bool = (key: string, fallback: boolean): boolean => {
    if (args[key] === undefined) {
      return fallback;
    }

    if (typeof args[key] !== 'boolean') {
      failure ??= `${key} must be a boolean`;
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
      failure ??= `${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`;
      return undefined;
    }

    return value;
  };

  const requestedModel = str('model');

  if (failure) {
    return refuse(failure);
  }

  if (kind === 'speech') {
    const model = requestedModel ?? SOUND_MODELS.speech;

    if (!SPEECH_MODELS.includes(model as (typeof SPEECH_MODELS)[number])) {
      return refuse(`Unsupported speech model: ${model}. Use ${SPEECH_MODELS.join(', ')}`);
    }

    const prompt = str('prompt', PROMPT_LIMIT.speech);

    if (!prompt) {
      return refuse(failure ?? 'generate_sound needs a "prompt" — for speech it is the exact text to say.');
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

      if (model !== SOUND_MODELS.speechTurbo) {
        return refuse(`language_code is only supported by ${SOUND_MODELS.speechTurbo}`);
      }

      options.languageCode = language;
    }

    // Read BEFORE the guard, or a bad file_name sets `failure` too late to be reported.
    const fileName = str('file_name');

    return failure ? refuse(failure) : { ok: true, kind, model, prompt, options, fileName };
  }

  /*
   * Effects and music both run on Suno, where `model` names a VERSION rather than a priced model id.
   * Keeping the tool's vocabulary identical to the MCP's matters more than the mismatch reads: the
   * version rides in `options.sunoModel` and the priced id comes from the kind.
   */
  const versions: readonly string[] = kind === 'music' ? SUNO_MUSIC_VERSIONS : SUNO_EFFECT_VERSIONS;
  const version = requestedModel ?? 'V5';

  if (!versions.includes(version)) {
    return refuse(`Unsupported ${kind} model: ${version}. Use ${versions.join(', ')}`);
  }

  options.sunoModel = version;

  if (kind === 'sound_effect') {
    const prompt = str('prompt', PROMPT_LIMIT.sound_effect);

    if (!prompt) {
      return refuse(failure ?? 'generate_sound needs a "prompt" describing the sound.');
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

    return failure ? refuse(failure) : { ok: true, kind, model: SOUND_MODELS.effect, prompt, options, fileName };
  }

  const customMode = bool('custom_mode', false);
  const limit = customMode && version !== 'V4' ? CUSTOM_MUSIC_PROMPT_LIMIT : PROMPT_LIMIT.music;
  const prompt = str('prompt', limit);

  if (!prompt) {
    return refuse(failure ?? 'generate_sound needs a "prompt" describing the music.');
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
      return refuse(failure ?? 'custom_mode music requires both style and title');
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

  return failure
    ? refuse(failure)
    : { ok: true, kind, model: SOUND_MODELS.music, prompt, options, fileName: musicFileName };
}
