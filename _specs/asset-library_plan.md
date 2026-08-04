# Synty Prototype Asset Library + creative-freedom creation (owner directive, 2026-08-04)

## The directive, verbatim intent

1. **Don't interfere with or restrict the prompt.** The prompt is the prompt; the model uses its own
   creativity. The keyword genre-seeding ("shooter" → First-Person Explorer) picked the wrong starter
   on a real creation and is the third keyword-table failure in this codebase — retire it.
2. **Two guarantees survive in the creation brief:**
   - On project creation the frontend shell is ALWAYS designed — bt-landing (+ bt-design) on the
     first build turn. Unchanged, mandatory.
   - The model is AWARE of the Synty Prototype asset library (Unity Synty prototype packs exported as
     interactive glTF with Toolkit metadata: complete levels — military maps, biomes — and character
     packs — military, street racer, city, apocalypse, …). Default rule: **user names no models →
     use the Synty library; primitives only when nothing suitable exists there or in a user-named
     pack.**
3. The model needs **at least one registered GameMode**, authored from the brief. Example ladder when
   it wants a working reference: `src/babylon/classes/` demos → Agent Reference docs → training
   examples.
4. The library manifest is **PINNED like skills and the starter template**: master
   `repo.babylontoolkit.com/assets.json` (owner generates it from Unity Export), admin
   fetch → validate → promote (immutable versions + pointer), rollback onto still-valid bytes.
   Generations never fetch the live URL.

## Current state (verified)

- `repo.babylontoolkit.com` is S3, no listing; `/assets.json` → 403 (does not exist yet). Everything
  must degrade to a "not pinned" state with NO invented capability in the brief (telling the model to
  use a library it cannot see is how invented asset paths happen).
- Registry: 4 real entries + `gm_blank_v1` fallback (scaffolds `DefaultGameMode.ts`). Cards + wizard
  are EXPLICIT choices and stay. Only Path A typed-prompt inference dies.
- `decideSeed` (`app/lib/registry/match.ts`): keyword ranking, `SEED_THRESHOLD = 1`.

## Build

### T1 — retire keyword seeding (Path A only)
`decideSeed`: vague → wizard offer (unchanged); anything else → fallback entry. `rankEntries`/
`scoreEntry`/keywords stay exported (hide-don't-delete; the seed-chip runner-up affordance may want
them) but no longer decide anything. `deriveProjectTitle` unchanged. Update `match`-related specs:
matched-kind assertions become fallback-kind, with a control that cards still pass an explicit entry.

### T2 — asset manifest pin store (`app/lib/.server/assets/library-manifest.ts`)
Mirror `templates/pin.ts` + `market-price-store.ts`: baked EMPTY default, ObjectStore immutable
versions + pointer, validate-before-write reporting ALL errors, rollback only onto bytes that still
validate, in-process cache with sync read (`activeAssetLibrary()`) + async doorway
(`ensureAssetLibrary()`). Admin routes behind `requireAdmin`. Fetch-from-URL is for the operator's
eyes and promote is explicit — never machine-applied.

**v1 schema — SUPERSEDED by the full design (2026-08-04): see `asset-library_manifest-schema.md`
(field-by-field, exporter-facing) and `asset-library_example-assets.json` (the worked starter
manifest, pinned always-valid by `library-manifest.spec.ts`). The sketch below is the original
outline, kept for history:**
```jsonc
{
  "version": 1,
  "generated": "2026-08-04T…",            // informational
  "baseUrl": "https://repo.babylontoolkit.com/", // asset URLs resolve against this
  "packs": [{
    "id": "synty-military",               // stable slug
    "title": "Polygon Military",
    "kind": "characters" | "level" | "props" | "vehicles" | "mixed",
    "description": "one line",
    "assets": [{
      "path": "packs/military/Soldier_01.gltf", // relative to baseUrl
      "name": "Soldier_01",
      "tags": ["character", "soldier"],       // optional
      "components": [{ "object": "Root", "script": "…" }], // optional, exporter detail
      "sceneUrl": "…"                          // optional, for complete levels
    }]
  }]
}
```
Unknown fields pass through untouched (the exporter will grow data we don't know yet). Validation
refuses: missing/empty `packs[].id`|`title`, missing `assets[].path`|`name`, duplicate pack ids,
absolute `path` values that escape `baseUrl` (path-traversal wall), non-numeric `version`.

### T3 — compact index in the CACHED prompt prefix
`buildAssetLibraryIndex(manifest)` → a bounded block (pack id, title, kind, asset count, one-liner,
plus per-pack asset names capped; hard char budget with an explicit "…and N more — full detail via
the manifest" tail). Injected as a stable prompt entry alongside the docs/skills zone (same
breakpoint region — it changes only on PROMOTE, exactly like a prompt promotion, so the one-time
warmup cost is the accepted one). Sorted, hash-stable. When nothing is pinned: NO block at all.
Full manifest detail deliberately NOT in context v1 — the index carries names; per-object component
detail is a later on-demand lever if placements need it.

### T4 — creation brief rewrite (`buildCreationBrief`)
- Marker verbatim, title, scaffolded-mode facts, play contract, images, media section, landing/
  chrome decision: KEPT.
- "Seeded from <genre>" framing → the starter is a generic shell; the REQUEST decides the game.
- New: at-least-one-GameMode requirement + the example ladder (classes/ demos → Agent Reference →
  training examples).
- New: asset sourcing rule. When a library is pinned: default to Synty prototypes (reference by the
  manifest's exact paths — never invent), primitives last resort. When NOT pinned: build with
  `classes/` demo content and primitives; no mention of a library that isn't there.
- Tone: awareness, not instruction — nothing funnels the model toward the four demos.

### T5 — Admin panel section
"Asset library" beside "Starter template"/"Marketplace prices": show active version + counts,
fetch-from-URL preview, promote, rollback list. Same shape as the template pin UI.

### T6 — tests + spec
Store: validate/promote/rollback/degrade tests (PGlite not needed — ObjectStore). Index: budget cap,
sort stability, empty-manifest → no block. Brief: pinned vs unpinned wording, marker unchanged
(creation-brief spec exists). Seeding: inverted specs + explicit-card control. Targeted `vitest run`
only (full suite still wipes `.data` — standing hazard). SPEC §4.4a amendment + this plan file.

## Not doing (deliberate)
- No LLM classifier replacing keywords — nothing replaces them; the model decides in the build turn.
- No per-object component detail in context v1 (money path; index only).
- No runtime fetch of the live URL from generations (pin-and-promote is the whole point).
- Cards/wizard untouched.
