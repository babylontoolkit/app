# NEW_PROJECT.md — How a Project Gets Created (quick reference)

The one-page version of SPEC §4.4 / §4.4a / §4.4b / §4.4c. Read this when you forget how the wizard, the registry, and the landing page fit together.

---

## 🔴 Creating a project and building a game are TWO steps (2026-07-29)

**Creation contacts no model.** It clones the starter template, mounts it, runs `npm install` and
`npm run dev`, and stops with the stock starter home page showing in the preview. Nothing a model does
can decide whether the user ends up with a project, because no model is asked.

The user's prompt is then **carried into the handoff card** — an in-flow panel in the chat column
offering **Build my game** / **Edit my brief** / **X** — for them to send, edit, or put aside. That send is
the **build turn**: it carries the user's own words plus a hidden machine-written brief (play contract,
scaffolded class, images on disk, the landing/chrome instruction), and it is what builds the game.

**The card, not the textbox.** The first version of this prefilled the box with the user's words and
left a banner describing the situation. Owner: *"it kind of feels disconnected to the initial project
creation process."* Text arriving in a box nobody typed into reads as leftover state rather than as the
next step, and a panel that only describes gives the flow no forward edge. The card encodes the
asymmetry that matters: **creation is the heavy step that must not fail; the brief is cheap and
re-runnable** — so the two are separated by a deliberate press, and the cheap half is the one behind the
button. The words reach the box only via **Edit my brief** (focused, caret at the end) or the **X**
(filled, unfocused) — and once they are in the box they are persisted like any typed draft, because both
of those also close the card and "press Edit, get distracted, reload" must not lose them. Creation
itself writes nothing to the `cachedPrompt` cookie, which used to leak one project's prompt onto the
next visit to the landing page.

**The handoff lives on the project row** (`creation_handoff`, migration 0016), not in one browser — so
the card and the hidden brief follow the project to any device, and both end when the first build turn is
SENT. The card's **X** is session-only: it comes back on reload until the project has actually been
built, because until then it is the one outstanding action and nothing else on screen says so.

The card also carries a **baseline save** — the header git chip's own action, through the same
`useSaveProject` hook and the same single writer, never a second thing called saving. Creation is the
one moment when the tree is exactly the pinned starter plus the scaffolded class, so a commit there is
something to reset back to.

| | creation | first build turn |
|---|---|---|
| runs a generation | no | yes |
| what the user sees | boot splash → running starter | the game being written |
| billing | **flat `PROJECT_CREATE_CREDITS`** (default 150), charged at registration, refused *before* anything is provisioned | ordinary per-token, like any other turn |
| can it fail | the credit refusal (before anything is provisioned), project registration, the starter fetch, the mount — and nothing else | it is a retry away; the project already exists and runs |

---

## The governing rule

> **Explicit user input > inference > guidance.**
> A typed prompt beats a suggested template. A picked card beats a matched keyword.
> **The wizard only appears when asked for, or when there is genuinely nothing to act on.**

The wizard is a fallback for people who don't know what to type — **not a toll booth everyone passes through.** If someone tells you what they want, build it.

The two-step flow *strengthens* this rule rather than changing it: the user now literally edits the
inference before it runs.

---

## Three entry paths (§4.4a)

### Path A — user typed a prompt (most common)
*"make me a kart racer where the cars are shopping carts"*

1. Match the prompt against `game_registry` entries via their `match_keywords[]`
   (Racing: racing, race, kart, car, driving, drift, lap, track, speed…)
2. Seed the project from the best match: AppTemplate snapshot + that entry's
   `source_class` (+ optional `scene_url`)
3. **Create the project immediately** — no wizard, no interstitial, no "now pick a template" after
   they already said what they want. Creation itself runs no generation.
4. **Their prompt is carried onto the handoff card**, byte-exact — theirs to send (**Build my game**),
   edit (**Edit my brief** puts it in the box, focused, caret at the end) or put aside (**X**). The chat
   box is left empty until they ask for it. Sending is the build turn.
5. The seed is visible and reversible — a chip: *"Started from: Racing — change"*
6. **Specific prompt, no registry match?** (unusual genre) → seed **Blank Canvas**
   (minimal default GameMode, no scene) and carry the prompt anyway.
   **Never block on ambiguity when intent is clear.**

### Path B — user clicked a registry card
Project created from that entry → straight into the builder. No wizard.

**With words already typed, both are honoured** (fixed 2026-07-29, reported live): the card picks the
entry, and the typed words are the brief AND the project title. `handleSelectEntry` used to ignore the
box entirely, so "type your idea, then click the genre you meant" silently deleted the words and named
the project after the card. Nothing threw; the only signal was the user's report.

**With an empty box** there is nothing to carry, and inventing something would put our phrasing in the
user's mouth — so the mode carries no words and the handoff card offers **Describe your game** (which
just focuses the box) instead of a Build button with nothing to send.

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

→ Creates the project from the chosen entry and compiles steps 2–4 into a prompt, which is carried into
the chat textbox (the short friendly summary, not the compiled brief — a textbox holds the user's own
words) for them to send. The compiled selections are not lost: they ride HIDDEN with the creation brief,
so every mechanic the user checked still reaches the model.

**Target: first playable change in under 90 seconds**, now spent across two steps — the project is
created and running in seconds, and the 90 seconds is measured to the end of the build turn the user
sends. What the user waits *at a blank screen* for is strictly shorter than before.

Wizard content is **data, not code** (`app/config/wizard.json`) — genres, vibes, mechanics,
and prompt fragments are editable without a deploy.

---

## What creation does under the hood (§4.4b)

Every path ends here. **All of it is AI-free**, and it ends with a running app — the design work in
steps 6–7 belongs to the build turn the user sends afterwards, not to creation.

1. Mount the **AppTemplate** snapshot into the WebContainer
   (self-contained — `src/babylon` vendored, NO submodules; binaries byte-intact per
   `spec/binary-files.md`; remote origin removed; `.gitignore`; **copy
   `src/babylon/assets/{babylon,spinner}.png` → `public/`**; StrictMode removed;
   exact `@babylonjs/*` pins + committed lockfile)
2. **COPY** the registry entry's `source_class` from `src/babylon/classes/`
   → **`src/scripts/<ProjectClassName>.ts`**
   (Blank Canvas → `DefaultGameMode.ts`)
3. **Rename** the class + its `RegisterClass` string to match
   ("Shopping Cart Racer" → `ShoppingCartRacerMode`), and **fix the imports that shift with the move** —
   the demo class imports `GameManager from '../globals'` (correct from `src/babylon/classes/`), which
   in `src/scripts/` must become `'../babylon/globals'` or Vite fails with
   `Failed to resolve import "../globals"`.
4. Wire navigation to the new class (+ `sceneUrl` if the entry defines one)
5. `npm install` → `npm run dev` → **the stock starter home page is live in the preview.**
   The boot splash covers this ("Installing dependencies…" → "Starting your project…"), bounded and
   degrading: a slow install never hangs the New Project button, it just stops being narrated.
   **Creation is done here.** The user is in New Project mode: the handoff card says the project is
   ready, shows their brief, and offers **Build my game** / **Edit my brief** / **X**. The chat box is
   empty; the workbench and the running preview stay visible behind the card.
6. **Checkpoint the fresh project — nothing else will** (found live 2026-07-29). The server copy of a
   conversation is written by `checkpointProject` at the END of a generation, and creation no longer
   runs one, so a created-but-not-yet-built project uploaded NOTHING: `/api/chats` returned `[]`, the
   sidebar read "No previous conversations" beside the open chat, and a project made on a laptop did
   not exist on the desktop until its first build landed. The old flow hid this — creation used to end
   by firing a generation, whose checkpoint uploaded the transcript as a side effect. Fire-and-forget:
   a safety net must never take down the thing it protects.

### Then the FIRST BUILD TURN — what the user sends (§4.4c)

Their message plus the hidden brief. The brief states the situation and lets **the model** decide from
the request which of these it is — a stated default with an exception, never a keyword table in our code
(a hardcoded classifier has cost this repo twice; see `create-project.ts`'s header):

- **default — a game/experience brief:** build it AND do the full `bt-landing` pass (steps 6–7 below).
- **exception — a narrow request** (*"just add a rotating cube"*): do only that, leave the frontend alone.

6. **Totally rewrite `src/pages/Home.tsx` + `Home.css`** as this game's landing page
   (nothing from the starter survives — no hero montage, no demo buttons,
   no Vite/React links, no footer, no Toolkit attribution).
   **Steps 6–7 are the `bt-landing` skill's procedure** — the brief delegates to it,
   and the user can re-run `/bt-landing <new brief>` any time to redesign the whole frontend
   shell (landing + splash + preloader + overlay) until they like it.
7. **Redesign the game's chrome in `src/custom/**`** (its own top-level folder since 2026-07-18 —
   deliberately OUTSIDE the read-only `src/babylon`, so the project can edit and maintain it freely;
   its framework imports go through `'../babylon/…'`, e.g. `import GameManager from '../babylon/globals'`)
   to the same design — all three
   ship Babylon-branded and must not stay so (§2.3): the **preloader** (`loading.tsx`), the
   **splash/loading screen** (`splash.tsx` + `splash.css`), and an **initial in-game overlay**
   (`overlay.tsx` + `overlay.css`). Restyle freely but keep the wiring — `loading.tsx` re-exports
   `babylonLogo`/`spinnerLogo` that `splash.tsx` imports; `splash.tsx` keeps its `OnLoadProgress`
   EventBus subscription; the overlay keeps `pointer-events: none` on its container.
8. Build what the user asked for.

**READ-ONLY, always:** `src/babylon/classes/**` (demo source library — copy FROM, never edit),
`src/babylon/system/**` (framework internals), `app.tsx` + `src/routing/**` (router shell).
**WRITE ZONE:** `src/scripts/` (GameModes + Script Components), `src/pages/` + `src/components/` (frontend),
`src/custom/**` (the game's chrome — splash, preloader, overlay).

### Layout law (every UI surface — landing page, chrome, menus, HUD)

**Non-negotiable, enforced in the baked prompt (`20-hard-constraints.md` "Layout law"):**

1. **Full-page-width by default.** Fill the viewport edge to edge — no centered fixed-width column
   (`max-width:1200px; margin:0 auto`, `.container`, `width:960px`). Root/section containers are
   `width:100%`; backgrounds/heroes/nav are full-bleed. Inner text may still cap its line length *inside*
   a full-bleed section. **Build a fixed-width / boxed layout ONLY when the user explicitly asks for one.**
2. **Always responsive.** Adapt from ≈320px phones to ≈2560px desktops, **no horizontal scroll at any
   width**, nothing clipped or overlapping: fluid units (`%`/`vw`/`dvh`/`rem`/`clamp()`), flex/grid that
   reflows (`flex-wrap`, `auto-fit`/`minmax`), `@media` breakpoints, `max-width:100%` on media/canvas,
   keep the `<meta viewport>`. Responsive in the SAME generation — never a "later" pass.

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
