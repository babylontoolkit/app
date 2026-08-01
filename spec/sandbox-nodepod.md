# Nodepod — the browser-side SandboxProvider (SPEC §8)

> **Status: ADOPTED, live-proven 2026-07-31.** Nodepod replaces WebContainers in the browser-side slot.
> **CodeSandbox is untouched** and remains the server-side provider. BrowserPod is REJECTED — see
> `spec/sandbox-browserpod.md`, kept because the spike is what produced the capability map below.

## Why a browser-side provider at all

**The requirement is the absence of a clock.** A cloud VM bills while a user walks away, which is the
only reason hibernate machinery has to exist; a browser-side runtime has $0 marginal compute and no
idle cost to manage. That — not the hourly rate — was always the reason WebContainers was preferred.
StackBlitz priced it out at ~$10,000 per 8,000 API calls, leaving the slot empty.

## What was measured (2026-07-31, real AppTemplate, not a probe app)

Driven through Chrome against `@scelar/nodepod@1.9.12`, mounting the **real pinned AppTemplate
snapshot** (66 files, commit `62a34a9b`) — the same fixture the BrowserPod spike used, so the numbers
are comparable rather than merely both existing.

| Step | Result |
|---|---|
| `Nodepod.boot({ files })` — 66 files, 12 binaries, 8.0 MB | **0.1 s** |
| Binary byte-identity via `fs.readFile` | **12/12 exact**, incl. `havok.wasm` (2,094,566 B) and a 2.9 MB PNG |
| `npm install` — direct to registry.npmjs.org | **306 packages, 46.6 s, exit 0** |
| `npm run dev` — our own 8,903-byte `vite.config.ts` | **VITE v8.2.0 ready in 1,244 ms** |
| Landing page first paint, **deps already optimized** | **0.5 s** |
| Landing page first paint, **fresh pod** (includes Vite dep optimization) | **17.1 s** |
| `fs.writeFile` → Vite HMR notification | **66 ms** |
| `fs.writeFile` → changed UI on screen | **1.0 s** |
| Click → `PlayerControllerDemo` rendering | **4.6 s**, WebGPU, 1040×640 |
| Click → `VehicleControllerDemo` rendering (Rigged Mustang) | **5.3 s** |

**Second boot in the same browser** (the returning-user case — `enableSnapshotCache`, IndexedDB):

| Step | Cold | Warm |
|---|---|---|
| `Nodepod.boot({ files })` | 0.10 s | **0.06 s** |
| `npm install` | 46.6 s | **1.9 s** ("added 0 packages") |
| `npm run dev` → server ready | 2.5 s | **1.1 s** |

⚠️ **The two first-paint numbers are both real and must not be quoted interchangeably.** 0.5 s is a
page load against an already-warm Vite; 17.1 s is the first load on a fresh pod, where Vite still has to
optimize deps even though `node_modules` came back from IndexedDB. The snapshot cache restores
packages, **not** `node_modules/.vite/deps`. Baking the dep cache into the restore is the obvious next
win and is not yet attempted.

`watermark: false` verified — no "nodepod" mark anywhere in the preview DOM.

Confirmed from the preview's own resource log: `@babylonjs-toolkit/next/lib/scenemanager.js`
(**12.2 MB**, 1,244 ms), `@babylonjs/havok/lib/esm/HavokPhysics_es.js` (277 KB), `havokPlugin`
(449 KB), 250 resources, **zero errors**. Physics ran; the character stood on the ground with a shadow.

**Two flagged risks retired by this run:**

1. **The cross-origin scene load survives `COEP: require-corp`.** The demo streams
   `https://repo.babylontoolkit.com/playground/samplescene.gz.gltf` (SPEC §4.4 open question #19) and
   it loaded with no CORP/CORS work on our side.
2. **Vite is not broken in the browser.** The `Atomics.wait` deadlock that killed every wasm bundler is
   a defect in BrowserPod's *wasm Node*, not in browsers. Vite 8 + rolldown
   (`@rolldown/binding-wasm32-wasi`) optimized deps and served normally.

## Why Nodepod and not BrowserPod

The BrowserPod spike's real output was the map of what our seam actually needs. Nodepod supplies all
of it:

| `SandboxProvider` need | BrowserPod | Nodepod |
|---|---|---|
| `fs.readdir` | ❌ absent — shell out and parse | ⚠️ `string[]` (no dirents — see gaps) |
| `fs.rm` | ❌ absent | ✅ `rm(path,{recursive,force})` |
| `watchPaths` | ❌ absent (zero inotify) | ✅ `fs.watch(path,{recursive},cb)` |
| `SandboxProcess.exit: Promise<number>` | ❌ no exit code at all | ✅ `completion` + `on('exit')` |
| `kill()` | ❌ absent — could not stop a dev server | ✅ |
| preview transport | 🔴 ~165 ms/request via Cloudflare | ✅ **same-origin Service Worker, no network** |
| bundler | 🔴 deadlock | ✅ |
| vendor dependency | 🔴 closed blob from their CDN, API key, TOS §8 termination | ✅ **none** |

**No vendor in the request path.** A grep of the shipped bundle for remote hosts returns only
`registry.npmjs.org`, `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`, `api.github.com` — all public
infrastructure. No API key, no relay, no server the vendor controls. That is the property BrowserPod
could not offer at any price, and it is why this is not simply trading one dependency for another.

## Adoption decisions (owner, 2026-07-31)

- **FORK AND VENDOR IN-TREE at a pinned version.** MIT means nobody can take it away — but only if we
  actually hold a copy. Do not track a floating npm range.
- **Watermark off.** `Nodepod.boot({ watermark: false })` — a documented boot flag, no patching.
- **Licence interpretation is the owner's call and is settled.** For the record only: the repo
  `LICENSE` and the npm `license` field both read `MIT WITH Commons-Clause`, while the project's blog
  states "MIT licensed… no commercial restrictions." Do not re-litigate this here.

## Gaps to close in the adapter — each of these fails silently if skipped

1. **`readdir` returns `string[]`, but `refresh-walk.ts:15-18` requires
   `readdir(path,{withFileTypes:true})`.** Synthesise dirents via `stat()`. Cheap here — the VFS is
   in-memory, unlike CodeSandbox where every `fs` call is a network round trip.
2. **🔴 RESOLVED — the preview is same-origin at `/__virtual__/<pod>/<port>`, and a root-absolute path
   escapes the mount.** Observed live: an iframe reload loaded the builder page instead of the game and
   looked exactly like a hang. Cause was `previewUrlWithPath` doing `joined.pathname = path` —
   **assigning** over the pathname, which was correct only because every preview base until then had a
   pathname of `/`. Under the mount, assigning rewrote the URL to `/play` on our own origin. Fixed by
   APPENDING under the mount; CodeSandbox and WebContainer are byte-identical, asserted as a control
   rather than assumed. Same class as the T17b `/play/:shareId` base-path defect. A dedicated preview
   origin was NOT needed.
3. **`Nodepod.boot()` throws without cross-origin isolation.** COOP `same-origin` + COEP
   `require-corp` are mandatory (the sync VFS bridge is `Atomics.wait` over `SharedArrayBuffer`).
   Without SAB, `execSync`/`spawnSync` throw and threaded WASI modules — rolldown included — refuse to
   load. Verify `entry.server.tsx` covers the new provider id **deliberately**, not by accident.
4. **`/__sw__.js` must be served from the root of our own origin** with `Service-Worker-Allowed: /`. A
   service worker's scope cannot rise above its own path and browsers refuse to register one out of
   `node_modules`. Ship it as a first-class asset derived from the vendored package, never a hand-copied
   file that silently drifts from the installed version.
5. **The OSC shell contract.** `app/utils/shell.ts` hardcodes `\x1b]654;` and `executeCommand` waits for
   `exit=<n>:<code>`. Nodepod gives **real exit codes**, so no bash-rc trick is needed — synthesise the
   markers in `nodepod-translate.ts` and reuse `shell.ts`'s existing parser. Do not write a second
   "did the command finish" mechanism; that is the two-writers drift this repo keeps rediscovering.

## Measurement traps hit during this spike — worth not repeating

- **A WebGPU canvas cannot be read back with `drawImage`.** A pixel sampler reported the canvas as
  solid black while the scene was visibly rendering. **Screenshot beats pixel-probe on this stack.**
- **`Home.tsx` renders markup identical to a static preloader**, so "still showing the splash" was
  misread as "React never mounted". `index.html`'s `#root` is empty — that is the check that settles it.
- **The landing page has no `canvas` by design** (Babylon is lazy-loaded on the game view, which is what
  `vite.config.ts` is set up for). Waiting for a canvas on `/` reports a false negative forever.

## Live drive of the real product (2026-07-31) — three defects, all silent, all now pinned

Phase 1 shipped unit-proven and "correct by construction". Driving the actual builder found three
defects in the first minute, none of which any unit test could have reached — the same lesson the MCP
relay taught, and the reason `CLAUDE.md` says to drive the real UI before claiming a feature works.

**1. `npm: command not found`, and the character that explained it was invisible.**
`BoltShell.executeCommand` writes `'\x03'` (Ctrl-C) before EVERY command and then waits for a prompt.
Nodepod has no shell, so the adapter's synthesised one IS the line editor — and it knew nothing about
control characters. `\x03` carries no newline, so it sat in the line buffer and was glued onto the next
line: the command ran as `"\x03npm install"`, `String.trim()` does not strip `\x03` (it is not
whitespace), and the first word was `"\x03npm"`. The runtime correctly reported no such command, and
because `\x03` does not render, the terminal displayed exactly `npm: command not found`. Install
failed, the dev server never started, and the terminal — the one place a human would look — showed a
command that looks perfectly correct. Fixed in `createInputBuffer` (interrupt + backspace as first-class
inputs); the interrupt runs **out of band**, never through the command queue, or it would not fire until
the process it is meant to interrupt had already exited.

**2. The file map stayed EMPTY behind a fully populated VFS.** 54 text + 13 binary files were written
to disk, and `workbenchStore.files` had none of them: blank workbench tree, `Mount not visible in the
file store after 15000ms — generating with a PARTIAL context`, and the working copy refused as empty.
Cause: `toWatchEventType` mapped Nodepod's `rename` to `update_directory`, and
`FilesStore.#processEventBuffer` has **no case** for that type, so every event fell through the switch.
The mapping was written deliberately, to avoid guessing add-vs-remove — **and that instinct is what
caused it: when the consumer has no handler for the honest answer, honesty is silence.** The fix is not
to guess harder but to ASK — the adapter stats the path and reads its bytes, and the pure
`classifyWatchEvent` decides from facts. Note this would have shipped a *worse model context* while
throwing nothing (§4.2.8's stated failure mode).

**3. `node_modules` would have flooded the map.** Nodepod's `fs.watch` takes no exclude option, so
`options.exclude` must be applied in the adapter — the first version ignored the options object
entirely. Unfiltered, `npm install`'s 306 packages each cost a stat, a full `readFile` and a store write
on the UI thread. Defect 1 masked this by preventing install from ever running.

Also fixed while in there: `WORK_DIR` was still computed as
`VITE_SANDBOX_PROVIDER === 'codesandbox' ? … : '/home/project'` — the last instance of the exact
compare-against-one-id shape `sandbox-runtime.ts` was created to delete, missed when the other three
were converted **because it gave Nodepod the right answer by luck**. An anti-pattern that is
accidentally correct is invisible. The workdir is now a trait per provider, and
`sandbox-runtime.spec.ts` asserts every one of them is in `SANDBOX_ROOTS` — an agreement that until now
existed only as a sentence in a comment.

### Verified live, end to end

| | |
|---|---|
| Creation → playable starter | ~50 s cold, splash covering continuously (`coverToggles: 2`, zero uncovered file growth) |
| `npm install` + `vite` | **VITE v8.2.0 ready in 887 ms** in-pod |
| Preview | served by the SW at `/__virtual__/<pod>/5173`, starter landing page rendering in the real workbench |
| File tree | fully populated, binaries included |
| Working copy | **76 files, 0 `node_modules` keys, 0 `dist`/`.git` keys** |
| Binary byte-identity | **11/11 sha256-identical**, pinned template → mount → VFS → watcher → working copy (`havok.wasm` 2,094,566 bytes, magic `0061736d`) |

Three mutation checks confirm the new tests catch the live defects rather than merely describing them:
swallowing Ctrl-C fails 6, restoring the `update_directory` mapping fails 13, dropping the exclusion
filter fails 7.

## Still owed

- **Bake `node_modules/.vite/deps` into the warm restore.** The 17.1 s fresh-pod first paint is almost
  entirely Vite dep optimization; the snapshot cache restores packages but not the optimized deps.
- **A build turn against a live model, and publish → `/play`.** The creation path is now driven end to
  end; the generation path is not. `type="file"` artifact writes go through `recordAgentWrite` and the
  same watcher that defect 2 broke, so it is the next thing to check, not an assumed pass.
- **Vendoring beyond the exact npm pin.** The dependency is exact-pinned and the assets are copied with
  a byte-identity drift guard, but no in-tree copy exists yet.
- A memory-ceiling check. Nodepod documents a soft budget and exposes `memoryStats()`; our projects
  carry an 8 MB binary payload plus a 12.2 MB Toolkit bundle, so the ceiling matters and is unmeasured.
