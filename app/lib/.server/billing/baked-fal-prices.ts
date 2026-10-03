/**
 * fal.ai's baked price list — the static fallback beneath the operator's promoted list (SPEC §4.6,
 * `_specs/media-gateways_plan.md` T2).
 *
 * The same role `baked-market-prices.ts` (KIE) plays: real,
 * current-at-build pricing, so a storage outage costs price DRIFT since the last bake and never a
 * dead billing path or a zero rate. The operator's promoted list (Settings → Admin → Marketplace
 * prices → FAL) overrides it at runtime.
 *
 * ## 🔴 MEDIA-ONLY — `llm` IS EMPTY, AND VALIDATION REQUIRES THAT
 *
 * fal is a media gateway (`MEDIA_ONLY_PRICE_PROVIDERS`): it renders images, video and sound and
 * serves no model the agent runs on. Its list therefore carries no LLM rows, and
 * `validateMarketPriceList(list, 'FAL')` refuses one that does — rows nothing bills against would sit
 * on the admin panel looking like prices the platform charges.
 *
 * ## Provenance (2026-10-01)
 *
 * Every row is fal's LIST price: "fal list price; account-specific discounts may apply". The base
 * number per model comes from fal's pricing API (`GET https://api.fal.ai/v1/models/pricing`, called
 * with the platform key 2026-10-01 — it reports ONE price per model) and the per-variant multipliers
 * (resolution, audio on/off) from each model's `https://fal.ai/models/<id>/llms.txt` prose, which is
 * the only place fal states them. `FAL_PRICE_SOURCES` records the source per row as data.
 *
 * ⚠️ **NOT YET CONFIRMED BY A RENDER.** `scripts/fal-media-probe.mjs` was run 2026-10-01 and every
 * submit was refused with HTTP 403 `User is locked. Reason: Exhausted balance` — the account had no
 * credit, so nothing rendered and nothing was charged. Re-run the probe after topping up; its
 * billing-events read is what turns these list prices into measured ones.
 *
 * ⚠️ **One row disagrees between fal's two sources, and the higher number ships.** Kling v3 Standard:
 * the pricing API reports $0.14/s while the model page says $0.126/s with audio ($0.084/s without).
 * The API's single price is the model's DEFAULT configuration (Kling defaults `generate_audio: true`),
 * so the audio-on row takes the API's $0.14 — under-quoting a render is the costly direction, because
 * the debit is taken BEFORE the spend from this exact number. (The same API reports $0.14/s for Kling
 * v3 PRO too, between that page's $0.112 and $0.168, so the API's number is not a reliable per-variant
 * price and the Pro rows keep the page's prices.) The probe's billing events settle it.
 *
 * ## Left out on purpose (plan, "Left out on purpose")
 *
 * `flux-2-pro`/`flux-2-flex` (priced per megapixel — no `MEDIA_UNITS` value expresses it),
 * `seedance-2.0` (priced per token) and `ideogram/v3/generate-transparent` (transparency here is the
 * two-stage cut-out, as on KIE). An unlisted model has no row, so it is REFUSED — never guessed.
 */
import type { MarketPriceList } from './market-prices';

/** One citation per row: the model page the variant multipliers came from, plus the API base price. */
export const FAL_PRICE_SOURCES: Record<string, string> = {
  'fal-ai/nano-banana-2':
    'https://fal.ai/models/fal-ai/nano-banana-2/llms.txt ($0.08/image; 2K x1.5, 4K x2) + pricing API $0.08 images',
  'fal-ai/nano-banana-pro':
    'https://fal.ai/models/fal-ai/nano-banana-pro/llms.txt ($0.15/image; 4K x2) + pricing API $0.15 images',
  'fal-ai/bytedance/seedream/v4.5/text-to-image':
    'https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image/llms.txt ($0.04/image) + pricing API $0.04 images',
  'fal-ai/bria/background/remove':
    'https://fal.ai/models/fal-ai/bria/background/remove/llms.txt ($0.018/generation) + pricing API $0.018 generations',
  'fal-ai/kling-video/v3/standard/text-to-video':
    'https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video/llms.txt ($0.084/s audio off) + pricing API $0.14 seconds (audio-on row; the page says $0.126)',
  'fal-ai/kling-video/v3/pro/text-to-video':
    'https://fal.ai/models/fal-ai/kling-video/v3/pro/text-to-video/llms.txt ($0.112/s audio off, $0.168/s on); pricing API reports $0.14 seconds',
  'xai/grok-imagine-video/text-to-video':
    'https://fal.ai/models/xai/grok-imagine-video/text-to-video/llms.txt ($0.05/s 480p, $0.07/s 720p) + pricing API $0.05 seconds',
  'fal-ai/veo3/fast':
    'https://fal.ai/models/fal-ai/veo3/fast/llms.txt ($0.10/s audio off, $0.15/s on) + pricing API $0.15 seconds',
  'fal-ai/veo3':
    'https://fal.ai/models/fal-ai/veo3/llms.txt ($0.20/s audio off, $0.40/s on) + pricing API $0.40 seconds',
  'fal-ai/elevenlabs/sound-effects/v2':
    'https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2/llms.txt ($0.002/s) + pricing API $0.002 seconds',
  'fal-ai/elevenlabs/tts/multilingual-v2':
    'https://fal.ai/models/fal-ai/elevenlabs/tts/multilingual-v2/llms.txt ($0.10/1k chars) + pricing API $0.1 per 1000 characters',
  'fal-ai/elevenlabs/tts/turbo-v2.5':
    'https://fal.ai/models/fal-ai/elevenlabs/tts/turbo-v2.5/llms.txt ($0.05/1k chars) + pricing API $0.05 per 1000 characters',
  'fal-ai/minimax-music/v2.6':
    'https://fal.ai/models/fal-ai/minimax-music/v2.6/llms.txt ($0.15/audio) + pricing API $0.15 audios',
};

export const BAKED_FAL_PRICES: MarketPriceList = {
  schemaVersion: 1,
  capturedAt: '2026-10-01',
  source:
    'fal list price; account-specific discounts may apply — api.fal.ai/v1/models/pricing + each model llms.txt ' +
    '(2026-10-01). Render probe refused: account balance exhausted (scripts/fal-media-probe.mjs).',

  /* Media-only gateway — see the header. */
  llm: {},

  media: {
    /*
     * ---------------------------------------------------------------------------------------------- *
     * Images — text-to-image routes only (no reference images on any gateway today, plan §"What exists")
     * ---------------------------------------------------------------------------------------------- *
     */
    'fal-ai/nano-banana-2': {
      kind: 'image',
      label: 'Nano Banana 2',
      vendor: 'Google',
      unit: 'per_request',
      variants: [
        { options: { resolution: '1K' }, usd: 0.08 },
        { options: { resolution: '2K' }, usd: 0.12 },
        { options: { resolution: '4K' }, usd: 0.16 },
      ],
    },

    /* 2K costs the same as 1K on this model; only 4K doubles. */
    'fal-ai/nano-banana-pro': {
      kind: 'image',
      label: 'Nano Banana Pro',
      vendor: 'Google',
      unit: 'per_request',
      variants: [
        { options: { resolution: '1K' }, usd: 0.15 },
        { options: { resolution: '2K' }, usd: 0.15 },
        { options: { resolution: '4K' }, usd: 0.3 },
      ],
    },

    /* One flat price; takes `image_size` (each side 1920–4096), not `aspect_ratio`. */
    'fal-ai/bytedance/seedream/v4.5/text-to-image': {
      kind: 'image',
      label: 'Seedream 4.5',
      vendor: 'ByteDance',
      unit: 'per_request',
      variants: [{ options: {}, usd: 0.04 }],
    },

    /*
     * The transparency pass (plan T3/T4): render, then cut out — quoted and debited TOGETHER with the
     * render, exactly as KIE's `recraft/remove-background`. Input `image_url`; output PNG.
     */
    'fal-ai/bria/background/remove': {
      kind: 'image',
      label: 'Bria Background Removal',
      vendor: 'Bria',
      unit: 'per_request',
      variants: [{ options: {}, usd: 0.018 }],
    },

    /*
     * ---------------------------------------------------------------------------------------------- *
     * Video — per second; the request MUST state its duration or the lookup refuses
     * ---------------------------------------------------------------------------------------------- *
     */
    'fal-ai/kling-video/v3/standard/text-to-video': {
      kind: 'video',
      label: 'Kling 3.0 Standard',
      vendor: 'Kling',
      unit: 'per_second',
      variants: [
        { options: { generate_audio: false }, usd: 0.084 },

        /* fal's pricing API (the model's default, audio on); its page says $0.126 — see the header. */
        { options: { generate_audio: true }, usd: 0.14 },
      ],
    },

    'fal-ai/kling-video/v3/pro/text-to-video': {
      kind: 'video',
      label: 'Kling 3.0 Pro',
      vendor: 'Kling',
      unit: 'per_second',
      variants: [
        { options: { generate_audio: false }, usd: 0.112 },
        { options: { generate_audio: true }, usd: 0.168 },
      ],
    },

    /* Grok Imagine has no audio switch; it is priced by resolution. */
    'xai/grok-imagine-video/text-to-video': {
      kind: 'video',
      label: 'Grok Imagine Video',
      vendor: 'xAI',
      unit: 'per_second',
      variants: [
        { options: { resolution: '480p' }, usd: 0.05 },
        { options: { resolution: '720p' }, usd: 0.07 },
      ],
    },

    /* Google video (`generate_google_video`). Durations are "4s" / "6s" / "8s" on the wire. */
    'fal-ai/veo3/fast': {
      kind: 'video',
      label: 'Veo 3 Fast',
      vendor: 'Google',
      unit: 'per_second',
      variants: [
        { options: { generate_audio: false }, usd: 0.1 },
        { options: { generate_audio: true }, usd: 0.15 },
      ],
    },

    'fal-ai/veo3': {
      kind: 'video',
      label: 'Veo 3',
      vendor: 'Google',
      unit: 'per_second',
      variants: [
        { options: { generate_audio: false }, usd: 0.2 },
        { options: { generate_audio: true }, usd: 0.4 },
      ],
    },

    /*
     * ---------------------------------------------------------------------------------------------- *
     * Sound
     * ---------------------------------------------------------------------------------------------- *
     */

    /*
     * Per second of audio ($0.002/s — both the page and the pricing API say seconds). `duration_seconds`
     * is optional on the wire (0.5–22), but a per_second row REFUSES a request with no duration, so the
     * platform must always send one. Unconfirmed by a render — see the header.
     */
    'fal-ai/elevenlabs/sound-effects/v2': {
      kind: 'audio',
      label: 'ElevenLabs Sound Effects v2',
      vendor: 'ElevenLabs',
      unit: 'per_second',
      variants: [{ options: {}, usd: 0.002 }],
    },

    'fal-ai/elevenlabs/tts/multilingual-v2': {
      kind: 'audio',
      label: 'ElevenLabs Multilingual v2',
      vendor: 'ElevenLabs',
      unit: 'per_1k_chars',
      variants: [{ options: {}, usd: 0.1 }],
    },

    'fal-ai/elevenlabs/tts/turbo-v2.5': {
      kind: 'audio',
      label: 'ElevenLabs Turbo 2.5',
      vendor: 'ElevenLabs',
      unit: 'per_1k_chars',
      variants: [{ options: {}, usd: 0.05 }],
    },

    /* Per generation; `is_instrumental: true` for a song with no vocals (lyrics are then optional). */
    'fal-ai/minimax-music/v2.6': {
      kind: 'audio',
      label: 'MiniMax Music 2.6',
      vendor: 'MiniMax',
      unit: 'per_request',
      variants: [{ options: {}, usd: 0.15 }],
    },
  },
};
