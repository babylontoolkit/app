# Media gateways — fal.ai beside KIE, sound on both, Comet removed

**Goal.** KIE and fal.ai become interchangeable media gateways, chosen by `MEDIA_PROVIDER` (`KIE` | `FAL`). Each one serves:
- **images**, including transparent ones;
- **video** (`generate_video` plus the separate `generate_google_video` for Veo);
- **sound**: sound effects, music and speech through `generate_sound` and the Media panel's Sound tab.

Every render is priced, debited before anything is spent, polled, and delivered into `public/assets/generated/`. If one gateway has an outage, the owner switches gateways with one environment variable.

**Comet is removed as a media gateway.** No render goes to Comet, no Comet media price is quoted, and `MEDIA_PROVIDER=Comet` is refused.

**Owner decisions:**
- *2026-09-30:* Anthropic is the only LLM provider. **Higgsfield is dropped**: its public REST API has no standalone sound, music or speech model (details below).
- *2026-10-01:* add **fal.ai** as a media gateway with the same capabilities as KIE. The fal key is the owner's existing `FAL_API_KEY` in `.env.local`.
- *2026-10-01:* **Comet is removed from media entirely.** The owner no longer trusts Comet because of a security issue. KIE and fal are the only media gateways, and both get sound.
- *2026-10-01:* this plan replaces `_specs/comet-sound_plan.md`, which was never executed and is now void.

**Out of scope:** Comet's LLM wiring (`PLATFORM_PROVIDERS`, the LLM price list, the provider ladder). This plan covers media only.

---

## Codebase Analysis

**Mode:** Quick Plan (no spec file). The owner's messages answer the scope, so there was no interview.
- `spec_impact: yes` (SPEC §4.16 and §4.6's price lists change).
- `size: medium`, inferred. 7 tasks: one gateway is added, one is removed, and sound is extended to the new one.
- `proof: functional`.

### Why Higgsfield is out (checked 2026-09-30)

Four sources agree that the public API serves only images and video:
- the price list (https://open.higgsfield.ai/) has no audio category;
- the OpenAPI spec (https://docs.higgsfield.ai/docs/openapi.json) has six generation paths, all image or video;
- the model catalogue (https://docs.higgsfield.ai/docs/models.md) lists 16 image and 66 video models;
- the JS SDK uses audio only as an input.

Seed Audio and its text-to-speech exist only in Higgsfield's CLI and web app, which need a browser login.

### What exists and is reused

All paths are relative to the repo root. This describes the code before T3/T4. T3/T4 (done) added fal, and T1 removes Comet.

- **The seam** (`app/lib/.server/media/provider.ts`):
  - `MediaProvider { name, create, query, download }`.
  - `MediaEndpoint` is **persisted on task records**, so values may be added and never renamed or removed. It holds `'jobs' | 'veo' | 'suno-sounds' | 'suno-music' | 'comet-image' | 'comet-gemini-image' | 'comet-video'` (+ `'fal-queue'` since T3). The three `comet-*` values stay in the type so old records still parse; nothing creates them after T1.
  - The one factory is `mediaProviderFor(name, apiKey, baseUrl)`, an exhaustive switch.
  - The provider is stamped on each task record, so polling asks the gateway that created the task, even if `MEDIA_PROVIDER` has since changed (`mediaProviderOf`).
- **Provider lists** (`app/lib/.server/agent/config.ts`):
  - `PLATFORM_PROVIDERS = ['Anthropic','KIE','Comet']` and `MEDIA_PROVIDERS` (`['KIE','Comet','FAL']` after T3; `['KIE','FAL']` after T1).
  - `MEDIA_KEY_ENV` maps each gateway to its key variable.
  - `getMediaProvider` reads `MEDIA_PROVIDER` and otherwise falls back to the LLM provider.
  - `mediaBaseUrlFor` (a record since T3) and `requireMediaKey` (which says "image/video generation").
- **Client-safe tables:**
  - `ImageProviderName` (`app/lib/media/image-capabilities.ts`).
  - `CAPABILITIES`: KIE has no native-alpha model, and Comet's was `gpt-image-1.5` (removed by T1).
  - `CUTOUT_MODEL_BY_PROVIDER` (T4): KIE `recraft/remove-background`, FAL `fal-ai/bria/background/remove`.
  - `DEFAULTS: Record<ImageProviderName, MediaModelDefaults>` (`app/lib/media/provider-defaults.ts`). FAL has `sound: null` until T6.
  - `SOUND_MODELS` and `soundKindForModel` know **KIE ids only**.
- **Service** (`app/lib/.server/media/service.ts`):
  - `endpointFor` and `buildProviderPayload` are exhaustive per-provider switches (`buildKiePayload`, `buildFalPayload`, and `buildCometPayload` until T1).
  - fal sound models are priced but refused before debit by `ROUTE_REFUSAL` until T6.
  - `buildSoundPayload` builds KIE-only bodies.
  - The music refusal (no reachable `MEDIA_CALLBACK_URL`) applies to every provider and names KIE.
  - `deriveDestPath` gives audio the `.mp3` extension.
  - **No gateway takes reference images today** (KIE sends `image_input: []`), so fal uses only its text-to-image and text-to-video routes.
- **The provider task id** field on `MediaTaskRecord` is named `kieTaskId` for historical reasons (`store.ts`). It holds any gateway's id. Do not rename it, because records persist.
- **Price lists:**
  - `MARKET_PRICE_PROVIDERS = ['KIE','Comet','Anthropic','FAL']`; FAL is media-only (`MEDIA_ONLY_PRICE_PROVIDERS`, T2) and `LLM_PRICE_PROVIDERS` excludes it.
  - Comet's list (`baked-comet-prices.ts`) holds its LLM rows **and** media rows: image, video, and the audio rows plus `COMET_AUDIO_PROVENANCE` added earlier in this run. T1 removes the media rows and leaves the LLM rows.
  - `lookupMediaPrice` (`market-prices.ts`) supports units `per_request`, `per_second` and `per_1k_chars`. It refuses rather than guessing.
- **Comet media code T1 removes:**
  - `app/lib/.server/media/comet-client.ts` + `comet-client.spec.ts`, including the parked-render map and `PENDING_RENDER_TTL_MS`;
  - the Comet branches in `provider.ts`, `service.ts`, `output-format.ts`, `image-capabilities.ts`, `provider-defaults.ts`, `media-tools.ts`, `MediaPanel.tsx`, `api.me.ts` and `app/lib/stores/session.ts`;
  - `scripts/comet-audio-probe.mjs`.
- **Dispatch queue** (`dispatch.ts`): serialises `provider.create` with spacing and retries. It wraps any provider unchanged.
- **Client:** `MediaPanel.tsx`:
  - `modelsForProvider(kind, provider)` reads a `CATALOGUES` record (T3) and returns sound models for KIE only;
  - the Sound tab appears only when its list is non-empty.
- **Agent side:**
  - `media-tools.ts` builds `generate_sound` only when `defaults.sound` is non-null. Its prose is KIE-specific.
  - `generate_google_video`'s description promises "720p, 1080p or 4k" on every gateway, but fal drops 4k (T6 fixes this).
  - `media-note.ts` always names `generate_sound`, even where the tool is absent (an existing defect, fixed in T6).
- **Tests to mirror:**
  - `fal-client.spec.ts`: a fetch stub with `seen[]` and a `responder`;
  - `media.spec.ts`: `FakeProvider`, quoting, poll and refund;
  - `media-provider.spec.ts`: endpoint routing;
  - `provider-defaults.spec.ts`: every default must be priced in its own provider's baked list;
  - `sound-request.spec.ts`, `media-tools.spec.ts`, `media-panel-fields.spec.tsx`, `media-config.spec.ts`.

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
  - It gives one base price per model. Resolution, audio and duration multipliers appear only in each model's prose, so the variant rows are curated by hand.
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
   - KIE keeps today's models.
   - fal uses ElevenLabs for sound effects and speech, and MiniMax Music v2.6 for music.

   Both gateways expose the same three kinds.
2. **Music without callbacks:** music on fal is polled only, so `MEDIA_CALLBACK_URL` stays a requirement for KIE music only.
3. **fal is a media-only gateway.** It is in `MEDIA_PROVIDERS` and `MARKET_PRICE_PROVIDERS`, but not in `PLATFORM_PROVIDERS`, because it serves no LLM. Its price list holds no `llm` rows, and validation knows that.
4. **Transparency on fal** works like KIE: render, then a priced cut-out pass (`fal-ai/bria/background/remove`), quoted and debited together.
5. **No `FAL_BASE_URL`.** fal has one public host.
6. **Comet tasks already on record** are never sent back to Comet. The next poll ends them as failed, with a sentence saying Comet is no longer a media gateway, and refunds them exactly once. `MEDIA_PROVIDER` has been `KIE` in practice, so there should be none, but the poll path must not depend on that.
7. **`MEDIA_PROVIDER=Comet` is refused**, never silently ignored. The refusal is a describable not-configured error naming `KIE` and `FAL`. If `MEDIA_PROVIDER` is unset and the LLM provider is Comet, the media fallback is KIE and never Comet.
8. **Probe spend:**
   - The fal probe spends real money: about $1.50 (images, one cut-out, a 4-second video with audio off, a short Veo clip with audio off, a sound effect, a speech line and a song).
   - The owner asked for this feature, which covers it.
   - It cannot run until the fal account is topped up (see the probe results above).

### SPEC conformance

The plan follows SPEC §4.16 as written:
- media is async: a task is enqueued and polled;
- the debit comes before any spend;
- prices are refused, never guessed;
- one delivery decision covers the quote, the payload and the file path;
- the provider is stamped on the task;
- an absent capability is absent from the tools and the panel, not present and refusing.

It also follows §4.6: price lists are per gateway, versioned and admin-promoted, with a baked fallback; the admin feed is for the operator to read and is never applied automatically.

It changes three rules:
- the media gateways become KIE and fal, and Comet is no longer one;
- "music needs a reachable callback" becomes KIE-only;
- "media providers are a subset of LLM providers" is relaxed for media-only fal.

---

## Tasks

### Phase 1 — Remove Comet, and prove and price fal

- [x] **T1** — Remove Comet as a media gateway
  - Files:
    - `app/lib/.server/agent/config.ts` (modify)
    - `app/lib/.server/media/provider.ts` (modify)
    - `app/lib/.server/media/comet-client.ts` + `comet-client.spec.ts` (delete)
    - `app/lib/.server/media/service.ts` (modify)
    - `app/lib/media/image-capabilities.ts`, `provider-defaults.ts`, `output-format.ts` (modify)
    - `app/lib/.server/agent/media-tools.ts` (modify)
    - `app/components/media/MediaPanel.tsx`, `app/routes/api.me.ts`, `app/lib/stores/session.ts` (modify)
    - `app/lib/.server/billing/baked-comet-prices.ts` (modify: media rows only)
    - `scripts/comet-audio-probe.mjs` (delete)
    - `.env.example` (modify)
    - every spec that asserts Comet media behaviour (modify)
  - Details:
    1. **Registration.**
       - `MEDIA_PROVIDERS = ['KIE','FAL']`, and `ImageProviderName = 'KIE' | 'FAL'`.
       - Remove the Comet entries from `MEDIA_KEY_ENV`, `mediaBaseUrlFor` and every `Record<ImageProviderName, …>` table: `CAPABILITIES` (`gpt-image-1.5`'s native alpha goes), `CUTOUT_MODEL_BY_PROVIDER`, `DEFAULTS`, the panel's `CATALOGUES`, and the image/video option switches.
       - `getMediaProvider` refuses `MEDIA_PROVIDER=Comet` (case-insensitive) with a describable not-configured error naming `KIE` and `FAL`. If `MEDIA_PROVIDER` is unset, the LLM-provider fallback goes to KIE whenever that provider is not a media gateway, Comet included.
       - `.env.example`: the `MEDIA_PROVIDER` comment lists `KIE | FAL`.
    2. **Client and payloads.**
       - Delete `comet-client.ts` and its spec, along with the parked-render map.
       - Remove the factory's `case 'Comet'`, `buildCometPayload`, `cometEndpointFor`, and the Comet branches in `output-format.ts` and `media-tools.ts`.
       - `MediaEndpoint` keeps its three `comet-*` values, because they are persisted. Nothing creates them.
    3. **Comet tasks already on record.**
       - A task stamped `Comet` is never sent to Comet.
       - Its next poll ends it as `failed` with the sentence "Comet is no longer a media gateway; this render was refunded.", and refunds it exactly once through the existing refund latch.
       - Put this in one place: a provider resolution that returns a refusing stand-in for `Comet`, or a guard before `query`.
    4. **Prices.**
       - Remove Comet's **media** rows from `baked-comet-prices.ts`: image, video, and the audio rows with `COMET_AUDIO_PROVENANCE`.
       - Comet's LLM rows and `COMET_PRICE_PROVENANCE` stay; Comet as an LLM gateway is out of scope.
       - Update `comet-prices.spec.ts` to match.
    5. Delete `scripts/comet-audio-probe.mjs`.
  - Tests:
    - `media-config.spec.ts`:
      - `MEDIA_PROVIDER=Comet is refused, naming KIE and FAL`;
      - `LLM_PROVIDER=Comet with no MEDIA_PROVIDER falls back to KIE, never Comet`;
      - `MEDIA_PROVIDERS is exactly KIE and FAL`.
    - `media.spec.ts`:
      - `a stored Comet task fails and refunds exactly once, and nothing contacts Comet` → the refusing stand-in records zero calls, and the balance is back in full after two polls.
    - `no-comet-media.spec.ts` (create): a comment-stripped source scan of `app/lib/media/**`, `app/lib/.server/media/**`, `media-tools.ts`, `media-note.ts` and `app/components/media/**`. It finds no `Comet` / `comet` except the three persisted `comet-*` endpoint values and the stored-task refusal, each in a named allow-list with a reason. It also has a control proving the scanner finds a planted `Comet` string.
    - The existing KIE and FAL media tests pass unchanged.
  - Acceptance:
    - Comet cannot be reached as a media gateway from the env, the agent tools, the Media panel or the poll path.
    - No Comet media price is quoted.
    - Comet's LLM rows and LLM wiring are untouched.
    - KIE and FAL behaviour is unchanged.
    - `pnpm typecheck && pnpm lint && pnpm test` are green.
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
       - `fetchFalMarketFeed(apiKey, { filter })` calls `GET https://api.fal.ai/v1/models/pricing?endpoint_id=…` with the ids from the active fal list, in batches of 50. It returns the same row shape the panel already renders for the other gateways.
       - The route dispatches on provider `'FAL'` and uses `FAL_API_KEY`. A missing key is a describable "not configured" error.
       - The panel's provider picker shows FAL. The feed is for the operator to read and is never applied.
  - Tests:
    - `market-prices.spec.ts`:
      - `accepts a media-only FAL list with an empty llm table` → ok;
      - `refuses a FAL list that carries llm rows` → an error naming FAL as media-only;
      - `still refuses a KIE list with no llm rows` → the existing error (control).
    - `market-price-store.spec.ts`:
      - `promotes and loads a FAL list under its own key` → stored at `fal`; KIE's pointer is untouched;
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
    - Every other provider's list validates exactly as before.
    - The admin panel can show FAL's list and fetch its feed.
    - If `FAL_API_KEY` is missing, the task stops and reports that.
  - Verify level: standard

### Phase 2 — fal renders images, transparent images and video

> As built, T3 and T4 also kept Comet working (its native-alpha transparency and its catalogue). T1 removes that; the checked text below is what remains true.

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
       - `MEDIA_PROVIDERS` gains `'FAL'`, with `MEDIA_KEY_ENV.FAL = 'FAL_API_KEY'`.
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
    - `fal-client.spec.ts` (create; a fetch stub with `seen[]` and a `responder`):
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
    - KIE behaviour is unchanged (its existing tests pass).
    - No new `=== 'KIE'` / `=== 'Comet'` / `=== 'FAL'` ternary.
  - Verify level: standard

- [x] **T4** — Transparent images on fal: the cut-out pass becomes per gateway
  - Files:
    - `app/lib/media/image-capabilities.ts` (modify)
    - `app/lib/.server/media/service.ts` (modify)
    - `app/components/media/MediaPanel.tsx` (modify only if it reads `CUTOUT_MODEL`)
  - Details:
    1. Replace `hasCutoutPass(provider) === (provider === 'KIE')` with one exported record:

       `CUTOUT_MODEL_BY_PROVIDER: Record<ImageProviderName, string | null> = { KIE: 'recraft/remove-background', FAL: 'fal-ai/bria/background/remove' }`

       `hasCutoutPass` and `supportsTransparency` read it. `CAPABILITIES.FAL = {}` (no native-alpha model is used on fal).
    2. In `service.ts`, `CUTOUT_MODEL` becomes `cutoutModelFor(provider)`, used by:
       - the quote (`cutoutAvailable`, the combined price);
       - the "is not a model you generate with" refusal, which now checks every gateway's cut-out id;
       - the poll-path chain.

       The chain creates the cut-out through `cutoutTaskFor(provider, renderUrl)`:
       - KIE: `{endpoint: 'jobs', payload: {image}}`, byte-identical to today;
       - FAL: `{endpoint: 'fal-queue', model: cutout id, payload: {image_url}}`.

    3. The stage-1 render for a transparent request on fal is asked for as jpeg, with the same flat-backdrop prompt directive KIE uses, because the alpha comes from stage 2.
  - Tests:
    - `image-capabilities.spec.ts`:
      - `FAL supports transparency through a cut-out pass`;
      - `KIE stays on Recraft` (control).
    - `media.spec.ts`:
      - `a transparent fal image quotes render + cut-out together, debits once, chains bria on the poll and delivers the cut-out` → the second create has `payload.image_url` equal to the render URL;
      - `a fal cut-out that cannot start fails and refunds in full`;
      - `KIE's cut-out payload is unchanged` (control: `{image}` on `'jobs'`).
  - Acceptance:
    - A transparent request on fal runs as one task with one debit and two stages, and delivers a PNG.
    - An opaque render is never delivered in its place.
    - KIE's transparency path is byte-identical.
  - Verify level: standard

### Phase 3 — Sound on both gateways

> T5 (Comet audio routes in the Comet client) was removed with Comet on 2026-10-01. Its id is not reused.

- [ ] **T6** — Make sound provider-aware on KIE and fal: models, validation, payloads, the music rule, the tool and the prompt note
  - Depends on: T1 (Comet gone from `ImageProviderName`).
  - Files:
    - `app/lib/media/provider-defaults.ts` (modify)
    - `app/lib/media/sound-request.ts` (modify)
    - `app/lib/media/fal-routes.ts` (modify: enable the `sfx`, `tts` and `music-minimax` families)
    - `app/lib/.server/media/service.ts` (modify)
    - `app/lib/.server/agent/media-tools.ts` (modify)
    - `app/lib/.server/agent/media-note.ts` (modify)
    - `app/lib/.server/agent/config.ts` (modify: `requireMediaKey` wording)
  - Details:
    1. **Model ids.** `SOUND_MODELS` becomes a per-provider record, `Record<ImageProviderName, { effect, music, speech: string[], voices, musicOptions }>`, exported from a client-safe module so T7's panel reads it:
       - KIE: today's values, byte-identical;
       - FAL:
         - effect `fal-ai/elevenlabs/sound-effects/v2`;
         - music `fal-ai/minimax-music/v2.6`;
         - speech `[fal-ai/elevenlabs/tts/multilingual-v2, fal-ai/elevenlabs/tts/turbo-v2.5]`;
         - voices: the documented ElevenLabs names (Rachel, the default, plus Aria, Roger, Sarah, Laura, Charlie, George, Callum, River, Liam, Charlotte, Alice, Matilda, Will, Jessica, Eric, Chris, Brian, Daniel, Lily, Bill);
         - no version option.

       `soundKindForModel(model)` checks every provider's ids through that record. Never use `=== 'KIE'` ternaries.
    2. **Defaults.** `DEFAULTS.FAL.sound` is set from that record.
    3. **Validation.** `validateSoundRequest(args, provider)` checks against the provider's models, voices and music options, and still returns sentences when it refuses.
       - On fal, sound-effect duration is capped at 22 s, and the refusal names the limit.
       - Music on fal needs `lyrics` unless it is instrumental, and the refusal says so.
    4. **`service.ts`:**
       - **fal sound bodies.** `buildFalPayload` builds the three bodies:
         - sound effect: `{text, duration_seconds, loop}`;
         - speech: `{text, voice}`;
         - music: `{prompt, lyrics?, is_instrumental}`.
       - **fal sound-effect duration is always sent.** It is priced `per_second`, and a request with no duration is refused by the price lookup, so a default (e.g. 5 s) is applied when the request has none. The quote and the payload use the same value.
       - **Routing.** `ROUTE_REFUSAL` stops refusing fal sound models.
       - **Music callback rule.** The music refusal applies only when the provider is KIE.
       - **Speech quote.** The quote passes `textChars` for speech, which the `per_1k_chars` rows need.
       - **File extension.** `deriveDestPath` keeps `.mp3`, unless the fal probe finds a model returns WAV; then the extension comes from the same delivery decision for that model.
    5. **The agent tools.**
       - `generate_sound`'s schema and description come from the provider's record, so the cached prompt never shows KIE names on fal.
       - `generate_google_video`'s resolution text comes from the provider's defaults too (fal has no 4k).
       - The text stays deterministic for a given provider.
    6. **The prompt note.** `media-note.ts` names `generate_sound` only when `defaults.sound` is non-null.
    7. **Missing key.** `requireMediaKey` says "media generation".
  - Tests:
    - `sound-request.spec.ts`:
      - `accepts fal ids and ElevenLabs voices for FAL`;
      - `refuses a KIE voice on FAL with a sentence naming valid voices`;
      - `refuses a 30 s fal sound effect naming the 22 s limit`;
      - `refuses fal music with lyrics missing and not instrumental`.
    - `media.spec.ts`:
      - `quotes, debits and creates a fal sound effect, then delivers it as .mp3`;
      - `a fal sound effect with no duration is quoted and sent with the same default`;
      - `fal music needs no MEDIA_CALLBACK_URL`;
      - `KIE music still refuses without a reachable callback` (control);
      - `speech is quoted per 1k chars on FAL`;
      - `a failed fal sound refunds exactly once`.
    - `media-tools.spec.ts`:
      - `generate_sound is offered on FAL with ElevenLabs voices and no KIE ids in its text`;
      - `generate_google_video names only the resolutions the gateway renders`;
      - the "a call that names NO model" table gains FAL rows for `generate_image`, `generate_google_video` and `generate_sound`.
    - The `media-note` test:
      - `does not name generate_sound when the gateway has no sound`, using a stub defaults table with `sound: null`.
  - Acceptance:
    - On both gateways, the agent tool and the server create, debit, poll and deliver all three sound kinds.
    - KIE's sound behaviour is unchanged (existing KIE sound tests pass).
    - No provider-name ternary is added.
  - Verify level: standard

### Phase 4 — The Media panel on both gateways, proved live, and SPEC

- [ ] **T7** — The Sound tab on both gateways, and a live run of fal end to end
  - Files:
    - `app/components/media/MediaPanel.tsx` (modify)
    - `app/components/media/media-panel-fields.spec.tsx` (modify)
  - Details:
    1. Replace `SOUND_MODELS_SPEC` ("KIE only") with fields built from T6's per-provider sound record: model list, voice list and music options. `modelsForProvider('audio', provider)` returns that provider's list.
    2. The price on Generate comes from the same quote action as today.
  - Tests (`media-panel-fields.spec.tsx`):
    - `shows the Sound tab on FAL with ElevenLabs voices and fal image/video models`;
    - `still shows KIE's sound fields on KIE`;
    - `hides the Sound tab when the gateway has no sound models` (control, stub table).
  - Acceptance (live):
    1. With `MEDIA_PROVIDER=FAL` and the dev server restarted, use the Media panel to generate:
       - one opaque image;
       - one **transparent** image (decode the delivered PNG: most pixels outside the subject are fully transparent);
       - one 4-second video with audio off;
       - one sound effect, one speech line and one music track.

       Each file lands in `public/assets/generated/` and plays or renders in the browser, and the balance drops by exactly the quoted amount. An invalid request that fal accepts and then fails is refunded.
    2. In one fal chat turn ("add a coin pickup sound, short background music and a transparent coin icon"), the agent calls `generate_sound` and `generate_image` with transparency, and the files appear.
    3. Switching back to `MEDIA_PROVIDER=KIE` still shows KIE's tabs. A task started on fal before the switch still completes and delivers.
    4. If the fal account still cannot render (no balance), report that and run steps 1–2 against a stubbed fal provider.
  - Verify level: live

- [ ] **T8** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details: following SPEC.md's "How to update this spec":
    - **§4.16:**
      - the gateway list becomes KIE and fal;
      - the heading's "second gateway (Comet)" and "sound … (KIE only)" become KIE and fal, both with sound;
      - fal's queue shape and its two-stage transparency;
      - fal's sound routes, and polling-only music;
      - the callback rule scoped to KIE;
      - Comet is not a media gateway: `MEDIA_PROVIDER=Comet` is refused, and an old Comet task is refunded on its next poll.
    - **§4.6:** fal's media-only price list and its admin feed; Comet's list carries LLM rows only.
    - **Decisions:**
      - **Higgsfield evaluated and rejected 2026-09-30** (no standalone audio in its public API);
      - **fal added 2026-10-01** as a media-only gateway;
      - **Comet removed from media 2026-10-01** (owner: security issue, no longer trusted).

    Record the product only, never verification procedure.
  - Acceptance:
    - SPEC.md matches T1–T7.
    - Nothing in it describes Comet as a media gateway, says sound is KIE-only, or says media providers must also serve an LLM.
    - All three decisions and their reasons are recorded.
  - Verify level: standard

---

## Estimated execution time

| Phase | Tasks | What makes it slow | Estimate |
| --- | --- | --- | --- |
| 1 — Remove Comet, price fal | T1 (T2 done in code; its probe waits on a fal top-up) | Comet runs through about a dozen media files and their specs | ~30 min |
| 2 — fal images, video, transparency | T3, T4 | Done | — |
| 3 — Sound on both | T6 | Six files across the shared validator and the tool text | ~35 min |
| 4 — Panel, live, SPEC | T7, T8 | One live fal session generating real media | ~40 min |

**Remaining ≈ 1 h 15 min – 2 h 15 min**, ±30 %. With `--strict`, multiply by 2–3.

Biggest uncertainty: whether fal's background removal returns real alpha, and whether the status URL really is `response_url + '/status'`. The fal probe settles both once the account is topped up. If the status URL is wrong, every fal task stays pending with its debit held, so check it first.

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- bt-execute verifies each phase with an independent verifier; add `--strict` for an adversarial verifier on every task.
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
