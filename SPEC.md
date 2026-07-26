# SPEC.md — Babylon Toolkit App Builder (bolt.diy Fork Edition)

**Product:** **Babylon Toolkit App Builder** (neutral working name — final brand undecided and freely changeable until Phase 3 via the brand module, §2.5; a distinct product brand such as CodeWRX at app.codewrxai.com remains under consideration, see open questions) — a hosted, commercial, credit-metered AI app builder at `app.babylontoolkit.com`, dedicated exclusively to building **Babylon Toolkit web games** (BabylonJS + Babylon Toolkit, Vite + TypeScript + React).

**Approach:** Fork **bolt.diy** (MIT-licensed open-source Bolt.new) and specialize it: bake the Babylon Toolkit Agent Reference into its brain, wire project creation to official Toolkit starter repos, add a hosted multi-user layer (accounts, persistence, gallery) and a prepaid credit system, and host it on our domain.

**One-liner:** Bolt, but the only thing it builds is Babylon Toolkit games — running on our domain, spending our credits, selling our assets.

**This document is the source of truth for the platform.** When architecture or scope changes, this spec changes first. Read at the start of every AI coding session alongside CLAUDE.md.

---

## 1. Vision, Principles & Strategy

### 1.1 What this is

Users describe a game in plain English. The platform generates, edits, and live-previews a real Babylon Toolkit project in the browser (chat left, code/preview right — the Bolt experience). Users iterate through chat, watch the game update live via Vite HMR inside WebContainers, and can play, share, remix, and export their game as a proper Toolkit project. Regular users buy prepaid credit packs (each AI generation debits credits); Pro Tools subscribers get BYOK unlocked — their own provider key, unlimited at their own cost.

### 1.2 What this is NOT

- Not a general website builder. The agent builds Babylon Toolkit games only.
- Not a three.js tool (three.js allowed only as an explicit, user-requested edge-case utility; never the rendering engine).
- Not a code playground. Every project is a real, exportable Vite + TypeScript + React + Babylon Toolkit repository.
- Not a from-scratch platform build. We fork; we do not reinvent the editor, streaming, or preview plumbing bolt.diy already has.

### 1.3 Core principles

0. **BUILD-FIRST — BUILD EVERY FEATURE IN EVERY PHASE, NOW (overrides everything below when they conflict).**
   - **Scope = the entire spec.** Every feature in §4.1–§4.15 and every phase in §9 is IN SCOPE for the current build. §9's phases describe **launch/gating order, NOT construction order** — they are NOT permission to build a subset. Do not "wait for Phase 3" to build the wizard, gallery, share/remix, GitHub sync, Game Backends, MCP, billing UI, or admin: build them all.
   - **Do not stop for missing credentials, accounts, or vendor contracts.** Every external dependency (Anthropic platform key, license service, Stripe, Supabase, S3, StackBlitz plan) is read from config; when absent, the feature is **built, wired, and gracefully degraded** — a clear "not configured" state in the UI and a descriptive server error — never a missing code path, never a stub that throws "TODO". Credentials are switched on later in the **credential pass** (§9a), which adds ZERO new feature work.
   - **The ONLY acceptable reasons to stop building a feature:** (a) a hard technical blocker that physically prevents the code from working (e.g. binary assets dropped by the file layer → fix it, then continue), or (b) an explicit instruction from the project owner. "We don't have the key yet," "that's a later phase," and "we can add it after launch" are NOT acceptable reasons.
   - **Definition of done for the build:** a user can sign up, pick a game from the registry (or type a prompt, or take the guided tour), generate, iterate, restore checkpoints, add assets, connect a Game Backend, share/remix, sync to GitHub, and see credits debited — end to end, locally, with degraded states only where credentials are genuinely absent.
1. **Fork, don't rebuild.** bolt.diy provides the workbench (Remix app, chat, Monaco-class editor, file tree, streaming action parser, WebContainers preview, terminal, multi-provider LLM support). We modify and extend; upstream improvements remain pullable for as long as practical.
2. **Template-DEFAULT, GameMode-centric generation.** The DEFAULT and promoted New Project path starts from THE official Babylon Toolkit React Framework starter mounted into the WebContainer — one universal scaffold (biggest single reliability lever). bolt.diy's native creation paths (blank prompt-driven start, git import, folder import) remain available as the ADVANCED options: blank starts have the agent scaffold per `project-installer.md` with clear expectation-setting (from-scratch is the least reliable generation type); imports are how power users bring their own Toolkit-shaped repos. Genre and gameplay are NOT scaffold variety: in the React Framework, a **GameMode class is the unit of "game"** (with an optional preloaded base scene via `sceneUrl` as convenience — a GameMode can load all its own assets). The agent's primary generative targets are **(a) GameMode classes** — the main controller of match/game flow, Unreal-style — and **(b) Script Components** — Unity MonoBehaviour-style classes with a Unity-like lifecycle, attached to game objects to hold per-object logic — both authored within framework conventions (documented in `scene-components.md`, already baked into the prompt).
3. **The Agent Reference is law — baked in, never fetched at runtime.** The system prompt is assembled server-side from the official Agent Reference repo via the doc-sync subsystem (§4.3). Zero user setup, zero GitHub dependency per generation, zero platform drift.
4. **Credits are the business; BYOK is the Pro perk.** Platform Anthropic API key server-side; regular users never need an AI account of any kind and pay via prepaid Stripe credit packs (which fund token spend by construction — users pay before tokens are spent). **BYOK (bring your own key) is exclusive to validated Pro Tools subscribers**: their subscription unlocks using their own provider key with zero credit charges — unlimited usage at their own token cost.
5. **Sandbox behind a seam.** WebContainers is the launch runtime (it's what bolt.diy is built on and it costs us zero compute). All WebContainer touchpoints stay behind bolt.diy's existing runtime abstraction — deepening WebContainer-specific coupling in our custom code is prohibited — so an E2B/server-container swap remains a bounded refactor (escape hatch, §8).
6. **Legal-clean by construction.** Development and internal demos require nothing. External users require the StackBlitz commercial plan/license to be in place (management workstream, §8). Acquisition-readiness demands this is airtight.
7. **Non-developers succeed on rails.** Guided Tour wizard is the front door: template + choices → compiled structured prompt. Blank-canvas chat exists but is not the onboarding path.
8. **Real code, no lock-in for users.** One-click export produces a complete Toolkit project matching the official Project Installation Instructions.
9. **The Assets tab is the second business.** Premium GLTF content tools/packs are merchandised inside the builder at the moment of need.
10. **BINARY FILES ARE FIRST-CLASS.** Games are binary-heavy (PNG/JPG textures, GLB/GLTF models, audio, fonts, wasm). EVERY file path — template mount, git/folder import, WebContainer writes, snapshots, restore, GitHub sync, share builds, deploys, asset adds — MUST carry binaries as bytes losslessly. Upstream bolt.diy's file layer is text-oriented and drops/mangles binaries; fixing this is a Phase 1 blocker, not a polish item. Binary CONTENT never enters LLM context or the editor's text map (store `isBinary` + size only); binary BYTES always survive every round-trip.
    **The contract that reconciles those two halves (implemented; see `spec/binary-files.md`): the WebContainer FS is the single source of truth for binary bytes.** The `FileMap` carries `isBinary` + `size` with EMPTY `content` — so binary content *cannot* leak into the editor or the model — and every egress path reads real bytes back from the container on demand. Snapshots and deploys carry bytes base64-encoded as a **wire format only**, never as live store state. Text-protocol channels (the `boltArtifact`/`boltAction` stream) NEVER carry binaries: the action runner UTF-8 encodes whatever it is given, so a binary routed through an artifact is corrupted by construction. Binaries are written to the sandbox out-of-band instead.

### 1.4 Strategy context (recorded so future sessions don't relitigate)

- "Toolkit Everywhere" (configs for Lovable/Bolt/Replit/Claude Code) is **complementary reach**, not the product. Starter repos carry all platforms' agent-config files; babylontoolkit.com links out. Near-zero cost; maintained in the starter repos, out of scope for this codebase.
- A fully custom platform (previous spec, archived) is the **eventual destination only if** the fork's bones are outgrown. Everything built here (prompt pipeline, templates, wizard config, credit ledger, assets tab) transfers.
- Management goal: demonstrable traction + revenue + clean IP/licensing → acquisition-attractive. The §5A analytics funnel (signup → first playable → share → purchase), the append-only revenue ledger, and the spec/licensing.md data-room checklist exist specifically to make diligence fast.
- **Recorded expansion intents (post-launch, not in scope — named because they matter to the acquisition narrative):** teams/collaboration (shared workspaces, multiplayer editing), community skills marketplace (§4.11), **creator marketplace for Unity-Exporter-authored interactive prefabs (§4.9)**, **platform Multiplayer Hosting (managed Colyseus endpoints for user games)**, community template/asset marketplace, education/classroom offering. Each widens TAM without changing the core architecture.

---

## 2. Foundation: the Fork

### 2.1 Upstream

- Repo: `stackblitz-labs/bolt.diy` (MIT). Fork into `babylontoolkit/app-builder` (private).
- Record the forked commit SHA in `FORK_BASE.md`. **STANDING COMMITMENT: stay pull-compatible with upstream indefinitely.** Pull cadence: monthly (and before each phase gate); every pull logged in FORK_BASE.md; CI must pass post-merge. Rationale: upstream's roadmap (notably the planned agent-based backend) delivers free improvements as long as merges stay cheap. Compatibility is maintained by the three rules in §2.1a.
- License compliance: retain bolt.diy's MIT license and copyright notices for the inherited code.

**§2.1a Pull-compatibility rules (never-violate; mirrored in CLAUDE.md):**
1. **Additive-first:** all net-new systems live in NEW files/directories (`app/lib/.server/**`, `spec/`, brand assets). Never restructure upstream modules when adding.
2. **Hide, don't delete:** unwanted upstream features (Electron, Expo, deploy buttons, MCP UI, Supabase connector, provider picker) are gated behind feature flags / build config — their code stays in the tree so upstream merges apply cleanly. "Remove" in §2.3 means remove FROM THE USER EXPERIENCE, not from the repo.
3. **Platform-as-provider:** the server agent proxy integrates as a new entry in upstream's extensible multi-provider layer — a "Platform" provider whose implementation calls OUR server endpoint (key, credit gate, tool loop, caching all server-side). Upstream's provider files stay nearly untouched; our largest structural change rides their own extension point.
Small unavoidable edits to upstream files (branding hooks, prompt selection) are kept minimal and individually logged in FORK_BASE.md's divergence map.

**Merge-risk hotspots (implement as EXTENSIONS, never rewrites — these are the files upstream churns most):**
- **File layer / `FilesStore` + import paths** (the binary-asset work, principle 10): add a binary-handling module and hook it at existing seams; represent binaries with an `isBinary` + size entry rather than restructuring upstream's types/flow. A rewrite here makes every future pull a conflict — especially the agent-backend rework.
- **Provider/LLM layer** (credits/Pro gating): add a "Platform" provider entry + server proxy; gate provider/model UI by mode. NEVER remove or restructure upstream's multi-provider system — BYOK (the Pro perk) and our own dev path (`PRO_FEATURES_ENABLED`) depend on it intact.
- **Upstream's planned agent-backend / subagents rework:** anticipated as the single hardest pull. Preparation: keep ALL our generation logic server-side (agent proxy) rather than woven into their client pipeline, so their orchestration can change beneath us. When it ships, schedule it as dedicated work (not a routine monthly pull), re-evaluate §4.2's single-agent stance against what they built, and adopt their orchestration if it subsumes ours.

### 2.1b Known upstream defects (fix additively; log each in FORK_BASE.md)

Upstream ships real bugs that surface in our environment. Each fix is additive/localized per §2.1a and logged in FORK_BASE.md's divergence map. Known set (grows as found):

- **Binary file layer destroys bytes at ingest** — the big one; see principle 10 and `spec/binary-files.md`.
- **UnoCSS icons render blank when the dev server is launched from VS Code's integrated terminal.** `uno.config.ts` relies on `presetIcons`' filesystem loader, which upstream installs only when `!process.env.VSCODE_CWD` (it assumes "VS Code" implies the UnoCSS extension is hosting). A terminal inside VS Code inherits that var, so every `i-ph:*` / `i-svg-spinners:*` icon silently disappears — no error, just missing UI. **Fix: register the `ph` + `svg-spinners` collections explicitly in `presetIcons`**, making icon loading independent of launch environment (additive keys; upstream-mergeable).
- **`functions/[[path]].ts` (Cloudflare Pages entry) breaks `tsc` on a fresh tree** — it imports `../build/server`, which exists only after a production build, so the pre-commit typecheck hook fails before you have ever built. We deploy to AWS Lightsail (spec/hosting.md), never CF Pages. **Fix: add `"exclude": ["functions", "node_modules", "build", "dist"]` to `tsconfig.json`.** Do NOT delete `functions/` or `wrangler.toml` (§2.1a hide-don't-delete).
- **The inherited outbound routes are anonymous SPEND HOLES** (git CORS proxy, GitHub/GitLab/Netlify/Vercel/Supabase passthroughs, deploy endpoints) — see `spec/spend-holes.md`. Bolt.diy ships them unauthenticated; each spends the OWNER's bandwidth / provider quota / storage, not the caller's, and `api.git-proxy.$` was additionally an open forward-proxy + SSRF vector, while `api.github-user`'s `get_token` leaked the platform `GITHUB_TOKEN`. **Fix: a `denyUnlessVerified` guard inside every handler** (never in `withSecurity`, whose unenforced `requireAuth` option is deleted), a shared SSRF guard (`net/ssrf.ts`, re-run per redirect hop) on any caller-influenced URL, and size caps on client-supplied uploads (publish build, remix seed). Pinned by `outbound-auth.spec.ts` + `net/ssrf.spec.ts`.

### 2.2 What we KEEP from bolt.diy (audit against upstream's CURRENT feature set — it has grown; do not rebuild what exists)

- Remix app shell, chat UI, streaming, code editor, file tree, diff view, terminal
- WebContainers boot/mount/preview integration
- The artifact/action streaming protocol (`boltArtifact`/`boltAction` file + shell actions) and its parser — we adopt it as-is rather than inventing a new protocol
- Multi-provider LLM layer (kept to power the Pro-only BYOK feature and for internal model experiments)
- **Snapshot restoration & revert-to-earlier-versions** — upstream already has these; §4.12 checkpoints ADAPT this machinery rather than building new (to LOCAL checkpoints — §4.5.4b moved the bytes out of our servers)
- **Image attachments in chat** — upstream already has this; §4.12 keeps it, rerouted through the server agent proxy so vision tokens hit billing
- **Git clone/import** — reused as the AppTemplate template-mounting mechanism (§4.4)
- **ZIP download / folder sync** — base of §4.8 export (add Toolkit README matching official Project Installation layout)
- **File locking, codebase search, diff view, voice prompting** — keep as-is (free features)
- **MCP machinery** — kept; repurposed to project-scoped `.mcp.json` with WebContainer-hosted servers + server tool bridge (§4.14)
- **Supabase connector** — kept as "Game Backend" for user-owned leaderboards/saves (§4.15)
- **Netlify/Vercel/GH-Pages deploys** — kept as secondary publish paths beside Share (§2.3, §4.8)

### 2.3 What we REPLACE, REMOVE, or HIDE (per §2.1a: "remove" = from the UX via flags, never from the repo)

- **System prompt** → replaced wholesale by the Toolkit prompt from the doc-sync subsystem (§4.3)
- **Blank/generic project start** → DEMOTED, not removed: game_registry entries (AppTemplate) are the default, front-and-center New Project path; upstream's blank start + git/folder import remain under "Advanced" (§4.4)
- **Local-first, single-user storage** → superseded by hosted accounts + Supabase persistence (§4.5); local mode may remain for development. (Upstream's snapshot/restore UX survives — its storage backend is what changes.)
- **Branding — complete debrand of the UI, replaced by BRAND MODULE REFERENCES (§2.5):** ALL bolt.diy marks removed from anything a user sees — logos, product name, favicon, loading screens, header, footer, meta/OG/social tags, example prompts, help/FAQ/community links, "made with"/changelog references. Every replacement reads from `app/config/brand.ts` — never hardcoded — so the working name (Babylon Toolkit App Builder — final brand undecided, open question) can be swapped in an afternoon. MIT attribution lives in LICENSE and source headers ONLY — the license requires preserving copyright notices in the code, never in the UI. Also remove generic-website affordances and template galleries irrelevant to games
- **Inherited settings-panel knobs that are inert on our path → HIDDEN (§2.1a hide-don't-delete; done 2026-07-18):** upstream's Settings surfaces several controls that only wired to the now-fail-closed `/api/chat` path and are silently ignored by our `/api/agent` proxy, yet whose labels imply they govern OUR platform. Removed from the web-facing UX: (a) the "Tip: set `VITE_*_ACCESS_TOKEN`" hints + dev "Debug: Env token" blocks in every git/deploy/backend connection panel (GitHub, GitLab, Vercel, Netlify, Supabase, and the shared `ConnectionForm`) — `VITE_*` is operator/self-host config, and a platform secret must never be `VITE_`-prefixed anyway (§5); (b) four **Features**-tab toggles — **Main Branch Updates** (a bolt.diy version-check phone-home that implies this app tracks their branch; the updater refuses to auto-pull, so it cannot revert the fork), **Auto Select Template** (zero live callers — creation uses the registry + §4.4), **Context Optimization** (the proxy runs §4.2.8 unconditionally), and the **Prompt Library** system-prompt picker (our prompt is built from synced docs+skills, §4.3). **Context Optimization was un-hidden on 2026-07-22 (owner decision) — a section holding a single row looks broken rather than minimal, and two rows read as a deliberate list.** It is still inert, so the condition of showing it is that its COPY no longer claims to govern anything: it reads *"Always on — every generation is built with an optimized context"*, which is true (§4.2.8 runs unconditionally). An inert control with honest copy states a fact; an inert control with upstream's copy is a lie the user can click, which is the whole reason the other three are hidden. **Event Logging** + **Context Optimization** are what the tab shows. The server-side env fallbacks and auto-connect logic are KEPT (functional, never shown); the toggles' safe defaults are still applied. Catalogued in `spec/context-budget.md` §"Dead levers". Same family as the provider/model machinery below, which was already Pro-gated.
- **Provider picker + API-key entry: Pro-only UI, not merely Pro-only function** → for non-Pro users these controls DO NOT RENDER anywhere — no key fields, no provider list, no model names; their entire billing surface is the credit balance, cost badges, and a Standard/Max quality toggle. The Settings Pro panel shows marketing copy ("BYOK — included with Pro Tools" + upgrade link) only. Key entry and provider/model selection render exclusively after the server confirms an active entitlement (§4.6.1), and the server rejects BYOK generations without one regardless of client state
- **Upstream's Supabase connector** → **KEEP (Game Backends, §4.15):** users connect their OWN Supabase projects for game features (leaderboards, saves, profiles). Strictly separated from our platform Supabase (accounts/billing) — UI labels it "Game Backend" to kill the two-Supabases confusion; user games never touch platform infrastructure.
- **Deploy to Netlify/Vercel/GitHub Pages** → **KEEP.** Share/`/play` remains the promoted, one-click default (it feeds gallery + remix), but external one-click deploys stay available under an "Also deploy to…" affordance — users own their games (§5A) and that includes where they host them. Publishing Checklist enforcement (§4.8) applies to these builds too.
- **Electron desktop app** → out of scope for a hosted product; do not build, package, or maintain the electron/* targets.
- **MCP integration** → **KEEP, project-scoped (§4.14):** projects carry a Claude Code-compatible `.mcp.json` (the AppTemplate template ships the default kit incl. `@babylonjs-toolkit/kie` and kie generators); servers run inside the user's WebContainer and bridge into the server agent proxy's tool loop. Upstream's MCP UI machinery is retained (pull-compat) but the project file is the configuration surface.
- **Expo/React Native creation** → remove; not a Toolkit target.

### 2.4 What we ADD (net-new packages/areas)

- `app/lib/.server/prompt` — doc-sync subsystem (§4.3)
- `app/lib/.server/billing` — credit ledger, Stripe (§4.6)
- Supabase integration — auth + Postgres (projects, snapshot metadata, messages, generations); snapshot/build FILES on S3 (§4.5, spec/hosting.md)
- Templates registry + wizard (§4.4, §4.7)
- Generation controls & project history — stop, checkpoints/restore, retry, attachments (§4.12)
- GitHub Sync bridge — link/push/pull, fast-forward-only, divergence flow (§4.13)
- Gallery / share / remix (§4.8)
- Assets tab + GLTF store integration (§4.9)
- Admin surface — prompt refresh, usage/cost dashboards, feature flags (§4.10)

### 2.5 Brand Module — the rebrand-in-an-afternoon rule

The entire brand lives in ONE module + ONE asset folder + config env vars. Nothing user-facing hardcodes a brand string, logo, color, or absolute URL. This keeps the working name (Babylon Toolkit App Builder) freely changeable until the Phase 3 beta — the commit-point where renaming starts costing real marketing/SEO/user-memory. The undecided final brand (see open questions) is precisely why this section exists.

**`app/config/brand.ts` (single source of truth; illustrative shape):**

```ts
export const brand = {
  productName: "Babylon Toolkit App Builder",  // neutral working name
  productFullName: "Babylon Toolkit App Builder",
  tagline: "Build 3D web games with AI",
  poweredBy: { name: "Babylon Toolkit", url: "https://www.babylontoolkit.com" },
  company: "<company legal name>",                      // legal footer / receipts
  domains: {                                   // mirrored by env: APP_URL, PLAY_URL, MARKETING_URL
    app: process.env.APP_URL,                  // https://app.babylontoolkit.com
    play: process.env.PLAY_URL,                // separate registrable play domain
    marketing: "https://www.babylontoolkit.com",
  },
  assets: {                                    // all under app/assets/brand/ — swap folder = swap identity
    logo: "/brand/logo.svg",
    logoMark: "/brand/mark.svg",               // small sphere mark: favicon/header
    favicon: "/brand/favicon.ico",
    ogImage: "/brand/og.png",
    loadingLogo: "/brand/mark.svg",
  },
  colors: { /* design tokens consumed by the theme layer, not per-component hex */ },
  support: { email: "support@babylontoolkit.com", docsUrl: "…", termsUrl: "…", privacyUrl: "…" },
  social: { /* … */ },
} as const;
```

**Rules (CLAUDE.md never-violate):**
1. No user-facing hardcoded brand strings, inline logos, brand hex colors, or absolute app/play URLs anywhere — components import `brand`; emails/receipts/meta tags/PWA manifest/error pages included.
2. Share and OAuth-facing links are minted from `APP_URL`/`PLAY_URL` config, never string-built from literals.
3. "Powered by Babylon Toolkit" (linking to the toolkit site) is itself a brand-module field — the tech-brand layer is part of the brand, not decoration.
4. CI grep-gate: build fails if bolt.diy marks or the literal working-brand name appear outside `brand.ts`/`app/assets/brand/` (regex list maintained with the module).

**Domain migration runbook lives in spec/hosting.md** — DNS/TLS/env swap + the three tentacles (OAuth redirect URLs in Google/GitHub/Supabase, Stripe webhook endpoints, GitHub doc-sync webhook) + permanent 301 from the old domain. With this section honored, a full rebrand = edit `brand.ts`, swap the asset folder, run the runbook checklist, keep a redirect.

---

## 3. System Architecture (High Level)

```
┌───────────────────────────────────────────────────────────────┐
│ Browser (app.babylontoolkit.com)                              │
│ Forked bolt.diy (Remix):                                      │
│   Chat │ Editor │ File tree │ Terminal │ Assets tab           │
│   WebContainer (user's own CPU): starter repo + Vite dev      │
│   Preview iframe ← WebContainer preview URL                   │
└───────────────┬───────────────────────────────────────────────┘
                │ HTTPS / streaming (chat, snapshots, billing)
┌───────────────▼───────────────────────────────────────────────┐
│ Server (Remix server routes)                                  │
│  Agent proxy (holds Anthropic key, prompt cache, credit gate) │
│  Doc-sync (prompt versions) │ Billing (Stripe, ledger)        │
│  Projects/snapshots │ Gallery builds │ Admin                  │
└───────┬───────────────┬───────────────┬───────────────────────┘
        │               │               │              │
  Anthropic API      Supabase         Stripe      AWS S3+CloudFront
  (platform key,     (Postgres,                   (snapshots, skills,
   prompt caching)    Auth, RLS)                   /play static builds)
```

Key property of this architecture: **compute for running user projects costs us ~nothing** (WebContainers = user's browser). Our marginal costs are LLM tokens (funded by prepaid credits) and S3/CloudFront + Supabase database usage (small).

**LLM calls always route through our server** (never browser → Anthropic): the platform key must never reach the client, and the server is where credit gating, prompt-version attachment, caching headers, and usage recording happen. bolt.diy's client-side provider calls are refactored accordingly (BYOK calls may remain client-side since the user's own key is theirs to expose).

---

## 4. Component Specifications

### 4.1 App Shell & UX (modified bolt.diy UI)

- Layout inherited: chat left; tabs right — **Preview** (default), **Code**, **Assets** (new), Terminal toggle (Settings-gated; hidden for non-developer mode). The Code tab's editor loads the synced Toolkit declaration files (`babylon.toolkit.d.ts`, playground declarations — §4.3) for full TOOLKIT/PROJECT IntelliSense.
- Top bar: project name, WebContainer status, **credit balance**, Share, Export, user menu. Its structure is specified in §4.1a.
- Screens: Dashboard (project grid, New Project → wizard or template picker), Builder, Guided Tour (`/new/tour`), Billing (`/account/billing`), Gallery (`/gallery`), public play page (`/play/[shareId]`).
- Per-message credit cost badge in chat; generation blocked with a friendly upsell when balance ≤ 0.
- **Two clean UI modes, one codebase — CREDITS IS THE DEFAULT BOOT STATE:** (a) **Credits mode** (default for everyone until proven otherwise): balance chip, cost badges, Standard/Max toggle — zero provider/key/model machinery rendered anywhere. This is what the app shows on first load, including when the platform Anthropic key is not yet configured (generation then returns a clear "platform key not configured" state — §1.3 principle 0 — it does NOT fall back to a provider picker). (b) **Pro mode**: adds the BYOK panel (provider picker + key entry, client-stored) and a "Pro Tools · BYOK" badge; cost badges read "BYOK".
- **Mode resolution (server-side):** **Credits mode is the default and the norm** (Lovable-style: usage credits only, no model choice, no keys). Pro UI (provider picker + model selector + BYOK key entry) renders ONLY when **`PRO_FEATURES_ENABLED=true`** (config; **default `false`**) — and, when Pro features are manually enabled (testing-only), an individual user gets them only with a verified Pro entitlement (§4.6.1) — whose authority would be the user's live Stripe plan (§4.18), not the retired ASMX license service — or when the flag is set for local development. With `PRO_FEATURES_ENABLED=false` the model selector and key fields do not exist in the UI at all, for anyone. Never derived from client state.
- **The model is an OPERATOR setting, not a user choice (§4.2a):** credits-mode generations use `LLM_MODEL`, falling back to upstream's `DEFAULT_MODEL` constant in `app/utils/constants.ts` (currently `claude-opus-4-8` — the strongest coding model, this being a game-coding product). Changing the platform's model = setting `LLM_MODEL` + promoting a price row in the Admin panel; **no rebuild, no redeploy, and no UI selector** — it is config the operator owns, never a choice the end user sees. Billing is model-aware, so the higher Opus unit cost carries the margin through automatically (§4.6).
- **Branding:** Babylon Toolkit identity throughout (see §2.3 debrand rule); no bolt.diy marks in any user-facing surface.
- Mobile: play/gallery only for launch; editing is desktop scope.

#### 4.1a The builder toolbar — uniform actions, one git control, one main menu (REBUILT 2026-07-22)

The header accumulated one button per feature across roughly a dozen changes and reached **eleven controls**, six of them identical accent-filled pills, with **two adjacent buttons both labelled "Sync"**. Every addition was individually reasonable; nothing was ever responsible for the row as a whole. Reported by the owner as *"a long row of ugly buttons… it basically looks like SHIT."*

**The shape (never regress):**

```
⚡ credits   [</>] [Media] [Share] [Deploy ▾]   [⚠ Not synced to GitHub ▾]   [⋯]
```

- **🔴 UNOCSS DOES NOT SCAN PLAIN `.ts`, AND THE SHARED STYLE LIVES IN ONE (found + fixed 2026-07-22, `uno.config.ts` `content.pipeline.include`).** The default include is `/\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/` — `[jt]sx` covers `.tsx` but **not** `.ts`. So putting the row's classes in `toolbar-button.ts`, exactly as this section requires, meant they were never extracted and their rules were never generated. **The failure was PARTIAL, which is why it read as a design regression rather than a bug:** `h-7`, `px-2.5` and `border-white/15` survived because other `.tsx` files happen to use them, while `w-7`, `hover:bg-white/10`, `bg-white/15` and `z-[1000]` — unique to that file — vanished. The buttons kept their height and border and lost their **width** (⋯ and the workbench toggle collapsed to their icons: measured 20px, now 36), and every toolbar menu lost its **z-index** and fell behind the workbench. The z-index mechanism is worth knowing: **Radix reads the content's computed `z-index` and copies it onto its fixed popper wrapper**, so an ungenerated class silently became `auto` and `.z-workbench` (3) painted over it. Fixed in the config rather than by renaming the file — the extension is not the point, and the next `.ts` module holding class names would not announce itself either. Verified in a real browser (36×28 controls; three probe points inside the workbench's rect return the menu on top; `body { padding-right: 0px }` still holds). Pinned by `toolbar-button.spec.ts`, mutation-verified.
  - ⚠️ **That spec's first two drafts were VACUOUS and passed on an invented utility.** `uno.generate()` returns ~45KB of layer scaffolding whatever you give it, so `css.trim()` is always non-empty; `matched` carries a **baseline of 24 entries from the `i-bolt:*` icon safelist**, so `matched.size > 0` is always true. Only `matched.has(token)` can fail. **A CSS test that cannot fail is the same class of defect as the thing it was written to catch** — and this one found a third dead thing on its first honest run: `animate-in` / `fade-in-80` / `zoom-in-95` are tailwindcss-animate classes that are not installed, so the menus have never animated (left in place — upstream uses the same trio in ~10 components; listed in `INERT_BY_DESIGN` so it is a known fact rather than a silent one).
- **The ⋯ fill is the ACCENT** (`bg-accent-500` + `text-white` + the primary hover — what the Share button wore before the rebuild; owner, 2026-07-22). `bg-white/15` read as a grey smudge rather than a deliberate highlight. **🔴 It is a COMPLETE constant (`TOOLBAR_ICON_BUTTON_FILLED`), never `classNames(TOOLBAR_ICON_BUTTON, …)`** — when two classes set one property the winner is **rule order in the generated stylesheet**, not class-string order, and UnoCSS emits the accent hover BEFORE `.hover\:bg-white\/10`, so composing gives a filled button that turns translucent grey the instant you point at it. The shared *shape* (geometry, border, transition, disabled) is factored into `TOOLBAR_SHAPE` so the filled and quiet variants stay identical in everything but colour. Found by reading the emitted CSS, not the code; pinned + mutation-verified.
- **A permanently-`disabled` menu row is not a roadmap, it is a dead end — hidden** (owner, 2026-07-22): Deploy's inherited *"Deploy to Cloudflare (Coming Soon)"* had no implementation behind it and never became reachable, so it advertised a capability that does not exist inside a menu the user opens to get something done. Hidden behind `{false && …}` (hide-don't-delete, §2.1a) so restoring it is deleting a wrapper.
- **Icon-only buttons carry a FIXED width wider than their glyph** (`w-9` + `shrink-0` against `h-7`), never shrink-to-fit: a control that resizes with its icon stops the row reading as a set, and a 28×28 square beside `px-2.5` labelled buttons reads as a different, smaller kind of control rather than the same button without a word in it.

- **Every action looks identical** — one shared style in `app/components/header/toolbar-button.ts` (`TOOLBAR_BUTTON`, `TOOLBAR_ICON_BUTTON`, `TOOLBAR_BUTTON_ACTIVE`, plus the menu styles), **imported, never re-typed**. Tiering by importance (filled primary / bordered secondary / bare tertiary) was built first and **rejected by the owner**: a row wearing four different looks reads as mess before it reads as hierarchy, and the labels already say what each control does. 🔴 The duplicated class string is the actual defect — a style only looks wrong *next to* the others, and nothing in a code review shows you the row, so consistency held only as long as someone remembered. A new control gets the row's look by importing it.
- **FILL IS RESERVED FOR EXACTLY TWO CONTROLS (owner decision): the git chip and the ⋯ main menu.** Everything else — workbench toggle, Media, Share, Deploy — is bordered-only, transparent background, whether or not it is "active". The two filled controls are the two the eye should land on: the state you may need to act on (sync) and the drawer where everything else lives. The workbench toggle therefore has **no pressed-fill** — `aria-pressed` still carries its on/off state for assistive tech, it just is not shouted visually (`TOOLBAR_BUTTON_ACTIVE` is now used ONLY by the ⋯ trigger). Its icon is a split-panel glyph (`i-ph:square-split-horizontal-bold`), which is what the workbench *is* (code | preview).
- **`GitStatusChip` is a special case for a second reason too**, because it carries STATE rather than an action: §4.5.4b requires the unsynced state to be loud (amber) and the synced state to be quiet. Its `neutral`/`busy` tones **match `TOOLBAR_BUTTON`** (bordered, no fill) — so a *synced* project's chip blends into the row and only amber/red break out. This is compatible with "the chip is one of the two filled controls": it is filled precisely when it has something to say. Restyle the toolbar button, restyle those two tones with it.
- **Preview-gated controls render DISABLED, never absent.** The row is right-aligned, so anything appearing to its right shoves everything left; Share and Deploy need a built preview, and used to pop in seconds after load (measured: `New chat` 16px from the right edge at t=0, **486px at t=4s** — reported as "the New chat button is very inconsistent"). The old fix was ordering (conditional first, unconditional last), which worked but made the order load-bearing and fragile. Disabling holds the space from first paint, frees the order to be semantic, and lets the user see that sharing exists before it is ready.

**The four git controls became one (§4.5.4b, §4.5.4c, §4.13).** A badge, a `GitHub ▾` provider picker, a push button, and the repo dialog were four siblings answering ONE question — *"where does my game live?"* — and **two of them shipped with the same label**, because each was named against its neighbour rather than against the row: `GitHubSyncButton` was deliberately renamed "GitHub" → "Sync" to stop competing with the button then called "Save", and §4.5.4c later renamed Save → Sync, handing it the word the other had just vacated. 🔴 **A name collision between siblings is usually a missing parent.** The chip shows the state and opens a menu holding every action on it (Sync / Pull / Link a repository / Open on GitHub / provider choice / "Where does my game live?"). Every string still comes from the tested `describeSaveStatus` — a string invented in the component is a string nothing tests. `SaveStatus.client.tsx` is **deleted, not left dormant**: two components drawing one state is the two-writers drift this codebase keeps rediscovering.

**⋯ is the MAIN MENU, and it is GROUPS, not a list.** General options live here and **new ones go here by default** — the row is the exception, not the destination. Separators are structure: **(1) Session** (`New chat`) · **(2) Take it with you** (`Export as ZIP`) · **(3) Help & diagnostics** (`Report a bug`, `Download debug log`). A new item **joins the group it belongs to**; if it belongs to none, that is the signal to add a fourth group, never to append to the bottom — a menu that grows by appending becomes an undifferentiated list, which is the same failure the toolbar just came back from. Anticipated groups: **Project** (settings, rename, duplicate, delete), **Connections** (Unity bridge, game backend, MCP), **View** (theme, layout).

`New chat` moved out of the row into group 1, and `NewChatButton` became the hook **`useStartNewChat()`** so the menu item and the `/clear` command (§4.2.9) take the same path — three call sites drifting into three meanings of "new chat" is the same failure as the two Syncs.

🔴 **Every header dropdown MUST set `modal={false}`** (the git chip, ⋯, and Deploy all do). Radix's modal default scroll-locks the body and adds scrollbar-compensation padding; the chat column is IN FLOW, so that padding shifts it left while the workbench (position: fixed, placed by `--workbench-left`) stays put — opening the menu shoved the whole chat off-screen. This is not chip-specific: it bites any in-header menu, and it already caught Deploy once (2026-07-18) and the git chip once (2026-07-22). A new header menu inherits the bug unless it opts out.

**Known, deliberate:** the credits pill is `h-24` and borderless while the row is `h-28` and bordered. It is an *indicator*, like the chip, not an action — flagged rather than silently changed.

### 4.2 Agent & Generation Loop

1. User message → server route. **Credit gate:** balance must cover a conservative estimate; block politely if not. In-flight generations are never killed for balance.
2. Server assembles the request: active prompt version (cached prefix, §4.3) — which includes the skills index (§4.11) — + project context (file manifest, relevant file contents, recent Vite/terminal errors surfaced by the client) + conversation history + the skill tools (`load_skill`, `read_skill_resource`, §4.11).
   > **The history is COMPACTED and bounded (2026-07-14, `app/lib/.server/llm/history.ts`).** It is *not* cached, and that is structural: all four cache breakpoints sit on the **system** blocks and the messages come after them, so every byte of every previous turn is re-sent at full input rate on every turn, forever, growing with the session. But **83–87% of that history was file BODIES** in `<boltAction type="file">` blocks — and every one was redundant, because the current and *more accurate* contents of those same files are sent fresh each turn in `# Current Project Files`. The same double-representation bug §4.2.8 found in the creation artifact, displaced into the conversation. The bodies are now stripped (the tags survive, so the model still knows which files it touched), and a windowing backstop bounds growth by conversation length while never dropping the first user message (the original brief). **The user's WORDS are never touched — but a file body is not a word (2026-07-25):** the client prepends a machine-generated `<boltArtifact>` of every editor-modified file to the user's next message, and because it rode in a USER message compaction stepped over it, leaving the one part of the history that grew without bound. The same strip now runs over user messages (safe by construction — only the inside of `<boltAction type="file"|"edit">` tags is rewritten), in `parts` as well as `content`. **Measured across six real conversations: 112,121 → 17,174 chars re-sent per turn, −85% (~28,030 → ~4,294 tokens)** — and those were only three-message conversations; the saving compounds. *Caching* the history would cost MORE, not less (a breakpoint before it would be invalidated every turn by the volatile blocks that precede it → a 2× cache write in place of a 1× read) — see `spec/context-budget.md` §5.
3. Call Anthropic API (platform key) with prompt caching; stream to client. **Server-side tool loop:** if the model emits a `load_skill`/`read_skill_resource` tool call, the server resolves it from the skills store and continues the same generation with the tool result — invisible to the client except latency; the visible stream stays pure text + actions.
4. Client-side bolt.diy parser applies `boltAction` file/shell actions progressively into the WebContainer (inherited behavior — user watches the game change live).
5. Shell actions restricted by allow-list: `npm install <pkg>`, `npm run <script>` (enforced in the parser/executor; the system prompt also instructs it).
6. On completion: client posts changed-files snapshot; server records `generations` row (tokens, model, prompt_version_id), debits credits via ledger, attaches cost badge to the message.
7. **Self-healing:** client reports post-apply Vite compile errors within an 8s window (`REPAIR_WINDOW_MS`) → server auto-issues one repair turn (max 2 per generation; settled at FULL cost against the same generation — `REPAIR_WEIGHT` is not implemented, see the status note).
   > **Status: BUILT end-to-end (2026-07-14).** The server half always existed; the client half did not, so none of it ever fired. It does now. The proxy mints the `generationId` up front and returns it on the `agentMeta` annotation; the client arms a watch when a generation finishes, and if a **Vite compile error** (`source: 'preview'`) lands within `REPAIR_WINDOW_MS` (8s — Vite recompiles just *after* the last file action, so the error arrives after the stream ends), it re-POSTs with `errors` + `repairOf` + `repairAttempt`. That is what makes the server treat it as a repair: escalate the effort (`high`, then `xhigh`), fold the compiler output into the prompt, and count it against `MAX_REPAIR_TURNS = 2`.
   >
   > The decision is a **pure function** (`app/lib/runtime/auto-repair.ts`, `decideAutoRepair`) rather than logic buried in a `useEffect`, because it decides whether to **spend the user's credits without them asking** — the most consequential call the client makes. Every guard is a way that could go wrong, and each is tested: only a preview error (a *terminal* error is usually the user's own command — repairing it uninvited is presumptuous **and** billable); only inside the window (an error an hour later is the user breaking their own project); never while streaming; and never more than twice, because two failed repairs is thrashing, not fixing. The loop's **termination** is asserted directly. `REPAIR_WEIGHT` remains unimplemented — repair turns settle at full cost (§4.6), and `generations.repair_of` now records the data needed to price them later.

**Agent architecture stance (deliberate — do not re-architect):** single agent + server-side tool loop + self-healing repair turns. No orchestrator/subagents in the core loop (cost, latency, and the progressive-stream UX argue against them for our narrow domain). Fixed-function sub-calls are fine (e.g., a small fast-model call for asset introspection). A sequential planner pass for very large requests is a recorded post-launch consideration. Upstream's agent-backend rework, when pulled, is evaluated against this stance.

**Model policy (see §4.2a):** credits mode uses a single config-defined model — no Standard/Max toggle, no model names in the UI. Model selection UI exists only under `PRO_FEATURES_ENABLED=true` (Pro/BYOK).

### 4.2.8 Context Budget — what the model is allowed to see (money path)

**Principle: the artifact is a channel to the MODEL that happens to write files. The WebContainer filesystem is how files get to the project. Never confuse the two.** Every byte routed through a `boltArtifact` is a byte the model pays to read — on this turn, and on every subsequent turn, because the artifact lives in the assistant message and rides the history forever.

This is a **money path**, in the same sense the ledger is. A regression here throws no error and fails no build; it silently multiplies the input bill of every generation. It is treated with the same rigor: tests in `app/lib/context/opaque-files.spec.ts`, and a measured before/after on any change.

**The measurement that produced this section (2026-07, "make me a kart racer"):** 997,775 *uncached* prompt tokens for one project creation, ~$4.25 all-in. Two independent causes, both structural:

1. **Double representation.** The creation artifact inlined all 51 starter files (258KB, ~70k tokens), AND the agent proxy sent the same files again as `# Current Project Files`, built from the file map. Every file, twice, on every step.
2. **Multiplied by the tool loop.** `maxSteps` re-sends the entire prefix on each step (up to `MAX_TOOL_ROUNDS + 1` = 7). An *uncached* file context is therefore paid up to seven times per generation at full price.

**The three rules that follow, all now enforced in code:**

- **The creation artifact carries NO file bodies.** The whole starter — binary and text — is written straight to the WebContainer (`writeBinaryFiles` / `writeTextFiles` in `app/lib/registry/mount.ts`), and the artifact carries only `npm install` + `npm run dev`. The file map (which the watcher populates from exactly those writes) is the **single representation** the model ever sees. Safe because restore is snapshot-driven (`useChatHistory` → `restoreFiles`), never artifact-replay.
- **Opaque files are never shown, only declared** (`app/lib/context/opaque-files.ts`). A file can be in the project but not in the conversation for three reasons, and all three now get identical treatment — a `<boltFile>` marker with path + size, and no body:
  - *binary* — bytes cannot survive UTF-8 encoding (`spec/binary-files.md`);
  - *generated* — the lockfile: correct text, 218KB, no correct edit exists;
  - *opaque* — vendor runtime shims (`public/scripts/twgsl.js` 73KB, `pep.js` 41KB, `glslang.js` 16KB — **half the starter's entire text payload**) and image assets that happen to be text (`.svg`).

  The inverse rule matters just as much: everything the agent must READ to work — `globals.ts`, `system/platform.tsx`, the `classes/` library, `vite.config.ts` — stays fully visible. Hiding those would leave the model guessing at the play contract, which is the exact failure §4.4c exists to prevent.
- **Opaque means "not in the conversation", NOT "not in the project".** Upstream's watcher excluded `**/package-lock.json` from the FilesStore, treating the file map as a view for the model. It is not — it is the SOURCE every egress path builds from (ZIP export, GitHub sync, snapshot, share build all iterate `workbenchStore.files`), so that exclusion silently shipped user projects with **no lockfile**, and a restored snapshot would re-resolve dependencies and could install a different tree than the one that was tested. The three concerns are separated: the **watcher** keeps the file in the project, the **context boundary** keeps it away from the model (a marker), and the **client** strips its body before POSTing the map (`stripOpaqueContent`, a copy — never a mutation, or egress loses the file again). Verified: the lockfile now survives snapshot→restore and lands in the exported ZIP as valid JSON, while never reaching the model.
- **The file context is CACHED.** It carries a cache breakpoint (`app/lib/.server/agent/proxy.ts`). This does not contradict the "volatile context last, uncached" ordering of §4.3.5: a breakpoint caches the prefix *up to itself*, so the base prompt and routed blocks keep their own entries and a file edit invalidates only the file entry. What the breakpoint buys is the **multiplier** — steps 2..n of the tool loop read the project at a tenth of the price instead of full freight.

- **The cache TTL is 1 hour, not the default 5 minutes.** An app builder is the workload that defeats a 5-minute cache: the user generates a game, then spends minutes *playing it* before asking for a change, by which point the prefix is cold and the next turn re-writes ~111k tokens at full price. That is paying to *keep creating* a cache rather than read one, and it is invisible in a single-creation measurement. The 1h tier writes at **2×** (vs 1.25×) and reads at 0.1×, so it breaks even on the second cached turn: over ten turns, ~$4.16 of cache writes becomes ~$0.97. Verified live — `ttl` needs no beta header, `@ai-sdk/anthropic` passes `cacheControl` through verbatim, and the entry is still a cache read seven minutes later (so it is not silently falling back to 5m). **Billing consequence: cache creation is billed at 2× — §4.6's ledger math must not assume 1.25×.**

**Result, same prompt, measured end to end:** request body 553,660 → 181,569 bytes; total input tokens **1,100,188 → 111,659 (−90%)**; cost ≈ **$4.25 → $1.35**. Output is now the dominant cost (~69%), which is the correct shape — we pay for what the model *writes*, not for what it *re-reads*.

**These four rules are not the whole system.** Roughly a dozen further levers hold that 111k number in place, and until 2026-07-13 every one of them existed only in code — each removable by a well-meaning refactor that would throw nothing and fail no test. They are now enumerated in `spec/context-budget.md` §"The complete lever inventory", with the reasons they exist. The ones most likely to be undone by someone acting in good faith:

- **`babylon.toolkit.d.ts` (~490KB / ~130k tokens) is NEVER baked into the prompt** — it is synced for editor IntelliSense only. It is larger than the entire post-fix creation context; "the agent should know the API surface" is the reasonable-sounding instinct that would reintroduce it. The agent learns the API from the reference prose and the `classes/` demo library.
- **Attachment limits** (5MB/file, 20MB/message, 8 max — `attachments.ts`, enforced before the credit gate). Vision tokens bill through the normal formula, so **an unbounded attachment is an unbounded bill on our own key**; the client's `accept="image/*"` is not a control.
- **The tool set is designed, not assembled** — the `+1` answer step, the forced-answer continuation on round-cap, batched `read_skill_resource` paths, the one-line already-loaded reply. Each came out of a measured wasted generation.
- **Cache-stability guards** — the skills index is sorted, and unchanged prompt builds are skipped by hash. An unstable prefix busts the cache on *every* generation, which is a silent 10× on the largest block we send.
- **`MAX_PRELOADED = 2`**, and a creation turn preloads exactly one skill.

**OUTPUT tokens are the other half of the bill — and the whole of the wall clock.** Input can be cached; **output decodes SERIALLY at ~60–110 tok/s** and costs 5× input, so a generation that emits 44k output tokens *cannot* finish quickly and no amount of caching will change that. "Make it faster" and "make it cheaper" are therefore the same instruction, and a latency complaint must never be answered with more caching until the step log has been read. `spec/context-budget.md` §"Wasted tokens and dead time" is the **taxonomy of tokens we bought that bought us nothing** — each entry a measured generation: redrafting around tool rounds (29,173 output tokens = 68% of the bill and 75% of the clock, to load ONE skill); output the user never sees — **measured 2026-07-16 across 10 live creations: thinking is 5–57% of output, scaling with the difficulty of the ask** (a physics playground thought for 3.1s; a "subway-surfer clone" for 219s of its 384s). The earlier "~35k" figure is retired — it described a six-tool-round generation that no longer exists — and so is the inference from `chars/output token`: that constant is calibrated for **prose**, our output is **code** (~2.0–2.2 is healthy, not pathological), so thinking is priced from the **reasoning window**, which needs no constant; 90.5s of dead air paying full output rate for reasoning returned as empty text; a clean `finishReason: 'stop'` that produced no text at all yet billed 10,054 tokens; a generation killed by a zod tool-arg violation *after* the tokens were spent; hitting the tool cap with no step left in which to answer; and re-emitting a 10,532-character file to change one line. Read it before optimising anything.

**A generation spends wall clock as well as tokens, and the two do not always move together.** Pathology 11 cost **$0** and was the worst thing about using the product: the server-side shell-action strip (§4.2.5) withheld every file until its closing tag, so a 13,776-character file arrived **51 seconds** after the model began sending it, as one lump. The step log read `92s · 89 tok/s` — entirely healthy — because the time was lost *after* the model, and server-side logging stops at the model. **A latency complaint is traced to where the time went, never explained away**, and a defect priced at zero tokens is still a defect. Fixed 2026-07-16 (157 chunks, max 222 chars, no silences ≥2s); a streaming filter's timing contract is now asserted per-`push` in `shell-strip.spec.ts`.

**Output being the majority of the bill is the success condition, not a pathology.** Input went from 1,100,188 to ~110k tokens per creation and most of what remains cache-reads at 0.1×; once input is optimised away, output dominates by arithmetic, and roughly half of it is the artifact the user asked for. Only the thinking half is a candidate for reduction — and it has **~8× run-to-run variance** (87s vs 10s on identical settings), so it cannot be tuned from a handful of runs. That measurement prices the output-quality eval work (§9a); it does not license an effort change.

> **Those diagnostics are now persisted (migration `0002_generation_diagnostics.sql`, 2026-07-14).** `public.generations` carries `tool_rounds`, `duration_ms`, `finish_reason`, `repair_of` and `steps jsonb`, and `SupabaseGenerationStore` writes them. Before this, every number in `spec/context-budget.md` had to be read by hand out of a browser DevTools stream — which does not scale to noticing a regression across real users, and meant production could see *that* a generation was expensive and never *why*. The §4.10 dashboards can now diagnose spend, not merely chart it.

**Open levers:** only **model routing** remains (Haiku for trivial turns, ~3× cheaper) — and it is not a free win: §4.2a is explicit that an under-thinking model returns a confident *wrong* answer rather than a smaller correct one, and the repair turns cost more than the routing saved. If attempted, route on turn KIND (as the effort policy does), never on a prose classifier. *(Shipped since this section was written: the patch/diff action type — `type="edit"`, `app/lib/runtime/edit-blocks.ts`; the waste diagnostics above; and history compaction — see §4.2 item 2.)*

**Standing rule for every future ingest path** (folder import, git import, remix, asset add, restore): new files must be classified before they can reach the model. If a path adds files to a project, it is responsible for deciding whether they are opaque — the default for anything generated, vendored, or minified is **opaque**.

### 4.2.9 Plan Mode — the Build/Plan toggle, honored the cache-safe way (BUILT 2026-07-18)

> **Naming:** the UI is ONE permanent, always-labeled toggle button in the chat box showing the
> CURRENT mode — **Build** (hammer) or **Plan** (chats, accent-highlighted) — click to switch (the
> inherited version was an unlabeled icon that only appeared mid-chat and only grew its label once
> active, and nobody found it). The WIRE value stays upstream's
> `chatMode: 'discuss'` and internal identifiers say "discuss" — the server contract never moved,
> only the label. "Discussion mode" below ≡ Plan mode.

The chat's inherited Discuss toggle was INERT on our path (it only fed the fail-closed `/api/chat` +
`stream-text.ts`, where upstream implements it as a full system-prompt swap). It is now honored by the
agent proxy — but never the upstream way: **a swapped system prompt is a different cached prefix**, so
each Discuss↔Build toggle would re-WRITE the whole base-prompt cache entry at 2× (§4.2.8). Instead
`chatMode: 'discuss'` appends one small instruction (`agent/discuss-note.ts`, pure + tested) to the
**uncached volatile tail, AFTER the file-context breakpoint** — a breakpoint caches the prefix up to
itself, so a note one line earlier would re-write the ~110k-token file entry on every toggle; past the
last breakpoint it invalidates nothing and costs a few dozen uncached input tokens on discuss turns
only.

What it buys: prose-only answers — no `<boltArtifact>`/`<boltAction>`, no file writes, no shell, no
media — and therefore the real saving: OUTPUT (5× input, serial decode, all of the wall clock) is a
few hundred prose tokens instead of an unwanted artifact rewrite. The model keeps the full file
context (a planning answer about code it cannot see is the §4.2.8 blind-model failure), and the note
tells it to end with proposed steps + "switch back to Build when ready". **Ignored on the creation
turn** (`isCreationTurn`), like the premium toggle — the user asked for a game; a discuss note there
would buy an essay while the full creation context was assembled and billed. Billing is otherwise
identical to Build (same gate, same settlement).

**Discuss is read-only by GUARANTEE, not just by instruction (the hard wall, same session):**

- **A discuss generation's message is marked `NO_REPLAY` by the SERVER, before its text streams**
  (`api.agent.ts`; the constant moved to `~/types/message-marks` so both sides import one string —
  the route must not import `useMessageParser`, which drags the client stores into the server
  bundle). The client's existing §4.5.4b transcript parser then renders any artifact as a proposal
  and never calls `runAction` — a disobedient `<boltAction type="file">` displays but cannot touch
  the filesystem. **The ordering IS the wall:** annotate after the text and the parser has already
  run the actions. The mark rides into IndexedDB with the message, so a reload cannot replay a
  discuss turn either.
- **The tool policy strips everything that spends or mutates** (`toolPolicyForTurn` gained
  `isDiscussTurn` → `toolset: 'skills-only'`, tested): media tools DEBIT credits and MCP tools can
  mutate the sandbox (a `write_file` MCP tool is ordinary, not exotic), so neither is offered; skill
  loads (read-only grounding) remain. MCP tools do NOT force the loop open on a discuss turn — they
  are not offered, so forced rounds would be unusable. The read-only property lives in the TOOLSET,
  never in `maxSteps` — one step can still spend if spending tools are offered. Creation outranks
  discuss if both flags ever arrive (pinned).
- The proxy exposes `discussMode` on the generation handle (decided ONCE — the note, the tool
  policy, and the route's annotation all derive from the same `discussModeNote` call, which owns the
  creation-turn guard).

**The wall has exactly ONE door: `_specs/` planning artifacts (2026-07-24).** The read-only
guarantee blocked the one write a plan-shaped turn legitimately needs — the bt-spec/bt-plan skills
author `_specs/<feature>_spec.md` / `_specs/<feature>_plan.md` as ordinary file actions, and the
wall silently dropped them (the skill reported a spec written that did not exist). The bypass is a
**path rule, never a skill rule** (`lib/chat/plan-artifacts.ts`, `isPlanArtifactPath`, pure +
traversal-tested): the client cannot reliably know which skill ran while file actions are still
streaming (`agentMeta.skillsLoaded` arrives after the text), and a folder is a contract the user can
see. `_specs/` is quarantine by construction — nothing in a project imports from it. Three parts,
each pinned:

- **A third parser instance** (`useMessageParser`'s `planParser`) executes file actions inside
  `_specs/` exactly like a build turn and registers everything else completed-only (shell/start
  never run). **Only a LIVE-streaming plan message reaches it**: parser routing is now **sticky per
  message id** (the parsers are stateful per id — switching instances mid-life re-parses the whole
  content: doubled text, doubled actions) and the plan route is granted only to a message that is
  plan-marked AND currently streaming (loading + last). A RESTORED plan turn freezes onto the
  transcript parser — re-writing historical `_specs` bodies over the user's later hand-edits is the
  §4.5.4b stale-replay bug wearing plan clothes. Mutation-verified in `useMessageParser.spec.ts`
  (dropping the live gate fails 3 tests; dropping the path check fails the write-containment test).
  🔴 **A route freezes only once the message has TEXT — annotations alone are not decidable.** The
  marks arrive as separate stream parts and the 50ms parse sampler can catch the frame between them:
  the first live drive froze a plan turn off a `NO_REPLAY`-without-`PLAN_MODE` frame, recorded it as
  a restored transcript, and the artifact said "Spec written" while the file 404'd on the real FS.
  Fixed from both sides (the server also writes `PLAN_MODE` BEFORE `NO_REPLAY`, so the ambiguous
  frame cannot exist on the wire), race pinned by the marks-only-frame test, and the full loop was
  re-driven live: both `_specs` files verified as real bytes in the WebContainer (`/@fs` probe),
  `src/` untouched, message annotated `['plan-mode','no-replay']`.
- **The note states the exception** (`discuss-note.ts` reads `PLAN_ARTIFACTS_DIR` — the folder name
  in two prose strings is the silent-drift bug `message-marks.ts` exists to prevent): without it the
  model obeys the blanket "write nothing" and never even EMITS the artifact, leaving the client
  bypass nothing to apply.
- **"Build & Apply" ignores planning artifacts** (`plan-proposal.ts` `messageProposesWrite` now
  inspects each `<boltAction>` tag's type + filePath): a `_specs/` write APPLIED, so offering to
  re-run the turn for it is the false positive that spends credits re-doing a change that landed.

### 4.2a Anthropic Model Configuration & Provider Hardening

**Model is operator CONFIG, never UI.** Credits-mode generations use **`LLM_MODEL`**, falling back to upstream's **`DEFAULT_MODEL`** constant in `app/utils/constants.ts` — currently **`claude-opus-4-8`**, the strongest coding model, chosen because this is a game-coding product (it superseded `claude-sonnet-5`; upstream's original value, `claude-3-5-sonnet-latest`, was retired AND matched no `staticModels` entry). Precedence is `LLM_MODEL` > `KIE_DEFAULT_MODEL` > the constant. The old "deliberately NOT an env var" rule is **RETIRED**: the answer to "a typo would 404" is to VALIDATE the value, which `getPlatformModel` does against the active price list — "is it configured?" and "do we know what it costs?" are the same question, so a typo is a describable error at config time rather than a silent mis-bill. `DEFAULT_MODEL` is **not** an env var and must never become one (nothing reads it from `process.env`; a second knob meaning the same thing is the two-writers drift this repo keeps rediscovering).

**Swapping the platform model is a CONFIG operation, and that is a load-bearing property (2026-07-25).** Set `LLM_MODEL` and promote a price row in Settings → Admin → Marketplace prices — **no code change, no rebuild, no redeploy.** Price first, then the variable: `getPlatformModel` refuses an unpriced model, so the reverse order throws on every generation until the list catches up. Three pieces already made this work (`LLM_MODEL` precedence; `kieEnvModel` synthesizing a `ModelInfo` for any unlisted id at 1M/128k; prices living in the admin-promoted list). The fourth was `capabilities.ts`, and it is now fixed — see the next paragraph.

**🔴 THE CAPABILITY LISTS ARE LEGACY DENY-LISTS, AND THE DIRECTION IS THE WHOLE POINT — never invert them back.** `MODELS_WITH_SAMPLING_PARAMS` and `MODELS_WITHOUT_ADAPTIVE_THINKING` name the *old* models; everything unrecognised defaults to **modern**. They used to be allow-lists of modern ids, which made a new `LLM_MODEL` value fail two ways at once: `stripSamplingParams` never fired so `ai@4` injected `temperature: 0` (**a hard 400 on every generation, before a token**), and `thinkingFetch` early-returned so the request carried neither `display:'summarized'` nor `output_config.effort` (**silent** — server-default `high` effort plus empty reasoning text, i.e. both §4.2a pathologies restored, with the token count going *down* so it reads as a cheaper turn). The modern set is open and grows with every Anthropic release; the legacy set is **closed** — no future Claude model will re-add sampling params or drop adaptive thinking — so the exception lists can only shrink and a brand-new id needs no code at all. The residual cost is that a genuinely ancient id now gets modern treatment and 400s on its FIRST request: loud, immediate, free, self-describing, and the same fail-loud preference as `assertNotLocalInProduction` and `NotConfiguredError`. Pinned by `anthropic.spec.ts` against ids that do not exist (`claude-opus-9`), mutation-verified — and the wire-level test **must** mirror `getModelInstance`'s gate rather than applying `stripSamplingParams` unconditionally, or it tests the wrapper instead of the decision and passes with the predicate inverted.

**Effort can gate thinking, not just bound it.** `canDisableThinking(modelId, effort)` takes the effort level because Opus 5 accepts `{type:'disabled'}` only at `high` and below (`xhigh`/`max` are a 400) — `MODELS_THAT_CANNOT_DISABLE_THINKING` is unconditional and cannot express a ceiling, so `THINKING_DISABLED_EFFORT_CEILING` holds it. **The caller CLAMPS to `adaptive` and must never propagate the 400**, mirroring `parseEffort`: an operator's `THINKING_MODE=disabled` is a preference, and a preference that cannot be honoured this turn is not a reason to burn the turn. This is reachable from a `.env` file alone at the worst moment — `effort-policy.ts` escalates a 2nd repair to `xhigh`, so the failure would land on the generation that had already failed twice.

**Current model table** (IDs are COMPLETE — never append a date or `-latest`; the dated-snapshot scheme now 404s):

| Model | ID | Context (`maxTokenAllowed`) | Output (`maxCompletionTokens`) |
|---|---|---|---|
| Claude Sonnet 5 | `claude-sonnet-5` | 1,000,000 | 128,000 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200,000 | **64,000** ⚠️ |
| Claude Opus 4.8 (platform default) | `claude-opus-4-8` | 1,000,000 | 128,000 |
| Claude Fable 5 | `claude-fable-5` | 1,000,000 | 128,000 |

⚠️ Haiku is the exception (200k/64k). Copying another row's numbers over Haiku requests more output than allowed → hard 400. Every model upstream bolt.diy shipped is retired and 404s — delete them, never keep as "fallbacks."

**Three wire-level failures that MUST stay fixed (full rationale: `spec/anthropic-models.md`, kept in-repo):**
1. **`temperature is deprecated for this model` (400).** Sonnet 5 / Opus 4.8 / 4.7 / Fable 5 removed sampling params. `ai@4` *injects* `temperature: 0` when the caller supplies none (`temperature != null ? temperature : 0`) — so it CANNOT be suppressed from a call site (passing `undefined` still sends `0`). Fix lives at the `LanguageModelV1` boundary: `stripSamplingParams()`, gated by `supportsSamplingParams()` (older models still accept them).
2. **`Expected 'text' | 'tool_use'` schema failure.** Sonnet 5 runs adaptive thinking BY DEFAULT (omitting `thinking` does not disable it); Fable 5 cannot disable thinking at all (`{type:"disabled"}` → 400). Requires **`@ai-sdk/anthropic ^1.2.12`** (upstream pins `0.0.39`, which predates thinking). Never downgrade below 1.x. (2.x needs `ai@5`.)
3. **`InvalidStreamPart: reasoning-signature without reasoning`.** Thinking blocks default to `display: "omitted"` → empty thinking text + a signature, which `ai@4`'s state machine rejects. Fix: `dropOrphanReasoningSignatures()` wrapping `doStream`, applied to **every** Claude model.

`getModelInstance` composes both wrappers. `capabilities.ts` MUST live outside `~/lib/.server/**` (the provider registry is imported by client code; a `.server` import breaks the client bundle).

**`getDynamicModels` reads the right fields** — the Models API is self-describing: `max_input_tokens` → context window, `max_tokens` → output cap. Upstream conflated them (and used substring heuristics). Fallbacks are deliberately asymmetric: undershooting output truncates, overshooting is a 400 — which is why `PROVIDER_COMPLETION_LIMITS.Anthropic` stays **64000** (a FLOOR, not a ceiling; it is only consulted when a model's cap is unknown).

**Thinking is ON and VISIBLE — and its cost is an explicit decision (full detail: `spec/anthropic-models.md` §3.4–§3.6).** Current Claude models think by default; omitting `thinking` does NOT turn it off. The defect was never that the model thinks — it was that `thinking.display` defaults to **`"omitted"`**: the model reasons, we are billed for every token at the full **output** rate, and the API returns a thinking block whose text is EMPTY. We paid for reasoning and had nothing to show, so a 90s think rendered as a dead spinner (measured: 90.5s of total silence, not even HTTP headers, before the first byte). `display: 'summarized'` costs **nothing extra** and turns those tokens into a stream the user watches (`ThinkingPanel`).
- `@ai-sdk/anthropic@1.2.12` cannot express any of this (`providerOptions` hardcodes the legacy `{type:'enabled', budget_tokens}` — a hard 400 on current models). The **only** seam is a `fetch` wrapper: `thinkingFetch(mode, effort, modelId)`.
- **Reasoning is a separate stream channel (`g:`), NEVER merged into text** — the client feeds `text` straight into the artifact parser, so leaked reasoning would be written into the user's file. It also does not count as "produced output": a generation that only thought and never wrote must still fail and refund (§4.6).
- **Config:** `THINKING_MODE=adaptive|disabled` (default `adaptive`). Flipping it invalidates the prompt cache **once**; that one-off is not a regression.
- **The liveness heartbeat covers the stream the provider cannot silence us out of (2026-07-24, `spec/anthropic-models.md` §3.4a).** `display:'summarized'` only helps when the provider actually returns the text — and KIE's adapter regressed to returning EMPTY thinking text for EVERY model (fable-5 went 224 chars → 0 on a forced 2,980-token think; api.anthropic.com control streams 209 chars with the same body; measurements in `kie-wire.ts`, send-ready report in `KIE_BUG_REPORT.md`), while still billing the thinking tokens. So a long think was minutes of dead dots, indistinguishable from a hang, with credits genuinely burning. The proxy now emits `agent-status` DATA parts on a timer while the model stream is quiet (`agent/heartbeat.ts`, ≥2.5s silent, every 3s: phase + server-clock elapsed + monotonic `seq`), and the client renders a ticking "Thinking — 1m 12s" panel in place of the dots (`stores/agent-status.ts`, `StreamingStatus.tsx`). **It is a liveness signal, never a thinking channel**: data stream only (never `text`/`g:`, zero tokens), it never fabricates reasoning, real content resets its quiet clock (so when KIE fixes their side, real thinking streams through the untouched reasoning pipe and the heartbeat stands down with no code change), empty deltas do NOT count as activity (KIE streams `""` thinking deltas), and the client gates replay on `(generationId, seq)` because `useChat` re-presents the data array every chunk. Pinned by `heartbeat.spec.ts` + `agent-status.spec.ts`.

**Effort — the dial that bounds spend, and the floor beneath it.** `output_config.effort` (GA) **defaults to `high` server-side**, so never sending it is not "no opinion" — it silently buys the second-most-expensive setting on every generation. Setting it to `medium` cut a creation from $0.232/103s to $0.200/80s with an identical deliverable.
- **`low` is REMOVED from the `EffortLevel` union — it is a correctness bug, not a discount.** It looked free on creation turns (22% cheaper, full-quality output), but on a real **edit** turn it wrote to `src/routing/router.tsx` — READ-ONLY SHELL (§4.4c) — and rewrote whole files instead of patching them, where `medium` created `src/scripts/BoostController.ts` in the correct zone with 5/5 clean diff blocks. An under-thinking model does not return a smaller correct answer; it returns a confident wrong one, and the file zones are the first constraint it drops. `parseEffort()` clamps a literal `THINKING_EFFORT=low` back to `medium` (a `.env` file is a string file; a cast cannot stop an operator) and rejects typos rather than 400-ing mid-generation.
- **Per-turn policy (`effort-policy.ts`) decides by turn KIND, never by reading the prompt** — a prose classifier is wrong in both directions, undebuggable when a bill doubles, and puts a language model in charge of spend. It **only ever escalates**: repair attempt 1 → `high`; repair attempt 2 → `xhigh`; `/slash` skill invocation → `high`; **creation and ordinary edits → the operator default (`medium`)**. Precedence is **policy > `THINKING_EFFORT` > `medium`** — a build that has already failed twice is not the place to economise, and repairs are capped (`MAX_REPAIR_TURNS = 2`) so the escalation is bounded.
- **Config, never hardcoded:** `THINKING_EFFORT=medium|high|xhigh|max` (`DEFAULT_EFFORT` in `capabilities.ts`). There is nothing below `medium` to drop to.

**Verification is mandatory** (these bugs are invisible to typecheck): `anthropic.spec.ts` asserts on the **serialized request body** (stub `fetch`, parse `init.body`) and drives the **real `ai.streamText` pipeline** with a replayed SSE stream containing an empty thinking block + `signature_delta` and NO `thinking_delta` (the production shape). Prove each test fails without its fix before trusting it.

**Restricted models:** Fable 5 requires access; Mythos-tier models are not publicly available. Include Fable 5 in the table but never make it a default or a required path.

**Ops notes:** use **pnpm** (`npm install` dies on this lockfile); `rg` skips hidden dirs — always `rg --hidden` or the entire `app/lib/.server/` tree is silently missed.

**Outstanding (tracked, not blocking):** the Amazon Bedrock provider still ships retired models and legacy ARN-versioned IDs; migrating it is a real integration change (different client + request shape), not a find-and-replace.

**Prompt constraints baked into every version:** Toolkit + BabylonJS only; ESM/ES6 style enforced; **TypeScript over JavaScript; WebGPU preferred over WebGL** (`project-installer.md` global rules); **work within the React Framework's conventions — game flow lives in GameMode classes (wired through unified navigation: `gameMode` + optional `sceneUrl`) and per-object behavior lives in Script Components with the toolkit's full lifecycle (awake/start/update/late/after/step/fixed/ready/destroy), registered via `TOOLKIT.SceneManager.RegisterClass`; never ad-hoc scene bootstrapping or logic outside these constructs unless asked**; **FILE ZONES (§4.4b/§4.4c): author game code in `src/scripts/` and frontend in `src/pages/`+`src/components/`; `src/babylon/classes/**` (demo source library), `src/babylon/system/**` (framework internals), `app.tsx` (routing shell) and `src/routing/**` are READ-ONLY — read for reference, never modify; to change a demo class, copy it into `src/scripts/` first**; **PLAY CONTRACT (§4.4c): gameplay is entered ONLY via `navigate('/play', { gameMode, sceneUrl? })` with a REGISTERED mode class — the frontend may be redesigned freely (title screens, track/car select, options → Start), with or without a play button on the landing page, but this call must never be broken, stubbed, or bypassed**; **read the user's prompt for FRONTEND/landing-page intent, not just gameplay intent, and honor it**; **BATTERIES-INCLUDED RULE: always prefer the Toolkit's built-in systems over custom implementations** — StandardPlayerController/ThirdPersonPlayerController for characters, the RacingSystem (Need-for-Speed-style, e.g. StandardCarController) for driving, TOOLKIT.CharacterController, NavigationAgent (Recast/Detour), AnimationState (Mecanim-style), the Havok joint suite, DefaultCameraSystem (incl. split-screen 1–4 and WebXR), MobileInputController for touch, AudioSource, and the Colyseus multiplayer stack — writing custom versions of these from scratch is a generation-quality bug; never restructure the starter's Vite/React scaffold unasked; **never modify the starter's `vite.config` `optimizeDeps` exclude list or `dedupe` settings** (they prevent the Babylon dual-instance hazard); keep the project runnable; three.js only on explicit user request as a utility; fix surfaced build errors before new features.

### 4.3 Doc-Sync Subsystem (system prompt build, refresh, caching)

**PLATFORM IDENTITY — we are a NEW HOST PLATFORM in the Agent Reference's Platform Detection Table:**
`project-installer.md` defines a BLOCKING platform-detection procedure (Lovable / Replit / Bolt.new / Base44 / V0 / Generic), each mapping to a platform-specific reference doc. Our builder is a **distinct host platform** — a bolt.diy fork with its own runtime, file zones, and creation flow. **Action (owner, agent repo):** author a platform row + reference doc (e.g. `references/web-app-builder.md`) covering: AppTemplate clone (self-contained — `src/babylon` is vendored, NO submodules), remote-origin removal, ES6 package set, our §4.4b file zones (`src/scripts` write zone; `babylon/classes` + `babylon/system` + router read-only), the §4.4c play contract + bundle-integrity rule, and the required `public/` binary assets. Until it exists, bake **Generic** (`web-app-generic.md`) behavior. **Baked-prompt corollary:** the detection procedure's "fetch the doc" step is satisfied at doc-sync time, not per generation — the agent must NEVER be instructed to fetch platform docs at runtime (§1.3 principle 3).

The Agent Reference repo (`github.com/babylontoolkit/agent`) and skills repo (`github.com/babylontoolkit/skills`) remain the single editable sources of domain knowledge — **no changes to how those docs are authored or organized**. The platform consumes snapshots:

1. **`buildSystemPrompt()`**: fetch root `reference.md` + linked sub-docs — Modern ES6 (`node-esm.md`, primary), `scene-components.md`, `react-framework.md`, `ui-design-system.md`, `training-reference.md`, **`project-installer.md`**; `shader-materials.md` held as an on-demand block; **the Component Reference tree (`training/components/README.md` overview baked; the 14 system docs — SceneManager, ScriptComponent, AnimationState, CharacterController, NavigationAgent, RigidbodyPhysics, AudioSource, Materials, InputController, ProComponents, Enums, StarterContent, RacingSystem, GamePatterns — as on-demand cached blocks routed by topic); declaration files (`babylon.toolkit.d.ts`, `default.playground.d.ts`) synced for editor IntelliSense (§4.1) and available to the agent on demand**; Classic UMD **excluded** (platform is ESM-only) — plus the **skills index** (name + description + when-to-use per active skill, §4.11); validate (all expected docs present, non-empty); concatenate with platform sections (action protocol rules, hard constraints, self-healing directive, skill-usage directive); store as `prompt_versions` row: `id, content, content_hash, source_commit_sha, created_at, is_active`.
2. **Activation:** exactly one active version; generations read it — never a live GitHub fetch. User generations have zero network dependency on GitHub.
3. **Refresh triggers:** admin endpoint `POST /api/admin/prompt/refresh` (Phase 2; curl-able before the dashboard exists); GitHub webhook on push to `main` of the agent/skills repos → auto build + activate on success (Phase 3). Failed builds keep the previous version active and alert the admin — a broken doc push can never take down generation.
4. **Rollback:** reactivate any previous version (one click).
5. **Anthropic prompt caching:** assembled prompt sent as cached prefix (`cache_control`); byte-identical between refreshes → nearly every generation pays the reduced cached-input rate on the largest context chunk. This is a primary margin lever. Verify current cache block limits/TTL at docs.claude.com.
6. **On-demand blocks** (shaders) appended as separate cached blocks only when keyword-routed in, keeping the base prefix stable.
7. Every `generations` row records `prompt_version_id` → cost/quality regressions traceable to doc changes.

### 4.4 Starter Template & Game Registry (template-first, GameMode-centric)

- **One universal starter:** `github.com/babylontoolkit/AppTemplate` — the Babylon Toolkit React Framework scaffold (ES6, MIT, template repo; Vite + TypeScript; unified navigation with a `/play` route taking `gameMode` + optional `sceneUrl`). **Default project origin** (the promoted New Project path; there are no per-genre repos). **Advanced paths retained from upstream:** blank prompt-driven start (agent scaffolds per `project-installer.md`; UI notes it's the less-reliable path), git import, folder import — power users bring their own Toolkit-shaped projects; the wizard and non-developer funnel always route through the registry.
- **Genres are registry DATA, not repos.** The `game_registry` (replaces the old multi-repo `templates` table concept; the table can keep the name) rows are: `id, title, genre, source_class (the file in src/babylon/classes/ to COPY — §4.4b), scene_url (optional), match_keywords text[] (§4.4a prompt seeding), thumbnail_url, wizard_config_ref, toolkit_version, is_active`. (The project's actual GameMode class is the renamed copy in `src/scripts/`, not the library source.) Adding a genre = adding a GameMode preset (+ optionally a hosted scene) — no new repo, no new snapshot pipeline.
- **Two-tier gameplay architecture (the agent's output taxonomy):** the **GameMode** is the main controller — it defines game flow and may load any assets it wants (`scene_url` is an optional convenience preload the framework performs before the mode runs; Unreal-style). **Script Components** carry per-game-object behavior — MonoBehaviour-like classes with a Unity-like lifecycle, attached to game objects (player controllers, pickups, hazards, UI hooks). Typical generation: new/modified script components + GameMode wiring. The "blank canvas" option is simply a minimal default GameMode with no scene — full creative freedom on a scaffold that always compiles.
- **Project setup hygiene (mandated by `project-installer.md`/`web-app-bolt.md` — the template-snapshot pipeline MUST bake these in):** **remove the git remote origin** so user projects are never wired to our starter repo; `.gitignore` exists and contains `node_modules` + `.env`; `node_modules` never enters a snapshot; never overwrite a user project's `CLAUDE.md`/`AGENTS.md`/`.github/copilot-instructions.md`; apply the mandated `vite.config` (dedupe, optimizeDeps excludes, COOP/COEP headers, media-MIME + gzip plugins, warmup), `tsconfig.app.json` (`skipLibCheck`, non-strict) and `eslint.config` relaxations; **remove React `StrictMode`** (prevents double window init); ES6 packages only (`@babylonjs/*` + `@babylonjs-toolkit/next`).
- **The starter is self-contained — no git submodules (verified against `babylontoolkit/AppTemplate@main`).** `src/babylon` (the React Framework) is vendored directly in the template. This matters because a GitHub zipball NEVER contains submodule content — it records only a gitlink (mode `160000`) — and WebContainers cannot run `git submodule`. The template route still vendors gitlinks generically (resolving `.gitmodules`, pinned to the referenced commit) so a submodule-bearing template is not silently mounted half-empty, but **the starter must never depend on that path**: a template that needs a submodule step is a template that will mount broken. **Kit requirement:** keep `src/babylon` vendored in-repo.
- **`public/babylon.png` + `public/spinner.png` MUST exist in every project (framework requirement — do not "optimize" this away).** They are ALSO ESM-imported by the preloader (`src/custom/loading.tsx` does `import babylonLogo from '../assets/babylon.png'` — which, with `custom/` at top level since 2026-07-18, resolves to `src/assets/`), so they exist in multiple places on purpose: bundled copies under `src/assets/` and `src/babylon/assets/`, **and** a runtime copy under `public/`. The starter does not ship the `public/` copies, so **project creation copies them into `public/`** (`mount-tree.ts` `withFrameworkPublicAssets` — sources `src/babylon/assets/` first, falling back to any `assets/` copy, so the template reorganisation did not break it) and verifies both are present before declaring the project ready — along with verifying that no imported binary is absent. These two files were the observed casualties of the binary bug and are the canonical smoke test that the file layer is honest.
- **PIN-AND-CACHE — BUILT (Stage 5, 2026-07-16); the divergence below is CLOSED.** New projects now mount a **pinned, SHA-addressed snapshot from object storage**, not live `main`. A snapshot is fetched once and stored immutably at `templates/snapshots/<repo>/<sha>.json`; the pin (`templates/pins/<repo>.json`) records the sha, the ref it came from, when, and by whom. Creation therefore makes **no GitHub call at all** once pinned, and a push to `main` cannot reach a single user until someone promotes it. Pieces: `templates/pin.ts` (keys, pin/snapshot IO, and `decideTemplateSource` — a PURE, exhaustively-tested decision core, `pin.spec.ts`), `templates/fetch.ts` (the fetch lifted out of the route so promotion and bootstrap share it; every fetch now targets an explicit **commit SHA**, which is what makes a snapshot reproducible), `templates/config.ts` (`TEMPLATE_PINNING_ENABLED`, default ON — set false only to develop the starter itself against live `main`), `api.admin.template.ts` (GET pin + rollback menu; POST `promote` / `rollback`, session-`requireAdmin`), and the **Starter template** section of the Admin settings tab (promote-latest + one-click rollback, both confirmed).
  - **The decision rules that must not regress** (each is a silent failure): a **broken mount (`?fallback=1`) outranks a healthy pin** — the server cannot see a runtime-broken WebContainer, so honouring the pin there traps the user on the same bad bytes forever; a pin whose **snapshot object is gone** serves live but **never re-pins** (auto-re-pinning to today's `main` is exactly the unreviewed jump pinning exists to prevent, performed at the moment nobody is watching); an **auto-pin happens only on a clean bootstrap** (pinning on, no pin, not a fallback) and is marked `pinnedBy:'auto'` so an admin can see it was never actually reviewed; **promotion validates BEFORE re-pointing the pin** and leaves the old pin untouched on refusal; **rollback only accepts a snapshot that is still in the store**.
  - **The release-lock footgun is DEFUSED.** `resolveTemplateRef` resolves the **default branch** deliberately and never consults `releases/latest`; publishing a Release on AppTemplate now changes nothing until someone promotes it by name. The pin is the only thing that decides what users mount.
  - **🔴 The model was building the game BLIND — fixed 2026-07-16 (`waitForMountVisible`).** Creation wrote the starter to the WebContainer (awaited; the bytes were on disk) and fired the generation immediately. The model reads `workbenchStore.files`, which a watcher fills asynchronously — measured live, the request went out at **5405ms with 7 files** and the store filled at **5531ms with 78**. So the most expensive generation in the product ran without `src/scripts/<Class>.ts` (the class §4.4b had just scaffolded for it), without `src/babylon/classes/`, without `globals.ts` — silently falsifying §4.2.8's "everything the agent must READ stays fully visible". It reported itself in the product (*"I can't see its source"*) and was read as caution. Nothing threw; the token count went DOWN. Now `startProject` waits for the store to show the exact files §4.4b produced (sentinels, not a count) before generating, degrading after 15s rather than hanging. The wait must stay at the END of `startProject`: the AI SDK sends only committed render state, so waiting inside `createProjectFromRegistry` fixed the files while leaving `projectId: undefined` on every creation. Pinned by `mount-visible.spec.ts`.
  - **🔴 CREATION IS UNCONDITIONAL, AND POST-CREATE MAY NEVER TAKE IT DOWN — owner rule, BUILT 2026-07-22.** New Project is **two phases**, and the second one's failures are bad states of a project that exists, never a lost project:
    - **Phase 1 — CREATE.** Clone the AppTemplate, mount it, verify it on disk, register it with the platform. **No model is contacted**, so nothing a model does can decide whether the user ends up with a project. **Exactly TWO things may fail a creation**, because without either there is nothing at all: the starter fetch, and the mount (`mountTemplate`'s `package.json` sentinel — a mount that did not land must stay LOUD).
    - **Phase 2 — POST-CREATE.** The AI carries out the brief: the §4.4c landing page and chrome, any §4.16 generated art, and the user's actual request. Every failure here — a dead image render, a generation that errors mid-stream, a model that writes nonsense — is **one prompt away from fixed**, so `startProject` wraps it in its own boundary and **still reports success**.
    - **Everything decorative DEGRADES rather than refusing.** Project hygiene and the §4.4b copy-rename-register are a head start, not the project: each is a pure transform over an in-memory file list, so a throw mounts the template without it. A registry row naming a class the template no longer ships used to cost the user the entire project; it now costs them a scaffolded GameMode.
    - **⚠️ The degraded path is only safe because the BRIEF DESCRIBES THE DISK.** Mounting while the brief still claims the mode is "already copied, renamed and registered" trades a loud failure for a silent one — the model builds against a class that does not exist and the project compiles, boots, and dead-ends at a blank `/play`, the exact failure §4.4b exists to prevent. The degraded brief instead tells the model to author AND register the mode itself, and `mustBeVisible` drops the file that was never written (waiting on it would burn the full 15s `waitForMountVisible` timeout and then log a false alarm about a partial context). Pinned by `create-project.spec.ts`, mutation-verified.
    - **A fatal creation says WHICH step broke and what to do (`creation-errors.ts`, pure + tested).** The message it replaced — *"Could not fetch the starter template (401)"* — named the template for what is almost always an **expired session**, sending the user to retry a button that cannot work until they sign in. Classified now: 401/403 → session, `isRetryable: false`; 404 → mid-deploy; 5xx → points at **Settings → Admin → Starter template**, because a 500 is only reachable after the pin AND the last-known-good snapshot both came up empty (i.e. nothing is pinned) and an admin promote is the only actual fix; a rejected `fetch` → "could not reach the server" (the request never arrived — offline, server restarted); an empty 200 → "came back empty"; a mount throw → attributed to the WRITE, with `mountTemplate`'s specific message (which file) preserved. The server's own `details` string survives verbatim so a screenshot is debuggable without a server log. Surfaced as BOTH a toast and the persistent error panel — a faded toast is indistinguishable from a New Project button that silently did nothing.
    - **⚠️ `/api/starter-template` does NOT call GitHub** (the route name is inherited and misleading). Since pin-and-cache it serves a SHA-addressed snapshot from object storage, so this is browser → our own server → storage: its realistic failures are SESSION and SERVER failures. Only an un-pinned repo with no last-known-good snapshot falls through to a live GitHub fetch.
    - **The toast does NOT move.** "🎮 Your game is ready" belongs to FINAL COMPLETE (`onFinish`, once the brief has actually been carried out). Phase 1 is a guarantee, not a milestone worth announcing.
    - **What this replaced:** ONE `catch` around both phases, which told a user whose project had mounted perfectly that we *"could not create the project from the starter template"* because something later failed. A failed creation TURN is a failed post-create — by the time any generation can error, the project exists — so the error alert now says so (`handleError`, gated on `creationTurnStore`). Wrong message on a recoverable situation is how a working project reads as a total loss.
  - **Safety net — BUILT (2026-07-14):** a **last-known-good template snapshot** (`app/lib/.server/templates/last-known-good.ts`, tested). Every successful, structurally-valid fetch is persisted to object storage (the same S3/local-FS layer as §4.5.5); a later fetch that fails outright **or** returns an unmountable result (missing `package.json`, or missing vendored `src/babylon/**` — the exact §4.4 breakages) serves the most recent good snapshot instead of failing project creation. A `?fallback=1` query param lets the client force the snapshot when it detects a broken mount at runtime. **It is still load-bearing under pinning** — it is the ONLY signal that bytes which pass every structural check are broken at runtime, and it deliberately outranks the pin. The response carries `X-Template-Source: pinned | live | last-known-good` (plus `X-Template-Sha`) for diagnostics.
  - **`toolkit_version` (registry) is still metadata, not the pin.** The pin lives in object storage per repo, not in the registry row: a genre is a row that names a demo class to copy (§4.4), and every genre mounts the SAME starter, so pinning per row would let two genres silently diverge. If `toolkit_version` should ever gate anything, it must read the pin — not the other way round.
- New Project: mount the starter snapshot into the WebContainer → apply the chosen registry entry (wire gameMode/sceneUrl) → `npm install` → `npm run dev`. **Binary-asset requirement (principle 10 — see `spec/binary-files.md` for the implemented contract):** upstream bolt.diy's file layer is text-oriented and destroys binary bytes at ingest. ALL project-file paths (template mount, git/folder import, snapshots, GitHub sync, restore, share builds, deploys) MUST handle binaries as bytes: fetch as base64/ArrayBuffer, write to the WebContainer via `fs.writeFile` with `Uint8Array`, keep binary content OUT of LLM context and the text editor map (store `isBinary` + size), carry binaries through snapshots as base64 entries in the JSON envelope (`spec/hosting.md` — supersedes the original tar design). Extend upstream's stores additively (§2.1a). Cold-start mitigations: pre-bundled dependency snapshot if WebContainer install times hurt (measure in Phase 1; the Babylon dependency set is heavy).
- **Template dependency pinning (kit requirement; blocks Share/publish §4.8 when violated).** `@babylonjs-toolkit/next` pins its `@babylonjs/*` peers to an EXACT version (e.g. `9.15.0`). Any `@babylonjs/*` package the starter lists with a caret that is NOT in that peer list will float to a newer minor and break the build: `@babylonjs/serializers@9.16.1` imports `__esDecorate`/`__runInitializers`/`__setFunctionName` from `@babylonjs/core@9.15.0`'s `tslib.es6.js`, which does not export them → `MISSING_EXPORT`, `npm run build` fails (dev still boots, so this hides until Share). **Kit requirements:** (a) every `@babylonjs/*` dependency pinned exactly to the toolkit's peer version, (b) `@babylonjs/serializers` added to `@babylonjs-toolkit/next`'s `peerDependencies`, (c) **the starter ships a committed lockfile** so resolution cannot drift on the next upstream publish.
- **Cross-origin isolation is MANDATORY (Havok/SharedArrayBuffer):** the starter's `vite.config` sets `Cross-Origin-Embedder-Policy: credentialless` + `Cross-Origin-Opener-Policy: same-origin`. **Our shared-build `/play` origin MUST serve the same headers** (CloudFront response-headers policy) or published games with physics break. The play origin must also serve correct media MIME types and `Content-Encoding: gzip` for `.gz.*` assets, mirroring the starter's dev-server plugins — otherwise `.gz.gltf` scenes and `havok.wasm` fail to load.
- **Hosted scene dependency:** referenced scenes (e.g., `repo.babylontoolkit.com/...gz.gltf`) are fetched cross-origin by previews (WebContainer origin) and shared games (play domain) — the scene CDN MUST serve permissive CORS and correct content-encoding for pre-compressed `.gz.gltf`, and must be on CDN-class infrastructure since it sits in the serving path of every preview/play that references it (open question).
- The starter repo also carries the multi-platform agent-config files for the "Toolkit Everywhere" reach play (maintained there, not here).
### 4.4b Project Scaffolding — Copy-From-Source Rule (`src/babylon/classes/` is READ-ONLY)

AppTemplate ships `src/babylon/classes/` as a **read-only library of reference/demo sources** (PlayerControllerDemo, VehicleControllerDemo, PlaygroundDemoScene, DefaultGameMode, …). These are **templates to copy from — never files to edit**. Project code is authored exclusively in **`src/scripts/`**.

**Creation algorithm (all New Project paths — §4.4a A/B/C):**
1. Resolve the `game_registry` entry → its `source_class` (e.g. `VehicleControllerDemo.ts`; Blank Canvas → `DefaultGameMode.ts`) and optional `scene_url`.
2. **Copy** that source file from `src/babylon/classes/` → **`src/scripts/<ProjectClassName>.ts`**.
3. **Rename** the class inside the copy to `<ProjectClassName>`, update its `TOOLKIT.SceneManager.RegisterClass` registration string to match, and fix internal self-references. **Update any imports/paths that shift due to the new location — this is a recurring build break, not a footnote.** The demo classes sit in `src/babylon/classes/`, so they import the game manager as `import GameManager from '../globals'`; once copied into `src/scripts/` that path resolves to the nonexistent `src/globals` and Vite fails with `Failed to resolve import "../globals"`. It MUST become `import GameManager from '../babylon/globals'` (and any other `'../…'` path that assumed the `classes/` location is corrected the same way). The system prompt's hard-constraints call this out explicitly.
4. Wire the app's navigation `gameMode` to `<ProjectClassName>` (+ `sceneUrl` if the entry defines one).
5. `src/babylon/classes/` remains **pristine** — a permanent, clean source library for every future copy, and useful read-only context for the agent ("here is how a working vehicle mode looks").

**Naming convention (deterministic; defined here):**
- Take the project title → strip non-alphanumerics → PascalCase each word → append `Mode` if it doesn't already end in `Mode`/`GameMode`.
  - "Shopping Cart Racer" → `ShoppingCartRacerMode`
  - "my racer!" → `MyRacerMode`
  - "Neon Drift GameMode" → `NeonDriftGameMode` (suffix preserved, not doubled)
- Leading digits or empty results → prefix `Game` (`"3D Test"` → `Game3DTestMode`).
- Collision within the project (`src/scripts/<Name>.ts` exists) → append `2`, `3`, …
- Class name, file name, and the `RegisterClass` string MUST always agree.

**Script Components** authored by the agent (per the two-tier architecture, §4.4) also live in `src/scripts/` — same rule: copy patterns from `classes/`, author in `scripts/`. Per `react-framework.md`, `src/scripts/` is the mandated root for new scripts; sub-folder organization within it is at the agent's discretion.

**Hard agent constraint (baked into every system prompt, §4.2):**
- **NEVER create, edit, or delete files under `src/babylon/classes/**` or `src/babylon/system/**`** — these are the read-only demo library and framework internals respectively. Read them freely for reference; modify never.
- **ALL project game code (GameModes + Script Components) is authored under `src/scripts/`.**
- If a user explicitly asks to change a demo class, copy it into `src/scripts/` first and modify the copy; explain that the library is read-only.

### 4.4a New Project — Entry Points & Routing

Three paths, separated by user intent. **The wizard NEVER interrupts a user who typed a specific prompt** — that is a bug, not a feature.

**Path A — Typed a prompt (Bolt-native; most common for returning users):**
1. User types on the New Project screen: *"make me a kart racer where the cars are shopping carts"*.
2. **Registry seeding:** match the prompt against `game_registry` entries (each row carries `match_keywords[]` + description; simple keyword/synonym scoring is sufficient — no LLM call needed for v1; an LLM classifier is an allowed later refinement). Best match ≥ threshold → seed the project from that entry (AppTemplate snapshot + its `game_mode` + optional `scene_url`).
3. **The seed is visible and reversible:** a chip in the chat header reads *"Started from: Racing — change"*; changing re-seeds from a different entry (project is new; nothing to lose).
4. The user's prompt runs IMMEDIATELY as the first generation against that seeded project. **No wizard. No interstitial. No "pick a template" prompt after they already told us what they want.**
5. No entry scores above threshold but the prompt IS specific (e.g. an unusual genre) → seed from the **Blank Canvas** entry (minimal default GameMode, no scene) and run the prompt. Never block on ambiguity when intent is clear.

**Path B — Clicked a registry card:** project created from that entry → straight into the builder with an empty chat. No wizard.

**Path C — Guided Tour (§4.7):** entered by (i) explicitly clicking **"Not sure what to build? Take the guided tour"** on the New Project screen, or (ii) typing something too vague to act on (see threshold below). Only in these cases does the wizard appear.

**Vagueness threshold (the ONLY automatic route to the wizard):** a prompt that names no genre, no mechanic, and no subject — e.g. *"I want to make a game"*, *"help"*, *"something fun"*. Implementation: no registry match AND no actionable nouns/verbs. Even then, the wizard is **offered, not forced**: *"Want a guided setup, or just start from a blank scene?"* Anything with a discernible subject ("a game about a robot in a maze") is Path A — seed and run.

**Precedence rule (never violate):** explicit user input > inference > guidance. A typed prompt always beats a suggested template; a picked card always beats a matched keyword; the wizard only ever appears when asked for or when there is genuinely nothing to act on.

**Registry data addition:** `game_registry` rows gain `match_keywords text[]` (e.g. Racing: racing, race, kart, car, driving, drift, lap, track, speed) to power Path A.

### 4.4c The Frontend & the Play Contract (landing page → full game UI)

AppTemplate ships the landing page pre-extracted at **`src/pages/Home.tsx`** (+ its own `Home.css`); `app.tsx` is a lean routing shell (BrowserRouter + NavAdapter + lazy `/play`). The platform therefore never performs surgery on the router — it rewrites one already-isolated page.

**The shipped `Home.tsx` is also the agent's CORRECT-USAGE EXAMPLE:** it imports `useUnifiedNavigation` (never `GameManager`), keeps Babylon out of the main bundle, and calls the play contract properly. Imitate its navigation pattern; replace its content.

**FULL REDESIGN — TOTAL REPLACEMENT, NOT AN EDIT.** `Home.tsx` and `Home.css` are OVERWRITTEN with a landing page designed from scratch for THIS game. **Nothing from the starter page survives** — no hero/logo montage, no "React + Vite + BabylonJS" heading, no demo buttons, no Documentation/Asset-Library links, no Vite-community "Connect with us" section, **no footer, and NO Babylon Toolkit / BabylonJS / Vite / React attribution or branding of any kind.** The starter page is scaffolding to be thrown away; the user's game gets its own front door (theme per §4.4a; honor any landing-page instructions in the prompt). The ONLY thing carried forward is the navigation PATTERN (`useUnifiedNavigation` → play contract, §4.4c), not any markup, styling, copy, or link.

**LAYOUT LAW — full-bleed by default, ALWAYS responsive (non-negotiable, applies to EVERY UI surface).** This binds the landing page, `src/components`, and the game chrome in `src/custom/**` alike; a violation is a generation-quality **defect**, not a taste call, and is enforced in the hard-constraints section of the baked prompt (`20-hard-constraints.md` "Layout law"). Two rules: **(1) FULL-PAGE-WIDTH BY DEFAULT** — the design fills the viewport edge to edge; do not wrap the page in a centered fixed-width column (`max-width: …px; margin: 0 auto`, a `.container`, a hard `width: 960px`). Root/section containers are `width: 100%`; backgrounds/heroes/nav are full-bleed. Inner *content* may still cap its own line length for readability **inside** a full-bleed section. A boxed/fixed-width layout is built **only when the user explicitly asks for one**; absent that instruction, full-bleed wins. **(2) ALWAYS RESPONSIVE** — every layout adapts cleanly from ≈320px phones to ≈2560px desktops with **no horizontal scroll at any width** and nothing clipped or overlapping: fluid units (`%`/`vw`/`dvh`/`rem`/`fr`/`clamp()`), fl*ex*/grid that reflows (`flex-wrap`, `auto-fit`/`minmax`), `@media` breakpoints that restack multi-column → single-column on mobile, `max-width: 100%` on `img`/`video`/`canvas`, and the starter's `<meta viewport>` kept intact. Responsiveness ships in the SAME generation as the design — never a deferred polish pass.

**ASSET-IMPORT HYGIENE (prevents the exact "Failed to resolve import" crash seen in Phase 1):**
- The starter's landing-page images live in **`src/assets/`** (`hero.png`, `player.png`, `react.svg`, `vite.svg`) — these are what the shipped `Home.tsx` imports. **Use whichever ones the new design genuinely calls for — and simply DON'T IMPORT the rest.**
- **NEVER DELETE image files from disk.** Unused assets stay in `src/assets/` (and `public/`); they cost nothing and may be wanted by a later redesign. **`public/babylon.png` + `public/spinner.png` are framework-required** (§4.4), as are their sources in the read-only framework zone (`src/babylon/assets/`, ESM-imported by the preloader): never delete either copy. Removing an import is not permission to remove a file.
- **Only import images that provably exist** — files already in the project, or ones generated this session (e.g. via the project's `.mcp.json` image servers, §4.14). NEVER import an asset path you did not verify or create.
- After rewriting, **zero unresolved imports** may remain — Vite fails hard and the preview goes blank.

**The play contract (the ONE invariant):**
Launching gameplay = calling the framework's unified navigation:
```ts
navigate('/play', { gameMode: '<RegisteredModeClass>', sceneUrl?: '<optional scene>' })
```
This call is an **API the frontend invokes**, not a button the frontend must contain. The agent may restructure the entire frontend freely — the contract is only that gameplay is entered through a valid `navigate('/play', …)` with a **registered** GameMode class (§4.4b) and, where used, a resolvable `sceneUrl`. Never break, stub, or bypass it; never route to `/play` with an unregistered mode.

**After-action questions (mandated by `project-installer.md`):** after project creation the agent offers next-step suggestions ("Create a new game mode?", "Design a user interface?"). The platform renders these as clickable chat suggestions — natural onboarding for non-developers.

**Creation-time landing page (scaffolding, not the final product):**
- Overwrite `src/pages/Home.tsx` + `Home.css` with a landing page designed from scratch for this game — nothing from the starter page survives (no hero montage, no demo buttons, no Vite/React/Docs links, no footer, no Toolkit/BabylonJS attribution or branding). Styled with the Toolkit UI design system (`ui-design-system.md`, already in the prompt bake).
- Wire ONE primary play action to the project's own GameMode + the registry entry's `scene_url` — **but the page MAY define N play actions** (e.g. "Race" / "Free Roam" → different registered modes), and a design MAY have **no play button at all** if the flow reaches `/play` from deeper UI.
- Theming per §4.4a routing: card-created → registry vibe defaults; prompt-created → themed to the game's subject; **landing-page instructions present in the prompt → honored explicitly** (the system prompt directs the agent to LOOK for frontend/landing-page intent, not only gameplay intent — e.g. "dark minimal landing that just says ENTER").

**Creation-time chrome — splash, preloader, overlay (scaffolding, like the landing page):**
**The full landing-page + chrome redesign PROCEDURE lives in the `bt-landing` skill (2026-07-18):** the creation brief delegates to it (with a fallback to the baked "Layout law"/"Chrome rewrites" prompt sections while the skill is absent from the synced repo), creation preloads `bt-landing` + `bt-design`, and the user can re-run `/bt-landing <new brief>` any number of times to redesign the whole frontend shell until they like it — each run replaces the design; the invariants in this section bind every run.

The landing page is not the only starter surface that ships Babylon-branded. On a new project the agent also redesigns the game's **chrome** in `src/custom/**` to the SAME design — the starter's default splash, preloader, and overlay carry the Babylon logo/spinner and placeholder copy, and §2.3 forbids that branding reaching the user's game exactly as it does on the landing page. This is a **restyle that preserves wiring**, not a free-for-all — each surface is functional:
- **Preloader** — `src/custom/loading.tsx`. Shown before the app mounts. It **re-exports `babylonLogo`/`spinnerLogo`** that `splash.tsx` imports — a rewrite keeps those exports (or updates `splash.tsx`'s import). `public/babylon.png` + `public/spinner.png` stay (framework-required, §4.4), whatever the new design displays.
- **Splash / loading screen** — `src/custom/splash.tsx` + `splash.css`. Shown while the 3D scene loads. **Keeps the `GameManager.EventBus` `"OnLoadProgress"` subscription and its status text** — real load progress, not decoration.
- **Initial overlay** — `src/custom/overlay.tsx` + `overlay.css`. The in-game HUD layer, shipped as a placeholder. Gets a minimal, themed starting point (a title/brand corner, a frame); the full HUD grows later with the gameplay features (§4.4c growth path). **Keeps `pointer-events: none` on the container** so input reaches the canvas — only genuinely interactive elements go `pointer-events: auto`.
- **Bundle-integrity nuance:** unlike `src/pages`/`src/components` (which must stay Babylon-free — see below), `src/custom/**` renders in the viewer context, so it MAY import `GameManager`/`EventBus` for game data and `useUnifiedNavigation` for navigation (`splash.tsx` already imports `GameManager`). The read-only list below does NOT include `custom/**` — it is a write zone.

**Growth path — the frontend is a first-class generative target:**
Landing page → full game frontend is expected and supported. The launch MECHANISM never changes; what changes is WHO computes its arguments — a hardcoded button at first, a menu flow later. A racing project may evolve into: title screen → track select → car select → race-type/options → **Start Race**, where the button computes `gameMode` (e.g. `FreeDriveMode` vs `TimedRaceMode`) and `sceneUrl` (the chosen track) **from the player's selections** and then calls the play contract. The agent authors these screens in the write zone (`src/pages/`, `src/components/`; game logic in `src/scripts/`).

**Passing richer configuration to the GameMode (chosen car, difficulty, lap count, …) — the channel EXISTS:**
`navigate(path, state)` carries a generic **NavigationState** object; the host nav adapters persist it to `sessionStorage` under `NAV_STATE_STORE_KEY`, and `BabylonSceneViewer` reads it back via `readNavStateStore()`. `gameMode`, `sceneUrl`, and `reloadPage` are simply its known keys — **additional selection data travels in the same state object**, read by the GameMode on start. This is the sanctioned channel: the agent NEVER invents side channels (no `window` globals, no query-string smuggling of game config, no ad-hoc localStorage). Note the framework's deliberate security property: nav state is sessionStorage-scoped, NOT in the URL, so users cannot craft links with a spoofed `gameMode`/`sceneUrl` — do not "improve" this by moving state into the URL.

**BUNDLE-INTEGRITY RULE (framework-mandated; an AI will violate this by default):**
- **React UI code** (pages/components — landing page, menus, track/car select) MUST navigate with **`useUnifiedNavigation`** and MUST NOT import `GameManager` (or any Babylon module). Importing `GameManager` into UI pulls the entire Babylon runtime into the main bundle and destroys initial load performance — the whole reason `/play` is a lazy chunk.
- **Game code** (GameModes, Script Components in `src/scripts/`) uses **`GameManager.NavigateTo(path, state)`**.
- Keep all Babylon imports inside the lazy `/play` route chunk.

**Read-only (never edit — §4.4b zones extended):** `app.tsx` routing shell, `src/routing/**`, `src/babylon/system/**`, `src/babylon/classes/**` (demo sources; the shipped `Home.tsx` content is likewise a *source* to rewrite, its router wiring untouched).

### 4.5 Identity, Accounts & Persistence (Supabase)

> **Status: IMPLEMENTED (Stage 3, 2026-07).** Sub-spec: `spec/billing.md` (which also records four deliberate divergences from the original billing design — read it before assuming §4.6 describes the code).

bolt.diy ships **no** user system (local, single-user, browser-persisted). This entire layer is net-new; Supabase Auth is the identity provider so we never store passwords or build token handling ourselves.

**Local mode (Supabase unconfigured) is a REAL, supported mode — not a stub.** The platform resolves to a single verified local developer with filesystem persistence, a working append-only ledger, real ownership checks, and byte-faithful snapshots. This is what made Stage 3 buildable and testable before a Supabase project, an S3 bucket, a Stripe account, or the license service existed (§1.3 principle 0) — and it is the single-user posture bolt.diy shipped with, so local dev behaves as it always did. It can never reach production by accident: `assertNotLocalInProduction` **refuses to boot** into the anonymous local user when `NODE_ENV=production`, because that fallback treats every caller as a verified admin.

⚠️ **The platform Supabase is NOT the one in §4.15 (Game Backends).** That one is the *user's own* project, reached through upstream's connector with `VITE_SUPABASE_*` — values that are public by design. Ours holds accounts, projects and the credit ledger, and its service-role key **bypasses RLS**. Platform secrets are therefore never `VITE_`-prefixed: Vite inlines every `VITE_*` variable into the client bundle, so doing so would hand every visitor every row in the database.

#### 4.5.1 Authentication

- **Methods (launch):** email + password, and OAuth via Google and GitHub (GitHub doubles as groundwork for Phase 4 repo export). Magic-link email sign-in optional flag. All through Supabase Auth — password hashing, token issuance/refresh, OAuth handshakes, reset flows are theirs, not ours.
- **Sessions:** Supabase-managed JWTs with refresh; server-side session validation on every authenticated route (`@supabase/ssr` pattern in the Remix server). Tokens in secure, httpOnly-where-possible cookies per the library's Remix guidance; never in localStorage beyond what the library requires.
- **Email verification:** required before the free credit grant (§4.5.4) and before Share/publish. Unverified accounts may open the builder and look around (reduces sign-up friction) but cannot generate.
- **Flows owned by Supabase, skinned by us:** password reset, email change (re-verification), OAuth account linking (same verified email = same account; conflicting links surfaced, not silently merged).
- **Anonymous visitors:** may browse `/gallery` and play `/play/[shareId]` with no account (the zero-cost funnel). Any creation intent — New Project, wizard, **Remix** — hits the sign-up gate, and the intended action is preserved through auth (post-signup redirect completes the remix/new-project the visitor started).
- **Sign-out everywhere** and session revocation via Supabase; account **deletion** (self-serve, Settings): projects, snapshots, messages soft-deleted then purged on schedule; ledger rows are **retained** (financial record, disassociated from PII where legally required). Deletion requirements vary by jurisdiction — legal review before public launch (open question).

#### 4.5.2 Profiles

- `profiles` row auto-created on first sign-in via Supabase trigger: `id (= auth.users.id), display_name, avatar_url, created_at, updated_at`.
- Defaults: display_name from OAuth name or email local-part; avatar from OAuth or generated placeholder. Editable in Settings.
- **Public surface is minimal by design:** display_name + avatar appear only on gallery entries the user chose to publish. Email is never public. No public profile pages at launch (Phase 4+ consideration alongside the community features).
- Display names sanitized (length, charset, reserved words) since they render on public gallery pages.

#### 4.5.3 Authorization

- **RLS on every user-facing table** (`user_id = auth.uid()` ownership policies; gallery/play reads via explicit public-read policies on published artifacts only).
- **Server-route middleware — the second wall:** every server route that touches a project (agent proxy, snapshot read/write, share/build, export) validates session **and project ownership**, not merely "logged in." RLS is the backstop; the middleware is the front door. This is a code-review checklist item from day one.
- Admin routes gated by an `is_admin` claim/allowlist, entirely separate from user auth paths.
- The agent proxy additionally enforces per-user rate limits and the credit gate (§4.6) after ownership passes.

#### 4.5.4 How identity ties to credits

Credits are meaningless without identity — the ledger is keyed on `user_id`, and every enforcement point resolves the authenticated user first:

1. **Grant at verification, not signup:** the free starter grant (§4.6) is written to `credit_ledger` (`reason='grant'`) only when email verification completes — one grant per user, enforced by a partial unique index (`user_id, reason='grant'`), so re-verification, OAuth-relinking, or races can never double-grant.
2. **Every debit is attributable:** generation completes → ledger row (`reason='generation'`, `generation_id` FK) for the authenticated owner of the project. Balance = latest `balance_after` for that `user_id`; append-only.
3. **Purchases bind Stripe to the user:** Stripe Checkout sessions are created server-side with `user_id` in metadata and the `stripe_customer_id` stored on the profile; the webhook writes the `purchase` ledger row against that user (idempotent on `stripe_ref`). A payment can never credit the wrong account because the linkage is server-asserted, not client-supplied.
4. **The credit gate is an auth-context check:** agent proxy resolves session → user → **BYOK-entitled? else balance** before any platform-key Anthropic call; unverified users and zero-balance users are blocked at this single choke point. A user with an active Pro entitlement AND BYOK enabled bypasses the credit charge (their own key pays); everyone else is on the ledger.
5. **Abuse containment is per-identity:** rate limits, device heuristics, and the grant kill-switch (§4.6) key on `user_id` (+ verified email domain heuristics); one identity = one grant = bounded free exposure.
6. **The choke point is only a choke point if nothing routes around it (added 2026-07-13).** Upstream bolt.diy ships `/api/chat` and `/api/llmcall`, which resolve a provider from the request body and read the key from the server env with **no session check, no credit gate, and no ledger row** — on a deployed instance with `ANTHROPIC_API_KEY` set, either one is an unauthenticated, unattributable bill on the platform key. Nothing in this product calls them (the client posts to `/api/agent`), so they now **fail closed with a 404** — not a 403, which would confirm to a prober that the endpoint exists — behind `UPSTREAM_LLM_ROUTES_ENABLED` (`app/lib/.server/llm/upstream-routes.ts`; never set it in a deployed environment). Upstream's `/api/enhancer` was the same hole but *live* — the prompt-enhance button called it anonymously, unmetered, and took its **model from the request body** — so it now runs the full path: `requireVerifiedUser` → server-resolved BYOK → credit gate → settlement, with the model fixed server-side and input length-capped. **Any new route that can reach a provider key must go through the gate, or it is not a route — it is a hole.**
   > 🔴 **And one route did not merely spend the key — it GAVE IT AWAY.** Upstream's `/api/export-api-keys` was an **unauthenticated GET loader** that walked every provider, read its key from `process.env` / the CF env / `llmManager.env`, and returned the values as JSON: `curl /api/export-api-keys` → `{"Anthropic":"sk-ant-..."}`. This is a strictly worse failure than an unmetered endpoint — an unmetered endpoint bills us only while it is reachable, whereas **a leaked key keeps working off-platform forever**, with no gate, no rate limit, and no way to attribute the spend. The route now requires a verified user and **never reads the server environment at all** — not even as a fallback when the cookie is empty; there is no ordering of precedence that makes returning a platform secret acceptable. Its legitimate purpose is narrow: a BYOK user exporting the keys *they themselves entered*, which live in their own cookie (echoing a caller their own cookie is not a disclosure). The "is a key configured?" question is answered by `/api/check-env-key`, which returns a **boolean, never the value**. Regression-tested in `upstream-routes.spec.ts` with a platform key deliberately present in the environment. **Standing rule: a server route may act on a platform secret; it may never emit one.**
7. **Every debit's `generations` row is written BEFORE the debit (added 2026-07-13).** `credit_ledger.generation_id` is a foreign key to `generations(id)`, and `settleGeneration` may never throw (§4.6) — so a missing row is a `23503` that gets caught, logged, and swallowed, and **the generation bills zero**. Silently, on every generation, forever. The row is therefore anchored inside `settleGeneration` itself (`app/lib/.server/billing/generations.ts`), not left to a caller's ordering, so every settlement path gets it for free. Pinned by `billing.spec.ts` with a ledger that enforces the same foreign key Postgres does — `FsLedger` has none, which is exactly how this survived to production.
6. **BYOK is Pro-gated:** the `byok_enabled` profile flag is honored ONLY while an active Pro Tools entitlement exists (checked server-side per generation — a lapsed subscription silently falls back to credits with a friendly notice). Key stored client-side only; generations are still recorded (tokens, `credits_charged=0`) and rate limits still enforced.

#### 4.5.4b Persistence model — REPO-PRIMARY (BUILT 2026-07-16)

> **Status: BUILT + LIVE-VERIFIED ON GITHUB (2026-07-18).** The user's game code lives in their own GitHub/GitLab repo; the platform holds the project record + chat and no files. §4.13's GitHub Sync is no longer an optional bridge — it IS the storage backbone.
>
> **Live verification (2026-07-18), driven through the real UI against real github.com (`MackeyK24`, private repo `blank-canvas`) — the entire GitHub flow PASSES, no defects; only GitLab remains:** Save → **private** repo created (CREATE-not-adopt); binary **byte-identity** on github.com incl. a **2 MB `havok.wasm`** (sha256-identical, lossless base64 blob round-trip); `.env` **secret-excluded** (404 + `.gitignore`); **wipe ALL browser storage → reopen → mounts from the repo** (server `Fetched 66 files`) → `npm install` → **playable** preview; **revoked-token → 401 → LOUD reconnect** (no false success); **VS Code commit → Pull round-trip** (real external clone committed `0d5925f`, `Sync from GitHub` pulled it — `Fetched 67 files`, sha advanced, safety checkpoint created first per §4.13); **network-kill mid-push → LOUD failure** (fault-injected `unavailable` in `fastForwardPush`: badge stayed "Not saved" with the error surfaced + a "Try again" affordance, no false success; recovered on retry once the fault was removed). **One step remains owner-side: repeat the whole flow on GitLab** (after the one-click GitLab OAuth connect). Caveat: the network-kill was **fault-injected, not a real OS-level socket cut** (no passwordless sudo; the host's wifi is also the agent's uplink) — the LOUD-failure UI path is exercised end-to-end, the physical-cut variant is not.
>
> **Nine deviations from the design above, each with a reason — read them before changing this area:**
>
> 1. **`buildCommit` is not a seam method.** The design listed it alongside `fastForwardPush`; making it one would have forced GitLab to fake GitHub's four-call blob/tree/commit/ref dance (GitLab commits atomically, one call with `actions[]`). The seam is `fastForwardPush` — the *outcome*. A seam that encodes one vendor's call shape is not an abstraction, it is GitHub with a second implementation bolted on.
> 2. **`ensureRepo` takes a required `adoptExisting`, and Save passes `false`.** Save DERIVES the repo name from the project title, so `deriveRepoName("My Game")` → `my-game` → a user with an unrelated `my-game` gets 422 → the original code ADOPTED it → their repo's HEAD silently becomes this game. Save now walks to `my-game-2`. Linking a repo the user *named* still adopts, which is the correct behaviour for that verb — hence a required flag rather than a default.
> 3. **Local checkpoints are ordered by a monotonic `seq`, never `createdAt`.** Two checkpoints in one millisecond tie on a clock, and the tiebreak decides which one undo restores and which one the 20-checkpoint trim discards. This is migration 0003's ledger bug (`order by seq desc`, never `created_at`) in a second place — clocks tie and clocks go backwards, so never order anything that matters by one.
> 4. **`remoteHead: undefined` (could not ask) is not `null` (branch is empty).** `selectMountSource` keeps them distinct: collapsing them lets a reload on a flaky connection decide the browser is authoritative and push over a repo it never read.
> 5. **The link is a TUPLE — `provider` + `linked_repo` + `linked_branch` are all-or-nothing** (migration 0006 constraint). It caught two live half-link writers on the way in: the sync route's `link` op never set `provider`, and `PATCH /api/projects/:id` let any caller set `linkedRepo` alone.
> 6. **A remix SEED is deposited at publish time** — the one thing the platform still stores of a user's source, and only for a game they deliberately made public. Removing server snapshots quietly broke §4.8 remix: the source pointer became `undefined` for every ordinary project, so a stranger's remix cloned nothing and produced an empty editor, silently. The owner's repo cannot fill the gap (it is private and it is theirs). `buildRemixSeed` strips the `.env` family — sharper than the push path, since a seed is handed to strangers — reusing `isSecretPath` rather than writing a second copy of "what counts as a secret".
>    - **It is stored as what it is (2026-07-16):** one object per project at `seeds/{projectId}.json`, key **derived** from the project id (`share/seed-store.ts`) — not a `Snapshot` row wearing the clothes of a deleted version history. It is a **read-only** surface (`GET /api/projects/:id/seed`; the route has no `action` — a write here would be server-side project storage under a new name), and **`unpublish` deletes it**: "make my game private again" has to mean the platform stops holding the source, or §4.5.4b is a claim rather than a behaviour. A clone gets its **own** seed under its own id, so the source being unpublished or deleted never empties someone else's remix. Binary byte-identity on this path is pinned by `seed-store.spec.ts` (the hostile-bytes tests ported from the deleted `snapshots.spec.ts` — the store went, the invariant did not).
> 7. **A restore DELETES what the incoming version dropped — it was an overlay, and an overlay is not a restore.** `restoreFiles` wrote the incoming map and removed nothing, so undo (§4.12) left the file it was undoing and "use the version from my repository" (§4.13) produced a third version that was neither. Both silent. `planRestore` is pure and exhaustively tested because it is the code that destroys the user's files: it normalises both sides through the SAME `toRepoRelativePath` the push uses (compare `/home/project/src/main.ts` against a repo's `src/main.ts` raw and nothing matches → every file is "missing" → the project is wiped), it takes a REQUIRED `protect` (a repo's map has no `.env`, so treating it as the whole truth deletes the user's keys), and an empty incoming map deletes nothing. Writing that test found a real latent bug in the shared path rule — `/home/project` with no trailing slash normalised to `home/project`, so the workdir itself was a deletion candidate.
> 8. **The chat is restored from the server on a new device — as a TRANSCRIPT, marked never-replay.** `saveMessages` was uploading every conversation and `loadMessages` had zero call sites, so a project opened elsewhere came back with its files and no history. The fix is not `setInitialMessages(serverMessages)`: parsing an assistant message RUNS its actions (that is how upstream rebuilds a project with no snapshot), so a replayed history writes stale file bodies over the ones just fetched from the user's repo. Restored messages are marked `NO_REPLAY` and routed to a second parser that renders them and executes nothing.
> 9. **Self-remix (Duplicate) sends its files from the browser.** There is no server copy of an unshared project to clone. The caller owns both sides (`requireOwnedProject`), so their own bytes are authoritative. `body.files` is IGNORED on the `shareId` path: a visitor's files are not the owner's game.

**The model (settled):** the user's game code is permanently **owned** by them and lives in **their own GitHub or GitLab repository**. Our servers hold the lightweight **project record** (name, thumbnail, chat/messages, registry seed, `provider`, `linked_repo`, `linked_branch`, `last_synced_commit_sha`, `auto_push`), plus — as of §4.5.4c — **one working copy per project, purely for crash recovery**. The live working copy still lives **in the browser** (WebContainer + inherited IndexedDB).

#### 4.5.4c Durability — the server WORKING COPY (DECIDED 2026-07-22, owner decision)

> **Status: DECIDED, NOT YET BUILT.** This amends §4.5.4b. Repo-primary stays the **ownership** model; it stops being the **durability** model.

**The failure that forced this, measured live (2026-07-22).** A `/bt-landing` redesign ran to completion on an unlinked project — `finish=stop`, 20,364 output tokens, 8 files rewritten, four generated images — and settled at **427 credits**. The browser tab then died. Re-opening the project showed the state from *before* the run: no redesign, no assets, and no mention in the conversation that it had ever happened. The server log knew it succeeded and the ledger knew it had been paid for; everything else was gone.

That is not repo-primary working as intended. Repo-primary says the user's code is *theirs* and belongs in *their* repo. It never said a completed, paid-for generation should be one tab-crash from oblivion — and §4.12 explicitly sells checkpoints and undo as **"the single most important safety net for non-developers"**, i.e. for exactly the users who do not have a git remote to fall back on. That net currently lives in IndexedDB and dies with the browser profile.

**The decision.** The platform keeps **one working copy per project** — a *recovery buffer*, not a backup product and not a version history.

**Invariants — each one is the line that keeps this from becoming the thing migration 0007 deleted:**

1. 🔴 **EXACTLY ONE OBJECT PER PROJECT, overwritten in place.** `working/{projectId}.json`. **Never a history** — no per-generation retention, no "keep the last few", no rows. Retention is what made the old `snapshots` table unbounded and expensive; "just keep N" is precisely how it grows back, so the count is one and the spec says so.
2. 🔴 **The key is DERIVED from the project id, never caller-supplied.** Same shape as the remix seed (§4.5.4b deviation 6, `share/seed-store.ts`). This is a security property, not tidiness: the deleted snapshot route took a caller-supplied id, which is exactly why it needed `assertSnapshotBelongsTo` to stop project A's owner reading project B's files. With a derived key there is no id to supply, so `requireOwnedProject` alone is sufficient — **and that stays true only while the key remains a pure function of the project id.**
3. **Two walls, as ever** (§4.5.3): verified session **and** project ownership, 404-not-403.
4. **Written on the same trigger as a local checkpoint.** One concept, one moment. A second, independent "when do we save" rule is how two writers end up disagreeing.
5. **Present whether or not the project is linked.** ⚠️ **`linked` ≠ `pushed`** — deleting the copy when a repo is linked re-opens the whole hole for anyone who links early and pushes late, which is the common case. This is why "store it until GitHub sync, then clean up" was **considered and rejected**: it makes existence conditional, and the failure mode of getting that condition wrong is deleting somebody's only copy.
6. **Deleted with the project**, by the same prefix sweep that already reaps chats (§4.5.6) — bytes must never outlive the record that named them.
7. **Binary byte-identity applies**, as on every other file path (`spec/binary-files.md`).

**What this does NOT change:** ownership (the user's code is theirs and belongs in their repo); the push/pull/divergence rules (§4.13); `.env` exclusion (`isSecretPath`); the remix seed; and the absence of a **snapshot history**. `POST /api/projects/:id/snapshots` stays non-existent.

**Save becomes SYNC.** The button is renamed because the current label conflates *durability* with *publishing to GitHub* — and that conflation is the reason a non-developer loses work: "Not saved — browser only" reads as a nag rather than as "the only copy of this is one tab-crash from gone". After this change durability is automatic and **Sync to repo** means what it says.

**Costs accepted, explicitly:**

- **Storage scales per project.** The Arcade Racing project measured **~30 MB** of generated PNGs, or ~3 MB once §4.16's `output_format: "jpg"` guidance lands. That guidance stops being cosmetic and becomes load-bearing for this decision. **BUILT 2026-07-23:** jpg is now the *default* for photographic art (not just guidance) via `resolveImageDelivery` (explicit choice wins; transparency-needing art renders as jpg and is cut out into an RGBA png — §4.16's cut-out pass) — and it had to be, because the working-copy save serializing large PNGs as base64 + `JSON.stringify` on the main thread **froze the tab at 8 GB** during a media-heavy `/bt-landing` run. The save now (1) **defers past the stream** and **size-gates** (a project over the client budget keeps its local checkpoint and skips only the server copy), and (2) runs the base64 + stringify + PUT in a **Web Worker** with transferable zero-copy bytes, so the encode can never pin the UI. See CLAUDE.md §4.16 "CONSUMING GENERATED MEDIA FROZE THE TAB".
- **The platform now holds user code.** The claim "we store no project files" ends; privacy copy must change with it.
- **A route that writes whole projects returns.** It ships with the two walls and the derived key from day one, never "added later".
- **`no-server-storage.spec.ts` stays exactly as it is, and it did NOT need changing** — a first draft of this section claimed it "pins the opposite" and would have to be rewritten. That was wrong, and checking it produced a more useful finding. It pins the absence of the **snapshot HISTORY specifically**: snapshot routes, `SnapshotStore`, `currentSnapshotId`, and any client module referencing a snapshots URL. §4.5.4c reintroduces none of those, so the whole suite went green with a working-copy store added — **which means that guard would never have caught this coming back under a different name.** A second guard is therefore required, asserting the NEW rule (`one-working-copy.spec.ts`): exactly one object per project, no retention, a key derived from the project id, and no caller-supplied storage id anywhere on the path. Two guards, two distinct rules — the old one keeps history dead, the new one keeps the buffer bounded.

**Lifecycle:**
- **UNLINKED (browser-only):** every new project starts here — newbies run a prompt or two and see a working game with ZERO friction (no repo, no OAuth). Honest consequence, stated in the UI: clear browser data / switch devices before linking = the code is gone (the chat record survives; the files do not).
- **SAVE = LINK:** "Save your project" connects GitHub or GitLab (OAuth), creates a private repo in *their* account (or links an existing one), pushes. The repo is now the project's permanent home.
- **LINKED:** a **commit + push** of the browser working copy happens **only when the user presses "Commit changes"** (owner decision, 2026-07-23 — auto-push on checkpoint is RETIRED; the post-checkpoint hook is a status READ, so the chip can go amber "Changes not synced"). Writing to a user's own account is the one action that leaves the platform and lands somewhere with their name on it — it takes a person. Commit messages still default to the generation summary. **LINKED ≠ SYNCED, and the copy says so:** the chip reads "Linked to GitHub" (a permanent fact about the project), never "Synced to GitHub" (a claim about the repository's current contents that nothing verified once nothing pushes automatically). `autoPush` remains a stored field that nothing reads; reviving it as a toggle is an owner decision, not a code change.
- **RELOAD (any device / lost browser):** open project → server record → fetch linked branch head → mount fresh WebContainer → `npm install` → resume. Local IndexedDB newer than `last_synced_commit_sha` → prefer local, prompt to push. Remote ahead (VS Code commits) → pull per §4.13 (checkpoint first; asset introspection re-runs; agent gets the externally-changed-files note). **This is the round-trip: create here → iterate in VS Code with their own AI → commits flow back.**

**UI surface (required):** LINKED/UNLINKED indicator on project header + dashboard cards (UNLINKED = amber "Not linked to GitHub"; LINKED = provider icon + repo@branch, quiet, amber "Changes not synced" when the browser holds work the repo does not). Unsaved-work nudges — **milestone-based, never timed nags, never blocking generation**: a **long, loud save-reminder toast after EVERY new project's first creation** (per PROJECT, not once per user — every unlinked game is one cleared-cache or device-switch from lost, so each one earns the reminder; `saving.introToastAutoCloseMs`, default 60s, or `false` to require a dismissal — keyed `bt_saving_intro_shown:<projectId>`); dismissible banner every N generations (default 5) while unlinked; `beforeunload` warning with unsynced work; Commit always one click in the header. Help page `/help/saving-projects` in plain non-developer language (what GitHub/GitLab are, why the game lives in THEIR account, the VS Code round-trip).

**Provider abstraction (required):** a `GitProvider` seam — oauth/connect, ensureRepo(private), getBranchHead, fetchTree, buildCommit (base64 binary blobs), fastForwardPush — with **GitHub** (the §4.13 machinery generalized) and **GitLab** (REST commits API) implementations. **Binary byte-identity extends to provider round-trips** (`binary-files.spec.ts` discipline): a PNG/GLB committed and re-fetched MUST be sha256-identical.

**What stays on our infrastructure:** project record + messages (Postgres), play builds (S3/CloudFront), skill resources, template snapshots/pins (§4.4), and **remix seeds** — a published game's source (§4.8), the one deliberate exception. **What leaves:** user project files as a server-held permanent store. In-session checkpoints (§4.12) are local, with commits as the durable history for linked projects. Remix clones files into a NEW unlinked project — the link never travels.

> **⚠️ This paragraph used to end "the `ObjectStore` snapshot seam REMAINS dormant as documented fallback". It does not — it was DELETED (migration 0007, 2026-07-16).** Keeping the machinery dormant meant a `snapshots` table with a live RLS policy, both store backends, and a route that stored whole projects and merely declined to. That is not a fallback, it is the old model one call site away from returning, and the §4.5.5 note above records what came out. The **ObjectStore itself remains** and is load-bearing (play builds, template pins, skill resources, seeds) — it is the *snapshot* layer on top of it that is gone.

**Honest risks, owned:** OAuth tokens expire → refresh + loud re-connect prompt (a lapsed token must never silently drop saves); provider rate limits → queued, retried, visible push status (a failed save is LOUD); asset-heavy repos → shallow fetches + repo-size cap; Git-LFS explicitly OUT of scope v1 (documented limitation). Completes §4.13's remaining hardening: server-side OAuth app tokens, not the inherited connector cookie.

#### 4.5.5 Data model

RLS on all user-facing tables.

```sql
-- auth.users                     (Supabase-managed: credentials, identities, verification)
profiles         -- id (= auth.users.id), display_name, avatar_url,
                 -- stripe_customer_id?, byok_enabled bool, is_admin bool,
                 -- created_at, updated_at
projects         -- id, user_id, name, template_id, share_id (nullable unique),
                 -- remix_seed_at? (§4.8: a HINT that this published game has a seed —
                 --   the seed's key is derived from the project id, so this is never
                 --   an address. Replaced current_snapshot_id, dropped in 0007.)
                 -- provider?, linked_repo?, linked_branch?,   -- all-or-nothing (0006 constraint)
                 -- auto_push (not null, default true),
                 -- last_synced_commit_sha?, github_installation_ref?, created_at, updated_at
git_tokens       -- user_id, provider, access_token_encrypted, refresh_token_encrypted?,
                 -- expires_at?, provider_login, created_at, updated_at
                 -- pk (user_id, provider). RLS ENABLED WITH NO POLICY, deliberately:
                 -- service-role only. A user's own session must never read these rows.
templates        -- (see 4.4)
-- snapshots     -- DROPPED (0007). The platform stores no project files (§4.5.4b).
--                  Checkpoints are local (IndexedDB); the one server-held copy of a
--                  user's source is a published game's remix seed, and it is an OBJECT
--                  at seeds/{projectId}.json, not a row. See §4.5.5.
-- messages      -- NOT a table. A project's conversations are OBJECTS at
--                  messages/{projectId}/{serverChatId}.json — written whole every turn,
--                  read whole on resume, never queried by row, and megabytes. MANY per
--                  project (§4.5.6). The table can be added beside them if per-message
--                  queries (admin search, analytics) are ever actually needed.
generations      -- id, project_id, message_id, model, prompt_version_id,
                 -- input_tokens, cached_input_tokens, output_tokens,
                 -- skills_loaded text[], credits_charged, status, error, created_at
prompt_versions  -- (see 4.3)
skills           -- id, name (spec-valid), description, is_active, created_at (see 4.11)
skill_versions   -- id, skill_id, body, resources_manifest jsonb, storage_prefix,
                 -- source_commit_sha, content_hash, is_active, created_at
credit_ledger    -- id, user_id, delta, reason (purchase|generation|grant|refund|promo),
                 -- generation_id?, payment_provider?, payment_ref?,
                 -- balance_after, created_at
                 -- partial unique (user_id) where reason='grant'
credit_packs     -- id, name, credits, price_cents, provider_price_ref, is_active
entitlements     -- id, user_id, source ('protools_subscription'), tier
                 -- (indie|small_business|enterprise), status (active|lapsed),
                 -- subscriber_email, last_validated_at, expires_at?, created_at
```

- **Snapshot policy — the machinery is DELETED, not dormant (§4.5.4b; migration 0007, 2026-07-16).** The platform no longer snapshots a user's project at all: checkpoints are **local** (IndexedDB, `local-snapshots.ts`, 20 per project, ordered by monotonic `seq`), and durable history is the commits in the user's own repo. Resume = `selectMountSource` → local / repo / seed / diverged (`npm install` only when `node_modules` is absent or the lockfile moved).
  - **What went, and why "dormant" was the wrong answer.** §4.5.4b originally kept the `SnapshotStore` (both backends), the `snapshots` table, and a 405-refusing write route — the behaviour removed, the machinery left standing as a "documented fallback". That is a door with a lock on it: an uncalled route that stores a whole project re-opens by being called, and a live RLS policy on a `snapshots` table is a standing invitation to write to it. Migration 0006 removed the writes and left the entire schema; **0007 drops the table, its index, its policy, and `projects.current_snapshot_id`**, and the interface, both backends, both routes, `buildManifest`, `snapshotKey` and `assertSnapshotBelongsTo` are gone with them. `POST /api/projects/:id/snapshots` does not refuse — **there is no route**.
  - **`current_snapshot_id` → `remix_seed_at`, and the rename is the point.** The field kept a real meaning on published projects (it pointed at a remix seed) under a name describing the per-generation history that no longer existed. A field named for a deleted system is how the deleted system comes back. The seed is now one object at a key **derived** from the project id (`share/seed-store.ts`) — so there is no id to keep in sync, and no caller-supplied id to cross-check, which is why `assertSnapshotBelongsTo` needed no replacement.
  - Pinned by `no-server-storage.spec.ts` (routes absent, store absent, no client helper, a comment-stripped source scan **with a control proving the scanner works**) and by `ledger-sql.spec.ts` against the real migrations under PGlite (no `snapshots` table, no `current_snapshot_id`, `remix_seed_at` present).
- Balance = latest `balance_after`; ledger append-only, never a mutable counter.

#### 4.5.6 Many chats per project — "New chat, same game" (BUILT 2026-07-16)

**A project holds many conversations.** A user can start a fresh context on a game they are already
building: the files stay exactly where they are, the history does not come along. The existing chats are
untouched — this is another conversation, not a replacement.

**Why.** A project used to hold exactly ONE chat. That was never a decision — it was upstream's model
showing through, where the chat *was* the project and 1:1 was a tautology. Two things make it wrong here:

- **Game projects are long and phase-shaped.** The `bt-spec` → `bt-plan` → `bt-execute` loop has natural
  context boundaries, and each phase is grounded by artefacts on disk (`SPEC.md`, `CLAUDE.md`, the plan)
  rather than by the talking that produced them.
- **The conversation is the one thing we re-send at full rate, forever.** It is UNCACHED (§4.2.8, all
  four breakpoints are on the system blocks) and grows without bound, so by the execute phase every turn
  pays to re-send the spec discussion. `HISTORY_WINDOW_TURNS` bounds that bill, but it does so by
  *forgetting* — on a mature project you pay to re-send a conversation that has been silently truncated
  anyway. Starting a new chat is the honest version of the same saving.

**Nothing is lost, because the conversation was never the grounding.** Every turn the agent is sent the
project's files fresh from the WebContainer FS, the project's `CLAUDE.md` as its own instructions block,
and the skills index. A new chat sees the whole game; it just does not see the talking.

**`/clear` is this feature's chat-command spelling (2026-07-18, `app/lib/chat/client-commands.ts`).**
Typing `/clear` (aliases `/new`, `/newchat`) in the chat box takes the same path as the header's ⋯ "New
chat" — intercepted in the BROWSER before anything is posted, so it costs zero credits and never reaches
the model. The parser is pure + tested and matches the bare command ONLY (exact after trim,
case-insensitive): `/clear the obstacles` is a message for the agent, and a prefix match would silently
swallow it. With no project yet it falls back to a full-page load of `/` (the sidebar's "Start new
chat"), because an SPA navigate without the baton inherits the old chat's identity.

**🔴 With a project open, the reset happens IN PLACE — it must NEVER re-mount the project (amended
2026-07-25, `app/lib/stores/chat-reset.ts`).** Both entry points originally hand-balled to the mount
baton (`setPendingOpenProject(pid, 'fresh')` + `navigate('/')`), reusing the path a dashboard Open takes.
Sound as reuse, wrong as behaviour: the baton exists to mount a project that is NOT open, and here it
re-mounted one that never left — `mountProjectFiles` ran again, the route remounted, and the workbench
tore down and slid back in. The user asked for the left-hand column to be emptied and watched the whole
workspace reload ("it makes the workflow look broken"). Clearing a conversation is not a project event.
So the already-mounted case resets only what belongs to the CONVERSATION — the message array, the chat
identity (via the same pure `identityForMount({ freshChat: true })` the mount path uses, so an inherited
`serverChatId` can never make the new chat save over the old chat's server transcript), the parsed-message
cache (keyed by INDEX — leaving it standing renders the previous chat's message 0 in the new chat), the
context stats, the repair chain, and the URL (`replaceState` to `/`, never `navigate`, which would re-run
the mount effect). It touches NOTHING of the project: not the WebContainer, not the file tree, not the
preview, not `showWorkbench`, not `chatStore.started`, not `chatStarted` (the open-state effect keys on
`activeProjectId`, which has not changed — flipping it back replays the landing intro over an open game).
The two entry points meet at a monotonic signal store (`requestChatReset()`), because the conversation is
`ChatImpl` component state and the ⋯ menu is outside it; listeners compare against the value they last
saw, seeded from the CURRENT value at mount (the store is module-level and survives an SPA navigate, so
seeding from 0 would replay a reset on every remount). **The baton path stays correct where the
DASHBOARD uses it** (`ProjectsDashboard`, `'fresh'`) — there the project genuinely does need mounting; do
not collapse the two. Pinned by `chat-reset.spec.ts` (mutation-verified: restoring the baton fails it).

**`/context` (alias `/usage`) + the context health dot (2026-07-18)** answer "when should I clear?".
The proxy measures the re-sent conversation AS IT WENT ON THE WIRE — post-compaction, post-window
(`historySize` in `llm/history.ts`, threaded through the generation handle into the `agentMeta`
annotation) — and the client (`app/lib/stores/context-stats.ts`, pure `contextHealth` + tested) folds
it with the `usage`/`credits` annotations into a green/amber/red dot on the chat box
(`ContextIndicator.tsx`); `/context` or clicking the dot opens the breakdown (history msgs/tokens vs
window, cached-read 0.1x, uncached input, cache writes 2x, output, last-turn credits, model). The
client NEVER estimates history from its own messages — it holds the un-compacted copy, which is
exactly the number that does not matter. Amber = half the `HISTORY_WINDOW_TURNS` window; red = the
window is about to start silently dropping the oldest turns, i.e. `/clear` now costs nothing that was
going to be kept anyway. Stats are seeded on reload from the last assistant message's persisted
annotations, and RESET before seeding — "New chat, same game" mounts with no messages, and inherited
stats would report the context the user just cleared.

**Never regress these — each fails silently:**

- 🔴 **The chat's server id is a minted UUID, NEVER the browser's chat id.** `getNextId` is
  `max(local keys) + 1` — a per-browser counter that hands out `"1"`, `"2"`, `"3"`. Keying the server
  transcript by it makes this laptop's chat "1" and that desktop's chat "1" **the same object**: two
  devices, one project, one silently destroys the other. Under §4.5.4b the conversation is the only
  thing we still store for the user, so that overwrite is data loss. The id lives in
  `IChatMetadata.serverChatId`, is minted at FIRST SAVE (an abandoned empty chat costs nothing), and
  `messagesKey` accepts a UUID and nothing else — a whitelist, so `"1"` and `../../seeds/{other}` are
  both refused by default. Upstream keeps `getNextId` and the URL scheme; we add ours beside it (§2.1a).
- 🔴 **Deleting a project sweeps a PREFIX, not a key.** `deleteMessages` deleted one object because
  there only was one; left alone it would delete a key that no longer exists, report success, and strand
  every real transcript with nothing left that can name them. It sweeps `messages/{projectId}/` and the
  legacy key.
- 🔴 **Deleting a chat deletes it on the SERVER too, or it resurrects.** The sidebar's delete was
  upstream's: it removed the IndexedDB record and stopped. Since `restoreTranscript` reads the server
  copy on open, the chat the user deleted **came back on the next open** — the delete did not delete it,
  it hid it until the next mount. Server first, while the local record still holds the ids that address
  it; the project and its other chats are deliberately untouched.
- **A restore keeps the chat's server id.** Minting a new one on a device switch uploads the same
  conversation again under a second id, so the user's chat list grows by one every time they open the
  project elsewhere.
- **The mount baton's chat slots are always written, never merely set.** A leftover id from a previous
  open silently restores the WRONG conversation — which reads as data loss while everything is in fact
  still there. A remix never inherits one: it is a new project, and that id names a conversation
  belonging to the project it was cloned FROM.
- **Pre-§4.5.6 transcripts are adopted on READ**, at a synthetic id derived from the project id and
  shaped so no minted v4 UUID can equal it. Continuing one migrates it to its own object and drops the
  old key (`putChat`) — otherwise the same conversation lists twice, forever. `listChats` prefers the
  real object, so a failed migrating delete never becomes visible.

#### The sidebar is the ACCOUNT's chats (2026-07-16)

The chat list follows the user between devices, the way claude.ai's does. The browser is a **local
staging area**: the platform holds the project record and the conversation, the user's code lives in
their own repo (§4.5.4b), and the sidebar is a view of the account rather than of one profile.

It was `getAll(indexedDb)` filtered by `urlId && description` — so a chat started on a laptop did not
exist on a desktop, and clearing site data destroyed the list, *while the transcripts sat on the server
the whole time with nothing listing them*. That was never a decision: upstream's chat WAS the project
and lived in IndexedDB, and the server copy was added underneath without the list ever learning of it.

- **`chats` (migration 0008) is a metadata INDEX; the objects remain the truth about existence.** A
  global list cannot read every transcript body on the platform to render a row of titles, so titles
  move into a queryable table — but an index that is authoritative about existence turns a failed row
  write into a conversation that is silently gone. So: an object with no row is still listed and its row
  is **backfilled** (the index heals by being used); a row with no object is not listed; `putChat`
  writes the object first and a failed index write never fails the save. A ghost row is left rather than
  pruned — a transient `list` failure must not delete a healthy account's sidebar.
- **No `user_id` column.** Ownership is inherited from the project (the `snapshots` pattern from 0001),
  and `/api/chats` resolves the caller's projects first, so the chat query can only ask about ids that
  ownership has already cleared.
- 🔴 **A chat's URL is its ID.** Upstream routed `/chat/<slug-of-the-title>`, de-duplicated against ONE
  browser's IndexedDB (`getUrlId` appends `-2`). That cannot address a chat once there is more than one
  user: `/chat/start-dev-server` is not unique, the de-duplication cannot see other accounts, and the
  same conversation got a different URL on every device. It also leaks the conversation's title into the
  URL bar and every proxy log. The URL is the `serverChatId` — a v4 UUID, minted in `mintUrlId` (free),
  kept by `restoreTranscript`, and resolved by `openFromServer` when the browser has no record, so a
  chat link works on a cold device. Someone else's id simply is not in their list, which is 404-not-403
  (§4.5.3) applied to a URL.
- 🔴 **`mergeChatList([], local)` is not the offline fallback.** It drops every synced chat — correct
  when the server has genuinely spoken (a delete from another device must stick), catastrophic when it
  merely failed to answer. `localChatList` is the fallback. Same distinction as `mount-source.ts`'s
  `remoteHead: null` (branch empty) vs `undefined` (could not ask).
- 🔴 **Sidebar delete takes the ITEM, not an id.** It read the addressing ids back out of IndexedDB,
  which finds nothing for a chat from another device — so the server delete was skipped *silently* and
  the chat returned on the next load.

**Two more, found only by driving the real UI (2026-07-16). Both were reported by the owner, and the
1,109 passing tests saw neither:**

- 🔴 **"Do we need to CREATE a project?" is never "is the chat empty?"** `sendMessage` branched on
  `!chatStarted`, which is seeded from `initialMessages.length > 0`. An empty chat on an EXISTING
  project satisfies that, so the first message ran the new-project path: it mounted a fresh template
  over the user's game and registered a SECOND project named after the prompt. Measured: opening "Kart
  Racer" and typing "add a boost pad to the track" produced a new project called "Add A Boost Pad". It
  is not specific to §4.5.6 — a dashboard Open of a project whose chat lives on another device had it
  too; the new-chat feature just made it the common path. The branch now asks `!activeProjectId`, and
  `chatStarted` reacts to a mounted project so the builder stops showing the marketing intro for a game
  the user is already in.
- 🔴 **`setUrlId` is a React state setter, and FOUR call sites read the value it does not update.** A
  chat is invisible without BOTH a `urlId` and a `description` — that is what the sidebar filters on —
  and upstream sourced both SOLELY from `firstArtifact`. So any conversation the model never wrote a
  file in never appeared: a question answered in prose, a failed generation, a Stop. Reported as "no
  chats at all show in the left sidebar". The stale-closure reads then made it worse in ways that
  cancelled out and looked plausible: `storeMessageHistory` wrote `urlId: undefined` on a new chat's
  first save; the chat-id block navigated to `/chat/1` over the slug; the next save re-minted the slug,
  collided with the record it had just written, and landed on `…-2`; and `ensureServerChatId` rewrote
  the record with `undefined`, wiping the slug at the exact moment the chat was first saved. Fixed with
  `urlIdRef` (a ref updates synchronously; state does not) plus a title/slug fallback to the user's
  first message. **Any new read of `urlId` inside an async callback is this bug again.**

**Deleting a chat NEVER deletes the game, and the card says how many chats there are.** Reported as a
bug ("I deleted KartRacer from side bar and its still in dashboard"), it is the correct behaviour and
the confusion was ours: the dashboard gave no way to tell "I deleted its only conversation" from "this
is an orphan". A chat delete cannot cascade to the project, because for an UNLINKED project the browser
holds the game's ONLY copy (§4.5.4b) — cascading would let deleting a conversation destroy a game that
was never saved. So `GET /api/projects` returns a server-side `chatCount` (`countChats` — one prefix
listing per project, reads no bodies) and a card reads "2 chats" or "No chats yet". `chatCount:
undefined` renders NOTHING: it means we did not count, and saying "No chats yet" because a listing
failed is a lie about someone's data.

Pinned by `message-store.spec.ts` (the collision, the sweep, legacy adoption + migration, the count —
including that a migrated legacy chat is counted ONCE),
`chat-routes.spec.ts` (both walls, the id whitelist, and that the chat cap never refuses to save a chat
the user is IN), `pending-remix.spec.ts` (the stale-slot cases), and `chat-visibility.spec.ts` (the slug
is never empty; four opens leave ONE local chat, not four).

- 🔴 **"Writes nothing" is about the FILESYSTEM, never the screen.** The `transcriptParser` (§4.5.4b) is
  a copy of the live parser with `runAction` removed — correctly, since replaying a stale
  `<boltAction type="file">` over the user's repo is the bug it exists to prevent. But it also dropped
  `showWorkbench.set(true)`, which writes no files and re-runs nothing, so **the project view vanished
  for every restored conversation**: chat and artifact bubbles rendered, file tree / editor / preview
  simply absent, for a project the user was looking straight at. Its test mocked the exact call that
  was missing (`showWorkbench: { set: vi.fn() }`, anonymous and inline), so nothing could assert it.
  Hoisted and pinned on both parsers now, verified to fail without the fix. **When you strip behaviour
  from a copy of a code path, strip only what is unsafe — and assert the rest is still there.**

⚠️ **The lesson, and it is the same one §4.5.4b already recorded.** Every invariant above was tested and
green while the feature was unusable end-to-end: the tests drove the stores and the routes, and every
bug lived in the wiring between them. "Correct by construction" is what the §4.14 MCP relay also was.
**Drive the real UI before claiming a user-facing feature works.**

⚠️ **A spec file must not live in `app/routes/`** — Remix compiles it as a route, so the manifest imports
`vitest` at runtime and *every request 500s*. Route tests live beside the code they exercise.

### 4.6 Credits & Billing

> **Status: IMPLEMENTED (Stage 3, 2026-07) — see `spec/billing.md` for the four divergences from this design.** In short: the charge formula has **four** token classes, not three (cache WRITES bill at **2×** base input, because we use the 1-hour cache tier per §4.2.8 — assuming the 1.25× headline number under-charges every generation and nothing throws); the pre-flight gate is `balance > 0` rather than a p90 cost estimate (a generation's cost is dominated by the tool loop and is not knowable in advance), so a `generation` debit is allowed to drive the balance negative and the *next* gate catches it — exposure bounded by one generation, which is the price of never yanking a game out from under someone mid-build; `balance_after` is derived by an atomic Postgres writer (`append_ledger_entry`) rather than in application code; and `REPAIR_WEIGHT` is not implemented (repair turns settle at full cost; `generations.repairOf` records the data to price them later).

- **Payments: Stripe only.** Stripe Checkout (cards + Apple/Google Pay + Link) is the platform's sole payment processor — for credit packs and premium assets. **No PayPal integration exists anywhere in the platform.** Pro Tools/BYOK is disabled by default and the external license-service validation is retired (§4.6.1); the platform's only subscription signal is the user's live Stripe plan, which drives the §4.18 Unity license tier and nothing else. The ledger keeps provider-agnostic fields (`payment_provider` + `payment_ref`) purely as cheap insurance (e.g., a future Merchant-of-Record move for tax compliance — see open questions); no second integration is planned.
- **Single credit balance:** one bucket, filled by Stripe pack purchases, the signup grant, promos, refunds; never expires. Append-only ledger; balance = latest `balance_after`. Pro Tools subscribers don't receive credit grants — their perk is BYOK (§4.6.1), which bypasses credit charges entirely.
- **Flow:** provider checkout → verified webhook (idempotent on `payment_ref`) → `purchase` ledger row. Failed generations auto-refund.
- **Charge formula:**
  `credits_charged = ceil((in*IN_RATE + cached_in*CACHED_RATE + out*OUT_RATE) / CREDIT_UNIT_COST * MARGIN)`
  Rates per model in config; `MARGIN` targets ≥ 70% gross margin on generation cost. Retail pack pricing is a launch decision; ledger records raw usage so pricing tunes without schema change.
- **The Marketplace price list (BUILT 2026-07-18, `spec/billing.md` §"The Marketplace price list"):** every KIE price — LLM token rates AND the §4.16 per-task media prices — lives in ONE versioned document: a baked fallback in code (`billing/baked-market-prices.ts`, captured from KIE's public pricing feed, which confirmed the measured rates to the cent) overridden by whatever list the admin has PROMOTED from **Settings → Admin → Marketplace prices** (immutable versions + pointer in the ObjectStore, validate-before-write, rollback; the panel can fetch KIE's live feed for comparison, which is never machine-applied). **The env price vars are RETIRED and refused if set** (`KIE_INPUT_DOLLARS`/`KIE_OUTPUT_DOLLARS`/`KIE_CACHED_INPUT`/`KIE_CACHED_WRITES`/`PREMIUM_INPUT_DOLLARS`/`PREMIUM_OUTPUT_DOLLARS`); `KIE_DEFAULT_MODEL` and `PREMIUM_MODEL` survive as selectors, accepted only if the active list prices them. Cache rates are never quoted in the list (they derive 0.1×/2.0× per row; validation refuses the keys). Media rows have NO most-expensive fallback — an unpriced media request is refused, because media debits happen BEFORE spend.
- **Free grant:** small configurable signup grant (`SIGNUP_GRANT_CREDITS`, default **800 credits on KIE at `CREDIT_MARGIN = 4.0`** — sized for **1 creation + real room to iterate**: a cold KIE creation is ~231 credits at margin 4.0 (12,862 out + 111,659 in tokens, `rates.ts`), so 800 ≈ ~3.5× headroom. On Anthropic a cold creation is ~576 credits, so that provider needs ~1,200 — the grant, provider, and margin are ONE decision, guarded by `grantHeadroom()`/`MIN_GRANT_HEADROOM`) gated by email verification + basic device/abuse heuristics; grant size, gating, and even existence are config flags. The credit AMOUNT is the stable fact; "creations' worth" is approximate and moves with model + **cache warmth**.
- **Packs (one-time) + PLANS (monthly) — BOTH BUILT (Stage 5, 2026-07-16; repriced premium 2026-07-18).** Packs: Starter 3,000/$30, Pro 9,500/$90, Studio 25,000/$225 (base $0.01/credit with a shallow volume discount to Studio; premium game-platform positioning, `stripe.ts`). Plans: the same three, per month, auto-granted on every paid invoice. Credits **never expire and never reset** — a monthly plan ACCUMULATES (§4.6: single bucket, no expiry); if you paid for it you keep it.
  - **⚠️ A PACK'S PRICE AND `CREDIT_MARGIN` ARE ONE NUMBER IN TWO FILES.** `ceil(raw / CREDIT_UNIT_COST_USD * CREDIT_MARGIN)` only earns `CREDIT_MARGIN` if a credit RETAILS at `CREDIT_UNIT_COST_USD` ($0.01): **effective margin = CREDIT_MARGIN × (pack $/credit ÷ CREDIT_UNIT_COST_USD)**. The packs shipped at $0.003/credit against a 3.34× setting → **1.01× on the smallest and 0.84× on the largest**, i.e. a ~19% LOSS per generation, worst on the best customers, silently. `packMargin()` + `MIN_PACK_MARGIN` + `billing.spec.ts` now assert it (one test reproduces the shipped 0.835× so the arithmetic is pinned to a fact).
  - **The model does not affect the margin — only the volume.** Credits are charged in proportion to raw cost, so at `CREDIT_MARGIN = 4.0`, 9,500 credits is ~$23.75 of model spend on ANY model. Measured: a $90 Pro subscriber who burns every credit earns **~$63 (73% GM)** on Opus 4.8 *and* on Sonnet 5 — identical. Opus buys many warm creations/month. **Downgrading the model to "save money" earns nothing**; it trades the quality differentiator for volume. (And §4.2's pathology 8: a cheaper tier returns confident WRONG answers whose repair turns cost more than the saving.)
  - **Subscription money path (the shape is where the bugs are):** a renewal has **no checkout session**, so `invoice.paid` is the ONLY grant trigger — and because it also fires for month one, granting on `checkout.session.completed` too would double-credit month one under two different idempotency keys (`session.id` vs `invoice.id`), which the `payment_ref` unique index cannot reconcile. The subscription checkout session is therefore an explicit, tested no-op. The user id rides on `subscription_data.metadata` (a renewal invoice has no session to read). **Cancellation needs no code**: Stripe stops invoicing, we stop granting. Portal/cancel/card/invoices are Stripe-hosted (`api.billing-portal`), resolved via `subscriptions.search` on OUR `userId` — never by email, which breaks the moment a user changes theirs. `subscriptions.spec.ts` drives the real webhook against a stubbed SDK.
- **BYOK (Pro Tools exclusive):** non-Pro users never see key/provider/model controls — only a marketing panel with an upgrade link (§2.3, §4.1). With a server-verified active entitlement, the BYOK panel renders: user-supplied provider key (any supported provider), stored client-side; zero credits charged (a minimal platform fee per generation is a config option, default off). Server re-verifies the entitlement per generation; lapse → controls hidden again + automatic fallback to credits with notice.
- **The turn that promised the work and ended — RESCUE, not refund (2026-07-25, `agent/unproductive.ts`).** A generation that produces *no actions, no tool calls, tiny visible text, and a chars/output-token density far below the code baseline* bought output and delivered nothing (measured: 524 output tokens → 83 characters → 316 credits → `status: 'completed'`). `!producedText` cannot see it, because a promise is text. It now gets **ONE** bounded corrective pass against the already-warm prefix, bounded and mutually exclusive with the tool-cap forced continuation, so no turn ever runs three streams. **Rescue beats refund here:** a refund returns the credits and no spec; a warm second pass costs ~11 credits (`spec/billing.md`) and returns the work the user asked for. The decision is a PURE, exhaustively-tested function like `decidePremium`/`decideAutoRepair` — it spends credits without the user asking — and every signal is mechanical (never a prose classifier, §4.2a). Recorded as `+unproductive-rescue` in `finish_reason`, because the rescue's own `drain` overwrites `finishReason` with a clean `stop` and this failure class is otherwise invisible in every column: it bills a normal amount and completes normally. **If this starts firing often, the cause is upstream of the rescue and the rescue is only paying for it.**
- **Kill-switches & caps:** Anthropic Console spend limits + alerting configured from day one; platform-level daily token budget breaker; per-user rate limits (generations/min, max message length, max concurrent projects).
- **Feature flag:** `BILLING_ENFORCED`. Off = beta mode (grants only, usage fully recorded). On = launch mode. The system is built credit-native from the start; the flag only controls enforcement.

#### 4.6.1 Pro Tools Subscriber Entitlements (BYOK — disabled by default; external ASMX license service RETIRED 2026-07-20)

> **Status: BYOK/Pro is disabled (`PRO_FEATURES_ENABLED=false`) and stays that way. The external ASMX license service (`licenser.asmx`) is RETIRED as of 2026-07-20 — its SOAP client is deleted and no code path performs network subscription validation.** This is a deliberate business decision: the platform is a **credits-based** product (Lovable/Bolt-style, specialized for high-quality Unity-style game development) with no BYOK upsell. The `entitlements` table and `resolveByok` remain in place but **inert** — nothing writes entitlements, `getEntitlement` returns the stored row without revalidating, and BYOK/Pro is a **manual, testing-only** knob from here forward. If Pro gating is ever re-enabled by hand, its authority is the user's **Stripe plan** (via the §4.18 tier resolver), never an external ASMX call.

When BYOK is manually enabled, Pro subscribers get **BYOK unlocked**: bring your own provider API key + model selection; unlimited usage at your own token cost, no credits involved. **That is the ONLY thing Pro would ever gate.** Everyone else — i.e. everyone, by default — uses platform credits with a fixed model and no keys to manage, and every other feature, including **Export and GitHub Sync**, is available to all users without gating.

- **No external subscription-validation authority.** The retired ASMX operation `ValidateSubscription(email) → { active, tier, expiry }` is gone: the SOAP client (`app/lib/.server/licensing/licenser.ts`) is deleted, `refreshEntitlement`/`linkSubscriberEmail` and the `/api/entitlement` route are removed, and the `LICENSE_SERVICE_URL` / `LICENSE_SERVICE_SECRET` env vars are retired (documented as unused in `.env.example`; refused as load-bearing). The only "who is subscribed?" signal the platform now reads is the live Stripe plan, and only §4.18 (Unity Project Licenser) consumes it.
- **`PRO_FEATURES_ENABLED` (config, default `false`):** the master switch for ALL Pro surface area — provider picker, model selector, BYOK key entry. When `false` (the shipping default, Lovable-style), none of it exists in the UI for anyone and every generation uses the `DEFAULT_MODEL` constant (`app/utils/constants.ts`) on platform credits. Setting it `true` is a **manual, testing-only** action; the BYOK UI then renders for local development, and any re-enabled entitlement authority would be the Stripe plan (§4.18), not the retired ASMX service.

> **The bullets below describe the HISTORICAL BYOK entitlement lifecycle. It is INERT today** (see the banner): no revalidation runs, `getEntitlement` returns the stored row as-is, and every "license service" they reference is the retired ASMX service. They are retained only as context for the manual/testing-only re-enable path.

- **Entitlement lifecycle (historical, inert):** on sign-in (and every 24h for active entitlements), the platform validated the user's verified email against the license service → upsert `entitlements` row (`status`, `tier`, `last_validated_at`). Lapse on failed revalidation (grace window: 72h of validation-service unreachability does NOT lapse anyone — our outage must never punish subscribers). This validation path no longer runs.
- **The perk is BYOK, not credits:** an active entitlement unlocks the BYOK setting (§4.6). Platform LLM cost for Pro users: zero (their key pays). Pro users may still buy credit packs and toggle BYOK off if they prefer the managed experience — both paths through the same gate logic.
- **Lapse behavior (historical, inert):** failed revalidation → `status='lapsed'` → BYOK stops being honored server-side; generations fall back to the credit gate with a friendly "your Pro subscription has lapsed" notice. Re-validation restored instantly. No revalidation runs today.
- **Email-mismatch recovery (historical, inert):** the subscription email on file with the license service often ≠ platform email; the manual link flow verified proof (license key / subscription ID / payer email) → stored `subscriber_email`. Removed with the ASMX client.
- **Scope (SUPERSEDED 2026-07-20 by §4.18):** the earlier boundary — "project license-key generation belongs to the Unity Editor Export Tool, not this platform" — no longer holds. The platform now **generates Unity project license files itself** (§4.18 Unity Project Licenser), byte-compatible with the Unity plugin's `licenser.cs` validator, billed as a **flat credit charge per tier** the user selects (replacing the retired PayPal annual Pro Tools subscription). Web projects still do not use or check license keys; the generated `license.json` is for the user's linked Unity project.
- **UX (historical, inert):** entitled users saw a "Pro Tools: BYOK unlocked" badge and the key-setup panel; non-entitled users saw the BYOK setting locked with an upgrade link. Not rendered today (`PRO_FEATURES_ENABLED=false`).

#### 4.6.1a Premium Model Tier (credits mode) — BUILT 2026-07-17

> **Status: IMPLEMENTED.** A second, higher-cost model a **credits** user may opt into per-generation — distinct from BYOK. This is the ONE user-facing model choice in credits mode, and it deliberately does not reopen the "model is a user input" concern: it is a **boolean toggle between exactly two operator-configured, operator-priced models** (the platform default and one premium model), never a free-form model string or a provider picker. The client sends `premium: boolean`; the server maps it to the single configured premium model and bills that model's rates. Works on **both providers** (KIE and Anthropic).

- **Config (`billing/rates.ts` `getPremiumTier`, `.env.example`) — price side moved to the Marketplace price list 2026-07-18:** `PREMIUM_MODEL` (default `claude-fable-5`) is a SELECTOR, accepted only if the ACTIVE price list prices it; `PREMIUM_INPUT_DOLLARS`/`PREMIUM_OUTPUT_DOLLARS` are **retired and refused if set** (the tier prices from the list row; the baked list carries fable-5 at the measured $4/$20, so the tier works with no env and no promotion; cache re-derives 0.1x read / 2.0x write). `PREMIUM_MINIMUM_CREDITS` stays env (default `1000`; `envNumber` — a threshold, not a price). The premium row is injected into **every** provider's rate table by `providerRates` — non-throwing, so a promoted list that unprices the premium model refuses NEW premium requests loudly without taking settlement down — which is what makes `claude-fable-5` (no `MODEL_RATES` row) billable on Anthropic.
- **The minimum-credits gate PROTECTS the free grant.** The signup grant (800) sits below the default minimum (1200), so a brand-new account **cannot** burn its grant on a 2x model out the gate — it must buy a credit pack or subscribe (crossing the threshold) first. There is deliberately **no separate subscription check**: holding the credits IS the proof of intent, and gating on a subscription would wrongly punish a credit-pack buyer who never subscribed. **The threshold binds regardless of `BILLING_ENFORCED` (2026-07-18):** the old "enforcement off → premium freely usable, nobody is charged" bypass rested on a false premise — settlement debits the ledger either way (enforcement only lets the gate refuse at zero), so an under-threshold user could switch on the 2x model and ride the balance negative with nothing objecting (observed live at 320 credits). The balance is always being debited, so the balance is always the eligibility fact; a deploy that wants free premium states it explicitly with `PREMIUM_MINIMUM_CREDITS=0`. **A CREATION turn never runs premium (2026-07-18, observed live):** KIE serves Fable 5 with a BUFFERED answer (accepted in the provider decision for edit-sized replies), and a creation-sized artifact (~25k output tokens, 4–7 min of decode) cannot flush before KIE's gateway timeout — measured: step 2 ran 307.8s streaming 17,635 chars of reasoning and died at `finish=error` with the artifact never arriving, 449s total. `decidePremium` takes `isCreationTurn` and returns `reason: 'creation_turn'`; creations run the standard streaming model, the premium preference applies from the first edit turn. Silent by design (no notice — the creation is not degraded, Opus 4.8 is the model the whole product was built and measured on).
- **The decision is a PURE function (`billing/premium.ts` `decidePremium`), exhaustively tested** — same category as the auto-repair loop and restore-target selection: it spends credits at 2x without a second confirmation, so it is never inlined into the proxy. The server re-derives eligibility on **every** generation from the balance the credit gate already read; a tampered client store only ever reveals a toggle the server declines (with a soft "premium needs N credits — used the standard model" notice, never a block).
- **UI (`components/chat/PremiumToggle.tsx`):** a credits-mode composer toggle (NOT behind `byokUnlocked`) with three states — eligible+off (opt-in), eligible+on (an accented "Premium · ~2×" pill, the persistent burn-rate warning), and locked (dimmed + lock + the threshold, below the minimum). The preference persists client-side (`premiumModelStore`); `/api/me` surfaces `credits.premium` (model, minimum, availability) as a rendering hint only.

### 4.7 Guided Tour Wizard ("Prompt Magic")

Non-developer front door at `/new/tour`, reached ONLY per §4.4a Path C (explicit "guided tour" click, or an offer when a prompt is too vague to act on). It never interrupts a user who typed a specific prompt. Four steps → compiled structured first message (hidden behind a friendly summary):

1. **Game type** — one card per active `game_registry` entry (GameMode preset + optional base scene).
2. **Vibe** — art/lighting presets (Sunset Arcade, Neon Night, Low-Poly Daylight, Moody Fog…) mapping to known skybox/lighting/post-process configs from the training examples.
3. **Mechanics** — genre-appropriate checkboxes, each mapping to a prompt fragment referencing a known Toolkit pattern (e.g., for a racing genre: lap counter, boost pads, drift via the built-in RacingSystem; for a platformer: double-jump, collectibles, moving platforms — defined per genre in wizard config), plus cross-genre toggles the Toolkit makes one-fragment cheap: **mobile touch controls** (MobileInputController — makes the shared game phone-playable) and **split-screen local multiplayer** (DefaultCameraSystem, 1–4 views).
4. **Your twist** — one optional free-text sentence.

Wizard creates the project from the template and drops the user into the builder with generation already streaming. Target: first playable change **< 90 seconds** from wizard completion. Wizard config (genres, vibes, mechanics, fragments) is versioned JSON data, not code.

### 4.8 Share, Gallery, Remix & Export

> **Status: IMPLEMENTED (Stage 4, 2026-07).** Server: publishing checklist (`share/checklist.ts` — a secret is a BLOCKING refusal, a debug overlay a warning the user may accept, a network game auto-launched `?solo=true`); byte-faithful build upload with a path-traversal wall (`share/publish.ts`); `/play/:shareId` served origin-isolated (`play.$.tsx` → an iframe pointed at `PLAY_URL`; local dev is explicitly NOT the security boundary); gallery returns admin-APPROVED only (`share/gallery.ts` — an allow-list projection, never the owner/project id); remix (`share/remix.ts` — `deriveRemix` names exactly what travels: files yes, ownership/link/share id no); anonymous report → admin queue (`share/reports.ts`). Client: a **Share** button + dialog (`components/share/` — builds in the WebContainer, renders the checklist's blocking/warning outcomes, shows the live link), the **`/gallery`** page, and the **`/remix/:shareId`** flow (clones then opens in the builder via the server-checkpoint resume path). Export ZIP already existed (binary-faithful, `workbench.downloadZip`). A minimal brand module (`app/config/brand.ts`) keeps the play badge from being a hardcoded mark. **Self-remix/Duplicate UI: BUILT (2026-07-15)** — a header `DuplicateButton` POSTs `{projectId}` to `/api/remix` and opens the clone via the resume path.

- **Share:** enforce the Toolkit **Publishing Checklist** first (agent-directed pre-share pass + build-time lint: `enableDebugKeys=false` on DebugInformation, debug overlays off, network-capable games forced `?solo=true` at launch — open question #17) → run `npm run build` in the WebContainer → upload `dist/` to the S3 play bucket (CloudFront-served) → mint `share_id`. `/play/[shareId]` serves the static build full-screen with a "Made with Babylon Toolkit — Remix this game" badge.
- **Remix:** clones the source snapshot into the visitor's account (sign-up gate) → opens in builder. Primary growth loop. **Self-remix / Duplicate:** any owner can remix their OWN projects (no share required) to spin variations — "Duplicate project" is the same snapshot-clone path within one account.
- **Gallery:** curated grid of shared games at `/gallery`; submission flag on share; admin curation. Playing is free to us (static hosting) — the zero-cost "take a peek" funnel.
- **Export (ALL users, never gated):** ZIP download of a proper Toolkit project (official Project Installation layout + README). Alongside **GitHub Sync (§4.13, also ungated)**, this keeps the users-own-their-games promise (§5A) true for everyone — no project is ever locked to the platform.

### 4.9 Assets Tab & GLTF Store

> **Status: IMPLEMENTED (Stage 4, 2026-07).** Server: asset introspection — the "agent knows what it just got" — `assets/introspect.ts` scans a glTF's `CVTOOLS_unity_metadata`/`extras` into a component reference injected into agent context, `assets/glb.ts` unwraps the GLB JSON chunk (doubling as structural validation), `assets/validate.ts` gates uploads (type allow-list, size caps, per-user quota, content sniff). `user_assets` store + upload route (introspects models at upload time) + static catalog (`app/config/assets.json`). Client: an **Assets** settings tab (catalog grid + upload/list/delete; "components read" badge when introspection succeeded). **Both carry-overs BUILT (2026-07-15):** premium-asset Stripe gating at add-time (pure gate `assets/premium.ts` + `asset_entitlements` store, migration `0005` + one-time asset checkout + gated add route; free adds directly, premium requires ownership, degrades to "payments not configured" when Stripe is off) and client-side GLB unwrap for store-asset introspection (`assets/store-introspect.ts` fetches + unwraps glb/gltf/gz in the browser and feeds the component reference into `assetNotes`).
>
> **How assets reach a NEW project is already solved — by the game_registry (§4.4), not by the agent.** A prompt keyword-matches a registry row, which names the `source_class` to copy and the `scene_url` to preload ("racing" → `VehicleControllerDemo.ts` + `openterrain.gz.gltf`). **The agent never picks, so it can never hallucinate an asset** — selection is deterministic config. That is the pattern any published library should extend: rows, matched by keyword, not a model choosing from a catalogue it half-remembers.
>
> ⚠️ **The narrow gap that remains (2026-07-16, NOT yet built; asset library not published).** Two things the registry does not cover:
> 1. **Variety within a genre.** Each row carries ONE `scene_url`, so every racing project gets the same terrain. A published Synty library means many worlds per genre — either more rows, or a row that names a SET the wizard/user picks from.
> 2. **Mid-session asset use.** "add some trees", "use a desert track" — here the catalog IS invisible to the agent (`assetNotes` only appear *after* a user manually Adds an item in the Assets tab). This is the real seam, and it is a smaller problem than a creation-time asset picker.
>
> Both wait on the real library, because its SHAPE decides the design: a baked index is affordable for ~100 items (~3k prefix tokens, cached) and unaffordable for thousands, where a `search_assets` tool is the only option — at the cost of a tool round, the §4.2 redrafting pathology we disable tools to avoid. **Whichever shape wins, keep the registry's property: the agent must never invent an asset id or URL** (§4.4c's "only import what provably exists", with a broken mount as the failure).

- Builder tab listing official/premium Toolkit content in three forms: **hosted scenes/environments referenced by URL** (one click passes the URL as `sceneUrl` or to the GameMode — instant; premium = gated URLs), **INTERACTIVE PREFABS** — GLTF/GLB carrying `CVTOOLS_unity_metadata` component descriptors authored with the Unity Exporter (a car prefab ships with its StandardCarController and tuned properties: instantly drivable on instantiation via `InstantiatePrefabFromContainer`) — and **file asset packs** downloaded into `public/assets/`.
- **Asset introspection ("the agent knows what it just got"):** when a scene or prefab is added/referenced, the platform scans its glTF `extras` metadata and generates a **component reference** (per the workflow defined in `scene-components.md`) — a breakdown of every attached component, class, and property — injected into the agent's project context as a system note. The agent writes game logic against the asset's actual components instead of guessing.
- **Content pipeline note:** interactive prefabs/scenes are authored in the Unity Editor with the Babylon Toolkit Exporter (the Pro Tools product) — the store's content pipeline IS the Pro toolchain, and (future) third-party creators could publish Exporter-made prefabs to the store (creator-marketplace expansion intent, §1.4).
- Free packs seeded at launch; **premium packs purchasable** (Stripe, one-time) — the second revenue line and the merchandising surface for the premium GLTF content-creation tools.
- **User asset uploads (Phase 3):** users can upload their own GLTF/GLB models, textures, and audio into a per-project (later per-account) asset library — validated server-side (type allow-list, size caps, glTF structural validation) and stored in S3 under a per-user quota (config; larger quota for Pro tiers). "Add to project" and agent wiring work identically to store assets. This is table stakes: real game builders have their own models.
- Contextual surfacing: when the agent detects a needed asset type ("add a police car"), it may suggest matching packs (system-prompt directive + assets manifest in context). Suggestions must be genuinely relevant; never spammy.
- Asset licensing terms for use in user games: legal text required before premium launch (open question).

### 4.10 Admin

> **Status: IMPLEMENTED (Stage 4, 2026-07).** Server: `admin/usage-report.ts` turns the diagnostics columns (migration 0002) into numbers that DIAGNOSE spend — cache hit rate, failure rate, wasted-output tokens (step output the user never saw), per-model cost — not merely chart it. Routes: `/api/admin/usage`, `/api/admin/gallery` (approve/reject — nothing public without this), `/api/admin/reports` (the abuse queue), `/api/admin/credits` (manual grant/refund through the append-only ledger). Client: an **Admin** settings tab rendering the usage stats + gallery-curation + reports-queue actions; a non-admin sees the routes' 403 as "admins only". Prompt/skills refresh + rollback already existed (`api.admin.prompt.ts`). Remaining: a credit-adjustment UI over `/api/admin/credits` (the route exists; no form yet).

- Authenticated admin routes: prompt refresh + version list/rollback; **skills list/versions/activate/rollback + per-skill load counts (§4.11)**; usage & cost dashboards (tokens, cache hit rate, credits sold vs. cost, per-model); feature flags (`BILLING_ENFORCED`, grant size, model routing); gallery curation; user/credit adjustments (granting, refunds).

### 4.11 Skills Subsystem (Claude Code-style skill support in the platform chat)

The point of this subsystem: **the skills in `github.com/babylontoolkit/skills` (bt-spec, bt-plan, bt-design, …) work in the platform's chat exactly like they work in Claude Code.** A user types `/bt-spec create user authentication system with login and signup pages` and the agent loads that skill and executes its workflow against the current project. Skills are agentskills.io bundles (SKILL.md + optional references/); the same bundles serve Claude Code, Cursor, and this platform unchanged.

> **🔴 EVERY `/slash` INVOCATION THE PRODUCT EVER SERVED WAS SILENTLY DROPPED — fixed 2026-07-25 (`chat/message-envelope.ts`).** `Chat.client.tsx` wraps every user message in `[Model: …]\n\n[Provider: …]\n\n` (upstream's BYOK transport, stripped only by `stream-text.ts` on the fail-closed `/api/chat` path). `parseSlashInvocation` anchors on a leading `/`, so it never matched, and `resolveSlashInvocation` returned null **one branch above its own unknown-skill warning** — no error, no log, nothing in `skillsLoaded`. What the user saw: the model announcing *"I'll load the bt-spec skill workflow"* and stopping, because a preloaded turn closes the tool loop (§4.2.8) so there was no `load_skill` to call and no skill body in context. Measured (`gen_ms0vcgq8_68vf4c`, during an investor demo): **316 credits, `finishReason: 'stop'`, `status: 'completed'`, 83 characters of text, zero work.** The envelope is now stripped at the proxy entry — in `content` AND `parts`, since the SDK prefers `parts` — and slash parses the user's TYPED text, carrying any leading modified-files `<boltArtifact>` through the rewrite rather than discarding the user's own edits. **Never regress:** the tests build their input the way the CLIENT builds it (`message-envelope.spec.ts`, `slash-invocation.spec.ts`) — a test that hand-feeds a bare `/bt-spec …` passes against the broken code, which is exactly why this survived a green suite. Mutation-verified: reverting the fix fails 6 tests. ⚠️ **The client still sends the envelope**; stripping it server-side is the additive fix (§2.1a). Removing it from those six upstream call sites is a separate change that must not break the enhancer or the dead path.

**Two invocation paths (both standard):**
1. **Explicit — slash commands (the primary UX, Phase 1–2):** typing `/` in chat opens an autocomplete of synced skills (name + description); `/skill-name <args>` injects that skill's body into the generation with the args as the task. This is the headline feature of the subsystem.
2. **Automatic — description-triggered:** the skills index (name + description per skill) lives in the cached system prompt; the model may call `load_skill(name)` mid-generation when a request matches a skill's description — same progressive-disclosure behavior Claude Code applies. `read_skill_resource(skill, path)` serves bundled reference files.

**Sync (extends doc-sync, §4.3):** fetch the skills repo → validate frontmatter (name matches folder, description present) → store `skills` + `skill_versions` rows, resources to S3 under `storage_prefix` with a manifest → rebuild the prompt's skills index. Same triggers (admin endpoint; GitHub webhook Phase 3), same failure guarantee (broken push never takes down generation; prior versions stay active), same per-skill rollback. All repo skills sync and are invocable by default; an optional repo-side manifest can scope which appear if that's ever wanted.

**Runtime:** the tool loop runs server-side in the agent proxy (§4.2) — tool calls invisible to the client stream. `read_skill_resource` resolves strictly via the version's resources manifest (no path semantics). Loop cap per generation (config). Loaded bodies are separate cached blocks; repeat loads within cache TTL are cheap.

**Division of labor with doc-sync (§4.3):** the Component Reference on-demand blocks carry raw Toolkit system depth (RacingSystem, navmesh, physics docs); skills are workflows and patterns that USE that knowledge. Skills reference the docs rather than duplicating them. Domain/pattern skills (e.g., the wizard-backing ideas in SKILLS_BACKLOG.md) are optional future content authored in the skills repo whenever they earn their place — never a platform gate.

**Metrics:** `generations.skills_loaded` records fires (slash + auto); admin shows per-skill usage. A skill that never auto-fires usually has a weak `description` — fix in the repo, resync.

**Trust model:** platform skills (our repo) are trusted prompt content. Community/user-installed skills remain OUT OF SCOPE until a review/moderation model exists (marketplace expansion intent, §1.4).

### 4.12 Generation Controls & Project History (Bolt/Lovable parity)

> **Status: server side IMPLEMENTED (Stage 3, 2026-07).** Stop aborts the provider call through an `AbortSignal` threaded from the request. Billing on a stopped generation charges tokens actually consumed to the abort point — never the full estimate. A **Stop is not a failure**: a hard failure (provider error, broken stream) auto-refunds, a stop does not, because the tokens it burned were burned by the user's own decision.
>
> **⚠️ This used to add "checkpoints are the `snapshots` table + object storage, addressed through their project (`/api/projects/:id/snapshots/:snapshotId`)". All of that is gone (§4.5.4b; deleted 2026-07-16).** Checkpoints are LOCAL (IndexedDB, `local-snapshots.ts`) — the table, both stores, and that route no longer exist. Nothing about Stop or its billing changed; only where the bytes live.
>
> **Client affordances: COMPLETE (2026-07-14).** All three now exist. (a) **Both directions are offered** — "undo this change" restores the state from BEFORE it (the previous checkpoint), and "restore to after" restores the state it produced. Checkpoints are taken *after* a generation is applied, so the checkpoint anchored to a message is the state that message **produced** — which makes "before this change" the PREVIOUS checkpoint, not this one. That off-by-one is the single most dangerous bug this feature can have (it would silently overwrite the project with the wrong bytes, turning the undo button into the mistake), so the selection is a pure, exhaustively tested function: `app/lib/persistence/restore-target.ts`. (b) The restore **appends a note to the chat** — as an *assistant* message, so it does not trigger a generation, and because without it the model's history claims it wrote code that no longer exists on disk and its next edit would reason about a file that is gone. (c) The restore **is itself checkpointed** (the state being left is captured *before* `restoreFiles` overwrites it — afterwards those bytes are gone), so history stays append-only and the undo can always be undone. Nothing is ever destroyed: the checkpoints after the restore point survive.

Users of Bolt/Lovable expect to control and undo the AI. Without these, one bad generation strands a non-developer.

- **Stop:** a Stop button aborts the in-flight stream. Actions already applied stay applied (next point covers recovery). Billing: charged for tokens actually consumed to the abort point (the ledger row reflects real usage; never the full estimate).
- **Checkpoints & restore:** upstream bolt.diy ALREADY ships snapshot restoration and revert-to-earlier-versions — adapt that machinery rather than building new. **⚠️ This used to read "our server-side snapshots (§4.5.5)"; §4.5.4b made that false.** Checkpoints are LOCAL (IndexedDB, `local-snapshots.ts`) — in-session restore stays fast and needs no network, and for a LINKED project the durable history is the commits in the user's own repo. The affordances below are unchanged; only where the bytes live moved. Surface as a **version history**: each assistant message carries a "Restore to before/after this change" affordance → remount WebContainer from that snapshot, append a system note to chat ("restored to checkpoint N"), and snapshot the restore itself (history is never destroyed, only appended). This is the single most important safety net for non-developers — **Phase 2**, not a nice-to-have.
- **Retry / refine:** "Try again" on a failed or disliked generation re-runs from the pre-generation checkpoint (normal credit charge; auto-refund already covers hard failures per §4.6).
- **Attachments in chat:** upstream ALREADY supports image attachments — keep, rerouted through the server agent proxy so vision tokens are billed through the normal formula; add server-side size/type validation and small text/code file support. Phase 3 hardening, not a new build. (User 3D asset uploads are §4.9, not chat attachments.)
- **Concurrency guard:** one in-flight generation per project; queued or rejected with a friendly message, never interleaved (interleaved file actions would corrupt the working tree).

---

### 4.13 GitHub Sync (two-way project ↔ repo bridge) — **AVAILABLE TO ALL USERS**

> **Role upgrade DONE (§4.5.4b, 2026-07-16): this is no longer a bridge, it is the storage backbone.** "Save" = link+push, reload = fetch+mount, GitLab joins via the `GitProvider` seam. Everything below (fast-forward-only, two-button divergence, `.env` exclusion, byte-faithful trees, checkpoint-before-pull) is now load-bearing for SAVING, not just syncing — a defect here loses the user's only copy, where before it merely failed to sync one.
>
> **What changed in this section's own machinery:**
> - **The client no longer holds or sends a token.** It used to read a raw PAT out of `githubConnectionStore` (localStorage) and put it in the request body of every op. The server resolves the token itself from an encrypted per-user store (`git_tokens`, service-role only); the browser never sees it, and `no-client-token.spec.ts` pins that the route cannot accept one again — behaviourally AND at source level.
> - **Push takes its files from the request body,** because the platform has no copy to read. The old flow snapshotted server-side first, which only worked while we kept every project.
> - **The checkpoint before a pull happens client-side** for the same reason: the only party holding the files is the one about to overwrite them.
> - **`.env` exclusion got sharper for a reason worth keeping.** The rule was `/\.env\.[^/]*local$/` — mirroring the gitignore convention — so it **pushed `.env.production`**, the most dangerous file in the family, because it does not end in `local`. Nothing failed; the secrets just went to a repo. Under §4.5.4b every save is a push, so the blast radius went from "if you clicked Sync" to "always". One rule (`isSecretPath`), one place, reused by the remix seed.

> **Status: IMPLEMENTED (Stage 4, 2026-07).** Server: link/push/pull/divergence via the GitHub Git Data API (`github/sync.ts`, Octokit — no git binary, WebContainers never run git). The dangerous decisions are a pure, tested core (`github/sync-logic.ts`): fast-forward-only (a moved remote → the two-button divergence choice, never a merge), `.env`-family excluded from every push, byte-faithful tree building. Pull ALWAYS checkpoints the platform state first (§4.12). Client: the dialog in `components/github/GitHubSyncButton.tsx` covering link, push (snapshots current files first), pull (mounts the result), and the two-button divergence resolution — since 2026-07-22 opened from the header's single `GitStatusChip` rather than its own button (§4.1a: it was one of two adjacent controls both labelled "Sync"). Ungated — no entitlement check anywhere; the user's token comes from the inherited connector. Remaining: hardening that per-user token from the connector cookie to a server-side OAuth App.

**Never gated.** GitHub Sync and Export are both available to every user, always. A person's project is never held hostage to this platform — they can leave with their code at any time, by ZIP or by repo. (Pro's only additions are BYOK + model selection, §4.6.1.)

The graduate path for developers: create/vibe-code on the platform → real engineering in local git → sync back. Deliberately a **sync bridge, not a git client** — the platform tracks exactly ONE linked repo+branch per project; branching, rebasing, merging, and PRs happen in the user's own git tooling. (bolt.diy's GitHub connection + import/push machinery is the inherited base; this section defines the product behavior on top.)

**Linking:**
- A project may link to one GitHub repo + branch: created by our initial push (auto-create repo in the user's account) or by importing an existing repo (which also serves as advanced project creation for Toolkit-shaped repos).
- Project fields: `linked_repo`, `linked_branch`, `last_synced_commit_sha`, `github_installation_ref`.
- Auth via GitHub OAuth/App with minimal scopes (repo content read/write only); tokens server-side per user, never in the client.

**Push (platform → GitHub):**
- Server-side via the GitHub Git Data API (trees/commits/refs) built from the current snapshot's file manifest — no git binary anywhere; WebContainers never run git.
- Manual "Commit changes" only (the header git chip). **No auto-push** — see §4.5.4b's LINKED lifecycle; the `auto_push` column survives unread.
- Commit messages default to the generation summary ("AI: add boost pads to RaceMode"), giving a readable history of AI changes.
- Fast-forward only: if the remote branch head ≠ `last_synced_commit_sha`, push is refused → divergence flow (below).

**Pull (GitHub → platform):**
- "Sync from GitHub" fetches the linked branch head. ALWAYS checkpoints current platform state first (§4.12 restore covers any regret), then overlays the repo tree → new snapshot → WebContainer remount → `npm install` if lockfile changed → **asset introspection re-runs (§4.9) and a system note summarizes externally-changed files** so the agent's context reflects the user's local edits.
- Protected paths (vite.config dedupe/optimizeDeps, §4.2 constraints) are linted after pull; violations produce a warning banner, not a block — it's the user's repo.

**Divergence (kept brutally simple — the platform NEVER merges):**
- Remote moved AND platform has unsynced changes → two buttons: **"Pull (overwrite platform — checkpoint saved)"** or **"Push platform state to a new branch"** (`platform/<date>` — user merges locally at leisure). No in-platform conflict UI, ever.

**Interactions with other systems:**
- Remix of a linked project clones the snapshot only — the link does NOT travel (no write access to someone else's repo).
- Export ZIP remains for non-GitHub users; "Push to GitHub" supersedes it for linked projects.
- BYOK/credits unaffected: sync operations are free (no LLM involved); only generations bill.
- Rate-limited per user; repo size cap (config) to keep Git Data API tree builds sane.

**Phasing:** Phase 4 (with export). Prereq: GitHub OAuth app + webhook infrastructure already exists for doc-sync by Phase 3.

---

### 4.14 MCP — Project-Scoped via `.mcp.json` (Claude Code-compatible)

> **Status: IMPLEMENTED incl. the LIVE RELAY (Stage 5, 2026-07-15).** 🔴 First: upstream shipped an **unauthenticated RCE** — `MCPService` spawns a child process per stdio server, driven by an unauthenticated `POST /api/mcp-update-config`. Closed fail-closed (`mcp/server-guard.ts`, 404 unless `SERVER_SIDE_MCP_ENABLED`); execution belongs in the user's WebContainer, never platform infra (§5). Built: `.mcp.json` parsing with the **command allow-rule** (a command must resolve inside the project tree — `mcp/project-config.ts`, client-safe); the **WebContainer launcher** (`mcp/webcontainer-bridge.ts` — spawns each allowed stdio server INSIDE the user's sandbox and speaks MCP JSON-RPC over its stdio: `initialize`→`tools/list`→`tools/call`); its lifecycle store (`stores/mcpBridge.ts` — launch on mount, relaunch on `.mcp.json` change, expose `mcpToolsAtom` + `callMcpTool`); and the agent-context note, which reflects the tools that actually STARTED (forwarded in the agent body).
>
> **The live relay is now BUILT, and it preserves single-generation billing.** The idiomatic AI SDK client-tool path (`addToolResult`) re-POSTs the whole conversation after every tool result — a NEW request, gate, `generationId`, and settlement per tool round — which would fragment the §4.2/§4.2.8 accounting. Instead we keep ONE `streamText` call alive: an MCP tool's `execute` (`agent/mcp-tools.ts`) EMITS the call to the client and AWAITS a result posted to `/api/agent/tool-result`, delivered through an in-process, **ownership-checked** registry (`agent/mcp-relay.ts` — a result POST is honoured only if its caller owns the generation, so no one can inject a tool result into another user's generation; timeout / abort / generation-end all settle so no promise leaks). The client half (`Chat.client.tsx`) runs each `mcp-tool-call` data part via `callMcpTool` in the WebContainer (never platform infra, §5) and posts the result back; results are untrusted input. When a project has no MCP tools the proxy path is byte-identical to before.
>
> **VERIFIED, and it was not clean (2026-07-16).** The relay's whole design rests on a TIMING claim — that the `mcp-tool-call` data part reaches the client *while* `execute` is still blocked — and a false one deadlocks every MCP generation for the full 60s timeout, silently, on the user's bill. It is now pinned by `agent/mcp-live-relay.spec.ts`, which drives the real `ai@4` `streamText` + `createDataStream` with only the MODEL mocked and asserts on the wire bytes: the call flushes over the still-open response, the loop parks, delivery resumes it, a second step happens. The claim held; three defects underneath it did not, all now fixed and tested. (1) **`inputSchema` never reached the model** — the client forwarded name/description/server only, so the model called every MCP tool with invented arguments; it now travels, capped server-side (a third-party server must not buy unbounded context, §4.2.8). (2) **Tool-key collisions silently overwrote tools** — the AI SDK tool set is a Record, so of two servers exposing `read_file` the model was told only one existed; keys are now server-qualified. (3) **`callTool` matched on tool name alone**, running a colliding call against whichever server launched first — the event now carries `server` end-to-end and the bridge routes on `(name, server)`. **Tool names are unique per server, never across servers.** `mcp/webcontainer-bridge.spec.ts` covers the stdio transport (framing, `initialize`→`tools/list`→`tools/call`, per-server routing, a failed server not taking down the others, the allow-rule) against fake JSON-RPC servers.

MCP configuration is a **project file, not a platform setting**. Projects carry a Claude Code-compatible `.mcp.json` at the root; the AppTemplate template ships the default setup (e.g., `@babylonjs-toolkit/kie`, kie image/video/google generators) with servers installed as project npm dependencies (`command: node_modules/.bin/...`). No platform-side MCP registry or connector UI is required at launch — editing `.mcp.json` IS the configuration surface, and MCP tooling travels with the project through snapshots, remixes, and GitHub sync automatically.

**Execution model — servers run in the user's WebContainer:**
- On project mount (and on `.mcp.json` change), the platform parses the file and launches the declared stdio servers **inside the user's WebContainer** — their sandbox, their compute, their env/API keys. The platform never executes MCP servers on its own infrastructure.
- **Tool bridge:** the server agent proxy performs MCP tool discovery and tool calls by relaying over the live session channel: model emits tool call (server) → relayed to client → executed against the WebContainer-hosted stdio server → result relayed back → generation continues in the same tool loop as `load_skill` (§4.2). BYOK-path generations may shortcut client-side where upstream already supports it.
- Command allow-rule: `command` must resolve inside the project tree (`node_modules/.bin/*` or project scripts) — no absolute/system paths, even though the WebContainer is inherently isolated.

**Secrets:** servers like the kie generators need user-supplied API keys → project `.env` (gitignored by the template). The GitHub-sync push path and Share pre-flight run a secret scan; `.env` never leaves the project sandbox/snapshot.

**Safety posture:** MCP tool descriptions/results are third-party content — treated as untrusted input in the agent loop (no instruction-following from tool output; file/shell action allow-lists still apply). Remixed/imported projects carry their `.mcp.json`; since execution is confined to the user's own WebContainer and the command allow-rule applies, the blast radius is the user's own sandbox — same trust model as the project's npm dependencies themselves.

**Why this rocks for the product:** the template's default kit means users can generate textures, images, and video assets *in-chat* from day one ("make me a neon billboard texture") — asset creation becomes part of the vibe-coding loop, powered by tooling the Toolkit ecosystem controls.

**Billing:** MCP tool traffic bills through normal generation token accounting; the MCP servers' own API costs (e.g., kie keys) are the user's, on their keys.

### 4.15 Game Backends (user-owned Supabase)

> **Status: IMPLEMENTED (Stage 4, 2026-07).** The agent is told a backend is connected via an RLS-first system note (`agent/project-notes.ts`), and the **hard separation** is enforced by `game-backend/separation.ts`: a claim whose project ref resolves to the PLATFORM Supabase is treated as "no backend", so game code (which ships the anon key) can never be scaffolded against our database. The chat now forwards the connection as `gameBackend` in the agent body (the proxy was dropping it), and the connector UI is relabelled "Game Backend" (settings tab + in-chat heading). Remaining: the `leaderboards` skill (skills-repo content, not platform code), and surfacing an explicit RLS-confirmed toggle.

Real games need leaderboards, saves, and profiles. Users connect their **own** Supabase project ("Game Backend" in UI) via the inherited connector:

- **Hard separation:** the user's game Supabase is theirs — their account, their keys, their data. It is never our platform Supabase (accounts/credits/projects), and user game code can never reach platform infrastructure. UI naming ("Game Backend") and docs enforce the distinction.
- **Agent support:** with a backend connected, the agent can scaffold the classic patterns — leaderboard read/write, save slots, player profiles — as Script Components + GameMode wiring, using the anon key + RLS pattern (standard Supabase client-side model). A `leaderboards` skill in the skills repo is the natural home for the canonical pattern (skills repo to-do, not platform code).
- **Shared builds:** a shared game with a backend ships the user's anon key in client code — normal for Supabase, safe ONLY with RLS; the agent always generates RLS-first schema instructions and the Share pre-flight warns if a backend is connected without confirmed RLS.
- **Wizard:** an "Online leaderboard" mechanic toggle becomes available for projects with a connected backend (config-driven, per §4.7).

### 4.16 Built-in Image & Video Generation (KIE media) — BUILT 2026-07-18

> **Status: BUILT** — both halves in one day: the §4.6 Marketplace price list (the pricing foundation, admin-controlled) and the generation surface. Owner directive (2026-07-18): platform-native media generation like Lovable/seels.ai — no external MCP connector — riding the same `KIE_API_KEY` the LLM provider uses, billed as **additional credits** at the same `CREDIT_MARGIN`. Pinned by `media.spec.ts` (33 money-path tests) + the migration-0009 pins in `ledger-sql.spec.ts`. **✅ VERIFIED LIVE against real KIE media, same day (2026-07-18):** all three wire branches ran end-to-end from the server — nano-banana-2 image (jobs endpoint, 14 credits, succeeded in ~23s, a real 2.27MB PNG streamed through the file proxy), kling-3.0/video std 5s (jobs video shape, 117 credits, 5.67MB MP4) and veo3_lite 720p (the flat veo endpoint, 51 credits, 5.37MB MP4) — with the ledger showing three exact `media` debits chaining 502→488→371→320, the retired-env refusal firing correctly on a stale dev-server env (and reading exactly as designed), the Media panel quoting live (the 8K refusal listed the priced variants verbatim), and the client half delivering the real bytes into the WebContainer file tree (`FilesStore: File created … scifi-floor-mrqef6.png`, 2,265,630 bytes) via the panel's Re-save. Unlike the §4.14 relay, the live pass found no defects. NOT yet exercised live: the agent-tool path end-to-end in a chat turn (the tool's `execute` is the same `startMediaTask` the routes drove), and a real render FAILURE (the refund path is spec-pinned, incl. the poll race).

- **The agent's tools** (`agent/media-tools.ts`): `generate_image`, `generate_video`, `generate_google_video` — same names/defaults as the MCP reference (`nano-banana-2`, `kling-3.0/video`, `veo3_fast`). **Async-enqueue:** `execute` debits + creates the KIE task + emits a `media-task` data part + returns the destination path IMMEDIATELY — the tool loop never parks on a multi-minute render (§4.2.8: each parked round would re-send the ~110k-token prefix). The model is told the path and writes code against it; the bytes arrive in the background. All params optional-in-schema, validated in `execute` (the `tools.ts` rule). **Reachable on EVERY turn (2026-07-21).** The original design offered them only where the tool loop was already on ("media tools do NOT force the loop; the Media panel covers loop-off turns") — that rule is **retired**, because the skill router fires on `design`/`landing`/`art`/`theme`, so the prompts that ask for art were exactly the prompts that pre-loaded a skill, closed the loop, and left the model with no tools; it then said so in plain language and drew the art in CSS. An ordinary turn that nothing else opened now gets a **bounded media-only loop** (`MEDIA_TURN_STEPS = 3`, skill tools not offered), so the §4.2.8 skill-thrash pathology stays dead while chat-driven generation works on every turn. The Media panel remains the direct, loop-free path. **The CREATION turn (2026-07-18)** is still its own case: The creation brief now tells the model it may generate bespoke design art (hero/splash/chrome imagery, at most one short hero video) for the initial frontend, so when media tools exist the creation turn runs a **media-only loop** decided by the pure `agent/tool-policy.ts` (`toolPolicyForTurn`, exhaustively tested): skill + MCP tools are NEVER offered on creation (the six-round skill-loading pathology stays dead), the cap is `CREATION_MEDIA_STEPS = 3` (one parallel round of generate calls + the answer + one round of slack — each extra round re-reads the cached prefix at 0.1×), and the brief instructs "all generate calls first, in one round, before any files; reference the returned `/assets/generated/…` paths" (the one sanctioned exception to the brief's never-invent-an-asset-path rule). Without media tools (no KIE key / no project) creation keeps the historic `maxSteps: 1` one-shot.
- **Billing is up-front, refund-on-failure — the inverse of LLM settlement** (`media/service.ts`): price from the ACTIVE list (`quoteMediaRequest` — the same lookup the UI quote shows, so the button's number IS the debit) → anchor a `generations` row (the FK rule) → **debit ledger reason `'media'`** (migration 0009 — may NEVER go negative, unlike `'generation'`: the debit precedes spend, so insufficient balance = 402 refusal, never overdraw) → create the KIE task. KIE refusal → immediate refund + 502. Render failure → refund EXACTLY once (per-task serialisation + a `refunded` latch; a flaky poll is pending, never a failure). Unmetered beta mode never blocks and never overdraws (debit skipped if uncovered). Task state lives at a DERIVED ObjectStore key (`media/tasks/{projectId}/{id}.json` — the seed-store rule); admin reporting separates media spend via the ledger reason + the anchor rows.
- **Transparency is a PIPELINE, not a format — the cut-out pass (BUILT + LIVE-VERIFIED 2026-07-23).** `output_format: "png"` never produced a transparent pixel and never could: Google's image models (the whole Nano Banana line, including Pro and Nano Banana 2) emit **flat RGB with no alpha channel**, and KIE exposes no transparency parameter to ask for one. Asked for "transparent background" the model renders a *picture of* transparency — the editor checkerboard (it reads that pattern as a style, not as UI chrome) or a flat backdrop. **Measured across every render this platform produced, 2026-07-19 → 2026-07-23, all sent with an explicit png:** KIE's `/ggc/` backend returns **JPEG bytes behind a `.png` URL** (the requested format ignored outright), and its `/workers/` backend returns real PNGs that are either colortype 2 (no alpha channel) or colortype 6 with **alpha pinned at 255 for all 4,227,072 pixels**. Not one transparent pixel, ever — and an opaque RGBA container passes a naive `colortype === 6` check, which is how a logo shipped with a grey box behind it and only the checkerboard render was ever noticed. So a request for transparency now runs **two stages in ONE task**: render (as **jpg** — the alpha comes from stage 2 either way, and Recraft caps its input at 5MB where a 2K PNG measured 4–6MB) → **`recraft/remove-background`** ($0.005 ≈ **2 credits**, the ONLY transparency capability in KIE's entire catalog). **Never regress, each fails silently:** the intent signal is a `transparent` **boolean** on the tool and a **Background** dropdown in the panel — *not* a file format, because "does this sit over other content?" is a question the model can answer and "which container?" is not; the delivery decision is ONE pure function (`lib/media/output-format.ts` — quote, payload and dest path all read it, or the file is billed as one thing, written as another and referenced as a third); both stages are quoted and **debited together** (one asset, one debit); a cut-out that cannot run is **REFUSED, never silently downgraded** to the opaque render (that *is* the bug); 4K + transparent is refused **in the quote** (Recraft caps at 4096px) rather than after paying for the render; the stage-1 prompt carries a flat-backdrop directive **forbidding the painted checkerboard by name**; and the model is told never to write "transparent background" into a prompt at all. **✅ VERIFIED LIVE against real KIE (2026-07-23), no defects:** one task chained render→cut-out automatically in 37s, debited 26 credits once, and delivered a 2752×1536 RGBA PNG measuring **79.2% fully transparent / 6.29% semi-transparent** (the soft drop-shadow edge survived) — and the cut-out removed the *background* checkerboard while preserving the checkered-flag ribbon that is part of the artwork.
- **The provider's word is not evidence** (`lib/media/sniff.ts`): the file proxy types the response from the BYTES (peeking only the first chunk, so a multi-hundred-MB video is never buffered) and reports a destPath/content mismatch to monitoring. This is what had been silently writing JPEGs into projects named `.png` since media generation shipped — browsers sniff, so nothing ever threw.
- **Bytes land in the PROJECT** (`public/assets/generated/<slug>-<id>.<ext>`): KIE URLs expire (~3d image / ~14d video), so the client polls `GET /api/projects/:id/media/:taskId` (each poll advances the record at most one state), then fetches the **streamed server proxy** `…/:taskId/file` and writes a `Uint8Array` via `workbenchStore.createFile` — binary-first-class, shows in the file tree, rides the repo on save (§4.5.4b: the platform stores no copy). `lib/media/tasks.ts` dedupes pollers by task id; a closed tab loses nothing (money settled server-side; the panel's history can Resume/Re-save).
- **UI:** a header **Media** button (project-gated) → panel with kind toggle, model dropdown (the curated priced set), per-model option dropdowns (resolution 1K/2K/4K / 720p–4k, Kling quality std/pro/4K, audio, duration 4–10s, aspect), and **the exact credit price on the Generate button** (re-quoted server-side on every option change — `action:'quote'`, which never debits). Recent-tasks list with status, refund notes, Resume and Re-save.
- **Routes are two-wall + gated** (§4.5.3, §4.5.4): verified user + `requireOwnedProject` on all three; start requires the platform KIE key as a describable 503 BEFORE any debit; the file proxy takes no caller-supplied URL (the record supplies it — nothing to traverse). 404-not-403 for unknown tasks.
- **Deferred from v1** (additive when wanted): reference-image input (image-to-video first-frame, style refs — the upload endpoint is in the wire reference), per-project default options for the agent's tool calls, premium-asset-style Stripe top-up prompts on 402.

### 4.17 Unity Editor Bridge (local editor, platform credits) — BUILT 2026-07-19

> **Status: BUILT, not yet live-verified against a real Unity Editor.** Owner directive (2026-07-19): close the loop on the browser-based workflow — the agent must be able to drive the user's **local Unity Editor** (scenes, GameObjects, scripts, assets) from the **same project chat**, orchestrated by OUR model on OUR credits. Options evaluated: **Unity AI Assistant** (`com.unity.ai.assistant`) was REJECTED — it bills through Unity's own points tied to the Unity account, with no way to route orchestration through platform credits; **CoplayDev/unity-mcp** (MIT, UPM package + MCP server, 47 editor tools) was adopted AS-IS, as a tool surface only. Pinned by `mcp/loopback.spec.ts`, `mcp/remote-client.spec.ts`, `stores/unityBridge.spec.ts`, `agent/unity-live-relay.spec.ts`, and the companion package's own 59 `node:test` tests.

- **The connection is browser→localhost, and it could not be anything else.** §5's SSRF guard (`net/ssrf.ts`) refuses private/loopback addresses on the server BY DESIGN, so the platform can never reach the user's machine — and it must not. The browser holds the connection; the platform only orchestrates. This is the same shape as §4.14 (MCP servers execute in the user's sandbox, never on platform infra), with a network transport in place of stdio.
- **Zero billing changes, because it reuses the §4.14 live relay verbatim.** A Unity tool is just an MCP tool wearing `server: 'unity'`: it rides `body.mcpTools` → `mcpLiveTools` → `createMcpRelayTools`, and its `execute` emits an `mcp-tool-call` data part then parks on `awaitClientToolResult` inside ONE `streamText` generation — one credit gate, one settlement (§4.6). `agent/unity-live-relay.spec.ts` drives the real AI SDK with only the model mocked and pins exactly that: the data part flushes over the still-open response, delivery resumes the SAME generation id, and `server: 'unity'` survives end-to-end. Mutation-verified — dropping the `server` label deadlocks the generation, which is the silent-on-the-user's-bill failure the pin exists to catch.
- **`unity` is a RESERVED server label.** It is defined at the leaf (`mcp/webcontainer-bridge.ts`) and `McpBridge.launch` refuses any `.mcp.json` server claiming it, BEFORE the transport check. `.mcp.json` travels with remixes and GitHub sync, so a project-declared server wearing that name would hijack every Unity-routed call. `mcpNote` also drops it, so the model is never told a server exists that cannot start.
- **Unity tools live in their OWN atom** (`stores/unityBridge.ts` → `unityToolsAtom`), merged into what the chat forwards via `combinedMcpToolsAtom` — never co-written into `mcpToolsAtom`, which `syncMcpBridge` wholesale `.set()`s on every `.mcp.json` resync and teardown. Co-writing it would silently drop the Unity tools mid-session. `callMcpTool` routes `server === 'unity'` to the loopback client (dynamic import — a static one would be a TDZ-fragile cycle).
- **Loopback-only, enforced before any fetch** (`mcp/loopback.ts` — `isLoopbackHttpUrl`, pure + exhaustively tested): `http:` only, host exactly `127.0.0.1` / `localhost` / `[::1]`, valid port. Because the check runs on the WHATWG-parsed hostname, no encoding shorthand (`127.1`, octal, `2130706433`) can pass while targeting something else. The same rule closed a pre-existing gap: `.mcp.json` `sse`/`streamable-http` servers previously bypassed allow-listing entirely and are now rejected unless loopback.
- **The companion CLI is the connection** (`companion/`, **`@babylonjs-toolkit/bridge`** — the owner's existing npm scope, alongside `@babylonjs-toolkit/next` and `@babylonjs-toolkit/kie`; MIT, zero runtime deps, Node ≥18, published separately; excluded from the app's tsconfig/vitest). ⚠️ **Not yet published** — `npx @babylonjs-toolkit/bridge` works only after `npm publish --access public` from `companion/`; until then it is `pnpm companion` from the repo. The npm `bin` is `bridge` (matching the unscoped package name, so `npx` resolves it without ambiguity). `npx @babylonjs-toolkit/bridge` launches or attaches to the Unity MCP server and reverse-proxies it on `127.0.0.1` — never `0.0.0.0`, which is the upstream server's own default and is LAN-reachable. It adds the two things the browser needs and upstream does not provide: the **CORS + Private Network Access preflight** answer (`Access-Control-Allow-Private-Network: true`, plus `Mcp-Session-Id` in `Access-Control-Expose-Headers` — a response header the browser cannot read otherwise, so the MCP session would silently restart every request) and a **pairing token** wall (`Authorization: Bearer`, constant-time compare, minted fresh per run, refused before the forward). The preflight is deliberately exempt from the token check: browsers never attach credentials to a preflight. Value-taking flags (`--origin`, `--token`) ERROR on a missing value rather than failing open to wildcard.
- **The relay window is 180s for Unity only** (`UNITY_RELAY_TIMEOUT_MS`, decided per-tool in `mcp-tools.ts`; `mcp-relay.ts` untouched — the `timeoutMs` seam already existed). A Unity script edit triggers a domain reload and recompile, and an asset import can exceed a minute; at the 60s default the model reports failure for an operation that succeeds moments later. Parking costs no tokens — the generation is idle, not decoding — so the only price is wall clock.
- **Guided export, not file transfer (this build).** The bridge has NO file channel. The agent context note (`project-notes.ts`, volatile region) tells the model these tools act on the LOCAL Unity project and NOT on the web project files, and that to bring content across it must run the Babylon Toolkit exporter and then **tell the user to import the exported folder** — never claim exported assets are already present, never invent paths for them. Automatic Unity→WebContainer file transfer is deliberately deferred.
- **Same-machine by DESIGN, not by limitation (owner decision, 2026-07-19).** The browser must be running on the same computer as the Unity Editor, because the connection is to `127.0.0.1`. This is the preferred shape, and it is a security property rather than a shortfall: the Editor is never reachable off that machine, there is no relay or tunnel holding a credential, and nothing about the pairing survives leaving the desk. A remote-Unity variant would need a fundamentally different transport and is explicitly NOT a goal.
- **Supported browsers: Chrome and Edge.** They treat loopback as potentially-trustworthy, so an HTTPS page may reach `http://127.0.0.1`; Safari and Firefox block or restrict this in some versions. The connect dialog says so on failure. The pairing token lives in `localStorage` (per-machine, never in the project file) and nothing auto-connects — a stale token failing silently in the background would be indistinguishable from the feature being broken.
- **NOT yet verified live** (the §4.14 relay's own history is why this is stated plainly): no run against a real Unity Editor or a real `uvx`-spawned server; the browser PNA handshake is proven only at the header level (curl cannot test what Chrome accepts from an HTTPS page); and the model calling a Unity tool in a real chat turn is traced statically end-to-end but never executed. "Correct by construction" is exactly what the MCP relay was before live testing found three defects in it.

### 4.18 Unity Project Licenser (platform-native project license generation) — BUILT 2026-07-20

> **Status: BUILT.** Replaces the retired PayPal/ASMX-era licensing (§4.6.1) with a platform-native licenser billed on **credits** — the credits-based replacement for the legacy annual Pro Tools subscription (owner decision 2026-07-20: kill the PayPal subs, gate Pro Tools on credits). A user links their Unity project (by Unity Project ID / `productGUID`) to an App Builder project from the Unity Exporter connect dialog, picks a tier, and the platform generates a `license.json` **byte-compatible with the unchanged `licenser.cs` validator** shipped in the Unity Exporter plugin. Generating is a **flat credit charge per tier** (the price ladder below): the credit balance IS the Pro Tools entitlement — no credits, no license. Owner decisions: ASMX + PayPal-sub retirement, credit price ladder, once-per-(project,tier)-then-free, never-expires project-locked licenses, `org = '*'` (any org), "Enterprise Studio" as the display name for the `PremiumContent` plan. Pinned by `unity-license-crypto.spec.ts`, `unity-license.spec.ts`, `unity-license-pricing.spec.ts`, `license-entitlements.spec.ts`, `unity-license-service.spec.ts`, `unity-license-route.spec.ts`, `license-delivery.spec.ts`, `UnityConnection.spec.tsx`, `opaque-files.spec.ts`, and migration-0011/0012 assertions in `ledger-sql.spec.ts`.

- **Tier is a PAID SELECTION on a credit price ladder — no longer derived from a Stripe subscription** (`unity-license-pricing.ts` + `unity-license-service.ts`). The user picks the tier; each is a flat, config-driven credit price (defaults **Indie 500 / SmallBusiness 1,000 / Enterprise Studio 2,000**, env-overridable per tier, a negative/non-finite override ignored). Seats follow the chosen plan (`tierForPlanName`): Indie `s1=s2='locked'`, SmallBusiness `s1=s2=''` (two blank editable seats), PremiumContent `s1=s2='unlimited'`. The plan STRING stays `Indie`/`SmallBusiness`/`PremiumContent` (the `licenser.cs` byte-compat constraint); "Enterprise Studio" is only the UI label for `PremiumContent`.
- **Billing — flat charge, once per (Unity project, tier), free to re-generate** (reason `'license'`, migration 0012; `unity-license-service.ts` mirrors the `media` money path but synchronous). The debit runs BEFORE the license is issued and **may never overdraw** (`'license'` is absent from `mayGoNegative`), so with billing enforced an insufficient balance REFUSES (402) and no license is issued; unmetered mode records the debit when the balance covers it and otherwise charges nothing. The paid unlock is recorded in `unity_license_entitlements` keyed to **(user, Unity project id, tier)** — NOT the App Builder project, so re-linking many Unity GUIDs to one App Builder project cannot mint many perpetual licenses for one payment. Re-generating or re-downloading an unlocked pair is free forever; a higher tier is a separate full charge. **The TOCTOU double-charge is closed:** two concurrent generates both pass `has()` and both debit, but the unique index records exactly one unlock, so the loser's `grant()` returns `{granted:false}` → its redundant debit is refunded and it reports free (a Stop-not-a-failure-class money invariant, tested).
- **Byte-compat contract with `licenser.cs`** (`unity-license-crypto.ts`, server-only): the `secret` is AES-256-CBC (base64) of `plan|licensee|org|product|project|expires`, key = .NET `PasswordDeriveBytes('12bucklemyshoe', null salt, 100 iterations, 32 bytes)` (PBKDF1-SHA1 with the Microsoft block extension, reimplemented in Node), IV = UTF-8 of `xdgrq4yhjmd1ajel`, PKCS7. The `key` = `computeProjectLicenseKeyHash(plan + '-' + productGUID)` = MD5 over UTF-16LE of the lowercased, per-part-space→underscore seed with the `-babylontoolkit.com-05.00.00` suffix, first 28 hex chars uppercased and dash-grouped by 4. **All three primitives are pinned byte-exactly against the live `license.json` test vector** (`EnterprisePartner|Mackey Kinard|*|*|*|never` → `CFA7-9108-9069-F09C-ED6F-1A68-8AB7`), because the fixed key/IV make encryption deterministic. The crypto constants live server-side only and appear in no client bundle (§5).
- **License fields are server-derived end to end.** `licensee` = the Supabase-verified user email; `product` = the linked Unity Project ID (lowercased — the value the plugin hashes against `PlayerSettings.productGUID`, i.e. the project lock); `project` = the App Builder project name; `org = '*'` (matches any org); `trial = false`; `expires = 'never'` (perpetual for that project). The seat fields `s1`/`s2` live OUTSIDE the encrypted secret and the key hash, so a user hand-editing seat emails into the file inside their Unity project never invalidates the license — which is why SmallBusiness ships blank seats and Studio ships "unlimited". A `unityProjectId`/`email` supplied in the request body is ignored.
- **The Link flow (two walls, metadata-only).** The linked id is stored per App Builder project as **`linkedUnityProjectId`** on the `Project` record (both FS and Supabase backends; migration **`0011_unity_project_link.sql`** adds a single nullable `linked_unity_project_id text` column — a plain pointer following the `gameBackendRef` precedent, never a credential). The route `api.projects.$projectId.unity-license.ts` enforces the §4.5.3 two walls (`requireVerifiedUser` + `requireOwnedProject`, 404-not-403) on GET (`{ linkedUnityProjectId, tiers }` — each tier's price + whether it is already unlocked) and POST (`link` / `unlink` / `generate { tier }`). The `tier` is client-supplied but server-validated (`isValidLicenseTier` → 400), and `licensee`/`product`/`project` are server-derived, so a client cannot buy a cheaper tier than it receives or forge the licensee/GUID. Linking does **not** require the Unity bridge to be connected; the GUID is validated server-side as 32 hex chars. Unlinking clears the pointer but never deletes already-generated license files.
- **Delivery — three ways, no extra credits, no LLM generation** (`app/lib/unity/license-delivery.ts`, client-safe; the charge is the one flat debit at generate-time, not here): (a) the returned JSON is written to the web project root as **`/license.json`** via `workbenchStore.createFile` (the `media/tasks.ts` pattern), so it travels with the user's repo on the next save; (b) a **best-effort MCP drop** into the connected Unity project at **`Assets/[Config]/license.json`** via a dynamically discovered asset/script-write tool from `unityToolsAtom`, routed through the ordinary `callUnityTool` path (§4.14 — the reserved `unity` server-name routing is untouched); a missing tool, a disconnected bridge, or a tool error is a **loud structured failure** (`{ ok: false, reason }`) that surfaces manual copy instructions in the dialog — never a silent false success; (c) a plain **Download** button saves `license.json` locally. `license.json` is classified **opaque** in `app/lib/context/opaque-files.ts` (root-relative exact match — declared, never shown to the model), and it is deliberately NOT an `isSecretPath` (it must travel with the user's repo).
- **UI:** the Unity Exporter connect dialog (`UnityConnection.tsx`) gains a distinct **Unity Project License** section beneath the connect/pair controls, rendered only with an active project. It shows the linked id or a Unity Project ID input (hint: Unity → Edit → Project Settings → the 32-char `productGUID`, also in `ProjectSettings/ProjectSettings.asset`) with Link/Unlink, a **tier picker** showing each tier's credit price and an "unlocked (free re-download)" marker for tiers already paid, a per-tier seat/email explanation (including the Indie email-match hint — the Unity account email must equal the App Builder email; paid tiers hand-add seat emails), and **Generate** (its button shows the exact price, or "Re-generate — free" when unlocked) + **Download** buttons.

## 5. Security & Abuse

- Platform Anthropic key: server-only, never in client bundles; Console spend caps + alerts from day one.
- Code execution is inside the user's own browser tab (WebContainers) — inherently self-sandboxed to them; no cross-tenant execution surface. Server never executes user code — including skill `scripts/` (§4.11).
- Shell action allow-list (`npm install`, `npm run`) enforced client-side in the executor AND the server strips disallowed actions from streams as defense-in-depth.
- Prompt-injection stance: the agent's tools are the skill loaders (`load_skill`, `read_skill_resource` — read-only, from our synced trusted store, manifest-validated paths), **MCP tools (project-scoped `.mcp.json`; servers execute only inside the user's own WebContainer with project-tree command resolution; all tool results treated as untrusted input — §4.14)**, plus file/shell actions in the user's own container; server routes validate that snapshot writes target only the user's own project. Game Backend credentials (§4.15) are the user's own and grant no platform access.
- Free-credit abuse: email verification before grant, rate limits, device heuristics, grant kill-switch.
- Shared builds are static files on S3/CloudFront; sanitize project names/descriptions; shared HTML is user code running on a `/play` route — serve from an isolated origin/subdomain so it can never touch app cookies/sessions.
- **User uploads** (§4.9 assets, §4.12 attachments): type allow-lists, size caps, glTF structural validation, per-user storage quotas; uploads are never executed server-side.
- **Public content moderation:** gallery is admin-curated (nothing public without approval); every `/play` page carries a Report link → admin queue → unpublish. Project names/descriptions on public pages sanitized and length-capped.
- GitHub sync tokens (OAuth/App) server-side per user with content-only scopes; pushes/pulls validate project ownership like every other route; remixes never inherit repo links (§4.13).
- Stripe webhooks verified + idempotent. RLS on all Supabase tables.
- **Every server route that reaches OUT (fetches, proxies, deploys) or writes client-supplied bytes to storage is a spend path on the OWNER's resources**, and requires a verified user + the appropriate wall — see `spec/spend-holes.md`. Authentication lives INSIDE the handler (`denyUnlessVerified`), never in a wrapper option; any caller-influenced fetch URL passes the shared SSRF guard on every redirect hop; a route may act on a platform secret but never emit one (the `get_token` / export-api-keys rule); client uploads are size-capped. The inherited bolt.diy outbound routes were all anonymous and are closed additively (§2.1b).

---

## 5A. Operations, Observability & Legal Readiness

> **Status: OPS BASELINE BUILT (Stage 5, 2026-07-15), vendor-neutral.** `app/lib/.server/monitoring/` is a transport-agnostic interface — no-op/log by default, ships to `MONITORING_WEBHOOK_URL` (errors + alerts) / `ANALYTICS_WEBHOOK_URL` (events) when set — so no vendor SDK is committed (this section names Sentry/PostHog only as examples; "decide tool in Phase 2" stays open, and the choice is one env var at the credential pass). It NEVER throws (observability can't become an outage) and is fire-and-forget. **Alerting** fires on: generation failure-RATE (a rolling in-process window, `monitoring/failure-rate.ts`), Stripe webhook failure, doc-sync + skills-sync build failure, and license-service unreachability. **Funnel events** are emitted at every stage below (signup/verified/project_created/generation_started+completed+failed/first_playable/share_published/remix_created/purchase_completed), each at its real lifecycle call site. **Health:** `/api/health` + a `/healthz` alias report per-dependency CONFIG state (booleans, never a secret) plus a `ready` flag the §9a check keys on; liveness is always `healthy` so an uptime monitor never red-alerts on a merely-unconfigured dependency. **Client errors** forward through `/api/monitoring/client-error` into the same monitor (a root `ErrorBoundary` + the GitHub boundary). Still config-only (the credential pass): a real collector URL, Supabase automated-backup schedule, and the S3 lifecycle policy.

**Ops (Phase 2 alongside staging):**
- Error tracking (e.g., Sentry) on client and server; alerting on generation failure rate, webhook failures, doc-sync/skills-sync build failures, and license-service unreachability. — **BUILT (see status note); wiring a collector is a credential-pass step.**
- Product analytics (privacy-respecting, e.g., PostHog or equivalent): the funnel that feeds the acquisition story — signup → verified → first generation → first playable → share → purchase; plus retention cohorts and per-phase exit metrics. Decide tool in Phase 2; instrument events from the first staging deploy so history exists by the time management needs charts. — **Events INSTRUMENTED at all six stages; the sink URL is the credential-pass step.**
- Supabase automated backups verified + restore drill before Phase 3; S3 lifecycle policies for snapshot pruning and unpublished builds (config). — **Config-only, tracked in DEPLOY.md.**
- Uptime monitoring on app + `/play` origin; simple status page by Phase 4. — **`/healthz` endpoint built; monitor config is ops.**

**Legal documents (gate: before first external user, with #10's deletion review):**
- Terms of Service and Privacy Policy for the platform (data collected, LLM processing disclosure, cookies/consent as applicable by region).
- **User IP position stated in ToS:** users own the games they create; we take only the license needed to host/serve shared builds and display gallery entries. (Clean user-IP terms are also an acquisition-diligence item.)
- Anthropic usage-policy alignment: user prompts/content pass to the Anthropic API under our commercial terms; disclose in Privacy Policy.

---

## 6. Licensing & Legal Posture (management workstream — tracked here because launch gates on it)

- **bolt.diy (MIT):** free for all uses including commercial; retain license/copyright notices. No action needed.
- **WebContainers (proprietary, StackBlitz):** per StackBlitz's published terms — prototypes/POCs need no license; **production commercial use serving customers requires licensing**. The exemption is about OUR product's stage, not about users building "prototype games": once external users are served at app.babylontoolkit.com (even free, even invite-only beta), we are in commercial production use.
  - **On-ramp:** paid StackBlitz commercial plan includes WebContainer API integration up to **500 sessions/month** (per their ToS) — the minimum viable legal footing for a small beta. In place **before the first external user**.
  - **Scale:** negotiated commercial license (private enterprise pricing) — management to open the conversation **now**, in parallel with development, and obtain terms **in writing** (including confirmation of the 500-session reading and whether charging credits affects terms — it shouldn't; the license covers commercial use, and charging users is our business decision).
  - **Acquisition angle:** clean licensing is a diligence requirement, not overhead. "Properly licensed or fully self-hosted sandbox" must be the answer the data room finds.
- **Development is ungated:** local dev, staging, internal demos, management/acquirer demos require nothing from StackBlitz. Build starts now.
- **Escape hatch:** see §8.

## 7. Cost Model (why this works without big capital)

- User project compute: ~$0 (WebContainers run on user CPUs).
- LLM: prepaid by credits before spend; free-grant exposure ≤ ~$2.00 of raw model spend per user (the default 800-credit grant on KIE = ~3.5× a cold creation at margin 4.0 — held down further in warm production by the shared cached prompt + history compaction), capped by flags and Console limits. Purchased credits carry the margin over Opus's real cost, so paid usage is never out-of-pocket.
- Prompt caching on the large stable system prompt is the main input-cost reducer → margin lever.
- Fixed costs: AWS Lightsail (~$7–15/mo per env) + S3/CloudFront (cents→dollars), Supabase tier, StackBlitz plan, Stripe fees, domains — tens of dollars/month at beta scale.
- Check Anthropic startup/credit programs and current API pricing before launch (docs.claude.com / anthropic.com).

## 8. Escape Hatch: Sandbox Swap (WebContainers → server containers)

Trigger conditions: StackBlitz terms unacceptable at scale, or WebContainer limits (install speed, memory alongside Babylon scenes) hurt UX. Plan: implement a `SandboxProvider`-style seam matching bolt.diy's runtime abstraction; E2B (or self-hosted Firecracker/Docker) implementation runs the same starter + Vite with preview URL proxied to the iframe. Costs shift from $0 to per-session compute → priced into credits. **Standing rule (from §1.3):** no new WebContainer-specific coupling outside the existing runtime layer, so this stays a bounded refactor — and remains management's negotiating leverage with StackBlitz.

---

## 9. Milestones (LAUNCH/GATING ORDER — NOT CONSTRUCTION ORDER)

> **Read §1.3 principle 0 first.** These phases exist to sequence *launch gates* (what must be true before external users, before billing, before scale) — they do NOT sequence the build. **Build every feature in every phase now.** A feature's phase tells you when it must be *live and gated*, not when you're allowed to write it.

### Phase 9a — The Credential Pass (runs whenever keys arrive; NOT a build blocker)

Per §1.3 principle 0, every feature below is BUILT during Phases 1–2 with config-driven degradation. This pass is pure configuration + verification — no new features:

| Credential | Unlocks | Until then (built, degraded) |
|---|---|---|
| `ANTHROPIC_API_KEY` (Console org) | Credits-mode generation (`DEFAULT_MODEL` = `claude-opus-4-8`) | Credits UI renders; generation returns "platform key not configured"; devs set `PRO_FEATURES_ENABLED=true` + BYOK locally |
| ~~License service `ValidateSubscription`~~ (RETIRED 2026-07-20) | — | External license service retired; BYOK/Pro disabled by default and manual/testing-only (§4.6.1). No credential needed |
| `STRIPE_*` | Credit purchases | Checkout UI built; buy button shows "payments not configured"; ledger/grants fully functional |
| `SUPABASE_*` | Hosted auth/persistence | Local/dev persistence path; feature-flagged |
| AWS `S3_*` | Snapshots/play builds | Local filesystem/dev bucket adapter |
| `MONITORING_WEBHOOK_URL` / `ANALYTICS_WEBHOOK_URL` (§5A) | Ship errors/alerts + funnel events to a collector | Monitor logs locally; every call site already wired (no-op transport) |
| StackBlitz plan | LEGAL to serve external users | Irrelevant to building; gate only at first external user (§6) |

Verification checklist per credential: set config → restart → the previously-degraded UI path now completes end-to-end.

### Phase 0 — Prompt proof (days; throwaway; start immediately)
Script: prompt → Anthropic API (system prompt assembled from Agent Reference + a hand-built skills index; `load_skill` tool resolving from a local clone of the skills repo) → parse file actions → write into a local clone of the golden starter template (`babylontoolkit/AppTemplate` — self-contained, no submodules) → verify Vite HMR shows the change.
**Exit:** 10 varied prompts appropriate to the chosen template's genre (feature adds, visual changes, HUD elements) each yield a runnable change with ≤ 1 manual fix, and at least one prompt demonstrably triggers a skill load that improves the result. If this fails, fix the docs/skills/prompt layer before fork surgery. (APEX BURNOUT on Lovable is informal evidence this passes.)

### Phase 1 — Fork surgery (local, single-user; no external users)
Fork bolt.diy → strip/replace per §2.3 → doc-sync v1 (build-time prompt bake; manual rebuild) → **skills sync v1 + `/skill-name` slash invocation with autocomplete + description-triggered `load_skill` loop in the agent proxy (tool loop built MCP-ready)** → AppTemplate-DEFAULT project creation (registry promoted; upstream blank/import retained under Advanced) → server-side agent proxy with platform key + prompt caching + usage recording (incl. `skills_loaded`) → branding pass.
**Exit:** a local user builds and plays a modified game (golden template) through the forked UI with zero manual setup; a physics/racing-flavored request visibly routes in the relevant **Component Reference on-demand block** (§4.3) and yields batteries-included code. Skills demo: `/bt-spec <feature>` in the chat loads the bt-spec skill and produces its workflow output against the project.

### Phase 2 — Hosted layer + billing built (still gated; internal/demo only)
Supabase auth/projects/snapshots/messages/generations → credit ledger + Stripe packs behind `BILLING_ENFORCED=off` → free-grant flow with verification gating → **Pro Tools entitlements v1 (Pro-gated BYOK — the original external `ValidateSubscription` integration was RETIRED 2026-07-20, BYOK now disabled by default and manual/testing-only, §4.6.1)** → **generation Stop + checkpoint restore (§4.12)** → **MCP v1: parse project `.mcp.json`, launch stdio servers in the WebContainer, tool-call bridge into the server tool loop (§4.14)** → admin prompt **and skills** refresh endpoints → self-healing loop → **ops baseline (error tracking, analytics events, backups — §5A)** → deploy to staging on app.babylontoolkit.com behind auth wall.
**Exit:** end-to-end demo on the real domain: sign up → wizard-less new project → generate → **break it → restore checkpoint** → snapshot/resume → (simulated) purchase → ledger correct → **a Pro Tools subscriber account shows BYOK unlocked and generates on its own key**. **This is the management/acquirer demo build.**

### Phase 3 — Beta launch (FIRST EXTERNAL USERS — StackBlitz plan/license must be active)
Invite-only, ≤ 500 WebContainer sessions/month under the paid-plan allowance. Guided Tour wizard → share + `/play` pages (with Report link) → **remix + self-remix/Duplicate (§4.8)** → gallery v1 → **Game Backends v1 (connect own Supabase; leaderboard wizard toggle; RLS pre-share warning — §4.15)** → **chat image attachments + user asset uploads (§4.12, §4.9)** → GitHub webhook auto-refresh for docs **and skills** → skills usage dashboard (which skills fire, cost impact) → **ToS/Privacy live (§5A)** → decide `BILLING_ENFORCED` on (recommended: on, with generous grants — revenue data > free-user data for the acquisition story).
**Exit:** external non-developer completes wizard → playable shared game, unaided; unit economics measured (real cost/generation, cache hit rate, margin).

### Phase 4 — Public launch & growth
StackBlitz negotiated license (or E2B swap decision) per real session volume → remaining genre templates → remix loop → Assets tab with first premium GLTF packs → export ZIP + **full GitHub Sync (§4.13: link, push, pull, divergence flow)** → **MCP hardening: `.mcp.json` edit UX, secret-scan on push/share, per-server enable toggles (§4.14)** → external deploy buttons surfaced (Netlify/Vercel/GH-Pages, §2.3) → subscription option → admin dashboards complete. (Community skills marketplace: recorded intent in §4.11, post-launch.)

---

## 10. Open Questions

1. ~~Golden starter template~~ — decided: `babylontoolkit/AppTemplate` (ES6 by design; MIT; template repo). ~~Residual: submodule vendoring in snapshots~~ — **resolved: the starter vendors `src/babylon` directly; it has no submodules (§4.4).** Residual: WebContainer install time/memory with the full Babylon dependency set.
2. WebContainer perf with a real Toolkit project (install time, memory next to a Babylon scene) — measure in Phase 1; feeds the escape-hatch decision.
3. StackBlitz written terms: 500-session reading confirmed? Does charging credits change anything? (Expected no.) — management, start now.
4. Retail credit pricing/pack sizes (needs Phase 2–3 usage data).
5. Asset pack licensing text for premium GLTF content used in user games.
6. ~~Hosting target~~ — decided: **AWS** — Lightsail Container Service (Docker) for the Remix app, S3 + CloudFront for snapshots and the separate-domain play origin (existing AWS account); see `spec/hosting.md`.
7. ~~Upstream pull cadence / divergence cutoff~~ — decided: indefinite pull compatibility, monthly cadence, rules in §2.1a. Residual: the merge around upstream's planned agent-backend rework will be the hardest single pull — schedule dedicated time when it ships.
8. Anthropic startup credits / current model pricing — verify before Phase 3.
9. Skills repo: (a) spec-validity audit of existing workflow skills (bt-spec, bt-plan, bt-design…) — these are first-class platform skills, slash-invocable in chat; (b) SKILLS_BACKLOG.md domain/pattern skills are OPTIONAL future content (a `leaderboards` skill or training example is wanted before the Phase 3 wizard toggle); (c) description quality tuning for auto-triggering.
10. Account deletion & data retention: jurisdiction requirements (GDPR et al.) for PII purge vs. financial-ledger retention — legal review before public launch.
11. ~~Payment provider strategy~~ — decided: **Stripe only** (the platform's sole payment + subscription signal; the external license service is retired, §4.6.1). Residual: revisit Merchant-of-Record (Paddle/Lemon Squeezy) only if international VAT/sales-tax burden becomes material — finance to monitor after `BILLING_ENFORCED=on`.
12. ~~`ValidateSubscription` endpoint~~ — obsolete (RETIRED 2026-07-20): the external ASMX license service is no longer called; BYOK/Pro is disabled by default and manual/testing-only, and the only subscription signal read is the live Stripe plan (§4.6.1, §4.18). No endpoint to build.
13. ~~Tier allowance sizing~~ — obsolete: Pro perk is BYOK, not credit allowances. Residual: whether tiers ever differentiate platform features (all tiers = same BYOK at launch).
14. Toolkit version migration: templates pin `toolkit_version`; policy for existing user projects when the Toolkit releases breaking updates (stay pinned forever vs. agent-assisted upgrade flow) — decide before Phase 4.
15. Transactional email provider (verification, receipts, entitlement notices): Supabase's built-in email is not production-grade — pick Resend/Postmark/SES-class provider in Phase 2.
16. Product analytics tool selection (§5A) — Phase 2.
17. **Online multiplayer scoping:** the Toolkit ships a full Colyseus stack out-of-box, but online play requires a Colyseus server endpoint. Launch scope: single-player + split-screen local multiplayer; shared builds of network-capable games run `?solo=true`. Platform-hosted Colyseus endpoints ("platform Multiplayer Hosting") = a natural premium service and expansion intent (§1.4) — decide post-launch.
18. **Final product brand:** neutral working name is "Babylon Toolkit App Builder." A distinct product brand (candidate: CodeWRX at app.codewrxai.com, with Babylon Toolkit as the "powered by" technology layer) is under consideration — decide before Phase 3 beta; execution is a brand-module swap + domain-migration runbook (§2.5, spec/hosting.md), an afternoon of work either way.
19. Scene CDN readiness: CORS headers + content-encoding for `.gz.gltf` on repo.babylontoolkit.com for WebContainer-preview and play-domain origins; confirm CDN-class hosting/bandwidth since it sits in the serving path of every scene-referencing preview/play (Phase 1 verification).

## 11. Working Agreement

- This SPEC.md + CLAUDE.md read at the start of every AI coding session.
- Sub-specs split out as areas deepen: `spec/doc-sync.md`, `spec/skills.md`, `spec/billing.md`, `spec/wizard-config.md`, `spec/sandbox-seam.md`, `spec/licensing.md`, **`spec/fail-loud.md` (owner directive 2026-07-25: a paid request never fails silently — four terminal states, the standing rules, and the staged kickoff plan for the owed guards)**. This file remains the index and source of truth for scope.
- Changes to the action protocol handling, the sandbox seam rule, the credit formula, or the licensing posture update this spec in the same PR.
- The previous custom-build spec is archived for reference as the potential long-term destination; do not build from it.

---

## Appendix A — Vendor & Account Setup Checklist

Who sets up what, when, and where. Company accounts throughout — never personal emails; use a shared/role address (e.g., dev@babylontoolkit.com) with 2FA, credentials in the company password manager.

### A.1 Anthropic Console (LLM provider) — needed at Phase 0

This is the **developer platform** (usage-based API billing), separate from claude.ai subscriptions and from Claude Code logins. End users of our platform never have any Anthropic account; only we do.

1. Create an organization account at **console.anthropic.com** (company email).
2. Add a company payment method (usage-based; billed monthly for tokens actually consumed — no prepay required).
3. **Set spend limits and billing alerts immediately** — before the first API call. This is the hard cap that makes a billing bug in our code non-catastrophic.
4. Create an API key per environment (`dev`, `staging`, `prod`); store server-side only (env vars / secret manager). Never in the client bundle, never committed.
5. Note rate-limit tier; request increases via the Console as usage grows.
6. Check current model names/pricing and the startup credits program before Phase 3 (docs.claude.com, anthropic.com).

Owner: dev (you). Blocker for: Phase 0 script's API calls. Cost: $0 until tokens are consumed.

### A.2 StackBlitz (WebContainers runtime) — plan needed before Phase 3, conversation starts NOW

1. **Nothing needed for Phases 0–2.** Local dev, staging, and internal demos fall under StackBlitz's prototype/POC exemption — no account, no plan, no contact required to build.
2. **Before the first external user (Phase 3 gate):** purchase a paid commercial StackBlitz plan (Teams tier or per current offering at stackblitz.com/pricing) — per their ToS this includes WebContainer API integration up to 500 sessions/month.
3. **In parallel, starting now (management):** contact StackBlitz for commercial licensing — via the contact form at webcontainers.io/enterprise or hello@stackblitz.com. Enterprise pricing is private and negotiated; expect a sales cycle, which is why this starts during development, not at launch.
4. **Get in writing:** (a) confirmation of the 500-session/month reading for our beta; (b) that charging users credits is covered (expected yes — the license covers commercial use generally); (c) session definition/counting; (d) pricing tiers beyond 500 sessions. These answers feed the Phase 4 license-vs-E2B-swap decision and the acquisition data room.

Owner: management (item 3–4), dev flags session counts. Blocker for: Phase 3 launch. Cost: ~tens of $/month for the plan; negotiated beyond.

### A.3 Supabase — needed at Phase 2

Create an organization at supabase.com (company email) → project per environment (staging, prod) → enable email auth → note connection strings/keys into the secret manager. Free tier suffices until beta. Owner: dev.

### A.4 Stripe — needed at Phase 2 (built), live mode before Phase 3 billing-on

Company Stripe account at stripe.com — **requires business entity details, bank account, and identity verification, which management/finance must provide; activation review can take days, so start when Phase 2 begins.** Dev works in test mode meanwhile (full integration, fake cards). Create Products/Prices for credit packs; configure webhook endpoint + signing secret per environment. Owner: dev (integration) + finance (activation).

### A.5 Also on the list (dev, as needed)

- GitHub org access to `babylontoolkit/*` for the fork, doc-sync fetches, and (Phase 3) the webhook.
- **AWS** (existing account): Lightsail Container Service (staging + prod), S3 buckets (snapshots + play builds), CloudFront for the play origin, IAM deploy/runtime roles, SSM for secrets (decided, spec/hosting.md) at Phase 2. DNS stays wherever babylontoolkit.com is managed today.
- Transactional email provider (Resend/Postmark/SES-class) wired into Supabase Auth SMTP settings at Phase 2 — verification and receipt emails must not depend on Supabase's default sender.
- Error tracking + analytics accounts (Sentry-class, PostHog-class — §5A) at Phase 2.
- DNS: `app.babylontoolkit.com` (staging behind auth first) plus a **separate registrable domain for `/play` builds** (§5, spec/hosting.md) — a different domain entirely (not a subdomain), served by CloudFront, so user game HTML can never touch app cookies.

### A.6 Gate summary

| Phase | Must be in place |
|---|---|
| 0 (now) | Anthropic Console org + key + spend caps |
| 1 | GitHub fork; nothing new |
| 2 | Supabase; Stripe test mode; staging hosting + DNS |
| 3 (first external users) | StackBlitz paid plan (+ written terms); Stripe live; play-domain isolation |
| 4 | StackBlitz negotiated license or E2B swap decision |

