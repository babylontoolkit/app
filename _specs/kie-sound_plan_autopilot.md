# kie-sound — auto-pilot run log

## Run 1 — 2026-09-30/10-01 (branch `btk-sandbox`)

Command: `bt-execute --auto-pilot _specs/kie-sound_plan.md ALL` · TIME MATTERS on.

### Tasks

| Task | Outcome | Attempts | Tests | Verifier | Commit |
|---|---|---|---|---|---|
| T1 — price sound | ✅ | 1 | `market-prices.spec.ts` 66 | PASS (independent) | `793908bf` |
| T2 — KIE wire + service + sniff + callback | ✅ | 1 | `media.spec.ts` 93 · `media-provider.spec.ts` 44 · `sniff.spec.ts` 10 | PASS (independent) | `793908bf` |
| T3 — `generate_sound` tool | ✅ | 1 | `sound-request.spec.ts` 54 · `media-tools.spec.ts` · `provider-defaults.spec.ts` 36 | PASS (independent) | `793908bf` |
| T4 — client Sound tab, audio tasks, status line | ✅ | 1 | `tasks.spec.ts` + `StreamingStatus.spec.tsx` + `media-panel-fields.spec.tsx` 155 total | PASS (independent) | `5c63c712` |
| T5 — builds ship SFX; live proof | ✅ | 1 | `creation-plan.spec.ts` + live wire probe (real KIE) | PASS (independent) | `5c63c712` |
| T6 — SPEC.md | ✅ | 1 | n/a (docs) | PASS (independent) | `5c63c712` |

Suite: 404 files / 8,716 tests at the plan's baseline (`893e313a`) → 405/8,796 after Phase 1 → **405/8,808** after Phase 2. Typecheck clean, lint 0 errors.

**Plan status: COMPLETE. All 6 tasks ticked.**

### Decisions

- **Prices are baked, not promoted.** Assumption (a) holds locally: `.data/storage/` has no `market-prices` key, so the baked KIE list is active and the four audio rows price immediately. The T5 promote step is **N/A locally** and remains **owner-action-required on any deploy that has a promoted KIE pointer** (a promoted list replaces the baked one wholesale).
- **Scope held to the plan's four price rows.** The owner supplied a wider feed excerpt; Gemini TTS is priced *per million tokens* (a unit `MediaUnit` cannot express) on an API neither Suno nor the ElevenLabs jobs route serves, so it is out of scope. ElevenLabs V3 text-to-dialogue ($0.07/1k) is one additive row whenever wanted.
- **`MediaTaskKind` introduced** rather than repeating the literal union across the quote, the started task and the stored record — three hand-written copies is how they stop agreeing.
- **Two Suno parsers, not one widened parser.** `parseSunoTaskState` is separate from `parseTaskState` because `TEXT_SUCCESS`/`FIRST_SUCCESS` read like success and are pending.
- **Live music test enabled by tunnel (owner-approved, option A).** `cloudflared` → a 200-only stub on :8787, *not* the dev server, so no app surface, auth route or API key is exposed. `MEDIA_CALLBACK_URL` set in `.env.local:371`, marked throwaway.
- **Unroutable callback addresses are refused**, extending the plan's D7: a parse-only check would accept `http://localhost:…` and then debit for a request KIE can never deliver a callback to.

### Findings worth keeping

- **The `oauth.spec.ts` env trap, fifth occurrence — self-inflicted.** Setting `MEDIA_CALLBACK_URL` in `.env.local` for the live test made it visible to `env()`'s `process.env` fallback, which vitest loads. `MEDIA_CALLBACK_URL` **and** its `APP_URL` fallback are now in `media.spec.ts`'s `MONEY_ENV`; without both, "music with no reachable callback is refused" passes on CI and fails only for whoever set the feature up.
- **`provider-defaults.spec.ts` caught its own predicted case.** Its comment said a new field added without a Comet answer would fail there rather than ship KIE's wording as a default. Adding `sound` did exactly that.
- Verifier findings closed in the same phase: the plan-named `media-note.spec.ts` assertion (unpinned prompt text is §4.2.8-silent), `file_name` refused by name rather than silently dropped, and IPv4-mapped/CGNAT addresses added to the unroutable check.

### Deferred

None yet.

### Owner action

- **Deploy only:** if a promoted KIE Marketplace price list exists, re-promote it with the four audio rows (Settings → Admin → Marketplace prices), or sound is refused as unpriced there.
- **Teardown after T5:** kill the `cloudflared` and `callback-stub` terminals, delete `scratchpad/callback-stub.mjs` (untracked), remove `MEDIA_CALLBACK_URL` from `.env.local`.
