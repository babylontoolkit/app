# Spec for unity-bridge-local-gltf

branch: project/feature/unity-bridge-local-gltf
design_system: DESIGN.md
spec_impact: yes
size: large
proof: functional

> 🔴 **SUPERSEDES SPEC.md §4.17's tombstone by OWNER DECISION (2026-09-27).** Verbatim: *"Please add
> full support for loading local gltf files and please make the local `Bridge` piece as
> `@babylonjs-toolkit-bridge` to full support the whole Unity CLI… Use the previous Unity ICON and for
> any dialogs we may need to support our `Unity Bridge` feature… You make the decisions."*
>
> The tombstone's argument was correct **about the design it buried** and is not an argument against
> this one. It said a Unity-CLI bridge "has the SAME architecture with a different subprocess" —
> true of a *browser → localhost* companion, which is what was removed. This spec inverts the
> direction: the helper on the user's PC connects **out** to the platform over ordinary HTTPS, so the
> browser is never in the path and none of CORS, Private/Local Network Access, mixed content or a
> pairing token typed into a page applies. Electron stays out of scope (§2.3); it remains a possible
> second host later, not a prerequisite.
>
> **Where the helper lives — the Desktop Agent (owner, 2026-09-27).** The bridge is NOT a separate
> package. It is a service of the **Babylon Toolkit Desktop Agent**, the existing `@babylonjs-toolkit/agent`
> npm package (`/Users/mackey/Documents/Repos/Babylon/Repositories/UniversalSkills`, command `bt-agent`),
> which the owner has repositioned from "installs skills" to the desktop agent the App Builder connects to
> for local Unity, Unity-exporter and Blender control. Owner, verbatim: *"this fits perfect into the primary
> service the desktop agent provides for the app builder to control blender and the unity editor and the
> exporter."* The bridge is the `bt-agent bridge` command. (An earlier draft of this spec named a separate
> `@babylonjs-toolkit/bridge` package; that is superseded.)

## Summary

Two capabilities and a cleanup, all of which have to land together to be true:

1. **Local glTF.** A game running in the Nodepod preview can load a glTF/GLB scene — and its buffers
   and textures — from a dev server on the user's own machine (the Toolkit exporter's server,
   `http://localhost:8888/scenes/Level01.gltf`), as well as from public URLs, in local development
   AND on the hosted app. A local scene can be **imported into the project** in one action, so a
   game built against the user's live Unity export can still be published. Today this fails for a
   reason no one had written down: Nodepod's service worker treats *every* `localhost` URL as the
   pod itself, ignoring the port, so the request never leaves the browser.
2. **Unity Bridge.** The Desktop Agent's bridge service, `bt-agent bridge` (or
   `npx @babylonjs-toolkit/agent bridge`), lets the platform's agent
   drive the **whole Unity CLI** (the live `unity command` catalog, the `bt_*` export bridge,
   `run_script`, and the top-level `unity` binary) and **headless Blender** on the user's PC, from the
   project chat, billed in credits. The previous Unity icon returns to the chat composer row; four
   dialogs cover pairing, status, per-call consent and job progress.
3. **Every problem the research found.** A baked prompt that tells the platform model it drives Unity
   and Blender when it has no way to; unsynced Unity/Blender docs; a Toolkit dev server that listens
   on every network interface with no path containment; three `bt_*` bridge bugs; and ~30 defects in
   the Agent Reference's new Unity/Blender documents (one of which damages a user's character model).

## Project Spec Alignment (from SPEC.md)

- **SPEC.md sections this feature relies on:** §3 System Architecture; §4.1a builder toolbar;
  §4.2 agent loop + §4.2.8 context budget; §4.2.9 Plan mode; §4.3 doc-sync; §4.4c play contract
  (`sceneUrl`); §4.5.4d local project folder; §4.6 credits & ledger; §4.8 share/publish checklist;
  §4.9 glTF introspection; §4.14 MCP live relay; §4.14a preview debugging tools; §4.16 media
  (async-enqueue billing pattern); §4.18a Unity subscription check; §5 security; §8 Nodepod provider
  (`spec/sandbox-nodepod.md`).
- **How it fits:** the bridge is a **new tool family in the existing server tool loop**, delivered by
  the same "`execute` parks, a result is delivered by an ownership-checked registry" mechanism the
  §4.14 relay already relies on — only the far end is the user's helper instead of their browser tab.
  Billing mirrors §4.16 media (debit before dispatch, refund exactly once, its own ledger reason).
  Local glTF is a browser-side concern (service worker, iframe permissions, exporter headers) plus a
  client-side import that writes bytes into the sandbox through the existing binary-safe path.
- **What changes in SPEC.md (spec_impact = yes):**
  - §4.17 becomes **"Unity Bridge — BUILT"** (outbound helper). The tombstone's reasoning is kept as a
    sub-note explaining why the *browser* direction failed.
  - §3 diagram gains the helper and its outbound HTTPS arrow.
  - §5 gains the bridge trust model: model-directed execution on the user's own machine, tiered and
    consented, never on platform infrastructure.
  - §4.6 gains the `bridge` ledger reason and its three config prices.
  - §4.5.4d / §4.8 gain "import a local scene" and the `localhost-url` publish warning.
  - §8 / `spec/sandbox-nodepod.md` record the service-worker localhost fix.
  - CLAUDE.md's §4.17 paragraph is rewritten to match.
- **Conflicts with SPEC.md:**
  - The §4.17 tombstone ("Not in scope"; "Electron is where it belongs"). This is resolved by the
    owner decision above.
  - §5: "code execution is inside the user's own browser tab". That stays true for the platform. The
    bridge adds execution on the user's **machine**, under their explicit pairing and consent. §5's
    rule that the server never executes user code is untouched.
  - Nothing else conflicts. In particular, the `.mcp.json` `sse`/`streamable-http` refusal
    **stays**, because the bridge is not an MCP server (see Decisions).

## Functional Requirements

### A. Local glTF in the preview

- **A1. A localhost URL on another port reaches the network.** In the Nodepod service worker, a
  `localhost` / `127.0.0.1` / `0.0.0.0` request is routed into the pod **only when its port is one the
  pod is serving**. Any other port goes to the real network, like any other cross-origin request.
  - Fixed in the Nodepod fork (`@babylonjs-toolkit/nodepod`), published, and the dependency bumped.
  - A missing local file must surface as the dev server's own 404, never as the pod's `index.html`.
- **A2. The Toolkit dev server answers a browser correctly.** The exporter's `WebServer`
  (`PE/Core/Projects/WebTools.cs`) must:
  - answer `OPTIONS` preflights with a bodiless success;
  - send CORS headers on every response, including 404 and 500;
  - stop pairing `Access-Control-Allow-Origin: *` with `Allow-Credentials: true`;
  - send `Access-Control-Allow-Private-Network: true` on preflights;
  - send `Cross-Origin-Resource-Policy: cross-origin`;
  - serve glTF with the registered types (`model/gltf+json`, `model/gltf-binary`).
- **A3. The dev server is safe on a real network.**
  - It **keeps serving the local network by default** (`localhost`, `127.0.0.1` and the machine's LAN
    address, as today), so phones, tablets and other machines can test a build (owner, 2026-09-29).
    Loopback-only becomes an explicit exporter setting: turning the "Serve To Local Network" toggle off
    binds `localhost` + `127.0.0.1` only.
  - Every request path is resolved and **refused if it escapes the web root** (`..`, encoded `..`,
    absolute paths).
- **A4. Port collisions are loud and solvable.**
  - When the port is taken (typically another Unity Editor on 8888), the start fails with a message
    naming the port and the likely cause, never a swallowed exception.
  - `bt_devserver_start` gains an `auto` port choice: the first free port from 8888 upward, which is
    then saved.
  - `bt_devserver_status` reports the project name and web root, so an agent can confirm the server
    it is about to use belongs to **this** project.
- **A5. The preview may ask for local network access.** Every **builder** preview surface delegates
  Chrome's Local Network Access permission. The permission names are **`loopback-network`** (Chrome
  145+, the one a `localhost` dev server needs) and **`local-network-access`** (the original name,
  Chrome 142–144). Both are delegated; a name a browser does not know is ignored, not an error.
  `local-network` (LAN addresses) is not delegated — the builder preview always addresses the dev
  server as `localhost`; the LAN binding (A3) exists for other devices, not for the preview.
  A same-origin iframe needs no delegation at all, and the Nodepod preview is same-origin, so this is
  belt-and-braces there and load-bearing for any provider whose preview is cross-origin. The surfaces:
  - the main iframe;
  - the device-frame iframe;
  - the device-frame popout document.

  The plain popout is a top-level window and needs nothing. The published-game wrapper does **not**
  delegate it (A8).
- **A6. A failed local load is explained, not silent.**
  - The injected preview script reports resource and fetch failures whose target is a local address,
    distinguishing "unreachable" (no server) from "blocked" (permission or CORS).
  - The builder shows one explainer dialog per session for each cause:
    - **Not running:** "Start your Unity dev server / Unity Bridge can start it".
    - **Blocked:** "Allow this site to reach apps on your device" — how to grant or re-grant it in
      Chrome site settings.
    - **Refused:** "the server refused the request" — upgrade the Toolkit exporter.
  - The same failures reach the agent through `get_game_errors`.
- **A7. Import a local scene into the project.** One action copies a local scene into the project's
  `public/scenes/<name>/`, byte-faithfully:
  - the `.gltf` plus every buffer and image its JSON references, or a single `.glb`;
  - relative URIs are preserved;
  - bytes are fetched **by the browser** from the local server and written through the existing
    binary-safe sandbox write, so they never reach the platform server;
  - existing files are only overwritten after the user confirms.

  It is offered in the Unity icon's dialogs (a Local scenes section present in both the Connect dialog
  and the Status panel, so it is reachable paired or not) and as an agent tool executed client-side, and
  it works **without** the bridge (it needs only a reachable dev server URL). Without a running helper
  there is no scene list; the user pastes the scene URL.
- **A8. Publishing refuses to ship a game that points at the author's computer — as a warning.**
  - The share checklist adds a `localhost-url` warning on source and built files. It must be
    acknowledged, and it names the file.
  - Its text says a published game cannot reach anyone's local server, and points at "Import to
    project".
  - The published-game iframe grants no local-network permission, so a stranger's browser never shows
    them a prompt on the author's behalf.
- **A9. The model knows the rule.**
  - One stable line in the hard-constraints prompt section: local scene URLs are for development only,
    and a scene must be imported before publishing.
  - When a dev server is known for this project, a volatile context note gives its origin and up to 20
    exported scene names. The note is placed **after the last cache breakpoint** (see Research Notes
    about the existing misplaced notes).
- **A10. Exported glTF is opaque to the model.** `.gltf` files join the opaque classification (they
  are generated JSON, often megabytes). The model learns a scene's components from the §4.9
  introspection note, never from raw glTF JSON in the file context.
- **A11. The local-folder path keeps working.** A scene that Unity (or the bridge) writes into the
  §4.5.4d project folder reaches the sandbox through the existing change poll. Two consequences are
  made loud:
  - when a new binary pushes the project past the 96 MB working-copy budget, the user is told the
    server recovery copy is now skipped;
  - a commit containing a file over GitHub's per-file limit fails before upload, naming the file.

### B. Unity Bridge — platform side

- **B1. Pairing (device-code flow).**
  - Running the helper prints a short code and the builder URL.
  - A signed-in user approves the code in the Unity Bridge dialog, and the helper receives a
    **per-device token**.
  - The server stores only a hash of it, in a new table that has RLS enabled and **no policy**
    (service-role only, the `git_tokens` precedent).
  - Devices are listed with name, OS and last-seen time, and each can be revoked, after which the
    helper's next request is refused and it says so.
  - Pairing attempts are per-user rate-limited. At most 5 devices per user.
- **B2. Transport.** The helper **long-polls** the platform over HTTPS:
  - a poll route is held open up to ~25 s and returns the next job, or nothing;
  - a result route delivers a job's result and progress.

  Presence is "polled within the last 45 s". Every route authenticates the device token inside the
  handler and is registered with the `outbound-enumerate` wall scan.
- **B3. Linking.**
  - A platform project is linked to exactly one (device, Unity project) pair, chosen in the dialog
    from what the helper advertises.
  - The helper advertises the Unity project(s) it was started for, with display names only, plus
    detected Unity CLI, Editor, Pipeline, Toolkit and Blender versions.
  - Absolute local paths are not stored server-side and are never shown to the model; the model works
    in project-relative paths, and the helper maps them.
- **B4. Tools offered to the model.** A small, generic set, never one tool per Unity command (the
  catalog is 150+ entries and would cost context on every turn):
  - **list commands** — the live catalog from the linked Editor, filterable, compact;
  - **run a Unity editor command** — typed commands and `bt_*`, by name + parameters;
  - **run a `unity` CLI operation** — the top-level binary;
  - **run a Unity C# script** — `run_script`;
  - **run a Blender Python script** — with declared input and output files;
  - **capture a Unity view** — Game or Scene view, returned to the model as a downscaled image;
  - **job control** — status, bounded wait, cancel;
  - **import a local scene** (A7) and **start / check the dev server**.
- **B5. When tools are offered.** Only on a **Build** turn whose project is linked to a device that is
  present. Never in Plan mode, and never on the first build turn — both already pinned by
  `tool-policy.spec.ts`.
  - When the bridge is linked but offline, the turn gets a one-line volatile note ("Unity Bridge
    offline — ask the user to run the helper") instead of tools.
  - The loop's tool-round budget is unchanged. Bridge tools count against it like any other tool.
- **B6. Safety tiers.** Every operation is enforced **at both ends**: the helper is the last wall on
  the user's machine and never trusts the server's classification alone.

  | Tier | What | Rule |
  |---|---|---|
  | **Allowed** | Read-only and status queries; typed editor authoring commands; `bt_*`; captures; dev server; `unity status/editors/logs/recompile/test/projects info\|verify/templates/releases`; opening or closing the linked project's Editor | Runs |
  | **Scripts** | `run_script`, `eval`/`eval_file`, and Blender Python | Needs the per-link **Allow scripts** switch. It is visible in the panel and icon tooltip, persists for that link, and can be revoked at any time |
  | **Consent** | Anything account-, seat-, machine- or history-level: `license *`, `auth *`, `install`/`uninstall`/`install-modules`, `self-update`, `projects new\|create\|clean\|upgrade`, `vcs resolve\|doctor --fix`, `unity build`; any editor command the catalog marks destructive (deletes, moves, renames, re-imports) | Per call: a Consent dialog shows the exact operation, and the user approves or denies. No answer in 120 s counts as a denial |

  - Paths in any parameter must resolve inside the linked Unity project, the helper's own output
    directory, or a Blender working directory the helper created for that job. Anything else is
    refused.
- **B7. Credits.**
  - A new ledger reason, **`bridge`**, is debited **before dispatch**. It may never go negative; with
    billing enforced and too few credits it refuses, and the refusal reaches the model as text.
  - Price by tier, from config with `0` disabling:
    - `BRIDGE_COMMAND_CREDITS` (default 1) — a command or CLI operation;
    - `BRIDGE_SCRIPT_CREDITS` (default 2) — a C# or Blender script;
    - `BRIDGE_JOB_CREDITS` (default 4) — long jobs: export, bake, build, render.
  - Listing commands, job status/wait/cancel, and dev-server status are free.
  - **Refunded exactly once** when the operation never ran on the machine: device offline, not picked
    up before timeout, refused by a tier rule, consent denied, or the helper failed before starting.
  - **Not refunded** once it ran, whatever Unity or Blender reported. A compile error is the
    project's result, not a platform failure.
  - The model's own tokens bill through the normal generation settlement, as today.
- **B8. Long operations never park the loop for minutes.**
  - Operations known to be long (exports, bakes, builds, renders, test runs), and any operation still
    running at 60 s, become **jobs** and return a job id.
  - Job wait is bounded (≤ 90 s per call).
  - A job that finishes after the turn ends is recorded; its outcome appears in the Jobs panel and in
    the next turn's volatile note.
  - The existing liveness heartbeat keeps the chat panel alive while a call is parked.
- **B9. Results are budgeted and untrusted.**
  - Every result is capped (the preview tools' 20k-char budget), trimmed from the **tail** for logs,
    and announces when it was truncated.
  - Images are downscaled to ≤ 1024 px on their longest side.
  - All output is data, never instructions (§4.14 posture).
- **B10. Prompt truth.**
  - The platform identity section neutralises the Agent Reference's "Agent Authority" claims:
    - Unity and Blender are driven **only** through Unity Bridge tools present this turn.
    - With no tools, the model must say Unity isn't connected, point to the Unity icon, and never
      print commands as though it had run them.
  - The identity text's stale "WebContainer" wording is corrected.
  - The five Unity/Blender reference documents are synced as on-demand reference blocks whose
    descriptions say they apply only when Unity Bridge tools are present.
  - A document larger than the reference read budget is **refused loudly by name**, never silently
    truncated. The durable fix is the doc split in D.

- **B16. Signed automation mode for the exporter licence (owner, 2026-09-27).** The exporter has an
  automation mode in which every licence check passes (`UnityTools.AutomatedEnabled`, used by nine checks in
  `BabylonLicense.cs`). It must switch on ONLY with a grant the App Builder signed:
  - The App Builder issues a short-lived **automation grant** to a paired Desktop Agent, only for an account
    in good standing — an active subscription **or** credits > 0, the same rule as §4.18a — and only for a
    Unity project that device has advertised.
  - The grant names the user, the device, the Unity project (by its `productGUID`), when it was issued and
    when it expires (at most 24 h). It is signed with a private key that exists only on the server.
  - The exporter verifies the signature with a public key embedded in the DLL, plus the expiry and that the
    grant's `productGUID` is this project's. Anything else leaves automation off. A grant is held in memory
    only for the Editor session.
  - The Desktop Agent fetches, renews and delivers the grant itself (a `bt_automation` command). The model
    never sees it, and it is never logged.
  - Without a valid grant, the user's own licence applies exactly as before, so a bridge on an account with
    no subscription and no credits still works for everything that is not licence-gated.

### B. Unity Bridge — UI (previous icon, four dialogs)

- **B11. The Unity icon returns where it was:** first in the chat composer row, before MCP tools, as
  the same Phosphor `cube-duotone` icon. It has three states:
  - **not paired** — neutral;
  - **paired but offline** — neutral with an "offline" tooltip;
  - **connected and linked** — the success colour.

  Connecting shows the ring spinner. The tooltip names the device and Unity project and whether
  scripts are allowed. When the bridge is disabled on the server the icon still shows, for local scenes only (A7).
- **B12. Connect dialog** (opens from the icon when not linked):
  - first, the Local scenes section (dev server URL, reachability check, paste-a-URL **Import**),
    marked "No bridge needed" — the same component the Status panel uses (A7);
  - the install/run command, with copy;
  - a pairing-code field and **Approve**;
  - the device list with revoke;
  - the Unity project picker for the link;
  - the detected Blender;
  - an "Unity Bridge needs Chrome, Edge, Safari or Firefox — any browser" note. Nothing here is
    Chromium-only; only local glTF permission prompts are.
- **B13. Status panel** (opens from the icon when linked):
  - device and link, with detected Unity CLI / Editor / Pipeline / Toolkit / Blender versions;
  - a version warning when the Toolkit is below the bridge minimum;
  - the **Allow scripts** switch;
  - the Local scenes section: dev server URL, state and a **reachability check** run from this browser,
    which diagnoses not-running, blocked or old-exporter (A6), plus the helper's exported-scene list with
    **Import to project** (A7);
  - unlink.
- **B14. Consent dialog:**
  - raised by a Consent-tier call;
  - shows the operation verbatim and which link it targets, with **Allow once** / **Deny**;
  - never a "remember" option, because account- and machine-level actions are exactly what must not
    be pre-approved.
- **B15. Jobs panel:**
  - running and finished jobs for this project, with progress lines from the helper, elapsed time, a
    **Cancel** button and the final result;
  - reachable from the status panel, and it opens itself once when a job started this turn is still
    running at the end of the turn.

### C. The Desktop Agent's bridge service (`@babylonjs-toolkit/agent`, `bt-agent bridge`)

- **C1. Package.**
  - Lives in the Desktop Agent repo (`UniversalSkills/`, npm `@babylonjs-toolkit/agent`, published from
    GitHub `babylontoolkit/skills`) as `lib/bridge/`, wired into the existing `bin/bt-agent.js` as a new
    `bridge` command (`bt-agent bridge [--server …] [--unity …] [--blender …] [--no-scripts]`,
    `bt-agent bridge status`, `bt-agent bridge logout`).
  - Follows the package's existing conventions: plain CommonJS JavaScript, no build step, zero runtime
    dependencies, Node ≥ 18, `node --test`. macOS and Windows first-class, Linux best-effort.
  - `bt-agent doctor` also reports the bridge's state (paired or not, `unity` CLI and Blender found).
  - Installing the Desktop Agent (`bt-agent install`, the global-install `postinstall`) never starts,
    pairs or schedules the bridge — it runs only when the user runs `bt-agent bridge`.
  - The App Builder's skills sync reads only `skills/<name>/` of that repo, so `lib/bridge/` never reaches
    the platform's skill store.
  - Published to npm by the owner (a new `@babylonjs-toolkit/agent` version). Publishing is an outward act
    and is not part of the build.
- **C2. Credential storage.** The device token lives in the OS user config directory, readable only by
  the user. `logout` deletes it and asks the server to revoke it.
- **C3. Discovery.** It finds:
  - the `unity` CLI (the documented locations, then PATH);
  - Blender (the macOS app bundle, Windows Program Files, then PATH, or `--blender <path>`);
  - the Unity project (cwd, or `--unity <path>`, repeatable).

  It reports the versions of each.
- **C4. It absorbs every Unity CLI trap the doc review found, so the model cannot fall into them:**
  - always `--project-path`, so `AMBIGUOUS_EDITOR` cannot happen;
  - JSON output only, branching on `success`;
  - `--yes` only where that subcommand accepts it;
  - every wait bounded, including `unity job wait --timeout`;
  - `safeMode: null` handled;
  - `blocked_by_dialog` surfaced to the user as "Unity is showing a dialog: <title>", not retried;
  - the `eval` 5-second main-thread limit reported plainly, steering to `run_script`.
- **C5. It absorbs every Blender trap:**
  - always `--background --factory-startup --python-exit-code 1`;
  - arguments in a safe order;
  - after a run it **verifies every declared output file exists** and fails if not;
  - any file it is about to modify inside a Unity `Assets/` folder is first copied to `<file>~` (which
    Unity ignores);
  - hard per-job timeout.
- **C6. Unsaved work is never discarded.**
  - Before any operation that opens or reloads a scene (`bt_export_level --scene`, resident-drawer
    reports), the helper checks for dirty scenes.
  - If a GUI Editor is open and the scene is dirty, the operation is refused with "Unity has unsaved
    changes in <scene>", and the model asks the user.
- **C7. Visible and stoppable.** The helper:
  - prints each operation it runs, with its tier;
  - stops cleanly on Ctrl-C;
  - reports jobs in flight as cancelled;
  - reconnects with back-off across platform deploys and network drops.
- **C8. Minimum versions.** The `bt_*` bridge needs Toolkit **9.25.1+**. Below that, `bt_*` operations
  are refused with an upgrade message, while typed commands still work. The helper reports the Unity
  Pipeline version it finds and never pins a command count.

### D. Fixes in the owner's other codebases

**Exporter.** Work goes in `PE/Core`, and in `PE/Project/BabylonToolkit-2024/Packages/com.babylontoolkit.editor/Editor/CLI/BabylonToolkitCliCommands.cs`, which currently has uncommitted edits that must be kept.

- **D1.** Everything in A2–A4.
- **D2.** `bt_devserver_start --port N` saves the port **after** confirming the server is not already
  running. When one is already running it reports the port it is actually bound to. The success
  message honours the alias and HTTPS instead of hardcoding `http://localhost:`.
- **D3.** `bt_export_level --scene` refuses when the open scene is dirty, rather than
  `OpenScene(…, Single)` silently discarding unsaved edits. `BuildProject`'s `SaveOpenScenes()` saves
  only scenes it opened itself, never a human's half-finished edits.
- **D4.** `bt_export_prefab` and `bt_export_animation` fail on a failed build, like `export_level`
  does. `LastBuildResult` is reset at the start of every export, so a guard-return cannot report the
  previous run's result.
- **D5.** The hardcoded owner-email licence bypass (`CANVAS_TOOLS_OWNERS`) must not be reachable by
  any user-supplied value in a release build.
- **D5b.** Automation mode (B16): `UnityTools.EnableAutomation()` must take a signed grant and verify it.
  The unconditional, parameterless version grants Pro to anyone who calls it (one line of
  `unity command eval`), so it is removed rather than kept alongside.

**Agent Reference docs.** Work goes in the local clone `/Users/mackey/Documents/Repos/Babylon/Repositories/AgentReference`, owner-directed like the 2026-08-05 `GetKeyDown` fix. It is inert on the platform until an admin re-syncs the prompt.

- **D6. Router (`reference.md`).**
  - "Agent Authority" becomes host-aware: *where your host gives you a terminal or Unity Bridge
    tools*.
  - Drop the hard "151 commands" count.
  - "9.22.3+" becomes "9.25.1+".
  - Add the ESM-vs-UMD exception for exporter output.
  - Correct "bt_* use Automate" (prefab and animation use `Scene`).
- **D7. `unity-blender-cli.md`.**
  - Fix `reweight.py`:
    - clear the parent keeping its transform before reparenting;
    - remove the old Armature modifier;
    - loop over every mesh (or take a name);
    - assert world bounds are unchanged.
  - The save branch raises on an unsupported extension and verifies the file exists.
  - Every operator call checks for `{'FINISHED'}` and selects/activates its target.
  - Add a render/bake recipe covering:
    - `-o` before `-f`;
    - valid engine ids;
    - bake requires Cycles, an active Image Texture node and `img.save()`.
  - Add Unity axis/scale guidance and an FBX preset. The "identical" check also compares transforms
    and sub-asset names.
  - Back up to `<file>~` rather than `.bak` inside `Assets/`.
  - `open_mainfile` is `.blend`-only.
  - Use `BLENDER=…` instead of `export PATH`.
  - Pin `bpy==5.1.*`.
  - Put the exit-code flag in the quick reference.
  - Narrow the "everything verified" claim.
- **D8. `unity-editor-commands.md`.**
  - "Destructive commands require `confirm`" becomes "some do — check the schema; dry-run where
    offered".
  - Bounded job waits and poll loops with a failure branch.
  - Explain the `eval` `timeout` name collision.
  - `DisableResidentDrawerReport` → save first.
  - Absolute capture paths.
  - A recovery for `blocked_by_dialog`.
  - Fix the §4B and §8 cross-references.
  - One name for the resident-drawer API.
- **D9. `unity-cli-reference.md`.**
  - `--yes` is per-subcommand.
  - Fence `license return` (all seats) and the other outward commands behind "ask the user".
  - Fix the `safeMode` / `pipelineServer.isReachable` JSON paths.
  - Fix the `unity logs` (Hub log), `skill install --local` (instead of) and `editors path`
    (directory) descriptions.
  - Resolve the WebGL-module contradiction.
  - Document `--no-dependencies`.
- **D10. `unity-exporter-cli.md` and `unity-authoring-recipes.md`.**
  - Copilot mode actually yields a GUI Editor: close the batch Editor, then `unity open`.
  - ✅ Hardcoded personal identity removed from examples, `companyName` marked EnterprisePartner-only
    (done 2026-09-27 — see Decisions).
  - Bounded poll helper with `failed` / `idle` branches.
  - `git` listed as a prerequisite.
  - One eval timeout story.
  - Consistent `Level01.gltf` casing; stop exporting `SampleScene` in examples.
  - `bt-stop-editor.sh` removes the lock only once the process is gone.
  - `unity run` with a timeout.
  - `Post.cs` null-safe.
  - Document the dev-server port bug's fix and the multi-Editor port rule.
  - Versions 9.25.1 / Pipeline "latest, check `list-versions`".
  - **Split the exporter doc:** move install/auth/eval duplication to the two new docs; licence
    internals to their own doc; §9/§10/§13 internals to an appendix. "Read the ENTIRE document"
    becomes "read §0, §4B, §11, §12; the rest on demand".
  - Host the scaffold scripts as raw repo files.

**Nodepod fork.** Work goes in `/Users/mackey/Documents/Repos/Nodepod`.

- **D11.** A1, with a test. The republish and version bump are owner steps.

### E. Documentation in this repo

- **E1.** Rewrite SPEC.md §4.17, §3 and §5, and add to §4.6, §4.5.4d, §4.8, §8 and
  `spec/sandbox-nodepod.md`. Rewrite CLAUDE.md's §4.17 paragraph and its "Current stage" block.
- **E2.** Replace the specs that pinned Unity's **absence** where the absence is no longer true:
  - the `project-notes` "no Unity frame" assertion;
  - `tool-policy` wording.

  Keep those that are still true: the `sse` refusal, and "no per-server relay window" (the bridge does
  not use the MCP relay's per-server timeouts).

## Design System Reference

- No DESIGN.md design system found — follow the existing UI conventions already in the codebase.
- Mirror, specifically:
  - the removed `UnityConnection.tsx` IconButton placement in `ChatBox.tsx`;
  - the Phosphor `i-ph:cube-duotone` icon, `i-svg-spinners:90-ring-with-bg` while connecting,
    `text-bolt-elements-icon-success` when connected;
  - the app's existing Radix dialog components and the Media panel's layout for list and progress
    rows;
  - `toolbar-button.ts` only if a header control is ever added (none is planned — the icon lives in
    the composer row, not the header, so §4.1a's fill rules are untouched).
- Every menu or popover uses `modal={false}` (the header scroll-lock trap).

## Possible Edge Cases

- **The dev server is on 8888 but belongs to a different Unity project** (four Editors were running
  during research). Status reports the root and project, the agent checks it, and the panel shows a
  mismatch.
- **A local scene exists in both the sandbox's `public/scenes` (imported) and on the dev server.** The
  pod serves its own origin, and the localhost URL goes to the dev server. They are different URLs by
  construction, so there is no shadowing once A1 lands.
- **Old Toolkit exporter** (no preflight, no Private-Network header). A plain GET of a `.gltf` sends
  no preflight and already carries `ACAO: *`, so loads mostly work. Failures are diagnosed as
  "old exporter" (A6), and bt_* below 9.25.1 is refused (C8).
- **Chrome denies, or the user dismisses, the local network prompt.** The "blocked" explainer
  includes how to reset it. The failed load is a normal game error, not a builder crash.
- **Safari / Firefox.** Local-network permission prompts do not exist there. Loads to `localhost` work
  or fail on CORS alone. The Unity Bridge is browser-independent.
- **Remote or dev-server sandbox providers** (CodeSandbox builds). Their preview is not same-origin
  and not served through the Nodepod service worker, so a `localhost` URL in the VM means the VM. The
  import (A7) and the bridge still work, because they run in the user's browser and helper.
- **A deploy restarts the platform mid-job.**
  - The helper reconnects, and finishes and reports the job.
  - The server has lost the parked tool call. The job result is recorded against the project, and the
    next turn's note carries it.
  - The operation already ran, so it was charged. Nothing ran twice.
- **Two tabs of the same project.** Jobs and consent prompts belong to the generation that raised
  them, and only the tab running that generation shows the Consent dialog.
- **The helper's machine sleeps.** Presence expires after 45 s, the next turn gets the offline note,
  and a parked call times out with a refund.
- **The user revokes the device mid-turn.** The in-flight call fails and is refunded, and later polls
  are refused.
- **Blender writes a file with a different name than declared** (`.001` suffix). The declared output
  is missing, so the call fails (C5) instead of reporting success.
- **A scene import whose glTF references `../` paths or absolute URLs.** Only in-root relative URIs
  are copied. Anything else is listed as not imported, and the import reports it.
- **A glTF over the working-copy budget** (A11): recovery-copy skip notice. A file over the GitHub
  limit gives a named refusal at commit time.
- **Plan mode with a linked bridge:** no bridge tools, and no charge.
- **Billing enforced with a zero balance:**
  - chargeable bridge calls refuse with a 402-shaped message the model relays;
  - free calls still work;
  - the balance never goes negative.

## Acceptance Criteria

- In a Nodepod project on both `localhost:5173` and the hosted app (Chrome), a game whose code loads
  `http://localhost:8888/scenes/Level01.gltf` from a running Toolkit dev server shows the scene with
  its textures, and the console is clean.
- Stopping the dev server shows the "not running" explainer once, and the game error reaches
  `get_game_errors`.
- **Import to project** copies a multi-file scene into `public/scenes/Level01/`.
  - Switching the game to the relative URL still loads.
  - The bytes are identical to the server's.
  - Publishing no longer shows the `localhost-url` warning, which it did before the import.
- The dev server no longer answers from another machine on the LAN by default, and a request for
  `/../ProjectSettings/ProjectVersion.txt` is refused.
- Running `bt-agent bridge --server <app origin>` inside a Unity project gets pairing done in under a minute:
  code, approve, link. The Unity icon turns green.
- In a Build turn, "export Level01 and load it in the game" results in:
  1. an export job that finishes;
  2. the game pointing at the local scene;
  3. a Unity Game-view capture and a browser screenshot, both shown in the reply;
  4. ledger rows for exactly the chargeable calls, and none for free ones.
- A `run_script` call with **Allow scripts** off is refused with a message naming the switch. With it
  on, it runs and charges `BRIDGE_SCRIPT_CREDITS`.
- A `unity license return` request raises the Consent dialog showing the exact command. **Deny** leaves
  the licence untouched and refunds the call.
- A Blender re-weight of the KayKit Knight through the bridge:
  - reskins every mesh;
  - leaves world bounds unchanged;
  - leaves a `Knight.fbx~` backup that Unity does not import.

  A script declaring a `.obj` output it never writes fails instead of reporting success.
- Automation mode cannot be switched on by hand: `unity command eval 'UnityTools.EnableAutomation("x"); return UnityTools.AutomatedEnabled;'`
  returns `false`, and so does a real grant for a different project, an expired grant, or a grant with one
  character of its payload changed. A grant from the App Builder for this project returns `true` until it
  expires, and an account with no subscription and no credits is refused a grant.
- With no bridge connected, asking the platform agent to "open Unity and bake the lighting" produces a
  reply saying Unity isn't connected and pointing at the Unity icon. It never pretends it ran a
  command.
- With a dirty scene open in a GUI Editor, `bt_export_level --scene` is refused with the scene named,
  and the scene's unsaved edits survive.
- `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` is green. The exporter builds in its
  solution, the Nodepod fork's tests pass, and the helper runs on macOS and Windows.

## Decisions

- **Outbound long-poll over HTTPS, not WebSocket.** Production runs Remix under **workerd** (`wrangler
  pages dev` in the Lightsail container), where a socket accepted by one request cannot be written to
  from another request's context. The `/api/agent` generation that needs to send a job is a different
  request, so a WebSocket needs Durable Objects, which this deployment does not wire up.
  - A held-open poll whose promise is resolved by the generation's request is exactly the
    cross-request promise pattern `mcp-relay.ts` already depends on.
  - It also sidesteps the unverified question of whether Lightsail passes upgrades.
  - Rejected: WebSocket (workerd I/O rule); browser → localhost companion (the §4.17 failure: CORS,
    PNA/LNA, pairing in a page); Electron (out of scope, and a platform-wide host change for one
    feature).
- **Device-code pairing with a hashed per-device token.** A CLI has no cookie, and a shared key is
  extractable (the §4.18a key is explicitly only a throttle). Device-code is the flow users know from
  `gh auth login`. The code is approved *inside* a signed-in session, so the two-wall rule holds.
  Rejected: pasting a session cookie (a full account credential on disk); a single platform key
  (anyone who unpacks the helper gets it).
- **The bridge is not an MCP server.** It is a platform-native tool family.
  - MCP semantics (third-party servers declared in `.mcp.json`, travelling with remixes) are the wrong
    trust model for something that executes on the user's machine.
  - The `.mcp.json` `sse`/`streamable-http` refusal stays true and keeps protecting remixes.
  - Rejected: reviving the `unity` reserved MCP label (that is what made a remixed project a vector).
- **A handful of generic tools, not the catalog as tools.** 150+ tool definitions would ride every
  bridge turn's prefix and churn with Pipeline versions (0.7 → 0.8 already moved the count). Rejected:
  one tool per command.
- **Three tiers, enforced in the helper as well as the server.** The helper is on the user's machine
  and is the only wall the user can see. A server bug or a prompt-injected model must not be able to
  run a script without the user's switch, or a machine-level command without a click.
  - Rejected: server-only enforcement.
  - Rejected: "everything needs consent" — it would make the tool loop unusable. Typed authoring
    commands are the normal path, and a click per `set_transform` is a product nobody uses.
- **Charge when it ran; refund when it never ran.** Our marginal cost is zero (the user's CPU), so the
  fee is product pricing, and a Unity-side failure is the project's result, not a platform fault
  (`spec/fail-loud.md`'s line between our waste and theirs).
  - Rejected: refund on any failure — a script can fail on purpose and be retried for free forever.
- **Tier prices are config with small defaults (1/2/4).** In line with media's per-task pricing and
  §4.6's "rates are config". Rejected: charging per second of Unity time (unobservable, and a bill the
  user can't predict).
- **Local glTF is browser-side and bridge-independent.** Most users with a dev server will not have
  paired a helper, and the fix is the service worker plus headers. Import is a client action so bytes
  never cross the platform (no spend path, no size-cap route). Rejected: routing scene bytes through
  the server or the bridge.
- **The published-game iframe never gets local-network permission.** A published game that reaches
  for the author's localhost is a bug to warn about, and a stranger should never see a permission
  prompt on the author's behalf.
- **`.gltf` becomes opaque to the model.** Exported glTF is generated and large, and §4.9 introspection
  already gives the model the part it needs. This is the §4.2.8 default ("generated → opaque").
- **The dev server keeps serving the local network by default (owner, 2026-09-29: option 1).** The owner
  tests builds from phones and other machines over the private IP, and that is how the server behaves
  today (`http://*:{port}/`). It serves the Unity export folder with no authentication, so the exposure is
  bounded instead: path containment (A3) confines it to the web root, and a loopback-only toggle is
  available for untrusted networks. Rejected: loopback-only by default — it silently breaks LAN device
  testing for every existing project.
- **Doc fixes are made at source, owner-directed.** CLAUDE.md's "never edit the Agent Reference from
  here" protects against casual drift. The owner directed this sweep, as with the 2026-08-05 fix. The
  platform must also not *depend* on the doc fixes: the identity-section override (B10) makes the
  platform truthful even before a re-sync.
- **The icon returns to the composer row, not the header.** It is the owner's "previous Unity icon",
  in its previous place, and it avoids adding a twelfth header control against §4.1a.

- **One server instance handles every bridge command (owner, 2026-09-27: "YES to platform a single
  server instance that handles all bridge commands").** The job registry lives in that process's
  memory, exactly like `mcp-relay`, and DEPLOY.md already runs `--scale 1`. The constraint is recorded
  next to the relay's in SPEC.md, so whoever scales out later sees both. Rejected: a shared queue
  (Redis/Durable Objects) — infrastructure for a scale the platform does not have.
- **Local Network Access names: `loopback-network` + `local-network-access` (resolved 2026-09-27 from
  Chrome's and MDN's published docs; the owner did not know the name, so it was looked up rather than
  guessed).** Rejected: `local-network` — it covers LAN addresses, and the builder preview never
  addresses the dev server by one (it always uses `localhost`, A3).
- **Personal identity removed from the Agent Reference (owner, 2026-09-27: "remove my name and email,
  that must have been a mistake").** Done in the local clone the same day: the six example values in
  `unity-exporter-cli.md` are now `<Licensee Name>` / `you@example.com`, and the `companyName` line is
  marked EnterprisePartner-only. D10's identity item is therefore complete; what remains is pushing it
  (an owner step). The strings are still in that public repo's **git history**.

- **The owner-email seat check (D5) is reachable, because it is a SUBSTRING match (resolved
  2026-09-27 by reading the code).** `HasDeveloperSeat()` (`BabylonLicense.cs:455`) tests
  `CANVAS_TOOLS_OWNERS.IndexOf(CloudProjectSettings.userName) >= 0` — "is the signed-in Unity email
  found anywhere inside the owners string". So `k24@gmail.com` or `24@gmail.com` passes, and an EMPTY
  user name passes too (`IndexOf("")` is `0`). It only matters to someone who already holds a Pro
  licence file, but it turns any such file into a developer seat. Fix: split the list and compare
  whole addresses exactly, ignoring an empty name. Rejected: deleting the owner list (the owner uses it).
  ⚠️ Found beside it, same file: `MakeSafeWebRequest` ships a Basic-auth password and a form `secret`
  as string literals in the DLL, where anyone can read them. If that endpoint is still live, those
  values should be rotated and moved out of the binary; if it is the retired ASMX service, the method
  should go.

- **The bridge is a service of the Desktop Agent, not its own package (owner, 2026-09-27).** One install
  gives a user skills, persona AND the bridge, and the package already has what the helper needs:
  cross-platform paths (`lib/paths.js`), self-update (`bt-agent update`), `doctor`, zero dependencies and
  `node --test`. Consequence: the helper follows that package's conventions (CommonJS, no build), so it
  cannot bundle this app's TypeScript tier module. **Each side keeps its own copy of the tier table, and the
  Desktop Agent's copy is authoritative on the user's machine**: a disagreement can only produce a refused
  (and refunded) call, never a looser rule, because the helper enforces its own table regardless of what
  the server says. Both copies are pinned by the same named test cases, and a protocol version in every poll
  tells an out-of-date agent to run `bt-agent update`. Rejected: a separate `@babylonjs-toolkit/bridge`
  package (a second install and a second self-update path); converting the Desktop Agent to TypeScript (a
  build step in a package that has none, for one module).
- **Foreground first; an always-on background service is a later, opt-in step.** `bt-agent bridge` runs
  while its terminal is open. Installing it as a login service (launchd, systemd, a Windows service) is the
  natural next step for the "Desktop Agent service", but a process that lets a website run commands on the
  user's machine must be switched on explicitly, never by `install` or `postinstall`. Not in this build.

- **Automation mode needs an App Builder-signed grant, verified with a public key (owner asked for "more
  secure automation mode", 2026-09-27).** The first version was a public, parameterless
  `EnableAutomation()`: one `unity command eval` line gave any free user Pro. An asymmetric signature is the
  only design where reading the DLL gets an attacker nothing: the DLL carries only the public key, and the
  private key never leaves the server. Binding the grant to the project's `productGUID` and a ≤ 24 h expiry
  limits what a copied grant is worth. Rejected: a shared secret in the DLL (extractable, like the licence
  `GetKeyPhrase` literal); an online check from the DLL on every licence test (the Editor would stall when
  offline, and the exporter already has a blocking-HTTP problem, `HasActiveSubscription`); persisting the
  grant to disk (it would outlive the session it was issued for).

## Open Questions

- None. Every question raised during research has an answer above.

## Research Notes

- **Removed bridge** (commit `4ab19ae6`; `_specs/unity-removal_plan.md`):
  - `app/components/chat/UnityConnection.tsx` — the icon `i-ph:cube-duotone text-xl` at old line 100,
    the dialog at ~108;
  - `app/lib/stores/unityBridge.ts`;
  - `app/lib/mcp/{remote-client,loopback}.ts`;
  - `companion/` (the removed browser-facing companion — superseded by the Desktop Agent's bridge service);
  - its composer-row placement in `ChatBox.tsx` (~352).
- **Tool loop** (`app/lib/.server/agent/proxy.ts`):
  - MCP relay tools 1387–1403, preview tools 1417–1449, media 1450–1498;
  - `toolPolicyForTurn` 1528, toolset merge 1812–1836, `cancelGenerationToolCalls` 3213;
  - `tool-policy.ts:258`; `mcp-relay.ts` (in-memory registry, ownership-checked delivery, never
    rejects);
  - data parts are written in `app/routes/api.agent.ts` 339 / 357 / 391.
- **Media billing to mirror:**
  - `app/lib/.server/media/service.ts` — `startMediaTask` 359 (anchor row 380–393, debit 398–423),
    refund latch ~534, `refundMediaTask` 689;
  - ledger reasons `billing/ledger.ts:55–65`, `mayGoNegative` 188;
  - CHECK constraint `supabase/migrations/0015_…`; latest migration **0024**, so the new one is
    **0025**;
  - lockstep sites: `ledger-sql.spec.ts:661`, `ledger-display.ts:80`, `money-paths.spec.ts:57`,
    `paid-path-rates.ts:97`.
- **Runtime:**
  - `functions/[[path]].ts` + `wrangler.toml` (`nodejs_compat`); `Dockerfile` / `package.json`
    `dockerstart`; DEPLOY.md:108–129 (workerd, `--scale 1`);
  - env vars must be declared in `worker-configuration.d.ts`.
- **Auth primitives:**
  - `http.ts:128` `denyUnlessVerified`, `ownership.ts:40`;
  - `git_tokens` (migration 0006:64) is the precedent for a service-role-only secret table;
  - `licensing/unity-api-key.ts` for header parsing plus timing-safe compare;
  - `security/user-rate-limit.ts:186`;
  - new routes must satisfy the `outbound-enumerate.spec.ts:43–44` wall regex.
- **Prompt:**
  - `prompt/sections/00-platform-identity.md` — the override section at ~27; the
    `skills-repository.md` neutralisation at ~70 is the pattern for B10;
  - `prompt/sources.ts` `BASE_DOCS` 91–94 / `ON_DEMAND_BLOCKS` 113+ (no Unity/Blender entries);
  - `agent/budgets.ts` (`DEFAULT_MAX_READ_CHARS` 120k; the exporter doc is 166 KB);
  - volatile notes go in `agent/project-notes.ts`. ⚠️ CLAUDE.md flags that `buildProjectNotes` output
    currently sits **before** the file-context breakpoint despite its comment. The new bridge note
    must go after the last breakpoint, as `discussNote` does, and must not silently move the existing
    notes.
- **Local glTF:**
  - `public/__sw__.js` (copied from `@babylonjs-toolkit/nodepod@1.9.18-btk.7` by
    `scripts/sync-nodepod-assets.mjs:26`) — the localhost-alias rule at 790–797, proxy to the pod at
    799–818, 404 network fallback at 1591–1607, COEP `credentialless` + CORP injected at 1581–1589;
  - the main-thread fallback skips localhost (`request-proxy.ts:810–817`);
  - document COEP `require-corp` at `app/entry.server.tsx:112–117`;
  - preview iframes at `Preview.tsx:822`, `1284–1298`, `1302–1310`, popout `835`; share wrapper at
    `share/wrapper.ts:81, 113–118`;
  - no document CSP (`security.ts:95–106` is used only by `api.supabase-user`);
  - preview script `app/lib/preview/agent-script.ts:22–28, 72–96` (does not capture resource-load
    failures today);
  - checklist `share/checklist.ts:71–72, 148–164`; `.gltf` sniffs as text so it is scanned;
  - change poll `local-project/external-changes.ts:60–100` (2 s, no size cap);
  - `working-copy-size.ts:36` (96 MB); GitHub `createBlob` has no per-file check
    (`git/github.ts:612–633`);
  - opaque list `app/lib/context/opaque-files.ts:42–76`; `web_fetch` blocks localhost
    (`net/ssrf.ts`), so the server model can never check a local URL itself.
- **Exporter:**
  - `WebTools.cs` — `HttpListener` on `http://*:{port}/` (62), CORS 253–257, none on 404/500
    (184–198), path join with no containment (163), MIME types 747–748, swallowed start failure
    116–120;
  - `CanvasToolsInformation.cs:747–748` (8888 / 4444); `UnityTools_HX.cs:8063–8117`
    (`StartWebServer`); `CVTools.cs:281` (`SaveOpenScenes`), `:70/279/297/320` (`LastBuildResult`);
  - CLI bridge `PKG/Editor/CLI/BabylonToolkitCliCommands.cs` — port bug 267–283, `OpenScene` 149–150,
    build types 165/224/248/308;
  - `BabylonLicense.cs:97, 455` (owner-email bypass);
  - package 9.28.0 in source, 9.25.1 distributed; no Blender integration exists.
- **Runtime library** (`/Users/mackey/Documents/Repos/Runtime/APP/src`):
  - `rootUrl` is derived from the scene URL (`core/CanvasTools.ts:481–485`, `SystemUtilities.ts:1296–1317`),
    so buffers and textures resolve against the dev server automatically; no URL or origin
    restrictions;
  - project script bundles load via `Tools.LoadScriptAsync` (`CanvasTools.ts:439, 463`) — under COEP
    these need the exporter's new CORP header (A2), which is why it is in scope.
- **Doc review evidence:**
  - three reviewer reports from this session, verified against Unity CLI `1.0.0-beta.11`, a running
    Editor catalog (Pipeline latest `0.8.0-exp.1`) and Blender `5.1.2`;
  - `reweight.py` damage reproduced on KayKit `Knight.fbx` (arm rotated 90°, only 1 of 9 meshes
    reskinned); the tested fix is `parent_clear(CLEAR_KEEP_TRANSFORM)` plus removing the old modifier.
- **Agent Reference local clone:** `/Users/mackey/Documents/Repos/Babylon/Repositories/AgentReference`.

## Testing Guidelines

Create tests beside the code they exercise (repo convention; never in `app/routes/`), without going
heavy:

- Service worker, `localhost:8888` from a preview client when the pod serves 5173 → network fetch, not
  pod proxy; `localhost:<pod port>` → pod (control).
- Exporter path mapping, `/../x`, `%2e%2e/x`, absolute path → refused; `/scenes/a.gltf` → served
  (control).
- Exporter `OPTIONS` → 204 with CORS + Private-Network headers; a 404 carries CORS headers.
- `bt_devserver_start --port 9000` while running on 8888 → reports 8888, saves nothing.
- Checklist, a source file containing `http://localhost:8888/scenes/x.gltf` → `localhost-url` warning;
  `https://repo.babylontoolkit.com/...` → none (control).
- Import planner, a glTF referencing `a.bin` and `tex/b.png` → both copied byte-identical; `../c.bin`
  and `https://…` → listed as skipped.
- Opaque classification, `public/scenes/x.gltf` → opaque; `src/game.ts` → visible (control).
- Pairing, an approved code → token issued once; a reused, expired or unapproved code → refused;
  stored value is a hash; RLS has no policy.
- Bridge routes, no or revoked token → 401 with zero side effects; appear in the `outbound-enumerate`
  wall scan.
- Tier classifier (the server and the Desktop Agent each carry the same table and the same test cases):
  - `bt_export_level` → Allowed; `run_script` → Scripts; `license return` → Consent;
  - an unknown command → Consent (default-deny direction);
  - a path parameter outside the link roots → refused.
- Billing:
  - executed call → one debit, no refund;
  - offline / timeout-before-pickup / denied consent / tier refusal → one debit + one refund;
  - free tools → no ledger row;
  - insufficient balance with billing enforced → refused, balance unchanged;
  - `bridge` reason present in the migration CHECK and in `LEDGER_REASONS`, and not in
    `mayGoNegative`.
- Tool policy, linked + present on a Build turn → bridge tools; Plan mode / first build / offline →
  none (offline → note).
- Helper:
  - Blender run declaring an output it never writes → failure;
  - writing inside `Assets/` → `<file>~` backup exists first;
  - dirty scene + export with `--scene` → refused;
  - every CLI wait carries a timeout;
  - `--yes` only added where the subcommand's help lists it.
- Prompt, no bridge tools this turn → the identity text states Unity/Blender are unavailable;
  on-demand block over the read budget → a named refusal, not a truncation.
