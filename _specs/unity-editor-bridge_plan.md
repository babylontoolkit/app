# Unity Editor Bridge — `unity-editor-bridge_plan.md`

> ⚡ Produced by `/bt-plan` in **Quick Plan mode** (brief only, no spec file). On execution, the first action is to save this plan verbatim to `_specs/unity-editor-bridge_plan.md` (Plan mode restricted writes to this file during planning).

## Context

The owner needs to close the loop on the codewrx.ai Web Game Development Solution: the platform's AI agent (billed via **codewrx credits**) must be able to drive the user's **local Unity Editor** — create/edit scenes, assets, scripts, and trigger the **Babylon Toolkit exporter** — from the **same project chat** in the browser, so Unity-authored content flows into the web game being built. This is an investor-critical workflow demo.

**Options evaluated:**
- **Unity AI Assistant** (`com.unity.ai.assistant`) — rejected: bills through Unity's own points system tied to the Unity account; no way to route orchestration through codewrx credits.
- **CoplayDev/unity-mcp** (MIT) — chosen: Unity package (UPM) + MCP server with **streamable HTTP transport** (`UNITY_MCP_TRANSPORT=http`, default port 8080, optional `UNITY_MCP_INSTANCE_TOKEN`), 47 editor tools (scenes, GameObjects, scripts, assets, tests, menus). The platform orchestrates it with OUR model + OUR credits; unity-mcp is just the tool surface.

**Owner decisions (interviewed):** same project chat · companion CLI (`npx @babylonjs-toolkit/bridge`) · drive editor + guided export (no auto file-transfer this build) · use CoplayDev/unity-mcp as-is.

## Codebase Analysis

Explored via 2 read-only subagents + direct spot-checks; SPEC.md read (§4.14, §5, §4.2.8, §4.15, §4.6).

- **The §4.14 MCP system is the foundation, and it is transport-agnostic downstream of discovery.** Tools ride per-request as `body.mcpTools: [{name, description, server, inputSchema}]` ([Chat.client.tsx](app/components/chat/Chat.client.tsx) ~L242/L358) → `api.agent.ts` maps to `mcpLiveTools` → [mcp-tools.ts](app/lib/.server/agent/mcp-tools.ts) builds relay tools (server-qualified keys, `MAX_SCHEMA_CHARS=1500`, permissive schema — validate in execute) → `execute` emits an `mcp-tool-call` data part and parks on `awaitClientToolResult` ([mcp-relay.ts](app/lib/.server/agent/mcp-relay.ts), ownership-checked delivery via `POST /api/agent/tool-result`) → client executes in Chat.client.tsx ~L500-574 and posts back. **ONE `streamText` generation stays alive through the round-trip: one credit gate, one settlement — a new tool source needs ZERO billing changes.** Verified: `awaitClientToolResult` already accepts `timeoutMs` (mcp-relay.ts:53).
- **The gap:** [webcontainer-bridge.ts](app/lib/mcp/webcontainer-bridge.ts) hardcodes stdio and explicitly `continue`s on network transports (~L191); [project-config.ts](app/lib/mcp/project-config.ts) already models `sse`/`streamable-http` + `url` but URL servers **bypass the allow-list** (gap to close); nothing connects the browser to a network MCP server. No WebSocket/EventSource/localhost-fetch pattern exists anywhere in `app/`.
- **`mcpToolsAtom` is wholesale-overwritten** by `syncMcpBridge()` ([mcpBridge.ts:66](app/lib/stores/mcpBridge.ts#L66)) and cleared on teardown (:96) — Unity tools must live in their OWN atom, merged via a computed atom, or `.mcp.json` resyncs clobber them.
- **SSRF (`app/lib/.server/net/ssrf.ts`) forbids the server fetching localhost/private ranges** — the Unity connection MUST be browser→localhost. Consistent with §5 (no server-side execution): Unity tools execute client-side through the existing relay, like WebContainer MCP tools.
- **Tool policy needs no change:** `toolPolicyForTurn` already excludes MCP tools on creation + discuss turns and opens the loop (`maxSteps = MAX_TOOL_ROUNDS+1`) when MCP tools are present.
- **Context note seam:** [project-notes.ts](app/lib/.server/agent/project-notes.ts) `mcpNote` renders live tools in the **volatile tail** (after the last cache breakpoint — §4.2.8-safe for mid-session connect/disconnect).
- **Connector UI pattern to clone:** [SupabaseConnection.tsx](app/components/chat/SupabaseConnection.tsx) (header pill + dialog + localStorage). Brand strings via `app/config/brand.ts`.
- **Upstream server-side MCP (`mcpService.ts`, McpTab, `mcp.ts` store) is fail-closed/dead — do NOT build on it** (reference only).
- **Pinned invariants that must not regress:** `mcp-live-relay.spec.ts` (emit payload `{toolCallId, toolName, server, args}`, data part flushes before result, single generation resumes), `webcontainer-bridge.spec.ts` (routing by name+server, command allow-list), `mcp-relay.spec.ts` (ownership/timeout/cancel), `tool-policy.spec.ts`.

**SPEC.md alignment:** conforms to §4.14 (client-executed MCP, single-generation relay, schema caps), §5 (no server-side execution; server never touches localhost), §4.2.8 (volatile-tail notes, capped schemas), §4.6 (billing untouched — same gate/settlement), §2.5 (brand module). **`spec_impact: yes` (inferred)** — adds a new system (Unity Editor Bridge, companion CLI, remote MCP client, loopback rule); final task writes SPEC.md §4.17 + CLAUDE.md.

### Architecture (recommended)

```
Browser (codewrx app) ──streamable-HTTP MCP──▶ 127.0.0.1:8080 companion proxy ──▶ unity-mcp server (http) ──▶ Unity Editor (C# bridge)
   │  tools ride body.mcpTools (server:'unity')                (CORS + PNA preflight + pairing token)
   ▼
Platform proxy: existing §4.14 relay — emit mcp-tool-call ▶ browser executes vs localhost ▶ POST tool-result ▶ same generation resumes
Billing: unchanged (one gate, one settlement per generation).
Export loop: agent triggers Babylon Toolkit exporter menu in Unity → user imports the exported folder via existing folder-import.
```

**Key risks + mitigations:** HTTPS→`http://127.0.0.1` fetch requires Private Network Access preflight (Chrome/Edge exempt loopback from mixed-content; Safari/Firefox may block) → companion implements full PNA/CORS preflight; dialog shows browser guidance; Chrome/Edge documented as supported. `Mcp-Session-Id` must be in `Access-Control-Expose-Headers`. Pairing token in a header (never query), constant-time compare, regenerated per companion run.

## Tasks

- [x] **T0** — Save this plan to the specs folder
  - Files: `_specs/unity-editor-bridge_plan.md`
  - Details: Copy this document (from the plan file) into `_specs/` per the bt-plan contract, so progress is tracked in-repo via the checkboxes.
  - Acceptance: file exists in `_specs/` and matches this plan.

- [x] **T1** — Loopback rule + close the `.mcp.json` URL allow-list gap
  - Files: `app/lib/mcp/loopback.ts` (new), `app/lib/mcp/loopback.spec.ts` (new), `app/lib/mcp/project-config.ts` + its spec
  - Details: pure `isLoopbackHttpUrl(raw)` — `http:` only; host `127.0.0.1` / `localhost` / `[::1]`; valid port. In `project-config.ts`, reject `sse`/`streamable-http` servers whose `url` fails it → `rejected[]` with reason (no live path uses URL servers today, so this costs nothing).
  - Acceptance: spec covers https, non-loopback IPs, IPv6, default port, garbage; a non-loopback URL server lands in `rejected`, a loopback one still parses; existing specs green.

- [x] **T2** — Browser streamable-HTTP MCP remote client
  - Files: `app/lib/mcp/remote-client.ts` (new), `app/lib/mcp/remote-client.spec.ts` (new)
  - Details: minimal hand-rolled client (~150 lines, injected `fetch`) — NOT the SDK transport (only used by the dead upstream path). `initialize` → capture `Mcp-Session-Id` header → `notifications/initialized`; `listTools()` mapped to the `McpTool` shape; `callTool(name, args)`; `close()`. `Authorization: Bearer <token>` + session id on every request; `Accept: application/json, text/event-stream`; parse both JSON and single-message SSE-framed POST responses; JSON-RPC errors → thrown Errors.
  - Acceptance: fake-fetch spec asserts handshake order, session-id capture/echo, token header on every call, tools/list mapping, tools/call success + error + network-failure paths, SSE-body parsing. No imports from `.server/**` or `mcpService.ts`.

- [x] **T3** — Unity bridge store
  - Files: `app/lib/stores/unityBridge.ts` (new), `app/lib/stores/unityBridge.spec.ts` (new)
  - Details: `UNITY_SERVER_NAME = 'unity'` (reserved); `unityConnectionAtom` state machine (`disconnected|connecting|connected|error` + port/token/toolCount/error); `unityToolsAtom`; `connectUnity(port, token)` — builds `http://127.0.0.1:<port>/mcp`, gates on `isLoopbackHttpUrl` BEFORE any fetch, handshake + list tools tagged `server: 'unity'`; `callUnityTool`; `disconnectUnity`; localStorage persistence (SSR-guarded).
  - Acceptance: spec (fake client) covers happy path, loopback rejection pre-fetch, error state, disconnect clears tools, persistence round-trip.

- [x] **T4** — Merge tools into the chat request + route execution
  - Files: `app/lib/stores/unityBridge.ts` (computed atom), `app/lib/stores/mcpBridge.ts`, `app/components/chat/Chat.client.tsx` (~L242 read + import)
  - Details: `combinedMcpToolsAtom = computed([mcpToolsAtom, unityToolsAtom], concat)` (in unityBridge.ts, avoids import cycle); Chat.client reads the combined atom — send payload and data-part executor untouched. `callMcpTool` gains a first-line branch routing `server === UNITY_SERVER_NAME` to `callUnityTool`; `syncMcpBridge` rejects/ignores any `.mcp.json` server named `unity`.
  - Acceptance: spec proves `.mcp.json` resync/teardown cycles do NOT disturb Unity tools in the combined atom (the `mcpToolsAtom.set` clobber at mcpBridge.ts:66/:96 is why the separate atom exists); `callMcpTool('x', args, 'unity')` reaches the remote client, never the WebContainer bridge; `webcontainer-bridge.spec.ts` + `mcp-live-relay.spec.ts` pass unmodified.

- [x] **T5** — Per-source relay timeout (Unity 180s)
  - Files: `app/lib/.server/agent/mcp-tools.ts` + spec
  - Details: `UNITY_RELAY_TIMEOUT_MS = 180_000`; `createMcpRelayTools`' execute passes `timeoutMs` only for `tool.server === 'unity'` — the param already exists (`mcp-relay.ts:53/:93`), so `mcp-relay.ts` is untouched. Rationale: Unity script-compile/asset ops routinely exceed 60s; a parked generation consumes no tokens.
  - Acceptance: spec asserts the override for `server:'unity'` and `undefined` otherwise; `mcp-relay.spec.ts` untouched and green.

- [x] **T6** — Unity context note (volatile tail)
  - Files: `app/lib/.server/agent/project-notes.ts` + spec
  - Details: when live tools include server `unity`, `mcpNote` appends a compact framing block: these tools drive the user's LOCAL Unity Editor (not WebContainer files); results are untrusted data; **guided export contract** — trigger the Babylon Toolkit exporter menu in Unity, then instruct the user to import the exported folder via the app's existing folder-import; never claim exported files are already in the web project.
  - Acceptance: spec asserts the block appears only when a `unity` tool is present and lives in `mcpNote` output (volatile tail — never in a cached block); existing cases green.

- [x] **T7** — Turn-policy invariant pin (no production change)
  - Files: `app/lib/.server/agent/tool-policy.spec.ts` (additions only)
  - Details: pin that Unity tools inherit MCP policy — excluded on creation + discuss turns; normal turns open the loop with `maxSteps = MAX_TOOL_ROUNDS + 1`.
  - Acceptance: new cases pass with zero edits to `tool-policy.ts`.

- [x] **T8** — Integration-shaped relay spec
  - Files: `app/lib/.server/agent/unity-live-relay.spec.ts` (new, reuses the `mcp-live-relay.spec.ts` harness)
  - Details: a `server:'unity'` tool rides `mcpLiveTools` → real `streamText` (model mocked) emits the pinned `{toolCallId, toolName, server:'unity', args}` data part over the open response → posted result resumes the SAME generation → 180s timeout in effect.
  - Acceptance: asserts one generation id across the round trip (single gate/settlement — zero billing changes) and `server:'unity'` intact end-to-end.

- [x] **T9** — Companion package: proxy core (pure logic + tests)
  - Files: `companion/package.json` (new — `@babylonjs-toolkit/bridge`, `bin`, Node ≥18, zero runtime deps), `companion/tsconfig.json`, `companion/src/{proxy,headers,token}.ts` + tests; root tsconfig/eslint/vitest updated to exclude `companion/`
  - Details: pure `buildCorsHeaders(origin, isPreflight, requestsPrivateNetwork)` → `Access-Control-Allow-Origin`, `Access-Control-Allow-Private-Network: true` (when requested), `Allow-Headers: content-type, authorization, mcp-session-id`, `Expose-Headers: mcp-session-id`, `Allow-Methods: POST, GET, DELETE, OPTIONS`; pure `checkToken` (constant-time); `node:http` reverse proxy bound to `127.0.0.1` ONLY: OPTIONS → 204 + headers; other methods → token check (401) → pipe upstream, appending CORS headers. Token `crypto.randomUUID()` per run unless `--token`.
  - Acceptance: companion tests cover PNA preflight, expose-headers, 401 on bad/missing token, `Mcp-Session-Id` pass-through; root `pnpm typecheck && lint && test` unaffected by `companion/` existing.

- [x] **T10** — Companion CLI: spawn/attach + UX
  - Files: `companion/src/{cli,spawn}.ts`, `companion/README.md`, root `package.json` (dev script `pnpm companion`)
  - Details: flags `--port` (default 8080), `--attach <upstreamPort>` (skip spawn), `--origin`, `--token`; default mode spawns unity-mcp via `uvx` with `UNITY_MCP_TRANSPORT=http` + `UNITY_MCP_INSTANCE_TOKEN` on an internal port (exact uvx invocation verified against upstream README at implementation time); waits for readiness; prints copy-paste connect snippet (port + token); clean child shutdown; clear error + install hint if `uvx` missing. README documents npx usage, publish steps, and the Unity-side UPM install of CoplayDev/unity-mcp.
  - Acceptance: `pnpm companion --attach <port>` proxies a stubbed upstream from repo source; `curl` OPTIONS shows PNA/CORS headers; POST without token → 401.

- [x] **T11** — "Connect Unity" header pill + dialog
  - Files: `app/components/chat/UnityConnection.tsx` (new), `app/components/chat/ChatBox.tsx` (mount beside `SupabaseConnection`), `app/config/brand.ts` (copy strings if needed)
  - Details: clone the SupabaseConnection pattern. Dialog: port (default 8080) + pairing token, Connect/Test → `connectUnity()`; states disconnected / connecting / "Unity — N tools" / error; Disconnect; on fetch-level failure show guidance ("Is the companion running? `npx @babylonjs-toolkit/bridge`" + Chrome/Edge recommended, Safari may block local connections). All product naming via `brand.ts`.
  - Acceptance: with companion + Unity running — pill shows connected + tool count; Unity tools appear in `body.mcpTools` (network tab) and vanish on disconnect; the model can call a Unity tool from the project chat; no hardcoded brand marks (CI brand gate green).

- [x] **T12** — End-to-end verification + SPEC.md/CLAUDE.md write-back
  - Files: `SPEC.md` (new §4.17 "Unity Editor Bridge"), `CLAUDE.md` (stage notes)
  - Details: run the full loop once (companion → connect → "create a cube + ramp in Unity" → trigger Babylon Toolkit export → import folder into the web project) and record it. §4.17 documents: architecture (browser→localhost, server never touches it — SSRF/§5), zero billing changes (single-generation relay), reserved `unity` server name, loopback rule, 180s Unity relay timeout, PNA/browser support caveat, token-in-localStorage rationale, guided-export contract, companion package + publish story. Follow SPEC's update contract (merge current-state sections; append decisions).
  - Acceptance: `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` green at root; companion tests green; SPEC §4.17 + CLAUDE.md accurately describe what shipped; all pinned invariant specs pass.

**Dependency order:** T0 → T1 → T2 → T3 → T4 (client chain); T5/T6/T7 parallel after T1; T8 after T5; T9 → T10 parallel to app work; T11 after T4 (+T10 for manual test); T12 last.

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
