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

## First-class parity pass (2026-07-31)

Four gaps found by AUDIT rather than by a failure — the runtime was never the limit in any of them,
the adapter was. Owner: *"Nodepod is supposed to be a FIRST CLASS DROP IN REPLACEMENT."*

### 1. The terminal was an argv splitter, not a shell

`createShellProcess` ran `command.split(/\s+/)` and passed the words to `client.spawn(cmd, args)`.
**Nodepod ships a complete shell interpreter** — tokenizer, parser, pipelines, `&&`/`||`/`;`,
`>`/`>>`/`<`/`2>&1`, glob and `$VAR` expansion, command substitution, aliases, and builtins
(`ls cat grep find sed head tail sort uniq wc which xargs cd echo touch` plus
`npm`/`pnpm`/`yarn`/`bun`/`node`/`git`) — and its `spawn` reaches that interpreter by joining `cmd`
and `args` into one line, **shell-quoting each argument first**. Only when `args` is empty is `cmd`
passed through verbatim.

So the words we handed over came back as quoted literals: `npm install && npm run dev` became six
of them, `echo "hello world"` became two. **The interpreter was there the whole time and we were
escaping the request out of it.** Passing the line with no args is the documented path in; the fix is
two lines and the adapter now has no parser of its own.

The worker is also PERSISTENT now (`processManager.spawn({ command: 'shell' })` +
`exec({ persistent: true })`, which is what `Nodepod.createTerminal` itself does), so `cd` survives
between commands and no one pays a ~1 s worker boot to run `ls`. Without a process manager it
degrades to one-shot spawns — still a full shell per command, just slower and with no `cd` memory.

⚠️ **An IDLE Ctrl-C must not kill that worker.** `BoltShell.executeCommand` writes `\x03` before
*every* command; killing on each one would respawn a worker per command and throw away the `cd`,
silently converting the persistent shell back into the one-shot one.

### 2. The terminal did not echo, so a human typed blind

`jsh` and a real PTY echo keystrokes, redraw on backspace and print a prompt, because that is the
terminal's job and not the shell's. Nodepod has neither, and the adapter owned only the *parsing*
half: keystrokes went in, nothing came back, and output appeared only once Enter was pressed.
Nothing threw — it just looked broken, which is exactly how it was reported.

`createLineEditor` (pure, in `nodepod-translate.ts`) is now a real line editor: echo, backspace,
insert at the cursor, ←/→, Delete, Home/End, Ctrl-A/E/U/K/L, bounded ↑/↓ history, and a cwd-aware
prompt. Output is passed through `toTerminalNewlines` because xterm reads `\n` as "down one row"
only, so raw Unix output staircases across the screen (Nodepod's own terminal makes the same
substitution).

**Deliberately not implemented:** cursor movement across a WRAPPED line. The redraw addresses one
screen row; a line longer than the terminal is wide will smear on edit. Appending — the common case —
echoes one character and never redraws, so it is unaffected. Tab completion is also absent (the
vendor exposes `getCompletions`, but only via a deep import the seam scan forbids).

### 3. `textSearch` was declared `false` while the runtime could search

Implemented over the VFS in the adapter, and the capability is now `true`. **Not** shelled out to the
runtime's `grep -r`, for three reasons that each give a wrong answer rather than a slow one: its
`grep` writes ANSI colour unconditionally (no `--color=never`, and the columns are what the panel
positions matches with); its recursive walk honours no excludes, so it would descend `node_modules`
on every debounced keystroke; and a shell round trip returns TEXT, where the seam's contract is
structured ranges. The VFS is in this tab's memory — reading it directly is both simpler and faster.

### 4. "Open in new window" was silently dead

`previews.ts`'s `getPreviewId` was a hardcoded StackBlitz hostname regex, so it returned `null` for
Nodepod and CodeSandbox — and every caller "guarded on null". *Open in new window* did nothing at
all, the cross-tab preview broadcast never fired, and the storage-sync refresh skipped every preview.
None of it threw. **Degrading safely is only a virtue when the thing degraded is optional; a menu
item that no-ops is a defect wearing a guard's clothes.**

`previewIdFromUrl` (in `preview-url.ts`) now answers for any provider — WebContainer's subdomain kept
byte-identical, Nodepod's `/__virtual__/<pod>/<port>` mount, and the origin for everything else — and
`null` is reserved for input that is not a URL. Both `Preview.tsx` call sites open the preview URL
directly; the `/webcontainer/preview/:id` route they went through only ever turned an id back into
the URL they already had, which is what *Open in new tab* has always done.

### 5. The 17.1 s cold first paint

`nodepod-vite-cache.ts` persists `node_modules/.vite` to IndexedDB, keyed by the project's dependency
set, and restores it before the dev server starts. Nodepod's own snapshot cache cannot close this: it
snapshots `node_modules` at the end of `npm install`, and `.vite/deps` does not exist yet at that
moment — and on a warm boot the install is a no-op, so it never re-snapshots either. The optimized
deps were recomputed from scratch on every page load, forever.

Three rules, each of which fails silently:

- **The key is an OPTIMIZATION, not a correctness boundary.** Vite writes `deps/_metadata.json` with
  a hash of its own inputs and re-optimizes when it does not match, so a stale restore costs exactly
  what today costs. That is why the key can be a cheap sync hash of `package.json` (sorted, with
  `dependencies` and `devDependencies` tagged apart) rather than a reproduction of Vite's own — which
  would be a second implementation of a rule we do not own, drifting the first time they change it.
- **Capture waits for the SENTINEL, never for the server.** The dev server is ready long before the
  first request triggers optimization; storing then persists a half-written directory, which Vite
  would trust on the next boot and serve modules that are not there. Restore writes the sentinel
  LAST for the same reason.
- **Restore happens before each command until it fires once**, because there is no single moment at
  boot when both "`node_modules` exists" and "Vite has not started" are true — the install spawn finds
  no `node_modules` and does nothing, the `npm run dev` after it restores. No command sniffing.

It is skipped entirely when the pod already has optimized deps: that pod's own cache is newer than
ours, and overwriting it is the `bootRestoredFilesystem` mistake in miniature.

### 6. …and the wait it leaves behind is narrated, over the PREVIEW PANE only

The dep cache removes the 17.1 s on the *second* load of a dependency set. The first one still pays
it, and creation's splash comes down before it starts — the splash ends when the dev server binds a
port, and Vite optimizes on the first REQUEST after that. So the user watched a blank preview pane
with nothing saying why.

`preview-busy.ts` + `PreviewBusyOverlay` cover **the preview pane and nothing else**. That scoping is
the decision, not an implementation detail: at that moment the file tree, editor, terminal and chat
are all ready and usable, so extending `WorkspaceSplash` over them would be a lie about three panes
in order to explain one — and it would take the workspace away exactly when the user could start
reading their code. It is drawn in the boot panel's visual language (same spinner, same title/detail
shape) because it is the same moment to a user, one pane smaller; a third look for "your project is
coming up" would repeat the mistake `BootScreen` already paid for.

Three timing rules, each failing silently in a different direction, all pure and mutation-verified:

- **An 800 ms delay before it appears.** The measured WARM first paint is 0.5 s, so a zero-delay
  overlay flashes on every ordinary load and every in-preview navigation — the strobing that made the
  import tail unusable as a boot phase. The test asserts the delay stays above the measured number.
- **After 4 s, and only on the session's FIRST load, it explains itself** — "First run: the dev server
  is optimizing dependencies. Later loads are much faster." A spinner says *wait*; it does not say
  *this is one-time*, and a user not told that concludes their project is always this slow. Gated on
  `everLoaded` because a later slow navigation is not paying for optimization, and saying it is would
  be a confident wrong answer.
- **A 120 s ceiling.** The exit must not depend solely on a `load` event that may never fire — a
  preview that has not loaded in two minutes has a problem the user needs to SEE, not a spinner on
  top of it. Same reason `coversWorkspace` refuses to cover the `failed` phase.

⚠️ **Neither §5 nor §6 has been re-driven live.** Both are unit-proven and mutation-verified — for
the cache, writing the sentinel first fails 2 tests and capturing without waiting for it fails 1; for
the overlay, a zero delay fails 2, removing the ceiling fails 1, and dropping the `everLoaded` gate
fails 1 — but the 17.1 s → ? number is owed, and nobody has watched the overlay come up and go down
in a real pane.

## Still owed

- **Re-measure the fresh-pod first paint** with the dep cache in place. The whole point of §5 is a
  number, and the number has not been taken.
- **Drive the new terminal live.** Pipes, `&&`, `cd`, history and echo are pinned by tests against a
  fake process manager; they have not been typed into the real workbench. Same live-fidelity caveat
  the MCP relay carried before testing found three defects in it.
- **A build turn against a live model, and publish → `/play`.** The creation path is driven end to
  end; the generation path is not. `type="file"` artifact writes go through `recordAgentWrite` and the
  same watcher that defect 2 broke, so it is the next thing to check, not an assumed pass.
- **Vendoring beyond the exact npm pin.** The dependency is exact-pinned and the assets are copied with
  a byte-identity drift guard, but no in-tree copy exists yet.
- A memory-ceiling check. Nodepod documents a soft budget and exposes `memoryStats()`; our projects
  carry an 8 MB binary payload plus a 12.2 MB Toolkit bundle, so the ceiling matters and is unmeasured.
- Tab completion in the terminal, and cursor editing on a wrapped line — both named above.
