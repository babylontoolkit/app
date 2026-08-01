# BrowserPod — third `SandboxProvider` evaluation (SPEC §8, §8c)

> **Status: TWO SPIKES RUN 2026-07-31. NOT BUILT. Verdict: the ECONOMIC case is proven and the
> original blocker is SOLVED; a NARROWER blocker replaced it.** Everything below was measured live in
> Chrome against the real `rt.browserpod.io` runtime with the owner's real API key and the **real
> pinned AppTemplate snapshot** (`62a34a9b…`, 66 files, 8.8 MB). Harness:
> `scratchpad/browserpod-spike/` + `scratchpad/img/` (throwaway).
>
> Read `SPEC.md` §8c first for why BrowserPod and why not Nodebox/WebContainers.

## Why this exists — and what BrowserPod is actually being asked to do

StackBlitz quoted **~$10,000 per 8,000 API calls** for WebContainers (2026-07-31, §6/A.2), which ends
WebContainer as a served runtime. CodeSandbox stays as the server-side provider (it works, and its
accounting is settled).

**The requirement is not "a cheaper sandbox" — it is the ABSENCE OF A CLOCK (owner, 2026-07-31).**
A cloud VM bills wall-time, so a user who opens a project and walks away for an hour costs real money
for nothing, and the only defence is hibernate/reap machinery (§8c T4/T5) that must then be built,
tuned, and trusted. A browser-side runtime has no such clock: an idle tab costs **$0**, and the
walk-away problem does not need solving because it does not exist. That — not the $0.149/hr — is why
WebContainer was preferred, and it is the property BrowserPod has to reproduce. The margin gain
(CREDITS.md prices a Nano VM-hour at **+50% on raw cost**, taking effective GM from ~72–75% to
**~58–63%**) is the second reason, not the first.

BrowserPod is **$0.01/pod-hour** with a **self-serve $20/mo commercial licence**.

---

## Results at a glance

| # | Test | Verdict |
|---|---|---|
| 1 | **OSC shell contract** — can `shell.ts` be reused unmodified? | ✅ **PASS** (with a caveat that changes the design) |
| 2 | Real starter `npm install` **in-pod** | 🔴 **FAIL** — stalls indefinitely |
| **2c** | **`userImage` — ship the starter as a pre-baked ext2 disk** | ✅ **PASS, decisively — this retires test 2** |
| 2b | Vite 8 / rolldown native binding | ✅ **PASS** — and it disproves the going-in assumption |
| **5** | **The real starter's dev server serves the app** | 🔴 **FAIL — the new blocker.** `optimizeDeps` deadlocks |
| 3 | **Portal latency** | ⚠️ **CONCERNING** — ~165 ms/request, ~2 MB/s |
| 4 | Havok in the preview | ❓ **INCONCLUSIVE** — harness bug, not a BrowserPod result |
| 6 | First paint of the real Babylon app | ❓ **STILL UNMEASURED** — now blocked behind #5, not #2 |

Measured platform: `linux-wasm32`, Node `v22.15.0`, `nproc` = **1**, `/home` = 2 GB.

**The one-line answer to "can BrowserPod stand in for WebContainers?"** — On economics and runtime
shape, yes: it boots a full pre-built Node project in ~1.2 s at zero marginal compute with no
hibernate problem to solve. On *running our actual starter*, not yet: Vite's dependency optimizer
deadlocks under its Wasm Node, and until that is worked around no Babylon app has been rendered
through it.

---

## 1. ✅ The OSC shell contract is satisfiable — `shell.ts` needs no changes

The go/no-go. `app/utils/shell.ts` hardcodes the `\x1b]654;` dialect and `executeCommand` waits for
`\x1b]654;exit=…\x07`; a shell that cannot emit it hangs every agent action silently, forever.

**It works.** Writing the *byte-identical* `OSC_BASHRC` block from `codesandbox-provider.ts` to
`/home/user/.bp_rc` and launching `bash --rcfile /home/user/.bp_rc -i` produced, via xterm's
`parser.registerOscHandler(654, …)`:

```
bash start        → exit=0:0 , prompt          ← a prompt draw with NO command
echo …            → begin , exit=0:0 , prompt
false             → begin , exit=0:1 , prompt  ← REAL exit code
```

That is exactly the shape `app/lib/sandbox/types.ts` documents, including the reason `beginOsc` is
**required**: bash's `PROMPT_COMMAND` fires on prompt draws that follow no command, and without a
`begin` marker `executeCommand` would match the previous command's exit. Real exit codes propagate.

### 🔴 But the headless terminal API is broken, and that changes the provider design

**`createCustomTerminal` cannot run processes.** Measured across **five** independent trials
(2.18.0 and 2.15.0, with/without `cols`/`rows`, with/without `echo`, default-terminal-created-first
or not, `bash -c` and `/bin/echo`):

- `createCustomTerminal` resolves in 1–2 ms and `onOutput` *does* fire for `echo: true` writes
  (`Uint8Array`), so the terminal is live —
- but **any process attached to it never starts and never resolves**, and
- **it then poisons the pod**: a `createDefaultTerminal` that worked seconds earlier in the same pod
  subsequently times out, and so does every `fs` call.

`createDefaultTerminal` (xterm-backed) works: `/bin/echo` in **472 ms**. Leaning's own Apache-2.0 IDE
uses `createCustomTerminal` only for fire-and-forget `rm`/`mv` whose result it never checks
(their comment: *"exposes no exit code… its view can lag the process world"*), so this may be broken
for them too and invisible.

**Design consequence:** a BrowserPod provider must attach a **real xterm instance on a hidden,
permanently-mounted DOM element** for every shell, including the agent's `BoltShell`. That is not
merely a workaround — `xterm.parser.registerOscHandler(654, …)` is a *cleaner* consumer of our
protocol than byte-scraping, and it is how the spike proved the contract. But it means:

- the provider owns DOM, which no other `SandboxProvider` does;
- output must be captured by patching `xterm.write` (the offscreen div's `innerText` is **empty** —
  xterm renders to canvas/WebGL, not DOM text — this cost the spike two wasted cycles);
- `SandboxProcess.output` is reconstructed, not native.

⚠️ Also: `pod.run()` is **synchronous**, returning a `Process` whose `then(e,t)` **does not return the
inner promise** — so `await` works but **`.catch` does not exist**. Wrap in `Promise.resolve()`.
And `createCustomTerminal`/`createDefaultTerminal` are **async** despite the docs showing them sync.

## 2. 🔴 The real starter does not install

| Install | Result |
|---|---|
| `is-odd` (2 pkgs) | **1.6 s** — real registry, `GET 200 https://registry.npmjs.org/…` 125–223 ms |
| `vite@^8.0.10` (20 pkgs) | **43.4 s** ✅ |
| **AppTemplate, with committed lockfile** | **0 packages after ~30 min** 🔴 |
| **AppTemplate, lockfile removed** | 161 dirs / **0 MB unpacked** after ~12 min, then flat 🔴 |

npm and the network are healthy — this is the **dependency tree**. The starter pulls the whole
`@babylonjs/*` set (core, gui, loaders, materials, serializers, inspector, addons, havok) **plus the
AWS SDK devDependencies**, on **1 core** of Wasm Node. Both variants stall.

**The lockfile makes it strictly worse** (0 vs 161), consistent with it pinning
`@rolldown/binding-linux-x64-gnu`-class artifacts that do not exist for `linux-wasm32` — but removing
it does not rescue the install, so the lockfile is an aggravator, not the cause.

**This is not fatal, and spike 2 proved it — see §2c.** The production shape would never run this
install on a user's machine.

⚠️ Even with a baked image, `npm install <pkg>` is a **shell-allow-list primitive** the agent uses
(SPEC §4.2/§5). Adding one package to an existing tree is small and probably fine; that was not tested.

### 2b. ✅ Vite 8 / rolldown works — the going-in assumption was WRONG

The research going in (and SPEC §8c as first drafted) said BrowserPod carries "the identical
native-binary tax as WebContainers", requiring
`"overrides": { "esbuild": "npm:esbuild-wasm@*", "rollup": "npm:@rollup/wasm-node@*" }`, and that
**Vite 8 / rolldown was "likely a blocker"** because rolldown is a Rust native binary.

**Measured: no overrides needed.** On `linux-wasm32` npm resolves
**`@rolldown/binding-wasm32-wasi`** automatically, and:

```
vite/8.2.0 linux-wasm32 node-v22.15.0
VITE v8.2.0  ready in 1549 ms
```

Dev server up and a portal minted in **4.0 s**. Leaning's own templates still carry the esbuild/rollup
overrides, which is presumably why the assumption was in circulation — for **Vite 8 they are
unnecessary**. Correct §8c accordingly.

## 2c. ✅ `userImage` works, and it is a BETTER way to deliver the starter than mounting files

This is the finding that changes the economics, and it retires test 2 entirely.

### What the runtime actually does

Read out of the minified 2.18.0 bundle (`BrowserPod.boot` → `init`), because none of this is
documented:

- `/home` is **its own ext2 device**, built as `createOverlayDevice(base, opfsOverlay)` where `base`
  defaults to `wss://disks.browserpod.io/disks/user.ext2` (2,097,152,000 B) and the overlay is an
  OPFS device sized to the base. `rootImage` does the same for `/`.
- `boot({ userImage })` accepts **any `http(s)`/`ws(s)` URL** (validated by a private `#i`; anything
  else throws `must use http(s) or ws(s) protocol`) and routes `http(s)` to **`createHttpDevice`**.
- 🔴 **`createHttpDevice` is a LAZY, RANGE-BACKED BLOCK DEVICE.** It probes with
  `Range: bytes=0-0` and thereafter range-reads only the blocks actually touched. **This is the whole
  ballgame:** the image can be enormous and still cost nothing to boot, and it can be served from
  **our own S3/CloudFront** — no vendor hosting, no Enterprise plan, no `disks.browserpod.io`.
  (This is the same mechanism Leaning's WebVM uses to boot a multi-GB Debian in a tab.)

### Measured, end to end

Built on the host: `npm install --os=linux --cpu=wasm32 --ignore-scripts` (**304 packages, 34 s**),
staged at `root/user/workspace`, then `mke2fs -t ext2 -b 4096 -N 250000 -d root user.ext2 1400M`
(**14 s**). Served from the local harness with Range support.

| Step | Measured |
|---|---|
| Install for the pod's platform, on the host | **34 s** (vs *never finishes* in-pod) |
| Build the 1.4 GB ext2 | **14 s** |
| `boot({ userImage })` | **1.13–1.28 s** · **3 range requests · 0.25 MB** |
| Verify the tree over bash (`ls`, symlinks, node) | cumulative **26 reqs · 3.13 MB** |
| **Vite dev server up + portal minted** | **7.0 s from page load** (`ready in 2160 ms`) |
| Total image bytes pulled for all of the above | **~170–190 reqs · ~21–23 MB of 1,468 MB (1.5 %)** |

The tree is byte-correct inside the pod: `node_modules` present, **`@rolldown/binding-wasm32-wasi`**
resolved (no host-native packages, zero `.node` binaries anywhere in 81,494 files), and
**symlinks survive** `mke2fs -d` (`node_modules/.bin/vite -> ../vite/bin/vite.js`, mode `120755`).

### Why this is the right architecture, not merely a workaround

It is the **direct analogue of the CodeSandbox fork-from-alias template** (`spec/sandbox-codesandbox.md`)
that reaches 7.6 s to playable, and it slots into the **§4.4 pin-and-promote** model without inventing
anything: an image is an immutable artifact addressed by the template's commit SHA, promoted by an
admin, rolled back onto bytes that still validate. It also **removes** the per-file mount entirely —
no 66 `createFile` round-trips, no `waitForMountVisible`, no `settleAfterCreation` for the starter,
because the files are *already there* before the first line of our code runs.

⚠️ **Build it on Linux in CI, not on a Mac.** The host install above is only correct because npm's
`--os`/`--cpu` overrides pick the right optional dependencies; anything with a real `postinstall`
was skipped by `--ignore-scripts` and was not exercised. And see §5 — the image must be built at the
**same absolute path** the pod will mount it at.

## 5. 🔴 THE NEW BLOCKER — Vite's dependency optimizer deadlocks, so the real starter never serves

Reproduced on **three separate fresh pods**. The dev server starts, prints `ready in ~2.1 s`, mints a
portal — and then never answers.

| Config | `/src/main.tsx` |
|---|---|
| No plugins, `optimizeDeps: { noDiscovery: true, include: [] }` | ✅ **170 ms** / **304 ms** (fresh pod) |
| Same + `optimizeDeps.include: ['scheduler','use-sync-external-store/shim']` | 🔴 **hang** (aborted at 90 s; still hanging 7 min later) |
| **The real `vite.config.ts`** | 🔴 **hang** (still hanging 12 min later) |

Evidence it is a **deadlock, not slowness**:

- The pod stays fully responsive throughout — an unrelated `bash -c` returns in **0.5–0.6 s**, so
  nothing is CPU-starved. `ps` shows the vite `node` process alive.
- `node_modules/.vite` is **never created**. The optimizer produces nothing at all; it blocks at the
  start rather than grinding.
- With no cache present, vite serves `index.html` fine (200) and only the *module* requests hang.
  With a cache present it wipes it and then blocks **before even `index.html`** — consistent with the
  optimizer running eagerly at startup instead of lazily on first import scan.

**Not the obvious culprit:** `worker_threads` **works** — a probe spawned a worker and got
`MSG: WORKER_OK` back. So this is not a missing-primitive gap in BrowserPod's Wasm Node.

### 🔴 THE ACTUAL ROOT CAUSE (2026-07-31, spike 4): `Atomics.wait` never returns in BrowserPod

Spike 3 blamed rolldown. **That was one layer too shallow.** The owner asked the right follow-up —
*"is Vite the only framework… can you try something else"* — and testing alternatives found the real
defect, which is far more fundamental and far more actionable.

**`Atomics.wait()` on the main thread never returns, and never times out**, and the worker that
should wake it never runs. A ~20-line probe, no bundler involved:

```
MAIN spawning worker
MAIN entering Atomics.wait      ← 15,000 ms timeout set; never fired, observed far past it
```

Two separate faults: the worker cannot be scheduled while the main thread blocks (`nproc` = 1), **and
the `Atomics.wait` timeout does not fire at all**, which is a spec violation on its own. A plain
`postMessage` worker round-trip **does** work — so `worker_threads` is fine; it is specifically
*blocking* on `Atomics.wait` that deadlocks.

**That single defect explains every hang in this document**, because synchronous cross-thread calls
via `Atomics.wait` are exactly how both wasm bundlers work:

| Setup | `/src/main.tsx` |
|---|---|
| **Vite 8** (rolldown wasm), stock `npm create vite --template react-ts` | 🔴 hangs (224 s) |
| Same, everything but **React** excluded from the optimizer | 🔴 hangs (357 s) |
| **Vite 7.3.6** + the documented `esbuild-wasm` / `@rollup/wasm-node` overrides | 🔴 hangs (232 s) |
| Any of the above with the optimizer **disabled** | ✅ **170–631 ms** |

So **it is not rolldown, not Vite 8, and not our template** — switching bundler or downgrading Vite
does not help, because both wasm bundlers block the same way. Send-ready report with the minimal
probe: `scratchpad/REPRO-browserpod-vite.md`.

### ✅✅ THE WHOLE STACK RUNS IN A POD — Babylon + **Toolkit** + Havok, from a pre-built bundle (spike 5)

The owner pushed back on the "blocked" verdict — *"are you saying vite and a bundler is the only way…
can we use webpack… UMD and script tags"* — and was right to. **"You need a bundler" was the wrong
statement; what you need is bundled OUTPUT, and that can be produced anywhere.** Bundling with
webpack on the host and serving the result statically from the pod:

| Stage | In-pod |
|---|---|
| **BabylonJS rendering** | ✅ **2,492 ms** |
| **Babylon Toolkit** | ✅ **116 exports, 6,420 ms** |
| **Havok physics** (2,094,566-byte wasm) | ✅ **initialised, 7,142 ms** |
| boot → portal → everything done | **0.9 s → 1.9 s → 9.5 s** |

That is the complete product stack, live in a browser-hosted pod, at zero marginal compute. **This is
the architecture that works today** and it is the same shape as everything else here: do the
expensive, tool-dependent work where the tools work (our CI), ship the result in the `userImage`, let
the pod serve it.

### 🔴 …but the EDIT LOOP is not solved, and it is a SECOND vendor gap

**webpack is pure JavaScript** — no wasm, no native binaries (verified: zero `.node` files, zero
`.wasm` in the toolchain) — so it sidesteps the `Atomics.wait` defect entirely and genuinely **runs**
in the pod. Two problems stop it being the answer on its own:

1. **A cold build takes >11.5 minutes and did not complete** on one Wasm core (host: **3.6 s**).
2. 🔴 **webpack's persistent cache — the fix for (1) — crashes on an incomplete `node:v8`:**
   `DefaultSerializer._setTreatArrayBufferViewsAsHostObjects is not a function`
   (`node:v8:152` ← `webpack/lib/serialization/BinaryMiddleware.js`). A warm host rebuild is **1.9 s
   over 3,510 cached modules**, so this single missing method is the difference between a usable
   in-pod edit loop and none.

**That is a much smaller ask than the `Atomics` fix** — one v8 shim method — and it is worth putting
in front of Leaning as the *cheap* one. `scripts/` note: both are in `scratchpad/REPRO-browserpod-vite.md`.

### Also: Babylon + Havok run with NO bundler at all

The other half of the owner's question, and the first time any of this has been seen working in-pod.
A plain static server (Node, no deps) + browser ES modules + an import map, in a fresh pod:

- ✅ **BabylonJS rendering** — WebGL2 on a real GPU, first frame at **6,033 ms**
- ✅ **Havok initialised** — 2,094,566 bytes, at **7,703 ms**
- boot **1.1 s**, portal **2.1 s**, iframe loaded **2.4 s**, ~25 MB of a 1.5 GB image pulled

**HOST CONTROLS both pass** (same wasm32 trees, on macOS): the Vite 8 app renders Babylon with
Toolkit **138 exports** and Havok init; the Vite 7 app does the same in **1,012 ms**. So the apps are
correct and the pod runs the workload — only the bundler step is broken.

⚠️ **The Toolkit specifically did NOT load unbundled**, and that is a genuine limitation rather than
a harness bug: `@babylonjs-toolkit/next` re-exports through `@babylonjs/core`'s barrel, so importing
it pulls **the whole of Babylon as thousands of individual modules** over a ~165 ms-per-request relay.
Every individual specifier resolves (verified: all 84 re-export targets return 200 once the import
map carries both bare and prefix forms) — the graph is simply too large to serve unbundled. **This is
precisely why a bundler is non-negotiable here**, and therefore why the `Atomics.wait` defect blocks
the product rather than merely inconveniencing it.

### Superseded: spike 3's reading of the same evidence (kept — it is how the cause was narrowed)

The owner's call — *"all that vite config was setup for lazy loading… can you test a default vite app
with the core install deps"* — was the right experiment and it settled it in two runs.

**A stock `npm create vite@latest -- --template react-ts`**, default config (`plugins: [react()]`,
nothing else), with only `@babylonjs/{core,gui,loaders,materials,inspector,serializers,havok,addons}`
+ `@babylonjs-toolkit/next` installed (pinned 9.16.0 to match the template):

| Run | Result |
|---|---|
| Stock app, **default config** | 🔴 `index.html` **pending at 224 s** — hangs exactly like our template |
| Stock app, **Babylon `optimizeDeps.exclude`d** (so the optimizer only has React to do) | 🔴 **hangs at 357 s**, vite logs `[optimizer] bundling dependencies...` and never another word |
| **HOST CONTROL** — same app, same wasm32 tree, on macOS | ✅ Babylon renders, **Toolkit 138 exports, Havok initialised (2,094,566 bytes)**, optimizer done in seconds |

**The proof is on disk:** after 357 s the pod contains `node_modules/.vite/deps_temp_c3531ba1` — the
optimizer's **temp directory, created and never committed** — with no `deps/` beside it. The pod stays
responsive (`bash` returns in under a second) the entire time.

**So the rule is simple and total: every configuration where vite's optimizer ACTUALLY RUNS hangs;
every configuration where it is disabled works** (170 / 304 / 631 ms per module, with or without the
react plugin). Babylon's size is irrelevant — it hangs with React alone. This is a
**rolldown-on-Wasm-Node defect in BrowserPod**, not a property of the AppTemplate, and not something
a config refactor can fix.

**Two consequences that shape any future provider:**

1. The **only** viable shape is a `node_modules/.vite` baked into the image that vite ACCEPTS, so the
   optimizer never runs at all (`loadCachedDepOptimizationMetadata` logs *"Hash is consistent.
   Skipping"* and returns). That requires the image be built on Linux at the pod's own absolute path
   — see the hash analysis below.
2. 🔴 **`npm install <pkg>` — a shell-allow-list primitive the agent uses (SPEC §4.2/§5) — would
   change the lockfile, invalidate the cache, and hang the dev server.** Any BrowserPod provider must
   either rebuild the cache out-of-band or refuse that primitive. This is a **product** constraint,
   not a build detail, and it is the strongest argument against BrowserPod as a drop-in replacement.

⚠️ **Not yet observed anywhere: Babylon actually rendering INSIDE a pod.** The host control proves the
app is correct and that Havok works; the pod has never got past the optimizer to run it.

### Bisection on the real template: four plausible causes RULED OUT (superseded by the above, kept for the record)

Each of these was run on a **fresh pod** (see trap 6 — a second trial in the same pod is worthless):

| Suspect | Result |
|---|---|
| `@vitejs/plugin-react` (babel) | ✅ **NOT the cause.** Minimal config + `react()` served `/src/main.tsx` **200 in 631 ms**, with correct CJS interop (`__vite__cjsImport0_reactDom_client`) resolving through the baked cache. |
| `server.warmup.clientFiles` (crawls `src/babylon/**`) | ✅ **NOT the cause.** Disabled; the real config still hung (231 s). |
| `optimizeDeps` **discovery** re-triggering the optimizer | ✅ **NOT the cause.** `noDiscovery: true` added to the real config; still hung (222 s). |
| Cache invalidation | ✅ **Addressed, and it helped but did not fix.** With vite patched to accept the cache, `index.html` went from *pending* to **200** — real progress — and the run read **33.5 MB** of the image versus 21 MB before, i.e. it got materially further. Modules still never arrived. |

🔴 **So the honest state is: the real starter's config does not serve on BrowserPod, and we do not
know exactly why.** A bare vite does (170–631 ms/module, with or without the react plugin). Something
in the remaining delta — the four custom middleware plugins, `resolve.dedupe`, `optimizeDeps.exclude`
of the whole `@babylonjs/*` set (which makes vite serve ~10 MB of Babylon as thousands of raw source
modules), `server.fs.allow`, `hmr`, `headers` — is responsible, alone or in combination.

⚠️ **And the behaviour is not deterministic.** The same real config produced a **200** for
`index.html` on one run and a **pending** on the next. Do not treat any single observation here as
settled; every claim above rests on a fresh pod, and the ones that varied are called out as varying.

⚠️ **One signal was over-read during this spike and should not be trusted again: "image range
requests stopped" is NOT proof of a stall.** The OPFS overlay is keyed `${storagePrefix}-user` and
persists across page loads at the default empty `storageKey`, so blocks read in an earlier run are
already local and generate no new HTTP traffic. Judge liveness from the pod (`bash` round-trip) and
from pending requests, never from the image byte counter.

### The pre-baked dep cache is the obvious fix, and it did not work *as tested*

`node_modules/.vite/deps/*.js` are **portable browser bundles**, so baking them into the image should
let vite skip optimizing. Generating them was easy — vite runs on macOS against the wasm32 tree using
the same `@rolldown/binding-wasm32-wasi` (`ExperimentalWarning: WASI`), producing exactly the CJS
pre-bundles the starter needs (`scheduler`, `use-sync-external-store_shim`, react, react-dom,
react-router-dom). Baked into the image and booted: **vite deleted the whole `deps` directory** and
re-optimized (→ deadlock).

That is vite invalidating the cache on a hash mismatch — **mechanism now confirmed exactly, by
reading vite's own source.** `loadCachedDepOptimizationMetadata` accepts a cache iff **both**
`lockfileHash` and `configHash` match, and `getConfigHash` hashes
`{ define, root, resolve, assetsInclude, plugins:names, optimizeDeps, optimizeDepsPluginNames }` —
**`root` is the absolute path**, and `resolve` carries absolute paths too. Measured both sides:
host `configHash = 1648889b`, pod `configHash = 4c4da52e` (obtained by patching vite in the image to
log what it computes). The lockfile hash matches, as expected.

So **the fix is to generate the cache on Linux at the identical absolute path** (`/home/user/workspace`)
— a CI detail, not a research problem. ⚠️ **It is necessary but NOT sufficient:** patching vite to
accept the mismatched cache outright still did not get the app to render (see the bisection above),
so path-matching alone will not deliver a working preview.

⚠️ **An attempt to re-key the cache arithmetically was ABANDONED, and its control is why.**
`scratchpad/img/rehash.mjs` transcribes `getConfigHash` verbatim and re-hashes with host paths
rewritten to pod paths. It **asserts first that it can reproduce vite's real hash**, and it could not
(`56cf902c` vs `1648889b`) — so it refuses to write. Without that control it would have silently
mis-keyed the cache and produced a confident wrong result. Keep the control if anyone revives this.

⚠️ **We cannot simply ship with the optimizer off.** `optimizeDeps.include` is in the starter because
`scheduler` and `use-sync-external-store/shim` are **CommonJS** and will not load in a browser
un-prebundled. Turning it off is not a configuration preference; it breaks React.

## 3. ⚠️ Portal latency — the risk that remains

There is **no service worker**: every preview request goes browser → Cloudflare Worker → WebSocket →
back into the same browser.

| Request | Measured |
|---|---|
| small module (5 KB), 9 samples | min **164 ms**, median **167 ms**, max 346 ms |
| `index.html` (cold) | 443 ms |
| `havok.wasm` (2,094,566 B) | **1,044 ms** then 884 ms → **~1.9–2.3 MB/s** |

~165 ms is a floor per request, and it is *remarkably* consistent. The danger is **unbundled Vite dev
with Babylon**: `optimizeDeps` pre-bundles `@babylonjs/*` into few chunks, but app source is served
per-module. At 165 ms each, even 6-way parallel, a few hundred modules is tens of seconds to first
paint — against ~0 ms on WebContainer's service-worker preview.

**Not yet measured, and it is the number that decides this:** first paint of the *real* Babylon
starter through a portal. That needs test 2 solved (baked image) first.

## 4. ❓ Havok in the preview — inconclusive, and one vendor claim contradicted

- ⚠️ **Isolation: the spike-1 finding was WRONG, and spike 2 corrects it.** Spike 1 measured
  `crossOriginIsolated: false` inside a portal page and concluded previews are never isolated. They
  are — **the dev server has to ask.** Spike 1 ran a *bare* vite with no config, so no COOP/COEP was
  sent. With the real starter's config (which sets `COOP: same-origin` + `COEP: credentialless`), the
  portal document came back with:

  ```
  cross-origin-opener-policy:   same-origin
  cross-origin-embedder-policy: require-corp     ← note: Cloudflare UPGRADED credentialless
  cross-origin-resource-policy: cross-origin
  ```

  So the relay does inject/normalise these, but only over headers the origin already sets. Two
  consequences: previews **can** be cross-origin isolated, and 🔴 **Cloudflare rewriting
  `credentialless` → `require-corp` is stricter than what the starter asked for**, which is exactly
  the mode in which a cross-origin subresource without CORP gets blocked — see the
  `repo.babylontoolkit.com` question below. ⚠️ Measured at the **response-header** level only;
  `crossOriginIsolated` was not re-read inside the document under the real config.
- ✅ **Real GPU in the preview:** `WebGL2 true`, `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Ultra)`,
  `navigator.gpu.requestAdapter()` resolved. Babylon rendering is a non-issue.
- ❓ **Havok init failed with `LinkError … _emval_call_method … requires a callable`** — an Emscripten
  glue/wasm version mismatch caused by the probe loading `HavokPhysics_es.js` from the CDN without
  supplying a matching `wasmBinary`. **That is a harness bug, not a BrowserPod result.** Do not cite
  it. Re-test by loading the project's own pinned `@babylonjs/havok` + local `havok.wasm`.
- `repo.babylontoolkit.com` returned **403** for the probed path (wrong path) — the CORP question
  under `require-corp` is therefore **still unanswered**, and moot while previews are un-isolated.

---

## Operational traps found (each cost real time)

1. 🔴 **Never wipe OPFS while a pod is live.** Deleting `cheerpos-tmp` wedges the runtime: every
   `fs` call then hangs with no error. The origin's OPFS is shared, so **concurrent pods on one
   origin wedge each other** — the spike's first "66 files hang" was entirely this.
2. 🔴 **A hung process wedges the whole pod**, not just its terminal — `fs` and new terminals hang too.
   There is **no `teardown`**: `shutdown?.()` is absent from the runtime. Recovery is a page reload.
3. **Offscreen xterm has empty `innerText`** — it renders to canvas. Patch `xterm.write` to capture.
4. `registerOscHandler` is on **`xterm.parser`**, not on the Terminal.
5. `run` resolves the binary via `PATH` from `opts.env`, defaulting to `/bin:/usr/bin` — **no
   `node_modules/.bin`**. Default `cwd` is `/home/user`; a **non-existent `cwd` hangs** rather than erroring.
6. 🔴 **A wedged process can poison LATER servers in the same pod, non-deterministically.** On one pod
   a healthy vite kept serving at 170 ms alongside a deadlocked one; on another, a fresh minimal vite
   that works on a clean pod (**304 ms**) hung. **Every trial after the first in a pod is suspect** —
   this invalidated two of this spike's own bisection runs, and both were re-run on fresh pods before
   anything was concluded. Budget one pod per measurement.
7. 🔴 **Backgrounding the host tab kills the portal.** Opening the preview URL as its own top-level
   tab (which backgrounds the pod's tab) left the relay permanently dead: subsequent `fetch` calls to
   the portal hung forever even after refocusing, while the pod itself stayed responsive. **The pod's
   network relay is only as alive as its host tab.** Harmless for our shape (the preview is an iframe
   in the same tab) but it means any "open preview in a new window" affordance needs verifying, and
   it is a real difference from a server-side VM.
8. **`node -v` / `node -p` do not work.** `handleExecve` treats the first argument after `node` as a
   module path (`Cannot find module '-v'`). Run scripts by path, and prefer `npx <bin>` — `node
   node_modules/vite/bin/vite.js` hung where `npx vite` started cleanly in 3 s.
9. **Piping node's stdout through bash loses it** (`node x.mjs 2>&1 | tail` printed nothing but the
   exit code; unpiped, the same script printed fine). Do not build the provider's output capture on
   shell redirection.

## What would have to be true to proceed

1. ✅ **DONE — the cause is known** (rolldown's optimizer never completes; §"ROOT CAUSE CONFIRMED").
   What remains is a choice between two paths, and they are not equal:
   a. **Report it to Leaning Technologies** (and probably rolldown). This is their bug, it is
      reproducible in ~5 minutes with a stock Vite app, and it blocks every modern Vite project on
      their platform — not just ours. Cheapest action with the highest leverage; do this regardless
      of which path we take.
   b. **Engineer around it: never let the optimizer run.** Build the image in Linux CI at
      `/home/user/workspace` so the baked `node_modules/.vite` hashes match and vite skips
      optimization entirely. ⚠️ This is a **containment strategy, not a fix** — it holds only while
      nothing invalidates the cache, and `npm install <pkg>` (an agent primitive, SPEC §4.2/§5) does
      exactly that. Costing that constraint honestly is part of the decision.
2. **First paint of the real Babylon starter through a portal**, then the ~165 ms/request relay cost
   judged against it. Still the number that decides whether this is *pleasant*, as opposed to
   *possible*.
3. A re-run of the Havok probe with the project's own pinned build, and the
   `repo.babylontoolkit.com` CORP question — now sharper, since Cloudflare upgrades the preview to
   `require-corp` (§4).
4. Then, and only then, the §8c seam work: `browserpod-provider.ts` + `browserpod-translate.ts` +
   `browserpod-boot.ts`, `SandboxProviderId` widened, `SANDBOX_OUTLIVES_SESSION` /
   `SANDBOX_REQUIRES_PROJECT` / `WORK_DIR` (= `/home/user/workspace`) answered explicitly, and a
   `MAY_IMPORT_BROWSERPOD_SDK` file-list **plus a CONTROL test** in `sandbox-seam.spec.ts`.
   Plus an image build+promote pipeline, which §4.4 pin-and-promote already gives the shape for.

**Recommendation: do not start the provider, and do not yet count on BrowserPod as the WebContainer
replacement.**

Split the verdict, because the two halves point opposite ways:

- ✅ **The runtime is good enough.** Everything the *platform* needs — boot fast, hold a real
  filesystem, run real bash speaking our exact OSC protocol with real exit codes, expose a port,
  cost $0 while idle — works, at **1.2 s and 0.25 MB** to boot a fully pre-built project and **7 s**
  to a live dev server. The `userImage` mechanism is genuinely better than what we do on CodeSandbox.
  Nothing here suggests a browser cannot host this product.
- ✅ **And our workload runs on it.** Babylon renders and Havok initialises **inside a pod** (6.0 s
  and 7.7 s, no bundler). This is no longer a question mark.
- 🔴 **But no bundler works, because `Atomics.wait` never returns.** Not rolldown specifically —
  Vite 7 + `esbuild-wasm` deadlocks identically, and a 20-line probe with no bundler at all
  reproduces it. Every Vite dependency optimizer hangs; disable the optimizer and everything serves
  in 170–631 ms. A `browserpod-provider.ts` written today would boot beautifully and show a blank
  preview.

**Two vendor gaps, both small and precisely located** — the best possible shape for a blocker:
`Atomics.wait` (kills every wasm bundler → all of Vite) and a missing `node:v8` serializer method
(kills webpack's persistent cache → no fast in-pod rebuilds). Each breaks a whole ecosystem on their
platform, not just us; each has a short repro. They have every reason to fix them, and the v8 one
looks like a one-method shim.

**What we could ship TODAY if we wanted to:** build in CI → bake `dist/` into the `userImage` → pod
serves it statically. Proven end to end. What that does *not* give us is the agent edit loop, since
nothing in the pod can rebuild in reasonable time — so it would mean rebuilding on our servers per
edit, which claws back some of the compute saving that made BrowserPod attractive.

**Recommendation: send the report, keep CodeSandbox, revisit when either gap closes.** The `node:v8`
fix alone would make BrowserPod viable (pre-baked webpack cache + incremental rebuilds); the
`Atomics` fix would additionally give us Vite back and let the template stay as it is.

Nothing is urgent: CodeSandbox continues to serve exactly as it does today. This only becomes
load-bearing when the idle-VM bill, or the hibernate machinery an always-billing VM forces us to
build (§8c T4/T5), starts to hurt.
