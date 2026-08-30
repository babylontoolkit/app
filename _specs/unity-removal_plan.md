# Unity Bridge + Project Licenser removal — plan

**Owner decision, 2026-08-30.** Remove the Unity Editor Bridge (§4.17) and the Unity Project
Licenser (§4.18) completely. **KEEP** the Unity Editor subscription check (§4.18a) as a callable
web service, and add a POST form for the Unity client.

## Why not repurpose to Unity CLI

Nodepod runs Node in **Web Workers** and serves previews from a service worker on our own origin.
Its `spawn()` is a virtual shell (node/npm/git/coreutils) — there is **no native process**, so
`unity -batchmode` can never run there. Driving Unity CLI would need the same local companion
process, loopback pairing, CORS and Private Network Access preflight the bridge already had; Unity
CLI only changes what the companion shells out to. The only architecture where this differs is the
Electron desktop build, whose main process is real Node. Not in scope.

Loopback fetch itself does work from the sandbox (loopback is "potentially trustworthy", so no
mixed-content block) but the local server must emit CORS + `Access-Control-Allow-Private-Network`,
which again means a companion.

## ✅ T1 — Bridge: client surface
- Delete `app/lib/stores/unityBridge.ts` (+ spec), `app/lib/mcp/remote-client.ts` (+ spec),
  `app/lib/mcp/loopback.ts` (+ spec), `app/components/chat/UnityConnection.tsx` (+ spec).
- `ChatBox.tsx`: drop `<UnityConnection />` and its comment — this is the chat-window icon.
- `Chat.client.tsx`: `combinedMcpToolsAtom` → `mcpToolsAtom`.
- `mcpBridge.ts`: drop the `UNITY_SERVER_NAME` routing branch and the dynamic import.

## ✅ T2 — Bridge: MCP plumbing
- `webcontainer-bridge.ts`: delete `UNITY_SERVER_NAME` and the reserved-name guard.
- `project-config.ts`: **refuse** `sse`/`streamable-http` servers by name. With the bridge gone
  nothing connects a URL transport, so accepting one is dead config that reads as support.
- `mcp-tools.ts`: delete `UNITY_RELAY_TIMEOUT_MS` and the per-server timeout branch.
- `project-notes.ts`: delete `unityBridgeBlock` and the unity server filter.
- Delete `app/lib/.server/agent/unity-live-relay.spec.ts`.

## ✅ T3 — Bridge: companion package
- Delete `companion/`, the `companion` script in `package.json`, and any tsconfig/lint exclusions.

## ✅ T4 — Licenser: code
- Delete `unity-license{,-crypto,-pricing,-service}.ts`, `license-entitlements.ts` (+ specs),
  `unity-license-route.spec.ts`, `app/lib/unity/` (license delivery), and
  `app/routes/api.projects.$projectId.unity-license.ts`.
- Remove `linkedUnityProjectId` from `projects/types.ts` + `store.ts`.
- Remove `'license'` as a WRITABLE ledger reason (`paid-path-rates.ts` `RefundableReason`).

## ✅ T5 — Licenser: ledger history stays readable
The ledger is append-only, so `'license'` survives as a **historical** reason: keep it in
`LedgerReason`, in the SQL check constraint, and in `ledger-display.ts` ("Unity license"). Only the
writers go. Dropping it from the constraint would fail against existing rows and would retro-
invalidate real charges.

## ✅ T6 — Migration 0025
Drop `unity_license_entitlements` and `projects.linked_unity_project_id`. Precedent: migration 0007
deleted the snapshots table rather than leaving it dormant — a table named for a deleted system is
how the deleted system comes back. The `credit_ledger` reason constraint is left ALONE (T5).

## ✅ T7 — Keep + extend the subscription check
- Keep `subscription-access.ts`, `subscriber-status.ts`, `unity-api-key.ts`,
  `api.unity.subscription.ts`, `unity-subscription.spec.ts`, `user-id-for-email-sql.spec.ts`,
  migration 0022.
- **Add a POST `action`** taking `{ "email": "..." }` in a JSON body, sharing one handler with the
  existing GET. POST keeps the address out of query strings and proxy logs, which the route's own
  doc comment already flags as GET's residual cost.
- Re-anchor every `§4.18` citation in these files to `§4.18a`.

## ✅ T8 — Docs
- SPEC.md: §4.17 and §4.18 become REMOVED tombstones; §4.18a keeps its number (every kept-code
  citation points at it) and absorbs the standalone description.
- CLAUDE.md: remove the §4.17/§4.18 entries, keep the subscription service.
- `spec/*.md`, `.env.example`: drop `UNITY_LICENSE_CREDITS_*`; keep `UNITY_SUBSCRIPTION_*`.

## Gates
`pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test`

---

## Status: COMPLETE (2026-08-30)

All gates green: `typecheck` clean · `lint` 0 errors (27 pre-existing warnings) · **7,841 tests
passing / 356 files** · `check:brand` clean. Driven live on `localhost:5173`: the chat toolbar now
leads with **MCP Tools** (the Unity icon is gone), no console errors, and the only 404 is
`POST /api/mcp-update-config` — the pre-existing §4.14 fail-closed guard on upstream's MCP RCE route.

### Tests rewritten rather than deleted

Every Unity assertion became an assertion about the ABSENCE, each with a control, because a deleted
guard that silently comes back is the failure this repo keeps finding:

- `ledger-sql.spec.ts` — `linked_unity_project_id` and `unity_license_entitlements` asserted GONE
  (controls: `game_backend_ref` and `credit_ledger` still present, so the queries still see the schema).
- `money-paths.spec.ts` — `unity-license-service.ts` asserted to be no longer a debiter.
- `mcp-tools.spec.ts` — every server on the relay default, `unity` included, because it used to be
  special and is now an ordinary name.
- `mcp.spec.ts` — network transports refused, **the loopback case specifically**, since that is the
  URL that used to be allowed and a partial revert restores exactly it.
- `project-notes.spec.ts` — a declared `unity` server is described like any other, with no frame.
- `webcontainer-bridge.spec.ts` — a network server never reaches `spawn`, with a stdio control.
- `store.spec.ts` — the pointer round-trip repointed to `gameBackendRef`, keeping the camelCase ⇄
  snake_case coverage the licenser pointer happened to carry.

---

## ✅ T9 — the schema was DELETED, not migrated away (owner correction, same day)

> *"remove any lingering stuff, dont make it where i have to deploy then do a bunch of patches or
> hacks or removals."*

The first pass added migration `0025` to DROP the Unity column and table, and kept `'license'` as a
readable ledger reason "because the ledger is append-only". Both were wrong for this repo's actual
state, and the owner was right to reject them: **the platform has never been deployed**, so a first
deploy would have run 0011 (add column) → 0012 (create table) → 0025 (drop both) for nothing.

- `0011_unity_project_link.sql` and `0012_unity_license_credits.sql` — **deleted from the repo**.
- `0025_remove_unity_licenser.sql` — **never shipped**, deleted.
- `'license'` removed from `0015`'s CHECK constraint, `LedgerReason`, `ledger-display.ts`,
  `money-paths.spec.ts`, `billing.spec.ts` and `ledger-display.spec.ts`. The Unity assertions in
  `ledger-sql.spec.ts` were removed outright rather than inverted to absences — asserting the absence
  of something no migration creates tests nothing.
- ⚠️ **The numbering gap at 0011/0012 is deliberate. Nothing is missing.** Renumbering 0013–0024 would
  be churn with a real chance of breaking a reference.

**The append-only rule was not violated — it had nothing to protect.** It exists to stop a schema edit
invalidating rows a live database already holds. There is no database: local mode is filesystem
`.data/`, and the local ledger was grepped before deleting anything (`media`, `generation`,
`project_create`, `grant`, `adjustment` — **zero `license` rows**).

🔴 **This licence is one-time and expires at the first deploy.** Once a database exists, removing a
ledger reason must go back to being a forward migration that leaves the value readable.

**Also swept:** stale comments pointing at the deleted button (`ModelTierPill.tsx` and its spec cited
"the Unity button" as the row's leading `IconButton`; `OverflowMenu.client.tsx` claimed the Unity
bridge still had a composer-row control), and `UNITY_LICENSE_CREDITS_*` is gone from `.env.example`
rather than documented as unread.

**`license.json` stays opaque** — the one Unity-shaped rule that survives, because an imported or
cloned project can still carry one and un-hiding it feeds machine crypto to the model every turn.

Gates after T9: typecheck clean · lint 0 errors · **7,835 tests / 356 files** · brand gate clean.
