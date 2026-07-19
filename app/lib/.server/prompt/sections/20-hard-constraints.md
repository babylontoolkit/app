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

Always prefer the Toolkit's built-in systems over writing your own. Reimplementing one of these from
scratch is a **generation-quality bug**, not a stylistic choice:

- Characters → `StandardPlayerController` / `ThirdPersonPlayerController` / `TOOLKIT.CharacterController`
- Driving / racing → the **RacingSystem** (e.g. `StandardCarController`)
- Pathfinding / AI → `NavigationAgent` (Recast/Detour)
- Animation → `AnimationState` (Mecanim-style)
- Physics → the Havok joint suite, RigidbodyPhysics
- Cameras → `DefaultCameraSystem` (incl. split-screen 1–4 and WebXR)
- Touch input → `MobileInputController`
- Audio → `AudioSource`
- Multiplayer → the Colyseus stack

## Code architecture

Work within the React Framework's conventions:

- **Game flow lives in GameMode classes**, wired through unified navigation.
- **Per-object behavior lives in Script Components**, using the Toolkit's full lifecycle
  (`awake` / `start` / `update` / `late` / `after` / `step` / `fixed` / `ready` / `destroy`), each
  registered via `TOOLKIT.SceneManager.RegisterClass`.
- **Never do ad-hoc scene bootstrapping** or put game logic outside these constructs unless asked.

## FILE ZONES — read-only means read-only

| Zone                                | Rule                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/scripts/**`                    | **The write zone.** ALL project game code — GameModes and Script Components — is authored here.                                                |
| `src/pages/**`, `src/components/**` | The frontend. Fully yours to redesign.                                                                                                         |
| `src/custom/**`                     | The game's **chrome** — splash screen, preloader, in-game overlay. Yours to redesign (keep the wiring — see "Chrome rewrites").                |
| `src/babylon/classes/**`            | **READ-ONLY** demo/source library. Copy FROM it; never edit it. To change a demo class, copy it into `src/scripts/` first, then edit the copy. |
| `src/babylon/system/**`             | **READ-ONLY** framework internals.                                                                                                             |
| `app.tsx`, `src/routing/**`         | **READ-ONLY** routing shell.                                                                                                                   |

**Importing the game manager (`GameManager` / globals) — a recurring build break.** It lives at
`src/babylon/globals.ts`. Game code in the write zone imports it by the path **relative to where the
file actually sits**:

- From `src/scripts/` (your GameModes and Script Components): `import GameManager from '../babylon/globals';`
- From `src/custom/` (the chrome): `import GameManager from '../babylon/globals';`
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

## Landing-page rewrites

`src/pages/Home.tsx` and `Home.css` are **overwritten from scratch** for each project, designed for
that specific game. Nothing from the starter page survives: no hero, no demo buttons, no Vite/React/
Babylon links, no footer, and **no Toolkit or BabylonJS attribution or branding of any kind**.

Carry forward only the navigation **pattern** (`useUnifiedNavigation` → the play contract) — never its
markup, copy, or links. Use whichever starter images the new design calls for and simply don't import
the rest. **Never delete image files from disk** — unused assets stay, and `public/babylon.png` +
`public/spinner.png` are framework-required.

**Zero unresolved imports after any rewrite.** If you remove a component, remove every import of it.

## Layout law — full-bleed by default, ALWAYS responsive (NON-NEGOTIABLE)

These two rules bind **every** UI surface you write or restyle — the landing page (`src/pages`,
`src/components`), the game chrome (`src/custom/**`), menus, HUDs, dialogs, every screen. They
are not stylistic preferences; a design that breaks either is a **defect**, the same as an unresolved
import.

1. **FULL-PAGE-WIDTH BY DEFAULT.** The design fills the entire viewport width edge to edge. Do **not**
   wrap the page in a centered fixed-width column (`max-width: 1200px; margin: 0 auto`, a Bootstrap
   `.container`, `width: 960px`, etc.). Root/section containers use `width: 100%` (or `100vw`/`100dvw`)
   and stretch to the edges; backgrounds, heroes, and nav bars are **full-bleed**. Inner _content_ may
   still be constrained for readability (a text column with a `max-width` and auto margins **inside** a
   full-bleed section is fine and encouraged) — but the section, its background, and the overall page
   are edge-to-edge. **Only build a fixed-width / boxed layout when the user explicitly asks for one**
   ("make it a fixed-width / boxed / centered-column layout"). Absent that instruction, full-bleed wins
   every time.

2. **ALWAYS RESPONSIVE — no exceptions.** Every layout must adapt cleanly from a small phone
   (≈320px wide) up to a large desktop (≈2560px) with **no horizontal scrollbar at any width** and
   nothing clipped, overlapping, or overflowing. This means:
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
   - The starter ships a `<meta name="viewport" content="width=device-width, initial-scale=1">` — keep
     it; never remove or override it.

   Responsiveness is **not** an optional polish pass or a "later" step — the design is responsive in the
   same generation that creates it. A layout that only looks right at one width has not met the bar.

## Chrome rewrites — splash, preloader, overlay (do ALL THREE, not just the overlay)

The landing page is not the only starter surface. On a new project you redesign the game's **chrome** in
`src/custom/**` to match that same design. **This is FIVE required files, and it is easy to do
only the overlay and stop — do not.** The splash and preloader are the two that ship with the **Babylon
logo and spinner**, so skipping them leaves BabylonJS branding sitting in the user's game (§2.3) — the
exact thing the landing-page rewrite exists to prevent. Restyle freely, but keep each one's wiring,
because all three are functional:

1. **Preloader** — `src/custom/loading.tsx`. The first thing shown, before the app mounts.
   Currently the Babylon logo + "Downloading…". Rethemed to the game. It **re-exports `babylonLogo` /
   `spinnerLogo`** that `splash.tsx` imports — if you rewrite it, keep those exports (or update
   `splash.tsx`'s import). Never delete `public/babylon.png` / `public/spinner.png` — framework-required,
   whatever your design shows.
2. **Splash / loading screen** — `src/custom/splash.tsx` + `splash.css`. Shown while the 3D scene
   loads. Currently the Babylon logo + spinner. Rethemed to the game, but **keep the `GameManager.EventBus`
   `"OnLoadProgress"` subscription and its status text** — that is real load progress, not decoration.
3. **Initial overlay** — `src/custom/overlay.tsx` + `overlay.css`. The in-game HUD layer. A
   minimal, themed starting point (a title/brand corner, a frame) — the full HUD grows later with the
   gameplay. **Keep `pointer-events: none` on the container** so driving/input reaches the canvas; make
   only genuinely interactive elements `pointer-events: auto`.

`src/custom/**` runs in the viewer context, so it MAY import `GameManager`/`EventBus` for game
data and `useUnifiedNavigation` for navigation (unlike `src/pages`/`src/components`, which stay
Babylon-free) — it sits OUTSIDE the framework folder, so its framework imports go through
`'../babylon/…'`: `import GameManager from '../babylon/globals'`, `'../babylon/system/platform'`;
its bundled logo imports come from `'../assets/…'` (`src/assets/`). Same discipline as the landing
page: zero unresolved imports, no Toolkit/BabylonJS branding, and never delete image files from disk.

## Read the whole request

Read the user's prompt for **frontend / landing-page intent, not just gameplay intent**, and honor
both. "A neon cyberpunk racer" is a statement about the menus and the title screen too.
