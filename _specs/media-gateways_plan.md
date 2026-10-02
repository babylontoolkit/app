# Media gateways — fal.ai as a third gateway, and sound on all three

**Goal.** KIE, Comet and fal.ai become interchangeable media gateways, chosen by `MEDIA_PROVIDER` (`KIE` | `Comet` | `FAL`). Each one serves:
- **images**, including transparent ones;
- **video** (`generate_video` plus the separate `generate_google_video` for Veo);
- **sound**: sound effects, music and speech through `generate_sound` and the Media panel's Sound tab.

Every render is priced, debited before anything is spent, polled, and delivered into `public/assets/generated/`. If one gateway has an outage, the owner switches gateways with one environment variable.

**Owner decisions:**
- *2026-09-30:* Anthropic is the only LLM provider. **Higgsfield is dropped**: its public REST API has no standalone sound, music or speech model (details below).
- *2026-10-01:* add **fal.ai** as a third media gateway with the same capabilities as KIE. **All three gateways get sound.** The fal key is the owner's existing `FAL_API_KEY` in `.env.local`.
- *2026-10-01:* this plan replaces `_specs/comet-sound_plan.md`, which was never executed. Its five tasks are folded in here (T1, T5, T6, T7, T8).

---

## Codebase Analysis

**Mode:** Quick Plan (no spec file). The owner's messages answer the scope, so there was no interview.
- `spec_impact: yes` (SPEC §4.16 and §4.6's price lists change).
- `size: medium`, inferred. 8 tasks: two gateways are being extended at once, and each needs its own probe and pricing.
- `proof: functional`.

### Why Higgsfield is out (checked 2026-09-30)

Four sources agree that the public API serves only images and video:
- the price list (https://open.higgsfield.ai/) has no audio category;
- the OpenAPI spec (https://docs.higgsfield.ai/docs/openapi.json) has six generation paths, all image or video;
- the model catalogue (https://docs.higgsfield.ai/docs/models.md) lists 16 image and 66 video models;
- the JS SDK uses audio only as an input.

Seed Audio and its text-to-speech exist only in Higgsfield's CLI and web app, which need a browser login.

### What exists and is reused

All paths are relative to the repo root.

- **The seam** (`app/lib/.server/media/provider.ts`):
  - `MediaProvider { name, create, query, download }`.
  - `MediaEndpoint` is **persisted on task records**, so values may be added and never renamed. Today it holds `'jobs' | 'veo' | 'suno-sounds' | 'suno-music' | 'comet-image' | 'comet-gemini-image' | 'comet-video'`.
  - The one factory is `mediaProviderFor(name, apiKey, baseUrl)`, an exhaustive switch.
  - The provider is stamped on each task record, so polling always asks the gateway that created the task, even if `MEDIA_PROVIDER` has since changed (`mediaProviderOf`).
- **Provider lists** (`app/lib/.server/agent/config.ts`):
  - `PLATFORM_PROVIDERS = ['Anthropic','KIE','Comet']` (:43) and `MEDIA_PROVIDERS = ['KIE','Comet']` (:58). The doc comment calls the second a "strict subset" of the first.
  - `MEDIA_KEY_ENV` (:840) maps each gateway to its key variable.
  - `getMediaProvider` (:864) reads `MEDIA_PROVIDER` and otherwise falls back to the LLM provider.
  - `mediaBaseUrlFor` (:936) is a `=== 'Comet'` ternary.
  - `requireMediaKey` (:947) says "image/video generation".
- **Client-safe tables:**
  - `ImageProviderName = 'KIE' | 'Comet'` (`app/lib/media/image-capabilities.ts:40`).
  - `CAPABILITIES` (:72): KIE has no native-alpha model; Comet's is `gpt-image-1.5`.
  - `hasCutoutPass(provider)` is `provider === 'KIE'` (:136).
  - `DEFAULTS: Record<ImageProviderName, MediaModelDefaults>` (`app/lib/media/provider-defaults.ts:150`). Comet has `sound: null`.
  - `SOUND_MODELS` (:118) and `soundKindForModel` (:136) know **KIE ids only**.
  - `isGoogleVideoModel` (:221) strips `-_.` and tests `^veo\d`, so **`fal-ai/veo3/fast` would NOT match**, because the vendor prefix comes first. T3 fixes this.
- **Service** (`app/lib/.server/media/service.ts`):
  - `CUTOUT_MODEL = 'recraft/remove-background'` (:50) is a single KIE constant.
  - The poll path chains the cut-out with a hardcoded `endpoint: 'jobs'` and `payload: { image }` (:741-747).
  - `endpointFor` (:862) is a switch per provider.
  - `buildProviderPayload` (:950) branches to `buildCometPayload` (:1125).
  - `buildSoundPayload` (:1051) builds KIE-only bodies.
  - The music refusal (:254-264) applies to every provider and names KIE.
  - `deriveDestPath` (:1178) gives audio the `.mp3` extension.
  - KIE sends `image_input: []` (:1029): **there are no reference images on any gateway today**, so fal uses only its text-to-image and text-to-video routes, and its `/edit` and image-to-video routes are not used.
- **The provider task id** field on `MediaTaskRecord` is named `kieTaskId` for historical reasons (`store.ts:62`). It holds any gateway's id. Do not rename it, because records persist.
- **Price lists:**
  - `MARKET_PRICE_PROVIDERS = ['KIE','Comet','Anthropic']` (`market-price-store.ts:50`), with a storage-key record (:63) and a baked-list record (:70).
  - `validateMarketPrices` (`market-prices.ts:175`) **requires LLM rows and the platform default model**. fal sells no LLM, so its list must be media-only (T2).
  - `rates.ts:448` iterates every provider's `llm` rows; a provider with an empty `llm` contributes nothing.
  - `lookupMediaPrice` (`market-prices.ts:508`) supports units `per_request`, `per_second` and `per_1k_chars`.
  - The admin feed fetchers are `fetchKieMarketFeed` and `fetchCometMarketFeed` (`market-feed.ts`), dispatched in `app/routes/api.admin.market-prices.ts:194-197`. The UI is `app/components/@settings/tabs/admin/MarketPricesSection.tsx`.
- **Dispatch queue** (`dispatch.ts`): serialises `provider.create` with spacing and retries. It wraps any provider unchanged.
- **Client:** `MediaPanel.tsx`:
  - `modelsForProvider(kind, provider: 'KIE'|'Comet'|null)` (:340) returns sound models for KIE only;
  - `withBackgroundField` (:166) decides whether the transparency control is shown;
  - the Sound tab appears only when its list is non-empty (:602).
- **Agent side:**
  - `media-tools.ts` builds `generate_sound` only when `defaults.sound` is non-null (:365-446). Its prose is KIE-specific.
  - `media-note.ts:71-76` always names `generate_sound`, even where the tool is absent (an existing defect, fixed in T6).
- **Tests to mirror:**
  - `comet-client.spec.ts`: a fetch stub with `seen[]` and a `responder`;
  - `media.spec.ts`: `FakeProvider` (:55), quoting (:205), poll and refund (:490);
  - `media-provider.spec.ts`: endpoint routing (:535);
  - `provider-defaults.spec.ts`: every default must be priced in its own provider's baked list;
  - `comet-prices.spec.ts`, `sound-request.spec.ts`, `media-tools.spec.ts`, `media-panel-fields.spec.tsx`, `market-price-store.spec.ts`.

### Comet's audio API (docs, 2026-09-30, https://apidoc.cometapi.com/llms.txt)

- **Common to all routes:**
  - Host `https://api.cometapi.com` with `Authorization: Bearer <COMET_API_KEY>`.
  - The audio routes are **not under `/v1`**, so the client derives the host from its base URL.
- **Sound effects:**
  - `POST /runwayml/v1/sound_effect` with `{model:"eleven_text_to_sound_v2", promptText (1–3000), duration? (0.5–30), loop?}`.
  - The body is strict (`additionalProperties:false`).
  - Returns `{id}`.
- **Speech:**
  - `POST /runwayml/v1/text_to_speech` with `{model:"eleven_multilingual_v2" (≤1000 chars) | "eleven_v3" (≤5000), promptText, voice:{type:"runway-preset", presetId}}`.
  - `presetId` is one of 49 names (Maya, Arjun, Serene, Bernard, Rachel, …).
- **Polling sound effects and speech:**
  - `GET /runwayml/v1/tasks/{id}`. Statuses: `PENDING | THROTTLED | RUNNING | SUCCEEDED | FAILED | CANCELLED`.
  - `output[]` holds the audio URLs.
  - A 400 `task_not_exist` on a fresh task means pending, not failed.
- **Music:**
  - `POST /suno/submit/music` with `{prompt, tags, title, mv, make_instrumental, generation_type:"TEXT", metadata:{create_mode:"custom"}}`.
  - `notify_hook` is optional.
  - Returns `{code, data:"<task id>"}`.
  - Poll `GET /suno/fetch/{id}`, which returns `{data:{status, fail_reason, data:[clips{audio_url, duration, status}]}}`. One submit can return two clips.
- **Prices:**
  - Sound effects: $0.008 (per second or per request, **to confirm in T1**).
  - Speech: $0.008 per 50 characters.
  - Suno: $0.144 per submit (from Comet's Suno guide; not in Comet's feed).

### fal.ai's API (research 2026-10-01; sources are each model's `https://fal.ai/models/<id>/llms.txt` and https://fal.ai/docs/llms.txt)

- **Queue REST, no SDK:**
  - `POST https://queue.fal.run/{model_id}` with `Authorization: Key <FAL_API_KEY>` and the model input as the JSON body.
  - Returns `{request_id, response_url, status_url, cancel_url, queue_position}`.
- **Status:**
  - `GET …/requests/{id}/status` returns `IN_QUEUE | IN_PROGRESS | COMPLETED`.
  - 🔴 **A failed job also reports `COMPLETED`.** The failure shows only as `error` and `error_type` fields.
- **Result:**
  - `GET …/requests/{id}`. The shape depends on the model:
    - images: `{images:[{url}]}`
    - background removal: `{image:{url}}`
    - video: `{video:{url}}`
    - audio: usually `{audio:{url}}`, but some models return `{audio:"<url>"}` or `{audio_file:{url}}`
  - 🔴 **Status and result URLs drop the model's subpath:** a job submitted to `fal-ai/veo3/fast` is polled under `fal-ai/veo3/requests/…`. Store what submit returns; never rebuild the URLs from the model id.
- **Webhooks** are optional (`?fal_webhook=`), so polling alone works.
- **Output files** on `v3.fal.media` are public GETs. Their lifetime is configurable and the default is not documented, so the platform downloads them promptly (it already does).
- **Do not set `sync_mode: true`**: it returns the file inline as a data URI.
- **Concurrency:** new accounts get **2 jobs in progress at once** (up to 40 as credit is bought). Jobs beyond that wait in the queue rather than failing.
- **Pricing feed:** `GET https://api.fal.ai/v1/models/pricing?endpoint_id=a,b` (1–50 ids, key required) returns `{prices:[{endpoint_id, unit_price, unit, currency}]}`.
  - The prices are account-specific.
  - It gives one base price per model. Resolution, audio and duration multipliers appear only in each model's prose, so the variant rows are curated by hand, as Comet's Suno row is.
- **The fal models this plan uses:**

| Use | fal id (price key) | Price (fal list, 2026-10-01) |
| --- | --- | --- |
| Image, default | `fal-ai/nano-banana-2` | $0.08; 2K ×1.5, 4K ×2 |
| Image | `fal-ai/nano-banana-pro` | $0.15; 4K ×2 |
| Image | `fal-ai/bytedance/seedream/v4.5/text-to-image` | $0.04 (takes `image_size`, not `aspect_ratio`) |
| Cut-out (transparency) | `fal-ai/bria/background/remove` | $0.018 (input `image_url`; output PNG) |
| Video, default | `fal-ai/kling-video/v3/standard/text-to-video` | $0.084/s, $0.126/s with audio |
| Video | `fal-ai/kling-video/v3/pro/text-to-video` | $0.112/s, $0.168/s with audio |
| Video | `xai/grok-imagine-video/text-to-video` | $0.05/s at 480p, $0.07/s at 720p |
| Google video, default | `fal-ai/veo3/fast` | $0.10/s, $0.15/s with audio (duration `"4s"`/`"6s"`/`"8s"`) |
| Google video | `fal-ai/veo3` | $0.20/s, $0.40/s with audio |
| Sound effect | `fal-ai/elevenlabs/sound-effects/v2` | $0.002/s (`text`, `duration_seconds` 0.5–22, `loop`) |
| Speech, default | `fal-ai/elevenlabs/tts/multilingual-v2` | $0.10 per 1k chars (`text`, `voice` name) |
| Speech | `fal-ai/elevenlabs/tts/turbo-v2.5` | $0.05 per 1k chars |
| Music | `fal-ai/minimax-music/v2.6` | $0.15 per generation (`prompt`, `lyrics`, `is_instrumental`) |

**Left out on purpose:**
- `flux-2-pro` and `flux-2-flex`: priced per megapixel, which no `MEDIA_UNITS` value expresses.
- `seedance-2.0`: priced per token.
- fal's native-alpha `ideogram/v3/generate-transparent`: the cut-out pass keeps the user's chosen model and matches KIE's two-stage design.

They can be added later as price rows.

### Comet audio probe (T1)

- **Not run, 2026-10-01:** `COMET_API_KEY` is blank in `.env.local`. `scripts/comet-audio-probe.mjs` exists and exits non-zero with "COMET_API_KEY is not set in .env.local" until the key is set.
- **The baked rows come from Comet's published sources, not a probe** (`baked-comet-prices.ts`, arithmetic in `COMET_AUDIO_PROVENANCE`):
  - feed (`GET https://api.cometapi.com/api/models`, no key, read 2026-10-01): `eleven_text_to_sound_v2`, `eleven_multilingual_v2` and `eleven_v3` each `per_request 0.01, ratio 0.8` → charged $0.008;
  - `eleven_text_to_sound_v2`: `per_request` $0.008, one catch-all row priced with or without a duration;
  - `eleven_multilingual_v2`, `eleven_v3`: `per_1k_chars` $0.16 (docs: "$0.008 per 50 characters");
  - `suno_music`: `per_request` $0.144, HAND-MAINTAINED from Comet's Suno guide (the feed has no Suno rows).
- **Run `node scripts/comet-audio-probe.mjs`** once the key is set to confirm: whether a sound-effect duration scales the charge (it submits 2 s and no-duration), the task status sequences and the `task_not_exist` behaviour, the Suno clip count and the working `mv`, whether result files download without the key, their real container, latency, and the charge.

### fal probe results (T2, 2026-10-01)

**The render probe could not run: every submit was refused, nothing rendered, $0 spent.** `scripts/fal-media-probe.mjs` submitted all 13 jobs; each answered at once with:

```
HTTP 403  {"detail": "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing."}
```

Top up the fal account, then re-run `node scripts/fal-media-probe.mjs` (raw output goes to `PROBE_OUT_DIR`, default the OS temp dir). It records everything T3 needs: the `response_url` ↔ `status_url` relation, the subpath-dropped claim for `fal-ai/veo3/fast`, the status sequence, a failed job's status and result bodies, each result's file-URL field, keyless downloads, magic bytes, the cut-out's decoded alpha, latency, and per-request charges (billing events).

**What was measured without spending:**

| Call | Result |
| --- | --- |
| `POST https://queue.fal.run/{model}` on an account with no balance | `403 {"detail":"User is locked. Reason: Exhausted balance. …"}` at submit — T3 must map it to a describable failure (the debit has already been taken, so it refunds) |
| `GET …/fal-ai/nano-banana-2/requests/<unknown id>/status` | `404 {"status":"NOT_FOUND"}` |
| `GET …/fal-ai/nano-banana-2/requests/<unknown id>` (result) | `404 {"detail":"Request not found"}` |
| `GET …/fal-ai/veo3/requests/<unknown id>/status` (parent path, no `/fast`) | `404 {"status":"NOT_FOUND"}` — the parent path is a valid route; whether a `/fast` job lives there is still unproved |
| `GET https://api.fal.ai/v1/models/pricing?endpoint_id=a,b` with the key | `200 {"prices":[{endpoint_id, unit_price, unit, currency}], "next_cursor":null, "has_more":false}` |
| …the same without a key | `401 {"error":{"type":"authorization_error","message":"API key authentication required"}}` |
| …with an unknown id | `404 {"error":{"type":"not_found","message":"Endpoint(s) not found"}}` |
| `GET https://api.fal.ai/v1/models/billing-events` and `/v1/account/billing` | `403 "This API key is not permitted to perform this action."` — this key cannot read per-request charges; use the dashboard or an admin-scoped key |

**Prices from the pricing API (account-specific, 2026-10-01):**

| fal id | API price | Model page (llms.txt) | Baked |
| --- | --- | --- | --- |
| `fal-ai/nano-banana-2` | $0.08 / images | $0.08; 2K ×1.5, 4K ×2 | 1K 0.08, 2K 0.12, 4K 0.16 |
| `fal-ai/nano-banana-pro` | $0.15 / images | $0.15; 4K ×2 | 1K/2K 0.15, 4K 0.30 |
| `fal-ai/bytedance/seedream/v4.5/text-to-image` | $0.04 / images | $0.04 | 0.04 |
| `fal-ai/bria/background/remove` | $0.018 / generations | $0.018 | 0.018 |
| `fal-ai/kling-video/v3/standard/text-to-video` | **$0.14 / seconds** | $0.084 off, **$0.126 on** | off 0.084, **on 0.14** (higher source wins) |
| `fal-ai/kling-video/v3/pro/text-to-video` | $0.14 / seconds | $0.112 off, $0.168 on | off 0.112, on 0.168 |
| `xai/grok-imagine-video/text-to-video` | $0.05 / seconds | 480p 0.05, 720p 0.07 | 480p 0.05, 720p 0.07 |
| `fal-ai/veo3/fast` | $0.15 / seconds | $0.10 off, $0.15 on | off 0.10, on 0.15 |
| `fal-ai/veo3` | $0.40 / seconds | $0.20 off, $0.40 on | off 0.20, on 0.40 |
| `fal-ai/elevenlabs/sound-effects/v2` | $0.002 / seconds | $0.002/s | per_second 0.002 |
| `fal-ai/elevenlabs/tts/multilingual-v2` | $0.1 / 1000 characters | same | per_1k_chars 0.10 |
| `fal-ai/elevenlabs/tts/turbo-v2.5` | $0.05 / 1000 characters | same | per_1k_chars 0.05 |
| `fal-ai/minimax-music/v2.6` | $0.15 / audios | same | per_request 0.15 |

The API reports ONE price per model: the model's default configuration (Veo and Kling default `generate_audio: true`, which is why Veo's API price is the audio-on price). Kling is the one disagreement: the API says $0.14/s for both Standard and Pro, which matches neither page. The Standard audio-on row ships at the higher $0.14, because a debit is taken before the render and under-quoting is the costly direction. The Pro rows keep the page's prices, since $0.14 sits between them and so is not a per-variant price.

**Inputs the probe will send** (read from each model's llms.txt, 2026-10-01):
- **Images:** nano-banana-2 / pro take `prompt`, `resolution` (`1K`/`2K`/`4K`, plus `0.5K` on nano-banana-2), `aspect_ratio`, `output_format` (`jpeg`/`png`/`webp`, default `png`) and `num_images`. Seedream takes `image_size` (enum such as `auto_2K`, or `{width,height}` with each side 1920–4096), not `aspect_ratio`.
- **Cut-out:** `image_url`. The output is `{image:{url, content_type:"image/png", width, height}}`.
- **Video:** Kling takes `duration` `"3"`–`"15"` (a string), `generate_audio` (default **true**), `aspect_ratio`. Grok takes `duration` 1–15 (an integer) and `resolution` `480p`/`720p`, with no audio switch. Veo takes `duration` `"4s"`/`"6s"`/`"8s"`, `generate_audio` (default **true**) and `resolution` `720p`/`1080p`. All three return `{video:{url}}`.
- **Sound effect:** `text`, `duration_seconds` 0.5–22 (optional; the model picks a length when it is absent), `loop`, `output_format` (default `mp3_44100_128`). Returns `{audio:{url}}`.
- **Speech:** `text`, `voice`. **`voice` is a free string with no enum** in fal's OpenAPI schema (default `Rachel`). The documented names are Rachel (the default), Aria, Roger, Sarah, Laura, Charlie, George, Callum, River, Liam, Charlotte, Alice, Matilda, Will, Jessica, Eric, Chris, Brian, Daniel, Lily and Bill. T6 should offer exactly that list, because an unknown name is only refused at run time (the probe's `invalid-voice` job captures how). Returns `{audio:{url}}`, documented as `.mp3`.
- **Music:** `prompt` (10–2000 chars), `lyrics` (required unless `is_instrumental`), `is_instrumental`. Returns `{audio:{url}}`. The documented example is **`.mp3`**; the probe confirms the container from the bytes.

### Assumptions (Quick Plan)

1. **Sound kinds per gateway:**
   - Comet uses its ElevenLabs routes for sound effects and speech, and Suno for music.
   - fal uses ElevenLabs for sound effects and speech, and MiniMax Music v2.6 for music.

   Every gateway exposes the same three kinds.
2. **Music without callbacks:** music on Comet and fal is polled only, so `MEDIA_CALLBACK_URL` stays a requirement for KIE music only.
3. **Multi-clip results:** when one music submit returns several clips, the first finished one is delivered, as on KIE.
4. **fal is a media-only gateway.** It joins `MEDIA_PROVIDERS` and `MARKET_PRICE_PROVIDERS`, but not `PLATFORM_PROVIDERS`, because it serves no LLM. Its price list holds no `llm` rows, and validation knows that.
5. **Transparency on fal** works like KIE: render, then a priced cut-out pass (`fal-ai/bria/background/remove`), quoted and debited together.
6. **No `FAL_BASE_URL`.** fal has one public host, and `mediaBaseUrlFor` returns `undefined` for fal.
7. **Probe spend:**
   - The live probes spend real money: about $0.20 on Comet and about $1.50 on fal (images, one cut-out, a 4-second video with audio off, a short Veo clip with audio off, a sound effect, a speech line and a song).
   - The owner asked for this feature, which covers it.
   - If a key is missing, that task stops and reports it rather than baking unverified prices.

### SPEC conformance

The plan follows SPEC §4.16 as written:
- media is async: a task is enqueued and polled;
- the debit comes before any spend;
- prices are refused, never guessed;
- one delivery decision covers the quote, the payload and the file path;
- the provider is stamped on the task;
- an absent capability is absent from the tools and the panel, not present and refusing.

It also follows §4.6: price lists are per gateway, versioned and admin-promoted, with a baked fallback; the admin feed is for the operator to read and is never applied automatically.

It changes two rules:
- "music needs a reachable callback" becomes KIE-only;
- "media providers are a subset of LLM providers" is relaxed for media-only fal.

---

## Tasks

### Phase 1 — Prove both gateways and price them

- [ ] **T1** — Live-probe Comet audio and bake Comet's audio prices  ⏭️ DEFERRED (auto-pilot): COMET_API_KEY is blank in .env.local — rows baked from Comet's public feed + docs; run `node scripts/comet-audio-probe.mjs` once a key is set, then tick
  - Files:
    - `scripts/comet-audio-probe.mjs` (create; mirrors `scripts/cache-probe.mjs` / `kie-model-health.mjs`)
    - `app/lib/.server/billing/baked-comet-prices.ts` (modify)
  - Details:
    1. **The probe.** It reads `COMET_API_KEY` from `.env.local`, then makes:
       - one sound effect: 2 s, then the same prompt with no duration;
       - one speech line (`eleven_multilingual_v2`, ~60 characters);
       - one Suno instrumental.

       It polls each one to completion and records:
       - the submit and poll status sequences;
       - the result URL's host, and whether downloading it needs the bearer key;
       - `Content-Type`, plus a decode of the first bytes;
       - how many clips each Suno submit returns;
       - the `mv` value that worked;
       - latency;
       - the charge Comet reports (balance before and after, or the dashboard).

       It writes a results table into this plan's Codebase Analysis.
    2. **Comet audio rows** in `baked-comet-prices.ts`, priced from the probe:
       - `eleven_text_to_sound_v2`: `per_second` if the probe confirms it; otherwise `per_request`, with a separate no-duration row;
       - `eleven_multilingual_v2` and `eleven_v3`: `per_1k_chars`;
       - `suno_music`: `per_request`, $0.144.

       Every row applies Comet's `pricing × ratio` rule. The Suno row is commented as hand-maintained, because Comet's feed has no Suno rows.
  - Tests:
    - `comet-prices.spec.ts`:
      - `prices every Comet audio row` → `lookupMediaPrice` resolves all three kinds in the units the probe chose;
      - `refuses a sound effect with no duration when only per_second is priced` → null (only if `per_second` was chosen).
  - Acceptance:
    - The probe runs end to end and its table is in this file.
    - Comet's baked list prices all three sound kinds, and each row cites the probe or Comet's published page.
  - Verify level: standard

- [ ] **T2** — Live-probe fal, give fal a media-only price list, and add the admin feed  ⏭️ DEFERRED (auto-pilot): fal returned 403 "Exhausted balance" on every submit ($0 spent) — code + baked prices done; top up fal, run `node scripts/fal-media-probe.mjs`, check the findings against T3–T4, then tick
  - Files:
    - `scripts/fal-media-probe.mjs` (create)
    - `app/lib/.server/billing/baked-fal-prices.ts` (create)
    - `app/lib/.server/billing/market-price-store.ts` (modify)
    - `app/lib/.server/billing/market-prices.ts` (modify)
    - `app/lib/.server/billing/market-feed.ts` (modify)
    - `app/routes/api.admin.market-prices.ts` (modify)
    - `app/components/@settings/tabs/admin/MarketPricesSection.tsx` (modify)
  - Details:
    1. **The probe** reads `FAL_API_KEY` from `.env.local`. For every model in the fal table above, except `veo3` and `kling…/pro`, which cost the same shape as their siblings, it submits one small job through the queue REST API, never `sync_mode`. Settings: images at 1K, video at 4 s with audio off, a 3 s sound effect, a ~60-character speech line, and an instrumental song. It also:
       - submits one deliberately invalid job, to capture the failure shape;
       - runs the cut-out on the probe's own image output.

       It records:
       - the exact `status_url` / `response_url` / `request_id` values, and **the exact relation between `response_url` and the status URL** (T3 relies on it);
       - the status sequence;
       - the failed-job status body, and what the result GET returns for a failed job;
       - each result JSON shape and the field the file URL lives in;
       - whether file URLs download without the key;
       - `Content-Type` and first bytes (JPEG, PNG, MP4 or MP3);
       - **the cut-out's real alpha**: decode the PNG and report the share of fully transparent pixels — never trust the container;
       - latency;
       - the charge (`/v1/models/pricing` and the dashboard).

       It writes a results table into this plan.
    2. **A media-only price list.**
       - Add `'FAL'` to `MARKET_PRICE_PROVIDERS`, with storage key `'fal'` and baked list `BAKED_FAL_PRICES`.
       - `validateMarketPrices(value, provider)` gains a per-provider rule: for a media-only provider (a `MEDIA_ONLY_PRICE_PROVIDERS = ['FAL']` record), `llm` must be `{}`, and the "price at least one model" and "price the platform default" rules are skipped. Every other provider keeps both rules unchanged.
       - Every caller (`promoteMarketPrices`, `loadVersion`, the admin route) passes the provider.
    3. **`baked-fal-prices.ts`**: one row per id in the fal table above.
       - Kinds: image, video, audio.
       - Units: `per_request` for images, the cut-out, music and the per-request sound effect if the probe says so; `per_second` for video and sound effects; `per_1k_chars` for speech.
       - Variants:
         - image `resolution` 1K / 2K / 4K for the nano-banana rows;
         - video `generate_audio` true / false (and `resolution` for grok);
         - the cut-out as its own row.
       - Each row cites the model's `llms.txt` URL and the probe. `capturedAt` is the probe date. The source says "fal list price; account-specific discounts may apply".
    4. **Admin feed:**
       - `fetchFalMarketFeed(apiKey, { filter })` calls `GET https://api.fal.ai/v1/models/pricing?endpoint_id=…` with the ids from the active fal list, in batches of 50. It returns the same row shape the panel already renders for Comet.
       - The route dispatches on provider `'FAL'` and uses `FAL_API_KEY`. A missing key is a describable "not configured" error.
       - The panel's provider picker shows FAL. The feed is for the operator to read and is never applied.
  - Tests:
    - `market-prices.spec.ts`:
      - `accepts a media-only FAL list with an empty llm table` → ok;
      - `refuses a FAL list that carries llm rows` → an error naming FAL as media-only;
      - `still refuses a KIE list with no llm rows` → the existing error (control).
    - `market-price-store.spec.ts`:
      - `promotes and loads a FAL list under its own key` → stored at `fal`; KIE and Comet are untouched;
      - `serves the baked FAL list when nothing is promoted`.
    - `fal-prices.spec.ts` (create):
      - `prices every fal row in the plan table` → `lookupMediaPrice` resolves each in its unit and variants;
      - `a 4K nano-banana-2 costs twice the 1K row`;
      - `kling v3 standard with audio costs 0.126/s`.
    - `market-feed.spec.ts`, or the existing feed spec:
      - `fetchFalMarketFeed sends Key auth and batches endpoint ids` → stubbed fetch, with the header and URL asserted.
  - Acceptance:
    - The probe ran, and its table, including the cut-out's measured transparency, is in this file.
    - The fal list validates and is served baked.
    - KIE and Comet lists validate exactly as before.
    - The admin panel can show FAL's list and fetch its feed.
    - If `FAL_API_KEY` is missing, the task stops and reports that.
  - Verify level: standard

### Phase 2 — fal renders images, transparent images and video

- [x] **T3** — The fal client and gateway: images and video end to end in the server, the agent tools and the panel
  - Files:
    - `app/lib/.server/media/provider.ts` (modify)
    - `app/lib/.server/media/fal-client.ts` (create)
    - `app/lib/media/fal-routes.ts` (create; client-safe)
    - `app/lib/.server/agent/config.ts` (modify)
    - `app/lib/media/image-capabilities.ts` (modify)
    - `app/lib/media/provider-defaults.ts` (modify)
    - `app/lib/.server/media/service.ts` (modify)
    - `app/components/media/MediaPanel.tsx` (modify)
    - `app/routes/api.me.ts` and `MediaButton.tsx` (modify only if their provider type is a literal union)
    - `.env.example` (modify)
  - Details:
    1. **Registration.**
       - `MEDIA_PROVIDERS = ['KIE','Comet','FAL']`, with `MEDIA_KEY_ENV.FAL = 'FAL_API_KEY'`.
       - `ImageProviderName` gains `'FAL'`.
       - `PLATFORM_PROVIDERS` is unchanged. Rewrite the "strict subset" comment, and the spec that asserts it, as: every media provider is either a platform provider or listed in a `MEDIA_ONLY_PROVIDERS = ['FAL']` constant.
       - `getMediaProvider` accepts `FAL` (case-insensitive, like the others). Because fal is never an LLM provider, `MEDIA_PROVIDER=FAL` is the only way to select it.
       - Add `FAL_API_KEY=` with a one-line comment to `.env.example`.
    2. **Endpoint.** Append `'fal-queue'` to `MediaEndpoint`; never rename existing values. `endpointFor` gets a `'FAL'` case that returns `'fal-queue'` for every model, sound included.
    3. **`fal-routes.ts`** is the single place a priced fal id maps to its submit path and payload family: `image-nano`, `image-seedream`, `cutout`, `video-kling`, `video-grok`, `video-veo`, `sfx`, `tts`, `music-minimax`. The table is keyed by the price-list id, and both the service and the panel read it.
    4. **`FalMediaProvider`** (`name: 'FAL'`, `Authorization: Key <key>`):
       - **`create`:** `POST https://queue.fal.run/{model}` with the payload. It returns `response_url` as the provider task id. Refuse with a describable error when the response has no `response_url`, or it is not under `https://queue.fal.run/`.
       - **`query`** refuses any task id not under `https://queue.fal.run/` (an SSRF wall, because the id is read back from storage). Then:
         - GET the status URL, derived from `response_url` exactly as T2 recorded;
         - `IN_QUEUE` / `IN_PROGRESS` → `pending`;
         - `COMPLETED` with `error` → `failed`, with that text plus `error_type`;
         - `COMPLETED` → GET `response_url` and extract the file URL with one exported function, `falResultUrl(json)`. It handles `images[0].url`, `image.url`, `video.url`, `audio.url`, `audio` as a string, and `audio_file.url`. A result with no URL → `failed`.
         - A network error or 5xx throws, which the service already treats as a flaky poll, never as a failure.
       - **`download`:** a plain GET, unless T2 found that file URLs need the key.
       - `mediaProviderFor` gets `case 'FAL'`.
    5. **Payloads.** `buildProviderPayload` branches to a new `buildFalPayload(model, request, delivery)`:
       - Never sets `sync_mode`.
       - **Images:** `prompt`, `num_images: 1`, `aspect_ratio`, and `resolution` for nano-banana. Seedream maps `aspect_ratio` to an `image_size` preset through a small table. `output_format` comes from the delivery decision (jpeg or png).
       - **Video:**
         - `prompt`, `aspect_ratio` and `generate_audio` (default false; the price row's variant must match);
         - duration in the shape each family wants, from `fal-routes.ts`: kling `"5"`, veo `"8s"`, grok an integer;
         - grok also takes `resolution`.
    6. **Defaults.** `DEFAULTS.FAL`:
       - `image: 'fal-ai/nano-banana-2'`
       - `video: 'fal-ai/kling-video/v3/standard/text-to-video'`
       - `googleVideo: 'fal-ai/veo3/fast'`
       - `videoAlternatives`: names kling v3 pro and grok-imagine
       - fal-specific `videoModeHint` / `videoResolutionHint`, or `''` where there is no such knob
       - `sound: null` until T6
    7. **`isGoogleVideoModel`** matches a `veo<digit>` **path segment** anywhere in the id, so `fal-ai/veo3/fast` and `fal-ai/veo3` count as Google video. `veo3_fast` and `veo3-fast` still match; `kling…` and `grok…` do not.
    8. **Panel.** `modelsForProvider` takes `ImageProviderName | null` and returns fal's image and video lists (sound in T7).
  - Tests:
    - `fal-client.spec.ts` (create; same fetch-stub pattern as `comet-client.spec.ts`):
      - `submits to queue.fal.run with Key auth and returns response_url`;
      - `polls the status URL derived from response_url, never one rebuilt from the model id` → for a `fal-ai/veo3/fast` job, the URL has no `/fast/requests`;
      - `COMPLETED with error is failed, not succeeded`;
      - `IN_QUEUE and IN_PROGRESS are pending`;
      - `a 503 on status throws (flaky poll)`;
      - `falResultUrl reads images, image, video, audio object, audio string and audio_file` → six cases;
      - `refuses a task id outside queue.fal.run` → throws; no fetch is made;
      - `never sends sync_mode`.
    - `media-provider.spec.ts`:
      - `routes every FAL model to fal-queue`;
      - `a FAL task is polled by FAL after MEDIA_PROVIDER changes back to KIE`.
    - `provider-defaults.spec.ts`: the existing "every default is priced in its provider's baked list" case passes for FAL. `isGoogleVideoModel` → true for `fal-ai/veo3/fast` and `fal-ai/veo3`; false for `fal-ai/kling-video/v3/standard/text-to-video`.
    - `media.spec.ts`, with `FakeProvider` named `'FAL'`:
      - `quotes, debits and creates a fal image, then delivers it`;
      - `generate_video with no model on FAL uses kling, never veo`;
      - `a failed fal render refunds exactly once`.
    - The config spec (where `MEDIA_PROVIDERS` is asserted against `PLATFORM_PROVIDERS` and `MARKET_PRICE_PROVIDERS`):
      - `every media provider is a platform provider or media-only`;
      - `MEDIA_PROVIDER=fal selects FAL and reads FAL_API_KEY`.
  - Acceptance:
    - On `MEDIA_PROVIDER=FAL`, `generate_image`, `generate_video`, `generate_google_video` and the panel's Image and Video tabs create, debit, poll and deliver against stubbed fal responses shaped like T2's probe output.
    - KIE and Comet behaviour is unchanged (their existing tests pass).
    - No new `=== 'KIE'` / `=== 'Comet'` / `=== 'FAL'` ternary.
  - Verify level: standard

- [x] **T4** — Transparent images on fal: the cut-out pass becomes per gateway
  - Files:
    - `app/lib/media/image-capabilities.ts` (modify)
    - `app/lib/.server/media/service.ts` (modify)
    - `app/components/media/MediaPanel.tsx` (modify only if it reads `CUTOUT_MODEL`)
  - Details:
    1. Replace `hasCutoutPass(provider) === (provider === 'KIE')` with one exported record:

       `CUTOUT_MODEL_BY_PROVIDER: Record<ImageProviderName, string | null> = { KIE: 'recraft/remove-background', Comet: null, FAL: 'fal-ai/bria/background/remove' }`

       `hasCutoutPass` and `supportsTransparency` read it. `CAPABILITIES.FAL = {}` (no native-alpha model is used on fal).
    2. In `service.ts`, `CUTOUT_MODEL` becomes `cutoutModelFor(provider)`, used by:
       - the quote (`cutoutAvailable`, the combined price);
       - the "is not a model you generate with" refusal, which now checks all three ids;
       - the poll-path chain.

       The chain creates the cut-out through `cutoutTaskFor(provider, renderUrl)`:
       - KIE: `{endpoint: 'jobs', payload: {image}}`, byte-identical to today;
       - FAL: `{endpoint: 'fal-queue', model: cutout id, payload: {image_url}}`.

       Comet keeps refusing nothing, because it resolves transparency to its native-alpha model.
    3. The stage-1 render for a transparent request on fal is asked for as jpeg, with the same flat-backdrop prompt directive KIE uses, because the alpha comes from stage 2.
  - Tests:
    - `image-capabilities.spec.ts`:
      - `FAL supports transparency through a cut-out pass`;
      - `Comet has no cut-out pass` (control).
    - `media.spec.ts`:
      - `a transparent fal image quotes render + cut-out together, debits once, chains bria on the poll and delivers the cut-out` → the second create has `payload.image_url` equal to the render URL;
      - `a fal cut-out that cannot start fails and refunds in full`;
      - `KIE's cut-out payload is unchanged` (control: `{image}` on `'jobs'`).
  - Acceptance:
    - A transparent request on fal runs as one task with one debit and two stages, and delivers a PNG.
    - An opaque render is never delivered in its place.
    - KIE's transparency path is byte-identical.
  - Verify level: standard

### Phase 3 — Sound on all three gateways

- [ ] **T5** — Comet audio routes in the Comet client
  - Files:
    - `app/lib/.server/media/provider.ts` (modify)
    - `app/lib/.server/media/comet-client.ts` (modify)
  - Details:
    1. Append `'comet-sound'`, `'comet-speech'` and `'comet-music'` to `MediaEndpoint`.
    2. Derive `host` from the base URL with a trailing `/v1` removed. `COMET_BASE_URL` still overrides it.
    3. **`create`:**
       - `comet-sound` → `POST {host}/runwayml/v1/sound_effect`;
       - `comet-speech` → `POST {host}/runwayml/v1/text_to_speech`;
       - `comet-music` → `POST {host}/suno/submit/music`, with **no `notify_hook`**.
    4. **`query`:**
       - `comet-sound` / `comet-speech` → `GET {host}/runwayml/v1/tasks/{id}`:
         - `SUCCEEDED` → `output[0]`;
         - `FAILED` / `CANCELLED` → `failed`;
         - `PENDING` / `THROTTLED` / `RUNNING`, a missing status, or 400 `task_not_exist` → `pending`.
       - `comet-music` → `GET {host}/suno/fetch/{id}`:
         - the first finished clip with a non-empty `audio_url` → `succeeded`;
         - a status T1 recorded as a terminal failure → `failed`, with `fail_reason`;
         - otherwise `pending`.
    5. `download` stays a plain GET, unless T1 found that audio URLs need the key.
  - Tests (`comet-client.spec.ts`):
    - `posts a sound effect to /runwayml/v1/sound_effect with promptText, duration and loop` → no `/v1/v1` in the URL;
    - `posts speech with a runway-preset voice`;
    - `submits music without notify_hook`;
    - `maps runway statuses, including task_not_exist → pending`;
    - `delivers the first finished Suno clip, and stays pending while audio_url is empty`;
    - `refuses a KIE sound endpoint`.
  - Acceptance: the Comet client creates, polls and downloads all three sound kinds against stubbed responses shaped like T1's probe output.
  - Verify level: standard

- [ ] **T6** — Make sound provider-aware on all three gateways: models, validation, payloads, the music rule, the tool and the prompt note
  - Files:
    - `app/lib/media/provider-defaults.ts` (modify)
    - `app/lib/media/sound-request.ts` (modify)
    - `app/lib/.server/media/service.ts` (modify)
    - `app/lib/.server/agent/media-tools.ts` (modify)
    - `app/lib/.server/agent/media-note.ts` (modify)
    - `app/lib/.server/agent/config.ts` (modify: `requireMediaKey` wording)
  - Details:
    1. **Model ids.** `SOUND_MODELS` becomes a per-provider record `Record<ImageProviderName, { effect, music, speech: string[], voices, musicOptions }>`:
       - KIE: today's values, byte-identical;
       - Comet: T1's ids, voices = the runway preset names, `mv` from T1;
       - FAL: `fal-ai/elevenlabs/sound-effects/v2`, `fal-ai/minimax-music/v2.6`, `[fal-ai/elevenlabs/tts/multilingual-v2, fal-ai/elevenlabs/tts/turbo-v2.5]`, voices = the ElevenLabs names T2 confirmed, no version option.

       `soundKindForModel(model)` checks every provider's ids through that record. Never use `=== 'KIE'` ternaries.
    2. **Defaults.** `DEFAULTS.Comet.sound` and `DEFAULTS.FAL.sound` are set from that record.
    3. **Validation.** `validateSoundRequest(args, provider)` checks against the provider's models, voices and music options, and still returns sentences when it refuses. On fal, sound-effect duration is capped at 22 s and the refusal names the limit.
    4. **`service.ts`:**
       - `cometEndpointFor` maps sound kinds to T5's endpoints;
       - `buildCometPayload` builds the three Comet bodies: `prompt`→`promptText`, duration→`duration`, voice→`{type:'runway-preset', presetId}`, and music→`{prompt, tags, title, mv, make_instrumental, generation_type:'TEXT', metadata:{create_mode:'custom'}}`;
       - `buildFalPayload` builds the three fal bodies: sound effect `{text, duration_seconds, loop}`; speech `{text, voice}`; music `{prompt, lyrics?, is_instrumental}`;
       - the music refusal (:254-264) applies only when the provider is KIE;
       - the quote passes `textChars` for speech, which the `per_1k_chars` rows need;
       - `deriveDestPath` keeps `.mp3`, unless T1/T2 found a gateway returns WAV; then the extension comes from the same delivery decision for that model.
    5. **The agent tool.** `generate_sound`'s schema and description text come from the provider's record, so the cached prompt never shows KIE names on Comet or fal.
    6. **The prompt note.** `media-note.ts` names `generate_sound` only when `defaults.sound` is non-null.
    7. **Missing key.** `requireMediaKey` says "media generation".
  - Tests:
    - `sound-request.spec.ts`:
      - `accepts Comet ids and runway voices for Comet`;
      - `accepts fal ids and ElevenLabs voices for FAL`;
      - `refuses a KIE voice on Comet with a sentence naming valid voices`;
      - `refuses a 30 s fal sound effect naming the 22 s limit`.
    - `media.spec.ts`:
      - `quotes, debits and creates a Comet sound effect, then delivers it as .mp3`;
      - `the same on FAL`;
      - `Comet and FAL music need no MEDIA_CALLBACK_URL`;
      - `KIE music still refuses without a reachable callback` (control);
      - `speech is quoted per 1k chars on FAL`;
      - `a failed Comet or FAL sound refunds exactly once`.
    - `media-tools.spec.ts`:
      - `generate_sound is offered on Comet and FAL with that gateway's voices and no KIE ids in its text`.
    - The `media-note` test:
      - `does not name generate_sound when the gateway has no sound`, using a stub defaults table with `sound: null`.
  - Acceptance:
    - On each gateway, the agent tool and the server create, debit, poll and deliver all three sound kinds.
    - KIE's sound behaviour is unchanged (existing KIE sound tests pass).
    - No provider-name ternary is added.
  - Verify level: standard

### Phase 4 — The Media panel on every gateway, proved live, and SPEC

- [ ] **T7** — The Sound tab on every gateway, and a live run of fal and Comet end to end
  - Files:
    - `app/components/media/MediaPanel.tsx` (modify)
    - `app/components/media/media-panel-fields.spec.tsx` (modify)
  - Details:
    1. Replace `SOUND_MODELS_SPEC` ("KIE only") with fields built from T6's per-provider sound record: model list, voice list and music options. `modelsForProvider('audio', provider)` returns that provider's list.
    2. The price on Generate comes from the same quote action as today.
  - Tests (`media-panel-fields.spec.tsx`):
    - `shows the Sound tab on Comet with Comet voices`;
    - `shows the Sound tab on FAL with ElevenLabs voices and fal image/video models`;
    - `still shows KIE's sound fields on KIE`;
    - `hides the Sound tab when the gateway has no sound models` (control, stub table).
  - Acceptance (live, one session per gateway):
    1. With `MEDIA_PROVIDER=FAL` and the dev server restarted, use the Media panel to generate:
       - one opaque image and one **transparent** image (decode the delivered PNG: most pixels outside the subject are fully transparent);
       - one 4-second video with audio off;
       - one sound effect, one speech line and one music track.

       Each file lands in `public/assets/generated/` and plays or renders in the browser, and the balance drops by exactly the quoted amount. An invalid request that fal accepts and then fails is refunded.
    2. In one fal chat turn ("add a coin pickup sound, short background music and a transparent coin icon"), the agent calls `generate_sound` and `generate_image` with transparency, and the files appear.
    3. With `MEDIA_PROVIDER=Comet`, generate one sound effect, one speech line and one music track from the Sound tab, with the same checks.
    4. Switching back to `MEDIA_PROVIDER=KIE` still shows KIE's tabs. A task started on fal before the switch still completes and delivers.
    5. If a key is missing where this runs, report that and run the steps for that gateway against stubbed providers.
  - Verify level: live

- [ ] **T8** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details: following SPEC.md's "How to update this spec":
    - **§4.16:**
      - the gateway list becomes KIE, Comet and fal;
      - the heading's "sound … (KIE only)" becomes all three gateways;
      - fal's queue shape and its two-stage transparency;
      - Comet's and fal's sound routes, and polling-only music;
      - the callback rule scoped to KIE.
    - **§4.6:** fal's media-only price list and its admin feed.
    - **Decisions:**
      - **Higgsfield evaluated and rejected 2026-09-30** (no standalone audio in its public API);
      - **fal added 2026-10-01** as a media-only gateway.

    Record the product only, never verification procedure.
  - Acceptance:
    - SPEC.md matches T1–T7.
    - Nothing in it says sound is KIE-only, or that media providers must also serve an LLM.
    - Both decisions and their reasons are recorded.
  - Verify level: standard

---

## Estimated execution time

| Phase | Tasks | What makes it slow | Estimate |
| --- | --- | --- | --- |
| 1 — Probe and price | T1, T2 | Real gateway latency (music and video take minutes); the media-only price-list rule touches validation | ~45 min |
| 2 — fal images, video, transparency | T3, T4 | T3 registers a new gateway across about ten files and writes the queue client | ~45 min |
| 3 — Sound everywhere | T5, T6 | T6 touches six files across the shared validator and the tool text, for three gateways | ~45 min |
| 4 — Panel, live, SPEC | T7, T8 | One live session per gateway generating real media | ~45 min |

**Total ≈ 2 h 15 min – 4 h 15 min.** That is 8 tasks × 17 min plus 4 phases × 10 min, plus one 20-minute fix round for the probes' genuine unknowns, ±30 %. With `--strict`, multiply by 2–3.

Biggest uncertainty: whether fal's background removal returns real alpha, and how its status URL relates to `response_url`. T2 settles both before any client code is written.

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- bt-execute verifies each phase with an independent verifier; add `--strict` for an adversarial verifier on every task.
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
