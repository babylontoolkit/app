# NEW_PROJECT.md — How a Project Gets Created (quick reference)

The one-page version of SPEC §4.4 / §4.4a / §4.4b / §4.4c. Read this when you forget how the wizard, the registry, and the landing page fit together.

---

## The governing rule

> **Explicit user input > inference > guidance.**
> A typed prompt beats a suggested template. A picked card beats a matched keyword.
> **The wizard only appears when asked for, or when there is genuinely nothing to act on.**

The wizard is a fallback for people who don't know what to type — **not a toll booth everyone passes through.** If someone tells you what they want, build it.

---

## Three entry paths (§4.4a)

### Path A — user typed a prompt (most common)
*"make me a kart racer where the cars are shopping carts"*

1. Match the prompt against `game_registry` entries via their `match_keywords[]`
   (Racing: racing, race, kart, car, driving, drift, lap, track, speed…)
2. Seed the project from the best match: AppTemplate snapshot + that entry's
   `game_mode` (+ optional `scene_url`)
3. **Run their prompt IMMEDIATELY as the first generation.** No wizard. No interstitial.
   No "now pick a template" after they already said what they want.
4. The seed is visible and reversible — a chip: *"Started from: Racing — change"*
5. **Specific prompt, no registry match?** (unusual genre) → seed **Blank Canvas**
   (minimal default GameMode, no scene) and run the prompt anyway.
   **Never block on ambiguity when intent is clear.**

### Path B — user clicked a registry card
Project created from that entry → straight into the builder with an empty chat. No wizard.

### Path C — the Guided Tour wizard
Appears in **exactly two** cases:
- User **explicitly clicks** *"Not sure what to build? Take the guided tour"*
- The prompt is **genuinely vacuous** — no genre, no mechanic, no subject
  ("I want to make a game", "help", "something fun")
  → and even then it is **OFFERED, not forced**:
  *"Want a guided setup, or just start from a blank scene?"*

Anything with a discernible subject ("a game about a robot in a maze") is **Path A** — seed and run.

---

## What the wizard actually does (§4.7)

Four steps → a compiled prompt (the user never sees the raw text, just a friendly summary card):

1. **Game type** — one card per active `game_registry` entry
2. **Vibe** — art/lighting preset (Sunset Arcade, Neon Night, Low-Poly Daylight, Moody Fog)
3. **Mechanics** — genre-appropriate checkboxes (catalog: `spec/wizard-config.md`)
   e.g. Racing: lap counter, boost pads, drift, AI opponents, minimap
   + cross-genre: mobile touch controls, split-screen co-op, online leaderboard,
     score HUD, audio, menus, polish, gamepad
4. **Your twist** — one optional free-text sentence ("the cars are shopping carts")

→ Creates the project from the chosen entry, compiles steps 2–4 into the first message,
drops the user into the builder with generation already streaming.
**Target: first playable change in under 90 seconds.**

Wizard content is **data, not code** (`app/config/wizard.json`) — genres, vibes, mechanics,
and prompt fragments are editable without a deploy.

---

## What creation does under the hood (§4.4b)

Every path ends here:

1. Mount the **AppTemplate** snapshot into the WebContainer
   (self-contained — `src/babylon` vendored, NO submodules; binaries byte-intact per
   `spec/binary-files.md`; remote origin removed; `.gitignore`; **copy
   `src/babylon/assets/{babylon,spinner}.png` → `public/`**; StrictMode removed;
   exact `@babylonjs/*` pins + committed lockfile)
2. **COPY** the registry entry's `source_class` from `src/babylon/classes/`
   → **`src/scripts/<ProjectClassName>.ts`**
   (Blank Canvas → `DefaultGameMode.ts`)
3. **Rename** the class + its `RegisterClass` string to match
   ("Shopping Cart Racer" → `ShoppingCartRacerMode`)
4. Wire navigation to the new class (+ `sceneUrl` if the entry defines one)
5. **Totally rewrite `src/pages/Home.tsx` + `Home.css`** as this game's landing page
   (nothing from the starter survives — no hero montage, no demo buttons,
   no Vite/React links, no footer, no Toolkit attribution)
6. `npm install` → `npm run dev` → preview live

**READ-ONLY, always:** `src/babylon/classes/**` (demo source library — copy FROM, never edit),
`src/babylon/system/**` (framework internals), `app.tsx` + `src/routing/**` (router shell).
**WRITE ZONE:** `src/scripts/` (GameModes + Script Components), `src/pages/` + `src/components/` (frontend).

---

## The play contract (§4.4c) — never break this

```ts
navigate('/play', { gameMode: '<RegisteredModeClass>', sceneUrl?: '...', ...selections })
```

- Gameplay is entered **only** through this call, with a **registered** GameMode class.
- It's an **API the frontend calls** — not a button the frontend must contain.
- The landing page may have one play action, several, or **none** (deeper UI can reach `/play`).
- The frontend can grow into a full game UI: title → track select → car select → options →
  **Start Race** computing `gameMode` (FreeDrive vs TimedRace) and `sceneUrl` (chosen track)
  from the player's selections, then calling the contract.
- Extra config rides in the same **NavigationState** object (sessionStorage-backed — never the URL).
- **React UI must use `useUnifiedNavigation` and must NEVER import `GameManager`** (it drags the
  Babylon runtime into the main bundle). Game code in `src/scripts/` uses `GameManager.NavigateTo`.
