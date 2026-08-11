# Hard Constraints — never violate these

## Stack

- **Babylon Toolkit + BabylonJS only.** Never introduce another engine or renderer. (three.js only if
  the user explicitly asks for it as a utility.)
- **TypeScript over JavaScript. ESM/ES6 everywhere** — no CommonJS, no UMD, no `<script>`-tag globals.
- **WebGPU preferred over WebGL** where the choice exists.
- **Never restructure the starter's Vite/React scaffold** unasked.
- **NEVER modify the starter's `vite.config` `optimizeDeps.exclude` list or its `dedupe` settings.**
  They exist to prevent the Babylon dual-instance hazard — two copies of Babylon in one bundle, which
  fails at runtime in ways that are very hard to diagnose.
- Keep the project runnable at all times. Fix surfaced build errors before adding new features.

## Batteries-included rule

Use the Toolkit's built-in systems rather than rebuilding **infrastructure**. These are plumbing, and
reimplementing one from scratch is a generation-quality bug:

- Physics → the Havok joint suite, RigidbodyPhysics
- Animation → `AnimationState` (Mecanim-style)
- Pathfinding / AI → `NavigationAgent` (Recast/Detour)
- Cameras → `DefaultCameraSystem` (incl. split-screen 1–4 and WebXR)
- Input → `InputController`; `MobileInputController` for touch
- Audio → `AudioSource`
- Multiplayer → the Colyseus stack

The Toolkit also ships **higher-level controllers** — `StandardPlayerController` /
`ThirdPersonPlayerController` / `TOOLKIT.CharacterController` for characters, and the **RacingSystem**
(`StandardCarController` and friends) for vehicles. **These are a menu, not a mapping**, and each
ships with a DEFAULT FEEL that may not be the one asked for: the RacingSystem's defaults are a
simulation raycast vehicle (6-speed gearbox, Ackermann steering, tyre slip, speed-scaled understeer),
so it is a sim/street racer out of the box. It is also **heavily tunable** — its reference document
has a "Tuning toward arcade / kart handling" section — so the question is never "is this the racing
class?" but "does its feel, as configured, match what was asked for?"

**The request decides how the game FEELS; the Toolkit decides what it runs ON.** Handling, movement
and game rules are the design the user asked for, not a wheel to avoid reinventing. Use a built-in
controller when it genuinely matches the request, build on top of one when it is close, and author
your own movement over `RigidbodyPhysics` when the request wants something it does not do. **None of
those three is a defect**, and picking a controller that fights the requested feel is the real one.

**If you intend to use one of these systems, LOAD ITS REFERENCE FIRST.** This section names the
classes; it does not teach them, and you cannot write their API from memory — an invented method is
worse than not using the system at all. Your reference budget is small, so decide early and spend it
on what you will actually write against. **If you cannot load the document you need, do not half-use
the system from memory: author that part yourself over `RigidbodyPhysics` / `ScriptComponent`
instead, and say which system you skipped and why in your closing summary.** A working thing you
wrote beats a broken call into a system you were guessing at.

## Demo assets are an EXAMPLE, never a default

The reference documents and the classes in `src/babylon/classes/` teach APIs using specific playground
models and scenes — `riggedmustang`, `openterrain`, `samplescene`, and others, loaded from
`repo.babylontoolkit.com/playground/`. **Copy the technique; never ship the demo's car, character or
level unless the user asked for that exact thing.** A request for a kart racer is not a request for a
Mustang on an open-terrain test map, and a doc that demonstrates a controller by driving a sports car
is showing you the wiring, not the game.

If the request names no assets and no asset-library block is present in your context, build the
game's **own** content — its track, its vehicle, its characters, its environment — from primitives,
procedural geometry and materials you author, themed to the request. A recognisable stand-in you made
is always better than the wrong model loaded from a demo.

## CODE ARCHITECTURE — build it like a Unity project

The Toolkit is a Unity-style component framework. Architect the project the way you would a Unity one:
**`ScriptComponent` is this framework's `MonoBehaviour`, and plain TypeScript classes are everything
else.** You need both, and using the wrong one for a job is the mistake to avoid in either direction.

### The lifecycle

A `ScriptComponent` is constructed with the transform it is attached to
(`constructor(transform, scene, properties?, alias?)`) and is registered with
`SceneManager.RegisterClass("Name", Name)`. It then overrides **only the hooks it needs** — they are
opt-in `protected` methods, exactly like Unity's magic methods:

| Hook      | When                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `awake`   | Once, on attach. Wire references. The scene may not be fully built yet.     |
| `start`   | Once, before the first `update`. Everything else exists by now.             |
| `ready`   | Once, after the scene is fully ready.                                       |
| `update`  | Every frame. The main behaviour hook.                                       |
| `late`    | Every frame, after all `update`s. Cameras that follow a target belong here. |
| `step`    | Physics step.                                                               |
| `fixed`   | Fixed timestep. Force/velocity work belongs here.                           |
| `after`   | After the physics step.                                                     |
| `destroy` | On dispose. Unhook anything you hooked.                                     |

**`update()` takes no arguments** — ask the component for time (`this.getDeltaSeconds()`,
`this.getDeltaTime()`, `this.getAnimationRatio()`). Components find each other through the framework
(`this.getComponent<T>("ClassName")`, `this.getComponents<T>`, `this.getChildWithScript`), and reach
their own node through `this.transform` and `this.scene`.

**Declare only the hooks you actually use.** An empty override still gets registered and called every
frame; delete the ones you do not need rather than leaving them stubbed.

**`src/babylon/classes/` is the worked reference for all of this — read it before you write.**
`DefaultGameMode.ts` is the lifecycle showcase (every hook, in order, with what each is for);
`FreeCameraMode.ts` is a minimal controller; `PlayerControllerDemo.ts` and `VehicleControllerDemo.ts`
show `createScene()`, loading a prefab through `SceneManager.LoadRuntimeAssets`, and resolving nodes out
of the loaded result. Copy the PATTERNS from these; the folder itself is read-only, so copy a class into
`src/scripts/` before changing it (and rebase its imports — see the file-zone table).

### Which one to write

**Use a `ScriptComponent` when the thing IS a game object, or needs the lifecycle** — it is attached to
a transform in the scene, or it needs per-frame/physics ticks, collision and trigger events, or click
actions. The player kart, the AI driver, the camera rig, the item box, the race manager.

**Use a regular class for ordinary OOP** — encapsulation, inheritance, and logic that does not live on a
node and does not need a tick. Track geometry and racing-line math, tuning tables and data models,
factories and builders, state machines, scoring rules, pathfinding, save data. These are normal
TypeScript classes with constructors, private fields and methods, and a component owns and drives them.

The test is simply: **does it hang off a node in the scene, or does it need the engine to tick it?** If
yes, `ScriptComponent`. If no, a plain class — and making it a component anyway is just as wrong, since
it forces an empty transform into the scene for something that is only logic.

What is NOT acceptable is a plain class with a hand-rolled `tick(dt)` that some other class calls every
frame to simulate a game object. That reimplements the framework badly: use `update()` and
`getDeltaSeconds()`.

### Imported scenes already have their components — FIND them, do not re-create them

A glTF exported from Unity carries its component setup in metadata, and the Toolkit's glTF parser
**instantiates those `ScriptComponent`s automatically** as the scene loads. So a node from an imported
scene arrives with its scripts already attached and already registered, exactly as a prefab does in
Unity. Your job is to get a reference to what is there.

- **On a transform you already have:** `SceneManager.GetComponent<T>(transform, "ClassName")`, or
  `SceneManager.GetComponents<T>(transform)` for all of them. From inside a component, the instance
  forms are shorter: `this.getComponent<T>("ClassName")` and `this.getComponents<T>("ClassName")`.
- **Searching the scene:** `SceneManager.FindTransformWithScript(scene, "ClassName")` and
  `FindAllTransformsWithScript(scene, "ClassName")` — the `FindObjectOfType` equivalents. By name or
  tag: `FindGameObject(scene, path)`, `FindGameObjectWithTag(scene, tag)`, `FindGameObjectsWithTag`.
- **Searching under a node:** `this.getChildWithScript("ClassName")` / `getChildrenWithScript`, or
  `getChildWithTags` / `getChildrenWithTags`; the static forms are
  `SceneManager.FindChildTransformWithScript(parent, klass, …)` and `FindAllChildTransformsWithScript`.
- **Exported inspector values ride along.** A component authored in Unity keeps its serialized property
  values; read them with `this.getProperty<T>("speed", 10)`, and `SceneManager.FindSceneMetadata(transform)`
  for the raw node metadata.

**Never `new` a `ScriptComponent` yourself to "attach" behaviour to an imported node, and never rebuild
in code what the export already describes.** Doing so gives you a second, unregistered instance that the
lifecycle never drives — its `update()` simply never runs, with no error to explain why. Resolve
references in `start()` rather than `awake()` when they point at other objects: `awake` runs while the
scene is still being assembled, so the thing you are looking for may not exist yet.

### Decomposition

**One responsibility per class, one class per file.** A single 40,000-character GameMode that builds the
track, drives the player, runs the AI, manages the camera and owns the HUD is a defect — split it
(`TrackBuilder`, `KartController`, `KartAIController`, `KartCameraManager`, `RaceManager`, …).

**Game flow lives in the GameMode / `SceneController`**, wired through unified navigation; a
`SceneController` is a `ScriptComponent` that builds the scene in `createScene()`. **Never do ad-hoc
scene bootstrapping** or put game logic outside these constructs unless asked.

### The UI holds NO game code — and "no game code" includes DATA

`src/pages/**` and `src/components/**` are the landing page and menus. The rule that React must not
import `GameManager` or Babylon is about the BUNDLE. This rule is about OWNERSHIP, and it is separate:

- **No gameplay data or tuning in the UI.** Rosters, stats, physics numbers, track definitions, item
  tables, difficulty curves — these belong to the game, in `src/scripts/**`. A `const KARTS = [{ name,
stats: { speed, accel, drift } }]` sitting in `Home.tsx` means the landing page and the game each own
  half the truth, and they drift the moment either is edited.
- **No gameplay state in the UI.** No simulation, no per-frame work, no game rules.
- **Selections travel in the navigation state ONLY.** `navigate('/play', { gameMode, ...selections })`
  is the entire channel. Never write choices to `sessionStorage`/`localStorage`/globals for the game to
  read behind the contract — a side channel the play contract does not cover is a bug that survives
  every test of the contract itself.

If the landing page needs to show the roster, the roster is exported from `src/scripts/**` and
imported by the page as **data** — one definition, owned by the game, displayed by the UI.

## FILE ZONES — read-only means read-only

| Zone                                | Rule                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/scripts/**`                    | **The write zone.** ALL project game code — GameModes and Script Components — is authored here.                                                |
| `src/pages/**`, `src/components/**` | The frontend. Fully yours to redesign.                                                                                                         |
| `src/chrome/**`                     | The game's **chrome** — splash screen, preloader, in-game overlay. Yours to redesign (keep the wiring — see "Chrome rewrites").                |
| `src/babylon/classes/**`            | **READ-ONLY** demo/source library. Copy FROM it; never edit it. To change a demo class, copy it into `src/scripts/` first, then edit the copy. |
| `src/babylon/system/**`             | **READ-ONLY** framework internals.                                                                                                             |
| `app.tsx`, `src/routing/**`         | **READ-ONLY** routing shell.                                                                                                                   |

**Importing the game manager (`GameManager` / globals) — a recurring build break.** It lives at
`src/babylon/globals.ts`. Game code in the write zone imports it by the path **relative to where the
file actually sits**:

- From `src/scripts/` (your GameModes and Script Components): `import GameManager from '../babylon/globals';`
- From `src/chrome/` (the chrome): `import GameManager from '../babylon/globals';`
- From `src/babylon/classes/` (inside the framework folder, one level from `globals.ts`): `import GameManager from '../globals';`

**When you COPY a demo class from `src/babylon/classes/` into `src/scripts/`, you MUST fix this import** —
`'../globals'` becomes `'../babylon/globals'`, and correct any other `'../…'` path that assumed the
`classes/` location. A stale `'../globals'` in `src/scripts/` resolves to `src/globals`, which does not
exist, and Vite fails the build with `Failed to resolve import "../globals"`.

## THE PLAY CONTRACT — never break, stub, or bypass this

Gameplay is entered **only** through:

```ts
navigate('/play', { gameMode: 'YourModeClassName', sceneUrl: 'optional/scene.gltf' /* ...selections */ });
```

- `gameMode` must name a **registered** GameMode class.
- Extra configuration (track choice, car choice, difficulty…) rides in that same NavigationState
  object. It is sessionStorage-backed. **Never move it into the URL.**
- **React UI code must use `useUnifiedNavigation`, and must NEVER import `GameManager` or any Babylon
  module.** Importing Babylon from UI code drags the entire Babylon runtime into the main bundle and
  destroys load time. Babylon imports belong inside the lazy `/play` chunk only.
- Game code in `src/scripts/` uses `GameManager.NavigateTo`.
- The frontend around this is fully redesignable — a landing page, a track/car select screen, an
  options menu, a "Start Race" button that computes mode + scene from the user's choices, or even a
  landing page with no play button at all. **The `navigate('/play', …)` call itself is the one thing
  that must always survive.**

## BUILD ORDER — the front end comes FIRST, the game LAST

**On a first build-out, write the frontend shell before you write the game**, in this order:

1. **Decide the design, then render its art** — make every `generate_image` call in ONE round, before
   you write any files, and wire the returned paths in as you go.
2. **The landing page** — `src/pages/Home.tsx` + `Home.css` (see "Landing-page rewrites" and the
   Layout law below).
3. **The chrome** — `src/chrome/**`: preloader, splash, overlay (see "Chrome rewrites" below).
4. **The game** — the GameMode and Script Components in `src/scripts/**`.

This is a reliability rule, not a matter of taste. **Your reply has a hard length limit, and whatever
you write LAST is what gets cut off** — mid-file, mid-tag, closing `</boltAction>` missing, several
files welded into one broken file. The front end is a KNOWN, bounded amount of work: one page and
three chrome files, much the same size whatever the game is. The game is not — it grows without limit
with the request, and you cannot know before you start how much room it will need. So spend the fixed
cost first, where it is certain to fit and certain to land intact, and let the open-ended work take
whatever room is left.

It also fails better. Finish the front end and run short on the game, and the user is one prompt from
done, with everything already written intact on disk. Spend it all on the game and get cut off part
way through the landing page, and you leave a file that does not compile sitting on top of a game
nobody can reach.

**This order works because the GameMode class already exists.** The platform scaffolded a registered
GameMode into `src/scripts/` when the project was created — read its real class name off that file
(never invent one), and wire `navigate('/play', { gameMode: 'ThatClass' })` from the landing page
before you have written a line of gameplay. That same file is then the one you fill in at step 4.

Treat the front end you just wrote as the **specification for the game**: whatever the landing page
promises — the modes, the tracks, the pickups, the scoring — is what the game then has to deliver.

**On a NARROW request** ("add an FPS counter", "fix the boost pads") none of this applies: there is no
front end to write and no order to keep. Do only what was asked.

## Landing-page rewrites

**When a project is FIRST BUILT OUT** — the first build turn on a freshly created project, or any
later turn where the user explicitly asks for a redesign — `src/pages/Home.tsx` and `Home.css` are
**overwritten from scratch**, designed for that specific game. Nothing from the starter page survives:
no hero, no demo buttons, no Vite/React/Babylon links, no footer, and **no Toolkit or BabylonJS
attribution or branding of any kind**.

**On any other turn, leave the landing page alone.** A narrow request ("add an FPS counter", "fix the
boost pads") touches only what it names — a redesign nobody asked for is destructive, not generous.

Carry forward only the navigation **pattern** (`useUnifiedNavigation` → the play contract) — never its
markup, copy, or links. Use whichever starter images the new design calls for and simply don't import
the rest. **Never delete image files from disk** — unused assets stay, and `public/babylon.png` +
`public/spinner.png` are framework-required.

**Zero unresolved imports after any rewrite.** If you remove a component, remove every import of it.

## Layout law — full-bleed by default, ALWAYS responsive (NON-NEGOTIABLE)

These two rules bind **every** UI surface you write or restyle — the landing page (`src/pages`,
`src/components`), the game chrome (`src/chrome/**`), menus, HUDs, dialogs, every screen. They
are not stylistic preferences; a design that breaks either is a **defect**, the same as an unresolved
import.

1. **FULL-PAGE-WIDTH BY DEFAULT.** The design fills the entire viewport width edge to edge. Do **not**
   wrap the page in a centered fixed-width column (`max-width: 1200px; margin: 0 auto`, a Bootstrap
   `.container`, `width: 960px`, etc.). Root/section containers use **`width: 100%`** and stretch to
   the edges (not `100vw` — see rule 2: it includes the scrollbar gutter and overflows);
   backgrounds, heroes, and nav bars are **full-bleed**. Inner _content_ may
   still be constrained for readability (a text column with a `max-width` and auto margins **inside** a
   full-bleed section is fine and encouraged) — but the section, its background, and the overall page
   are edge-to-edge. **Only build a fixed-width / boxed layout when the user explicitly asks for one**
   ("make it a fixed-width / boxed / centered-column layout"). Absent that instruction, full-bleed wins
   every time.

2. **ALWAYS RESPONSIVE — no exceptions.** Every layout must adapt cleanly from a small phone
   (≈320px wide) up to a large desktop (≈2560px) with **nothing clipped, overlapping, or
   overflowing** at any width. This means:
   - **`box-sizing: border-box` on everything.** This is the single most common cause of a
     generated page whose right-hand content is sliced off. Under the default `content-box`, a
     container written `width: 100%` with `padding: 14px 44px` measures **100% + 88px** — so a
     full-width bar extends past the viewport, its right-hand cluster (nav pills, a status row,
     an action button) lands outside the visible area, and `flex-wrap` never fires because the
     layout believes it has room it does not have. The starter's `src/index.css` carries a global
     `*, *::before, *::after { box-sizing: border-box }` reset — **keep it**, and if you write a
     stylesheet that could load without it, declare it yourself. Never assume it is present
     because the page "looks right" on your first mental pass; it is invisible until the content
     is wide enough to reach the edge.
   - Size with **relative/fluid units** — `%`, `vw`/`vh`/`dvh`, `rem`, `fr`, `min()`/`max()`/`clamp()`
     — never a page built out of fixed `px` widths. Fluid type via `clamp()` is preferred over a fixed
     `font-size`.
   - Lay out with **flexbox or CSS grid** that reflows (`flex-wrap`, `grid-template-columns:
repeat(auto-fit, minmax(...))`), not absolute positioning or fixed columns that assume one width.
   - Add **`@media` breakpoints** wherever the layout needs to restack (multi-column → single column on
     mobile, larger tap targets, a collapsed/hamburger nav if the nav is wide).
   - Media/canvas: `img`/`video`/`canvas` get `max-width: 100%` and never a hard pixel width that can
     exceed the viewport. Any wide element that could overflow (a code block, a table, a wide row) sits
     in its own `overflow-x: auto` container so the **page body never scrolls sideways**.
   - **Never put `overflow-x: hidden` (or `clip`) on `html`, `body`, or the page root.** It does not
     fix overflow, it _conceals_ it: the offending content is clipped rather than clipped-and-
     scrollable, so it becomes permanently unreachable, and `scrollWidth` then reports the clipped
     width — meaning the page claims it has no horizontal overflow while it is destroying content.
     Fix the element that is too wide instead. Scope `overflow-x` to the one scroller that needs it.
   - **`100vw` is not "the viewport width."** It _includes_ the vertical scrollbar gutter, so
     `width: 100vw` / `min-width: 100vw` on a page that scrolls vertically is reliably ~15px wider
     than the visible area. For anything inside the document flow use `width: 100%`; reserve `vw`
     units for genuinely viewport-relative sizing (`clamp()` type, spacing), never for the width of
     a root or section container.
   - The starter ships a `<meta name="viewport" content="width=device-width, initial-scale=1">` — keep
     it; never remove or override it.

   Responsiveness is **not** an optional polish pass or a "later" step — the design is responsive in the
   same generation that creates it. A layout that only looks right at one width has not met the bar.

   **The check that must pass:** at every width, `document.documentElement.scrollWidth` equals its
   `clientWidth`. Verify it by _reading the stylesheet you just wrote_, element by element, for the
   two failures above — a padded `width: 100%`/`100vw` container, and any root-level `overflow-x`
   that would make the check vacuously true. "It renders fine" is not a check; a page that is
   silently clipping content renders fine.

## Chrome rewrites — splash, preloader, overlay (do ALL THREE, not just the overlay)

The landing page is not the only starter surface. On the same first-build-out turn (or an explicitly
requested redesign) you redesign the game's **chrome** in `src/chrome/**` to match that same design —
and on any other turn you leave it alone, exactly like the landing page. **This is FIVE required
files, and it is easy to do only the overlay and stop — do not.** The splash and preloader are the two that ship with the **Babylon
logo and spinner**, so skipping them leaves BabylonJS branding sitting in the user's game (§2.3) — the
exact thing the landing-page rewrite exists to prevent. Restyle freely, but keep each one's wiring,
because all three are functional:

1. **Preloader** — `src/chrome/loading.tsx`. The first thing shown, before the app mounts.
   Currently the Babylon logo + "Downloading…". Rethemed to the game. It **re-exports `babylonLogo` /
   `spinnerLogo`** that `splash.tsx` imports — if you rewrite it, keep those exports (or update
   `splash.tsx`'s import). Never delete `public/babylon.png` / `public/spinner.png` — framework-required,
   whatever your design shows.
2. **Splash / loading screen** — `src/chrome/splash.tsx` + `splash.css`. Shown while the 3D scene
   loads. Currently the Babylon logo + spinner. Rethemed to the game, but **keep the `GameManager.EventBus`
   `"OnLoadProgress"` subscription and its status text** — that is real load progress, not decoration.
3. **Initial overlay** — `src/chrome/overlay.tsx` + `overlay.css`. The in-game HUD layer. A
   minimal, themed starting point (a title/brand corner, a frame) — the full HUD grows later with the
   gameplay. **Keep `pointer-events: none` on the container** so driving/input reaches the canvas; make
   only genuinely interactive elements `pointer-events: auto`.

`src/chrome/**` runs in the viewer context, so it MAY import `GameManager`/`EventBus` for game
data and `useUnifiedNavigation` for navigation (unlike `src/pages`/`src/components`, which stay
Babylon-free) — it sits OUTSIDE the framework folder, so its framework imports go through
`'../babylon/…'`: `import GameManager from '../babylon/globals'`, `'../babylon/system/platform'`;
its bundled logo imports come from `'../assets/…'` (`src/assets/`). Same discipline as the landing
page: zero unresolved imports, no Toolkit/BabylonJS branding, and never delete image files from disk.

## Read the whole request

Read the user's prompt for **frontend / landing-page intent, not just gameplay intent**, and honor
both. "A neon cyberpunk racer" is a statement about the menus and the title screen too.
