# spec/sandbox-cloudflare.md — Cloudflare Sandbox as a `SandboxProvider` (SPEC §8)

Research pass, 2026-07-26, against `developers.cloudflare.com/sandbox` + the Containers platform docs it
inherits from. **Nothing here is built.** Everything marked ⚠️ UNVERIFIED must be driven against a real
sandbox before we design around it — two Cloudflare doc pages already contradict each other on the most
important property (see §1).

## 0. What does NOT change

The LLM path is untouched. Generations go through our server agent proxy on the KIE key, with the credit
gate, the context budget, the doc-synced prompt and the skills index. The sandbox runs the user's *project*;
it never calls a model. Cloudflare's `-opencode` / Claude Code image variants are for a different product
shape (agent-in-the-sandbox, agent's own key) and would bypass metering entirely — **do not use them**.

One genuine improvement: §4.16 media bytes currently go KIE → browser → `createFile` → sandbox, which is
what froze the tab at 8 GB. With a server sandbox the bytes can go KIE → our server → sandbox and never
enter the browser at all.

## 1. 🔴 THE DISK IS EPHEMERAL — this is the design-defining fact

> "All disk is ephemeral. When a Container instance goes to sleep, the next time it is started, it will
> have a fresh disk as defined by its container image." — Containers architecture

> "When the container stops (due to inactivity or explicit destruction), all files are deleted… All files
> are deleted / All processes terminate / All shell state resets" — Sandbox concepts

**A slept sandbox does not come back with the user's files.** It comes back as the image.

⚠️ The Sandbox *lifecycle API* page reads as though sleep preserves state ("state is preserved for
resumption"). Two pages against one, and the concepts page is explicit and detailed — but this is worth
**60 seconds of empirical test** before a line of provider code: create a sandbox, write a file, force
sleep, wake, read it back.

### What it means

Wake is a **re-materialisation**, not a resume:

1. container boots from our image (1–3s cold start, `node_modules` already inside)
2. we write the project's source from the working copy / repo
3. we start the dev server

This is almost exactly what the WebContainer path does today — with the crucial difference that
`npm install` is replaced by "already in the image". It also means §4.5.4c's working copy stops being a
crash-recovery nicety and becomes **load-bearing infrastructure**: it is the thing a wake restores from.

Snapshots are "coming soon" per the docs. If they land, this section gets simpler.

## 2. API surface → `SandboxProvider`

| Our seam | Cloudflare | Fit |
|---|---|---|
| `fs.readFile(path)` bytes | `readFile(path, {encoding:'none'})` → `ReadableStream<Uint8Array>` (RPC transport only); `'base64'` otherwise | ✅ needs an adapter to buffer the stream |
| `fs.readFile(path,'utf-8')` | `readFile(path)` — auto-detects from MIME | ✅ |
| `fs.writeFile(path, data)` | `writeFile(path, content, {encoding:'utf-8'\|'base64'})`; `ReadableStream` for >32 MiB over RPC | ✅ binaries go base64 |
| `fs.mkdir(path,{recursive})` | `mkdir(path, {recursive})` | ✅ |
| `fs.rm(path)` | `deleteFile(path)` | ✅ |
| `fs.readdir(path,{withFileTypes})` | **not documented** | 🔴 see §3 |
| `mount(tree)` | none | 🔴 loop of `writeFile`, or `gitCheckout()` |
| `spawn(cmd,args,opts)` | `startProcess(cmd, {cwd, env, stdin, timeout, encoding, autoCleanup})` → `Process` | ✅ plus `waitForPort` / `waitForLog` / `waitForExit` / `streamProcessLogs` |
| `onServerReady` | `process.waitForPort(port)` + `exposePort` | ✅ better than an event |
| `onPort` | `getExposedPorts()` | ⚠️ poll, not push |
| `watchPaths(opts, cb)` | `watch(path, {recursive, include\|exclude})` → SSE `ReadableStream` | ⚠️ **no file contents** — see §3 |
| `textSearch` | none | ➖ `capabilities.textSearch: false`, or `exec('grep -rn …')` |
| `teardown()` | `destroy()` | ✅ |
| terminal | `terminal()` WebSocket + `SandboxAddon` for xterm.js, binary frames, `{type:'resize',cols,rows}` | ✅ real PTY — better than jsh |

Extras worth having: `exists()`, `gitCheckout(repoUrl,{branch,targetDir,depth})`, `exec()` /
`execStream()`, `listProcesses()`, `killProcess()`, `killAllProcesses()`, `mountBucket()`.

## 3. The three real gaps

**a. Watch events carry no content.** Ours do (`includeContent: true` → `event.buffer`), and
`FilesStore.#processEventBuffer` builds the file map straight from it. On Cloudflare every change event
becomes a follow-up `readFile` round trip. For a Vite project mid-generation that is a lot of chatter.
Mitigation: debounce (we already `bufferWatchEvents(100, …)`), and read lazily — the map only needs
`isBinary` + `size` for binaries anyway (§1.3 principle 10), so a binary event may not need a read at all.

**b. No documented `readdir`.** `FilesStore.refreshFiles()` walks the tree with
`readdir(dir,{withFileTypes:true})`. ⚠️ UNVERIFIED whether an undocumented `listFiles` exists; the fallback
is `exec('find /workspace -type f')` and parsing, which is fine but is a shell round trip.

**c. No atomic `mount`.** Our mount tree exists because 64 sequential writes raced a cold boot (SPEC §4.4).
Cloudflare has no bulk write. Options: a loop (slow, non-atomic), `gitCheckout` for repo-backed projects,
or write a tar and `exec('tar -x')`. **The atomicity requirement does not go away** — a half-written
project that starts `npm run dev` is the same bug.

## 4. Custom images — the `npm install` fix

Base images are Ubuntu 22.04: `cloudflare/sandbox:0.7.0`, `-python`, `-opencode`. Extend with a Dockerfile;
`wrangler dev` / `wrangler deploy` builds and pushes automatically.

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0
# Bake the Babylon Toolkit starter's dependencies so a wake never runs npm install.
COPY starter-package.json /opt/starter/package.json
COPY starter-package-lock.json /opt/starter/package-lock.json
RUN cd /opt/starter && npm ci
```

Then a wake copies or symlinks `/opt/starter/node_modules` into the project. A project that added
dependencies beyond the starter pays a partial `npm install`; the starter set — which is all of Babylon,
Vite, React and the toolchain — is free.

🔴 **The image tag must match the npm package version exactly** (`@cloudflare/sandbox@0.7.0` ↔ `:0.7.0`).
Mismatches "trigger warnings and potential feature breaks". That is a version-pin discipline exactly like
§4.4's template pinning, and it belongs in the same place.

⚠️ Image size limits are not documented. Baking Babylon's `node_modules` is not small — measure it.

## 5. Idle, sleep, lifecycle

| Option | Type | Default | Notes |
|---|---|---|---|
| `sleepAfter` | `string \| number` | `"10m"` | `"30s"`, `"5m"`, `"1h"` or seconds. Ignored when `keepAlive`. |
| `keepAlive` | `boolean` | `false` | Pings every 30s, never times out. **Must be explicitly destroyed.** |
| `containerTimeouts.instanceGetTimeoutMS` | ms | 30000 | provisioning |
| `containerTimeouts.portReadyTimeoutMS` | ms | 90000 | API readiness |
| `normalizeId` | `boolean` | `false` | 🔴 **set `true`** — DNS is case-insensitive and preview URLs mis-route on uppercase ids |
| `enableDefaultSession` | `boolean` | `true` | being removed; use `createSession()` |

`getSandbox(id)` — same id, same sandbox. Shutdown is SIGTERM then SIGKILL after 15 minutes.
Cold start 1–3s. A woken sandbox may start in a **different geographic location**.

## 6. Preview URLs

`exposePort(port, {hostname, token?, name?})` → `https://[port]-sandbox-[id]-[token].[hostname]`.

- 🔴 **A custom hostname is required — `.workers.dev` does not work.** We need a real domain for previews;
  this dovetails with the existing `PLAY_URL` origin-isolation rule (§4.8, `share/serve.ts`).
- Token is 1–16 chars, auto-generated random if omitted. Omit it → unguessable-ish per session. Supply it →
  stable URL across restarts. **Default to auto-generated**: our posture is "unguessable and dies with the
  sandbox".
- `unexposePort(port)`, `getExposedPorts()`, `validatePortToken()`.
- Ports 1024–65535.

## 7. Cost, for our shape

Rates (Workers Paid, $5/mo minimum — **no free tier for Containers**):

| Resource | Rate | Included/month |
|---|---|---|
| vCPU | $0.000020 / vCPU-s | 375 vCPU-min |
| Memory | $0.0000025 / GiB-s | 25 GiB-hr |
| Disk | $0.00000007 / GB-s | 200 GB-hr |
| Egress (NA/EU) | $0.025 / GB | 1 TB |

| Instance | vCPU | Memory | Disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |

**vCPU bills on active use; memory and disk bill on PROVISIONED size for as long as the container is awake.**
So memory dominates an idle-but-awake builder session, and `sleepAfter` is the main cost lever — not CPU.

Estimate, standard-2, one awake hour at ~10% CPU:

```
vCPU    3600 × 0.10 × $0.000020 = $0.0072
memory  3600 ×  6   × $0.0000025 = $0.054
disk    3600 × 12   × $0.00000007 = $0.003
                                   ≈ $0.064 / awake hour
```

At `CREDIT_MARGIN = 4.0` (~$0.0025 raw per credit) that is **~26 credits per awake hour** — roughly 10% of
one `/bt-spec` generation (263 credits measured). Material, not alarming. ⚠️ These are derived from list
rates, not measured; and `standard-1` (4 GiB) may not hold Vite + esbuild for a Babylon project — **measure
before choosing the instance type**, because memory is both the constraint and the bill.

Also billed: Workers requests, Durable Objects (one per sandbox), optional Workers Logs.

## 8. Provider design implied by all of the above

- `capabilities`: `terminal: true` (real PTY), `watch: true` (no content), `textSearch: false`.
- **`workdir` is `/workspace`**, not `/home/project`. Watches must resolve inside it. Our whole app rebases
  through `path.relative(workdir, …)`, so this should be a config value — but `WORK_DIR` is a constant today
  and is baked into prompts and opaque-file rules. **Check every `/home/project` literal before assuming.**
- **A wake hook is required.** Something must notice "fresh container" and re-materialise. `exists()` on a
  sentinel is the cheap check — the same shape as `waitForMountVisible`'s sentinels (§4.4b).
- The working copy becomes load-bearing. Its size gate (`DEFAULT_CLIENT_WORKING_COPY_MAX_MB`) currently
  decides whether we hold a *recovery* copy; it would then decide whether a project can be **woken at all**.
  That is a much bigger promise and the number needs re-deriving.
- Binary bytes: base64 over the wire in both directions. `spec/binary-files.md`'s byte-identity contract
  must be re-proven end to end — a `havok.wasm` round trip is the test.
- Egress: every preview asset load is billed egress. A Babylon project serves big textures and `.wasm`.
  1 TB included is a lot, but this is the one line item that scales with *players*, not builders.

## 9. Verify before building (in this order)

1. **Does the filesystem survive sleep?** Write, sleep, wake, read. Everything above depends on the answer.
2. Is there a `readdir`/`listFiles`, or do we shell out to `find`?
3. Does a baked-`node_modules` image build, and how big is it?
4. Does Vite + Babylon actually run in `standard-1` (4 GiB), or do we need `standard-2`?
5. Cold-start → dev-server-ready wall clock, end to end. This is the number the whole swap is judged on.
6. `havok.wasm` byte-identity through `writeFile`/`readFile` base64.
