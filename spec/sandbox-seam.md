# spec/sandbox-seam.md — Sandbox Seam Rule & Swap Plan (governs SPEC §1.3.5, §8)

## The standing rule

**No new WebContainer-specific coupling outside bolt.diy's existing runtime layer.** All new code that needs to touch the sandbox (templates mount, action executor, preview URL, build-for-share, restore-from-snapshot) goes through the runtime abstraction, never imports `@webcontainer/api` directly. This is a code-review checklist item; CLAUDE.md repeats it as a never-violate rule.

Why: (a) StackBlitz licensing is negotiated and could become unacceptable at scale; (b) WebContainer limits (install speed, memory next to a Babylon scene) may hurt UX. Either triggers the swap. The rule keeps the swap a bounded refactor and is management's negotiating leverage.

## Seam surface (what the abstraction must cover)

- `mount(fileTree)` / `writeFiles` / `readFile` / file events
- `exec(allowlistedCommand)` with streamed output (install/dev/build)
- `previewUrl` (event/promise when the dev server is up)
- teardown / remount (checkpoint restore path)
- capability flags (e.g., `supportsTerminal`) so UI degrades gracefully

Where bolt.diy's existing abstraction already covers a need, use it; where our features (templates, restore, share-build) need more, extend the abstraction — never bypass it.

## Swap plan (if triggered)

Target: **E2B** (or self-hosted Firecracker/Docker) server containers.
1. Implement the seam against E2B: create sandbox from a prebuilt template image (starter + node_modules preinstalled), proxy the dev-server preview URL into the iframe, stream exec output over the existing channel.
2. Preview auth: E2B preview URLs are unguessable + die with the sandbox (same posture as today).
3. Lifecycle: lazy create on builder open; hibernate ~10min idle; destroy ~60min; resume = template image + snapshot overlay (mirrors SPEC snapshot policy).
4. Cost shifts from ~$0 to per-session compute → fold `SANDBOX_RATE` into the credit formula (spec/billing.md leaves the term ready).
5. Ship behind a per-user/per-env flag; A/B against WebContainers before cutover.

## Anti-patterns (reject in review)

- `import { WebContainer } ...` in any `app/lib/.server/**` or feature module we author
- Serializing WebContainer-specific state into snapshots
- UI assuming zero-latency local FS semantics (server sandboxes have RTT)
