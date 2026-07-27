# spec/sandbox-codesandbox.md — Together CodeSandbox as a `SandboxProvider` (SPEC §8)

**Driven live against the real API on 2026-07-26**, `@codesandbox/sdk@2.4.2`, free Build plan, workspace
`mackeyk24`. Everything below marked MEASURED came off a real VM; everything marked ⚠️ UNVERIFIED did not.
§0–§10 were written as the evidence a provider would be built against; the provider has SINCE BEEN BUILT
(see the status updates below and `spec/sandbox-seam.md`) — the measurements stand, the "nothing is
built" framing does not.

Companion to `spec/sandbox-cloudflare.md`, which this **supersedes as the recommendation**: Cloudflare's
disk is ephemeral (a wake is a full re-materialisation) and it needs a deployed Worker alongside Lightsail.
CodeSandbox resumes with the filesystem intact and is a plain HTTPS API callable from the existing box.

> **STATUS UPDATE 2026-07-26 (late): the provider is BUILT and the whole creation path was DRIVEN LIVE
> through the real UI** — Blank Canvas creation → template fork → 68-file mount → generation (with
> media) → `npm install` → `npm run dev` → tokenized private preview rendering the generated landing
> page in the workbench iframe. Three defects found live and fixed, each of which read as "stuck on
> create / npm install / npm run dev" from the outside:
>
> 1. **`retainPartialOsc` infinite-looped ON THE UI THREAD** (`app/utils/shell.ts`):
>    `lastIndexOf('\x1b', -1)` clamps its fromIndex to 0, so an escape at position 0 was found forever.
>    The triggering bytes are every bash prompt redraw (`…\x07\x1b[?2004h<prompt>`), i.e. the FIRST
>    `npm install` of every creation pinned the tab at 100% CPU, the generation finished server-side
>    ("the client did not save this turn"), and the product looked frozen. The spec suite itself hung
>    on `shell.spec.ts` — the gates can never have been green with that code. Fixed + pinned.
> 2. **The preview iframe was double-blocked**: the bare `https://<id>-<port>.csb.app` a port event
>    carries answers 401 on a private sandbox (token wiring was unbuilt — now
>    `api.sandbox.preview.ts` + `mintPreviewUrl` + `options.previewUrl`), and even the tokenized URL
>    was refused by OUR OWN `Cross-Origin-Embedder-Policy: require-corp` (`*.csb.app` sends no CORP
>    header — MEASURED ERR_BLOCKED_BY_RESPONSE). COEP is now conditional on the provider build; it
>    exists only for WebContainer's SharedArrayBuffer.
> 3. **Already-open ports were never announced**: `onDidPortOpen` reports transitions only, and
>    `ports.getAll()` answers `[]` in the first moments after `connectToSandbox` (MEASURED), so a
>    reload over a running dev server showed "No preview available" forever. The provider now replays
>    open ports (two sweeps, t=0 and t=3s) into BOTH `onServerReady` and `onPort` — `onPort` is the
>    one that fills `PreviewsStore.previews`.
>
> Still open after the live run: per-project sandboxes (registry is per-USER — see `registry.ts`),
> the wake hook (a resumed/CLEAN sandbox has no dev server until the user runs one), billing/metering
> (§8 item 4), the template's `open: true` in `vite.config.ts` (prints a harmless-but-scary
> `xdg-open ENOENT` in the user's terminal), and the `runAtStart` task double-dev-server question on
> a fresh FORK (the template snapshot may hold port 3000 while the artifact's `npm run dev` takes
> 5173 — two Vites on one VM).
>
> **SECOND LIVE SESSION, 2026-07-27 — two more defects found by the owner using the product, both
> fixed + pinned:**
>
> 4. **A stale client copy silently REVERTED the generated landing page on reopen.** Two stacked
>    causes. (a) *The file map lags disk on this provider*: the action runner wrote straight to
>    `sandbox.fs.writeFile` and the store learned of it via watcher event + an enrichment read — a
>    network round trip per file — so the end-of-generation working-copy/checkpoint serialization
>    captured a STALE PREFIX (measured: the generated `Home.tsx` beside the STARTER's `Home.css`).
>    Fixed write-through: the runner now reports every landed write to
>    `FilesStore.recordAgentWrite` (same contract `saveFile` already had). (b) *The mount path
>    restored that copy over a LIVE sandbox*: correct on WebContainer (empty FS every load), data
>    loss on a persistent disk. `SandboxProvider.bootRestoredFilesystem` (from the session's
>    `bootupType` via `bootupPreservedFilesystem` — RESUME/RUNNING true, FORK/CLEAN false) now gates
>    the `local`/`working`/`diverged` restores in `useChatHistory`: a warm sandbox is re-scanned
>    (`refreshFiles`), never overwritten — §1's "recovery buffer, never the primary wake mechanism",
>    finally enforced in code. The clobbered files were recovered from the saved transcript's
>    artifact bodies (they live nowhere else once the disk is overwritten — remember that).
> 5. **A visible-but-unfocused tab lets the Pitcher socket go stale** (~20 min: every fs/terminal
>    call times out, typing into a terminal is silently dropped) because the reconnect signal only
>    listened to `visibilitychange`. `onFocusChange` now also notifies on window focus/blur — the
>    owner's "it works now that I moved the window" was the reconnect firing.
>
> ⚠️ Noticed, not yet handled: `refreshFiles` on a live sandbox now surfaces `.codesandbox/`
> (Dockerfile, tasks.json, template.json) into the file map — provider plumbing that will ride into
> context, working copies, exports and git pushes unless the ignore/opaque rules learn about it.
> (Re-confirmed unhandled at every layer by the 2026-07-27 review — see §11 finding M4.)
>
> **THIRD LIVE SESSION, 2026-07-27 (late) — creation on a REUSED VM, two defects fixed + pinned,
> then re-driven to a fully green creation (`npm install` exit 0, vite up, preview tokenized):**
>
> 6. **A reused VM wakes with a dev server already bound to 5173, and the creation's `npm run dev`
>    died on it** ("Port 5173 is already in use" — strictPort). Both reuse paths deliver one: the
>    per-user sandbox (a "new project" resumes the VM the previous project was using) and a fresh
>    `btk@starter` fork (the snapshot is taken while the tasks.json port task serves). Fixed with a
>    seam capability `clearPort` (fuser-by-port + pkill fallback + bounded wait-for-release;
>    WebContainer declares `false`) called from `clearInheritedDevServer` BEFORE `mountTemplate`.
> 7. **🔴 Stale OSC markers made `executeCommand` resolve against the PREVIOUS command — which
>    KILLED `npm install` on every creation.** bash's `PROMPT_COMMAND` fires on prompt draws that
>    follow NO command (attach, Ctrl-C at idle) — jsh marks neither — so a fresh bolt terminal
>    buffers exit+prompt pairs nothing consumes. Measured cascade: `npm install` "completed"
>    instantly against a stale exit 0 → the action chain moved on → `npm run dev`'s leading
>    interrupt killed the STILL-RUNNING install (its ^C surfaced as exit 130 on whichever wait was
>    up next) → the start action "failed" over a healthy server — and the interrupted installs left
>    `node_modules` corrupted (npm ENOTEMPTY on later installs), which is the "broken build on a
>    reused VM" tail. Fixed IN-BAND, not by timing: the rc block (v2, versioned marker so old VMs
>    get the upgrade appended) adds bash's `PS0` — expanded only when a typed command actually
>    starts — as a `begin` marker; `SandboxShell.beginOsc` declares it; `waitTillOscCode('exit')`
>    ignores every marker before it (`reduceOscSignals`, pure + pinned in `shell.spec.ts`). jsh
>    declares no `beginOsc` and is byte-identical. The rc v2 block also exports `BROWSER=true`,
>    which silences the `xdg-open ENOENT` noise item 4 of the open list flagged.
>
> **FOURTH SESSION, 2026-07-27 (later) — creation SPLASH + a full three-track code review.**
> The blank-purple-screen creation window got the same narrated treatment as the resume path: the
> `bootProgress` store gained `creating-*` phases (starter download → workspace boot → mount →
> finalize), written by `createProjectFromRegistry`/`startProject` and rendered by `CreationSplash`
> (an overlay sibling of `BootScreen`, one shared status panel — `boot-progress.spec.ts` +
> `create-project.spec.ts` pin the phases and the overlay gate; reset-to-idle is owned by ONE
> `finally` in `startProject`). Provider-agnostic by construction. Then the whole sandbox surface —
> server key-holder, client provider, and every integration touchpoint — was reviewed; the verified
> findings live in **§11** below and gate the cutover.

## 0. What does NOT change

The LLM path is untouched: generations still go through our server agent proxy on the KIE key with the
credit gate, context budget, doc-synced prompt and skills index. The sandbox runs the user's *project* and
never calls a model. The App Builder itself stays on Lightsail — CodeSandbox is a vendor we call, exactly
like KIE, not a place anything of ours is hosted.

One genuine improvement: §4.16 media bytes currently go KIE → browser → `createFile` → sandbox, which is
what froze the tab at 8 GB. With a server sandbox they can go KIE → our server → sandbox and never enter
the browser.

## 1. 🟢 THE DISK SURVIVES HIBERNATION — the design-defining fact, and it is the opposite of Cloudflare's

MEASURED, twice, on separate sandboxes:

```
hibernate → resume: bootupType=RESUME in 1.3s / 2.4s
  node_modules      = true   (95MB, 18 entries)
  source files      = true
  2MB binary        = byte-identical (sha256 match)
```

`Sandboxes.resume()` documents three outcomes and we observed the good one:

- **Hibernated with snapshot** → wakes and continues in 2–3s (**observed 1.3s and 2.4s**)
- **Hibernated with expired snapshot** → CLEAN boot, setup runs again
- **Shutdown** → CLEAN boot

**Snapshot lifetime — ANSWERED (their docs, 2026-07-26).** Hibernated sandboxes keep a memory snapshot on
disk for **up to 7 days**; after that (or under disk pressure) they are **archived to long-term storage**,
which still retains full state but resumes in **10–60s** instead of 1–3s. Only an *expired* snapshot forces
a CLEAN boot with setup re-run.

So the resume path degrades in three named tiers — 1–3s warm, 10–60s archived, CLEAN if expired — and a
provider must treat "resume was slow" as normal rather than as a fault. This also means the §4.5.4c working
copy stays a **recovery buffer** and never becomes the primary wake mechanism, which is the opposite of
what `spec/sandbox-cloudflare.md` §1 concluded for Cloudflare.

**Processes do NOT survive.** MEASURED: after resume, `ps aux | grep vite` → 0, ports list empty. The
filesystem comes back; the dev server must be restarted. That is a wake hook, not a blocker — and restarting
`npm run dev` on a warm `node_modules` MEASURED at **0.4s**.

## 2. 🟢 FORK A WARM TEMPLATE — `npm install` disappears entirely

`create({ id: <sandboxId> })` forks another sandbox, inheriting its whole filesystem. MEASURED, forking a
sandbox that already had Babylon + React + Vite installed:

```
fork → connect                    4.4s   (bootupType=FORK)
node_modules inherited            95MB, 18 entries
batchWrite 72 user files          0.7s
npm run dev → port 3000 open      0.4s
preview URL serving user's HTML   HTTP 200
─────────────────────────────────────────
TOTAL fork → playable preview     8.0s
```

Against **113s** for cold-create + `npm install` + dev, and against the WebContainer path's full
`npm install` on every page load. This is the shape §4.4's template pinning should take here: pin a prepared
**template sandbox id** the way we pin a starter commit SHA, promote it from the Admin panel, fork per
project. A project that adds dependencies beyond the starter pays a partial install; the starter set — all
of Babylon, Vite, React, the toolchain — is free.

## 2a. 🟢 THE API KEY NEVER REACHES THE BROWSER — the seam survives §5 intact

The obvious objection to a server sandbox is that `SandboxProvider` is consumed by **client** stores
(`FilesStore`, `PreviewsStore`, the workbench), while `@codesandbox/sdk` needs the platform API key — which
§5 forbids shipping to a browser. The SDK solves this itself, and the shape is exactly ours:

```
@codesandbox/sdk           (node, server only)  — holds CODESANDBOX_API_KEY
@codesandbox/sdk/browser   (client)             — connectToSandbox({ session, getSession })
```

`connectToSandbox` takes a **`SandboxSession`** — a scoped, per-sandbox credential minted by
`sandbox.createSession({ permission: 'write', env })` — and returns the same `SandboxClient` the server
gets (`.fs`, `.commands`, `.ports`, `.terminals`). No API key, and `getSession(id)` is documented as "an
endpoint that resumes the Sandbox", i.e. one of **our** two-wall routes.

So the split is:

| Where | Holds | Does |
|---|---|---|
| Lightsail (`app/lib/.server/sandbox/`) | `CODESANDBOX_API_KEY` | create / resume / hibernate / delete, mint sessions, mint host tokens |
| Browser (`app/lib/sandbox/codesandbox-provider.ts`) | a session only | `fs`, `spawn`, ports, watch — via `connectToSandbox` |

`SessionCreateOptions` also carries `permission: 'read' | 'write'` — a read-only session is the natural
implementation of a shared/gallery view, and it is enforced server-side rather than by hiding UI.

⚠️ The session is a bearer credential for one sandbox. It must be minted per user per project behind
`requireOwnedProject`, and it must never be logged. `onFocusChange` exists so a backgrounded tab can
reconnect — wire it, or a long-idle builder tab silently stops receiving file events.

## 2b. Templates are built by a CLI, and that CLI is the §4.4 pin

MEASURED. `npx @codesandbox/sdk build <dir>` (binary name `csb`) is the documented production path — their
docs say plainly *"Don't create templates on codesandbox.io, use the CLI"*.

```
csb build ./template --ports 3000 --alias btk@starter --vm-tier Pico --vm-build-tier Nano
```

- writes the directory into a scratch sandbox, builds `.codesandbox/Dockerfile`, runs the setup tasks,
  **waits for `--ports` to open**, then snapshots with the dev server ALREADY RUNNING;
- does this **once per cluster** — MEASURED building on US-3 and US-4 in parallel — so a fork is fast in
  any region;
- `--alias` (`namespace@name`) is a stable pointer to an immutable template. That is precisely §4.4's
  pin-and-promote shape: an admin promotes an alias the way they promote a starter commit SHA, and a push
  to the starter repo reaches nobody until they do.
- `--vm-build-tier` can exceed `--vm-tier`: build big, run small.

🔴 **A template needs `.codesandbox/tasks.json` or the build times out waiting for the port.** MEASURED —
the first build produced a working container and then failed with
`Timeout of 60000ms exceeded waiting for port 3000 to open`, because nothing had been told to install
dependencies or start the dev server. The image is the *environment*; tasks are the *project*:

```json
{
  "setupTasks": [{ "name": "Install dependencies", "command": "npm install --no-audit --no-fund" }],
  "tasks": {
    "dev": { "name": "Dev Server", "command": "npm run dev", "runAtStart": true, "preview": { "port": 3000 } }
  }
}
```

Their own guidance draws the line the same way: environment things (Node, Postgres) go in the Dockerfile;
project things (installing dependencies, building a binary) go in setup tasks.

## 3. API surface → `SandboxProvider`

Much closer to our seam than Cloudflare's. `readFile` returns `Uint8Array` **directly** — no base64 on the
wire in either direction, so `spec/binary-files.md`'s contract holds without an encoding hop.

| Our seam | CodeSandbox | Fit |
|---|---|---|
| `fs.readFile(path)` bytes | `fs.readFile(path)` → `Uint8Array` | ✅ MEASURED byte-identical at 2MB |
| `fs.readFile(path,'utf-8')` | `fs.readTextFile(path)` | ✅ |
| `fs.writeFile(path, data)` | `fs.writeFile(path, Uint8Array, {create,overwrite})` | ✅ |
| `fs.mkdir(path,{recursive})` | `fs.mkdir(path, recursive)` | ✅ |
| `fs.rm(path)` | `fs.remove(path, recursive)` | ✅ |
| `fs.readdir(path,{withFileTypes})` | `fs.readdir(path)` → `{name,type,isSymlink}[]` | ✅ **real readdir** — MEASURED |
| `mount(tree)` | `fs.batchWrite([{path,content}])` — zips, uploads, extracts | ✅ 74 files in 1.0s — **see §5a** |
| `spawn(cmd,args,opts)` | `commands.runBackground(cmd,{cwd,env})` → `Command` | ✅ `onOutput`, `onStatusChange`, `kill`, `waitUntilComplete` |
| — | `commands.run(cmd)` → output string | ✅ blocking variant |
| `onServerReady` | `ports.waitForPort(n,{timeoutMs})` + `ports.onDidPortOpen` | ✅ **push event**, better than Cloudflare's poll |
| `onPort` | `ports.getAll()` / `onDidPortClose` | ✅ |
| `watchPaths(opts, cb)` | `fs.watch(path,{recursive,excludes})` → `{onEvent,dispose}` | ⚠️ **no file contents** — §5b |
| `textSearch` | none | ➖ `capabilities.textSearch: false`, or `commands.run('grep -rn …')` |
| `teardown()` | `sandboxes.shutdown(id)` / `.delete(id)` | ✅ |
| terminal | `terminals` namespace, real PTY | ✅ better than jsh |

Extras worth having: `fs.stat`, `fs.copy`, `fs.rename`, `fs.download(path)` → 5-minute signed URL,
`sandboxes.listRunning()`, `sandbox.updateTier()`, `sandbox.updateHibernationTimeout()`.

## 2c. 🟢 THE WHOLE THING, END TO END — MEASURED

Fork the CLI-built template **by alias**, on the free plan, Pico (1 CPU / 2GiB):

```
[ 2.3s] alias btk@starter resolved → sandbox 89r6c7 (FORK)
[ 3.2s] glibc  : Debian GLIBC 2.36-9+deb12u14        ← custom image took
[ 3.2s] os     : Debian GNU/Linux 12 (bookworm)
[ 3.2s] node   : v20.20.2
[ 3.6s] node_modules: 20 entries, 100M                ← inherited, no install
[ 3.7s] ports at t=0: [3000]                          ← DEV SERVER ALREADY RUNNING
[ 4.6s] vite   : vite/5.4.21                          ← Vite 5 works on 2.36
[ 5.3s] mounted 72 user files                  0.7s
[ 7.1s] preview HTTP 200 — serving the USER files
[ 7.2s] /src/main.js  HTTP 200, babylon import rewritten by Vite
[ 7.6s] /havok.wasm   HTTP 200, 524288 bytes exactly
────────────────────────────────────────────────────
TOTAL alias-fork → user's game playable:      7.6s
```

**The dev server is already listening on port 3000 before we do anything** — the CLI snapshot is taken
*after* `--ports` opens, so the running Vite process is part of the restored memory image. There is no
install and no server start on the project-creation path at all.

🔴 **The CLI creates its template sandboxes as `public`.** MEASURED: all six `sdk-template`-tagged
sandboxes came out public, with no CLI flag to change it. For a starter that is fine (it is the same code
we would publish anyway), but **never build a template from a directory containing a secret**, and never
assume the template inherits the `privacy: 'private'` we pass at fork time — that setting applies to the
FORK, which was correctly private.

⚠️ A failed `csb build` leaves its per-cluster scratch sandboxes behind (4 orphans from the run that timed
out). They are shut down, so they do not bill, but a promote/rollback flow should reap them.

## 4. ✅ RESOLVED — the base image was Ubuntu glibc 2.31; a custom Debian 12 image fixes it

MEASURED. `npm run dev` on Vite 5 dies before binding a port:

```
Error: Cannot find module @rollup/rollup-linux-x64-gnu
  cause: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.32' not found
         (required by node_modules/@rollup/rollup-linux-x64-gnu/rollup.linux-x64-gnu.node)

$ ldd --version → ldd (Ubuntu GLIBC 2.31-0ubuntu9.14) 2.31
$ node -v → v20.12.1    $ npm -v → 10.5.0    $ whoami → root
```

Rollup 4 ships a **native** binary; rollup 3 (Vite 4) is pure JS, which is why Vite 4.5.5 starts fine on the
stock image (MEASURED) — but pinning the toolchain backwards to dodge an image problem is a workaround.

**The fix is one line in `.codesandbox/Dockerfile`:**

```dockerfile
# node:20-bookworm = Debian 12 => glibc 2.36, clearing Vite 5's rollup native binary.
FROM node:20-bookworm
```

MEASURED after `csb build`: `Debian GLIBC 2.36`, `node v20.20.2`, `vite/5.4.21` running and serving. The
custom image is also where the starter's `node_modules` gets baked, so it solves both problems at once.

🔴 **A bad image BRICKS the sandbox, and it fails as a hang rather than an error.** MEASURED: a bare
`FROM ubuntu:22.04` built successfully and the container started — but the CodeSandbox **agent** never came
up, so `resume()` itself hung for 3+ minutes and `delete()` returned `An unexpected error occurred`. Their
agent needs a base with the devcontainer tooling present; `node:20-bookworm` has it, bare `ubuntu:22.04`
does not. **Any image change must be proven by a `csb build` that reaches "Snapshot created"**, never by
editing `.devcontainer/` on a live sandbox and restarting it — that is how you get an unreachable VM you
cannot even delete. Their docs' "Debian and Ubuntu based images" is necessary, not sufficient.

⚠️ This is a **starter-template** constraint, not a provider constraint, and it belongs in the §4.4 pin
alongside the commit SHA. It also means the WebContainer starter and the CodeSandbox starter can silently
diverge on toolchain version — which is exactly the two-writers drift this codebase keeps rediscovering.

## 5. The three real gaps

**a. `batchWrite` takes RELATIVE paths only.** MEASURED: absolute paths fail with
`Unzip command failed with exit code 1`, relative paths work. The SDK zips the entries and extracts against
the workspace root, so a leading `/project/workspace/` becomes a bogus zip entry. Nothing in the types says
so — `BatchWriteFile.path` is just `string`. **Every other `fs` method takes absolute paths**, so this one
method is the odd one out, and getting it wrong fails at *extraction time* with a message that names neither
the path nor the cause. A provider must normalise, and a test must pin it.

Mitigation for the atomicity requirement (SPEC §4.4 — 64 sequential writes racing a cold boot): less urgent
than expected. MEASURED **64 parallel `writeFile` calls in 0.3s**, and `batchWrite` of 74 files in 1.0s.
Either is fast enough that the mount window is small; `batchWrite` is still preferable because extraction is
closer to atomic.

**b. Watch events carry no content.** `WatchEvent` is `{paths, type}`. Ours carry `event.buffer` and
`FilesStore.#processEventBuffer` builds the map straight from it, so every change becomes a follow-up
`readFile` round trip. Same gap as Cloudflare. Mitigations unchanged: we already `bufferWatchEvents(100,…)`,
and binaries need only `isBinary` + `size` in the map (§1.3 principle 10) so a binary event may need no read
at all. ⚠️ UNVERIFIED under real load — see the rate limit in §7.

**c. `workspacePath` is `/project/workspace`, not `/home/project`.** MEASURED. `WORK_DIR` is a constant
today and is baked into prompts, opaque-file rules and path rebasing. **Check every `/home/project` literal
before assuming this is a config change.**

## 6. Preview URLs — all three auth forms work, and private is genuinely private

MEASURED, on a `privacy: 'private'` sandbox:

| Access | Result |
|---|---|
| `csb-preview-token` header | HTTP 200 |
| `csb_preview_token` cookie | HTTP 200 |
| `?preview_token=…` query param | HTTP 200 |
| no token at all | **HTTP 401** ✅ |
| `/src/main.js` through the module graph | HTTP 200 |
| `/havok.wasm`, 512KB binary asset | HTTP 200, 524288 bytes exactly |

`sdk.hosts.createToken(sandboxId, { expiresAt: Date })` — `expiresAt` is **required**; omitting it throws
`Cannot read properties of undefined (reading 'expiresAt')`, which reads like a server error and is not.
Then `sdk.hosts.getUrl(token, port)` / `.getHeaders(token)` / `.getCookies(token)`.

🟢 **The query-param form is the one that matters**: an `<iframe src>` cannot set a header, so this is what
makes the preview embeddable with no proxy. URL shape is
`https://<sandboxId>-<port>.csb.app?preview_token=<token>`.

- 🔴 **Default privacy is `"public"`.** `CreateSandboxBaseOpts.privacy` defaults to public — a user project
  created without an explicit `privacy: 'private'` is **world-readable at a guessable hostname**. This must
  be set at every creation site, and pinned by a test, exactly like `adoptExisting: false` on the git save.
- 🔴 **Vite must allow the host.** MEASURED: without it every preview request is `HTTP 403 Blocked request.
  This host ("<id>-3000.csb.app") is not allowed.` — Vite's own guard, not CodeSandbox's, and the 403 body
  is the only thing that says so. The starter needs
  `server: { allowedHosts: ['.csb.app'], hmr: { clientPort: 443, protocol: 'wss' } }`. The `hmr` half is
  required because the preview is HTTPS on 443 while Vite thinks it is HTTP on 3000.
- Token expiry is ours to choose, revocable per-token (`revokeToken`) or wholesale (`revokeAllTokens`).
  This dovetails with §4.8's `PLAY_URL` origin-isolation rule.

## 7. Cost and limits, for our shape

Free **Build** plan, MEASURED from the workspace settings page:

| Limit | Value |
|---|---|
| VM credits | 400/month (≈ 40 hours of Nano) |
| Concurrent VMs | 10 |
| Sandboxes created per hour | **20** |
| API requests per hour | **3,600** |

VM tiers (from `VMTier`, MEASURED — note Pico is **1 CPU / 2GiB**, not the "very small" earlier guesswork):

| Tier | vCPU / RAM | $/hr | Our platform credits/hr¹ |
|---|---|---|---|
| Pico | 1 / 2 GiB | $0.074 | ~30 |
| Nano | 2 / 4 GiB | $0.149 | ~60 |
| Micro | 4 / 8 GiB | $0.297 | ~119 |
| Small | 8 / 16 GiB | $0.594 | ~238 |

¹ at `CREDIT_MARGIN = 4.0` and `CREDIT_UNIT_COST_USD = 0.01`, i.e. `raw_usd × 400`.

**Pico is enough.** MEASURED with the dev server running: **490MB of 2309MB used**. The earlier claim that
Babylon needs 4GB was wrong — meshes, textures, Havok WASM and the render loop are all *browser*-side. The
sandbox holds Vite's module graph and esbuild workers only. ⚠️ UNVERIFIED: peak RSS during `vite build`
(rollup over the full Babylon graph) — `/usr/bin/time -v` is not in the image, so this needs measuring
another way. That is the one genuinely memory-hungry server-side step, and it is on the §4.8 publish path.

🔴 **3,600 requests/hour is the limit to watch, not the credits.** That is 1/second sustained, and our
`FilesStore` is chatty: with content-less watch events (§5b) every file change becomes a `readFile`. A
single generation writing 20 files could burn 40+ requests. ⚠️ UNVERIFIED under real load — **measure this
before the tier question**, because it bites first.

⚠️ UNVERIFIED: what the free plan's **"CodeSandbox SDK lite"** actually restricts. Everything probed here
worked on the free plan; the restriction may be concurrency or tier ceiling (Build lists "VMs up to 4 vCPUs
+ 8 GiB", i.e. Micro).

## 8. Provider design implied by all of the above

- `capabilities`: `terminal: true`, `watch: true` (no content), `textSearch: false`, `clearPort: true`
  (a resumed/forked VM wakes with the previous session's dev server still bound to 5173 — both the
  per-user sandbox reuse and a `btk@starter` fork deliver one, and the creation artifact's own
  `npm run dev` then dies with "Port 5173 is already in use", MEASURED live 2026-07-27; creation
  clears the port via `clearInheritedDevServer` before mounting).
- **`privacy: 'private'` at every creation site.** Default is public. Pin it.
- **`batchWrite` paths are relative; everything else is absolute.** Normalise in one place, pin it.
- **A wake hook is required** — filesystem survives, processes do not. Restart the dev server on resume
  (MEASURED 0.4s warm). `exists()` on a sentinel is the cheap check, same shape as `waitForMountVisible`.
- **Template = a pinned sandbox id** (or image), promoted from the Admin panel like the §4.4 commit SHA.
- The §4.5.4c working copy stays a recovery buffer rather than becoming load-bearing infrastructure —
  because resume preserves the disk. That is the main thing CodeSandbox buys over Cloudflare.
- The API key is a platform secret: `app/lib/.server/**` only, never `VITE_`-prefixed, never in a response
  body (SPEC §5).
- Billing: sandbox time is a **new cost input** that scales with wall-clock, not tokens. It needs its own
  ledger reason, a metering sweep, and an overdraw policy, and `packMargin()` must be re-run. None of that
  exists yet.

## 9. Verify before building

**Both blocking questions are now ANSWERED** — ✅ a custom Dockerfile builds and fixes glibc (§4), and
✅ a snapshot lives 7 days then archives rather than expiring (§1). What remains does not block a provider:

1. **Request rate under a real generation.** (§7) 3,600/hr with content-less watch events is the limit most
   likely to bite first, and it bites before the credits do.
2. `vite build` peak RSS on the real Babylon Toolkit starter — the tier decision for the §4.8 publish path.
   `/usr/bin/time -v` is absent from the image; measure another way.
3. The full Toolkit starter, not the subset probed here (`@babylonjs/core` + `loaders` + React + Vite 5).
4. What "SDK lite" restricts on the free Build plan. Everything probed here worked on it.
5. `connectToSandbox` from a real browser (§2a) — proven from Node, not yet from a tab, and the
   reconnect/`onFocusChange` path is exactly the kind of wiring that "correct by construction" has lost
   three times in this codebase already.

## 10. Build order, once started

1. `app/lib/.server/sandbox/` — key holder: create/resume/hibernate/delete, mint sessions, mint host
   tokens. Two-wall routes (`requireOwnedProject`), and a `sandbox_id` on the project record.
2. `app/lib/sandbox/codesandbox-provider.ts` — `connectToSandbox` wrapped in `SandboxProvider`. The seam
   scan in `sandbox-seam.spec.ts` already forbids anything else importing the vendor; keep it that way.
3. Template pin + Admin promote/rollback on the `csb build` alias (§2b), mirroring §4.4.
4. Lifecycle + billing: a `sandbox` ledger reason, a metering sweep, an overdraw policy, and a re-run of
   `packMargin()`. SPEC §7's "user project compute: ~$0" stops being true — and this cost accrues **while
   the user is idle**, which no existing ledger reason does.
5. Flag it per-user/per-env and A/B against WebContainers before cutover (`spec/sandbox-seam.md` §8).

## 11. Code review, 2026-07-27 — verified findings that GATE the cutover

Three parallel review tracks (server key-holder, client provider, integration touchpoints) over the
whole sandbox surface; every finding below was verified against the source, the worst by hand a
second time. **None of these block WebContainer builds** (the review found zero regressions on the
default path); all of them are between here and flipping `VITE_SANDBOX_PROVIDER=codesandbox` for
real users.

### 🔴 CRITICAL — fix before ANY multi-project use

- **C1. Cross-project adoption: the per-user sandbox + the warm-boot gate can silently turn project
  B INTO project A.** The sandbox is keyed per USER (`registry.ts`, documented stopgap), but
  `liveSandboxIsTruth` (`useChatHistory.ts` mount path) checks only `bootRestoredFilesystem` — a fact
  about the VM, never *which project* the disk holds. Open project B while the user's single VM holds
  A: the gate skips B's restore, `refreshFiles` fills B's store with A's files, the next
  checkpoint/working-copy records A's game under B's identity, and a later Commit pushes A's code to
  **B's repo**. The gate needs a project-identity sentinel on the disk (written at creation, compared
  at mount) before it may open — or the per-project `sandbox_id` migration, which subsumes it.

### 🟠 MAJOR — lifecycle & money

- **M1. VMs leak and nothing ever reaps them.** `deleteSandbox` / `hibernateSandbox` /
  `deleteSandboxRecord` have **zero callers** (verified by grep — `deleteSandbox`'s own comment
  claims "called when the PROJECT is deleted"; `delete-leaves-nothing.spec.ts` never sweeps
  `sandboxes/`). A `reset` create overwrites the record without disposing the old VM; two tabs
  first-booting race the lock-less registry PUT and orphan the loser (which the loser tab still holds
  a live write session to). Orphans bill until the provider timeout and occupy the 10-concurrent /
  20-per-hour caps.
- **M2. `{reset:true}` is an unmetered, unlimited VM-creation loop.** Caller-supplied, honored
  unconditionally, no rate limit, no ledger reason, and each iteration orphans the previous VM (M1).
  Twenty requests exhaust the platform's hourly CodeSandbox cap — one confused retry loop takes the
  sandbox feature down platform-wide.
- **M3. The promised resume→create fallback does not exist, and gone-detection is a message regex.**
  `lifecycle.ts`'s comment says a 404'd resume "can fall back to creating"; the route turns it into a
  generic 500. `sandboxExists` classifies "confirmed gone" by regexing the error MESSAGE — if the SDK's
  wording shifts, every open is a permanent retryable 503 with no client reset affordance (the
  `retryable: true` body is read by nobody, and a boot failure is cached forever in the module-level
  `sandbox` promise).

### 🟠 MAJOR — the `/home/project` literal family (each one is the same bug)

`sandbox-paths.ts` (`toProjectRelativePath`, roots as a LIST) exists precisely for these; five call
sites never migrated. On a CodeSandbox build (`WORK_DIR=/project/workspace`):

- **M-P1. `stripOpaqueContent`'s default workdir is `/home/project/`** and its one caller passes
  nothing — the client-side opaque strip is a no-op, so the 218KB lockfile + vendored scripts are
  POSTed to `/api/agent` every turn (wire freight; the server's own strip still protects the model).
- **M-P2. `project-instructions.ts` misses `CLAUDE.md`** — no Project Instructions block, no cap, no
  precedence statement: the §4.2 money-path promotion silently regresses to the pre-2026-07-16 state.
- **M-P3. `plan-artifacts.ts` refuses `/project/workspace/_specs/...`** — Plan mode silently blocks
  the one write it is supposed to allow (the exact §4.2.9 defect, reintroduced per-provider).
- **M-P4. Netlify/Vercel deploy path rebasing no-ops** → file maps keyed with absolute sandbox paths
  → broken deploys on CSB builds. `share/checklist.ts`'s normalizer is the same copy (its secret
  regexes survive by accident — `(^|\/)` anchoring).

### 🟠 MAJOR — provider internals

- **M4. `.codesandbox/` rides into everything** (confirmed at every layer: watcher + refresh
  excludes, `IGNORE_PATTERNS`, opaque rules, working copy, ZIP export, git push — none know it).
- **M5. Shell signal demultiplexing can deadlock.** `executeCommand`'s prompt-wait is un-armed and
  shares one stream reader with a parked exit-wait; `reduceOscSignals` **breaks at the awaited code
  and discards the rest of the chunk's signals**, and bash emits `exit`+`prompt` in ONE chunk on
  Ctrl-C — whichever waiter gets the chunk starves the other. Creation worked live because stale
  attach-draw markers happened to backfill the prompt-wait; that balance is accidental and
  chunk-boundary-dependent.
- **M6. A failed `.bashrc` install hangs every shell action forever** — `ensureOscBashrc` is
  best-effort (warn) but the provider *unconditionally* declares `beginOsc`, so if the rc write fails
  (hardcoded `/root/.bashrc`; non-root image) every `waitTillOscCode` waits for markers bash will
  never emit. Degrade honestly: don't declare `beginOsc` when the install failed.
- **M7. `restoreFiles` has no store write-through** — `recordAgentWrite` closed the stale-serialize
  race for ARTIFACT writes only; repo mounts, working-copy restores, git pulls and checkpoint undos
  still fill the store via the RTT-per-file watcher, so a post-restore save can capture a stale mix
  (the 2nd-session defect through a different door).
- **M8. `resolveInWorkdir` DOUBLES an already-workdir-absolute path** (`/project/workspace/src/x` →
  nested junk) while its sibling strips it — latent (every caller rebases first), unpinned, at the
  exact seam the module exists to make safe. Watch-event paths are likewise passed through raw with
  no pin on the "absolute, workdir-prefixed" contract.
- **M9. Watch enrichment is the request-rate hazard and is untested.** `include` is silently ignored,
  the `'**/node_modules'` exclude-glob shape is unverified against the SDK, and no test ever fires
  the `onEvent` path (enrichment, read-failure classification, disposed gate). This is §7's
  3,600 req/hr limit — the one the spec says to measure FIRST.

### 🟡 Minor / notes (fix opportunistically)

`teardown()` is a silent no-op (`onTeardown` never injected — the comment claims otherwise);
mid-session reconnect after a provider-side delete swaps the user onto a fresh template FS silently;
preview tokens have no re-mint trigger for a long-lived iframe and the cache is keyed by port only
(serves the OLD sandbox's host after a recreate); `rm({force:true})` swallows ALL errors, not just
absence; `CODESANDBOX_HOST_TOKEN_MINUTES` has no upper clamp (a typo mints ~41-day bearer tokens);
the platform user UUID is written into vendor-side metadata under a parameter named `projectId`;
background exit codes are narrowed to 0/1 (documented); watch enrichment can deliver stale content
out of order for non-agent writes; `firstBootupType` is frozen per page, so a mid-session
CLEAN-reconnect reads as restored (data-loss direction, rare); the privacy scan matches the literal
`sandboxes.create(` (an aliased call evades it); `reset` has no client affordance (dead parameter);
security behavior of both routes is implemented but not behaviorally pinned (`outbound-auth.spec.ts`
has no sandbox entries; the enumerate spec passes them on source scan alone).

### ✅ What the review CONFIRMS (keep these properties)

Key hygiene is right (`CODESANDBOX_API_KEY` server-only, never in a response, pinned with controls);
`privacy: 'private'` at the sole creation site, scanned; sessions/tokens never logged; the tri-state
`sandboxExists` → refuse-on-unknown bias is correct and exhaustively tested; `decideSandboxStart` is
pure + tested; the batchWrite relative/absolute split is in ONE pinned place; the seam scans have
controls and mutation-verified allow-lists; test assertions are single-call (no concatenation trap);
**zero WebContainer-path regressions found**.

## Appendix — reproduction

Probe scripts live in the session scratchpad (`csb-probe/`), not the repo: `probe2.mjs` (cold path),
`probe3-fork.mjs` (fork path), `debug-image.mjs` (glibc), `debug-preview2.mjs` (preview auth),
`cleanup.mjs` (delete every `probe`-tagged sandbox). They read `CODESANDBOX_API_KEY` from `.env.local`.
