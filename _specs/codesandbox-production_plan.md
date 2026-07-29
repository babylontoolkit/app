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

- [x] **T1** — `sandbox_id` on the project record (migration + both stores)
  - Files: `supabase/migrations/0013_project_sandbox.sql`, `app/lib/.server/projects/types.ts`, `app/lib/.server/projects/store.ts`, `app/lib/.server/projects/store.spec.ts` (or nearest store spec)
  - Details: Add `sandboxId?: string` to the server `Project` type as a plain pointer mirroring `linkedUnityProjectId` (doc comment says pointer-not-credential, client never sees it — do NOT add it to `app/types/project.ts`). Migration copies `0011`'s single-column shape (`alter table … add column if not exists sandbox_id text;` + `comment on column`). Supabase store: add BOTH halves — `rowToProject` (`sandbox_id → sandboxId`) and `projectToRow`'s map (`sandboxId: 'sandbox_id'`). FS store needs no field work (round-trips whole object); do not add a default in `withProjectDefaults` (undefined is correct).
  - Acceptance: migration runs clean in the PGlite harness (`ledger-sql.spec.ts` machinery); a store round-trip test proves `sandboxId` survives create→update→get in BOTH store modes (the Supabase half via the row-mapping unit); the client `Project` type still has no `sandboxId`.

- [x] **T2** — Per-project sandbox routes; delete the per-user registry
  - Files: `app/routes/api.sandbox.session.ts`, `app/routes/api.sandbox.preview.ts`, `app/lib/.server/sandbox/registry.ts` (DELETE), `app/lib/.server/sandbox/service.ts`, route specs
  - Details: `POST /api/sandbox/session` body becomes `{ projectId, reset? }`; resolve via `requireOwnedProject` (404-not-403), read `project.sandboxId`, run the UNCHANGED `decideSandboxStart`, on create call `createSandboxForProject(project.id, …)` (fixing the user-id-where-project-id-belongs lie — the `project:${id}` tags become truthful) and persist via `store.update(project.id, { sandboxId })`. `GET /api/sandbox/preview` gains a `projectId` query param + the same ownership wall. Delete `registry.ts` outright — the project row is the registry; grep for all importers. Keep the header-comment invariant intact and state it: the client supplies a PROJECT id it must own, never a sandbox id. **Review hardening (§11 M1–M3), each a silent money/lockout failure without it:**
    - **The create race survives the registry deletion** — two tabs both read `sandboxId` unset, both fork, last `store.update` wins, the loser VM is orphaned with a live write session pointed at it. Persist with compare-and-set semantics: after creating, re-read the row; if a DIFFERENT sandboxId already won, treat that one as canonical and `deleteSandbox` the just-created loser (best-effort, monitored).
    - **`reset` must DISPOSE the old VM** (`deleteSandbox`, best-effort + monitored) — today it orphans a billing VM holding the user's files. And creates need a **per-user rate limit** (`sharedRateWindow`-style): 20 forks/hr is the whole platform's provider budget, so an unbounded `{reset:true}` loop is a platform-wide outage lever. A refused create is a described 429, never a silent stall.
    - **Decide whether `sandboxId` may ride out on the project response (found verifying T1, 2026-07-27).** `app/types/project.ts` deliberately omits it, but a TS type strips nothing at runtime and BOTH project routes serialize the whole row (`api.projects.ts:33` spreads `{ ...project }`; `api.projects.$projectId.ts:20,80` return `json({ project })`) — so the pointer ships to every dashboard load the moment this task records it, exactly as `userId` already does. Not an auth bypass (the id is not a credential; a preview still needs a server-minted `preview_token`), but it must be a DECISION: either hand-pick the response fields on both routes, or state in the type's doc comment why exposing it is safe. What is forbidden is the current state — a comment claiming the browser never sees it while the routes send it.
    - **The resume→create fallback `lifecycle.ts`'s comment promises must actually exist**: a resume failure that classifies as gone falls through to create ONCE and records the new id (today it is a generic 500, and a deleted VM bricks the project into a permanent 503). Gone-classification must prefer typed SDK errors/status codes over the current message regex (keep the regex as last-resort fallback).
  - Acceptance: route specs pin — someone else's projectId → 404 with zero provider calls; missing projectId → 400; create path records `sandboxId` on the row; resume path uses the recorded id; `registry.ts` and `sandboxRecordKey` no longer exist anywhere (source grep in a spec, with a control). **Plus:** concurrent creates converge on ONE recorded sandboxId and the loser is disposed (mutation: dropping the dispose fails it); reset disposes the previous VM; resume-of-a-deleted-sandbox falls back to create and records the new id; both routes join `outbound-auth.spec.ts` (unauthenticated → 401 with ZERO provider calls — today they pass the enumerate scan on source alone, which its own doc warns is not a behavioral pin).

- [x] **T3** — Project-aware client boot (lazy, pinned, cache-keyed)
  - Files: `app/lib/sandbox/index.ts`, `app/lib/sandbox/codesandbox-boot.ts`, `app/lib/persistence/useChatHistory.ts`, `app/lib/sandbox/codesandbox-provider.spec.ts` + a boot spec
  - Details: The module-scope eager boot cannot know a project. Replace with a lazy entry — `sandbox` stays a Promise for consumers (stores capture it in constructors; keep that contract) but resolution is DEFERRED until the mount path supplies a projectId (e.g. `bootForProject(projectId)` called from `doMountProjectFiles`/creation, resolving the shared deferred). Rules, each a silent failure if missed: **(a)** `requestSession` and the `getSession` reconnect closure carry the projectId they were BOOTED with (captured, not read from the atom — a hibernated tab must reconnect to its own project); **(b)** `mintPreviewUrl` passes projectId and the `previewUrls` cache is keyed `(projectId, port)` or cleared on project switch; **(c)** WebContainer branch is unaffected (its boot needs no project); **(d)** the HMR `import.meta.hot.data` caching keeps one identity. Project switch within one page (dashboard → open) re-runs boot for the new project; document that one tab = one active sandbox connection. **Review hardening (§11), each a silent failure today:**
    - **(e) A boot failure is currently cached FOREVER** in the module-level promise — the server's deliberate `retryable: true` 503 is read by nobody, and the only recovery is a full page reload. The deferred boot must keep failure retryable: surface a described state with a retry affordance, and a later `bootForProject` re-attempts instead of replaying the cached rejection.
    - **(f) A reconnect must never silently ADOPT a fresh sandbox.** `getSession` re-runs the decide flow; if it comes back `created: true`, the SDK would reconnect the live client to a DIFFERENT filesystem mid-session (files vanish, no signal). Fail that reconnect loudly (toast + reload affordance) instead.
    - **(g) `firstBootupType`/`bootRestoredFilesystem` become per-BOOT facts** (per project), not module-frozen — a CLEAN reconnect mid-page must not read as "disk restored" (data-loss direction: the next checkpoint captures template state as the project).
    - **(h) Identity sentinel, defense-in-depth for the warm-boot gate:** creation writes a marker (e.g. `.codesandbox/btk-project.json` with the projectId — inside the dir T9 excludes, so it never rides into context/pushes once T9 lands; if executed before T9 it briefly shows in the tree, harmless); the `liveSandboxIsTruth` gate reads it via provider `fs` (not the map) and stays CLOSED on mismatch. With per-project VMs it should never fire — which is exactly why it is cheap insurance against a mis-pointed `sandbox_id` (operator edit, restored old row) re-opening §11 C1's silent cross-project adoption.
  - Acceptance: unit specs pin — session request carries the booted projectId; reconnect after a simulated hibernate uses the ORIGINAL projectId even after the atom changes; preview mint for port P on project B never returns project A's cached token; a failed boot can be retried without a page reload (no permanently-cached rejection); a reconnect that would CREATE fails loudly instead of adopting; sentinel mismatch keeps the warm-boot gate closed with a described error. Live check: open project A, then project B from the dashboard in the same tab — B's files, B's preview, A untouched (the registry-era overwrite is gone).

- [x] **T3b** — The two consequences T3's verifier surfaced: import-without-a-project, and the orphan project row
  - Files: `app/lib/hooks/useGit.ts` + `app/components/chat/GitCloneButton.tsx`, `app/utils/folderImport.ts` + its caller, `app/components/chat/Chat.client.tsx` (`runStartProject`), specs beside each
  - Details: Two things T3 made HONEST but did not make work, both filed rather than hidden. **(1) Import-a-repo / import-a-folder run from the landing page, before any project exists** — on a per-project sandbox there is nothing to write into, and `requireBootedSandbox` now refuses with a sentence instead of hanging forever on a promise that will never resolve. They previously "worked" on CodeSandbox only by adopting whichever VM the per-user registry handed back, i.e. the §11 C1 cross-project defect T2 removed — so this is not a regression to undo, it is a flow that needs the same shape creation now has: register the project FIRST, `bootForProject(project.id)`, then write. Give both entry points that path (and a described, non-hanging state while it is absent — verify the button/dialog says why rather than sitting disabled). **(2) A failed creation now leaves an orphan project row**: `createProject` moved to the top of phase 1 (a sandbox cannot be booted for a project that does not exist), so a later failure — starter fetch, sandbox boot, mount — leaves a registered project with no files, where previously nothing was registered at all. Decide and implement: roll back on a phase-1 failure, or adopt the row on retry. It compounds against T2's per-user create rate limit, and an empty project in the dashboard reads as data loss.
  - Acceptance: a git clone / folder import with no project open produces a DESCRIBED refusal (or, once built, a real project) and never an indefinite spinner — pinned with a provider double reporting `SANDBOX_REQUIRES_PROJECT`; a phase-1 creation failure leaves no orphan row (mutation-verified), or the retry adopts it and the spec says which.

- [x] **T4** — Sandbox teardown on project delete + legacy orphan sweep
  - Files: `app/routes/api.projects.$projectId.ts`, `app/lib/.server/projects/delete-leaves-nothing.spec.ts`, `scripts/sweep-legacy-sandboxes.mjs` (one-shot)
  - Details: In the DELETE branch, before `store.delete`: `deleteSandbox(project.sandboxId, context)` when set (best-effort per its own contract, but LOGGED + monitored on failure — an orphan VM is a bill nobody sees). Extend the leaves-nothing spec with the sandbox case. One-shot sweep script (scratchpad-style, committed under `scripts/`): list provider sandboxes tagged `btk`, cross-reference project rows' `sandboxId` + legacy `sandboxes/{userId}.json` records, delete orphans + the legacy storage prefix; dry-run mode default, `--apply` to execute. **Also (§11 minor): the client provider's `teardown()` is currently the silent no-op its own comment claims it isn't** (`onTeardown` is never injected in `index.ts`'s composition) — either wire it or fix the lying comment; a false claim in a comment is how the shell-strip defect survived review.
  - Acceptance: leaves-nothing spec covers the sandbox (mutation-verified: removing the delete call fails it); sweep script dry-run output lists the current legacy per-user sandbox; after `--apply` (owner-run) the `sandboxes/` prefix is empty.

- [x] **T5** — Per-user running-VM cap (default 2, hibernate-oldest)
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

- [x] **T6** — Wake hook: a resumed VM with a dead dev server restarts it
  - **Shipped 2026-07-27, code half verified; the LIVE half is deferred to T17 by owner decision.** The
    wait is `awaitRunningPreview` (`app/lib/persistence/port-settle.ts`, pure + injected clock, 12 tests,
    mutation-verified), threaded as `PrepareOptions.awaitPortReplay` = `runtime.bootRestoredFilesystem`
    to every `prepareMountedProject` call site. 5s bound chosen to clear the provider's SECOND replay
    sweep (`PORT_REPLAY_RECHECK_MS` = 3s) — a shorter window expires between the two sweeps, i.e. exactly
    the case the re-check exists to catch (pinned by a test, which fails at 2s). ⚠️ **The WIRING is not
    pinned**: mutating `awaitPortReplay` to `false`, or dropping it from a call site, breaks no test —
    same live-fidelity caveat family as the MCP relay before its verification. T17 owes the scenario:
    hibernate, kill the dev server, reload → preview returns unaided with "Getting the project ready…".
  - Files: `app/lib/persistence/useChatHistory.ts` (`prepareMountedProject`/`startDevServer`), `app/lib/sandbox/codesandbox-provider.ts` (port state), `app/lib/stores/boot-progress.ts`, specs
  - Details: Fix the race the analysis found: `shouldStartDevServer` gates on `previews.length`, which `replayOpenPorts` fills asynchronously. On a `bootRestoredFilesystem` mount, WAIT (bounded, ~5s — covers the two replay sweeps) for the port replay to settle before deciding; if no dev server is listening after the window, run `npm run dev` through the existing `startDevServer` path and phase `bootProgress` `{step:'prepare'}` while doing it. A `CLEAN` boot (files restored from working copy/repo) already flows through the restore branches — verify it reaches `prepareMountedProject` with `prepareToRun: true`. Never start a second server when one IS listening (the existing guard's purpose survives).
  - Acceptance: unit spec on the pure wait/decide logic (ports appear late → no second server; ports never appear → start ordered once); live check: hibernate the sandbox, kill the dev server via terminal, reload → preview comes back without the user typing anything, boot screen shows "Getting the project ready…" during the restart.

### Phase B — defects the analysis surfaced (small, real, cheap now)

- [x] **T7** — `resolveInWorkdir` accepts workdir-absolute paths; kill the `/home/project` literals in publish/deploy
  - **Shipped 2026-07-27.** `resolveInWorkdir` rebases through `toProjectRelativePath` (traversal still
    refused — the wall runs AFTER the rebase, on the same string that gets joined), so the
    `action-runner` build-dir probe is live again on this provider. The candidate derivation became ONE
    shared pure module (`app/lib/sandbox/build-output.ts`) consumed by publish AND both deploy flows —
    the three had their own copies of the list and had already drifted, which is the whole reason the
    literal survived in three places. It carries an empty-detected-path guard (`''` resolves to the
    WORKDIR, where `readdir` SUCCEEDS — the flow would have published the entire project, `node_modules`
    and `.env` included). Also: `rm({force:true})` now classifies (`isMissingPathError`) instead of
    swallowing every failure, and watch-event paths are normalized ONCE before enrichment so the read
    and the map key cannot diverge. ⚠️ **`not found` is deliberately NOT in the absence phrase list** —
    it also matches the SDK's `null: Sandbox not found` (a dead VM), and swallowing that under `force`
    is the exact failure the classifier exists to prevent; pinned by its own test.
  - Files: `app/lib/sandbox/codesandbox-translate.ts`, `app/lib/sandbox/codesandbox-provider.spec.ts`, `app/components/share/useShareGame.ts`, `app/components/deploy/VercelDeploy.client.tsx`, `app/components/deploy/NetlifyDeploy.client.tsx`, `app/lib/runtime/action-runner.ts` (only if needed after translate fix)
  - Details: `resolveInWorkdir` must return an already-workdir-absolute input unchanged (use `isSandboxAbsolutePath`/`toProjectRelativePath` from `sandbox-paths.ts` — one rule, one place) so `action-runner`'s build-dir probe works again on this provider. Replace the `'/home/project'` string literals in `useShareGame.ts:112` and both deploy components with `toProjectRelativePath`. Keep the fallback candidate list (defense in depth), but the detected `buildOutput.path` must now be the FIRST working candidate. **While in the translate layer (§11):** `rm({force:true})` currently swallows ALL errors, not just absence — classify, so a network/permission failure rejects instead of resolving as success (today the map diverges from disk silently and an export ships a "deleted" file); and **pin the watch-event path contract** — event paths must be workdir-absolute (normalize in `translateWatchEvent` if the SDK ever emits relative), the one leg of the path story with neither normalization nor a test.
  - Acceptance: provider spec adds the case the existing "does not double up" test misses — `fs.readdir('/project/workspace/dist')` resolves to `/project/workspace/dist`, not doubled; a unit over the candidate derivation proves a custom `outDir` (e.g. `build-out/`) detected by the probe reaches `readDist`; existing publish specs stay green; `rm` force rejects on a non-ENOENT failure (mutation-verified); a watch event with a workspace-relative path still lands in the map under the `WORK_DIR`-prefixed key.

- [x] **T7b** — The REST of the `/home/project` literal family (each one a silent per-provider break — §11 M-P1..P4)
  - **Shipped 2026-07-28.** All four migrated to `toProjectRelativePath`, each with a both-roots
    `describe.each(SANDBOX_ROOTS)` block (parameterized off the imported constant, so a third provider
    root extends every one of them for free). `stripOpaqueContent` LOST its `workdir` parameter rather
    than gaining a caller — a default nobody overrode was the whole bug.
  - **🔴 The scan found a TENTH instance that no grep could ever have found** (`buildObjectKey`,
    `share/publish.ts`): its raw text is `home\/project`, regex-escaped, so `grep home/project` does not
    match it. It is fixed with a NEW primitive — `stripSandboxRootPrefix` — and deliberately NOT
    `toProjectRelativePath`: that strips bare leading slashes, and `buildObjectKey` must REJECT
    `/etc/passwd` rather than launder it into a valid storage key. The two functions' DIFFERENCE on an
    absolute path is now itself a test, so the reason the second exists cannot be refactored away.
  - **The scan's own first draft was blind to the bug shape it was written for** — it required the root
    to sit next to a quote, which the regex spelling (`checklist.ts`'s old body) does not. Caught by the
    verifier, not by me; the three missed spellings are now controls. It matches the root as a path
    substring after removing backslashes, iterates `SANDBOX_ROOTS` (so the mirror bug — a CodeSandbox
    root hardcoded into a WebContainer path rule — is caught too), excludes `.spec` files by design (the
    both-roots tests must name both roots), and every allow-list entry carries a reason plus a
    dead-entry test. **Residual, filed not fixed:** `[/]`-char-class and string-concat spellings are not
    detected (neither is house style — 0 uses vs 69 of `\/`), and `LockManager.tsx`'s two display-only
    literals are allow-listed rather than migrated.
  - Files: `app/lib/context/opaque-files.ts` (:76 default param) + its caller `app/components/chat/Chat.client.tsx` (:152), `app/lib/.server/agent/project-instructions.ts` (:51), `app/lib/chat/plan-artifacts.ts` (:46), `app/lib/.server/share/checklist.ts` (:90), specs beside each
  - Details: Four more sites re-implement path-stripping with a `/home/project` literal instead of `toProjectRelativePath` (`sandbox-paths.ts` — roots as a LIST precisely so file maps outlive the provider that produced them). On a CodeSandbox build each fails silently: **(1)** the client opaque strip is a NO-OP — the 218KB lockfile + vendored `public/scripts/*` bodies are POSTed to `/api/agent` every turn (wire freight + request-size exposure; the server strip still protects the model); **(2)** **`CLAUDE.md` promotion misses** — no Project Instructions block, no `MAX_INSTRUCTIONS_CHARS` cap, no precedence statement: the §4.2 money path regresses to its pre-2026-07-16 state, including the "imported CLAUDE.md written for another host stalls the agent" hazard; **(3)** Plan mode REFUSES `/project/workspace/_specs/...` — the exact §4.2.9 "skill reports a spec written that does not exist" defect, reintroduced per-provider; **(4)** the publish checklist normalizer leaves `project/workspace/`-prefixed paths (its secret regexes survive today only because they anchor on `(^|\/)` — a future root-anchored rule breaks silently). Migrate all four; then sweep `grep -rn "'/home/project" app/` and leave only display cosmetics + the dead upstream prompt files (on the fail-closed `/api/chat` path), each with a reason.
  - Acceptance: per-file specs run the same inputs under BOTH roots — the opaque strip strips the lockfile at `/project/workspace/...` keys; `project-instructions` promotes a `/project/workspace/CLAUDE.md`; `plan-artifacts` accepts `/project/workspace/_specs/x.md` and still refuses traversal; the checklist normalizes both roots. Plus a source-scan spec (comment-stripped, WITH a control) that fails any NEW `/home/project` literal outside `sandbox-paths.ts` and the reason-carrying allow-list — this family has now produced nine instances; a scan is the only thing that stops the tenth.

- [x] **T8** — Preview token expiry: re-mint instead of a dead 401 iframe
  - **Shipped 2026-07-28.** `expiresAt` is threaded mint → `PreviewInfo`; a per-port timer re-mints
    `PREVIEW_REMINT_WINDOW_MS` before expiry and swaps the URL in place (`port`/`ready` stable), and
    `reloadPreview` awaits a fresh URL instead of re-assigning the old `src`. WebContainer omits
    `refreshPreviewUrl` entirely, so absent expiry = no timers, by shape rather than by a flag.
  - **Two silent holes the verifier caught in the first draft, both fixed and pinned:** a failed
    re-mint used to APPLY the tokenless bare host — a URL guaranteed to 401 — replacing a still-valid
    preview five minutes early on one transient blip, and then stop rotating forever (no expiry to
    schedule from); it now keeps the working URL and retries at `REMINT_RETRY_DELAY_MS`. And a port
    that closed while a mint was in flight (i.e. every dev-server restart) armed an immortal timer for
    a preview nothing renders — the closed-port check now runs after the await, before any `setTimeout`.
  - ⚠️ **The window is ONE constant** (`boot-decisions.ts`, re-exported by `preview-url.ts`): the store
    schedules at `expiresAt - window` and the mint cache answers "still fresh?" with the same window,
    so two independently-chosen values would make the timer fire and hand back the OLD token.
  - The host is recorded from the PORT EVENT, not from a successful mint — otherwise a port whose
    first mint failed has no host, `previewUrlForPort` can only answer `undefined`, and the retry ticks
    forever without issuing a request. ⚠️ **Live check still owed** (T17): the whole design rests on
    the MEASURED premise that a cross-origin 401 still fires the iframe's `onLoad`.
  - Files: `app/lib/stores/previews.ts` (`PreviewInfo.expiresAt`), `app/lib/sandbox/codesandbox-boot.ts`, `app/lib/sandbox/codesandbox-provider.ts`, `app/components/workbench/Preview.tsx`, specs
  - Details: Thread `expiresAt` from the mint through to `PreviewInfo`. Two consumers: **(a)** `reloadPreview` awaits a fresh `mintPreviewUrl` (never reassigns the old `src`); **(b)** a timer re-mints `PREVIEW_REMINT_WINDOW_MS` before expiry and swaps the iframe URL in place (same path, new token — preserve the URL-path join that keeps `?preview_token`). WebContainer previews have no expiry — absent `expiresAt` means "never re-mint" (no timers on that provider). **Also (§11 minor): clamp `CODESANDBOX_HOST_TOKEN_MINUTES`** to a sane ceiling (≤ 24h, same ignore-bad-override style as `sandboxHibernationSeconds`) — the token is a bearer credential riding in URLs and expiry is its ONLY mitigation; an operator typo (`60000`) currently mints ~41-day tokens silently.
  - Acceptance: spec pins — a preview whose token is within the re-mint window gets a NEW url on reload; the scheduled re-mint fires before `expiresAt` (fake timers) and the store's `baseUrl` changes while `port`/`ready` are stable; WebContainer path schedules nothing. Live check: force a 1-minute token via env, watch the iframe survive past expiry without a manual reload.

- [x] **T9** — `.codesandbox/` joins the exclusion rules at the MAP layer
  - **Shipped 2026-07-28.** One list (`MAP_EXCLUDED_DIRS`) with two spellings derived from it — the
    watcher's globs and the walk's predicate — because "match the watcher's exclusions" had been a
    COMMENT, and a comment is not a mechanism. `.codesandbox/` is also a second wall in `OPAQUE_DIRS`
    (for any ingest path that fills context without going through the map) and an exclude in Search.
    `isSecretPath` deliberately untouched: it doubles as restore-protection semantics.
  - ⚠️ **The first draft pinned the constants and the pure walker, and NEITHER call site** — the
    verifier reverted both to their pre-T9 literals and all 352 tests stayed green, i.e. the whole
    feature reverted silently. `files-exclusions.spec.ts` now drives a real `FilesStore` over a
    provider double: the watcher's `exclude` must BE `MAP_EXCLUDE_GLOBS` (`toBe`, so an equal-but-
    separate literal is rejected — that copy is the drift the constant exists to abolish) and
    `refreshFiles` must not `readdir` it, both with controls (a walk that excludes everything, and a
    narrowed watch, each fail their control).
  - ⚠️ **The glob spelling is NOT proven on this provider.** `.codesandbox` copies `.git`'s bare-name
    form because that is this codebase's history — but that history is WebContainer's, and the CSB SDK
    types its excludes as an unspecified `readonly string[]`. **T17 scenario 2 owes the live check**,
    and an ignored exclude is expensive rather than quiet: one `npm install` floods enrichment reads at
    an RTT each into a 3,600 req/hr cap.
  - **Known consequence, recorded not fixed:** `fastForwardPush` builds its tree with no `base_tree`
    (deliberately — it is what makes "the stray file does not survive" true), so a user whose repo
    ALREADY contains `.codesandbox/` (a pre-T9 commit, or an imported CodeSandbox project) silently
    loses it on their next Commit. Recoverable from git history, invisible at the time, and the VM is
    unaffected (the fork template supplies `tasks.json` regardless).
  - Files: `app/lib/stores/files.ts` (watcher exclude ~L652 + `refreshFiles` exclude ~L776), `app/lib/context/opaque-files.ts` (belt-and-braces), `app/components/workbench/Search.tsx` (excludes list), specs (`refresh-walk.spec.ts` pattern, `opaque-files.spec.ts`)
  - Details: Add `.codesandbox` to the watcher excludes AND the `refreshFiles` walk excludes (the comment already says they must match — keep them adjacent). This one change removes it from model context, file tree, ZIP export, working copies, checkpoints, git pushes, AND defuses the restore-deletion hazard (a repo restore would otherwise delete `tasks.json` off the VM, whose absence breaks the template's port task). Do NOT touch `isSecretPath` (it doubles as restore-protection semantics). Add `.codesandbox/` to `OPAQUE_DIRS` as a second wall for any ingest path that bypasses the map.
  - Acceptance: walk spec proves `.codesandbox` is never listed nor read (readdir not called for it, same as `node_modules`); opaque spec covers the dir; live check after reload: file tree no longer shows `.codesandbox`, and a `git` push tree contains no `.codesandbox/` paths. **Plus (§11 M9): the watch leg finally gets tests** — fire a fake `onEvent` through the provider double and pin the enrichment wiring (which path reaches `client.fs.readFile`, read-failure → directory classification, the `disposed` gate on late events); and the SDK's acceptance of the `'**/node_modules'` exclude-glob shape is VERIFIED (unit against the double now, live count in T17 scenario 2) — an ignored exclude + one `npm install` floods thousands of enrichment reads straight through the 3,600 req/hr cap, which is the limit the spec says bites first.

- [x] **T9b** — Restores and mounts get the same map write-through the action runner got (§11 M7)
  - **Shipped 2026-07-28.** `restoreFiles` reports every restored file into the map synchronously
    (`#recordRestoredFiles`), mirroring `recordAgentWrite`: locks carried forward, binaries as
    `isBinary` + `size` with EMPTY content (base64 is a wire format), folders recorded. Placed BEFORE
    the `if (!options) return`, so the overlay callers (snapshot restore) get it too. Every restore
    door — checkpoint undo, working-copy restore, repo restore, git pull — funnels through this one
    function, so no caller needed changing.
  - 🔴 **The blocker the verifier found: it keyed the map off the RAW incoming path.** An incoming map
    may carry a FOREIGN root — that is why `SANDBOX_ROOTS` is a list, and a WebContainer-era working
    copy restored into a CodeSandbox project is exactly the cutover this plan performs. The disk write
    rebases; the map did not. So `serializeFiles({strict:true})` — the working-copy save and every
    checkpoint — threw `IncompleteSerializationError` on the first binary, and once the watcher caught
    up every restored file sat in the map TWICE. Now both sides go through `toProjectRelativePath`.
    ⚠️ The spec could not see it because its provider double keyed its disk by the raw string, so map
    and disk agreed by construction — **a double that does not resolve paths cannot observe a path
    disagreement.** It now uses the real `resolveInWorkdir`.
  - Also fixed while there: `restoreFiles`' own `toContainerPath` passed a foreign root through
    verbatim, which CodeSandbox rescued and WebContainer (a bare `container.fs`) would not — i.e. the
    documented rollback direction would have WRITTEN OUTSIDE the project.
  - **Pre-existing, recorded not fixed** (both shared with `recordAgentWrite`): `#size` double-counts
    once the watcher's own `add_file` fires (cosmetic — `filesCount` is display/`>0` only), and a
    restored path is not cleared from `#deletedPaths`, so a later `refreshFiles` drops a file that IS
    on disk. The second is pinned as a documented-behaviour test saying it is inherited.
  - Files: `app/lib/stores/files.ts` (`restoreFiles` ~L923), `app/lib/persistence/useChatHistory.ts` (repo-mount/restore branches), spec beside `files.ts`
  - Details: `recordAgentWrite` closed the stale-serialize race for ARTIFACT writes only. `restoreFiles` (checkpoint undo, working-copy restore, repo restore, git pull) still writes the disk and lets the watcher fill the map — an RTT-per-file enrichment on this provider — so a post-restore working-copy save or checkpoint can capture a stale mix: the exact measured second-session defect (generated `Home.tsx` beside the starter's `Home.css`) through a different door. Report every restored file into the map synchronously, same contract as `recordAgentWrite` (binaries as `isBinary` + size only, never content — §1.3 principle 10). Mount-path callers that pass the restored file object onward directly are already safe; the fix is for everything that SERIALIZES THE STORE afterward.
  - Acceptance: spec proves the map reflects a restore synchronously (no watcher tick) and a serialize immediately after restore returns the restored content, binaries as metadata (mutation: dropping the write-through fails it); WebContainer path behavior unchanged (its watcher was never the source of truth for this either — the write-through is provider-neutral).

- [x] **T9c** — Shell OSC waits: one demultiplexer, honest rc degradation (§11 M5 + M6)
  - **Shipped 2026-07-28.** ONE pump owns the single stream reader; `waitTillOscCode` registers a
    waiter and every signal in a chunk reaches every pending waiter. The per-waiter `break` is KEPT
    deliberately (each waiter folds the full list itself, so it only stops a wait that is already
    satisfied) — the defect was never the break, it was two loops sharing one `read()`, where the
    chunk carrying bash's `exit`+`prompt` pair went to exactly one of them and starved the other. The
    OSC carry and the expo buffer moved onto the pump, so a sequence split across a chunk boundary now
    survives even when the boundary falls BETWEEN two waits.
  - `ensureOscBashrc` ANSWERS instead of warning: `shell.beginOsc` is a getter that declares `'begin'`
    only for a shell that actually has the hook. A void return plus a warn was the whole M6 bug — a
    logged warning converting into "every shell action hangs forever".
  - **Three things the verifier found, each a silent permanent hang, all fixed:** `oscHookInstalled ||=
    success` **un-degraded an already-running shell** (`.bashrc` is read at shell START, so a later
    terminal's successful install re-armed the waits of the bash still running without the hook) — the
    claim is now decided by the FIRST spawn and frozen; a **rejected `read()`** parked every waiter
    forever and escaped as an unhandled rejection (pre-demux it rejected the caller) — the pump now
    rejects every waiter with the error, and `close()` still RESOLVES, because a dead shell is not an
    error; and a **guessed `$HOME`** made a write to `/root/.bashrc` "succeed" against a file bash may
    never read — `shellHomeDir` now reports `{path, resolved}` and an unresolved home installs anyway
    but declines to make the claim.
  - Also fixed in passing: two floating promises (`streamA.pipeTo`, `_watchExpoUrlInBackground`) leaked
    unhandled rejections on the same stream error.
  - Files: `app/utils/shell.ts` (`reduceOscSignals` break-early ~L154, `executeCommand`'s un-armed prompt-wait ~L405), `app/lib/sandbox/codesandbox-provider.ts` (`ensureOscBashrc` + the `beginOsc` declaration), `app/utils/shell.spec.ts`
  - Details: Two confirmed hazards, both in the "hangs silently forever" class. **(a)** `reduceOscSignals` BREAKS at the awaited code and discards the rest of the chunk's signals, while `executeCommand`'s un-armed prompt-wait and a parked start-action exit-wait share ONE stream reader. bash emits `exit`+`prompt` in a single chunk on Ctrl-C (the measured `MEASURED_PROMPT_CHUNK` shape), so whichever waiter receives that chunk starves the other — the live creations worked only because stale attach-draw markers happened to backfill the second waiter, a balance that is accidental and chunk-boundary-dependent. Fix structurally: one signal demultiplexer that consumes each chunk once and routes EVERY signal in it to every registered waiter's state machine — never break early, never let two waiters race one reader. **(b)** `ensureOscBashrc` is best-effort (a warn) but the provider *unconditionally* declares `beginOsc` — if the rc append fails (hardcoded `/root/.bashrc`; a non-root image; a transient fs error), every `waitTillOscCode` waits for markers bash will never emit: a logged warn converts into every-shell-action-hangs-forever. Degrade honestly: a failed install yields a shell WITHOUT `beginOsc` (armed-wait skipped, pre-fix semantics), and derive the rc path from `$HOME` rather than hardcoding root's.
  - Acceptance: shell spec adds the single-chunk `exit+prompt` case with BOTH waiters registered — neither starves (mutation: restoring the break-early fails it); a provider double whose rc install fails produces a shell without `beginOsc` and `executeCommand` still completes; every existing jsh/WebContainer spec passes byte-identical (that path has no `beginOsc` and must not change).

- [x] **T10** — Search tab honest "not supported" state
  - **Shipped 2026-07-28.** `textSearch: false` now renders a described panel and disables the input
    instead of running a search, logging to the console and falling through to "No results found." —
    which told the user, in the product's own words, that their code does not contain what they just
    searched for. Tab stays visible: a limitation you can read beats one you discover by being misled.
  - **`undefined` is a THIRD state, not a default.** While the sandbox is still connecting nothing is
    claimed (rendering "unavailable" for a second on every load is wrong; disabling the input under
    the user's cursor is worse), and a boot REJECTION also leaves it `undefined` — a sandbox that
    failed to boot is not one that cannot search, and it has its own loud surface.
  - ⚠️ **Two of the first-draft tests could not fail**, both found by mutation rather than review: the
    "no search executes" pin asserted only that the provider method was never called, which passes
    with the guard deleted because `performTextSearch` has its own capability check; and the
    empty-state pin typed AFTER the capability resolved, so the guard upstream made it vacuous. The
    binding version drives the real race — type while pending, resolve `false` mid-debounce — because
    that is the only path where the JSX gate is what stands between the user and the wrong answer.
    Nine mutations now caught.
  - Files: `app/components/workbench/Search.tsx`
  - Details: Read `capabilities.textSearch` into component state (await the sandbox in an effect). When false, render a proper panel ("Text search isn't available on this workspace runtime yet") instead of the misleading "No results found." empty state; disable the input. Keep the tab visible (discoverability of the limitation beats hiding it).
  - Acceptance: with a provider double reporting `textSearch: false`, the panel text renders and no search executes; with `true`, behavior unchanged.

### Phase C — economics, reporting, monitoring

- [x] **T11** — VM cost into the margin math (no per-user metering at launch)
  - **Shipped 2026-07-28** (`billing/vm-cost.ts`). "User project compute ≈ $0" is RETIRED as a claim
    and replaced by two explicit inputs kept deliberately apart — `SANDBOX_VM_USD_PER_HOUR` (MEASURED
    $0.074/hr Pico) and `SANDBOX_EST_VM_HOURS_PER_KCREDIT` (the ESTIMATE, 8.33 = CREDITS.md's ~120
    credits per active build-hour INVERTED) — plus `effectivePackMargin`, which re-runs the
    `MIN_PACK_MARGIN` floor with compute on the cost side. Measured 3.21× / 3.04× / 2.89× (Starter /
    Pro / Studio) = 68.8% / 67.1% / 65.4% GM, matching CREDITS.md's stated band. Assertion-only by
    design (no metering at launch) and stated as such.
  - ⚠️ **The predicate is `> 0`, not `>= 0`.** It shipped obeying a literal `0`, so
    `SANDBOX_VM_USD_PER_HOUR=0` would collapse `effectivePackMargin` onto `packMargin` and leave the
    new floor passing while asserting nothing — a config typo silently restoring the exact belief the
    task retires, contradicting the code's own comment and the spec.
  - ⚠️ **The first draft covered PACKS only** — and plans are a second, independently editable price
    array (which is why `subscriptions.spec.ts` already had its own LLM-only floor). A plan repriced
    into the gap clears the LLM floor and fails this one; the verifier proved it with $61.75/9,500
    (2.17× vs 1.80×). Both floors now run over both arrays. **A second floor that covers one of two
    revenue shapes is decorative.**
  - `effectivePackMargin` is now genuinely `packMargin × raw/(raw+vm)` — bit-identical to the first
    draft's re-derivation, but the pack price arithmetic exists once. The draft's comment claimed it
    was derived when it was not, true only because a test pinned it.
  - Files: `app/lib/.server/billing/stripe.ts` (or a sibling `vm-cost.ts`), `app/lib/.server/billing/billing.spec.ts`, `.env.example`, `spec/billing.md`
  - Details: Owner decision: bake in. Model the VM cost as an explicit, measured input — `SANDBOX_VM_USD_PER_HOUR` (Pico list price) and `SANDBOX_EST_VM_HOURS_PER_KCREDIT` (operator estimate, refined by T12's report) — and add a pure `effectivePackMargin(pack, { vmOverheadUsdPerCredit })` assertion beside the existing `packMargin` floor: every pack/plan must clear `MIN_PACK_MARGIN` AFTER VM overhead. Never fudge `CREDIT_MARGIN` itself or a cost input (the file's own warning). **The interim numbers already live in CREDITS.md §"Sandbox compute" (2026-07-27)** — ~+25% on raw cost ≈ 5–7 GM points at margin 4.0, `5.0` restores the ~75% target, same placeholder for BOTH providers by owner decision — T11 formalizes that derivation into the tested floor; keep the two documents agreeing (the placeholder's credits-per-active-hour assumption IS `SANDBOX_EST_VM_HOURS_PER_KCREDIT`, inverted). Document in `spec/billing.md` that "user project compute ≈ $0" is retired and what replaces it (the §7/§8 SPEC.md flags for this landed 2026-07-27).
  - Acceptance: new margin-floor-with-VM-overhead test passes at current pack prices with the measured Pico rate and a stated hours estimate; the test FAILS if the estimate is set to an absurd value (proving it binds); `.env.example` documents both vars with the derivation.

- [x] **T12** — VM lifecycle marks + per-user VM-hours on the Admin tab
  - **Shipped 2026-07-28.** Append-only marks (`sandbox/usage-store.ts`, FS JSONL + Supabase, migration
    `0014`, RLS-with-no-policy) emitted from `service.ts`'s create/resume/hibernate/delete via a threaded
    `SandboxAttribution`; pure `buildVmReport(marks, now, {topN, maxIntervalMs})` pairs them into
    VM-hours; joined onto `/api/admin/usage` like `providerBalance` and rendered as a "Sandbox VM time"
    section. The ledger's own rule, applied to hours: marks are facts, hours are DERIVED.
  - 🔴 **A close mark is written only when the VM actually stopped.** A failed hibernate returns BEFORE
    marking — recording the close anyway would end the interval in the report while the meter kept
    turning, i.e. under-state cost at exactly the moment the cost is real. Same for a failed delete.
  - ⚠️ **An unclosed interval is CLAMPED (24h) and the clamp count is reported.** The common way a VM
    stops is the provider's own idle timeout, which happens with nobody to tell — so those intervals
    never receive a closing mark, and counting them to `now` would have a six-minute VM contributing a
    month of hours. The clamp is a ceiling, not a measurement, which is why `clamped` sits beside it.
  - ⚠️ **"Cannot throw" is not "cannot block."** `recordSandboxMark` runs on the path a user is waiting
    on, so it races the write against `MARK_WRITE_DEADLINE_MS` and REPORTS a timeout — a store that
    hangs was otherwise the one failure this module could not see, contradicting its own doc comment.
    Pinned with fake timers (mutation-verified: deleting the race fails it).
  - The verifier's first pass FAILED on something neither the tests nor typecheck could see: the new
    spec's `vi.mock('@codesandbox/sdk')` tripped `sandbox-seam.spec.ts`'s default-deny scan, so the
    whole suite was red. Allow-listed with a written reason mirroring the boot spec's mock-target
    carve-out (`usage-store.ts` itself imports no SDK — checked, not assumed). **Run the full suite, not
    the files you touched: a default-deny scan fails in a file you never opened.**
  - Files: `app/lib/.server/sandbox/usage-store.ts` (new: append-only lifecycle marks — create/resume/hibernate/delete, `{projectId, userId, sandboxId, event, at}`), `app/lib/.server/admin/vm-report.ts` (new, PURE), `app/routes/api.admin.usage.ts`, `app/components/@settings/tabs/admin/AdminTab.tsx`, `vm-report.spec.ts`
  - Details: Emit marks from `service.ts`'s create/resume/hibernate/delete (best-effort, never fails the operation). Pure `buildVmReport(marks[])` pairs resume→hibernate intervals into VM-hours (an unclosed interval counts to `now` passed in as an arg — no `Date.now()` in the pure core), aggregates total + per-user top-N. Join onto the usage route like `providerBalance` (a failure renders "unavailable", never breaks the dashboard); render a "Sandbox VM time" section beside "Usage & cost". This is the measurement that decides whether metering ever needs to exist.
  - Acceptance: `buildVmReport` exhaustively tested (paired, unclosed, out-of-order, multi-user); Admin tab shows total VM-hours + per-user rows against seeded marks; a usage-store outage leaves the rest of the usage report rendering.

- [x] **T13** — Sandbox monitoring + health key
  - **Shipped 2026-07-28** (`monitoring/sandbox-rates.ts`). Three `sharedRateWindow`s —
    `sandbox:create`, `sandbox:resume`, `sandbox:clean-boot` — fed from the session route on EVERY
    provider attempt, success included. `app/lib/.server/sandbox/*` imported no monitoring at all
    before this: every failure on the path that decides whether a user can open their project was a
    `logger.warn`, i.e. invisible in production.
  - **A CLEAN resume is a SUCCESS with a cost, and it gets its own window and its own signal**
    (`SANDBOX_CLEAN_BOOT_RATE`, `warning`, not `critical`). The request worked; the snapshot did not.
    The files came from the working copy rather than the VM, which is the closest thing this subsystem
    has to a data-loss signal — and no failure metric can ever show it.
  - **A 429 records NOTHING.** That is US refusing, not the provider failing; counting it would let one
    user's reload loop trip a platform-wide "nobody can start a project" alert. The 503 `refuse` branch
    DOES record a resume failure — it is only reached when the provider is unreachable, which is exactly
    the condition the window exists to surface.
  - 🔴 **Health reports `codesandbox` ONLY when the build uses it.** `VITE_SANDBOX_PROVIDER` is a
    build-time switch, so a WebContainer image has correctly dropped `CODESANDBOX_API_KEY` — reporting
    it degraded there would drag `ready` to false forever on a healthy deploy, the mirror image of the
    `platformKey` bug the same file already records. Config presence only; no reachability probe (a
    live call there would let a provider outage flip the uptime monitor and start a retry storm).
  - ⚠️ Scoped deliberately: the windows cover the PROVIDER call. A `createBrowserSession` or
    `store.update` failure AFTER a successful fork records the attempt as a success while the user gets
    a 500 — filed, not fixed, and worth its own window if session minting ever proves flaky.
  - Files: `app/lib/.server/monitoring/events.ts` (`SANDBOX_FAILURE_RATE`), a `recordSandboxOutcome` helper beside `paid-path-rates.ts`, `app/routes/api.sandbox.session.ts`, `app/lib/.server/monitoring/health.ts` + `health.spec.ts`
  - Details: Rate windows `sandbox:create`, `sandbox:resume`, and a separate `sandbox:clean-boot` (a CLEAN resume is silent-data-loss-adjacent, not a failure) — record EVERY attempt, not just failures (the `proxy.ts:1701` lesson). Alert through `getMonitor(context).alert(…)` on threshold. Health: add `codesandbox: isSandboxConfigured(context) ? 'ok' : 'degraded'` — config presence ONLY, no reachability probe (the endpoint's stated contract; reachability lives in the rate windows).
  - Acceptance: session route spec proves success AND failure both record into the window (mutation: recording only failures fails a test); health spec covers configured/unconfigured; monitoring never throws into the request path.

### Phase D — template pipeline

- [x] **T14** — CSB template pin: promote/rollback from the Admin panel
  - **Shipped 2026-07-28** (`sandbox/template-pin.ts`, `api.admin.sandbox-template.ts`, an Admin
    section beside "Starter template"). Precedence **promoted pin > `CODESANDBOX_TEMPLATE` > baked
    `btk@starter`**, decided by one pure function that the fork path AND the panel both read — two
    copies of a precedence rule is how a panel ends up confidently describing a decision the runtime
    is not making.
  - 🔴 **The honest difference from `templates/pin.ts`: CodeSandbox holds the bytes, we hold only the
    POINTER HISTORY.** That module can promise a rollback target's bytes are unchanged because it
    stored them. We cannot, and writing anything that implied otherwise would be a false claim about
    somebody else's storage. Rollback is still recorded, auditable and one click — it is just not
    byte-immutable, and it re-validates nothing (the target passed when promoted; CodeSandbox may have
    deleted it since, in which case the fork fails LOUDLY rather than falling through to live).
  - **Promote forks the candidate for real** (`validateSandboxTemplate`) and stats four sentinel files
    before the pin moves — sentinels, never a count. The probe is reaped on BOTH paths, so refusing
    costs no more than accepting, and it carries a 60s hibernation timeout so a crash between fork and
    reap stops billing quickly. It deliberately bypasses the T5 cap and the create rate limit: those
    bound what USERS spend, and counting an admin's probe would let the cap refuse the repair at the
    moment of the repair.
  - ⚠️ **The verifier caught a path bug the mocks never could:** the sentinel stats were RELATIVE, and
    the measured SDK rule is that everything but `batchWrite` is absolute — every promotion would have
    422'd with "missing package.json", blaming the template for a path bug. Now resolved against
    `client.workspacePath` (the SDK's own answer, not our `WORK_DIR` — this is an arbitrary candidate
    image, and asserting our root onto someone else's is how a valid template gets refused).
  - The sync/async seam is the market-price one, deliberately (`activeSandboxTemplatePin()` +
    `ensureSandboxTemplatePin()` at the session route's doorway) — a failed refresh KEEPS the previous
    pin, because reverting to "no pin" on a storage blip silently returns every new project to the env
    default the pin was promoted to replace.
  - ⚠️ Still owed by T15/T17: no promotion has been driven against real CodeSandbox. `.env.example`
    now warns that a pin silently outranks `CODESANDBOX_TEMPLATE`.
  - Files: `app/lib/.server/sandbox/template-pin.ts` (new: pointer history + pure `decideSandboxTemplate`), `app/lib/.server/sandbox/config.ts` (`sandboxTemplate()` prefers the promoted pin over env), `app/routes/api.admin.sandbox-template.ts` (new, `requireAdmin` both halves), `AdminTab.tsx` (section beside "Starter template"), specs
  - Details: Mirror `templates/pin.ts` exactly where it applies: immutable pointer HISTORY (CodeSandbox holds the bytes; we record `{target, promotedAt, promotedBy, provenance}`), validate-before-re-point (fork the candidate template once, assert it boots + contains the sentinel starter files, then record), rollback only onto a target already in the history. Precedence: promoted pin > `CODESANDBOX_TEMPLATE` env > baked `btk@starter` — each priced… each VALID in its own right (a pin pointing at a deleted template falls through loudly, never silently to live).
  - Acceptance: `decideSandboxTemplate` pure-tested (no pin → env/default; pin → pin; corrupt pin ≠ outage); promote validates before recording (a candidate failing validation leaves the pin unchanged, 422); Admin section lists history with one-click rollback; `sandboxTemplate()` callers all flow through the decision.

- [x] **T15** — Rebuild `btk@starter` clean and promote it
  - **BUILT AND LIVE-VERIFIED 2026-07-28; owner actions CLOSED 2026-07-29** — the AppTemplate changes
    are committed (`62a34a9 "Base Path Updates"`) and the current promoted pin is
    `btk@starter-20260728c` (built from that committed state; it supersedes `-20260728b`, which
    therefore never needs promoting). Only the HMR-over-wss browser check remains un-driven (minor).
    Alias **`btk@starter-20260728b` → `pt_KQF2CZ3eMvpAuL3cFKK8ge`**, built from the owner's checkout at
    `Repositories/StarterProjects/AppTemplate` (staged clean: no `node_modules`, no `.git`). Live
    `btk@starter` is UNTOUCHED — a new alias, so nothing forks it until an admin promotes it through
    T14's panel. **The owner's remaining actions: promote it, and re-drive HMR in a browser.**
  - 🔴 **THE FIRST BUILD PRODUCED A TEMPLATE THAT INSTALLS CLEANLY AND CANNOT RUN — and `npm install`
    said nothing.** The starter is on **Vite 8**, whose rolldown core ships its native binary as an
    OPTIONAL dependency with engine `^20.19.0 || >=22.12.0`. The default CodeSandbox image is **node
    v20.12.1**, and npm SKIPS an optional dep whose engine does not match: `WARN EBADENGINE`, exit 0,
    `@rolldown/binding-linux-x64-gnu` simply absent, and then `Cannot find module
    '../rolldown-binding.linux-x64-gnu.node'` when the dev server starts. MEASURED that neither
    `npm ci` (18s) nor deleting the lockfile and reinstalling (91s) repairs it — **the node version was
    the cause, not the lockfile**, and a whole afternoon could be spent on the lockfile instead. Fixed
    by adding `.codesandbox/Dockerfile` (`FROM node:22-bookworm`), which the live template already had
    in `node:20-bookworm` form and my staged copy did not.
  - 🔴 **The live `btk@starter` is a DIFFERENT, OLDER starter than the owner's checkout** — measured on
    a fork: **Vite 5.4, port 3000, `runAtStart: true`**, and it still carries `src/main.js` +
    `public/havok.wasm`. The checkout is **Vite 8.1.5, port 5173**. So promoting this is not a cleanup,
    it is a **starter upgrade**, and the owner should read it as one. It also FIXES a latent mismatch:
    `mount.ts`'s `STARTER_DEV_PORT = 5173` has never matched the live template's 3000, so
    `clearInheritedDevServer` has been clearing a port nothing was ever on.
  - **Measured on a real fork of the new template** (probe VMs reaped; `csb`'s two example sandboxes
    shut down): debris `(none)` — all four gone; `npm install` at creation **2s, "up to date"** (so
    `node_modules` is genuinely baked); **`VITE v8.1.5 ready in 402ms`**; `curl localhost:5173` →
    **200**; open ports **[5173]**; **zero** `xdg-open` errors; and exactly ONE dev server —
    `ps -eo args` shows a single `node /project/workspace/node_modules/.bin/vite`.
    ⚠️ `pgrep -f <pattern>` MATCHES ITS OWN SHELL, so an earlier "count = 1" was the pgrep process on a
    template with NO server running. Count dev servers with `ps -eo args | grep "[n]ode …"`.
  - `runAtStart: false` settled as the plan decided, and it has a build consequence worth writing down:
    **`csb build` must NOT be given `--ports`**, or it waits 60s for a port nothing will open and fails
    with a timeout that reads like a broken template. Recorded in the template's own
    `.codesandbox/README.md`.
  - **Left uncommitted in the owner's AppTemplate checkout for review:** `vite.config.ts` (dropped
    `open: true`, added `server.hmr: {clientPort: 443, protocol: 'wss'}`) and a new `.codesandbox/`
    (`Dockerfile`, `tasks.json`, `README.md`).
  - **Still owed:** HMR-over-wss in a hosted preview (needs a browser → T17), and the promote itself.
  - Files: template working dir (owner's starter checkout — locate at execute time; NOT this repo's `app/`), `scripts/` helper if useful
  - Details: From a clean starter checkout: delete the probe debris baked into the current template (`src/main.js`, fake 512KB `public/havok.wasm` — the real one lives in `public/scripts/`, `src/scripts/ArcadeRacingMode.ts`, `src/scripts/Simple3dSceneMode.ts`); `vite.config.ts`: remove `open: true` (the `xdg-open ENOENT` noise), add `server.hmr: { clientPort: 443, protocol: 'wss' }`; settle `runAtStart` — the template's task must NOT auto-start a dev server that fights the artifact's `npm run dev` (decide: task present but `runAtStart: false`, since the platform starts the server itself and T6 handles wakes). `csb build --alias` to a NEW version; validate + promote through T14's panel (owner clicks promote).
  - Acceptance: a fresh project forked from the promoted template contains none of the four debris files, prints no `xdg-open` error, HMR connects over wss in the hosted preview, and exactly ONE dev server runs after creation (verified in the terminal).

### Phase E — deploy wiring + live verification

- [x] **T16** — Production build + deploy wiring
  - **IMPLEMENTED 2026-07-28; box left unchecked only because the independent re-verification was still
    running when the session was stopped.** Gates green (typecheck, lint, 3059 tests), and the
    acceptance was driven for real: `VITE_SANDBOX_PROVIDER=codesandbox pnpm build` +
    `wrangler pages dev` → **`GET /healthz` 200 with `"codesandbox":"ok"`**.
  - 🔴 **THE PRODUCTION IMAGE COULD NOT SERVE A SINGLE REQUEST, AND THIS HAD NOTHING TO DO WITH
    SANDBOXES.** `service.ts` statically imported `@codesandbox/sdk`, whose ESM entry calls
    `createRequire(import.meta.url)` at module scope — and `import.meta.url` is `undefined` under
    **workerd**, which is what `pnpm run dockerstart` runs. It threw while the server bundle was still
    evaluating, so **every route 500'd**, including `/healthz` — the path Lightsail's health check
    polls, meaning the deployment could never have reached ACTIVE. Auth, billing and generation were
    all down for a package none of them use; it was merely in the same bundle. Fixed with a lazy
    `loadSdk()` (`await import(...)` at first use; the type import is erased).
  - 🔴 **AND NO PLATFORM SECRET WOULD HAVE REACHED THE APP.** `bindings.sh` greps
    `worker-configuration.d.ts` for names and forwards only those, because under workerd `process.env`
    is EMPTY. That file listed only upstream's provider keys — so a production container would have
    booted with **no Supabase, no Stripe, no S3, no KIE key and no CodeSandbox key**. Every one of
    those degrades to "not configured" rather than crashing (§1.3 principle 0), which is exactly why it
    would have been invisible: the app serves happily while unable to bill, authenticate or open a
    sandbox. The platform block is now in that file, with a header saying it IS the delivery mechanism,
    not a type declaration — **a new `env(context, 'X')` read means a new name there.**
  - Both defects were **pre-existing at HEAD** and neither was introduced by this plan. They were found
    only because the verifier ran the documented production command instead of reading it.
  - Also: `Dockerfile` gained `ARG`/`ENV VITE_SANDBOX_PROVIDER` in the build stage; DEPLOY.md gained the
    `CODESANDBOX_*` table (7 vars, defaults checked against `config.ts`), both build commands, the
    CodeSandbox commercial-terms OWNER ACTION, and a "promote the sandbox template per environment"
    item. Two doc lies fixed: `/healthz` no longer claims to check "DB reachable / S3 credentials
    valid" (it is config-presence-only BY CONTRACT — a live probe there would let a Supabase blip cycle
    containers), and the "which build is this?" check now names the `webcontainer-provider-*.js` chunk
    instead of `/home/project`, which appears in BOTH bundles.
  - ⚠️ A local `pnpm build` with no explicit value silently inherits `.env.local`; only the Docker build
    is authoritative (`.dockerignore` excludes `*.local`). Documented.
  - **RE-VERIFIED 2026-07-28 (independent verifier) — all three acceptance clauses hold.** `/healthz` on
    the real production build: **HTTP 200, `"codesandbox":"ok"`**. The chunk discriminator was proven by
    a CONTROL rather than asserted: a `VITE_SANDBOX_PROVIDER=webcontainer` build emits
    `webcontainer-provider-*.js` and zero `codesandbox-*` chunks, the codesandbox build the exact
    inverse. Stronger still, `@webcontainer/api` itself is **absent from the CodeSandbox bundle** (the
    control's copy is identifiable by its `"WebContainer already torn down"` string; the codesandbox
    build has no file containing it), so no code path survives that *could* fetch the WASM — which is
    what the acceptance actually asks, and is a claim the chunk NAME alone cannot support. The surviving
    `webcontainer.connect/preview._id-*.js` are dead upstream ROUTES (1 byte and 1.2KB, no vendor
    import), not the provider. The container branch of `bindings.sh` was simulated separately (no
    `.env.local`, copied to /tmp) because the local `/healthz` run exercised only the `.env.local`
    branch — the two are different code paths and only one of them ships.
  - ⚠️ **`indexedDB is not available in this environment.` is logged once at workerd startup — non-fatal,
    PRE-EXISTING at HEAD, not introduced here.** Every route returns 200 after it. It comes from
    `app/lib/persistence/db.ts` (an upstream CLIENT persistence module being SSR'd), which is unmodified
    on this branch. Recorded because it is the same SHAPE as the two defects T16 did catch (a
    module-scope side effect workerd cannot satisfy) and the next person reading the log deserves to
    know it was investigated and is benign, rather than re-investigating it.
  - ⚠️ **Not a defect, but it cost an hour: `wrangler pages dev ./build/client $bindings` must run under
    `sh`, not `zsh`.** zsh does not word-split an unquoted expansion, so the whole binding string arrives
    as ONE argument and wrangler fails with `Unknown argument: binding LLM_MODEL` — which names the FIRST
    variable in `.env.local` and reads exactly like a malformed env entry. `pnpm run dockerstart` is
    immune (npm scripts run under `sh`). A plausible-but-wrong fix (skipping empty-valued bindings, to
    match the process-env branch) was written and then REVERTED when the real cause was found —
    `bindings.sh` is unmodified at HEAD. Both branches of that script are fine as they stand.
  - ⚠️ `usesCodeSandbox()`'s `|| process.env.VITE_SANDBOX_PROVIDER` arm can disagree with the bundle if an
    operator sets the var on a WebContainer image — deliberate, fail-toward-`degraded`, test-pinned, and
    the one observable (harmless) exception to the "never an env flip" rule. Filed, not changed.
  - ⚠️ `docker build` itself was NOT run; the `ARG`/`ENV` wiring is verified structurally (build stage,
    before `COPY . .` and `RUN pnpm run build`) plus the equivalent host build.
  - Files: `DEPLOY.md`, Docker/build config (wherever the production image is built), `.env.example`
  - Details: `VITE_SANDBOX_PROVIDER=codesandbox` is a BUILD-time switch — bake it into the production image build args; document that rollback to WebContainer is "deploy the previous image", never an env flip on a running container (the client bundle already chose). `CODESANDBOX_API_KEY` + `CODESANDBOX_*` tunables go to SSM → container env alongside the existing secrets; verify `assertNotLocalInProduction` posture unchanged. Note the licensing/commercial check as an owner action item in DEPLOY.md: confirm the CodeSandbox plan covers embedding/reselling VM time (the `spec/licensing.md` StackBlitz precedent) and is sized for launch concurrency.
  - Acceptance: a production build produced by the documented command serves the CodeSandbox provider (no WebContainer WASM fetched); DEPLOY.md's SSM table lists every `CODESANDBOX_*` var with defaults; health endpoint on that build reports `codesandbox: ok`.

- [x] **T17** — Live verification pass of the never-driven money paths
  - **ALL TEN scenarios done 2026-07-28 (the acceptance's "all nine" is corrected to TEN here).**
    - **(3) asset upload:** driven via Settings → Assets → Upload asset: a PNG accepted, listed under
      "Your uploads", `user_assets` record written, and the stored object is **sha256-identical** to the
      uploaded bytes (`57cda64c…`). Validation/quota refusal paths not exercised (unit-covered in
      `assets/validate`).
  - **Results (2026-07-28 evening session, all against real CodeSandbox):**
    - **(2) request rate: ~26 REST calls in 81 minutes** (13 session mints, 4 forks, 9 resumes) across THREE
      full creations plus heavy reopening — ~1% of the 3,600/hr cap. File traffic rides one Pitcher
      websocket per client (not REST); the baked `node_modules` makes the creation install a 2s no-op, so
      no enrichment flood. The T9 excludes held (no `node_modules`/`.git`/`.codesandbox` ever appeared in
      the map).
    - **(4) media delivery:** three creations × 2 images each, delivered into `public/assets/generated/`
      and written through; the 3.4MB hero JPEG is sha256-IDENTICAL across VM → ZIP export and VM → publish
      → `/play` serve (and a 4.6MB transparent PNG likewise served intact).
    - **(5) restore/undo: the MACHINERY is proven** (both refusal paths fired honestly — "no earlier
      state" / "no checkpoint for this message" — and `restoreFiles` containment is T17a-pinned), but a
      REAL cross-checkpoint restore is impossible because **checkpoints silently stop after the first
      machine message on CSB → filed as T17c** (found here, confirmed by scenario 9).
    - **(6) Export ZIP: byte-faithful.** 113 files; `havok.wasm` (2,094,566B) and `glslang.wasm`
      sha256-identical to template source; generated media identical to the published copies.
    - **(7) two browsers, one project:** second tab mounted the same project in 15s; both Pitcher clients
      live on one VM; no watcher echo storms, no terminal contention, first tab unaffected.
    - **(8) A→B→A in one tab:** each switch landed on the CORRECT per-project VM (`rdkhpl` → `3n53kf` →
      `rdkhpl`), ~12s per switch, no cross-project adoption, disk edits survived the round trip.
    - **(9) kill recovery:** VM deleted provider-side (shutdown → delete) → reload → fresh VM `28ql27`
      minted via resume→create fallback in 52s, working-copy restore refilled it, no permanent 503, no
      silent template adoption. ⚠️ It restored the STARTER, because the working copy was pinned at the
      stale seq-0 checkpoint — the T17c defect's cost, measured end-to-end.
    - **(10) wake check:** dev server killed inside the VM (`pkill` — note `pkill -f vite` kills its own
      SDK shell, the plan's own pgrep trap; and the kill tears the shared PTY, the T9c coupling) +
      hibernate → reload → boot narrated "Getting the project ready…", exactly ONE vite restarted
      (`ps` count 1, curl 200), preview back in 39s with zero typing.
    - **Bonus live coverage:** a real self-remix fired (`/remix/:shareId` auto-POSTs on load — a stray
      badge click in a blank tab minted "Blank Canvas (copy)", 94-file clone, opened clean); `/remix/:shareId` auto-remixing on page LOAD is recorded as BY DESIGN
      (following the badge link IS the intent; the stray-click clone was a human misclick in a blank tab)
      — revisit only if unwanted clones recur; the cache
      warmer ran live (`6 sent, 6 reads, 0 writes`); the flat creation price charged exactly 500 + media
      on all three creations; a warm creation ran 79.7s vs 205/247s.
    - **Scenario 1 — publish + peak build memory: MEASURED.**
      **Pico survives the Babylon rollup build, but only just.** Sampling `free -m` every 0.3s from
      inside the same shell as the build (a `nohup`'d sampler does NOT survive `commands.run`, and
      `/usr/bin/time` is absent from the image):
      ```
      baseline (dev server running):    931 MB
      PEAK during build:              1,958 MB   of 2,053 MB total (1 vCPU)
      headroom:                          95 MB   (4.6%)
      build: 9.19s, exit 0, dist 25M, babylon chunk 11,020 kB (2,442 kB gzip)
      ```
      It did not OOM only because 2 GB of swap sits behind it. **A per-build `updateTier` bump is not
      needed today and IS worth pricing** — 95 MB is not margin, it is luck, and the number that erodes
      it is the user's own asset count. Publish wall time end-to-end: 32s. Project reopen (resume of a
      hibernated VM): 12s.
      🔴 The published game then **does not run** — see **T17b**, filed. Publish succeeds; the artifact
      it publishes is broken, and has been since the template's initial import.
  - Files: none (drive the real product; record findings in `spec/sandbox-codesandbox.md`)
  - Details: One deliberate session on the real provider, in this order: **(1)** Share/publish end-to-end (`vite build` in the VM — record peak memory; decides whether Pico survives a full Babylon rollup build or the publish path needs a per-build `updateTier` bump); **(2)** request-rate during a full creation generation vs the 3,600/hr API limit (count Pitcher/API calls; the watch channel is the suspect — including an `npm install` with T9's excludes in place, which live-verifies the SDK honors the glob shape); **(3)** asset upload via the Assets tab; **(4)** media generation delivery; **(5)** checkpoint restore/undo over a live VM; **(6)** Export ZIP byte-integrity (spot-hash a binary); **(7)** two browsers on ONE project (two Pitcher clients, one VM — watcher echo, terminal contention); **(8)** project switch A→B→A in one tab (T3's live proof); **(9)** kill recovery: delete the VM provider-side (and separately let a snapshot expire if feasible) → reload → T2's resume→create fallback mints a fresh VM and the working-copy/repo restore refills it — no permanent 503, no silent template adoption (T3f); **(10)** T6's deferred wake check — hibernate the
    sandbox, kill the dev server from the terminal, reload → the preview comes back with no typing and the
    boot screen reads "Getting the project ready…" during the restart (the code half shipped 2026-07-27;
    only this drive is owed). Fix-or-file every defect found — the MCP-relay precedent says expect defects precisely here.
  - Acceptance: all ten scenarios run against the real provider with results (numbers, not adjectives) recorded in `spec/sandbox-codesandbox.md`'s status block; every defect found is either fixed with a pinned test in this pass or filed as an explicit follow-up task appended to this plan.

- [x] **T17a (FILED 2026-07-27 while attempting T6's live check — two defects, neither introduced by T6)**
  - **SHIPPED + VERIFIED 2026-07-28 (independent verifier PASS, mutation-checked; 195 files / 3,232 tests green; live re-driven).**
    **(1) EISDIR:** classified at the seam (`isDirectoryPathError`, `codesandbox-translate.ts`, pinned against the
    measured wire string); `writeSerializedFileMap` gained per-entry containment (`onError` — one bad entry is
    reported and skipped, the rest of the map lands; without `onError` the historical throw is preserved);
    `restoreFiles` filters `MAP_EXCLUDED_DIRS` from INCOMING maps (a pre-T9 checkpoint carrying `.codesandbox/…`
    was the write-over-a-directory source) and never throws per-file failures; `openFromServer` is tri-state —
    `'not-found'` (offline/foreign id) still falls back to the browser's copy, but a MOUNT failure is `'failed'`:
    `handleOpenFailure` surfaces it (classified → boot failure + Retry; else warn + ready) and the caller RETURNS,
    so the legacy `prepareToRun:false` mount is structurally unreachable from a failed primary open.
    **(2) files-phase counts:** `restoreFiles`/`writeSerializedFileMap` report (done, total) and all five restore
    call sites feed `bootProgress {step:'files'}` — observed live: "… of 113 files" ticking on a real reopen, and
    the dev log shows zero `IsADirectory` / `Could not open chat` / `from: local` across the session's reopens.
    ⚠️ Honest gap: the tri-state itself has no hook-level unit test (no harness exists; code-read + live negatives
    only). The `protect` option became optional for the progress ride-along — the legacy overlay site's semantics
    are UNCHANGED and pinned ("no protect deletes NOTHING", with a with-protect control).
  - **(1) `openFromServer` dies with `Os { code: 21, kind: IsADirectory }` and falls back silently.**
    MEASURED opening an existing project (`prj_20260728000041_zjvg0au2`): the transcript restored fine
    ("Restored 3 message(s)"), the sandbox came up (`Sandbox qt6f3c … (FORK, newly created)` — the
    recorded VM was gone, so T2's resume→create fallback worked), and then the mount threw a raw
    provider `EISDIR`. The console shows `Could not open chat … from the server: 21: Os { … }` TWICE,
    after which the flow drops to the legacy IndexedDB path (`Mounting project … from: local`, the one
    that passes `prepareToRun: false`). So a provider fs error on the primary open path is downgraded
    to a warn and the user silently gets the fallback mount — including no wake hook. Find the `readFile`
    that is handed a directory (the enrichment/refresh leg is the suspect — T9's `.codesandbox` excludes
    and T9's untested watch leg are both in that neighbourhood) and classify the error rather than
    letting it escape as a raw `Os {}` string.
  - **(2) The `files` phase stalls with no counts and no ceiling.** After the fallback, the boot screen
    sat at "Loading project files… · 220s" and was still climbing when the session was abandoned — the
    restore branches never report progress (only `refreshFiles` has the done/total callback), so a slow
    or wedged restore is indistinguishable from a hang. RTT-per-file on this provider makes that the
    normal case, not the edge one. Needs progress on the restore path and a bound/described failure.
  - Acceptance: the EISDIR is reproduced in a spec against a provider double and classified (the primary
    open path no longer silently degrades to the legacy mount); the `files` phase reports counts on the
    restore branches; both re-driven live.

- [x] **T17b (FILED 2026-07-28 by T17 scenario 1 — 🔴 EVERY PUBLISHED GAME IS BROKEN, and always has been)**
  - **SHIPPED + LIVE-VERIFIED 2026-07-28 (verified: independent subagent, PASS on all 4 criteria; tests: 195 files / 3,220 green).**
    The defect had TWO layers, and the second only became visible once the first was fixed: **(1) assets** —
    `base: "/"` made the built `index.html` request `/index.js` at the origin root (the filed bug); **(2) routing** —
    `<BrowserRouter basename={import.meta.env.BASE_URL}>` matched nothing under the share prefix, and the nav
    adapter's full reload (`window.location.href = path`) escaped the prefix entirely. **Routing was broken for
    every share independently of the assets — nobody ever saw it because the assets 404'd first.**
    Fixes (a)+(b) both taken, plus a serve-layer third: **(a)** the share build passes `--base=./` via
    `SHARE_BUILD_COMMAND` (`app/lib/runtime/build-command.ts`, exact-match allow-list — the model's output channel
    can only SELECT between two fixed argv arrays, never shape one), repairing existing projects with no rebuild;
    server backstop `rootAbsoluteEntryRefs` + `RootAbsoluteAssetError` (422, pre-write) refuses a root-absolute
    entry HTML so the bug can never ship silently again. **(b)** template-side in the owner's AppTemplate checkout
    (COMMITTED 2026-07-29 as `62a34a9 "Base Path Updates"`): `base: "./"`, runtime `appBasename()` (resolves `BASE_URL` against the
    document URL — `/` in dev, `/play/<id>/` on a share), prefix-preserving reload in `adpter.tsx`. Built +
    promoted as alias `btk@starter-20260728c` (pt_JRRv5CbnsugrpDaqHzNWqs), which remains the CURRENT pin —
    it matches the committed checkout, so no rebuild or further promote is owed. **(c)** `resolvePlayRequest` (`serve.ts`): the wrapper's iframe loads the
    DIRECTORY URL `?embed=1` (never `/index.html`, which leaves a route path no router matches); `embed` or
    `sec-fetch-dest: iframe` gets the game DOCUMENT for any extensionless path (SPA fallback scoped to the
    iframe), a no-signal browser degrades to the wrapper — never 404, never recursion.
    **Live proof** (share `q97my8gfur5t`): `/index.js` → 200 `text/javascript`; landing renders in the iframe;
    ENTER THE STUDIO → `/play/q97my8gfur5t/play` (prefix kept) → Babylon canvas + splash live.
    ⚠️ **Found on the way, each its own note:** CSB **alias propagation lag** — a fork 19s after promoting a
    freshly built alias got the PREVIOUS bytes (self-healed in minutes; a probe fork confirmed the alias serves
    the new code — do not trust the first fork right after a promote); **publish/deploy raced applying actions**
    — publishing mid-generation shipped a half-written tree under a green "Build Completed" → `decidePublishReadiness`
    now refuses (running `start` actions excluded — the dev server runs forever and the first draft refused every
    publish, stuck closed, caught live); the **save-reminder toast fired mid-creation** (checkpoint after the first
    machine-written message) → `NudgeFacts.applying` gates every nudge until streaming ends and actions settle;
    my interim template build **dragged checkout junk in** (`.DS_Store`, `Screenshot.png`, `.gitmodules`,
    `*.tsbuildinfo`) — the staging excluded only `node_modules/.git/dist`; the owner's clean rebuild supersedes it,
    and the rebuild script must exclude those.
  - **MEASURED.** Published a real game (`/play/rnxqq79ujdtz`, project `prj_20260728141124_0hs9gnb7`).
    Publish itself SUCCEEDED end-to-end in 32s — VM build, upload, share link, 20.6MB remix seed
    deposited at the derived key. Then the game does not boot. Its `index.html` asks for
    **root-absolute** assets:
    ```
    <script type="module" crossorigin src="/index.js">
    <link rel="stylesheet" crossorigin href="/index.css">
    ```
    but a share is served under a PREFIX, so the browser requests `http://<app>/index.js` →
    **404, and the 404 body is the BUILDER app's own HTML shell (2,473 bytes, `content_type: text/html`)**.
    The real asset is at `/play/rnxqq79ujdtz/index.js` → 200, 5,659 bytes, `text/javascript`. A module
    script served as an HTML 404 page fails silently in the console; the play page renders the badge and
    nothing else (measured `document.body.innerText.length === 52`).
  - 🔴 **ROOT CAUSE: `vite.config.ts:74` → `base: "/", // Ensures assets are correctly referenced`.** The
    comment asserts precisely what the line prevents — the same false-claim-in-a-comment failure mode as
    the shell-strip's "still streams in real time". Traced via `git log -S` in the owner's AppTemplate
    checkout to commit `c647bf4 "Project Files"` — **the initial import**. NOT introduced by T15's
    template rebuild; the old Vite 5.4 template carries it too.
  - 🔴 **PRODUCTION IS NOT EXEMPT — checked, not assumed.** The tempting reading is "local dev serves
    same-origin under `/play/`, but production has its own `PLAY_URL` origin so `/` is right there".
    False: `buildContentKey(shareId, requestPath)` (`share/serve.ts:39`) resolves `/play/:shareId/<path>`
    into the share's object prefix **on the play origin too**. There is no deployment in which a share is
    served at an origin root, so `base: "/"` is wrong everywhere.
  - **HOW IT SURVIVED — worth generalising.** Publish was verified as *"it publishes"*: the spec suites
    cover byte-faithful upload, the traversal wall and the checklist, and the live checks confirmed a
    share link comes back. Nobody ever LOADED the resulting game. The one signal that something was
    wrong — an iframe rendering only its badge — reads as "still loading". §4.8's acceptance is
    "a stranger can play it", and every test asserted a step short of that.
  - **Candidate fixes, in preference order (not yet chosen — this changes a shipped money/feature path):**
    **(a)** platform-side, `useShareGame.ts:99` builds with `npm run build -- --base=./` — a CLI `--base`
    overrides the config, so it repairs EXISTING projects with no template rebuild or promote, and is one
    line. ⚠️ Must be checked against the `npm run <script>` shell allow-list (§4.2.5) and against deep
    client-side routes (relative assets resolve per-document, which is fine for the play page's own root
    but must be confirmed against `src/routing/router.tsx`). **(b)** template-side `base: './'` — correct
    at the source and fixes the lying comment, but only reaches NEW projects and needs a rebuild + T14
    promote. **(c)** rewrite at the serve layer — rejected, it makes the served bytes differ from the
    built bytes. Probably (a) AND (b): (a) to repair the installed base now, (b) so the template stops
    producing it.
  - Acceptance: a freshly published game LOADS AND RUNS in the iframe — asserted on the real asset
    fetches (the module script returns `text/javascript`, not `text/html`), not on the page merely
    rendering; existing publish specs stay green; and a pinned test proves the built `index.html` does not
    reference a root-absolute asset. Re-drive live and confirm `/play/:id` actually plays.

- [x] **T17c (FILED 2026-07-28 by T17 scenarios 5+9 — 🔴 CHECKPOINTS SILENTLY STOP AFTER THE FIRST MACHINE MESSAGE on CSB, so undo has nothing and kill-recovery restores the STARTER)**
  - **SHIPPED + LIVE-VERIFIED 2026-07-29 (all three acceptance clauses).** The fix is `checkpoint-run.ts`
    (`runCheckpointSerialize`, 10 tests): the checkpoint waits for the turn's actions to SETTLE
    (bounded `CHECKPOINT_SETTLE_TIMEOUT_MS` — `onFinish` fires while `<boltAction>` writes still land
    over RTT), each strict-serialize attempt is TIME-BOXED (`CHECKPOINT_SERIALIZE_TIMEOUT_MS` 60s —
    measured: a dead sandbox connection HANGS `fs` calls forever rather than erroring, which is why the
    old `.catch()` never fired) with 3 spaced retries; every failure is LOUD (toast + `logger.error`,
    idempotency guard reset so the NEXT turn retries, `workingCopySafe` flips pessimistic) and the
    conversation save is DECOUPLED from the file serialize (a sandbox read failure no longer loses the
    server transcript for the turn). `dist/` joined `MAP_EXCLUDED_DIRS` (both spellings + `OPAQUE_DIRS`
    second wall; membership pinned — the parameterized exclusion tests cannot notice a list removal).
  - **LIVE (real CodeSandbox, 2026-07-29):** a creation + one edit produced `projectSnapshots`
    **seq 0 (68-file starter) → seq 1 (94 files, creation) → seq 2 (94 files, edit)** on
    `prj_20260729032844_lnqzrgli`, with the server working copy at seq 2 holding the generated media +
    game script; the T17b project holds seq 0..4. **Scenario 9 re-driven:** VM deleted provider-side →
    reload → fresh VM via resume→create fallback (`sandbox-gone`) → restore delivered the **POST-EDIT
    state** (all generated images, `SimpleCosmicPinballMode.ts`, redesigned Home, full conversation) and
    the preview came back live — not the starter. `dist/` never appeared in the file map.
  - The `</function_results>` leak seen in that project's transcript (written into `Home.tsx` as a
    Vite parse error, user-repaired by prompt) is ALREADY FIXED: `function_results` joined
    `protocol-strip.ts`'s tag list 2026-07-28 with the measured leak string pinned in
    `protocol-strip.spec.ts`; the transcript predates the fix.
  - **MEASURED live.** Project `prj_20260729010253_5po27e90`: IndexedDB `projectSnapshots` holds exactly ONE
    checkpoint — `seq 0, 67 files`, keyed to the machine-written creation message, i.e. the PRE-GENERATION
    STARTER. The creation generation's checkpoint (would be seq 1, with the Nocturne redesign + 2 generated
    images), and the later edit's checkpoint, were **never written** — `checkpointProject` fires from
    `Chat.client.tsx` onFinish per message and its failure is a console-only `logger.error` behind a
    `.catch(() => {})`. Every project created this session has ONLY seq 0; yesterday's WebContainer-era
    project has seq 0–4. The server working copy is pinned at the same stale seq 0 (`.data/storage/working/…`
    = 67 starter files).
  - **The measured cost:** scenario 5 — clicking "Undo this change" on the edit says *"There is no checkpoint
    for this message"* (the refusal is the ONLY symptom); scenario 9 — deleting the VM provider-side recovered
    perfectly mechanically (fresh VM `28ql27` in 52s, no 503, no template adoption) and **restored the
    STARTER**: the whole 500-credit creation output is gone from disk while the chat still shows it. §4.12's
    safety net and §4.5.4c's recovery copy are both silently absent on the provider the platform is cutting
    over to.
  - **Suspected mechanism (unconfirmed — reproduce first, per the standing memory):** `checkpointProject`
    serializes STRICT (`serializeFiles({ strict: true })` — "better no checkpoint than a poisoned one", a
    trade-off written for WebContainer where reads are free). On CSB every binary read is an RTT; after a
    generation the tree holds fresh multi-MB media (and, after a publish, a ~25MB `dist/` — see next bullet)
    whose enrichment reads race the checkpoint. One failed/timed-out read → `IncompleteSerializationError` →
    no checkpoint, forever, silently.
  - **Also observed, same neighbourhood:** 🔴 **`dist/` enters the file map after a publish** (113 files vs
    67; the whole build output rides into the model's context, checkpoints, working copies, exports and the
    next publish's remix seed). It should almost certainly join `MAP_EXCLUDED_DIRS` — but that changes what a
    checkpoint holds, so decide it WITH the strict-serialize policy, not as a drive-by.
  - Fix direction (needs a design decision, not an inline patch): make the checkpoint failure LOUD in the UI
    (a §4.5.4b failed-save is never silent — the working-copy half already toasts; the local-checkpoint half
    must too); decide a retry/partial policy for strict serialization on RTT providers; exclude `dist/` at the
    map layer; then re-drive scenarios 5 + 9 and confirm seq advances per generation and recovery restores the
    LATEST state.
  - Acceptance: a failing test reproduces the missed checkpoint (strict serialize failing on one file must not
    silently end checkpointing — the user is TOLD, and policy decides retry/skip); after a creation + one edit
    on the real provider, `projectSnapshots` holds seq 0..2 and the working copy matches the latest; scenario 9
    re-driven restores the post-edit state; `dist/` never appears in the file map, checkpoints, or context.

- [x] **T19 (ADDED + SHIPPED 2026-07-29, owner report: "Remix this project should have the same splash screen progress that new creations and resume get")** — Remix/dashboard opens get the boot splash; ⋯ Remix actually opens the clone
  - The cosmetic report sat on a REAL defect: since per-project boot (T3), one tab = one sandbox
    connection, and the dashboard's `openBuilder` handles a switch with a full page load — but
    ⋯ "Remix project" (`useRemixProject`) and the sidebar Duplicate (`duplicateCurrentChat`) still
    SPA-navigated, so `bootForProject` REFUSED the clone's mount ("already connected to another
    project") and the user silently stayed on the old project while the toast said "Project remixed"
    (measured live: clone row created, no sandbox session ever minted). All three remix writers now
    use the `openBuilder` rule (`bootedProjectId()` set → `window.location.href`), and the dashboard's
    own remix goes through `openBuilder` (a dashboard reached by SPA from the builder still holds the
    sandbox).
  - The splash gate is **module state** (`pendingMountGate` atom in `useChatHistory.ts`), not hook
    state, because the mount and the splash belong to DIFFERENT hook instances: several components
    call `useChatHistory`, the baton is read-once, and the instrumented live run showed the sidebar
    Menu's instance consuming it (child effects run first) while the Chat instance — whose `ready`
    decides what renders — found nothing and dismissed the splash. The atom initializes by PEEKING the
    baton at module evaluation (`hasPendingProjectMount`, non-consuming, SSR-safe), is re-asserted on
    consumption, cleared on completion, and deliberately KEPT UP on a classified boot failure so
    `BootScreen` shows the failure + Retry. A non-consuming instance whose effect finds no baton must
    NOT set itself ready while the gate is up.
  - `/remix/:shareId` renders `BootScreen` with a new `remixing` phase ("Making your copy…") instead
    of its private spinner — the phase atom survives `navigate('/')`, so the surface is continuous
    from clone through mount; terminal states (sign-in, error, unmount without hand-off) reset it.
  - **LIVE-VERIFIED (150ms poll with a control string):** baton → full load shows "Waking your
    workspace…" from t≈678ms, holds through session mint + mount, lands on the open project; ⋯ Remix
    minted clone `hxf6otz9` with its OWN VM `lp9qfy` and opened it titled "(copy)". Pinned:
    `hasPendingProjectMount` peek-never-consumes (`pending-remix.spec.ts`), `remixing` copy/phase
    (`boot-progress.spec.ts`).

- [x] **T20 (ADDED + SHIPPED 2026-07-29, owner request: show CSB account info on the Admin panel like the KIE balance)** — "CodeSandbox status" section on Admin → usage
  - **CodeSandbox has NO credit-balance endpoint** — verified three ways (every REST path the SDK
    bundle calls, the docs, live probes of `/billing`/`/credits`/`/usage`/… all 404), so a KIE-style
    balance tile cannot exist. What their API does report is the headroom that fails first, and that
    is what the section shows: `GET /meta/info` (hourly API requests — the 3,600/hr cap the spec says
    bites before concurrency; hourly sandbox creations — the platform's whole fork budget; concurrent
    VMs), `GET /vm/running` (VMs burning credits right now, with the tier specs each bills at), and
    `GET /sandbox?tags=btk` (fleet count — the population the T4 orphan sweep audits). The spend
    ESTIMATE remains T12's VM-hours × `SANDBOX_VM_USD_PER_HOUR`, and the section says so in-line.
  - `sandbox/provider-status.ts`: never throws (nulls + `reason` — one section must not take the
    dashboard down), the three reads run `allSettled` and degrade INDEPENDENTLY with the failure
    named (a partial answer that reads as "fewer VMs" is a wrong number on a money panel), 30s cache,
    5s per-fetch timeout, raw `fetch` on a fixed host (two of the three endpoints are not in the
    SDK's typed client; avoids the seam scan and the workerd lazy-import rule). Joined onto
    `/api/admin/usage` beside `providerBalance`/`vm`. Pinned by `provider-status.spec.ts` (6 tests:
    mapping, independent degradation, `/vm/running` concurrency fallback when `/meta/info` fails,
    total-outage nulls, unconfigured-with-zero-fetches — env-scrubbed per the `oauth.spec.ts` lesson —
    and the cache).
  - **Live-verified in the real Admin panel:** requests 3,596/3,600 · creations 17/20 · VMs 0 of 10 ·
    fleet 9, rendered between "Sandbox VM time" and "Refund audit".

- [x] **T18** — Update SPEC.md to match what was built
  - **SHIPPED + VERIFIED 2026-07-28 (independent verifier PASS on all 5 criteria; full gates green — 195
    files / 3,232 tests, brand gate, and every doc-adjacent source scan).** SPEC §7/§8 current-state
    replaced/merged (per-project sandboxes, cap-2 hibernate-oldest, wake hook, csb-alias pin+promote with
    the propagation-lag caveat, deploy build-arg contract, T17b serve contract, VM-cost margin input with
    the "$0 compute" claim struck-and-superseded) + a §8 Decisions log (bake-vs-meter; cap=2
    never-refuse; the T17b three-layer fix; T17c filed-not-fixed). `spec/sandbox-codesandbox.md` carries
    the dated T17 status block with the live numbers, the full §11 disposition table (every finding
    fixed-by-T\<n\> or explicitly still-open — none ambiguous), and a superseded-not-deleted trail;
    `spec/sandbox-seam.md` and CLAUDE.md's sandbox block updated to match. The verifier's three residual
    nits (stale Pico rate example, one present-tense historical phrase, T17c code-shape wording) were
    fixed after the PASS.
  - Files: `SPEC.md`, `spec/sandbox-codesandbox.md`, `spec/sandbox-seam.md`, `spec/billing.md`, `CLAUDE.md` (stage/status blocks)
  - Details: Update the specific sections this plan changes: the sandbox architecture (per-project sandboxes, registry deletion, VM cap, wake hook — replacing the documented per-user stopgap), the billing model (VM cost as a margin input, the retired "user compute ≈ $0" claim, the T11 floor assertion), the template pipeline (CSB alias pin-and-promote), monitoring/health additions, and the deploy contract (build-time provider switch). Follow the working agreement: replace/merge current-state sections; append decisions with rationale (bake-vs-meter, cap=2, hibernate-oldest-never-refuse); never delete history — supersede it. **Also disposition the review:** `spec/sandbox-codesandbox.md` §11 and the CLAUDE.md sandbox-provider sub-entry both list the findings this plan folds in — mark each one fixed-by-T\<n\> or explicitly still-open.
  - Acceptance: no spec section contradicts the shipped code; the per-user-registry stopgap text is superseded (not silently deleted); `spec/sandbox-codesandbox.md`'s "Still open" list reflects only what genuinely remains; **every §11 finding carries a disposition (fixed-by-task or still-open, none ambiguous)**; gates green including the doc-adjacent source-scan specs.

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
