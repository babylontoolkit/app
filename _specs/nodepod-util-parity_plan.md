# Implementation Plan — nodepod-util-parity

Spec: none (a vendor defect with a measured cause; this file carries the analysis)
Branch: `project/feature/nodepod-util-parity`
Fork: `github.com/MackeyK24/Nodepod`, cloned at `~/Documents/Repos/Nodepod`
spec_impact: **yes** — SPEC §8 / `spec/sandbox-nodepod.md` gain a "we run a fork, and why" note

## STATUS — 2026-08-01

**§0 ANSWERED: Option B — base on 1.9.18 (fork HEAD), and land the repackage FIRST, without the util
changes**, so the runtime upgrade is proven on its own before anything else rides on it.

### ✅ Phase 1 — repackage + upgrade: DONE and live-verified

Fork branch `btk/repackage` @ `9715d9f` — `@babylonjs-toolkit/nodepod@1.9.18-btk.0`. Name, version and
repository URL only; **no functional change**. `-btk.0` is deliberately the pure repackage, leaving
`-btk.1` for the util fix, so the two can be judged separately.

Checked first: **nothing resolves the package by its own name at runtime** — the only occurrences are
`package.json`, README/docs prose, and one comment in `vite.lib.config.js`. The rename is safe.

Consumer side: 9 source references renamed across 4 files + the `package.json` dependency (T7's table).

**Live-verified against a real project on the real runtime:**

| check | result |
|---|---|
| cold pod boot | 16 s (consistent with the known ~15 s cold start) |
| vite ready | 830 ms |
| landing page | renders; both generated images load |
| the Babylon game | **plays** — reached wave 3, 260 score, 4 kills, running unattended |
| HMR round-trip | **502 ms** (edit → visible in preview), file restored after |
| `nodepod-assets.spec.ts` | green — `public/` matches the fork's worker |
| `sandbox-seam.spec.ts` | green, and its positive control still names `nodepod-boot.ts`, so the rename did not make the default-deny scan vacuous |
| gates | typecheck ✓, 0 lint errors, 4,571 tests, brand ✓ |

⚠️ **`package.json` currently points at a LOCAL TARBALL**
(`file:../../../Nodepod/babylonjs-toolkit-nodepod-1.9.18-btk.0.tgz`) so the upgrade could be proven
before anything was published. **It must be switched to `"1.9.18-btk.0"` once the package is on npm** —
a `file:` spec is unbuildable on any other machine and in CI.

⚠️ Peer warnings for `@xterm/xterm` (want ^6, have 5.5.0) and `@xterm/addon-fit` (want ^0.11, have
0.10.0) are **pre-existing, not from the upgrade** — 1.9.12 and 1.9.18 declare identical ranges, and the
terminal is live-verified working on both.

### Remaining

**T2–T6 are DONE and verified (2026-08-01).** Fork commit `96b951e` on `btk/util-parity`; 163 fork tests
green (116 util, 47 path); `formatWithOptions` confirmed present in `dist/__worker__.js` **and** both the
ESM (`index-8HRj_Dty.js`) and CJS (`index-DA_V3tLa.cjs`) chunks, so T3's both-module-systems requirement
is proven at the BUNDLE level, not just in `src/`. All 14 symbols verified on both export surfaces.

### ✅ T7 DONE (2026-08-01) — published, adopted, and step 6 live-verified

`@babylonjs-toolkit/nodepod@1.9.18-btk.3` is on npm and pinned in `package.json` as a **registry**
version. The blank-published-game blocker that Verification step 6 tripped on was **ours** (the pod
service worker adopting the share iframe — see the FOURTH DEFECT, since corrected) and is fixed: a
published game now renders, plays, and serves all its assets 200.

**`1.9.18-btk.4` published and adopted 2026-08-01** — the third and final piece of the service-worker
fix. Adopted by the hand-edit recipe below: **10-line lockfile diff, nodepod only**, and
`pnpm install --frozen-lockfile` printed *"Lockfile is up to date, resolution step is skipped"*, which
is the proof no re-resolution happened (590 was the white-screen).

**Live-driven as a visitor, on btk.4, with `node_modules/.vite` cleared and the dev server restarted:**

| check | result |
|---|---|
| `/play/9m2epwr45j6v` landing | renders fully — hero, car cutout, all three track tiles |
| iframe URL | `…/?embed=1&__nodepod=host` — the marker is on the wire |
| document in the frame | the **game's**, not the builder's |
| START RACE → **in-frame navigation** to `/play/<id>/play` | **resolves correctly** — this is the exact case `btk.3` failed |
| Babylon canvas | live, 3930×2218, car rendering |
| console | no `No routes matched`, no `import_meta`. Remaining warnings (`TrackManager`, `StartPosition 20`, AudioContext) are the game's own scene content and audio device |
| `markHostClient(clientId)` **and** `markHostClient(resultingClientId)` in `public/__sw__.js` | both present — the fix is in the SHIPPED worker, not merely in the package |

### Historical — the publish block, kept for the `--tag`/2FA details

**🔴 T7 WAS BLOCKED on npm 2FA — the publish was the ONLY thing standing between there and done.**
`npm whoami` → `mackeyk24`, scope `@babylonjs-toolkit` read-write, package validates
(460 files, 5.8 MB). `npm publish --access public --tag latest` then fails `EOTP`: npm demands a
one-time password through an interactive browser flow. `--tag` is REQUIRED — `1.9.18-btk.1` is a
prerelease (the hyphen), and a bare publish refuses.

The owner must run, in `~/Documents/Repos/Nodepod`:

```
npm publish --access public --tag latest
```

⚠️ **The prepublish build reruns `build:lib` + `build:types`, regenerating `dist/`.** Verified
deterministic — integrity came back `sha512-P59Rs8W78R+0L[...]qTJ1y5LZG5ouw==` across three separate
packs, matching the tarball hash already in `pnpm-lock.yaml`. Do not assume that; re-read the hash npm
prints and compare before editing the lockfile.

**Then the adoption half of T7**, which is where the THIRD DEFECT below bites: flipping `package.json`
off the `file:` spec to `"1.9.18-btk.1"` changes the resolution KIND (file → registry), so the
tarball-swap recipe does not transfer verbatim — the lockfile entry loses its `tarball:` field and the
key changes shape. Hand-edit it, then `pnpm install --frozen-lockfile`, then **`git diff --stat
pnpm-lock.yaml` and confirm it is ~6 lines before running anything else.**

⚠️ **The user's `Top Down Twin Stick` project now carries its own workaround** for this bug — a
`tools/build.mjs` that polyfills `util.formatWithOptions` before importing Vite, plus a `package.json`
build-script edit, written in an earlier chat turn. Once `-btk.1` ships that becomes unnecessary. It is
the user's project file, so removing it is their call, not something this plan should do silently.

---

## The defect

**Publishing any game is broken.** Share runs `tsc -b && vite build`; the build dies in 2 ms:

```
error during build:
TypeError: formatWithOptions is not a function
```

`debug` — a transitive dependency of essentially every build tool — logs through
`util.formatWithOptions(exports.inspectOpts, ...args)`. Nodepod's `node:util` polyfill
(`src/polyfills/util.ts`) has `format` but not `formatWithOptions`.

Call sites, verified in our own tree (a proxy for the generated project's, which Vite dominates):

- `node_modules/vite/dist/node/chunks/dep-C6uTJdX2.js:16403`
- `node_modules/vite/dist/node-cjs/publicUtils.cjs:1142`

**Both module systems**, which matters for the fix (§T3).

This is why dev works and publish does not: the dev path never reaches that logger.

### Scope of the gap

Against Node v24.11 the polyfill is **14 exports short**: `formatWithOptions`, `MIMEType`,
`MIMEParams`, `aborted`, `diff`, `getCallSites`, `getSystemErrorMap`, `getSystemErrorMessage`,
`getSystemErrorName`, `parseEnv`, `setTraceSigInt`, `toUSVString`, `transferableAbortController`,
`transferableAbortSignal`.

**Only `formatWithOptions` has a call site** across vite / rollup / postcss / typescript / esbuild /
@babel / chokidar. (`parseEnv` appears to match but the hits are a local `parseEnvVar()` helper, not
`util.parseEnv`.) Several of the rest — `diff`, `setTraceSigInt`, `getSystemErrorMessage`,
`getCallSites` — are recent Node additions no bundler uses, so **14 overstates the practical gap**.

⚠️ Three of my first greps returned all-zeros *including* `formatWithOptions`, which I already knew was
present: zsh does not word-split unquoted variables, and `--include` was silently filtering everything
out. A filter that matches nothing reports a clean bill of health. The counts above are from the run
that reproduces the known-good hit — re-derive the same way if this is revisited.

**Owner decision (2026-08-01): implement all 14 anyway**, for parity, so the next missing one is not
another broken publish. Recorded once and not re-litigated: twelve are speculative — untested-in-anger
code that reads as coverage — so **`formatWithOptions` lands and is verified first**, and the rest must
not delay it.

---

## Why a fork, and not `pnpm patch`

`pnpm patch` was the first choice — `_specs`' predecessor plan already names it for the cold-start work,
and two mechanisms on one dependency is worse than either. It cannot work here:

- the package's `main`/`exports` resolve to **`dist/`**; `src/` ships for types and reference and is
  never executed;
- the polyfill is bundled, **minified**, into three dist files including the ~1 MB `dist/__worker__.js`;
- so a patch would have to edit minified bundles — the stop condition the cold-start plan wrote down.

No supported escape hatch exists either: `NodepodOptions` (`src/sdk/types.ts:7-75`) has no polyfill or
module-override hook, and a Vite `resolve.alias` does not help — Vite's own code `require`s `node:util`
from the pod runtime, and aliases only affect the app being bundled.

Licence is not a blocker: MIT + Commons Clause permits modification and redistribution, forbidding only
reselling Nodepod itself.

---

## §0 — 🔴 OPEN DECISION: which base?

The fork's HEAD is **1.9.18**. We run and have live-verified **1.9.12**.

| release | change to `src/` |
|---|---|
| 1.9.14 | **117 files, +9,448 / −1,130** |
| 1.9.15 | 5 files, +1,323 / −483 |
| 1.9.16–1.9.18 | smaller: vite 8.1 import analysis, `import.meta` parity, Expo `listen` fix |

`util.ts` itself grew **559 → 767 lines**, so every line number below is 1.9.12's and is stale against
HEAD.

**Confirmed: 1.9.18 still has no `formatWithOptions`.** The fork is required either way.

- **Option A — branch off the 1.9.12 tree** (`e7caf03~1`; `e7caf03` is the 1.9.13 version bump), publish
  `1.9.12-btk.1`. One isolated change against a runtime already live-verified: if publish still breaks,
  it is the util code and nothing else. Bump to 1.9.18 later as its own change with its own live drive.
  The upstream PR (§T8) branches separately off HEAD.
- **Option B — branch off 1.9.18**, publish `1.9.18-btk.1`. Newer, one hop, picks up six releases of
  upstream fixes — but conflates a ~10k-line runtime upgrade (shell, watcher, worker: precisely the
  parts tuned and live-verified this week) with the fix, so a sandbox regression would be ambiguous
  between the two.

Answer this, then proceed from T1.

---

## Tasks

> Checklist added 2026-08-01 at the start of the `bt-execute ALL` run — the tasks were written as plain
> headings, so there was nothing for a resumable run to flip. Each box is checked only after its own
> Acceptance is independently verified.

- [x] **T1** — Fork housekeeping (upstream remote, `btk/util-parity`, version → `-btk.1`)
- [x] **T2** — `formatWithOptions` via a shared `formatImpl`
- [x] **T3** — Both export surfaces, every symbol
- [x] **T4** — The remaining 13
- [x] **T5** — Fork tests
- [x] **T6** — Build and prove it reached the bundles
- [x] **T7** — Publish and adopt *(published 2026-08-01; the FOURTH DEFECT that blocked Verification step 6 turned out to be OURS and is fixed — step 6 now passes, live)*
- [ ] **T8** — Upstream PR to `R1ck404/Nodepod` — **DEFERRED by the owner (2026-08-01), branch prepared and pushed.** *"i am not 100% i should send my customizations upstream"* — a judgement call about their own work going out under their name, not a blocker. Everything else in this plan is done. See T8 below for the ready branch and for what shipping it would and would not commit them to.

### T1 — Fork housekeeping

In `~/Documents/Repos/Nodepod` (already cloned; `origin` → the fork, no `upstream` remote yet):

- `git remote add upstream https://github.com/R1ck404/Nodepod.git` — or the PR in T8 has nowhere to go.
- Branch `btk/util-parity` off the chosen base.
- `package.json`: name → **`@babylonjs-toolkit/nodepod`** (sibling to the existing
  `@babylonjs-toolkit/bridge`), version → **`<base>-btk.1`**, so provenance and upstream base are
  readable from the version string alone.
- Keep `build:publish` (`build:lib` + `build:types`) as the release build. **No `prepare` script** — that
  is only needed for git-URL installs, which publishing removes.

### T2 — `formatWithOptions`, refactor rather than copy

`format` (L4 @1.9.12) hardcodes `inspect(val)` for `%o`/`%O` with no options. Extract the specifier
parser into a shared internal `formatImpl(inspectOptions, template, ...values)`; `format` calls it with
`{}`, `formatWithOptions` with the caller's options. Duplicating the parser means the two drift on the
next `%`-specifier fix.

`inspect`'s options type is currently `{ depth?, colors? }` (L47) — widen it, or threading options
through is a claim the signature does not honour.

### T3 — 🔴 Both export surfaces, every symbol

**Every new symbol goes in TWO places: the named `export`, and the `export default {…}` object**
(L527 @1.9.12, currently 31 entries).

CJS `require('node:util')` receives the default object and `debug` calls `util.formatWithOptions` — so a
named export alone leaves the reported bug exactly as it is for CJS consumers **while looking fixed in
the diff**. Vite calls it from both module systems (§"The defect"), so both paths are live.

### T4 — The remaining 13

Faithful implementations are possible for: `toUSVString`, `MIMEType`, `MIMEParams`, `aborted`,
`transferableAbortController`, `transferableAbortSignal`, `getSystemErrorName`, `getSystemErrorMap`,
`getSystemErrorMessage`, `parseEnv`, `diff`.

**Two cannot be faithful in a browser and must say so rather than pretend:**

- `setTraceSigInt` — there is no SIGINT to trace. An explicit, documented no-op.
- `getCallSites` — best-effort over `Error.prepareStackTrace` (V8 supports it in Chrome); it will not
  match Node's frame data exactly.

A polyfill that silently returns a plausible wrong answer is worse than one documented as degraded — the
only reason this bug was cheap to find is that the failure was loud.

### T5 — Fork tests

In the fork's existing vitest setup:

- each new symbol present on **both** export surfaces (this is what catches a T3 regression);
- `formatWithOptions` pinned against Node's reference output —
  `formatWithOptions({colors:false},'%s %d %o','a',1,{x:1})` → `"a 1 { x: 1 }"`;
- `getSystemErrorName(-2)` → `ENOENT`; `getSystemErrorMap().size` ≥ 80.

### T6 — Build and prove it reached the bundles

`pnpm run build:publish`, then **grep `dist/__worker__.js` and the index chunks for
`formatWithOptions`**. The whole reason a patch was rejected is that the runtime executes bundles, not
`src/` — so "it is in the source" is not evidence, and this check is the one that distinguishes them.

### T7 — Publish and adopt

`npm publish --access public` (needs the owner's npm auth).

Then in **this** repo — the specifier appears in five places:

| file | change |
|---|---|
| `package.json:112` | `"@scelar/nodepod": "1.9.12"` → `"@babylonjs-toolkit/nodepod": "<base>-btk.1"` |
| `app/lib/sandbox/nodepod-boot.ts:130` | the `await import(...)` — the ONLY runtime import |
| `app/lib/sandbox/sandbox-seam.spec.ts:161-182` | the default-deny scan's package string (4 refs) |
| `scripts/sync-nodepod-assets.mjs:31-37` | `require.resolve(...)` + doc comments |
| `app/lib/sandbox/nodepod-assets.spec.ts:10` | doc comment naming the package |

Chosen over a `npm:@babylonjs-toolkit/nodepod` **alias**: an alias keeps `@scelar/nodepod` in the source
while running our fork, and a name that misreports what is installed is how the next reader draws the
wrong conclusion.

Then **`pnpm sync:nodepod`** — `public/__sw__.js` and `public/__worker__.js` are generated copies and
`nodepod-assets.spec.ts` pins them byte-identical to the installed package. Skipping it means a patched
runtime serving an unpatched worker; the guard fails loudly, which is the behaviour we want.

⚠️ `sandbox-seam.spec.ts`'s default-deny scan is what keeps the vendor confined to one module. It must
keep **passing** after the rename — never be relaxed to accommodate it.

### T8 — Upstream

PR `formatWithOptions` (at least) to `R1ck404/Nodepod` with the `debug` call site attached, branched off
their HEAD. It is a standard `node:util` API and any project whose build pulls in `debug` hits this — a
real contribution, not a private hack. Keep the local fork until it lands and releases.

**STATUS 2026-08-01 — prepared, verified, NOT submitted. One click from the owner finishes it:**

**https://github.com/R1ck404/Nodepod/compare/main...MackeyK24:Nodepod:btk/upstream-util-parity**

Branch `btk/upstream-util-parity` @ `0a67acd`, pushed to `MackeyK24/Nodepod`, branched off
`upstream/main` exactly (verified by `git merge-base`, not merely by ancestry). Independently verified:

- **4 files only** — `src/polyfills/util.ts`, `src/polyfills/path.ts` and their two test files. **No
  `package.json`** (so no `@babylonjs-toolkit` rename and no `-btk` version reaches a stranger's diff),
  no `dist/`, and **none of the service-worker commits** — those add new API surface (`?__nodepod=host`)
  and are a design proposal, not a bug fix, so they belong in their own PR if at all.
- `formatWithOptions` present on **both** export surfaces, which is the property that matters.
- The commit message carries both `debug` call sites, as the task requires.
- **163 tests green off upstream HEAD** (116 util, 47 path) — re-run by the verifier, not taken on trust.

**The box stays unchecked** on the verifier's reasoning, which is correct: the named deliverable is a
pull request on `R1ck404/Nodepod`. A branch on our own fork is necessary but not sufficient — no
maintainer sees it, their CI never runs, and nothing can "land and release" as the task's closing
sentence requires. `gh` is not installed here and opening a public PR under the owner's identity is
theirs to do.

**DEFERRED 2026-08-01 — the owner is unsure about sending customizations upstream, and nothing depends
on resolving that.** Recorded so it is not re-raised as an oversight. What the deferral does and does
not cost:

- **Nothing breaks.** We ship our own package and the fork is self-sufficient. The plan's own note —
  *"keep the local fork until it lands and releases"* — means the fork is the plan of record either way.
- **The cost is carrying rebases forever.** Every future upstream release has to be re-applied by path
  (they share no git history with us, see below), and `util.ts` is a large file that upstream is
  actively editing.
- **What the branch would actually expose, if that is the hesitation:** two `node:` polyfill bug fixes
  and their tests — no product code, no `@babylonjs-toolkit` name, no `-btk` version, and none of the
  service-worker work. It reads as "your polyfill diverges from Node here", not as a look inside
  anything we built. The genuinely bespoke part (`?__nodepod=host`) is deliberately excluded and would
  be a separate conversation with the maintainer if it were ever wanted.
- **The reverse is also fair:** `formatWithOptions` is a real upstream bug that breaks any Nodepod user
  whose build pulls in `debug`. Not sending it is a choice to let that stand, which is the owner's to
  make.

⚠️ **Finding, and it changes how a future rebase must work: upstream has NO shared history with our
fork.** `R1ck404/Nodepod`'s `main` is a **single commit** — `d89642f "Initial project snapshot"`, dated
2026-08-01 — while our fork carries 175 commits including `8180909 "Merge pull request #78 from
R1ck404/Nodepod"`. Upstream squashed (or re-created) its history after we forked. The **content** is
identical where it matters (`util.ts` and `path.ts` at `upstream/main` are byte-for-byte our base
`8180909`), which is why the patch applied cleanly — but `git merge upstream/main` or a rebase would see
two unrelated histories. **Sync by applying paths, not by merging refs.**

---

## Verification

1. **Reproduce first.** `Top Down Twin Stick` currently fails publish with `TypeError:
   formatWithOptions is not a function`. That exact string must be gone. ⚠️ Its unrelated
   `hideSplashScreenDelayMs` type error must be fixed first, or the build stops earlier for a different
   reason and proves nothing.
2. **Fork tests** — `pnpm test` in the fork; both export surfaces asserted.
3. **T6 bundle grep** — the symbol is in `dist/__worker__.js`, not merely in `src/`.
4. **`pnpm sync:nodepod`** then `nodepod-assets.spec.ts` green — `public/` matches the fork's worker.
5. **Gates** — `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` (4,571 baseline) +
   `pnpm check:brand`.
6. **Live drive, not construction** — create a project, let it come up, use the terminal, then
   **Share → publish → open `/play/:shareId` and play it**. A 201 is not proof a stranger can play the
   game; T17b shipped every published game broken because nobody ever loaded one.
7. **Sandbox unaffected** — a cold pod still boots, preview appears, HMR works. One polyfill changed but
   the worker bundle is rebuilt wholesale, so confirm rather than assume. Under Option B this is the
   step carrying the whole 10k-line upgrade — budget for it.

---

## 🔴 SECOND DEFECT, found by this plan's own verification — `path.normalize` (FIXED 2026-08-01)

Fixing `formatWithOptions` let a publish build finish for the first time ever on Nodepod — and the
game it produced was **broken**: every asset 404'd, because the emitted HTML said

```html
<script type="module" src=".index.js"></script>   <!-- one character short of ./index.js -->
```

**This is NOT a regression from the util work.** Before the fix the build died in 2 ms, so no
published game had ever existed on this provider; the bug was unreachable, not introduced. It is the
same defect CLASS as the whole plan — a `node:` polyfill silently disagreeing with Node.

**Root cause, isolated rather than guessed.** Ruled out in order: the template (it already ships
`base: "./"`), the CLI arg (`buildSpawnArgs` passes `--base=./`), the shell (Nodepod's own parser
tokenises `--base=./` intact), and Vite (real Node + the same Vite 8 emits `./index.js`). What was
left was `src/polyfills/path.ts`:

| input | Node | Nodepod (before) |
|---|---|---|
| `normalize("./")` | `"./"` | `"."` |
| `normalize("a/b/")` | `"a/b/"` | `"a/b"` |
| `normalize("a/../")` | `"./"` | `"."` |

Node's docs are explicit — *"Trailing separators are preserved"* — and **11 of 21 probed inputs
diverged**. Vite normalises its `base` through this call, so `./` became `.` and every asset URL lost
its separator. One-line fix, `join` inherits it, full fork suite green (only the 4 pre-existing
`nodepod-sab` failures), pinned by 4 tests in `path.test.ts` (mutation-verified: reverting fails 3).

⚠️ The pairs in those tests are asserted TOGETHER on purpose — a fix that appends `/`
unconditionally passes `normalize("./")` and corrupts `normalize("a/b/..")`.

**Generalisable:** the plan's Verification step 6 says *"A 201 is not proof a stranger can play the
game"*. It was right twice over — publish returned success, the dialog said "Your game is shared",
and the game was unplayable. Only fetching the built HTML found it.

---

## 🔴 THIRD DEFECT — a bare `pnpm install` re-resolved the WHOLE tree and white-screened the app (FIXED 2026-08-01)

Adopting `-btk.1` was done with a plain `pnpm install`. That did not change one specifier — it
**re-resolved every caret range in the project**: 590 resolution changes, a 9,392-line lockfile diff,
`@types/node` 24→26, `sass-embedded` 1.89→1.100, `vite` 5.4.19→5.4.21, the whole CodeMirror set, and —
fatally — **`react-icons` 5.5.0 → 5.7.0, which dropped the `SiAmazon` export**:

```
Uncaught SyntaxError: The requested module '/node_modules/.vite/deps/react-icons_si.js'
does not provide an export named 'SiAmazon'
```

One missing export at module-eval time takes down the whole React tree, so the symptom was a **total
white screen** — which reads as "the new nodepod runtime broke the app". Nodepod was innocent; the
package under test was the one thing in the diff that was *supposed* to change.

**How to adopt a new tarball without this happening.** The lockfile is the known-good state, so
edit it rather than regenerate it:

1. `git checkout HEAD -- pnpm-lock.yaml`
2. rewrite the tarball filename (4 refs), the `version:` field (**line ~1068 — a separate field the
   filename rewrite does not touch**), and the `integrity:` hash
   (`sha512-` + base64 of `createHash('sha512')` over the `.tgz`)
3. **`pnpm install --frozen-lockfile`** — it prints *"Lockfile is up to date, resolution step is
   skipped"*, which is the proof no re-resolution happened
4. `rm -rf node_modules/.vite` — Vite caches optimized deps, so a stale bad bundle survives the fix

Result: a **6-line** lockfile diff touching nothing but nodepod.

⚠️ **`pnpm install --frozen-lockfile` exits 0 on the integrity mismatch** but leaves the package
uninstalled behind an `ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE` line. Read the output; do not trust
the exit code.

**Generalisable:** a lockfile is a money-path-shaped artifact — it fails silently, in bulk, and blames
whatever else was in the commit. When a dependency bump breaks something, **diff the lockfile and count
the changed resolutions before debugging the dependency**. 590 ≠ 1 is the whole diagnosis.

---

## 🔴 FOURTH DEFECT — every published game renders BLANK (found 2026-08-01, **WAS ours, FIXED**)

> ⚠️ **This section originally concluded "NOT ours, NOT fixed" and that conclusion was WRONG.** The
> owner rejected it — *"There is a blank page on share.. that is our problem... that used work now it
> not"* — and was right. The original reasoning is kept below the line because **how it was wrong is
> the most transferable thing in this file**; the fix follows.

Driving T7's live verification end to end: the Arcade Racing project built, published, returned
`/play/9m2epwr45j6v`, the dialog said **"Your game is shared"** — and the page is **white**, with only
the "Made with Babylon Toolkit" badge. The game never renders.

```
[warn] No routes matched location "/play/9m2epwr45j6v/?embed=1"
```

### Root cause — the Nodepod service worker adopts the share page's iframe

`__sw__.js` claims paths for the pods it hosts and routes matching requests into them. The builder page
has a live pod, so the worker holds a claim on `/`. The Share dialog then loads the published game in a
**same-origin** iframe — and the worker's `lookupPodForClaimedPath` walks the path tree UP, hits the `/`
claim, and serves `/play/<id>/…` **out of the builder's pod** instead of letting it reach the server. The
iframe gets the builder's own document back, so React Router is handed a location its routes have never
heard of, and reports it unmatched. Hence the misleading warning: the basename logic was innocent all
along, and the document in the frame was never the game's.

**Local-dev only.** In production `PLAY_URL` puts the game on a different origin, and SW rule 2 passes
cross-origin requests straight through. That is why it had never been seen before — and why a "does it
work in prod?" instinct would have mis-filed it as fine.

**Fixed across three fork commits, each closing a hole the previous one left:**

| commit | version | what it adds | the hole it closed |
|---|---|---|---|
| `961b321` | btk.2 | `?__nodepod=host` on a request makes the worker decline it | the **document** only — its subresources still walked up to the `/` claim and came back as HTML |
| `e048a50` | btk.3 | a `hostClients` Set; the opt-out marks `resultingClientId`, and any request from a marked client is declined | one **page** only — a navigation inside the frame commits a NEW client id, which was unmarked |
| `5182a1b` | btk.4 | a marked client that performs a navigation marks the resulting client too | — |

Consumer side: `share/wrapper.ts` appends `&__nodepod=host` to the iframe `src`. Every variant is
pinned in `share.spec.ts`, including a guard that the marker is present on **all** of them — the two
partial fixes above are exactly what an every-variant assertion catches and a single-case one does not.

### Two further defects the same live drive uncovered, both fixed

**`import_meta is not defined`** — the game's landing page rendered but pressing START threw in Vite's
own preload helper, which every dynamic import goes through. Nodepod rewrites `import.meta` →
`import_meta` for its CJS module loading, where its wrapper declares the binding; that rewrite reached
code which then got **bundled into the user's build**, where nothing declares it. Repaired at publish
time by `repairBareImportMeta` (`share/publish.ts`), which **refuses to touch a chunk that declares
`import_meta` itself** — rewriting one of those would produce `var import.meta = …`, a syntax error, i.e.
strictly worse than the bug.

**Root-absolute generated-asset URLs** — the game played and its track tiles were empty boxes.
`Home.tsx` carried `"/assets/generated/track-x.jpg"`, which under `/play/<id>/` resolves to the app
origin's root. The CSS hero in the SAME build loaded fine, because a bundler rewrites `url()` and cannot
rewrite a JS string literal. Fixed at **both** ends: `mediaReferenceUrl` now hands the model
`./assets/generated/…` (future games), and `repairRootAbsoluteAssetRefs` re-points existing ones at
publish time — **only for a path that names a file the build actually emitted**, so an API route or a
path on another service is never silently relativised.

**Live-verified end to end 2026-08-01:** published game renders, START RACE launches a Babylon canvas
(3930×2218), all 5 images return 200. **Verification step 6 now passes.**

---

### The original (wrong) reasoning, kept as the lesson

> **🔴 This is NOT a regression from the util/path work, and the control is what proves it.** The
> `Blank Canvas` game, published in an EARLIER session, fails **identically** — same warning, same blank
> page. And the basename is computed in the BROWSER at runtime from `window.location`; our polyfills only
> affect the BUILD.

**Why that control was worthless.** It establishes only that the defect is not in the *build output* —
and both games were being **served and framed by the CURRENT app**, running the CURRENT Nodepod worker.
An old artifact viewed through new machinery tests the new machinery, not the old artifact. The control
answered a question nobody had asked, and its confident framing ("the control is what proves it") is
what made it persuasive.

**And the warning text actively misdirected.** `No routes matched location` names the router, so the
investigation went to `appBasename()` and stopped at "the basename never got applied — root cause past
that point is not yet isolated". The router was reporting honestly about a document that should never
have been in that frame. **When a component reports a nonsense input, suspect what fed it before
suspecting the component.**

**Generalisable, and it is this plan's own lesson landing a third time:** the `path.normalize` entry
says *"publish returned success, the dialog said 'Your game is shared', and the game was unplayable.
Only fetching the built HTML found it."* Here the built HTML was **correct** and the game was still
unplayable — so even fetching the HTML is not enough. Only loading the page, reading the console, **and
disbelieving the first plausible exoneration** found this one.

---

## Related finding — NOT part of this work

The same project also fails on `src/scripts/TopDownTwinStickMode.ts:87 - error TS2339: Property
'hideSplashScreenDelayMs' does not exist on type 'TopDownTwinStickMode'`.

The Agent Reference teaches `this.hideSplashScreenDelayMs = 2000` in a `SceneController`
(`references/…` prose + `AgentReference/training/declarations/babylon.toolkit.d.ts:1150`), while the
**shipped runtime typings declare `scenePrewarmDurationMs`** instead
(`BabylonToolkit/Runtime/babylon.toolkit.d.ts:1150-1153`). The property was renamed and the docs still
teach the old name.

**So any game following that doc runs perfectly in dev — Vite never typechecks — and can never be
shared or deployed.** That is every project touching the splash screen, and it was invisible until the
build error was surfaced in the Share dialog (commit `e02765f`).

Those docs are authored in `babylontoolkit/agent`, which this codebase consumes and never edits —
**report it there.**
