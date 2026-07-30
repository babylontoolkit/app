# spec/wizard-config.md — Guided Tour Wizard (governs SPEC §4.7)

The wizard is data-driven: `app/config/wizard.json` (versioned in git; editable without code changes). Steps: game type → vibe → mechanics → twist → a compiled prompt. Since 2026-07-29 (SPEC §4.4a) that prompt is **prefilled, not fired**: the wizard's last act is a created, installed, running project with text in the chat box, and the user's send is the build.

## Config schema (informal)

See the starter catalog below — it doubles as the schema example. Structure: `genres[]` (each with `registryId`, card copy, and `mechanics[]`), shared `crossGenre[]` toggles available in every genre, and `vibes[]`. Every mechanic carries: `id`, `label`, `fragment` (the compiled prompt text), `backing` (the Toolkit system that fulfills it — the batteries-included rule anchor), and optional `requires` (gating, e.g. a connected Game Backend).

## Starter catalog (launch `wizard.json` content, v1)

Authoring rules: 6–8 mechanics per genre MAX; every checkbox is a reliability promise — each must be anchored to a built-in Toolkit system, and each should eventually be backed by a skill or training example (backlog noted per item). Copy is for non-developers: no class names on cards.

### Cross-genre toggles (`crossGenre[]`, shown in every genre)

| id | Label | Backing system | Notes |
|---|---|---|---|
| `mobile-controls` | Play on phones (touch controls) | `MobileInputController` | Makes shared game phone-playable |
| `splitscreen` | Split-screen local co-op (2–4 players) | `DefaultCameraSystem.SetMultiPlayerViewLayout` | |
| `leaderboard` | Online leaderboard | Game Backend (§4.15) + `leaderboards` skill | `requires: gameBackend`; hidden until backend connected |
| `score-hud` | Score & timer on screen | UserInterface / GamePatterns HUD | |
| `audio` | Music & sound effects | `TOOLKIT.AudioSource` | |
| `menus` | Pause menu & game-over screen | UserInterface patterns | |
| `polish` | Visual polish (glow, particles) | DefaultRenderingPipeline + ShurikenParticles | |
| `gamepad` | Gamepad support | `TOOLKIT.InputController` | Near-free; strong perceived value |

### Genre: Third-Person Adventure (`gm_adventure_v1`)
Card: "Explore a 3D world" · Backing controller: `StandardPlayerController` (+AnimationState, CharacterController)

| id | Label | Backing |
|---|---|---|
| `double-jump` | Double jump | controller jump properties |
| `sprint` | Sprint | run/walk speeds + sprint binding |
| `climb-vault` | Climb & vault over ledges | built-in climb system (`useClimbSystem`, Climb/Vault volumes) |
| `pickups` | Collectible pickups with counter | pickups pattern (skill backlog) |
| `enemies` | Patrolling enemies | `NavigationAgent` + GamePatterns AI enemy |
| `health` | Health & damage | GamePatterns PlayerHealth |
| `checkpoints` | Checkpoints & respawn | pattern (skill backlog) |

### Genre: Racing (`gm_racing_v1`)
Card: "Arcade racing" · Backing: RacingSystem (doc 13) — Need-for-Speed-style out of the box

| id | Label | Backing |
|---|---|---|
| `laps` | Lap counter & race timer | RacingSystem |
| `boost` | Boost pads | RacingSystem |
| `drift` | Drift handling | RacingSystem |
| `ai-racers` | AI opponents | RacingSystem + NavigationAgent |
| `minimap` | Minimap | RacingSystem pattern |
| `race-menus` | Countdown, results screen | UserInterface patterns |

### Genre: First-Person Explorer (`gm_fps_explorer_v1`)
Card: "See through your character's eyes" · Backing: `StandardPlayerController` (first-person view)

| id | Label | Backing |
|---|---|---|
| `sprint-jump` | Sprint & jump | controller properties |
| `interact` | Look-at interaction prompts | raycast + UI pattern (skill backlog) |
| `pickups` | Collectibles | pickups pattern |
| `doors` | Doors & switches | FixedHingeJoint + trigger volumes |
| `footsteps` | Footstep & ambient audio | AudioSource |

### Genre: Physics Playground (`gm_physics_v1`)
Card: "Stack it, smash it, swing it" · Backing: RigidbodyPhysics (Havok) + joint suite

| id | Label | Backing |
|---|---|---|
| `stacks` | Destructible stacks | RigidbodyPhysics |
| `ragdoll` | Ragdoll characters | BallSocket/Hinge/Sixdof joints |
| `swings` | Swinging & hanging objects | Hinge/Distance joints |
| `levers` | Levers & sliding platforms | Slider/Prismatic joints |
| `grab` | Click-and-throw objects | raycast + impulse pattern (skill backlog) |

### Deliberately NOT in v1
Online multiplayer (Colyseus server scoping — SPEC open question #17); WebXR/VR (post-launch candidate); any mechanic without a built-in backing system.

### Vibes (`vibes[]`, unchanged mechanism)
Sunset Arcade · Neon Night · Low-Poly Daylight · Moody Fog — each mapping to skybox/lighting/post-process configs from the training examples.

## Compile algorithm

> ⚠️ **Revised 2026-07-29 (SPEC §4.4a — creation is a clone).** The wizard no longer produces a message that is *sent*; it produces a project that is *running* and text sitting in the chat textbox. Steps 1 and 2 are unchanged as compilation; steps 3 and 4 changed. Step 2's output no longer travels as the visible message — it rides HIDDEN with the creation brief (see step 3).

1. Create project from the universal starter; wire the registry entry's GameMode + optional sceneUrl, install dependencies and start the dev server. **No model is contacted** — the wizard's four steps decide what to clone and what to prefill, nothing more.
2. Compile the prompt = `compiled.preamble` + vibe fragment + selected mechanics fragments (as a numbered task list) + wrapped twist (if any). `compileWizardPrompt(selection)`; it is seeded onto `projectSeedStore.prompt`.
3. Show the user a friendly summary ("<Genre> · <Vibe> · <Mechanics> · '<twist>'", `summarizeSelection`). ⚠️ **It is the SUMMARY, not the compiled prompt, that is carried into the textbox** — `draftTextForSeed` prefers the seed's `visiblePrompt`, a rule written for Path A (where the visible string is the user's own typing) and inherited here. **The compiled fragments therefore ride HIDDEN, appended to the creation brief** under a *"The user's guided-tour selections"* heading (`Chat.client.tsx`, pinned by `new-project-mode-wiring.spec.tsx`) — machine-written text travels the way machine-written text travels here, subordinate to whatever the user actually sends. That was briefly a flagged product call and it is now BUILT; the alternative — swapping the preference so the box holds the compiled text — stays rejected, because it puts a wall of machine-composed task list in a box the user is expected to read and edit.
4. Drop into the builder with the **stock starter running** and that text in the box, in New Project mode. Sending it is the build turn, and it carries the hidden creation brief (§4.4a). Target: **< 90s from wizard completion to a running starter** — restated deliberately, because first-playable now sits behind a user decision plus a per-token generation and is no longer a number the platform alone controls. Measure the two separately.

## Rules

- Fragments must reference known Toolkit patterns (ideally ones covered by training examples or skills) — the wizard's whole point is keeping first builds on well-trodden paths. The fragments reach the model on the hidden half of the first build turn (step 3), so this binds as written.
- A mechanic that consistently produces broken first passes gets fixed or pulled from config — check the analytics funnel (wizard completion → first-build success rate per mechanic). ⚠️ That join is not currently measurable: the funnel has no event between `project_created` and `generation_started` (SPEC §5A), so wizard completion cannot be tied to the build turn it prefilled.
- Config is validated at boot (ids unique, registryIds exist in game_registry, fragments non-empty); invalid config falls back to last-known-good and alerts.
- Copy tone: for non-developers; no jargon on cards.
- Items marked *(skill backlog)* above must gain a skill or training example in the content repos before or shortly after the mechanic ships — a checked box that generates broken code is worse than no box.
