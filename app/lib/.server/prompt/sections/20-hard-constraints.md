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
| `src/babylon/classes/**`            | **READ-ONLY** demo/source library. Copy FROM it; never edit it. To change a demo class, copy it into `src/scripts/` first, then edit the copy. |
| `src/babylon/system/**`             | **READ-ONLY** framework internals.                                                                                                             |
| `app.tsx`, `src/routing/**`         | **READ-ONLY** routing shell.                                                                                                                   |

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

## Read the whole request

Read the user's prompt for **frontend / landing-page intent, not just gameplay intent**, and honor
both. "A neon cyberpunk racer" is a statement about the menus and the title screen too.
