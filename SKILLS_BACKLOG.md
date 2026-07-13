# SKILLS_BACKLOG.md — Wizard-Backing Skills To Author

**Destination: `github.com/babylontoolkit/skills` (NOT the app-builder repo).** This is content work, unblocked today — no platform code required. Each skill below backs one or more wizard checkboxes (spec/wizard-config.md); authoring it upgrades that checkbox from "agent improvises" to "agent loads the proven pattern."

Format: agentskills.io bundles — folder + `SKILL.md` with `name`/`description` frontmatter + body (≤ ~5,000 tokens) + optional `references/`. **The `description` is the trigger** — the model decides to load a skill from it alone, so descriptions state what it does AND when to use it. Draft frontmatter below is a starting point; tune after watching real trigger behavior (`generations.skills_loaded`).

Test each skill in Claude Code against the StarterAssets project before considering it done — the same skill serves Claude Code, Cursor, and the platform unchanged.

---

## Priority 1 — backs launch checkboxes with no built-in system

### `leaderboards`
```yaml
name: leaderboards
description: Implement online leaderboards, high-score tables, or score submission for a Babylon Toolkit game using the player's connected Supabase Game Backend. Use whenever a game needs persistent scores, rankings, or best-times across players or sessions.
```
Body covers: RLS-FIRST schema (scores table + policies — anon key ships in client code, so RLS is non-negotiable and the SQL the user must run comes first); a `LeaderboardManager` Script Component (submit score, fetch top N, fetch player rank) using supabase-js; GameMode wiring (submit on race/level end); simple HUD list via the UI patterns; offline/failure fallback (queue + retry, never block gameplay).

### `pickups`
```yaml
name: pickups
description: Add collectible pickups, coins, stars, or power-ups to a Babylon Toolkit game — spawn placement, collection detection, counter HUD, respawn rules, and collect effects. Use for any "collect N things" mechanic.
```
Body covers: a `Pickup` Script Component (trigger-volume overlap with the player, collect event via `SceneManager.EventBus`, sound via AudioSource, particle/scale-out effect); a `PickupCounter` HUD component subscribing to the event; GameMode win-condition hook ("all collected"); prefab-friendly pattern (works when the pickup is an instantiated container prefab).

### `checkpoints`
```yaml
name: checkpoints
description: Add checkpoints, respawn points, and fall/death respawn handling to a Babylon Toolkit game. Use when the player should restart from progress points after falling, dying, or resetting.
```
Body covers: `Checkpoint` Script Component (trigger volume, stores spawn transform, activation feedback); `RespawnManager` (kill-Y plane / death event → teleport via `TOOLKIT.CharacterController.set/teleport`, reset velocity, brief input disable + camera settle); ordering rules (latest checkpoint wins); EventBus messages (`checkpoint:reached`, `player:respawned`) for HUD/audio hooks.

### `interaction-prompts`
```yaml
name: interaction-prompts
description: Add look-at or proximity interaction to a Babylon Toolkit game — "Press E to open/use/talk" prompts, interactable objects, doors, switches, and pickable items in first- or third-person games.
```
Body covers: `Interactable` Script Component (tag/interface + prompt text property); an `InteractionRayCaster` on the player/camera (raycast from camera or proximity overlap, layer-masked); prompt UI show/hide via the UI design system; `interact()` dispatch pattern (EventBus or direct call); wiring examples: door (FixedHingeJoint impulse/animation), switch (toggle event), item pickup (delegates to `pickups`).

### `grab-and-throw`
```yaml
name: grab-and-throw
description: Add physics object grabbing, dragging, carrying, and throwing to a Babylon Toolkit game — click-and-throw sandbox interactions or first-person carry mechanics on Havok rigidbodies.
```
Body covers: pointer-ray pick against RigidbodyPhysics bodies (layer-masked); hold strategies (kinematic follow vs. velocity-match spring — when each); release + throw impulse from pointer/camera motion; mass/distance limits; carried-object collision handling; integration with `interaction-prompts` for "press E to pick up" variants.

---

## Priority 2 — strengthen checkboxes that have built-in backing

### `race-flow`
```yaml
name: race-flow
description: Wire complete race structure in a Babylon Toolkit racing game using the built-in RacingSystem — countdown start, lap counting and validation, race timer, positions, results screen, and AI opponent setup. Use for any racing GameMode flow beyond raw driving.
```
Body: the glue the RacingSystem docs assume — GameMode race states (waiting → countdown → racing → finished), enabling player/AI input at green light (`enableInput` pattern), lap/checkpoint validation ordering, results UI, restart flow. Cross-references component doc 13 rather than duplicating it.

### `game-menus`
```yaml
name: game-menus
description: Add title screen, pause menu, game-over and results screens to a Babylon Toolkit game using the toolkit UI design system — including pause semantics (PauseRenderLoop vs timescale), input capture, and menu navigation.
```
Body: menu state machine in the GameMode; `SceneManager.PauseRenderLoop` vs. soft-pause tradeoffs; pointer-lock release/reacquire; gamepad navigation of menus; standard screen templates per the UI design instructions.

---

## Priority 3 — verify before authoring (may already be covered)

- **Vehicle/driving basics** — component doc 13 (RacingSystem) + existing training examples may already cover it; author a skill only if trigger behavior shows gaps.
- **Enemy AI patrol/chase** — GamePatterns (doc 14) has an AI enemy example; consider a thin skill that mostly routes to it with NavigationAgent setup steps.
- **Health/damage** — GamePatterns has PlayerHealth; same thin-routing consideration.

---

## Definition of done (each skill)

- [ ] Frontmatter validates against agentskills.io (name matches folder, description ≤1024 chars, states what + when)
- [ ] Body ≤ ~5k tokens; complete code follows Toolkit conventions (namespace PROJECT, full lifecycle, `RegisterClass`, batteries-included — built-ins over custom)
- [ ] Tested in Claude Code against a StarterAssets clone: a natural prompt ("add coins to collect") triggers the load and yields a runnable result
- [ ] Cross-references component docs instead of duplicating them
