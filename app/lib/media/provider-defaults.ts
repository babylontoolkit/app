/**
 * WHICH MODEL A MEDIA TOOL CALLS WHEN THE AGENT NAMES NONE (SPEC §4.16).
 *
 * ## The defect this exists to close (found live, T9, 2026-08-11)
 *
 * `generate_image` defaulted to `nano-banana-2`, `generate_video` to `kling-3.0/video` and
 * `generate_google_video` to `veo3_fast` — three literals inlined in the tool schemas, every one of
 * them a **KIE** model id. Nothing in the type system or the tests said so, because while KIE was the
 * only gateway a "default model" and "a KIE model" were the same string.
 *
 * (Comet was a media gateway until 2026-10-01; the measurement below is why the table is per gateway.)
 *
 * On Comet none of those ids is in the price list, so `lookupMediaPrice` returns null and
 * `startMediaTask` REFUSES — correctly, before any debit. The result is not a wrong render or a wrong
 * bill; it is a whole tool round spent discovering that the defaults do not exist here. Measured on
 * the first live Comet media turn (`gen_mso6s0gd_frqrfh`):
 *
 *   step 0: 3 calls, ALL refused (2x generate_image + generate_video, all default models)
 *           8187ms - 578 out - 31,098 cache-write tokens - 0 tasks created
 *   step 1: the model re-read the refusal, named Comet ids, 2 images created
 *   step 2: the video, after `generate_google_video`'s default was refused the same way
 *   step 3: the answer
 *
 * Four steps where two would do. It SELF-HEALS — `MediaRefusedError` names the available models, so
 * the agent recovers on the next round — which is exactly why it would never have been reported as a
 * bug: the art arrives, the ledger is right, and the only trace is a turn that cost about twice what
 * it should have. That is the §4.2.8 silent-failure shape (nothing throws, the bill goes up).
 *
 * ## Why a table and not a constant
 *
 * The same reason the cache warmer's `!== 'KIE'` guard was wrong (2026-08-08): in a codebase built so
 * the gateway is a config swap, any value that silently means "the vendor we happened to start with"
 * stops being true on the next deploy, and stops being true QUIETLY. A default model is per gateway or
 * it is a bug waiting for `MEDIA_PROVIDER` to change.
 *
 * ## The invariant that keeps it honest
 *
 * **Every default here must be priced in that provider's own baked price list.** A default that cannot
 * be quoted is precisely the bug above, so `provider-defaults.spec.ts` asserts it against the real
 * baked lists rather than against a copy of this table — a table checked against itself proves only
 * that it was typed consistently. If an operator promotes a list that drops a default, the refusal is
 * still correct and still names the alternatives; the test is what stops us SHIPPING one that way.
 *
 * Client-safe (no `~/lib/.server/**` imports) so the Media panel can render the same defaults the
 * agent gets, rather than a second opinion about them.
 */
import type { ImageProviderName } from './image-capabilities';

export interface MediaModelDefaults {
  /** `generate_image` when the agent names no model. */
  image: string;

  /**
   * `generate_video` — the gateway's general-purpose video model, or `null` when it has none.
   *
   * 🔴 **NEVER A GOOGLE/VEO MODEL, ON ANY GATEWAY (owner rule, 2026-08-11).** `generate_google_video`
   * exists precisely so Veo is asked for on purpose: it is the most expensive video on either
   * catalogue, and a general tool that quietly resolves to it spends that money without anyone
   * choosing to. `null` means an unqualified `generate_video` call is REFUSED here and told to name a
   * model or call `generate_google_video` — a free refusal, before any debit.
   *
   * ⚠️ This regressed once, in the T9 defaults fix, and the regression was WORSE than the bug it
   * replaced: `generate_video` previously defaulted to `kling-3.0/video`, which Comet cannot price, so
   * an unqualified call was already refused for free. Pointing it at `veo3-fast` to remove a wasted
   * tool round converted that free refusal into an automatic 128-credit Veo render. **Removing a
   * refusal is not a cost saving when the thing you replaced it with spends money.**
   */
  video: string | null;

  /**
   * `generate_google_video` — the Veo family specifically.
   *
   * ⚠️ The id differs by gateway for the SAME model: KIE spells it `veo3_fast` (underscore) and fal
   * `fal-ai/veo3/fast`. That one character is the whole defect in miniature — it looks like the same
   * value and is not, and no type can tell you which spelling a given gateway wants.
   */
  googleVideo: string;

  /**
   * Other video ids worth naming in `generate_video`'s schema, as a ready-made clause ('' for none).
   *
   * ⚠️ Provider-scoped for the same reason as the defaults, and it is not cosmetic: this text sits in
   * the CACHED prompt, so a KIE model list shown on a fal deploy actively teaches the agent ids that
   * will be refused — buying the wasted round back that the defaults just removed.
   */
  videoAlternatives: string;

  /**
   * `generate_video`'s `mode` and `resolution` hints — the knobs are gateway-specific too.
   *
   * ⚠️ These were hardcoded KIE prose (`'kling-3.0 tier: std (720p)…'`, `'For seedance/grok models…'`)
   * and were left behind on the first pass as "cosmetic". They are not: this file's own header says
   * naming a foreign id teaches the agent ids that will be refused, and on Comet no model starts with
   * `kling-3.0`, so `mode` is never even added to the payload — dead prose in the CACHED prefix
   * describing a knob that does nothing. Empty string means "this gateway has no such knob".
   */
  videoModeHint: string;
  videoResolutionHint: string;

  /**
   * `generate_sound`'s default model per kind, or `null` on a gateway that serves no audio.
   *
   * `null` is not a placeholder: it is what makes the tool and the Media panel's Sound tab ABSENT on
   * a gateway with no audio routes. Advertising a sound tool there would buy a refused call
   * on every turn that wants one — the same wasted round the image/video defaults exist to remove.
   */
  sound: { effect: string; music: string; speech: string } | null;

  /**
   * The resolutions `generate_google_video` may name on this gateway, default first.
   *
   * ⚠️ Gateway-scoped because the cached tool description is built from it: fal's Veo renders 720p and
   * 1080p only, so the KIE text ("720p, 1080p or 4k") promised a 4k clip fal would render at 720p while
   * billing the request as asked. The tool refuses a resolution outside this list, before any debit.
   */
  googleVideoResolutions: readonly string[];
}

/** The three kinds `generate_sound` serves — the MCP's vocabulary (`kie-sound`), kept verbatim. */
export type SoundKind = 'sound_effect' | 'music' | 'speech';

/** Suno version options — a REQUEST option, never a price key (every version costs the same). */
export const SUNO_EFFECT_VERSIONS = ['V5', 'V5_5'] as const;
export const SUNO_MUSIC_VERSIONS = ['V4', 'V4_5', 'V4_5PLUS', 'V4_5ALL', 'V5', 'V5_5'] as const;

/**
 * How a gateway's sound arguments are spoken — which validator and which tool text apply.
 *
 * A DIALECT, not a provider name: KIE serves Suno (effects + music, with a version option) and
 * ElevenLabs (speech, any voice id); fal serves ElevenLabs effects with a length, ElevenLabs speech
 * with a fixed set of voice NAMES, and MiniMax music with lyrics. A third gateway that spoke either
 * dialect would reuse it rather than adding a branch.
 */
export type SoundDialect = 'suno' | 'elevenlabs-minimax';

/** One gateway's sound catalogue (SPEC §4.16, `_specs/media-gateways_plan.md` T6). */
export interface SoundModels {
  dialect: SoundDialect;

  /** The PRICED model id for each kind — a price-list key, a wire route and a payload shape at once. */
  effect: string;
  music: string;

  /** Speech model ids, the default FIRST. */
  speech: readonly string[];

  /**
   * The voice names this gateway accepts, the default FIRST — or `null` when any voice name or id is
   * accepted (KIE's ElevenLabs takes raw voice ids, so a list would refuse real voices).
   *
   * ⚠️ fal's `voice` is a free string with NO enum in its schema, so an unknown name is refused only at
   * run time — after the debit. Offering exactly the documented list is what makes that refusal free.
   */
  voices: readonly string[] | null;

  /** Suno version choices for effects and music, or `null` on a gateway with no version option. */
  musicOptions: { effectVersions: readonly string[]; musicVersions: readonly string[] } | null;

  /**
   * A sound effect's length in seconds — the bounds and the default used when none is stated — or
   * `null` when the gateway has no length control (Suno picks its own).
   *
   * 🔴 The default is not cosmetic on a gateway that prices effects PER SECOND: a request with no
   * length cannot be priced at all, so the quote and the payload both resolve it through
   * `soundEffectSeconds` — one function, so the length billed is the length asked for.
   */
  effectSeconds: { min: number; max: number; default: number } | null;
}

/**
 * The canonical sound model ids per gateway, named ONCE.
 *
 * These strings are a price-list key, a wire route and a payload shape all at the same time, read by
 * the service, the agent tool and the Media panel. Three copies of one id is how a model gets priced
 * under one spelling and created under another — `isSecretPath`'s rule, applied to a model slug.
 *
 * A RECORD, never a ternary: a gateway added to `ImageProviderName` must state its catalogue here or
 * fail to compile.
 */
export const SOUND_MODELS: Readonly<Record<ImageProviderName, SoundModels>> = {
  KIE: {
    dialect: 'suno',
    effect: 'suno/generate-sounds',
    music: 'suno/generate-music',
    speech: ['elevenlabs/text-to-speech-multilingual-v2', 'elevenlabs/text-to-speech-turbo-2-5'],
    voices: null,
    musicOptions: { effectVersions: SUNO_EFFECT_VERSIONS, musicVersions: SUNO_MUSIC_VERSIONS },
    effectSeconds: null,
  },

  /*
   * fal.ai — each id is the fal model path, its price-list key (`baked-fal-prices.ts`) and its route
   * (`fal-routes.ts`). Voices are fal's documented ElevenLabs names (read 2026-10-01).
   */
  FAL: {
    dialect: 'elevenlabs-minimax',
    effect: 'fal-ai/elevenlabs/sound-effects/v2',
    music: 'fal-ai/minimax-music/v2.6',
    speech: ['fal-ai/elevenlabs/tts/multilingual-v2', 'fal-ai/elevenlabs/tts/turbo-v2.5'],
    voices: [
      'Rachel',
      'Aria',
      'Roger',
      'Sarah',
      'Laura',
      'Charlie',
      'George',
      'Callum',
      'River',
      'Liam',
      'Charlotte',
      'Alice',
      'Matilda',
      'Will',
      'Jessica',
      'Eric',
      'Chris',
      'Brian',
      'Daniel',
      'Lily',
      'Bill',
    ],
    musicOptions: null,
    effectSeconds: { min: 0.5, max: 22, default: 5 },
  },
};

/** A gateway's sound catalogue, or `null` for one this table does not know (never KIE's by default). */
export function soundModelsFor(provider: ImageProviderName | string): SoundModels | null {
  return Object.hasOwn(SOUND_MODELS, provider) ? SOUND_MODELS[provider as ImageProviderName] : null;
}

/**
 * The length a sound effect is priced AND requested at, in seconds — or `undefined` where the gateway
 * has no length control.
 *
 * The ONE resolver both the quote and the payload read: a per-second price looked up with one length
 * and a body sent with another bills a clip that was never rendered.
 */
export function soundEffectSeconds(provider: ImageProviderName | string, requested?: number): number | undefined {
  const range = soundModelsFor(provider)?.effectSeconds;

  return range ? (requested ?? range.default) : requested;
}

/**
 * Which sound kind a model id is, or `null` when it is not a sound model at all.
 *
 * The ONE writer of that question — `endpointFor`, `buildProviderPayload` and `deriveDestPath` all
 * ask it, and three private spellings is the `isGoogleVideoModel` lesson repeating. Every gateway's
 * ids are checked, through the table, so a fal id is never mistaken for "not sound".
 */
export function soundKindForModel(model: string): SoundKind | null {
  const id = model.trim();

  for (const catalogue of Object.values(SOUND_MODELS)) {
    if (id === catalogue.effect) {
      return 'sound_effect';
    }

    if (id === catalogue.music) {
      return 'music';
    }

    if (catalogue.speech.includes(id)) {
      return 'speech';
    }
  }

  return null;
}

/** The `{effect, music, speech}` defaults a gateway's sound catalogue implies (speech: its first id). */
function soundDefaults(models: SoundModels): NonNullable<MediaModelDefaults['sound']> {
  return { effect: models.effect, music: models.music, speech: models.speech[0] };
}

const DEFAULTS: Record<ImageProviderName, MediaModelDefaults> = {
  KIE: {
    image: 'nano-banana-2',
    video: 'kling-3.0/video',
    googleVideo: 'veo3_fast',
    videoAlternatives: ' Also: kling-2.6, bytedance/seedance-2, …',
    videoModeHint: 'kling-3.0 tier: std (720p), pro (1080p) or 4K. Default std.',
    videoResolutionHint: 'For seedance/grok models: 480p, 720p, 1080p, 4K.',
    sound: soundDefaults(SOUND_MODELS.KIE),
    googleVideoResolutions: ['720p', '1080p', '4k'],
  },

  /*
   * fal.ai (media-only gateway, `_specs/media-gateways_plan.md` T3). Every id is the fal model path,
   * which is also its price-list key (`baked-fal-prices.ts`) and its route (`fal-routes.ts`).
   */
  FAL: {
    image: 'fal-ai/nano-banana-2',

    /* Kling, never Veo — the owner rule this field's doc comment states. */
    video: 'fal-ai/kling-video/v3/standard/text-to-video',
    googleVideo: 'fal-ai/veo3/fast',
    videoAlternatives:
      ' Also: fal-ai/kling-video/v3/pro/text-to-video (higher quality), ' +
      'xai/grok-imagine-video/text-to-video (cheapest; resolution 480p or 720p).',

    /* Kling's tier on fal is a different MODEL id (standard/pro), not a `mode` field. */
    videoModeHint: '',
    videoResolutionHint: 'Grok Imagine only: 480p or 720p. Default 720p.',

    /* ElevenLabs effects and speech, MiniMax music (T6). */
    sound: soundDefaults(SOUND_MODELS.FAL),

    /* fal's Veo takes `720p` / `1080p` only — no 4k. */
    googleVideoResolutions: ['720p', '1080p'],
  },
};

/**
 * The defaults for a gateway.
 *
 * ⚠️ An unrecognised provider falls back to **KIE's** table rather than throwing: this is called from
 * inside a tool's `execute`, and a throw there kills a generation the user has already paid for. A
 * wrong-but-priced default is refused before any debit and names the alternatives; a throw is not.
 */
export function mediaModelDefaults(provider: ImageProviderName | string): MediaModelDefaults {
  return DEFAULTS[provider as ImageProviderName] ?? DEFAULTS.KIE;
}

/**
 * Is this id a Google/Veo video model?
 *
 * 🔴 THE OTHER HALF OF THE OWNER RULE. Removing the Google DEFAULT stops `generate_video` drifting
 * onto Veo by itself; this stops it being driven there by a model that named the id on the general
 * tool. "You have to explicitly ask for Google video" means calling `generate_google_video` — not
 * mentioning a Veo id somewhere else — and without this the separation is advice rather than a wall.
 * `protocol-strip`'s rule: no prompt wording reliably stops a model, so the pipeline has to refuse.
 *
 * ⚠️ Matches on the FAMILY, after stripping separators, because the gateways spell the same model
 * `veo3_fast`, `veo3-fast` and `fal-ai/veo3/fast`, and a future `veo4` must not need a new entry here. It is deliberately
 * NOT a hardcoded id list: an id list is a thing that goes stale the next time a vendor ships a model,
 * silently, in the expensive direction.
 */
export function isGoogleVideoModel(model: string): boolean {
  /*
   * Per PATH SEGMENT: fal prefixes its vendor (`fal-ai/veo3/fast`, `fal-ai/veo3`), so a test anchored
   * at the start of the whole id read fal's Veo as NOT Google — and `generate_video` would have served
   * the most expensive video on the gateway from the general tool. `kling-video/…` and
   * `grok-imagine-video/…` have no segment starting `veo<digit>`, so they stay non-Google.
   */
  return model
    .trim()
    .toLowerCase()
    .split('/')
    .some((segment) => /^veo\d/.test(segment.replace(/[-_.]/g, '')));
}

/** Every gateway this table knows, for the specs to iterate rather than re-list. */
export function providersWithDefaults(): ImageProviderName[] {
  return Object.keys(DEFAULTS) as ImageProviderName[];
}
