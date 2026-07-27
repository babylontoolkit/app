# CodeSandbox Production Plan — multi-user, multi-project, credit-charged

> Quick Plan (bt-plan, 2026-07-27). No feature spec file; brief = the six-item production roadmap.
> Interview decisions locked in with the owner: **(a)** VM cost is baked into `CREDIT_MARGIN`/plans at
> launch (no per-user metering; build the reporting so metering can be added later), **(b)** max
> **2** concurrently RUNNING sandboxes per user (env-configurable; older ones hibernated), **(c)** the
> template rebuild is done end-to-end inside this plan (agent prepares + builds the alias; owner
> reviews and promotes).

## Codebase Analysis

Three read-only exploration passes (project record/lifecycle, billing/admin/health, client money-path
surfaces) plus two live driving sessions on the real provider ground this plan.

**Where per-project state goes.** The server `Project` type (`app/lib/.server/projects/types.ts`)
already has the exact precedent to mirror: `gameBackendRef` / `linkedUnityProjectId` — a single
nullable pointer, never exposed on the client wire type (`app/types/project.ts` is deliberately a
subset). The FS store persists new fields for free; the Supabase store needs BOTH hand-maintained
maps updated (`rowToProject` ~L186 and `projectToRow` ~L215 in
`app/lib/.server/projects/store.ts`) — missing either half is a silent field drop. Migrations top out
at `0012`; `0011_unity_project_link.sql` (single `add column if not exists` + `comment on column`) is
the pattern to copy for `0013`.

**The sandbox server module is already mostly per-project-shaped.**
`createSandboxForProject(projectId, …)` in `app/lib/.server/sandbox/service.ts` already takes a
project id and tags the VM `project:${id}` — but `api.sandbox.session.ts` passes `user.id` into it,
so the tags lie today. `decideSandboxStart` (`lifecycle.ts`, pure + tested) already names its input
`recordedSandboxId` "recorded on the project" — **zero changes needed there**. `deleteSandbox`
exists with **zero callers**. The per-user registry (`registry.ts`) documents itself as a temporary
stopgap; with `sandbox_id` on the row it should be **deleted outright** (the row IS the registry,
with ownership + cascade for free), not re-keyed.

**The structural obstacle is client boot timing.** `app/lib/sandbox/index.ts` boots the sandbox at
module-evaluation time — before any projectId exists. The project id lands in the `projectId`
nanostore only during chat/project mount (`useChatHistory.ts` ~L1195). Per-project boot therefore
requires a **lazy/deferred boot** keyed by project, and the `getSession` reconnect closure must stay
pinned to the project it booted for (a naive atom read would reconnect a hibernated tab to whichever
project is current). The `previewUrls` cache in `codesandbox-boot.ts` is keyed by port only — project
B's iframe would get project A's token on a switch.

**Delete path.** `api.projects.$projectId.ts` DELETE sweeps seeds → messages (prefix) → working copy
→ row, bytes-first, pinned by `delete-leaves-nothing.spec.ts` ("leaves NOTHING in storage under that
project id"). Sandbox teardown slots immediately before `store.delete`; the spec needs a sandbox
case. The migration also **orphans every legacy per-user sandbox** (`sandboxes/{userId}.json` + the
VM it names) — exactly the "bytes outliving the record that named them" failure the delete path
exists to prevent, so the cutover needs a one-shot sweep.

**Billing.** `CREDIT_MARGIN` is one scalar (`rates.ts:401`, default 4.0); `packMargin()` +
`MIN_PACK_MARGIN` (2.0 floor) live in `stripe.ts:79-88` with the pack table at `:68-72`
($0.009–0.01/credit), tested at `billing.spec.ts:1149-1200`. Cost inputs are already pluralized in
`market-prices.ts` (`llm`, `media`, optional `search`) — a VM `$/hr` input follows the optional
`search` precedent. Ledger reasons are pinned in three lockstep places (union `ledger.ts:42`,
`mayGoNegative` `:143` + its spec mirror, SQL CHECK re-added per migration — `0010` is the copyable
shape) — **not needed at launch** (bake-into-margin decision) but the reporting is. The Admin usage
route already joins a second data source (`providerBalance`) — the VM-hours report joins the same
way; `usage-report.ts` is pure and its sibling should be too. Per-user VM-hours needs persisted
lifecycle marks (create/resume/hibernate timestamps); none exist today.

**Health/monitoring.** `buildHealthReport` is config-presence-only BY CONTRACT (never a live network
call — a "reachable" probe there would make a CSB outage flip the uptime monitor and cause retry
storms); `codesandbox: isSandboxConfigured(…)` is a one-liner + `health.spec.ts` update.
`sharedRateWindow(name)` (`failure-rate.ts:100`) is already a generalized named registry;
`paid-path-rates.ts` is the emission pattern to copy (**record every attempt, not just failures** —
`proxy.ts:1701` warns a failures-only window reads 100%). `app/lib/.server/sandbox/*` imports no
monitoring at all today. A `CLEAN` resume (snapshot archived) is a distinct data-loss-adjacent
signal worth its own window.

**Review fold-in (2026-07-27):** a full three-track code review of the sandbox surface
(`spec/sandbox-codesandbox.md` §11 — server key-holder, client provider, integration touchpoints;
every finding verified against source) was folded into this plan. The per-project migration
(T1–T3) subsumes the review's one CRITICAL (per-user VM + warm-boot gate = cross-project file
adoption); the rest lands as hardening inside T2/T3/T4/T7/T8/T9 and four added tasks (T7b, T9b,
T9c, plus T17 scenario 9). T18's acceptance now requires every §11 finding to be dispositioned.

**Latent defects the analysis surfaced (now tasks, not footnotes):**
1. **`resolveInWorkdir` double-prefixes workdir-absolute paths** (`codesandbox-translate.ts:50`):
   `/project/workspace/dist` → `/project/workspace/project/workspace/dist`. Consequence: the build-dir
   probe in `action-runner.ts:634-651` is dead code on this provider, and publish only works because
   `useShareGame.ts:112`'s fallback list happens to contain `'/dist'`. A project with a custom
   `outDir` publishes nothing. The `'/home/project'` literal at that line (and in
   `VercelDeploy.client.tsx:87,162-184` / `NetlifyDeploy.client.tsx:88`) is a no-op under CodeSandbox.
2. **Preview tokens expire after 60 min with ZERO handling** (`Preview.tsx` has no `onError`, and a
   cross-origin 401 page still fires `onLoad`, clearing stale-preview alerts; `reloadPreview` reuses
   the expired token). After an hour the preview shows CodeSandbox's 401 page and only a full page
   reload fixes it.
3. **A repo restore can delete `.codesandbox/tasks.json` off the VM**: `.codesandbox/` is in the file
   map (surfaced by `refreshFiles`), the repo has no such path, so `planRestore` +
   `protectForRepoRestore` plans it for deletion — and the template NEEDS `tasks.json` (measured:
   build times out waiting for the port without it). Excluding the directory at the map layer
   (watcher + refresh excludes in `files.ts:652,776`) fixes context, ZIP, working copy, push, and the
   delete hazard in one move. Push filtering must NOT overload `isSecretPath` (it doubles as
   `protectForRepoRestore` semantics).
4. **The wake path races**: `startDevServer` is gated on `previews.length`, which `replayOpenPorts`
   fills asynchronously — a resumed VM with a dead dev server can pass "already serving" and land the
   user on a dead preview with no signal.

**Template pin.** `templates/pin.ts` + `api.admin.template.ts` + the AdminTab "Starter template"
section are the exact shape to mirror for the CSB alias: pure `decide…Source`, validate-before-
re-point, immutable history, rollback only onto recorded targets. Difference: CodeSandbox holds the
immutable snapshot, so our store keeps only the pointer history; `sandboxTemplate()`
(`sandbox/config.ts:88`) must prefer a promoted pin over the env default.

**Media delivery is provider-neutral already** (`tasks.ts` → `createFile` → provider `fs.writeFile`,
`WORK_DIR`-derived). The KIE→server→browser→sandbox byte path could later become KIE→server→sandbox,
but that is out of scope here.

**SPEC.md alignment.** Conforms to: §4.5.3 (two walls — projectId + `requireOwnedProject`
everywhere; the client still never supplies a sandbox id), §5 (API key server-only; no server-side
execution of user code — the VM is the user's sandbox), §4.6/`spec/billing.md` (margin discipline,
pack floor re-asserted), §4.4 (pin-and-promote applied to the CSB template alias), §5A (monitoring
never throws), §8/`spec/sandbox-seam.md` (all vendor coupling stays in the provider modules; the
default-deny seam scans must stay green). **`spec_impact: yes` (inferred)** — this changes the
sandbox architecture, adds a cost input, a config surface, and deploy wiring; the final task writes
SPEC.md + `spec/sandbox-codesandbox.md` back to match.

---

## Tasks

### Phase A — per-project sandboxes (the architectural blocker)

- [ ] **T1** — `sandbox_id` on the project record (migration + both stores)
  - Files: `supabase/migrations/0013_project_sandbox.sql`, `app/lib/.server/projects/types.ts`, `app/lib/.server/projects/store.ts`, `app/lib/.server/projects/store.spec.ts` (or nearest store spec)
  - Details: Add `sandboxId?: string` to the server `Project` type as a plain pointer mirroring `linkedUnityProjectId` (doc comment says pointer-not-credential, client never sees it — do NOT add it to `app/types/project.ts`). Migration copies `0011`'s single-column shape (`alter table … add column if not exists sandbox_id text;` + `comment on column`). Supabase store: add BOTH halves — `rowToProject` (`sandbox_id → sandboxId`) and `projectToRow`'s map (`sandboxId: 'sandbox_id'`). FS store needs no field work (round-trips whole object); do not add a default in `withProjectDefaults` (undefined is correct).
  - Acceptance: migration runs clean in the PGlite harness (`ledger-sql.spec.ts` machinery); a store round-trip test proves `sandboxId` survives create→update→get in BOTH store modes (the Supabase half via the row-mapping unit); the client `Project` type still has no `sandboxId`.

- [ ] **T2** — Per-project sandbox routes; delete the per-user registry
  - Files: `app/routes/api.sandbox.session.ts`, `app/routes/api.sandbox.preview.ts`, `app/lib/.server/sandbox/registry.ts` (DELETE), `app/lib/.server/sandbox/service.ts`, route specs
  - Details: `POST /api/sandbox/session` body becomes `{ projectId, reset? }`; resolve via `requireOwnedProject` (404-not-403), read `project.sandboxId`, run the UNCHANGED `decideSandboxStart`, on create call `createSandboxForProject(project.id, …)` (fixing the user-id-where-project-id-belongs lie — the `project:${id}` tags become truthful) and persist via `store.update(project.id, { sandboxId })`. `GET /api/sandbox/preview` gains a `projectId` query param + the same ownership wall. Delete `registry.ts` outright — the project row is the registry; grep for all importers. Keep the header-comment invariant intact and state it: the client supplies a PROJECT id it must own, never a sandbox id. **Review hardening (§11 M1–M3), each a silent money/lockout failure without it:**
    - **The create race survives the registry deletion** — two tabs both read `sandboxId` unset, both fork, last `store.update` wins, the loser VM is orphaned with a live write session pointed at it. Persist with compare-and-set semantics: after creating, re-read the row; if a DIFFERENT sandboxId already won, treat that one as canonical and `deleteSandbox` the just-created loser (best-effort, monitored).
    - **`reset` must DISPOSE the old VM** (`deleteSandbox`, best-effort + monitored) — today it orphans a billing VM holding the user's files. And creates need a **per-user rate limit** (`sharedRateWindow`-style): 20 forks/hr is the whole platform's provider budget, so an unbounded `{reset:true}` loop is a platform-wide outage lever. A refused create is a described 429, never a silent stall.
    - **The resume→create fallback `lifecycle.ts`'s comment promises must actually exist**: a resume failure that classifies as gone falls through to create ONCE and records the new id (today it is a generic 500, and a deleted VM bricks the project into a permanent 503). Gone-classification must prefer typed SDK errors/status codes over the current message regex (keep the regex as last-resort fallback).
  - Acceptance: route specs pin — someone else's projectId → 404 with zero provider calls; missing projectId → 400; create path records `sandboxId` on the row; resume path uses the recorded id; `registry.ts` and `sandboxRecordKey` no longer exist anywhere (source grep in a spec, with a control). **Plus:** concurrent creates converge on ONE recorded sandboxId and the loser is disposed (mutation: dropping the dispose fails it); reset disposes the previous VM; resume-of-a-deleted-sandbox falls back to create and records the new id; both routes join `outbound-auth.spec.ts` (unauthenticated → 401 with ZERO provider calls — today they pass the enumerate scan on source alone, which its own doc warns is not a behavioral pin).

- [ ] **T3** — Project-aware client boot (lazy, pinned, cache-keyed)
  - Files: `app/lib/sandbox/index.ts`, `app/lib/sandbox/codesandbox-boot.ts`, `app/lib/persistence/useChatHistory.ts`, `app/lib/sandbox/codesandbox-provider.spec.ts` + a boot spec
  - Details: The module-scope eager boot cannot know a project. Replace with a lazy entry — `sandbox` stays a Promise for consumers (stores capture it in constructors; keep that contract) but resolution is DEFERRED until the mount path supplies a projectId (e.g. `bootForProject(projectId)` called from `doMountProjectFiles`/creation, resolving the shared deferred). Rules, each a silent failure if missed: **(a)** `requestSession` and the `getSession` reconnect closure carry the projectId they were BOOTED with (captured, not read from the atom — a hibernated tab must reconnect to its own project); **(b)** `mintPreviewUrl` passes projectId and the `previewUrls` cache is keyed `(projectId, port)` or cleared on project switch; **(c)** WebContainer branch is unaffected (its boot needs no project); **(d)** the HMR `import.meta.hot.data` caching keeps one identity. Project switch within one page (dashboard → open) re-runs boot for the new project; document that one tab = one active sandbox connection. **Review hardening (§11), each a silent failure today:**
    - **(e) A boot failure is currently cached FOREVER** in the module-level promise — the server's deliberate `retryable: true` 503 is read by nobody, and the only recovery is a full page reload. The deferred boot must keep failure retryable: surface a described state with a retry affordance, and a later `bootForProject` re-attempts instead of replaying the cached rejection.
    - **(f) A reconnect must never silently ADOPT a fresh sandbox.** `getSession` re-runs the decide flow; if it comes back `created: true`, the SDK would reconnect the live client to a DIFFERENT filesystem mid-session (files vanish, no signal). Fail that reconnect loudly (toast + reload affordance) instead.
    - **(g) `firstBootupType`/`bootRestoredFilesystem` become per-BOOT facts** (per project), not module-frozen — a CLEAN reconnect mid-page must not read as "disk restored" (data-loss direction: the next checkpoint captures template state as the project).
    - **(h) Identity sentinel, defense-in-depth for the warm-boot gate:** creation writes a marker (e.g. `.codesandbox/btk-project.json` with the projectId — inside the dir T9 excludes, so it never rides into context/pushes once T9 lands; if executed before T9 it briefly shows in the tree, harmless); the `liveSandboxIsTruth` gate reads it via provider `fs` (not the map) and stays CLOSED on mismatch. With per-project VMs it should never fire — which is exactly why it is cheap insurance against a mis-pointed `sandbox_id` (operator edit, restored old row) re-opening §11 C1's silent cross-project adoption.
  - Acceptance: unit specs pin — session request carries the booted projectId; reconnect after a simulated hibernate uses the ORIGINAL projectId even after the atom changes; preview mint for port P on project B never returns project A's cached token; a failed boot can be retried without a page reload (no permanently-cached rejection); a reconnect that would CREATE fails loudly instead of adopting; sentinel mismatch keeps the warm-boot gate closed with a described error. Live check: open project A, then project B from the dashboard in the same tab — B's files, B's preview, A untouched (the registry-era overwrite is gone).

- [ ] **T4** — Sandbox teardown on project delete + legacy orphan sweep
  - Files: `app/routes/api.projects.$projectId.ts`, `app/lib/.server/projects/delete-leaves-nothing.spec.ts`, `scripts/sweep-legacy-sandboxes.mjs` (one-shot)
  - Details: In the DELETE branch, before `store.delete`: `deleteSandbox(project.sandboxId, context)` when set (best-effort per its own contract, but LOGGED + monitored on failure — an orphan VM is a bill nobody sees). Extend the leaves-nothing spec with the sandbox case. One-shot sweep script (scratchpad-style, committed under `scripts/`): list provider sandboxes tagged `btk`, cross-reference project rows' `sandboxId` + legacy `sandboxes/{userId}.json` records, delete orphans + the legacy storage prefix; dry-run mode default, `--apply` to execute. **Also (§11 minor): the client provider's `teardown()` is currently the silent no-op its own comment claims it isn't** (`onTeardown` is never injected in `index.ts`'s composition) — either wire it or fix the lying comment; a false claim in a comment is how the shell-strip defect survived review.
  - Acceptance: leaves-nothing spec covers the sandbox (mutation-verified: removing the delete call fails it); sweep script dry-run output lists the current legacy per-user sandbox; after `--apply` (owner-run) the `sandboxes/` prefix is empty.

- [ ] **T5** — Per-user running-VM cap (default 2, hibernate-oldest)
  - Files: `app/lib/.server/sandbox/config.ts`, `app/lib/.server/sandbox/vm-cap.ts` (new, pure decision + IO wrapper), `app/routes/api.sandbox.session.ts`, `vm-cap.spec.ts`
  - Details: `CODESANDBOX_MAX_RUNNING_VMS` (default 2; nonsensical override → default, same guard style as `sandboxHibernationSeconds`). On every session create/resume for user U: list U's OTHER projects' sandboxIds from the project store (survives restarts — do not use an in-memory map, per the `inflight.ts` caveat), query provider running state, and hibernate the oldest-running beyond the cap. Hibernate is free and reversible, so this NEVER refuses the new session — it makes room. Pure `decideVmCap(running[], cap)` returns which ids to hibernate; IO applies best-effort with monitoring on failure.
  - Acceptance: `decideVmCap` exhaustively tested (under cap → none; at cap → oldest; cap 1; invalid cap falls back to default); session route spec proves a 3rd concurrent project triggers hibernate of the oldest and still returns a session.

- [x] **T6-inverse-b (SHIPPED 2026-07-27, found by re-driving T6-inverse live)** — Stale OSC markers killed `npm install` on every creation
  - With the port cleared, creation STILL errored: bash's PROMPT_COMMAND emits exit+prompt markers on
    command-less prompt draws (attach, ^C at idle), nothing consumed them, and `executeCommand`'s waits
    resolved against the PREVIOUS command's markers — `npm install` "done" instantly on a stale exit 0,
    then killed by `npm run dev`'s leading interrupt, leaving node_modules corrupted (ENOTEMPTY later).
    Fixed in-band: rc v2 adds bash `PS0` as a `begin` marker (versioned marker so existing VMs get the
    upgrade), `SandboxShell.beginOsc` declares it, and the exit-wait ignores pre-begin markers
    (`reduceOscSignals`, pure, pinned). Also `export BROWSER=true` (kills the `xdg-open ENOENT` noise —
    resolves the item-4 open question in `spec/sandbox-codesandbox.md`'s status block). Verified live:
    clean creation, `npm install` exit 0 after a full fresh install, vite up, tokenized preview.

- [x] **T6-inverse (SHIPPED 2026-07-27)** — Creation collision: a reused VM with a LIVE dev server broke `npm run dev`
  - The other direction of T6's race, hit live: the per-user sandbox (and a `btk@starter` fork — the
    snapshot is taken while the port task serves) wakes with a dev server already bound to 5173, and the
    creation artifact's `npm run dev` dies with "Port 5173 is already in use", leaving the new project
    served by the OLD project's process. Fixed with a seam capability `clearPort` (CodeSandbox: fuser/pkill
    script with a bounded wait-for-release, WebContainer: `false` — nothing survives a tab) called from
    `clearInheritedDevServer` in `create-project.ts` BEFORE `mountTemplate`. Best-effort: a failed clear
    never fails a creation. T6 (dead-server wake) below can reuse the same primitive: clear-then-start is
    deterministic where "is anything listening?" is the race.

- [ ] **T6** — Wake hook: a resumed VM with a dead dev server restarts it
  - Files: `app/lib/persistence/useChatHistory.ts` (`prepareMountedProject`/`startDevServer`), `app/lib/sandbox/codesandbox-provider.ts` (port state), `app/lib/stores/boot-progress.ts`, specs
  - Details: Fix the race the analysis found: `shouldStartDevServer` gates on `previews.length`, which `replayOpenPorts` fills asynchronously. On a `bootRestoredFilesystem` mount, WAIT (bounded, ~5s — covers the two replay sweeps) for the port replay to settle before deciding; if no dev server is listening after the window, run `npm run dev` through the existing `startDevServer` path and phase `bootProgress` `{step:'prepare'}` while doing it. A `CLEAN` boot (files restored from working copy/repo) already flows through the restore branches — verify it reaches `prepareMountedProject` with `prepareToRun: true`. Never start a second server when one IS listening (the existing guard's purpose survives).
  - Acceptance: unit spec on the pure wait/decide logic (ports appear late → no second server; ports never appear → start ordered once); live check: hibernate the sandbox, kill the dev server via terminal, reload → preview comes back without the user typing anything, boot screen shows "Getting the project ready…" during the restart.

### Phase B — defects the analysis surfaced (small, real, cheap now)

- [ ] **T7** — `resolveInWorkdir` accepts workdir-absolute paths; kill the `/home/project` literals in publish/deploy
  - Files: `app/lib/sandbox/codesandbox-translate.ts`, `app/lib/sandbox/codesandbox-provider.spec.ts`, `app/components/share/useShareGame.ts`, `app/components/deploy/VercelDeploy.client.tsx`, `app/components/deploy/NetlifyDeploy.client.tsx`, `app/lib/runtime/action-runner.ts` (only if needed after translate fix)
  - Details: `resolveInWorkdir` must return an already-workdir-absolute input unchanged (use `isSandboxAbsolutePath`/`toProjectRelativePath` from `sandbox-paths.ts` — one rule, one place) so `action-runner`'s build-dir probe works again on this provider. Replace the `'/home/project'` string literals in `useShareGame.ts:112` and both deploy components with `toProjectRelativePath`. Keep the fallback candidate list (defense in depth), but the detected `buildOutput.path` must now be the FIRST working candidate. **While in the translate layer (§11):** `rm({force:true})` currently swallows ALL errors, not just absence — classify, so a network/permission failure rejects instead of resolving as success (today the map diverges from disk silently and an export ships a "deleted" file); and **pin the watch-event path contract** — event paths must be workdir-absolute (normalize in `translateWatchEvent` if the SDK ever emits relative), the one leg of the path story with neither normalization nor a test.
  - Acceptance: provider spec adds the case the existing "does not double up" test misses — `fs.readdir('/project/workspace/dist')` resolves to `/project/workspace/dist`, not doubled; a unit over the candidate derivation proves a custom `outDir` (e.g. `build-out/`) detected by the probe reaches `readDist`; existing publish specs stay green; `rm` force rejects on a non-ENOENT failure (mutation-verified); a watch event with a workspace-relative path still lands in the map under the `WORK_DIR`-prefixed key.

- [ ] **T7b** — The REST of the `/home/project` literal family (each one a silent per-provider break — §11 M-P1..P4)
  - Files: `app/lib/context/opaque-files.ts` (:76 default param) + its caller `app/components/chat/Chat.client.tsx` (:152), `app/lib/.server/agent/project-instructions.ts` (:51), `app/lib/chat/plan-artifacts.ts` (:46), `app/lib/.server/share/checklist.ts` (:90), specs beside each
  - Details: Four more sites re-implement path-stripping with a `/home/project` literal instead of `toProjectRelativePath` (`sandbox-paths.ts` — roots as a LIST precisely so file maps outlive the provider that produced them). On a CodeSandbox build each fails silently: **(1)** the client opaque strip is a NO-OP — the 218KB lockfile + vendored `public/scripts/*` bodies are POSTed to `/api/agent` every turn (wire freight + request-size exposure; the server strip still protects the model); **(2)** **`CLAUDE.md` promotion misses** — no Project Instructions block, no `MAX_INSTRUCTIONS_CHARS` cap, no precedence statement: the §4.2 money path regresses to its pre-2026-07-16 state, including the "imported CLAUDE.md written for another host stalls the agent" hazard; **(3)** Plan mode REFUSES `/project/workspace/_specs/...` — the exact §4.2.9 "skill reports a spec written that does not exist" defect, reintroduced per-provider; **(4)** the publish checklist normalizer leaves `project/workspace/`-prefixed paths (its secret regexes survive today only because they anchor on `(^|\/)` — a future root-anchored rule breaks silently). Migrate all four; then sweep `grep -rn "'/home/project" app/` and leave only display cosmetics + the dead upstream prompt files (on the fail-closed `/api/chat` path), each with a reason.
  - Acceptance: per-file specs run the same inputs under BOTH roots — the opaque strip strips the lockfile at `/project/workspace/...` keys; `project-instructions` promotes a `/project/workspace/CLAUDE.md`; `plan-artifacts` accepts `/project/workspace/_specs/x.md` and still refuses traversal; the checklist normalizes both roots. Plus a source-scan spec (comment-stripped, WITH a control) that fails any NEW `/home/project` literal outside `sandbox-paths.ts` and the reason-carrying allow-list — this family has now produced nine instances; a scan is the only thing that stops the tenth.

- [ ] **T8** — Preview token expiry: re-mint instead of a dead 401 iframe
  - Files: `app/lib/stores/previews.ts` (`PreviewInfo.expiresAt`), `app/lib/sandbox/codesandbox-boot.ts`, `app/lib/sandbox/codesandbox-provider.ts`, `app/components/workbench/Preview.tsx`, specs
  - Details: Thread `expiresAt` from the mint through to `PreviewInfo`. Two consumers: **(a)** `reloadPreview` awaits a fresh `mintPreviewUrl` (never reassigns the old `src`); **(b)** a timer re-mints `PREVIEW_REMINT_WINDOW_MS` before expiry and swaps the iframe URL in place (same path, new token — preserve the URL-path join that keeps `?preview_token`). WebContainer previews have no expiry — absent `expiresAt` means "never re-mint" (no timers on that provider). **Also (§11 minor): clamp `CODESANDBOX_HOST_TOKEN_MINUTES`** to a sane ceiling (≤ 24h, same ignore-bad-override style as `sandboxHibernationSeconds`) — the token is a bearer credential riding in URLs and expiry is its ONLY mitigation; an operator typo (`60000`) currently mints ~41-day tokens silently.
  - Acceptance: spec pins — a preview whose token is within the re-mint window gets a NEW url on reload; the scheduled re-mint fires before `expiresAt` (fake timers) and the store's `baseUrl` changes while `port`/`ready` are stable; WebContainer path schedules nothing. Live check: force a 1-minute token via env, watch the iframe survive past expiry without a manual reload.

- [ ] **T9** — `.codesandbox/` joins the exclusion rules at the MAP layer
  - Files: `app/lib/stores/files.ts` (watcher exclude ~L652 + `refreshFiles` exclude ~L776), `app/lib/context/opaque-files.ts` (belt-and-braces), `app/components/workbench/Search.tsx` (excludes list), specs (`refresh-walk.spec.ts` pattern, `opaque-files.spec.ts`)
  - Details: Add `.codesandbox` to the watcher excludes AND the `refreshFiles` walk excludes (the comment already says they must match — keep them adjacent). This one change removes it from model context, file tree, ZIP export, working copies, checkpoints, git pushes, AND defuses the restore-deletion hazard (a repo restore would otherwise delete `tasks.json` off the VM, whose absence breaks the template's port task). Do NOT touch `isSecretPath` (it doubles as restore-protection semantics). Add `.codesandbox/` to `OPAQUE_DIRS` as a second wall for any ingest path that bypasses the map.
  - Acceptance: walk spec proves `.codesandbox` is never listed nor read (readdir not called for it, same as `node_modules`); opaque spec covers the dir; live check after reload: file tree no longer shows `.codesandbox`, and a `git` push tree contains no `.codesandbox/` paths. **Plus (§11 M9): the watch leg finally gets tests** — fire a fake `onEvent` through the provider double and pin the enrichment wiring (which path reaches `client.fs.readFile`, read-failure → directory classification, the `disposed` gate on late events); and the SDK's acceptance of the `'**/node_modules'` exclude-glob shape is VERIFIED (unit against the double now, live count in T17 scenario 2) — an ignored exclude + one `npm install` floods thousands of enrichment reads straight through the 3,600 req/hr cap, which is the limit the spec says bites first.

- [ ] **T9b** — Restores and mounts get the same map write-through the action runner got (§11 M7)
  - Files: `app/lib/stores/files.ts` (`restoreFiles` ~L923), `app/lib/persistence/useChatHistory.ts` (repo-mount/restore branches), spec beside `files.ts`
  - Details: `recordAgentWrite` closed the stale-serialize race for ARTIFACT writes only. `restoreFiles` (checkpoint undo, working-copy restore, repo restore, git pull) still writes the disk and lets the watcher fill the map — an RTT-per-file enrichment on this provider — so a post-restore working-copy save or checkpoint can capture a stale mix: the exact measured second-session defect (generated `Home.tsx` beside the starter's `Home.css`) through a different door. Report every restored file into the map synchronously, same contract as `recordAgentWrite` (binaries as `isBinary` + size only, never content — §1.3 principle 10). Mount-path callers that pass the restored file object onward directly are already safe; the fix is for everything that SERIALIZES THE STORE afterward.
  - Acceptance: spec proves the map reflects a restore synchronously (no watcher tick) and a serialize immediately after restore returns the restored content, binaries as metadata (mutation: dropping the write-through fails it); WebContainer path behavior unchanged (its watcher was never the source of truth for this either — the write-through is provider-neutral).

- [ ] **T9c** — Shell OSC waits: one demultiplexer, honest rc degradation (§11 M5 + M6)
  - Files: `app/utils/shell.ts` (`reduceOscSignals` break-early ~L154, `executeCommand`'s un-armed prompt-wait ~L405), `app/lib/sandbox/codesandbox-provider.ts` (`ensureOscBashrc` + the `beginOsc` declaration), `app/utils/shell.spec.ts`
  - Details: Two confirmed hazards, both in the "hangs silently forever" class. **(a)** `reduceOscSignals` BREAKS at the awaited code and discards the rest of the chunk's signals, while `executeCommand`'s un-armed prompt-wait and a parked start-action exit-wait share ONE stream reader. bash emits `exit`+`prompt` in a single chunk on Ctrl-C (the measured `MEASURED_PROMPT_CHUNK` shape), so whichever waiter receives that chunk starves the other — the live creations worked only because stale attach-draw markers happened to backfill the second waiter, a balance that is accidental and chunk-boundary-dependent. Fix structurally: one signal demultiplexer that consumes each chunk once and routes EVERY signal in it to every registered waiter's state machine — never break early, never let two waiters race one reader. **(b)** `ensureOscBashrc` is best-effort (a warn) but the provider *unconditionally* declares `beginOsc` — if the rc append fails (hardcoded `/root/.bashrc`; a non-root image; a transient fs error), every `waitTillOscCode` waits for markers bash will never emit: a logged warn converts into every-shell-action-hangs-forever. Degrade honestly: a failed install yields a shell WITHOUT `beginOsc` (armed-wait skipped, pre-fix semantics), and derive the rc path from `$HOME` rather than hardcoding root's.
  - Acceptance: shell spec adds the single-chunk `exit+prompt` case with BOTH waiters registered — neither starves (mutation: restoring the break-early fails it); a provider double whose rc install fails produces a shell without `beginOsc` and `executeCommand` still completes; every existing jsh/WebContainer spec passes byte-identical (that path has no `beginOsc` and must not change).

- [ ] **T10** — Search tab honest "not supported" state
  - Files: `app/components/workbench/Search.tsx`
  - Details: Read `capabilities.textSearch` into component state (await the sandbox in an effect). When false, render a proper panel ("Text search isn't available on this workspace runtime yet") instead of the misleading "No results found." empty state; disable the input. Keep the tab visible (discoverability of the limitation beats hiding it).
  - Acceptance: with a provider double reporting `textSearch: false`, the panel text renders and no search executes; with `true`, behavior unchanged.

### Phase C — economics, reporting, monitoring

- [ ] **T11** — VM cost into the margin math (no per-user metering at launch)
  - Files: `app/lib/.server/billing/stripe.ts` (or a sibling `vm-cost.ts`), `app/lib/.server/billing/billing.spec.ts`, `.env.example`, `spec/billing.md`
  - Details: Owner decision: bake in. Model the VM cost as an explicit, measured input — `SANDBOX_VM_USD_PER_HOUR` (Pico list price) and `SANDBOX_EST_VM_HOURS_PER_KCREDIT` (operator estimate, refined by T12's report) — and add a pure `effectivePackMargin(pack, { vmOverheadUsdPerCredit })` assertion beside the existing `packMargin` floor: every pack/plan must clear `MIN_PACK_MARGIN` AFTER VM overhead. Never fudge `CREDIT_MARGIN` itself or a cost input (the file's own warning). **The interim numbers already live in CREDITS.md §"Sandbox compute" (2026-07-27)** — ~+25% on raw cost ≈ 5–7 GM points at margin 4.0, `5.0` restores the ~75% target, same placeholder for BOTH providers by owner decision — T11 formalizes that derivation into the tested floor; keep the two documents agreeing (the placeholder's credits-per-active-hour assumption IS `SANDBOX_EST_VM_HOURS_PER_KCREDIT`, inverted). Document in `spec/billing.md` that "user project compute ≈ $0" is retired and what replaces it (the §7/§8 SPEC.md flags for this landed 2026-07-27).
  - Acceptance: new margin-floor-with-VM-overhead test passes at current pack prices with the measured Pico rate and a stated hours estimate; the test FAILS if the estimate is set to an absurd value (proving it binds); `.env.example` documents both vars with the derivation.

- [ ] **T12** — VM lifecycle marks + per-user VM-hours on the Admin tab
  - Files: `app/lib/.server/sandbox/usage-store.ts` (new: append-only lifecycle marks — create/resume/hibernate/delete, `{projectId, userId, sandboxId, event, at}`), `app/lib/.server/admin/vm-report.ts` (new, PURE), `app/routes/api.admin.usage.ts`, `app/components/@settings/tabs/admin/AdminTab.tsx`, `vm-report.spec.ts`
  - Details: Emit marks from `service.ts`'s create/resume/hibernate/delete (best-effort, never fails the operation). Pure `buildVmReport(marks[])` pairs resume→hibernate intervals into VM-hours (an unclosed interval counts to `now` passed in as an arg — no `Date.now()` in the pure core), aggregates total + per-user top-N. Join onto the usage route like `providerBalance` (a failure renders "unavailable", never breaks the dashboard); render a "Sandbox VM time" section beside "Usage & cost". This is the measurement that decides whether metering ever needs to exist.
  - Acceptance: `buildVmReport` exhaustively tested (paired, unclosed, out-of-order, multi-user); Admin tab shows total VM-hours + per-user rows against seeded marks; a usage-store outage leaves the rest of the usage report rendering.

- [ ] **T13** — Sandbox monitoring + health key
  - Files: `app/lib/.server/monitoring/events.ts` (`SANDBOX_FAILURE_RATE`), a `recordSandboxOutcome` helper beside `paid-path-rates.ts`, `app/routes/api.sandbox.session.ts`, `app/lib/.server/monitoring/health.ts` + `health.spec.ts`
  - Details: Rate windows `sandbox:create`, `sandbox:resume`, and a separate `sandbox:clean-boot` (a CLEAN resume is silent-data-loss-adjacent, not a failure) — record EVERY attempt, not just failures (the `proxy.ts:1701` lesson). Alert through `getMonitor(context).alert(…)` on threshold. Health: add `codesandbox: isSandboxConfigured(context) ? 'ok' : 'degraded'` — config presence ONLY, no reachability probe (the endpoint's stated contract; reachability lives in the rate windows).
  - Acceptance: session route spec proves success AND failure both record into the window (mutation: recording only failures fails a test); health spec covers configured/unconfigured; monitoring never throws into the request path.

### Phase D — template pipeline

- [ ] **T14** — CSB template pin: promote/rollback from the Admin panel
  - Files: `app/lib/.server/sandbox/template-pin.ts` (new: pointer history + pure `decideSandboxTemplate`), `app/lib/.server/sandbox/config.ts` (`sandboxTemplate()` prefers the promoted pin over env), `app/routes/api.admin.sandbox-template.ts` (new, `requireAdmin` both halves), `AdminTab.tsx` (section beside "Starter template"), specs
  - Details: Mirror `templates/pin.ts` exactly where it applies: immutable pointer HISTORY (CodeSandbox holds the bytes; we record `{target, promotedAt, promotedBy, provenance}`), validate-before-re-point (fork the candidate template once, assert it boots + contains the sentinel starter files, then record), rollback only onto a target already in the history. Precedence: promoted pin > `CODESANDBOX_TEMPLATE` env > baked `btk@starter` — each priced… each VALID in its own right (a pin pointing at a deleted template falls through loudly, never silently to live).
  - Acceptance: `decideSandboxTemplate` pure-tested (no pin → env/default; pin → pin; corrupt pin ≠ outage); promote validates before recording (a candidate failing validation leaves the pin unchanged, 422); Admin section lists history with one-click rollback; `sandboxTemplate()` callers all flow through the decision.

- [ ] **T15** — Rebuild `btk@starter` clean and promote it
  - Files: template working dir (owner's starter checkout — locate at execute time; NOT this repo's `app/`), `scripts/` helper if useful
  - Details: From a clean starter checkout: delete the probe debris baked into the current template (`src/main.js`, fake 512KB `public/havok.wasm` — the real one lives in `public/scripts/`, `src/scripts/ArcadeRacingMode.ts`, `src/scripts/Simple3dSceneMode.ts`); `vite.config.ts`: remove `open: true` (the `xdg-open ENOENT` noise), add `server.hmr: { clientPort: 443, protocol: 'wss' }`; settle `runAtStart` — the template's task must NOT auto-start a dev server that fights the artifact's `npm run dev` (decide: task present but `runAtStart: false`, since the platform starts the server itself and T6 handles wakes). `csb build --alias` to a NEW version; validate + promote through T14's panel (owner clicks promote).
  - Acceptance: a fresh project forked from the promoted template contains none of the four debris files, prints no `xdg-open` error, HMR connects over wss in the hosted preview, and exactly ONE dev server runs after creation (verified in the terminal).

### Phase E — deploy wiring + live verification

- [ ] **T16** — Production build + deploy wiring
  - Files: `DEPLOY.md`, Docker/build config (wherever the production image is built), `.env.example`
  - Details: `VITE_SANDBOX_PROVIDER=codesandbox` is a BUILD-time switch — bake it into the production image build args; document that rollback to WebContainer is "deploy the previous image", never an env flip on a running container (the client bundle already chose). `CODESANDBOX_API_KEY` + `CODESANDBOX_*` tunables go to SSM → container env alongside the existing secrets; verify `assertNotLocalInProduction` posture unchanged. Note the licensing/commercial check as an owner action item in DEPLOY.md: confirm the CodeSandbox plan covers embedding/reselling VM time (the `spec/licensing.md` StackBlitz precedent) and is sized for launch concurrency.
  - Acceptance: a production build produced by the documented command serves the CodeSandbox provider (no WebContainer WASM fetched); DEPLOY.md's SSM table lists every `CODESANDBOX_*` var with defaults; health endpoint on that build reports `codesandbox: ok`.

- [ ] **T17** — Live verification pass of the never-driven money paths
  - Files: none (drive the real product; record findings in `spec/sandbox-codesandbox.md`)
  - Details: One deliberate session on the real provider, in this order: **(1)** Share/publish end-to-end (`vite build` in the VM — record peak memory; decides whether Pico survives a full Babylon rollup build or the publish path needs a per-build `updateTier` bump); **(2)** request-rate during a full creation generation vs the 3,600/hr API limit (count Pitcher/API calls; the watch channel is the suspect — including an `npm install` with T9's excludes in place, which live-verifies the SDK honors the glob shape); **(3)** asset upload via the Assets tab; **(4)** media generation delivery; **(5)** checkpoint restore/undo over a live VM; **(6)** Export ZIP byte-integrity (spot-hash a binary); **(7)** two browsers on ONE project (two Pitcher clients, one VM — watcher echo, terminal contention); **(8)** project switch A→B→A in one tab (T3's live proof); **(9)** kill recovery: delete the VM provider-side (and separately let a snapshot expire if feasible) → reload → T2's resume→create fallback mints a fresh VM and the working-copy/repo restore refills it — no permanent 503, no silent template adoption (T3f). Fix-or-file every defect found — the MCP-relay precedent says expect defects precisely here.
  - Acceptance: all nine scenarios run against the real provider with results (numbers, not adjectives) recorded in `spec/sandbox-codesandbox.md`'s status block; every defect found is either fixed with a pinned test in this pass or filed as an explicit follow-up task appended to this plan.

- [ ] **T18** — Update SPEC.md to match what was built
  - Files: `SPEC.md`, `spec/sandbox-codesandbox.md`, `spec/sandbox-seam.md`, `spec/billing.md`, `CLAUDE.md` (stage/status blocks)
  - Details: Update the specific sections this plan changes: the sandbox architecture (per-project sandboxes, registry deletion, VM cap, wake hook — replacing the documented per-user stopgap), the billing model (VM cost as a margin input, the retired "user compute ≈ $0" claim, the T11 floor assertion), the template pipeline (CSB alias pin-and-promote), monitoring/health additions, and the deploy contract (build-time provider switch). Follow the working agreement: replace/merge current-state sections; append decisions with rationale (bake-vs-meter, cap=2, hibernate-oldest-never-refuse); never delete history — supersede it. **Also disposition the review:** `spec/sandbox-codesandbox.md` §11 and the CLAUDE.md sandbox-provider sub-entry both list the findings this plan folds in — mark each one fixed-by-T\<n\> or explicitly still-open.
  - Acceptance: no spec section contradicts the shipped code; the per-user-registry stopgap text is superseded (not silently deleted); `spec/sandbox-codesandbox.md`'s "Still open" list reflects only what genuinely remains; **every §11 finding carries a disposition (fixed-by-task or still-open, none ambiguous)**; gates green including the doc-adjacent source-scan specs.

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
