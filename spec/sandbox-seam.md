# spec/sandbox-seam.md — The Sandbox Seam (governs SPEC §1.3.5, §8)

> **Status: the seam is BUILT (2026-07-26).** `SandboxProvider` exists, every runtime store is
> constructed with one, and a default-deny source scan keeps it that way. WebContainer is now *a*
> provider rather than *the* runtime. What is NOT built is a second provider — that is the next step,
> and it is now a bounded piece of work rather than a refactor of the whole app.

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

## Swap plan (next step)

Target: a server-container provider. The market matured since this file was first written —
Cloudflare Sandbox bills **active CPU only** (~$0.00002/vCPU-s), which suits a builder session that
is mostly idle with bursts of `npm install` / Vite rebuild, where provisioned-memory billing
(Vercel) punishes the idle time. E2B and Daytona sit at ~$0.0504/vCPU-hr. Self-hosted Firecracker on
the Lightsail box remains the maximum-control option.

1. Implement `SandboxProvider` against the chosen vendor; boot from a prebuilt image (starter +
   `node_modules` preinstalled).
2. Proxy the dev-server preview URL into the iframe. Preview URLs must stay unguessable and die with
   the sandbox (same posture as today).
3. Lifecycle: lazy create on builder open, hibernate ~10min idle, destroy ~60min. `teardown()` is
   already on the interface for this.
4. **Cost model changes.** SPEC §7's "user project compute: ~$0" stops being true. Fold a
   `SANDBOX_RATE` term into the credit formula — and note it accrues **while the user is idle**,
   which is a different billing shape from anything in the ledger today (`spec/billing.md`).
5. **The binary contract gets a network hop.** `spec/binary-files.md` makes the sandbox FS the source
   of truth for binary bytes, read back on demand. Every one of those reads becomes an RTT, and
   `FilesStore.refreshFiles` walks the whole tree. Egress paths (publish, GitHub sync, deploy)
   probably want a server-side route where bytes never round-trip through the browser at all.
6. Ship behind a per-user/per-env flag; A/B against WebContainers before cutover.

One incidental win: dropping WebContainer lets us drop `Cross-Origin-Embedder-Policy: require-corp`
(`app/entry.server.tsx`), which exists only for SharedArrayBuffer and constrains what the app can embed.

## Anti-patterns (reject in review)

- `import ... from '@webcontainer/api'` anywhere outside `app/lib/sandbox/webcontainer-provider.ts`
  and the allow-listed upstream files. **The spec scan will fail — do not add an allow-list entry to
  silence it.**
- `import { webcontainer } from '~/lib/webcontainer'` outside `app/lib/sandbox/index.ts`. This is the
  subtler bypass: it type-checks, it works, and it never names the package.
- Feature-detecting a capability by probing for a method instead of reading `capabilities`.
- Serializing provider-specific state into snapshots or the working copy.
- UI that assumes zero-latency local FS semantics.
