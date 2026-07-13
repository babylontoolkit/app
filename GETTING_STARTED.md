# GETTING_STARTED.md — Building app.babylontoolkit.com

You have: a bolt.diy fork on disk + this kit. Here is the entire workflow.

## Step 1 — Unzip the kit into the fork root

That's the whole step. The kit's sub-specs live in a `spec/` folder, which doesn't exist in bolt.diy, so nothing conflicts with bolt.diy's own files.

Resulting layout in the fork root:
```
SPEC.md  CLAUDE.md  FORK_BASE.md  GETTING_STARTED.md  DEPLOY.md
NEW_PROJECT.md  SKILLS_BACKLOG.md (→ skills repo)  spec/*.md        ← the kit (new)
   spec/ includes anthropic-models.md — the provider rebuild guide (§4.2a).
   NOTE: any doc Claude Code writes into the fork (e.g. docs/*.md) is NOT in this
   kit — copy such files into spec/ so they survive a re-clone.
app/  docs/  package.json  ...                                     ← bolt.diy's existing code (untouched)
```

Commit this as your first commit. Push to your private repo (`babylontoolkit/app-builder`).

## Step 2 — Install dependencies & verify the baseline

Do this BEFORE any modifications, so you know the unmodified fork runs — every later breakage is then diagnosable as "our change," never "was it ever working?"

**bolt.diy uses pnpm, not npm.** Requirements: Node.js 20+ (LTS).

```bash
cd <your-fork-folder>
npm install -g pnpm      # once, if you don't have pnpm
pnpm install             # installs all dependencies
pnpm run dev             # starts the dev server
```

Open http://localhost:5173 and confirm the stock bolt.diy UI loads. (If the WebContainer preview misbehaves locally in regular Chrome, try Firefox or Chrome Canary — a stale dev-mode quirk; deployed builds are unaffected.) Stop the server; baseline verified.

## Step 3 — Open Claude Code in the fork

```bash
claude
```
Claude Code auto-reads CLAUDE.md, which directs it to SPEC.md. It now has the whole plan.

## Step 4 — Build in STAGES (not phases)

**Critical distinction:** SPEC §9's *phases* are LAUNCH gates (when things must be live/legal). They are NOT a build order. Below are **build stages** — dependency-first construction order. **No stage waits on a key, account, or vendor.** Missing credentials degrade gracefully (SPEC §1.3 principle 0); you wire them in the Credential Pass (Step 5) whenever they arrive.

Run one stage per Claude Code session. Start each session by pasting the stage prompt. Test, commit, next stage.

### Stage 0 — Ground rules + the blocker
```
Re-read CLAUDE.md and SPEC.md completely — both changed substantially.

MODE: BUILD-FIRST (SPEC §1.3 principle 0). We build EVERY feature in EVERY phase. SPEC §9
phases are LAUNCH/GATING order, NOT construction order. No credentials exist yet (no
Anthropic key, no AWS, no Stripe, no Supabase, no license service) — EXPECTED, and never a
reason to skip, stub, or defer. Every external dependency reads from config and degrades
gracefully: clear "not configured" UI state + descriptive server error. Stop building ONLY
for (a) a hard technical blocker or (b) my explicit instruction.

PULL COMPATIBILITY IS MANDATORY (SPEC §2.1a): additive-first, hide-don't-delete (flags,
never removing upstream code), platform-as-provider. Extend the FilesStore and provider
layer — never rewrite them.

STAGE 0 TASK — the blocker: binary assets are dropped by the file layer (PNGs vanish; Vite
fails on "Failed to resolve import ../assets/babylon.png"). Implement SPEC §1.3 principle
10 across EVERY file path (template mount, git/folder import, WebContainer writes,
snapshots, restore, GitHub sync, share builds).
Verify: new project → src/assets PNGs present + public/babylon.png + public/spinner.png
present → pnpm dev boots with ZERO unresolved imports → snapshot → restore → PNG bytes
hash-identical.
```

### Stage 1 — The brain (agent + knowledge)
```
Continue per CLAUDE.md/SPEC.md (build-first; no credentials needed).
Build: §4.3 doc-sync (fetch Agent Reference + sub-docs + Component Reference on-demand
blocks + declaration files; versioned prompt_versions; admin refresh + rollback; zero
runtime GitHub dependency) → §4.2 server agent proxy (platform-as-provider entry; tool
loop; self-healing repair turns; usage recording) with the ANTHROPIC key read from config
("not configured" state when absent) → §4.11 skills sync + /slash invocation with
autocomplete.
Also: §4.2a Anthropic provider hardening — current model IDs (claude-sonnet-5 default,
haiku-4-5 at 64k output, opus-4-8, fable-5), @ai-sdk/anthropic ^1.2.12, stripSamplingParams
+ dropOrphanReasoningSignatures, capabilities.ts OUTSIDE .server, anthropic.spec.ts tests.
Model comes from the DEFAULT_MODEL constant (app/utils/constants.ts) — never a UI choice.
Dev path: PRO_FEATURES_ENABLED=true + my own key in .env.local. Verify: /bt-spec <task> loads
the skill and produces its workflow output.
```

### Stage 2 — Project creation (the Toolkit core)
```
Continue per CLAUDE.md/SPEC.md.
Build: §4.4 game_registry (source_class, scene_url, match_keywords) + template snapshot
pipeline (submodules vendored, setup hygiene: remote origin removed, .gitignore, public
PNGs, vite/tsconfig/eslint config, StrictMode removed) → §4.4a new-project routing (typed
prompt SEEDS a registry entry and RUNS IMMEDIATELY — the wizard NEVER interrupts it; card
path; guided-tour path) → §4.4b copy-from-source scaffolding (copy classes/<SourceClass>
into src/scripts/<ProjectClassName>, rename class + RegisterClass; babylon/classes +
babylon/system + app.tsx + routing are READ-ONLY) → §4.4c landing page TOTAL rewrite
(no starter content, no attribution) + play contract + bundle-integrity rule.
Verify: type "make me a kart racer" → project seeded from Racing → landing page themed →
Play launches the project's own GameMode.
```

### Stage 3 — Users, persistence, money
```
Continue per CLAUDE.md/SPEC.md.
Build: §4.5 auth/profiles/projects/snapshots (Supabase config-driven; storage layer with
S3 adapter AND local-filesystem fallback when S3_* unset) → §4.12 stop / checkpoint restore
/ retry / attachments → §4.6 credit ledger + Stripe checkout + BILLING_ENFORCED flag +
§4.6.1 license-service client (licenser.asmx ValidateSubscription; returns inactive when
unreachable) + Pro-gated BYOK.
CRITICAL: PRO_FEATURES_ENABLED defaults to FALSE — credits-only, Lovable-style. With it false,
the provider picker / model selector / API-key fields DO NOT RENDER for anyone; every generation
uses DEFAULT_MODEL (app/utils/constants.ts). Only PRO_FEATURES_ENABLED=true reveals Pro/BYOK UI (then gated
per-user by the license service).
Verify: default config = credits UI only, no model names anywhere; flag on = BYOK panel appears.
```

### Stage 4 — The full product surface
```
Continue per CLAUDE.md/SPEC.md.
Build: §4.7 guided tour wizard (spec/wizard-config.md catalog) → §4.8 share / /play builds /
gallery / remix + self-remix → §4.9 assets tab (hosted scenes by URL, prefabs, user uploads,
asset introspection) → §4.14 project .mcp.json (parse, launch stdio servers in the
WebContainer, tool bridge) → §4.15 game backends (user-owned Supabase, RLS-first) →
§4.13 GitHub sync — ALL USERS, never gated (link/push/pull/divergence) → §4.10 admin.
```

### Stage 5 — Identity + hardening
```
Continue per CLAUDE.md/SPEC.md.
Build: §2.5 brand module (app/config/brand.ts + app/assets/brand/ + APP_URL/PLAY_URL) +
CI grep-gate → §2.3 complete UI debrand (no bolt.diy marks anywhere user-facing) → §5
security pass (server-only secrets, ownership checks on every project route, shell
allow-list, moderation/report) → §5A ops (error tracking, analytics events, health check).
Then: full self-audit against SPEC §4.1–§4.15 — list anything missing or diverging, fix it,
and update SPEC.md where reality won.
```

## Step 5 — The Credential Pass (whenever keys arrive)

Per SPEC §9a: pure configuration, zero new features. Set each value, restart, verify the
previously-degraded path now completes:

| Set | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | Credits-mode generation |
| Supabase `SUPABASE_*` | Hosted auth/persistence |
| AWS `S3_*` + IAM | Snapshots/builds on S3 (was local-fs) |
| `STRIPE_*` (test → live) | Credit purchases |
| License service live | Real Pro entitlements (set `PRO_FEATURES_ENABLED=true` when you want to offer Pro at all) |
| StackBlitz plan | LEGAL to serve external users (§6) |

## Parallel workstreams (not build blockers)

- **You:** Anthropic Console org + API key + spend caps (SPEC Appendix A.1) —
  needed when the agent proxy lands. Build `ValidateSubscription` in the license
  service (open question #12). Audit skills repo descriptions (open question #9).
  Author wizard-backing skills per **SKILLS_BACKLOG.md** (leaderboards, pickups,
  checkpoints, interaction-prompts, grab-and-throw first) — unblocked today.
- **Management:** email StackBlitz for commercial license terms NOW (SPEC
  Appendix A.2) — required before the FIRST EXTERNAL USER, not before building.

## Launch gates (never pass one unmet)

| Before… | Must have… |
|---|---|
| Generating with platform credits (not dev BYOK) | Anthropic key + spend caps |
| Staging deploy | Supabase, Stripe test mode, email provider, error tracking — deploy per **DEPLOY.md** |
| **First external user** | **StackBlitz paid plan + written terms; Stripe live; ToS/Privacy; play-domain isolation** |
| Scale | StackBlitz negotiated license OR E2B swap |
