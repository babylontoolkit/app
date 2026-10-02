# media-gateways_plan — auto-pilot run log

## Run 1 — started 2026-10-01

Command: `/bt-execute --auto-pilot @_specs/media-gateways_plan.md ALL` (TIME MATTERS, standard verifier). Branch `btk-sandbox`.

### Decisions

- DECISION run: Agent Reference not fetched. This plan is platform server/UI work (media gateways), not Babylon game code, so the reference has nothing that governs it.
- DECISION T1: `COMET_API_KEY` is blank in `.env.local` (and absent from every other env file), so the paid Comet probe cannot run. The probe script is still written, so it runs as soon as a key exists. Comet audio rows are baked from Comet's PUBLIC feed (`GET https://api.cometapi.com/api/models`, no key needed, read 2026-10-01: `eleven_text_to_sound_v2`, `eleven_multilingual_v2`, `eleven_v3` all `per_request 0.01 × ratio 0.8 = $0.008`) plus Comet's docs (speech "$0.008 per 50 characters" → per_1k_chars $0.16; Suno $0.144 per submit from the Suno guide, not in the feed). T1's Acceptance allows "the probe or Comet's published page", but its first item ("the probe runs end to end") cannot be met, so T1 stays unticked and DEFERRED. T5–T7's Comet work is built against the documented API shapes.

### Tasks
- DECISION T2: fal answered every probe submit with 403 "User is locked. Reason: Exhausted balance" — $0 spent, no render findings. Price rows baked from fal's pricing API (works with the key) + each model's llms.txt. T3–T4 are built against fal's DOCUMENTED queue shapes (status URL = `response_url + '/status'`, result URL = `response_url`), and the probe confirms them once the account is topped up.
- DECISION T2 (implementer): Kling v3 Standard with audio baked at the pricing API's $0.14/s rather than the page's $0.126 (under-quoting is the costly direction); the fal sound effect is `per_second`, so a request with no duration is refused and T6 must always send `duration_seconds`.
- T1 — built, NOT ticked: probe written (exits 1 "COMET_API_KEY is not set"), Comet audio rows baked from the public feed + docs. Tests: touched specs green; full suite 9110 passed. ⏭️ DEFERRED — needs a COMET_API_KEY, then `node scripts/comet-audio-probe.mjs`.
- T2 — built, NOT ticked: fal probe written, media-only FAL price list + admin feed + 17 new fal tests. ⏭️ DEFERRED — fal account balance exhausted; top up, then `node scripts/fal-media-probe.mjs`.
- Phase 1 verifier (independent subagent): T1 code PASS, T2 code PASS — 8 spec files / 494 tests, typecheck, eslint clean. Open risk for the Comet probe: docs say "$0.008 per 50 characters" — if Comet rounds up to whole 50-char blocks, short speech lines are under-quoted (60 chars quoted $0.0096 vs a possible $0.016); the feed lists the rows per_request. The probe's speech job settles it.
- T3 — ✅ PASS (1 attempt). fal queue client (`fal-client.ts`, documented shapes; status URL only in `statusUrlFor`), `fal-routes.ts`, FAL registered as a media-only gateway, `isGoogleVideoModel` by path segment, panel catalogue. Verifier (independent): 15 files / 486 tests, typecheck, eslint clean.
- T4 — ✅ PASS (1 attempt). `CUTOUT_MODEL_BY_PROVIDER` (KIE recraft / Comet null / FAL bria); fal transparent = jpeg render + bria cut-out, one debit; KIE cut-out byte-identical.
- DECISION T3: T3/T4 ticked although T2's probe is deferred — their Acceptance is against stubbed responses, built to fal's documented shapes. ⚠️ FIRST thing to confirm when the fal probe runs: `status_url === response_url + '/status'`. If wrong, every fal task stays pending forever with the debit held (the service has no server-side expiry for pending tasks — a pre-existing property, KIE behaves the same).
- Phase 2 verifier notes (records, not failures): `generate_google_video`'s "720p, 1080p or 4k" text is gateway-blind (fal drops 4k silently) — folded into T6's per-provider tool text; on FAL only `generate_video` is driven through the agent tool in specs; Seedream maps an uncovered ratio (21:9) to 16:9.
- Full suite after Phase 2 (implementer): 431 files, 9173 passed, 8 skipped, 0 failed.
