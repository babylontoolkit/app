# spec/sandbox-seam.md — The Sandbox Seam (governs SPEC §1.3.5, §8)

> **Status: the seam is BUILT (2026-07-26), and the SECOND PROVIDER now exists (2026-07-26).**
> `SandboxProvider` exists, every runtime store is constructed with one, and a default-deny source
> scan keeps it that way — now for **both** vendors. `codesandbox-provider.ts` implements the
> interface against Together CodeSandbox (`spec/sandbox-codesandbox.md`), with the server half in
> `app/lib/.server/sandbox/`. What is NOT done is the CUTOVER: nothing constructs it yet, because
> `index.ts` still boots WebContainer. Routes, a `sandbox_id` on the project record, and the billing
> term are the remaining work — see §"Swap plan".
>
> The escape hatch is no longer a paragraph. It is a file with 61 tests behind it.

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
- `teardown()` — unused by app code today (a WebContainer dies with the tab) but in the contract,
  because a server provider bills for whatever it does not reap.
- `capabilities: { terminal, textSearch, watch }` — so the UI degrades instead of throwing.

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
2. **`shell.ts` spawns `/bin/jsh`** with `--osc` and parses WebContainer's OSC escape sequences to
   detect an interactive prompt. A server provider gives you a real PTY and this shim becomes
   simpler, not harder — but it is provider-specific today.
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
- [ ] **3. Lifecycle + persistence.** A `sandbox_id` on the project record, two-wall routes for
      session minting and resume, and reaping on project delete. `decideSandboxStart` (pure, tested)
      already encodes the dangerous half.
- [ ] **4. Cost model.** SPEC §7's "user project compute: ~$0" stops being true. A `sandbox` ledger
      reason, a metering sweep, an overdraw policy, and a re-run of `packMargin()`. It accrues
      **while the user is idle**, which is a billing shape nothing in the ledger has today.
- [ ] **5. The binary contract gets a network hop.** Every `readBinaryFile` becomes an RTT and
      `FilesStore.refreshFiles` walks the whole tree — against a MEASURED 3,600 requests/hour cap on
      the free plan. Egress paths (publish, GitHub sync, deploy) want a server-side route where bytes
      never round-trip through the browser at all.
- [ ] **6. Flag + A/B.** Per-user/per-env, against WebContainers, before cutover.

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
