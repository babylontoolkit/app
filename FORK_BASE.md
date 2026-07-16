# FORK_BASE.md — Upstream Fork Record

| Field | Value |
|---|---|
| Upstream repo | https://github.com/stackblitz-labs/bolt.diy |
| Upstream license | MIT (retained; see LICENSE) |
| Forked at commit | `<FILL IN: git rev-parse HEAD of upstream at fork time>` |
| Fork date | `<FILL IN>` |
| Fork repo | github.com/babylontoolkit/app-builder (private) |

## Upstream pull log

| Date | Upstream commit pulled to | Notes / conflicts |
|---|---|---|
| — | — | — |

## Pull policy

Per SPEC §2.1/§2.1a: **indefinite pull compatibility** — monthly pulls (and before each phase gate), CI green post-merge, every pull logged above. No divergence cutoff is planned; if one is ever forced, record date, final upstream commit, and reason here with a SPEC change in the same PR.

## Major intentional divergences (keep this list honest — it is the merge map)

- System prompt pipeline replaced (SPEC §4.3)
- Project creation: templates-only (SPEC §4.4)
- Persistence: Supabase hosted layer replaces local-first storage (SPEC §4.5)
- LLM calls moved server-side behind agent proxy + credit gate (SPEC §3, §4.2)
- Provider picker demoted to Settings › Advanced / BYOK (SPEC §2.3)
- Skills runtime added (SPEC §4.11)
- Branding/UX pass (SPEC §2.3, §4.1)
- **Binary files are first-class (SPEC §1.3 principle 10, §4.4)** — see divergence map below

## Divergence map — binary-file support (merge hotspot: file layer)

Upstream's file layer is text-oriented and destroys binary bytes at ingest. Per §2.1a this is
implemented as an ADDITIVE module hooked into existing seams; upstream's `FileMap`/`File` types
and control flow are extended, never restructured.

**New (all net-new files — zero merge surface):**
- `app/lib/binary/binary-files.ts` — codec, binary detection, snapshot (de)serialization, deploy wire format
- `app/lib/binary/binary-files.spec.ts` — regression suite (byte-identity round-trips)

**Contract:** binary BYTES live in the WebContainer FS (the source of truth for a session).
`File` carries `isBinary` + `size` and an EMPTY `content` — so binary content can never reach the
editor's text map or LLM context. Egress paths read real bytes back on demand; snapshots/deploys
carry them base64-encoded as a wire format only.

**Upstream files touched (each a small, localized hook — keep them small on merge):**

| File | Change |
|---|---|
| `app/lib/stores/files.ts` | watcher uses `fileEntryFromBuffer` (was: `content = ''` for binaries); added `readBinaryFile` / `serializeFiles` / `restoreFiles`; `File.size` |
| `app/lib/stores/workbench.ts` | ZIP export, folder sync, GitHub + GitLab push read real bytes (were: skipped binaries) |
| `app/lib/persistence/{types,useChatHistory}.ts` | `Snapshot.files` is a `SerializedFileMap`; restore writes bytes (was: wrote 0-byte files); binaries excluded from the replay artifact |
| `app/lib/.server/llm/{constants,utils}.ts` | binaries emitted to the model as a `<boltFile binary size>` marker, never as an empty `boltAction` |
| `app/routes/api.github-template.ts` | zip/Contents extraction keeps binaries as base64; size cap no longer drops assets; release→branch zipball fallback; placeholder-token guard; gitlink vendoring (no-op for our starter, which vendors `src/babylon` directly) |
| `app/utils/selectStarterTemplate.ts` | template binaries written to the container as bytes, out-of-band of the artifact; copies `babylon.png`/`spinner.png` into `public/` |
| `app/utils/{folderImport,fileUtils}.ts` | folder import writes binaries as bytes (was: dropped, "Skipping N binary files") |
| `app/components/git/GitUrlImport.client.tsx` | binaries excluded from the artifact so the clone's correct bytes are not overwritten by a mangled UTF-8 copy |
| `app/components/deploy/*`, `app/routes/api.{netlify,vercel}-deploy.ts` | build output read as bytes; binaries uploaded base64 (were: `readFile(…, 'utf-8')` → U+FFFD corruption) |

## Divergence map — context budget (merge hotspot: LLM context assembly)

Upstream inlines every text file into the model's context and inlines the template into the creation
artifact as well. Per SPEC §4.2.8 / `spec/context-budget.md` we send each file AT MOST ONCE, and never
send files no correct edit exists for. Implemented additively: a net-new classifier + two small hooks.

**New (net-new files — zero merge surface):**
- `app/lib/context/opaque-files.ts` — the classifier: generated / vendored / image-ish text
- `app/lib/context/opaque-files.spec.ts` — guards BOTH directions (hidden stays hidden; readable stays readable)
- `app/lib/.server/llm/history.ts` — conversation-history compaction (strip stale `<boltAction type="file|edit">` bodies, −85%) + windowing (a char cap `MAX_HISTORY_CHARS` and an env-tunable turn cap `HISTORY_WINDOW_TURNS`, default 30, `0` disables); called from `proxy.ts` before `convertToCoreMessages`. Deliberately NO summary model call — see `spec/context-budget.md` §5. Replaces upstream's dead-path `createSummary`/last-3-slice (only ever reachable from the fail-closed `/api/chat`). `app/lib/.server/llm/history.spec.ts` pins both directions (strips bodies; keeps tags, the first brief, and the current turn).

**Contract:** a file is in the project OR in the conversation, never in the conversation twice. The
WebContainer FS is how files reach the project; the artifact is a message to the model. Opaque and
binary files are declared as `<boltFile>` markers (path + size), never as bodies.

| File | Change |
|---|---|
| `app/lib/.server/llm/utils.ts` | `createFilesContext` emits a `<boltFile opaque>` marker for opaque files (was: full body). One `if`, mirroring the existing `isBinary` branch. |
| `app/lib/.server/agent/proxy.ts` | file-context system block carries a cache breakpoint; cache TTL is `1h` (was: the 5-minute default, which expires while the user plays the game we just built — so every turn re-wrote the whole prefix at full price) |
| `app/lib/stores/files.ts` | watcher no longer excludes `**/package-lock.json`. Upstream treated the file map as a view for the model; it is the SOURCE for every egress path (ZIP, GitHub sync, snapshot, share build), so the exclusion silently shipped user projects with no lockfile. Keeping it from the model is done at the context boundary instead. |
| `app/components/chat/Chat.client.tsx` | posts `stripOpaqueContent(files)` rather than the raw map — opaque bodies (218KB lockfile, vendor shims) are freight on every turn, since the model only ever receives a marker for them |

## Divergence map — Stage 3: identity, persistence, money (merge hotspot: none — almost entirely additive)

bolt.diy ships **no** user system (local, single-user, browser-persisted). This whole layer is net-new,
so the merge surface is close to zero: eight new server modules and a handful of new routes. Only three
upstream files were touched, each with a small localized hook.

**New (net-new — zero merge surface):**
- `app/lib/.server/env.ts` — the single door to server config. ⚠️ Platform secrets are NEVER `VITE_`-prefixed (Vite inlines those into the client bundle; the Supabase service-role key bypasses RLS).
- `app/lib/.server/supabase/` — request client (RLS in force) + admin client (bypasses RLS; three privileged jobs only), auth, the two-wall rule
- `app/lib/.server/projects/` — projects, snapshots (byte-faithful via `SerializedFileMap`), `requireOwnedProject`
- `app/lib/.server/billing/` — rate table, append-only ledger, gate + settlement + auto-refund, Stripe
- `app/lib/.server/licensing/` — ASMX `ValidateSubscription` client, entitlements, the 72h grace window, `resolveByok`
- `app/lib/.server/storage/` — `ObjectStore` interface, S3 adapter, local-FS fallback
- `app/lib/.server/http.ts` — uniform error responses (404-not-403 for ownership)
- `app/lib/stores/session.ts`, `app/lib/hooks/useSession.ts` — the client's view of who it is
- `app/components/auth/`, `app/components/chat/CreditsIndicator.client.tsx`
- `supabase/migrations/0001_stage3_*.sql` — schema, RLS, and `append_ledger_entry` (the atomic writer)
- Routes: `api.auth`, `api.me`, `api.credits`, `api.checkout`, `api.stripe-webhook`, `api.entitlement`, `api.projects*`, `auth.callback`

**Contract:** the platform Supabase (accounts, projects, ledger) is a DIFFERENT Supabase from upstream's
Game Backends connector (§4.15), which is the USER's own project and whose `VITE_SUPABASE_*` values are
public by design. Do not merge the two.

| File | Change |
|---|---|
| `app/lib/.server/agent/proxy.ts` | Takes an `AuthUser` (never a client-supplied id — the ledger is keyed on it); resolves BYOK server-side from a verified entitlement; runs the credit gate before the first token; settles against REAL usage in `finally` (so Stop and crashes settle too); auto-refunds hard failures; threads an `AbortSignal` for Stop (§4.12). |
| `app/routes/api.agent.ts` | The two walls before any token is spent: `requireVerifiedUser` + `requireOwnedProject`. Passes `request.signal` so a closed stream aborts the provider call. Emits a `credits` annotation carrying the settled charge. |
| `app/components/chat/ChatBox.tsx` | Provider picker / model selector / API-key field are **Pro-gated** (§4.6.1) — and so is the collapsed Model Settings toggle, which *renders the model name*. In the shipping default all of it is absent from the DOM. |
| `app/components/@settings/core/ControlPanel.tsx` | The `cloud-providers` / `local-providers` tabs are the same machinery behind a different door — filtered out unless BYOK is unlocked. |
| `app/components/header/Header.tsx` | Credits indicator + account menu. |
| `app/components/chat/Chat.client.tsx` | Applies the settled balance from the `credits` annotation (server's number, not a local subtraction — which would drift on the first stop or repair). |
| `app/routes/api.chat.ts`, `app/routes/api.llmcall.ts` | **Fail closed** (404) unless `UPSTREAM_LLM_ROUTES_ENABLED`. Both resolve a provider from the request body and read the key from the server env, with no session check, no credit gate, and no ledger entry — on a deployed instance either one is an unauthenticated, unattributable bill on the platform key, routing around the `/api/agent` choke point. Guard is a 4-line early return calling `upstreamLlmRouteDisabled()`; the upstream bodies are untouched, so pulls still merge. |
| `app/routes/api.enhancer.ts` | Brought onto the money path: `requireVerifiedUser` → server-resolved BYOK → credit gate → settlement against real usage. Previously anonymous and unmetered on the platform key, and it took its **model from the request body** (upstream's `[Model: …]` prefix), so a caller could pick the most expensive model on the market and bill it to us. The model is now the platform's choice for everyone; input is length-capped. |
| `app/routes/api.export-api-keys.ts` | 🔴 **Critical secret leak, rewritten.** Upstream's loader was an **unauthenticated GET** that read every provider's key from `process.env` / the CF env / `llmManager.env` and returned the values as JSON — `curl /api/export-api-keys` → `{"Anthropic":"sk-ant-..."}`. Worse than an unmetered endpoint: a leaked key works off-platform forever. Now requires a verified user and returns ONLY the caller's own cookie-supplied BYOK keys; the server environment is never read. Pinned by `upstream-routes.spec.ts`. |
| `app/entry.server.tsx` | Calls `assertNotLocalInProduction()` at **module scope**. Local mode treats every caller as a verified admin and engages purely from a missing `SUPABASE_URL`; a per-request check let the process boot healthy, pass its health check, and serve every route that never calls `getUser`. Two lines, additive. |

## Upstream files touched — Stage 4 (full product surface, SPEC §4.8–§4.15)

| File | Change |
|---|---|
| `app/routes/api.mcp-update-config.ts`, `app/routes/api.mcp-check.ts` | 🔴 **Critical RCE, fail-closed.** Upstream's `MCPService` spawns a child process per stdio server (`Experimental_StdioMCPTransport`), and the config arrives from an **unauthenticated** POST — `curl /api/mcp-update-config -d '{"mcpServers":{"x":{"command":"sh",...}}}'` ran arbitrary commands on the platform box. Each route now opens with a 4-line early return calling `serverSideMcpDisabled()` (404 unless `SERVER_SIDE_MCP_ENABLED`); the upstream bodies and `MCPService` are byte-untouched, so pulls still merge. MCP execution belongs in the user's WebContainer (§4.14). Pinned by `upstream-routes.spec.ts`. |
| `app/routes/api.agent.ts` | Additive: threads `gameBackend` (through the §4.15 hard-separation `sanitizeGameBackend`) and `assetNotes` from the request body into the generation. The client already sent the Supabase connection; the server was dropping it. |
| `app/lib/.server/agent/proxy.ts` | Additive: injects the volatile project-context notes (§4.9/§4.14/§4.15) into the system array AFTER the cached prefix, and adds `gameBackend`/`assetNotes`/`mcpLiveTools` to `AgentRequest`. No change to the cache-breakpoint ordering. |
| `app/components/header/HeaderActionButtons.client.tsx` | Additive: renders `<ShareButton />` (§4.8) and `<GitHubSyncButton />` (§4.13) alongside the inherited `<DeployButton />`. (Stage 5: the inherited "Report Bug" bolt.diy link was debranded — see the Stage 5 map below.) |
| `app/components/chat/Chat.client.tsx` | Additive: forwards `gameBackend` (§4.15) and `mcpTools` (§4.14) in the `/api/agent` body, and runs `syncMcpBridge()` on project change to launch the WebContainer MCP servers. The upstream `supabase` body block is left in place for pull compatibility. |
| `app/lib/persistence/useChatHistory.ts` | Additive: the no-`mixedId` (fresh builder) branch now adopts a pending remix (`takePendingRemix()`), mounting the cloned project through the same server-checkpoint path a resume uses (§4.8). |
| `app/components/@settings/core/{types.ts,constants.tsx}`, `ControlPanel.tsx` | Additive: registered the **Assets** (§4.9) and **Admin** (§4.10) tabs, and relabelled the `supabase` tab to "Game Backend" (§4.15 — id kept for merge safety, label/description/icon changed). |
| `app/components/chat/SupabaseConnection.tsx` | One label change: "Connect to Supabase" → "Connect a Game Backend" (§4.15). |

## Upstream files touched — Stage 5 (identity + hardening, SPEC §2.3/§2.5/§4.4)

**Template pin-and-cache (SPEC §4.4 — the divergence is now CLOSED; new projects mount a pinned snapshot, not live `main`):**

| File | Change |
|---|---|
| `app/routes/api.github-template.ts` | **Reduced to a loader.** All fetching moved to `app/lib/.server/templates/fetch.ts` (verbatim, plus an explicit commit SHA on every call) because promotion and bootstrap need the same fetch; the decision of WHAT to serve moved to `templates/pin.ts` (`decideTemplateSource`). Behaviourally: the mount is now the **pinned snapshot** — no GitHub call once pinned — falling through to live only to bootstrap the first pin, or when a pin's object is missing. Keeps the last-known-good net (`?fallback=1` deliberately outranks the pin — it is the only signal a structurally-valid template is broken at RUNTIME). `X-Template-Source: pinned \| live \| last-known-good` + `X-Template-Sha`. **This is a big diff against upstream** — the upstream file was already ~90% ours (binary base64 handling, size caps, gitlink vendoring, token guard), so the extraction moves our code, not theirs; a future upstream pull touching this route should be replayed onto `templates/fetch.ts`. |
| *(new)* `app/lib/.server/templates/{pin,fetch,config}.ts`, `api.admin.template.ts` | Additive — pin/snapshot storage + the pure decision core, the shared fetch, `TEMPLATE_PINNING_ENABLED` (default ON), and the admin promote/rollback route (session-`requireAdmin`). No upstream file involved. |
| ~~⚠️ Release-lock footgun~~ | **Gone.** `resolveTemplateRef` resolves the default branch deliberately and never consults `releases/latest`. Publishing a Release on AppTemplate no longer changes what new projects mount; only a promotion does. |

**Debrand (SPEC §2.3 — route user-facing marks through `app/config/brand.ts`; §2.5 rule 1):** all additive, one string/URL each — no structural change, pull-safe.

| File | Change |
|---|---|
| `app/routes/_index.tsx`, `app/routes/git.tsx` | Page `meta` `title:'Bolt'` / "AI assistant from StackBlitz" → `brand.productName` / `brand.metaDescription`. |
| `app/components/chat/BaseChat.tsx` | Empty-state `#intro` heading + subheading → `brand.intro.*`. |
| `app/components/chat/ExamplePrompts.tsx` | Generic web-dev examples (incl. "app about bolt.diy") → game-themed prompts (§2.3 removes non-game examples). |
| `app/components/@settings/core/AvatarDropdown.tsx`, `app/components/header/HeaderActionButtons.client.tsx`, `app/components/sidebar/Menu.client.tsx` | bolt.diy Help/Docs + "Report Bug" links → `brand.urls.docs` / `mailto:brand.support.email`. |
| `app/components/@settings/tabs/event-logs/EventLogsTab.tsx` | PDF export subtitle/footer "bolt.diy — AI Development Platform" / "Generated by bolt.diy" → `brand.*`. |
| `app/components/deploy/GitHubDeploymentDialog.tsx`, `app/lib/services/gitlabApiService.ts` | Git/GitLab commit messages "…from Bolt.diy" → `…from ${brand.productName}` (they land in the user's repo history). |
| `app/lib/.server/github/sync-logic.ts` | Default sync commit message hardcoded the product name → `brand.productName` (caught by the brand gate). |
| `app/routes/api.system.git-info.ts` | `repoName` fallback `'bolt.diy'` → `'app-builder'` (build metadata; only shown if the injected constant is missing). |
| `.github/workflows/quality.yaml`, `.husky/pre-commit`, `package.json` | Wire the brand grep-gate (`pnpm check:brand` → `scripts/check-brand.mjs`, SPEC §2.5 rule 4) into CI and the pre-commit hook. |

**Visual debrand — OG/social/PWA meta + bare-"Bolt" copy (SPEC §2.3, 2026-07-14):** all additive/one-string; the visual logo/favicon assets were already Babylon-branded (no change needed). The dotted-mark brand gate does NOT catch bare "Bolt" (too many false positives: `BoltShell`, `bolt-terminal`), so these were a manual sweep.

| File | Change |
|---|---|
| `app/root.tsx` | Added brand-driven Open Graph / Twitter / `theme-color` meta + `apple-touch-icon` + `manifest` links in `<Head>`/`links` (none existed); `favicon` href → `brand.assets.favicon`. |
| `app/routes/manifest[.]webmanifest.ts` | **New route** — PWA manifest served from code (not a static `public/manifest.json`) so name/description come from `brand` (rule: nothing brand-shaped hardcoded in a manifest). |
| `app/components/chat/ChatBox.tsx`, `app/components/chat/ChatAlert.tsx`, `app/components/deploy/DeployAlert.tsx` | Bare "Bolt" in the chat placeholder, error copy, and "Ask Bolt" buttons → `brand.productName`. |
| `app/components/@settings/tabs/providers/local/SetupGuide.tsx` | "To work with Bolt DIY…" (LM Studio CORS guide) → `brand.productName`. |
| `app/components/@settings/tabs/event-logs/EventLogsTab.tsx` | Download filenames `bolt-event-logs-*` → `${brand.productSlug}-event-logs-*`. |
| `app/routes/api.netlify-deploy.ts`, `app/routes/api.vercel-deploy.ts`, `app/components/chat/NetlifyDeploymentLink.client.tsx`, `app/components/chat/VercelDeploymentLink.client.tsx` | Deploy site/project name prefix `bolt-diy-…` (visible in the deploy subdomain) → `${brand.productSlug}-…`; creator and link-matcher changed together so they still match. |
| `app/components/deploy/GitHubDeploy.client.tsx`, `app/components/deploy/GitLabDeploy.client.tsx` | Repo-name fallback `'bolt-project'` → `${brand.productSlug}-project`. |

New brand field: `brand.productSlug` (`babylon-toolkit`) — filesystem/URL-safe slug for filenames + deploy names (never a display string).

Not touched (deliberately): HTTP `User-Agent: 'bolt.diy-app'` identifiers (functional, not rendered); `Copyright (c) StackBlitz` source headers (MIT REQUIRES retention); the dead/hidden upstream paths (`new-prompt`/`discuss-prompt`, `api.updates`, `webcontainer.connect`, `api.bug-report`) — allow-listed in the brand gate with reasons.

## Upstream files touched — Stage 2 (project creation, SPEC §4.4)

| File | Change |
|---|---|
| `app/components/chat/Chat.client.tsx` | New Project routing (§4.4a): `selectStarterTemplate` (an LLM round-trip to pick a template) replaced by registry keyword seeding; `startProject()` is the single creation path for all three entry paths. Upstream's blank/import paths remain. |
| `app/components/chat/BaseChat.tsx` | `StarterTemplates` → `GameRegistryCards`; added the seed chip and the vague-prompt offer. Six additive optional props. |
| `app/lib/runtime/action-runner.ts` | `#runStartAction` now passes through the shell allow-list. It executes on the same shell as `#runShellAction`, so gating only `type="shell"` left the §4.2.5 allow-list bypassable by relabelling the action. |
| `app/types/template.ts` | Added the shared `TemplateFile` type (was duplicated in two modules). |

## Other upstream files touched

| File | Change |
|---|---|
| `uno.config.ts` | `presetIcons` collections: register `ph` + `svg-spinners` explicitly. Upstream relies on presetIcons' filesystem loader, which it installs only when `!process.env.VSCODE_CWD` (it assumes VS Code means the UnoCSS extension is the host). A dev server started from VS Code's integrated terminal inherits that var, so every `i-ph:*` / `i-svg-spinners:*` icon silently rendered blank. Loading the collections ourselves is launch-environment independent. Upstream-mergeable (additive keys). |
