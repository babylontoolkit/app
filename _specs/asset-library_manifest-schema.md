# Asset Library Manifest — Schema (v1)

The target for the Unity Export pipeline: what `repo.babylontoolkit.com/assets.json` should contain
so the model can build scenes, characters, vehicles and prop layouts from the library WITHOUT opening
a single glTF. Designed from the consumer's seat — every field answers a question the model actually
has while writing Toolkit game code. The live example (`_specs/asset-library_example-assets.json`) is
validated by `library-manifest.spec.ts` on every test run, so this doc, the example, and the
validator cannot drift apart.

**Ground rules the exporter can rely on:**
- **Unknown fields pass through validation untouched** — add exporter detail freely; nothing here is
  a ceiling.
- **Required fields are few on purpose**: manifest `version` + `baseUrl` + `packs[]`; pack `id` +
  `title` + `assets[]`; asset `path` + `name`. Everything else is optional detail — a sparse manifest
  is valid, it is just less useful to the model.
- **`path` is always relative to `baseUrl`** — no scheme, no leading `/`, no `..` (refused).
- Structured optional fields ARE validated when present (a `prefabs` entry without a `name` is an
  exporter bug worth refusing at promote time, because the model instantiates BY name).

---

## Top level

| Field | Req | Type | What the model does with it |
|---|---|---|---|
| `version` | ✅ | number | Schema version. `1`. |
| `baseUrl` | ✅ | string (https) | Every asset `path` resolves against this — the URL game code loads. |
| `generated` | — | ISO date | Informational; shown in the admin panel. |
| `toolkitVersion` | — | string | The Toolkit version the exports were authored against. |
| `units` | — | string | World units, e.g. `"meters"`. Placement math assumes this. |
| `packs` | ✅ | Pack[] | The library. |

## Pack

| Field | Req | Type | What the model does with it |
|---|---|---|---|
| `id` | ✅ | string | Stable slug, unique across the manifest (`"synty-military"`). |
| `title` | ✅ | string | Display name (`"Polygon Military"`). |
| `kind` | — | string | Free-form category: `characters`, `vehicles`, `level`, `props`, `weapons`, `mixed`. Guides which pack to reach for. |
| `description` | — | string | One or two lines: theme, scale, what it is good for. Rides in the prompt index — write it FOR the model. |
| `tags` | — | string[] | Search/theming words (`["military", "modern", "fps"]`). |
| `assets` | ✅ | Asset[] | At least one. |

## Asset (common fields — every kind)

| Field | Req | Type | What the model does with it |
|---|---|---|---|
| `path` | ✅ | string | Relative file path — the EXACT string game code loads. Never invented. |
| `name` | ✅ | string | Human/model-readable name. |
| `kind` | — | string | `level` \| `character` \| `vehicle` \| `prop-container` \| `prop` \| `weapon` \| `building` \| `environment`. Decides which of the shapes below applies. |
| `description` | — | string | What it is, what it is good for. |
| `tags` | — | string[] | (`["barrel", "container", "cover"]`). |
| `load` | — | string | HOW to bring it in: `scene` (preload via the play contract's `sceneUrl`), `container` (load as an AssetContainer and instantiate prefabs from it), `mesh` (import directly). Defaults: levels → `scene`, everything else → `container`. |
| `bounds` | — | `{ size: [x,y,z], center?: [x,y,z] }` | World-space extents in `units` — placement and spacing math. |
| `pivot` | — | string | Where the origin sits: `bottom-center`, `center`, `custom`. Placement assumes `bottom-center` when absent. |
| `nodes` | — | Node[] | The game-object tree that MATTERS: nodes carrying script components, attach points, markers. Not the full hierarchy — the actionable part. |
| `sceneUrl` | — | string | Levels only: the ready-to-play scene file to pass through the play contract (`navigate('/play', { gameMode, sceneUrl })`). Relative like `path`. |
| `thumbnail` | — | string | Relative image path, for future gallery UI. Unused by the model. |

## Node (`nodes[]` — script components per game object)

The CVTOOLS/Unity-metadata answer to "what behaviour is already ON this thing".

| Field | Req | Type | Notes |
|---|---|---|---|
| `name` | ✅ | string | The node's name in the glTF — what code looks up. |
| `path` | — | string | Slash path when the name alone is ambiguous (`"Root/Armature/RightHand"`). |
| `components` | — | Component[] | `{ "script": "TOOLKIT.StandardCarController", "properties": { ... } }` — script class + the tuned property values worth knowing (top speed, mass, health). `properties` is open. |
| `purpose` | — | string | Marker semantics: `attach-point`, `camera-mount`, `exhaust`, `muzzle`, `seat`. |
| `children` | — | Node[] | Nested actionable nodes. |

## Prefab (`prefabs[]` — prop containers)

Prop packs ship MANY props in ONE file, loaded once as an AssetContainer; the model instantiates
individual prefabs from it by name (`InstantiatePrefabFromContainer`). The prefab list is therefore
the container's real content — without it the file is opaque.

| Field | Req | Type | Notes |
|---|---|---|---|
| `name` | ✅ | string | The prefab's node name INSIDE the container — the exact string instantiation uses. |
| `kind` | — | string | `prop`, `weapon`, `foliage`, `rock`, `structure`… |
| `tags` | — | string[] | (`["barrel", "explosive"]`). |
| `bounds` | — | same as asset | Per-prefab extents for placement. |
| `components` | — | Component[] | Scripts already on the prefab (a destructible's health script, a pickup's trigger). |

## Character extras (`kind: "character"`)

| Field | Type | Notes |
|---|---|---|
| `rig` | string | `humanoid` \| `generic`. Humanoid → the Toolkit's retargetable animation set applies. |
| `animations` | `{ name, loop?, note? }[]` | Clips shipped IN the file (`idle`, `walk`, `run`, `jump`, `death`…). The model wires AnimationState machines from these names. |
| `controller` | string | The recommended/preconfigured controller: `ThirdPersonPlayerController`, `StandardPlayerController`, `none` (an NPC to drive via NavigationAgent). |
| `attachPoints` | Node[] | Where weapons/props mount (`RightHand`, `Back`) — same Node shape, `purpose: "attach-point"`. |

## Vehicle extras (`kind: "vehicle"`)

| Field | Type | Notes |
|---|---|---|
| `vehicleType` | string | `car`, `truck`, `bike`, `kart`. |
| `wheels` | string[] | Wheel node names, in FL/FR/RL/RR order when four. |
| `seats` | Node[] | Driver/passenger mounts (`purpose: "seat"`). |

(The controller and its tuning live in `nodes[].components` like everything else —
`TOOLKIT.StandardCarController` with its tuned properties.)

## Level extras (`kind: "level"`)

| Field | Type | Notes |
|---|---|---|
| `spawnPoints` | `{ name, position: [x,y,z], rotationY?, purpose? }[]` | Where things START: `purpose` = `player`, `vehicle`, `enemy`, `item`, `checkpoint`. The single most valuable level fact — without it the model guesses coordinates. |
| `navMesh` | boolean | A baked navigation mesh ships in the scene → NavigationAgent works out of the box. |
| `lighting` | string | `baked` \| `dynamic` \| `mixed` — whether the model should add lights. |
| `environment` | `{ skybox?: boolean, fog?: boolean, timeOfDay?: string }` | What ambience already exists. |
| `playableArea` | same as `bounds` | The area gameplay should stay inside (may be smaller than the mesh extents). |
| `recommendedModes` | string[] | What this level was built for: `["racing"]`, `["fps", "exploration"]`. A hint, never a restriction. |

---

## How the model consumes this (current wiring)

- The **prompt index** (`buildAssetLibraryIndex`, hard char budget) carries packs + capped asset
  names — awareness of what exists, on every turn.
- The **full detail** (nodes, prefabs, spawn points) lives in the promoted manifest. It is NOT in
  context v1 (context is the money path, §4.2.8); the planned consumer is an on-demand detail lever
  (a `read_asset_pack`-style tool or per-pack doc block) once real pack sizes are known. Export the
  detail NOW regardless — the manifest is the source of truth the lever will read, and re-exporting
  later to add it is the expensive path.
