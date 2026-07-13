# CLAUDE.md — Babylon Toolkit App Builder (bolt.diy fork)

## Read this first, every session

1. **Read `SPEC.md` before doing anything.** It is the source of truth for scope, architecture, and phasing. If a request conflicts with the spec, say so and propose a spec change — do not silently diverge.
2. This repo is a **fork of bolt.diy** (MIT). `FORK_BASE.md` records the upstream base commit. Respect the inherited Remix code structure; keep diffs against upstream minimal where practical so upstream pulls stay possible.
3. When architecture or scope changes, **update SPEC.md in the same PR** (see SPEC §11 Working Agreement).

## What we are building (one paragraph)

**Babylon Toolkit App Builder** (neutral working name, via brand module — SPEC §2.5): a hosted, credit-metered, Bolt-style AI app builder at `app.babylontoolkit.com` that builds **Babylon Toolkit web games only** (BabylonJS + Babylon Toolkit, Vite + TypeScript + React, ESM). Every project starts from an official Toolkit starter template. The agent's knowledge comes from the synced Agent Reference docs and agentskills.io-compliant skills — never from generic web-dev assumptions.

## Standing rules — NEVER violate these in code

- **BUILD-FIRST — BUILD EVERYTHING, ALL PHASES, NOW:** the whole spec (§4.1–§4.15) is in scope for the current build. SPEC §9's phases are LAUNCH/GATING order, NOT construction order — never defer a feature because "that's Phase 3" (wizard, gallery, share/remix, GitHub sync, Game Backends, MCP, billing, admin: build them). Never skip or stub a feature because a key/account/vendor is missing — build it, read credentials from config, degrade gracefully ("not configured" UI state + descriptive server error). Stop building ONLY for (a) a hard technical blocker that physically prevents the code from working, or (b) an explicit instruction from the owner (SPEC §1.3 principle 0, §9, §9a).
- **BINARY FILES ARE FIRST-CLASS (`spec/binary-files.md`):** every file path — template mount, git/folder import, WebContainer writes, snapshots, restore, GitHub sync, share builds, deploys, asset adds — carries binaries as bytes losslessly (base64/ArrayBuffer → `fs.writeFile` with `Uint8Array`). **The WebContainer FS is the single source of truth for binary bytes:** `File.content` is ALWAYS empty when `isBinary` (the map holds `isBinary` + `size` only) — read bytes via `FilesStore.readBinaryFile()`, never `dirent.content`. **NEVER route a binary through a `boltArtifact`/`boltAction`** — it is a text protocol (the action runner UTF-8 encodes it, corrupting it) and it reaches the model; write binaries to the sandbox out-of-band. base64 is a WIRE format (snapshots, deploys, GitHub blobs), never live store state. Upstream's text-oriented file layer MUST be extended, not worked around (SPEC §1.3 principle 10, §4.4).
- **CREDITS-ONLY BY DEFAULT (`PRO_FEATURES_ENABLED=false`):** the shipping default is Lovable-style — usage credits only. The provider picker, model selector, and API-key fields DO NOT RENDER for anyone; every generation uses upstream's `DEFAULT_MODEL` constant in `app/utils/constants.ts` (`claude-sonnet-5`). Setting `PRO_FEATURES_ENABLED=true` is the ONLY way Pro/BYOK UI appears (then gated per-user by the license service, or bypassed for local dev). Model choice is a config property, never a user choice (SPEC §4.1, §4.2a, §4.6.1).
- **ANTHROPIC PROVIDER — do not regress (SPEC §4.2a, `spec/anthropic-models.md`):** keep `@ai-sdk/anthropic ^1.2.12` (never downgrade — 0.0.x cannot parse thinking blocks); keep `stripSamplingParams()` (ai@4 injects `temperature: 0`, which current models 400 on) and `dropOrphanReasoningSignatures()` (empty thinking blocks emit orphan signatures); `capabilities.ts` stays OUTSIDE `~/lib/.server/**` (client bundle imports the registry); `PROVIDER_COMPLETION_LIMITS.Anthropic` stays 64000 (a floor, not a ceiling); model IDs carry no date/`-latest` suffix.

- **Pull compatibility (standing commitment):** stay mergeable with upstream bolt.diy indefinitely — additive-first (new code in new files), hide-don't-delete (flags, never removing upstream code), platform-as-provider (our server proxy plugs into upstream's provider layer). **Hotspots — extend, never rewrite:** the file layer/FilesStore + import paths (binary work: add a module + hook seams, use `isBinary` metadata) and the provider layer (add a Platform provider; never restructure multi-provider — BYOK and `PRO_FEATURES_ENABLED` depend on it). Keep all generation logic server-side so upstream's coming agent/subagent rework can land beneath us. Unavoidable upstream-file edits are minimal and logged in FORK_BASE.md (SPEC §2.1a).
- **Sandbox seam:** no new WebContainer-specific coupling outside bolt.diy's existing runtime layer. Everything sandbox-ish must remain swappable for a server-container provider (SPEC §1.3.5, §8).
- **ALL platform secrets are server-only.** Anthropic platform key, AWS keys, Supabase service-role key, Stripe secret, license-service secret: server code paths (`app/lib/.server/**`) only — never in client bundles, never committed, never logged. Local dev values live in `.env.local` (must be gitignored — verify before pasting real AWS keys; leaked AWS keys are scraped from GitHub within minutes); deployed values come from SSM → container env (DEPLOY.md). Platform-credit LLM calls route through the server agent proxy (SPEC §3).
- **Storage is server-side (`@aws-sdk/client-s3`).** Snapshots/builds move through server routes with ownership checks (proxy now; presigned URLs are the planned scaling swap — keep the storage layer behind an interface). Tars are built from `Uint8Array`-faithful maps; a snapshot→restore round-trip MUST preserve binary bytes exactly (spec/hosting.md).
- **Authorization is two-wall:** every server route touching a project validates session **and** project ownership (middleware), with Supabase RLS as backstop (SPEC §4.5.3). "Logged in" is not authorization.
- **The credit ledger is append-only.** Balance is derived (latest `balance_after`); never a mutable counter. Single bucket; credits never expire (SPEC §4.6).
- **Shell actions are allow-listed** (`npm install <pkg>`, `npm run <script>`), enforced client-side AND stripped server-side (SPEC §4.2, §5).
- **No server-side execution of user code or skill scripts.** Ever (SPEC §5).
- **Generations never depend on GitHub at runtime.** Docs and skills are consumed from synced, versioned snapshots (SPEC §4.3, §4.11).
- **Grant integrity:** signup grant once per user (partial unique index). **BYOK is honored only with a server-verified active Pro entitlement**, and its UI (key entry, provider/model pickers) must not render for non-Pro users at all — credits-mode UI contains zero provider machinery (SPEC §2.3, §4.1, §4.6.1).

## Where things live

| Area | Location | Sub-spec |
|---|---|---|
| System prompt / doc-sync | `app/lib/.server/prompt` | `spec/doc-sync.md` |
| Skills runtime + sync | `app/lib/.server/skills` | `spec/skills.md` |
| Billing, ledger, Stripe, entitlements | `app/lib/.server/billing` | `spec/billing.md` |
| Supabase clients, auth middleware | `app/lib/.server/supabase` | — |
| Agent proxy (LLM calls, tool loop, credit gate) | `app/lib/.server/agent` | — |
| Templates / game registry | `app/lib/.server/templates` | — |
| GitHub Sync bridge | `app/lib/.server/github` | SPEC §4.13 |
| MCP (project `.mcp.json` → WebContainer-hosted servers → tool bridge) | bridge in agent proxy; launcher in runtime layer | SPEC §4.14 |
| Game Backends (user Supabase) | inherited connector, relabeled | SPEC §4.15 |
| Wizard config (data, not code) | `app/config/wizard.json` | `spec/wizard-config.md` |
| Sandbox seam rule | (inherited bolt.diy runtime layer) | `spec/sandbox-seam.md` |
| Licensing posture | — | `spec/licensing.md` |

(Sub-spec docs are created as areas deepen; until they exist, SPEC.md sections govern.)

## Project file zones (never-violate)

`src/babylon/classes/**` = read-only demo/source library (copy FROM, never edit). `src/babylon/system/**` = framework internals, read-only. **All project game code — GameModes and Script Components — is authored in `src/scripts/`.** New Project copies the registry entry's `source_class` from `classes/` into `src/scripts/<ProjectClassName>.ts`, renames the class + its RegisterClass string to match (PascalCase project title + `Mode`), and wires navigation to it (SPEC §4.4b).

## Landing page rewrites (never-violate)

`src/pages/Home.tsx` + `Home.css` are OVERWRITTEN per project with a landing page designed from scratch for that game. NOTHING from the starter page survives — no hero, no demo buttons, no Vite/React/Babylon links, no footer, **no Toolkit/BabylonJS attribution or branding at all**. Carry forward only the navigation PATTERN (`useUnifiedNavigation` → play contract), never markup/copy/links. Use whichever starter images the new design calls for and don't import the rest — but **NEVER delete image files from disk** (unused assets stay; `public/babylon.png` + `public/spinner.png` are framework-required). Zero unresolved imports after any rewrite (SPEC §4.4c).

## Pro vs. credits feature split (never-violate)

**Pro gates EXACTLY ONE thing: BYOK + model selection.** Nothing else, ever. Every other feature — including **Export ZIP and GitHub Sync** — is available to ALL users regardless of Pro status. Never hold a user's project hostage to the platform. Credits users (the default, `PRO_FEATURES_ENABLED=false`) get the complete product on platform credits with a fixed model and no keys to manage (SPEC §4.6.1, §4.13).

## Play contract & bundle integrity (never-violate)

Gameplay is entered ONLY through `navigate('/play', { gameMode, sceneUrl? , ...selections })` with a REGISTERED GameMode class — extra config rides in the same NavigationState object (sessionStorage-backed, never the URL; do not move it to the URL). **React UI code must use `useUnifiedNavigation` and must NEVER import `GameManager` or any Babylon module** (it drags the Babylon runtime into the main bundle); game code in `src/scripts/` uses `GameManager.NavigateTo`. Babylon imports stay inside the lazy `/play` chunk. The frontend is fully redesignable (landing page → track/car select → Start Race computing mode+scene from UI choices; a landing page may have no play button at all) — but this call must never be broken, stubbed, or bypassed. Frontend lives in `src/pages/`+`src/components/`; `app.tsx` and `src/routing/**` are read-only shell (SPEC §4.4c).

## New Project routing (never-violate) — full flow: `NEW_PROJECT.md`

Explicit user input > inference > guidance (SPEC §4.4a). A typed prompt is seeded against the game_registry and RUN IMMEDIATELY — the guided tour must NEVER interrupt it. The wizard appears only when explicitly requested, or offered (not forced) when a prompt is too vague to act on.

## Branding rule (never-violate)

No bolt.diy marks in any user-facing surface. ALL brand output (product name, logos, colors, taglines, support links, absolute app/play URLs) comes from `app/config/brand.ts` + `app/assets/brand/` + `APP_URL`/`PLAY_URL` env — NEVER hardcoded in components, emails, meta tags, manifests, or error pages. Working name: Babylon Toolkit App Builder (final brand undecided — see SPEC open questions; swap via brand module only). MIT attribution stays in LICENSE and source headers, never in UI. A CI grep-gate enforces this. (SPEC §2.3, §2.5.)

## Conventions for this codebase

- TypeScript strict; Remix (inherited from bolt.diy) — follow upstream's route/module patterns.
- ESM everywhere. No CommonJS in new code.
- Server code under `app/lib/.server/**` only; anything importable by the client must contain no secrets and no privileged logic.
- Migrations: Supabase SQL migrations checked into `supabase/migrations`; RLS policies live with the table that they protect.
- Feature flags and rates (credit rates, grant sizes, model strings) are **config**, never hardcoded.
- Tests: unit-test the ledger math, grant uniqueness, action-parser allow-list, and prompt-builder validation — these are the money/safety paths.

## Domain rules the agent-facing code must preserve

- Generated projects: Babylon Toolkit + BabylonJS only; three.js only on explicit user request as a utility; never restructure the starter's Vite/React scaffold unasked; keep the project runnable.
- The Agent Reference docs and skills repos are authored externally (`babylontoolkit/agent`, `babylontoolkit/skills`) — this codebase consumes them; never edit their content from here.

## Current stage

We build in **STAGES** (GETTING_STARTED.md Step 4) — dependency-first construction order. SPEC §9's *phases* are LAUNCH/GATING order and never bound what may be built (see the BUILD-FIRST standing rule). Nothing here is "out of scope because it's a later phase."

> **Active stage: 2 — Project creation (the Toolkit core).** Build §4.4 game_registry (`source_class`, `scene_url`, `match_keywords`) + template snapshot pipeline → §4.4a new-project routing (a typed prompt SEEDS a registry entry and RUNS IMMEDIATELY — the wizard NEVER interrupts it) → §4.4b copy-from-source scaffolding → §4.4c landing-page TOTAL rewrite + play contract + bundle integrity. Verify: "make me a kart racer" → seeded from Racing → themed landing page → Play launches the project's own GameMode.
>
> (Stage 3 is the hosted layer — §4.5 Supabase, §4.6 credits/Stripe. The Stage 1 stores are already behind interfaces — `getPromptStore()` / `getSkillStore()` / `getGenerationLog()` — with filesystem adapters writing to `.data/`; Stage 3 adds Supabase adapters and switches the factories, with no caller changes.)
>
> **Stage 1 — the brain: DONE.** Verified 2026-07-13 against the live repos and the live Anthropic API:
> - **§4.2a Anthropic hardening** — `@ai-sdk/anthropic ^1.2.12`; current model table; `stripSamplingParams` + `dropOrphanReasoningSignatures` in `capabilities.ts` (outside `.server/`); `DEFAULT_MODEL = claude-sonnet-5`. `anthropic.spec.ts` asserts on the serialized wire body and a replayed SSE stream, and INCLUDES the two "prove the bug exists" tests. Live calls green on sonnet-5 / haiku-4-5 / opus-4-8.
> - **§4.3 doc-sync** — 26 docs fetched from `babylontoolkit/agent`, 143KB base prompt, 15 on-demand blocks (keyword-routed), 2 declaration files; versioned + content-addressed store; hash no-op; atomic activation + rollback; `POST /api/admin/prompt` (ADMIN_TOKEN-guarded; unset = closed). The Agent Reference is a ROUTER INDEX that tells the reader to fetch sub-docs at runtime — `sections/00-platform-identity.md` overrides that, since generation has zero network access by rule (§1.3 principle 3).
> - **§4.11 skills** — all 9 skills synced from `babylontoolkit/skills`; frontmatter validation (invalid bundle → skip, never fatal); manifest-only resource resolution (traversal is unreachable, not "blocked"); `/` autocomplete in chat; slash force-load; auto description-triggered `load_skill` confirmed firing.
> - **§4.2 agent proxy** — `/api/agent` (upstream `/api/chat` left intact); server-side tool loop invisible to the client; prompt-cache breakpoints (measured 114k tokens written → 84k read back); usage + cache tokens recorded per generation.
>
> **Known Stage 1 follow-ups (behavioral, not structural):**
> - **Skill over-loading.** On a request that merely *resembles* a skill's domain, the model can burn all 6 tool rounds loading skills and reading their resources (measured: 180k in / 75k out / >10 min for one small feature). The cap-continuation ("on cap, proceed with what's loaded") prevents the silent truncation this used to cause, but the index directive in `sections/40-skill-usage.md` still needs tuning. Simple requests that match no skill are unaffected (39s, clean artifact).
> - **No text streams during tool rounds** — the user can watch a blank pane for minutes. Wants a progress annotation ("loading skill…"), as upstream does for context/summary.
> - **Self-healing (§4.2.7) is server-ready but client-unwired.** The proxy accepts `errors` / `repairOf` / `repairAttempt` and caps repairs at 2; nothing on the client posts Vite compile errors to it yet.
>
> **Stage 0 — binary-assets blocker: DONE** (commit `110d3ff`). Verified 2026-07-12: live `babylontoolkit/StarterAssets` mount carries 12/12 binaries byte-identical to GitHub raw; snapshot→restore preserves PNG bytes hash-identically (`app/lib/binary/binary-files.spec.ts`).
>
> SPEC §9's "Phase 0 — prompt proof" (`tools/phase0` throwaway script) was **skipped deliberately**: it was a pre-fork de-risking exercise, and the fork now proves the same thing end-to-end in the real UI.

(Update this block as stages complete.)
