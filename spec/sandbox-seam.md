# spec/sandbox-seam.md — The Sandbox Seam (governs SPEC §1.3.5, §8)

> **Status: the seam is BUILT (2026-07-26), the SECOND PROVIDER is BUILT AND WIRED, and the whole
> creation path has been DRIVEN LIVE on it (2026-07-26/27).** `SandboxProvider` exists, every runtime
> store is constructed with one, and a default-deny source scan keeps it that way — for **both**
> vendors. `codesandbox-provider.ts` implements the interface against Together CodeSandbox
> (`spec/sandbox-codesandbox.md`), with the server half in `app/lib/.server/sandbox/` (key holder,
> session/preview routes; per-PROJECT `sandbox_id` on the project row since 2026-07-28 — the interim
> per-user registry is deleted). **The cutover is a BUILD-TIME switch that already
> works**: `VITE_SANDBOX_PROVIDER=codesandbox` selects the provider in `index.ts` (unset/typo =
> WebContainer, the safe direction; both branches are dynamic imports so the unused runtime is never
> even downloaded), and the same flag drives `WORK_DIR` (`/project/workspace` vs `/home/project`) and
> the COEP conditional in `entry.server.tsx`.
>
> ~~What remains before REAL USERS ride it: the 2026-07-27 review's findings…~~ **SUPERSEDED
> 2026-07-28: the production plan (`_specs/codesandbox-production_plan.md`, T1–T16 + T17a/T17b)
> closed the review list** — per-project sandboxes are built (the per-user registry is DELETED;
> `sandbox_id` lives on the project row), the VM lifecycle has callers (teardown on delete, cap-2
> hibernate-oldest, reset-disposes, resume→create fallback), the `/home/project` literal family is
> migrated behind a default-deny scan, `.codesandbox/` is excluded at the map layer, and the shell
> demux is one pump. Every §11 finding is dispositioned in `spec/sandbox-codesandbox.md`. Nine of
> ten T17 live scenarios ran clean against the real provider (numbers in that spec's status block).
> **Still between here and real users:** T17c (checkpoints silently stop on CSB; `dist/` leaks into
> the file map after publish — FILED, not fixed), T17 scenario 3 (Assets-tab upload), metering
> (item 4 below — placeholder folded into margin, now ASSERTED by T11's floors and MEASURED by
> T12's report), and the per-deploy A/B (item 6).

## Why this exists

WebContainers is proprietary (StackBlitz). `spec/licensing.md` makes a paid commercial plan a hard
**Phase-3 gate**: no plan, no external users, whatever the code does. Two triggers were always named
for the swap — (a) StackBlitz terms unacceptable at scale, (b) WebContainer limits (install speed,
memory alongside a Babylon scene) hurting UX. A third arrived in practice: **StackBlitz not
responding at all.** A dependency you cannot get a contract from is the same risk as one whose
contract you cannot afford.

The seam is also negotiating leverage, and it only counts as leverage if it is real.

## The standing rule (unchanged, now enforced)

**No WebContainer-specific coupling outside the provider.** Feature code imports `sandbox` from
`~/lib/sandbox` and nothing else. It was prose for the whole build, and prose cannot fail: when the
seam was finally extracted, **13 modules imported `@webcontainer/api` directly and 7 more reached
the boot singleton**. The rule held in spirit — nothing had grown WebContainer-specific *logic* — but
the type was everywhere.

Now enforced by `app/lib/sandbox/sandbox-seam.spec.ts`, default-deny, both specifiers, with
CONTROLS. Adding a file that imports either one fails the suite (mutation-verified).

## What was built

| File | Role |
|---|---|
| `app/lib/sandbox/types.ts` | The interface. Declares its own types — imports nothing from `@webcontainer/api`. |
| `app/lib/sandbox/webcontainer-provider.ts` | The WebContainer adapter. The one intentional dependency. |
| `app/lib/sandbox/index.ts` | The entry point. The single place that decides which runtime backs `sandbox`. |
| `app/lib/sandbox/sandbox-seam.spec.ts` | Default-deny scan + controls + a non-WebContainer provider that satisfies the interface. |
| `app/lib/sandbox/codesandbox-provider.ts` | The CodeSandbox adapter — the second provider. |
| `app/lib/sandbox/codesandbox-translate.ts` | Pure path/mount/watch translation, where the silent failures live. |
| `app/lib/.server/sandbox/{config,lifecycle,service}.ts` | Key holder, create-vs-resume decision, and lifecycle. |

`app/lib/webcontainer/index.ts` survives unchanged as the WebContainer **boot** (COEP flags, preview
script injection, preview-error forwarding) — hide-don't-delete, and it keeps the upstream diff small.

### The surface

Measured against real call sites, not copied from WebContainer's `.d.ts`:

- `fs` — `readFile` / `writeFile` / `readdir` / `mkdir` / `rm`. The overload pairs are load-bearing:
  `readFile` with no encoding returns **bytes** (that is `spec/binary-files.md`'s contract).
- `mount(tree)` — atomic. Not a nicety: the starter used to arrive as ~64 sequential writes that
  raced a cold boot, so `npm install` ran against an empty directory.
- `spawn(command, args, options)` — returns a process with `output` / `input` / `exit` / `kill` / `resize`.
- `watchPaths` / `onServerReady` / `onPort` — named for what they do. Two of these were
  `container.internal.*`, i.e. `@unstableInternal` in StackBlitz's own types.
- `textSearch?` — **optional**, gated by a capability flag.
- `clearPort?` — **optional**, gated by a capability flag. Kills whatever is listening on a port and
  waits (bounded) for it to free. Exists for sandboxes that OUTLIVE a page session: a resumed/forked
  microVM wakes with the previous session's dev server still bound to 5173, and a fresh
  `npm run dev` dies with "Port already in use" (MEASURED live on CodeSandbox, 2026-07-27). Creation
  calls it (`clearInheritedDevServer`) before mounting the template. WebContainer declares `false` —
  its runtime dies with the tab, so there is nothing to inherit.
- `teardown()` — unused by app code today (a WebContainer dies with the tab) but in the contract,
  because a server provider bills for whatever it does not reap.
- `capabilities: { terminal, textSearch, watch, clearPort }` — so the UI degrades instead of throwing.

### Capability flags replaced method-probing

`Search.tsx` used to ask `typeof instance.internal?.textSearch !== 'function'`. That reads as
defensive coding rather than a contract, cannot be tested, and reports "no results" where the honest
answer is "not supported". It now reads `capabilities.textSearch`.

## What is still WebContainer-shaped (flagged, not fixed)

Honesty matters more here than a clean scorecard:

1. **`PreviewsStore.getPreviewId`** parses `*.local-credentialless.webcontainer-api.io` hostnames.
   It degrades safely — a different provider returns `null` and every caller guards on it, costing
   only the cross-tab preview broadcast. Promoting preview-id extraction onto the provider is
   follow-up work.
2. **`shell.ts`'s OSC parsing is now provider-CONFIGURED, not provider-specific** (2026-07-27): the
   shell command and its marker dialect come from the provider's `SandboxShell` (`{command, args,
   readyOsc?, beginOsc?}` — WebContainer declares `/bin/jsh --osc` + `readyOsc:'interactive'`;
   CodeSandbox declares `bash` + `beginOsc:'begin'` via the versioned rc block). What remains
   WebContainer-shaped is the parsing machinery itself living in `shell.ts` rather than behind the
   seam. (The §11 M5 demux race on the CodeSandbox dialect was FIXED 2026-07-28 — one pump owns the
   stream reader, every signal reaches every waiter; plan T9c.)
3. **`mount()` corrupts binaries on the WebContainer provider** (`TextDecoder('latin1')` =
   windows-1252). Documented at length in `~/lib/registry/mount-tree.ts`. This is a property of one
   provider; the seam permits `Uint8Array` contents and a correct provider would carry them.
4. **`useGit.ts`** stubs symlinks and `chmod` because WebContainer has neither.

None of these block a swap. All of them are one module each.

## Swap plan

**Vendor chosen: Together CodeSandbox**, on licensing grounds first — it is self-serve (API key,
published rates, no negotiation) where StackBlitz requires a contract from a vendor that does not
answer. The full measured case is in `spec/sandbox-codesandbox.md`; the headline is **7.6s from
nothing to a playable game**, because a project forks a pre-built template whose snapshot already has
`node_modules` installed and the dev server running.

Cloudflare Sandbox was researched first (`spec/sandbox-cloudflare.md`) and rejected: its disk is
ephemeral, so every wake is a full re-materialisation, and `getSandbox()` is a Durable Object binding
that would mean deploying a **second application** beside Lightsail.

- [x] **1. Implement `SandboxProvider` against the vendor.** Done. Boots from a `csb build` template
      with the starter + `node_modules` baked in, on a custom Debian 12 image.
- [x] **2. Wire the preview into the iframe.** DONE + DRIVEN LIVE 2026-07-26 (creation → mount →
      `npm install` → `npm run dev` → the generated landing page rendering in the workbench iframe).
      Four pieces, each of which was a silent blocker on its own:
      (a) `api.sandbox.preview.ts` — two-wall route minting the `?preview_token=` URL for the
      caller's OWN sandbox (no id on the wire, same rule as the session route);
      (b) `mintPreviewUrl` in `codesandbox-boot.ts` (cached per port, re-mints near expiry), injected
      into the provider as `options.previewUrl` — the bare `https://<host>` the port event carries is
      a 401, not a preview;
      (c) **COEP dropped on CodeSandbox builds** (`entry.server.tsx`): `require-corp` exists only for
      WebContainer's SharedArrayBuffer, and under it a cross-origin iframe without a CORP header is
      refused outright — StackBlitz's preview hosts send CORP, `*.csb.app` does NOT (MEASURED:
      ERR_BLOCKED_BY_RESPONSE over a healthy, token-authorized server);
      (d) **already-open ports are REPLAYED into BOTH `onServerReady` and `onPort`** — `onDidPortOpen`
      only reports transitions, so a reload over a running dev server otherwise shows "No preview
      available" forever. Two sweeps (t=0 and t=3s), because `ports.getAll()` answers `[]` in the
      first moments after `connectToSandbox` (MEASURED); and it must feed `onPort`, because THAT is
      the listener that fills `PreviewsStore.previews` — `onServerReady` only broadcasts.
- [x] **3. Lifecycle + persistence — DONE (2026-07-28, plan T1–T5).** Session minting and preview
      tokenization are BUILT (`api.sandbox.session.ts` + `api.sandbox.preview.ts`, verified-user
      wall; `decideSandboxStart` pure + tested, refuse-on-unknown). The 2026-07-27 gaps are closed:
      `sandbox_id` is a per-PROJECT pointer on the project row (the per-user `registry.ts` is
      DELETED); reaping exists — teardown on project delete (`delete-leaves-nothing` pins it),
      `reset` disposes the old VM, the create race converges via compare-and-set with the loser
      disposed, a per-user create rate limit bounds the fork budget, `decideVmCap` hibernates the
      oldest beyond `CODESANDBOX_MAX_RUNNING_VMS` (default 2, never refuses), and a deleted VM falls
      back resume→create ONCE (live-proven: 52s to a fresh VM).
- [~] **4. Cost model — HALF DONE (2026-07-28, T11+T12).** The `sandbox` ledger reason, metering
      sweep and overdraw policy are still unbuilt (bake-into-margin, owner decision 2026-07-27) —
      but the fold-in is no longer invisible: `effectivePackMargin` ASSERTS every pack and plan
      clears `MIN_PACK_MARGIN` with VM overhead on the cost side (`billing/vm-cost.ts`,
      `spec/billing.md`), and per-user VM-hours are MEASURED from append-only lifecycle marks on the
      Admin tab — the number that decides whether metering ever needs to exist. Placeholder
      derivation stays in CREDITS.md §"Sandbox compute"; it accrues **while the user is idle**,
      which is a billing shape nothing in the ledger has today.
- [~] **5. The binary contract gets a network hop.** Every `readBinaryFile` becomes an RTT and
      `FilesStore.refreshFiles` walks the whole tree — the fear was the 3,600 requests/hour cap.
      **MEASURED 2026-07-28: ~26 REST calls in 81 minutes across three creations (~1% of cap)** —
      file traffic rides the Pitcher websocket and the `.codesandbox`/`node_modules` excludes held.
      Egress paths (publish, GitHub sync, deploy) still round-trip bytes through the browser; a
      server-side route remains future work, no longer urgent.
- [~] **6. Flag + A/B.** The flag EXISTS and is deliberately BUILD-time, not runtime:
      `VITE_SANDBOX_PROVIDER=codesandbox` (unset/typo = WebContainer; the runtime's name is not a
      secret, which is the one legitimate `VITE_` prefix). A/B against WebContainers on real usage
      is still owed before cutover — per-user runtime switching was rejected (two lifecycles in one
      session), so the A/B is per-DEPLOY.

One incidental win: dropping WebContainer lets us drop `Cross-Origin-Embedder-Policy: require-corp`
(`app/entry.server.tsx`), which exists only for SharedArrayBuffer and constrains what the app can embed.

## Anti-patterns (reject in review)

- `import ... from '@webcontainer/api'` anywhere outside `app/lib/sandbox/webcontainer-provider.ts`
  and the allow-listed upstream files. **The spec scan will fail — do not add an allow-list entry to
  silence it.**
- `import ... from '@codesandbox/sdk'` outside `codesandbox-provider.ts` and
  `app/lib/.server/sandbox/service.ts`. **Same rule, same scan.** Swapping one lock-in for another is
  not an escape hatch, and a fresh SDK looks harmless right up until it is in twenty files.
- Naming `CODESANDBOX_API_KEY` anywhere outside `.server/`. It is scanned for.
- `sandboxes.create(...)` without `privacy: 'private'`. The vendor default is **public**; a sandbox
  created without it is a user's game readable by anyone who guesses a short id. Scanned for.
- `import { webcontainer } from '~/lib/webcontainer'` outside `app/lib/sandbox/index.ts`. This is the
  subtler bypass: it type-checks, it works, and it never names the package.
- Feature-detecting a capability by probing for a method instead of reading `capabilities`.
- Serializing provider-specific state into snapshots or the working copy.
- UI that assumes zero-latency local FS semantics.
