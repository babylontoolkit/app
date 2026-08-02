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

1. `npm publish --access public` from the fork (needs owner npm auth), then flip `package.json` off the
   `file:` spec and re-run gates.
2. Phase 2 — the util work: T2–T6, T8 below, published as `1.9.18-btk.1`.

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
- [ ] **T7** — Publish and adopt *(publish needs owner npm auth)*
- [ ] **T8** — Upstream PR to `R1ck404/Nodepod`

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
