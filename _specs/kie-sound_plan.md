# KIE Sound — built-in `generate_sound` (effects, music, speech)

**Goal.** Make sound a first-class, built-in media type next to images and video (SPEC §4.16), on the same `KIE_API_KEY`, debited as media credits. The model gets a `generate_sound` tool. The Media panel gets a **Sound** tab. Every new game ships with sound effects. The tool's behaviour matches the owner's `kie-sound` MCP server (`/Users/mackey/Documents/Repos/Runtime/MCP/kie-image-mcp/src/sound.ts`), adapted to the platform's async-enqueue design: debit → create task → return the path at once → the client polls and writes the bytes.

**Owner answers (2026-09-30):**
- **Kinds:** all three — sound effects (Suno), music (Suno), and speech (ElevenLabs).
- **Builds:** Art direction automatically generates **sound effects only, not music**. Music is generated only when the user asks.

---

## Codebase Analysis

**Mode:** Quick Plan (no spec file). One round of questions was asked, and the answers are above. The remaining scope comes from the brief, the MCP server and the platform code.

### The reference implementation (`kie-image-mcp/src/sound.ts`)

**Tool.** One tool, `generate_sound`, selects one of three kinds with `kind` (default `sound_effect`):

| kind | model | create | poll | result URL |
|---|---|---|---|---|
| `sound_effect` | Suno `V5` / `V5_5` | `POST /api/v1/generate/sounds` `{prompt, model, soundLoop, soundTempo?, soundKey?, callBackUrl?}` | `GET /api/v1/generate/record-info?taskId=` | `data.response.sunoData[i].audio_url \|\| audioUrl` |
| `music` | Suno `V4`, `V4_5`, `V4_5PLUS`, `V4_5ALL`, `V5`, `V5_5` | `POST /api/v1/generate` `{prompt, model, customMode, instrumental, style?, title?, negativeTags?, vocalGender?, duration?, callBackUrl}` (**callBackUrl required**) | same as effects | same as effects |
| `speech` | `elevenlabs/text-to-speech-multilingual-v2`, `elevenlabs/text-to-speech-turbo-2-5` | `POST /api/v1/jobs/createTask` `{model, input:{text, voice, stability?, similarity_boost?, style?, speed?, language_code?}}` | `GET /api/v1/jobs/recordInfo?taskId=` | `resultJson.resultUrls[0]` |

**Task states.**
- Suno uses `data.status`:
  - `SUCCESS` → done;
  - `PENDING`, `TEXT_SUCCESS`, `FIRST_SUCCESS` → still pending;
  - anything else → failed, with the message from `failMsg || errorMessage || msg`.
- Jobs (speech) uses `data.state`: `success`, or pending `waiting`, `queuing`, `generating`.

**Output.** MP3 only. A Suno task returns several tracks; the MCP saves `track_index` (default 0).

**Per-kind rules** (`buildSoundRequest`, sound.ts:30-134). A key that belongs to another kind is rejected: `` `${key} is not supported for ${kind}` ``.

**Prompt limits:**

| kind | limit |
|---|---|
| sound_effect | 500 |
| speech | 5,000 |
| music | 3,000 (5,000 in custom mode, except V4) |

**Option ranges:**

| Option | Range |
|---|---|
| `tempo` | 1-300 |
| `key` | `C` … `B` and `Cm` … `Bm` |
| `speed` | 0.7-1.2 |
| `stability`, `similarity_boost`, `speech_style` | 0-1 |
| `language_code` | `^[a-z]{2}$`, turbo-2-5 only |
| music `duration` | 10-360, custom mode + `V5_5` only |

**Default voice:** `EkK5I93UQWFDigLMpZcX` ("James").

### KIE prices (public feed `POST https://api.kie.ai/client/v1/model-pricing/page`, fetched 2026-09-30)

| Feed row | Unit | USD |
|---|---|---|
| Suno, Generate sounds | per request | 0.0125 |
| Suno, Generate Music | per request | 0.06 |
| Elevenlabs Text to Speech, multilingual v2 | per 1,000 characters | 0.06 |
| Elevenlabs Text to Speech, turbo 2.5 | per 1,000 characters | 0.03 |

At `CREDIT_UNIT_COST_USD=0.01` and `CREDIT_MARGIN=4` these come to about:
- a sound effect: 5 credits;
- a music track: 24 credits;
- speech: 24 credits per 1,000 characters (multilingual v2), or 12 (turbo 2.5).

### The platform's media pipeline (paths under `app/`)

**Agent tools** — `lib/.server/agent/media-tools.ts`:
- `MEDIA_TOOL_NAMES = ['generate_image','generate_video','generate_google_video']` (:118); `media-tools.spec.ts` pins it against the factory.
- `MediaTaskEvent.kind: 'image'|'video'` (:55).
- Shared `start()` (:130) → `startMediaTask` → `ctx.emit` → returns "Started … DO NOT wait… Reference ./assets/generated/…".
- Every argument is `.optional()` and validated in `execute`.
- Default models come from `mediaModelDefaults(provider.name)` (`lib/media/provider-defaults.ts`, `MediaModelDefaults`, one row each for KIE and Comet).

**Where the tools are offered:**
- Media tools are built only when a project and a media provider exist (`proxy.ts` ~:1574-1595).
- The `creation` toolset includes them when `toolPolicy.allowsMedia`; the `all` toolset always does (`proxy.ts` ~:1984-2052).
- `api.agent.ts:416-426` relays `media-task` data parts.

**Service** — `lib/.server/media/service.ts`:
- `MediaRequest`, `MediaQuote.kind`, `StartedMediaTask.kind`.
- `quoteMediaRequest` (:125) branches `if (requested.pricing.kind !== 'image')` → the video path, labelled `kind:'video'` (:164-181).
- `startMediaTask` (:359): quote → anchor → debit (`reason:'media'`, never negative, 402 when enforced) → `dispatchMediaCreate(provider.create({endpoint, model, payload}))` → refund + 502 if create fails → `putMediaTask`.
- `pollMediaTask` (:573) refunds once on failure.
- `endpointFor` (:728).
- `buildProviderPayload` (:804) falls through to the image payload for unknown models.
- `deriveDestPath(kind, …)` (:956): `public/assets/generated/<slug>-<id6>.<ext>`.

**Store and provider:**
- `store.ts` `MediaTaskRecord.kind` (:24).
- `provider.ts` `MediaEndpoint = 'jobs'|'veo'|'comet-image'|'comet-gemini-image'|'comet-video'` (:56); this value is stored in task records.
- `kie-client.ts`:
  - `_assertKieEndpoint` allows only `jobs`/`veo` (:67);
  - create → `/api/v1/jobs/createTask` or `/api/v1/veo/generate`;
  - query → `/api/v1/jobs/recordInfo` or `/api/v1/veo/record-info`;
  - `parseTaskState`/`extractResultUrl` (:118-175) know `resultUrls`, `fullResultUrls`, `videoUrl` and `mp4Url`, but not Suno's `sunoData`.

**Pricing** — `lib/.server/billing/market-prices.ts`:
- `MediaKind = 'image'|'video'` (:59), `MediaUnit = 'per_image'|'per_second'|'per_video'` (:66), `MediaModelPricing` (:81).
- `validateMediaModel` (:353) checks kind (:359) and unit (:371).
- `lookupMediaPrice` (:489) uses `per_second × durationSeconds` and refuses rather than guessing.
- `baked-market-prices.ts` media (:248-478) has 18 KIE rows and no audio.
- A **promoted** list replaces the baked one completely (`market-price-store.ts`). Audio rows added only to the baked list are refused on any deployment with a promoted KIE pointer until an admin re-promotes.
- The admin panel `components/@settings/tabs/admin/MarketPricesSection.tsx` has a local `MediaRow.kind`/`unit` (:26-32) and `UNIT_LABEL` (:72).

**Routes** (two walls each):
- `routes/api.projects.$projectId.media.ts` — quote / start / list;
- `…media.$taskId.ts` — poll;
- `…media.$taskId.file.ts` — the byte proxy. Its content type is the sniffed type, then the upstream header, then `video/mp4` or octet-stream (:78-81).

**Sniffing** — `lib/media/sniff.ts`: `SniffedImageType` (:18) has no audio.

**Client:**
- `lib/media/tasks.ts`: `MediaTaskHandle.kind` (:25); `mediaRenderStore = {images, videos}` (:71); `inFlightKinds` (:73); poll every 10 s for video, otherwise 4 s (:110).
- `Chat.client.tsx` turns any media kind that is not video into `'image'` (~:1188).
- `StreamingStatus.tsx:32` `renderLine(images, videos)`.
- `components/media/MediaPanel.tsx`: `FieldSpec.key` (:31); the `IMAGE_MODELS`/`VIDEO_MODELS` (+Comet) lists; `modelsForProvider(kind, provider)` (:287); `TaskRow.kind` (:301); `buildRequest` (:311); the kind `useState` (:354); `switchKind` (:369); the tab array (:528-538); the placeholder (:583); quote → "Generate — N credits" (:598).

**Already in place for audio:**
- `lib/binary/binary-files.ts` already treats mp3, wav, ogg and m4a as binary (:104-113), so `write_file` refuses them and `createFile` stores the bytes.
- `lib/preview/media-kind.ts` already has `'audio'`.
- The Code tab's `BinaryPreview.tsx` already plays `<audio controls>`.

**Prompt text that mentions the media tools:**
- `lib/.server/agent/media-note.ts` `mediaProtocolNote` (:63-101);
- `lib/.server/prompt/sources.ts:389` ("built-in generate_image/generate_video tools");
- `lib/agent/creation-plan.ts` — the `design` phase (`allowsMedia: true`, task :135-144) and the `game` phase (~:219).

**Docs:** the synced reference `audio-source` (`training/components/07-AudioSource.md`, `sources.ts:298`) covers playing music and sound effects; the game phase points the model at it.

**Gateways:** Comet has no audio routes. Sound is KIE-only, and on a Comet media gateway the tool and the panel tab are absent (see D9).

### SPEC conformance

The plan conforms to:
- SPEC §4.16: built-in media, async-enqueue, debit before any spend, never negative, refund once, panel quote = debit;
- §4.6: the Marketplace price list, refuse rather than guess;
- §5: two walls on every project route;
- `spec/binary-files.md`: bytes are written with `Uint8Array` out-of-band and never through an artifact;
- §4.2.8: tool args validated in `execute`.

The music callback route is the one new unauthenticated route (D7). It never acts on its body, so it is not a spend hole. It is listed in `PUBLIC_BY_DESIGN` with its reason.

- **spec_impact:** yes — a new media kind, two price units, a new public route, and a change to the Art direction phase.
- **size:** medium (inferred).
- **proof:** functional.

### Test baseline

`pnpm test` passed 404 files / 8,716 tests with 0 failures at commit `893e313a`. The bar is: the named tests pass, and there are no new failures against that baseline.

### Assumptions

- **(a)** Prices are the KIE feed rows above, captured into the baked KIE list. On a deployment with a promoted KIE list, an admin re-promotes with the four rows (T5 does it locally when a pointer exists).
- **(b)** A Suno task's first track is saved; the others are dropped. The MCP reports alternates, but the platform has no use for them.
- **(c)** Speech is billed in proportion to the prompt's characters. `usd = perThousand × chars / 1000`, and credits round up through `creditsForRawCost`, so a short line costs a credit or two, not a full thousand characters' worth.
- **(d)** Whether KIE accepts a `callBackUrl` it cannot reach (localhost in dev) is unknown. T5's live check settles it, and D7 decides the fallback.

---

## Decisions

- **D1 — One tool, `generate_sound`, with `kind: 'sound_effect' | 'speech' | 'music'` (default `sound_effect`), mirroring the MCP.**
  - Every argument is `.optional()`, and the MCP's per-kind rules are re-checked in `execute` and returned as sentences: wrong-kind keys, prompt limits, ranges, models allowed for each kind.
  - Parameters:
    - common: `prompt`, `kind`, `model`, `file_name`;
    - sound_effect: `loop`, `tempo`, `key`;
    - speech: `voice`, `stability`, `similarity_boost`, `speech_style`, `speed`, `language_code`;
    - music: `instrumental` (default true), `custom_mode`, `style`, `title`, `negative_tags`, `vocal_gender`, `duration`.
  - No `callback_url` and no `track_index`: the platform owns the callback (D7), and saves track 0 (assumption b).
- **D2 — Pricing: `MediaKind` gains `'audio'`, and `MediaUnit` gains `'per_request'` and `'per_1k_chars'`.**
  - `lookupMediaPrice` accepts `textChars?: number`. For `per_1k_chars` it returns `variant.usd × textChars / 1000`, and **null** when `textChars` is absent (the per_second rule).
  - Four baked KIE rows:
    - `suno/generate-sounds` (audio, per_request, $0.0125, vendor Suno);
    - `suno/generate-music` (audio, per_request, $0.06);
    - `elevenlabs/text-to-speech-multilingual-v2` (audio, per_1k_chars, $0.06);
    - `elevenlabs/text-to-speech-turbo-2-5` (audio, per_1k_chars, $0.03).
  - The Suno version (`V5` etc.) is a request option and plays no part in the price, which is the same across versions in the feed.
- **D3 — New KIE endpoints: `MediaEndpoint` gains `'suno-sounds' | 'suno-music'`. Speech uses the existing `'jobs'`.**
  - The KIE client creates against `/api/v1/generate/sounds` or `/api/v1/generate`, and queries both against `/api/v1/generate/record-info`.
  - The Suno create response must have `code === 200`, and the task id comes from `data.taskId`.
  - Suno status parsing:
    - `SUCCESS` → succeeded, with the URL from `data.response.sunoData[0].audio_url ?? audioUrl`;
    - `PENDING`, `TEXT_SUCCESS`, `FIRST_SUCCESS` → pending;
    - anything else → failed, with `failMsg || errorMessage || msg`.
  - Speech result: `resultJson.resultUrls[0]`, which the existing jobs parser already reads. Confirm it in a unit test.
- **D4 — The service routes by `pricing.kind === 'audio'` before the video fallthrough.**
  - Quote: credits come from the price row (D2); speech passes `textChars = prompt.length`.
  - `endpointFor`: `suno/generate-sounds` → `suno-sounds`, `suno/generate-music` → `suno-music`, `elevenlabs/*` → `jobs`.
  - `buildProviderPayload` builds the D3 bodies from the validated options. The Suno `model` field is `options.sunoModel ?? 'V5'`.
  - `deriveDestPath('audio')` uses the extension `mp3`.
  - `MediaQuote`, `StartedMediaTask` and `MediaTaskRecord` `kind` all widen to `'image'|'video'|'audio'`.
- **D5 — Sniffing knows MP3.**
  - `sniff.ts` gains `'mp3'`, detected by the `ID3` header or an MPEG frame sync (`0xFF` then `& 0xE0 === 0xE0`), and typed `audio/mpeg`.
  - `extensionMismatch` checks `.mp3`.
  - The file route falls back to `audio/mpeg` for an `audio` task.
- **D6 — Client polls audio every 10 s.**
  - Kind unions widen.
  - `mediaRenderStore` becomes `{images, videos, sounds}`, and `StreamingStatus` says "N sounds".
  - The Chat data-part coercion passes `'audio'` through.
  - `MediaPanel` gains a **Sound** tab (D9).
  - Delivery is unchanged: `createFile` with bytes, then a toast "Generated sound saved…".
- **D7 — The music callback is a no-op public route.**
  - `routes/api.media.kie-callback.ts`: POST returns `200 {ok:true}` and ignores the body. Polling stays the only source of truth, so the route can neither debit nor credit nor write.
  - It is listed in `PUBLIC_BY_DESIGN` (`app/lib/.server/security/outbound-enumerate.spec.ts`) with that reason.
  - The callback URL is `env('MEDIA_CALLBACK_URL')` if set, otherwise `${APP_URL}/api/media/kie-callback`.
  - If neither yields an http(s) URL, a music request is **refused before any debit** with "Music generation needs a public callback URL (set MEDIA_CALLBACK_URL)". Effects and speech never send a callback.
- **D8 — Defaults (`lib/media/provider-defaults.ts`).**
  - `MediaModelDefaults` gains `sound: { effect: string; music: string; speech: string } | null`.
  - KIE: `{effect:'suno/generate-sounds', music:'suno/generate-music', speech:'elevenlabs/text-to-speech-multilingual-v2'}`. Comet: `null`.
  - `generate_sound` is built only when `sound` is non-null, so a Comet media gateway never offers it.
- **D9 — Media panel Sound tab (KIE only).**
  - Kind select: Sound effect / Music / Speech.
  - Effect: `loop` checkbox.
  - Music: `instrumental` checkbox (default on).
  - Speech: model select (multilingual v2 / turbo 2.5).
  - The tab is hidden when the gateway is Comet.
  - Quote and "Generate — N credits" reuse the existing flow.
- **D10 — Prompt.**
  - `mediaProtocolNote` and `sources.ts:389` name `generate_sound`.
  - The `design` phase writes an **Audio** list into `DESIGN.md` and generates the **sound effects** on it — the gameplay cues, about 3-6. **No music unless the user asked for music.**
  - The `game` phase wires the generated sounds into the game, loading the `audio-source` reference.
  - The `art` phase is unscheduled and unchanged.
- **D11 — No new dependencies.**

---

## Tasks

### Phase 1 — Server: prices, wire, tool

- [x] **T1** — Price sound: the `audio` kind, two new units, four KIE rows
  - Files:
    - `app/lib/.server/billing/market-prices.ts` (modify)
    - `app/lib/.server/billing/baked-market-prices.ts` (modify)
    - `app/components/@settings/tabs/admin/MarketPricesSection.tsx` (modify)
    - `app/lib/.server/billing/market-prices.spec.ts` (modify)
  - Details:
    - Per D2: widen `MediaKind` and `MediaUnit`, and the validator's kind and unit checks.
    - `lookupMediaPrice` input gains `textChars?`:
      - `per_request` returns `variant.usd`;
      - `per_1k_chars` returns `usd × textChars / 1000`, or null when `textChars` is missing or ≤ 0.
    - Add the four rows to the KIE baked media table, citing the feed in a comment.
    - In the admin panel, widen `MediaRow.kind`/`unit` and add `UNIT_LABEL` entries: "per request" and "per 1,000 characters".
  - Tests (`market-prices.spec.ts`):
    - the baked KIE list still validates;
    - a row with `kind:'audio'` + `per_1k_chars` validates;
    - an unknown unit is still rejected;
    - `lookupMediaPrice(suno/generate-sounds)` → 0.0125;
    - `elevenlabs/…-multilingual-v2` with `textChars: 500` → 0.03;
    - the same with no `textChars` → null;
    - `suno/generate-music` → 0.06.
  - Acceptance:
    - all four rows are priced from the baked KIE list;
    - speech prices scale with characters;
    - an unpriced call is refused, never guessed.
  - Verify level: standard

- [x] **T2** — KIE sound wire and service: Suno endpoints, audio quote/start/poll, MP3 sniffing, music callback route
  - Files:
    - `app/lib/.server/media/provider.ts`, `kie-client.ts`, `service.ts`, `store.ts` (modify)
    - `app/lib/media/sniff.ts` (modify)
    - `app/routes/api.projects.$projectId.media.$taskId.file.ts` (modify)
    - `app/routes/api.media.kie-callback.ts` (create)
    - `app/lib/.server/security/outbound-enumerate.spec.ts` (modify — `PUBLIC_BY_DESIGN` entry)
    - specs: `media.spec.ts`, `media-provider.spec.ts`, `sniff.spec.ts` (modify)
  - Details:
    - D3 in `provider.ts` / `kie-client.ts`, keeping `_assertKieEndpoint` exhaustive.
    - D4 in `service.ts`: an audio branch in `quoteMediaRequest` ahead of the video fallthrough, plus `endpointFor`, `buildProviderPayload` and `deriveDestPath`. The `kind` unions widen in `service.ts` and `store.ts`.
    - D5 in `sniff.ts` and the file route.
    - D7: the callback route, the callback URL resolver (`env(context,'MEDIA_CALLBACK_URL')` → `APP_URL`), and the music refusal **before** the debit.
    - Refunds, the never-negative rule and the 402 path are unchanged; audio reuses them.
  - Tests:
    - `media.spec.ts`:
      - a sound-effect quote → `kind:'audio'`, credits from $0.0125;
      - a speech quote scales with prompt length;
      - start debits once, creates on `suno-sounds` with body `{prompt, model:'V5', soundLoop:false}`, and the dest path ends `.mp3`;
      - the music body carries `callBackUrl` and `instrumental:true`;
      - music with no resolvable callback is refused with zero ledger rows;
      - a Suno `SUCCESS` poll → succeeded with `sunoData[0].audio_url`;
      - a Suno failure state → refunded exactly once;
      - a speech poll reads `resultJson.resultUrls[0]`.
    - `media-provider.spec.ts`: KIE accepts `suno-sounds`/`suno-music`, and the create/query URLs are as in D3.
    - `sniff.spec.ts`:
      - ID3 bytes → `mp3`, `audio/mpeg`;
      - frame-sync bytes → `mp3`;
      - `.mp3` holding PNG bytes → mismatch.
    - `outbound-enumerate.spec.ts` passes with the new public route listed.
  - Acceptance:
    - an audio task can be quoted, started, polled and served through the existing routes;
    - it is debited and refunded like images;
    - the bytes are served as `audio/mpeg`.
  - Verify level: standard

- [x] **T3** — The `generate_sound` agent tool
  - Files:
    - `app/lib/.server/agent/media-tools.ts`, `media-note.ts` (modify)
    - `app/lib/media/provider-defaults.ts` (modify)
    - `app/lib/.server/prompt/sources.ts` (modify — the :389 sentence)
    - `app/lib/.server/agent/proxy.ts` (only if the paid-media call count needs the name; it reads `MEDIA_TOOL_NAMES`)
    - specs: `media-tools.spec.ts`, `media-note.spec.ts`, `provider-defaults.spec.ts` (modify)
  - Details:
    - D1 + D8.
    - Port the MCP's `buildSoundRequest` validation into a pure exported `validateSoundRequest(args): { ok: true; model: string; options; prompt } | { ok: false; error: string }`. Its error sentences match the MCP's (e.g. `` `${key} is not supported for ${kind}` ``).
    - The tool maps `kind` to the D8 default model, or accepts `model` (a Suno version for effects/music, an ElevenLabs id for speech), calls the shared `start()`, and returns the standard "Started… Reference ./assets/generated/<name>.mp3" sentence.
    - `MEDIA_TOOL_NAMES` adds `'generate_sound'`. `MediaTaskEvent.kind` widens.
    - Description, in plain words:
      - when to use each kind;
      - Suno effects have no exact duration;
      - music is only for when the user asks for music;
      - "DO NOT wait; reference the returned path".
    - `mediaProtocolNote` and `sources.ts` name the tool.
  - Tests:
    - `media-tools.spec.ts`:
      - the names list matches the factory;
      - `generate_sound` is absent when `sound` defaults are null (Comet);
      - a call with only `prompt` starts a `suno/generate-sounds` task and returns a `.mp3` reference;
      - `voice` with `kind:'sound_effect'` → `"voice is not supported for sound_effect"`, with no debit;
      - a 501-character effect prompt → a limit error;
      - `kind:'speech'` with `language_code` on multilingual-v2 → an error;
      - a malformed arg (a `loop` sent as a string) does not throw at zod.
    - `media-note.spec.ts`: the note names `generate_sound` when the tool exists.
    - `provider-defaults.spec.ts`: KIE has sound defaults, Comet null.
  - Acceptance:
    - the model can generate effects, music and speech through one tool with the MCP's rules;
    - a bad argument returns a sentence and never kills the generation.
  - Verify level: standard

### Phase 2 — The panel, the build flow, and the live proof

- [x] **T4** — Client: Sound tab, audio tasks and status line
  - Files:
    - `app/lib/media/tasks.ts` (modify)
    - `app/components/chat/Chat.client.tsx` (modify — the `media-task` kind coercion only)
    - `app/components/chat/StreamingStatus.tsx` (modify)
    - `app/components/media/MediaPanel.tsx` (modify)
    - specs: `tasks.spec.ts`, `StreamingStatus.spec.tsx`, `media-panel-fields.spec.tsx` (modify)
  - Details:
    - D6 + D9.
    - `MediaTaskHandle.kind` and `inFlightKinds` widen; audio polls every 10 s.
    - `mediaRenderStore` becomes `{images, videos, sounds}`, and `republishRenderCounts` counts audio as sounds.
    - `renderLine` includes "N sound(s)".
    - The Chat coercion maps `'audio'` → `'audio'`.
    - Panel:
      - add `'sound'` to the kind state and the tab row (KIE only);
      - model specs for the three kinds with the D9 fields;
      - `buildRequest` maps kind and fields to the route body (`model`, `options: {kind, loop|instrumental}`);
      - the placeholder per kind.
  - Tests:
    - `tasks.spec.ts`: an audio task polls, delivers bytes once (latch), and counts as a sound.
    - `StreamingStatus.spec.tsx`: "Generating 2 images and 3 sounds…".
    - `media-panel-fields.spec.tsx`:
      - KIE lists the Sound kind with its three types;
      - Comet does not;
      - the sound request body carries the chosen kind and options.
  - Acceptance:
    - a user can quote and generate a sound from the Media panel;
    - an in-flight sound shows in the status line;
    - the MP3 lands in `public/assets/generated/` and plays in the Code tab.
  - Verify level: live

- [x] **T5** — Builds ship with sound effects; prove the whole feature live
  - Files:
    - `app/lib/agent/creation-plan.ts` (+ `creation-plan.spec.ts`) (modify)
  - Details:
    - D10. In `CREATION_PHASES`, the `design.task` gains:
      - an Audio list in `DESIGN.md` (each gameplay sound: event, description, loop or one-shot);
      - "generate each sound effect on it with `generate_sound` (one call per sound, `kind: sound_effect`); do not generate music unless the user asked for music".
    - The `game.task` gains: "wire the generated sounds from `DESIGN.md` into the game (load the `audio-source` reference for the Toolkit's audio API)".
    - Keep the existing labels, the two-words / no-shared-word rule and `phaseAllowsMedia`.
  - Tests (`creation-plan.spec.ts`):
    - the design task names `generate_sound` and says no music unless asked;
    - the game task names `audio-source`;
    - the existing phase-table tests are unchanged.
  - Acceptance — **live**, one session on the local dev server with real KIE (a few credits, expected):
    - **Admin prices.** If a promoted KIE price list exists (Settings → Admin → Marketplace prices), add the four audio rows to it and promote, then confirm a sound quote resolves.
    - **Panel.** On project "Mario Kart Racer Clone 2", generate one sound effect from the Media panel ("arcade coin pickup chime"):
      - the button shows a credit price;
      - the debit equals that price;
      - the MP3 lands in `public/assets/generated/` and plays in the Code tab.
    - **Agent.** In the same project, send "add a jump sound and a crash sound to my game":
      - the agent calls `generate_sound` twice;
      - both MP3s land;
      - the game code plays them;
      - `check_game` passes.
    - **Music.** Generate one music track from the panel. Report whether KIE accepted the dev callback URL.
      - If it was refused because the URL is unreachable, report the error text. D7's `MEDIA_CALLBACK_URL` is the operator's fix, and music in local dev is then documented as needing it.
    - **Speech.** Generate one 1-sentence speech line; it plays.
    - **Report:** the credits for each kind, and the generation and task ids.
  - Verify level: live

- [x] **T6** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details:
    - §4.16 gains sound:
      - `generate_sound` (effects, music, speech) on KIE;
      - the `audio` kind and its two units;
      - the music callback route and `MEDIA_CALLBACK_URL`;
      - MP3 output;
      - KIE-only.
    - The Art direction bullet (§4.4a PHASED CREATION) says it generates sound effects, not music unless asked.
    - Add a §8l decision line: sound added (owner 2026-09-30) — all three kinds; builds generate SFX only.
    - Follow SPEC.md's "How to update this spec". Record the product only.
  - Acceptance:
    - SPEC.md matches what T1–T5 shipped;
    - the new env var `MEDIA_CALLBACK_URL` and the public route are listed;
    - nothing contradicts the code.
  - Verify level: standard

---

## Estimated execution time

| Phase | Tasks | What makes it slow | Estimate |
|---|---|---|---|
| 1 — Server | T1–T3 | the service's kind branching and the MCP validation port; three spec files to extend | ~61 min |
| 2 — Client, build flow, live | T4–T6 | the Media panel wiring; one live session with real KIE (four kinds plus an agent turn) | ~61 min |

**Total:**
- Base: 6 × 17 + 2 × 10 = 122 min.
- One fix round (20 min) for the genuine unknown: does KIE accept an unreachable music callback?
- **About 2.4 h, range 1.7–3.1 h of agent time.**
- With `bt-execute --strict`, about 2–3× that.

**Biggest uncertainty:** KIE's real Suno and ElevenLabs responses (the response shape, the codec, and the callback rule) have never been exercised live. The MCP's own research notes say no paid generation was ever run, so T5 is the first real test.

---

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- bt-execute verifies each phase with an independent verifier; add `--strict` for an adversarial verifier on every task.
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
