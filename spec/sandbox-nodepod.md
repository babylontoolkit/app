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
2. **🔴 The preview is same-origin at `/__virtual__/<pod>/<port>`, and the app client-side-routes to
   `/` — which on that origin is the BUILDER page, not the game.** Observed live: an iframe reload
   loaded the harness page instead of the app and looked exactly like a hang. This is the same class as
   the T17b `/play/:shareId` base-path defect. Resolve with a dedicated preview origin or a
   subpath-scoped SW; do not leave it to chance.
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

## Still owed

- **Bake `node_modules/.vite/deps` into the warm restore.** The 17.1 s fresh-pod first paint is almost
  entirely Vite dep optimization; the snapshot cache restores packages but not the optimized deps.
- Everything in Phase 1 of the plan: the provider, the seam wiring, the preview-origin fix, and the
  default-deny import scan.
- A memory-ceiling check. Nodepod documents a soft budget and exposes `memoryStats()`; our projects
  carry an 8 MB binary payload plus a 12.2 MB Toolkit bundle, so the ceiling matters and is unmeasured.
