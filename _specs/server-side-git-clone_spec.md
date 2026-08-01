# Spec for server-side-git-clone

branch: project/feature/server-side-git-clone
design_system: DESIGN.md
spec_impact: yes

## Summary

Route the repo clone/import path through the platform's own GitHub/GitLab identity instead of upstream bolt.diy's browser-side credential flow, and give it the same full-page boot surface every other door into the workspace already has. Today a user who has already connected their GitHub account via OAuth — and whose encrypted token sits in `git_tokens`, service-role only, driving link/push/pull for every project — is nevertheless asked by `window.prompt` for a username and a personal access token when they clone a repo, and that credential is stored in a **plaintext, non-httpOnly `git:<domain>` cookie** and sent as browser Basic auth through `/api/git-proxy`. The platform therefore holds two unrelated GitHub identities, and the one the user explicitly authorized is the one clone cannot see. This feature makes clone a first-class server-side `GitProvider` operation: the server resolves the caller's token, fetches the tree, and streams it to the sandbox, with the client never holding or sending a credential. Public repositories continue to clone with no authentication at all. Alongside it, clone gains a real `bootProgress` phase so the workspace is covered by `BootScreen` while the network work happens, rather than by a generic spinner, and a live binary-corruption defect in one of the two clone entry points is closed.

## Project Spec Alignment (from SPEC.md — REQUIRED)

- **SPEC.md sections this feature relies on or must conform to:**
  - **§4.13 GitHub Sync (two-way project ↔ repo bridge)** — *"The client no longer holds or sends a token… the server resolves the token itself from an encrypted per-user store (`git_tokens`, service-role only); the browser never sees it, and `no-client-token.spec.ts` pins that the route cannot accept one again — behaviourally AND at source level."* The status note already records this feature as owed work: *"Remaining: hardening that per-user token from the connector cookie to a server-side OAuth App."*
  - **§4.5.4b Persistence model — repo-primary** — the link is a TUPLE (`provider` + `linked_repo` + `linked_branch`, all-or-nothing, migration 0006). An import that clones and then records a half-link reproduces the two live bugs that constraint was written to catch.
  - **§4.5.4c Durability — the server working copy** — declares the required `GitProvider` seam: *"oauth/connect, ensureRepo(private), getBranchHead, **fetchTree**, buildCommit (base64 binary blobs), fastForwardPush."* A server-side clone belongs behind that seam, never as a second fetch implementation. Binary byte-identity applies, as on every other file path.
  - **§4.5.3 Authorization — the two walls** — *"every server route that touches a project validates session and project ownership, not merely 'logged in.'"*
  - **§5 Security & Abuse** — *"Every server route that reaches OUT… is a spend path on the OWNER's resources… Authentication lives INSIDE the handler (`denyUnlessVerified`), never in a wrapper option; any caller-influenced fetch URL passes the shared SSRF guard on every redirect hop."* Clone is the first route in the product whose fetch target is a **user-typed URL**.
  - **§4.4a New Project — Entry Points & Routing** — *"THE SPLASH COVERS EVERY DOOR THAT PUTS FILES IN THE WORKSPACE, NOT JUST CREATION… The overlay gate is 'every phase except `idle` and `failed`', asserted over the declared phase union — it was twice written as an enumeration of the known doors and a third door walked past both."*
  - **§4.2.8 Context budget** — the standing rule for every future ingest path: new files are classified before they can reach the model; the default for anything generated, vendored or minified is opaque. A foreign repository is the highest-variance ingest this platform has.
  - **§1.3 principle 10** — binary bytes survive every round-trip; git import is named in the list.
  - **§8 / `sandbox-seam.spec.ts`** — the mount writes go through `SandboxProvider`, default-deny source scan.

- **How this feature fits the existing architecture:** the server-side authenticated fetch already exists and is live-proven — `GitProvider.fetchTree()` (`app/lib/.server/git/provider.ts:200`, implemented at `github.ts:322` and `gitlab.ts:307`) is what repo-primary mount uses to restore a project from its linked repo, logging *"Fetched N files from …@branch"*. It returns a `SerializedFileMap` whose binaries are re-encoded from decoded bytes by `classifyFetchedBlob` (`fetch-decode.ts:52`) precisely so provider base64 wrapping cannot leak downstream. The only thing that path cannot do today is run against a repo the project is not already linked to. **This feature is therefore an extension of an existing seam to a new entry point, not a new subsystem** — the §2.1a-compliant shape.

- **spec_impact = yes** → what will change in SPEC.md and which sections:
  - **§4.13** *(primary)* — import/clone becomes a first-class §4.13 operation beside link/push/pull/divergence: server-side, token resolved from `git_tokens` by the service role, session-walled, SSRF-guarded, size-capped, client never sending a credential. The "Remaining: hardening…" status note is discharged for this path, and the Linking bullet's one-clause *"or by importing an existing repo"* is replaced by a real description.
  - **§4.5.4b** — a new lifecycle fact: the documented lifecycle is UNLINKED → SAVE=LINK → LINKED, and **an imported project is born LINKED**. That is a fourth entry point into the lifecycle and is currently recorded nowhere.
  - **§4.4a** — import becomes a fourth path beside Path A (typed prompt), Path B (registry card) and Path C (guided tour), with its own answers on credits, handoff card and scaffolding (below). The boot-surface change is recorded against the "every door" rule.
  - **§5** — the outbound-route rule names the clone route explicitly, and states the consequence that private/self-hosted hosts are unreachable server-side **by design** (`net/ssrf.ts` refuses private addresses, §4.17 relies on that).
  - **§2.2 / §2.3** — the "hide, don't delete" ledger: upstream's `window.prompt` + `git:<domain>` cookie + Basic-auth path is superseded in the UX, not deleted. §2.2's *"Git clone/import — reused as the AppTemplate template-mounting mechanism"* becomes stale as the whole story.
  - **§10 Open Questions** — candidate entries for Git-LFS on imported repos and private/self-hosted host support.

- **Conflicts with SPEC.md:** none. Nothing forbids a server-side clone; the constraints are SSRF, per-user rate limiting, size caps, and — the tightest — **§4.5.4b/§4.5.5's "the platform stores no project files."** The clone must stream through to the sandbox (or land in the single §4.5.4c working copy); it may never become a server-side cache of cloned repositories, which is exactly the shape migration 0007 deleted. `no-server-storage.spec.ts` is a comment-stripped source scan and will notice a new store.

- **One documented mechanism whose *reason* changes:** §4.4a records that an import is covered by the overlay rather than by `ready` *"because its files replay through the message parser and can only land AFTER the chat renders (a `ready` gate would deadlock the replay it waits for)."* If clone moves from artifact-replay to a direct server fetch + mount, that justification no longer applies to this door. The behaviour may stay the same, but the recorded reason must be updated rather than silently relied upon.

## Functional Requirements

### A. Server-side clone

1. A new authenticated route performs the clone server-side. It takes a repo reference and an optional branch, and returns a `SerializedFileMap` plus the resolved head commit — the same shape `fetchTree` already returns.
2. **Authentication lives inside the handler** — `denyUnlessVerified` (not a `withSecurity` option, whose unenforced `requireAuth` was deleted for making routes *look* protected). `requireOwnedProject` does not apply: at clone time there is no project yet. `requireVerifiedUser` is the correct floor because the route reaches out on the platform's behalf.
3. **The token is resolved server-side, from the caller's session identity only** — `resolveProvider(context, userId, provider)` (`resolve.ts:116`). The route must not accept a token, a username, or a password in its body, on the query string, or in a header. `no-client-token.spec.ts` must be extended to pin this route the same way it pins the sync route: behaviourally *and* by source scan.
4. **A public repository clones with no authentication at all.** An unconnected user cloning a public repo is a supported, silent, first-class path — not a degraded one. Only a repo that actually returns 401/404-for-auth escalates.
5. **When authentication is genuinely required and the user is not connected, the response is a connect prompt, never a credential prompt.** The existing `GitProviderError{kind:'auth', reconnect:true}` shape already drives this in the sync path; clone reuses it. `window.prompt` never appears on this path.
6. **The route never emits a secret.** Including indirectly: the remote URL written into the cloned working tree's git config must not embed a token. (`resolveProvider` returning a live token to the client, an error string echoing it, or a tokenised origin URL are all failures of the same §4.5.4 rule.)
7. **SSRF:** the primary wall is an **origin allow-list** — `github.com` and the operator-configured GitLab host from `getOAuthConfig` — reached by reducing the user's input through `parseRepo()` (`provider.ts:54`) to `owner/repo` so no raw user URL is ever fetched. `assertPublicUrl()` is applied as defense-in-depth on any URL that is fetched, re-run on every redirect hop, per `api.git-proxy.$.ts`'s existing pattern. The residual TOCTOU noted at `ssrf.ts:24-26` is why the allow-list is primary and the DNS guard secondary, not the reverse.
8. **Size caps before the bytes are stored:** the fetched map is measured against `DEFAULT_PROJECT_SOURCE_MAX_MB` (`storage/limits.ts:28`, currently 256) — the same derived ceiling the working copy and remix seed share, so the three cannot drift. Refusal names the size, the limit and the env var. Provider-side ceilings hit first and must surface as errors, not silence: GitHub recursive-tree truncation (`github.ts:340`) and GitLab pagination exhaustion (`gitlab.ts:301`) already throw `GitProviderError{kind:'invalid'}`.
9. **Per-user rate limiting** on the route — egress is the owner's bandwidth, and "verified" is not "unmetered".
10. **Binary byte-identity end to end.** The `fetchTree` → `classifyFetchedBlob` path is already byte-faithful and contract-tested; the requirement is that nothing downstream re-decodes. Files reach the sandbox as `Uint8Array` via `SandboxProvider`, never through a `boltArtifact`.
11. **Secret exclusion reuses the one rule** — `isSecretPath` (`git/sync-logic.ts`), never a second definition.
12. **Ingest classification** — cloned files are classified for opacity before they can reach the model (§4.2.8); generated/vendored/minified default to opaque.

### B. Binary integrity in the existing entry points *(a live defect, closable independently)*

13. **`GitCloneButton.tsx` corrupts binaries today and must stop.** At `:70` it builds a **non-fatal** `new TextDecoder('utf-8')` and at `:80-90` applies it to any file whose extension matches its text allow-list — which includes `.svg`, `.json`, `.xml`, `.md` — even when the content is a `Uint8Array`. Invalid bytes become U+FFFD and the action runner writes that garbage back over the correct bytes on disk. Its sibling `GitUrlImport.client.tsx:60-90` was already fixed, with a comment describing this exact failure, and the two must converge on the fixed behaviour: `isBinaryPath` exclusion plus a **fatal** decoder, binaries excluded from the artifact and left on disk.
14. **`GitCloneButton`'s silent truncation must stop.** `MAX_FILE_SIZE = 100KB` and `MAX_TOTAL_SIZE = 500KB` (`:42-43`) drop files from the artifact with no user-visible consequence beyond a `skippedFiles` list. With the clone's bytes already on disk, the artifact does not need to carry file bodies at all — which is also the §4.2.8-correct shape.

### C. Boot surface

15. **Clone gets a real `bootProgress` phase**, so the workspace is covered by the shared surface from the first moment rather than by `<LoadingOverlay message="Please wait while we clone the repository..." />`. A new phase is automatically covered: `coversWorkspace` (`boot-progress.ts:214`) is *"every phase except `idle` and `failed`"*, asserted over the declared union — the whole point of the 2026-07-31 rewrite, and the reason a fourth door cannot walk past it this time.
16. **Adding the phase means adding it everywhere the union is enumerated:** a new union member with its doc block, and a `bootPhaseCopy` case. `boot-progress.spec.ts:143` ("leaves no phase untested") and `:255` ("gives each phase a distinct title, none of them the idle fallback") scan the union source and fail otherwise — by design.
17. **Progress, where the provider gives it.** `BootScreen.tsx:90-91` draws a progress bar only for `step === 'files'`. If clone reports counts, that condition widens; if it cannot, the phase shows title + detail + the elapsed clock after 5s, exactly like `creating-starter`.
18. **The clone phase narrates the real stages** — resolving the repo, fetching the tree, writing to the workspace — in the manner of creation's `creating-starter` → `creating-workspace` → `creating-mount` → `creating-settle` progression, never a single opaque step for the whole operation.
19. **The workspace is not revealed until the file map stops changing.** Reuse `settleAfterCreation` with `IMPORT_SETTLE_OPTIONS` (`settle.ts:169` — 3s floor / 45s ceiling / 1.5s quiet / `minCount: 1`), never a blind `setTimeout` and never a re-derived copy.
20. **All entry points converge.** `GitCloneButton`, `GitUrlImport.client` (`/git?url=`) and `StarterTemplates.tsx` — which links to `/git?url=…` and was not on any prior list of clone doors — must all reach the same phase and the same code path. `importChat` (`useChatHistory.ts:2428`) remains the single choke point, and `setPendingImport()` continues to arm the import tail.

### D. Project lifecycle for an imported repo

21. **An imported project is born LINKED**, and the link is written as a complete tuple (`provider` + `linked_repo` + `linked_branch`) or not at all.
22. **§4.4b copy-rename-register does not run.** A foreign repository is not AppTemplate-shaped by assumption; scaffolding a GameMode into it would be destructive.
23. **The creation handoff card's "no Build without words" branch applies** — an imported project has no §4.4b brief and no scaffolded class, so `creation_handoff` is either null or carries only the user's own words.
24. **Credits — DECIDED (owner, 2026-07-31): every project creation carries the base charge, through every door.** Clone a repo, import from disk, a typed prompt, a registry card, the guided tour — each one provisions a WebContainer session or a CodeSandbox VM, and the platform pays for that regardless of how the project was started. `PROJECT_CREATE_CREDITS` (ledger reason `project_create`, `DEFAULT_PROJECT_CREATE_CREDITS = 100`) is therefore charged on **all** of them, quoted before the row exists and debited after it, never going negative, refusing at 402 with zero project rows and zero ledger rows written.

25. **🔴 That rule is currently true on one sandbox provider and silently false on the other, and the flag deciding it is not a billing flag.** `openImportWorkspace` (`registry/import-project.ts:71`) early-returns when `alreadyBooted || !SANDBOX_REQUIRES_PROJECT`, and `SANDBOX_REQUIRES_PROJECT = SANDBOX_PROVIDER === 'codesandbox'` (`sandbox/index.ts:79`). So:
    - On **CodeSandbox**, an import calls `createProject()` → `POST /api/projects` → `quoteProjectCreate` → `debitProjectCreate`. It already charges correctly.
    - On **WebContainer** — still the default, since `VITE_SANDBOX_PROVIDER=codesandbox` is opt-in — an import registers **no project row and takes no charge at all**.

    The condition is a *runtime capability* question ("does this sandbox need a project id to boot?") being used to answer a *money* question ("did we provision a workspace for this user?"). Those are different questions and must stop sharing an expression. A door that provisions a workspace charges for it on both providers; the only legitimate exemption is `alreadyBooted` — an import **into a project the user already has open** writes into a workspace that was already paid for, and charging again would bill twice for one VM.

26. **The charge is quoted before anything is provisioned.** Ordering is load-bearing and already established by `POST /api/projects`: quote → 402-and-stop, or row → debit → rollback the row if the debit throws. A clone that boots a sandbox and *then* discovers the user cannot afford it has already spent the money it was checking for. `rollbackRegisteredProject` remains fire-and-forget and is **not** where a refund may live — it never rejects, so a refund placed there can silently not happen.

## Design System Reference

No `DESIGN.md` design system found — follow the existing UI conventions already in the codebase. The relevant conventions this feature must match:

- **`BootScreen` / `BootStatusPanel`** (`app/components/chat/BootScreen.tsx`) is the shared surface; clone renders through it, never a bespoke panel. `BootScreen` is the in-flow full-page variant (`ready === false`); `WorkspaceSplash` is the `fixed inset-0 z-50` overlay gated on `shouldCoverWorkspace`.
- **`bootPhaseCopy`** (`boot-progress.ts:238-338`) is the single copy table — every phase's title and detail live there, not in a component.
- **The elapsed clock** rides at the end of the detail line, tabular figures, after 5s — never on its own line (§4.4a: alone at the bottom it was the only moving thing on screen, i.e. the least important number drawing the eye).
- **A fixed overlay does not move with body padding** — `body.sidebar-docked` needs its `left: var(--sidebar-dock-width)` rule or the panel centres on the viewport while the in-flow variant centres in the content column.
- **The toolbar shape constant** (`app/components/header/toolbar-button.ts`) governs any header affordance; fill is reserved for the git chip and the ⋯ menu only.
- **Failure is loud** — `reportBootFailure` + the `failed` phase's retry affordance, in the manner of the network-kill path already verified for GitHub sync.

## Possible Edge Cases

- A **public** repo cloned by a user with no connection at all — must work silently, no prompt.
- A **private** repo cloned by a user who is connected — the whole point; must never prompt.
- A private repo cloned by a user who is **not** connected — a connect prompt, not a credential prompt; and after connecting, the clone resumes rather than restarting from the dashboard.
- A repo the connected user genuinely **lacks access to** — 404-shaped, not a credential retry loop.
- A **self-hosted or private-network** git host — unreachable server-side by design (`net/ssrf.ts` refuses private addresses so the platform can never reach the user's machine). This must be stated to the user as a product boundary, not surfaced as a mysterious failure.
- A repo containing **submodules** — a GitHub tree records only a gitlink (mode `160000`) and WebContainers cannot run `git submodule`; §4.4's template path already vendors gitlinks generically, and an imported repo inherits the same problem.
- A repo containing **Git-LFS pointers** — §4.5.4c declares LFS out of scope v1 for the save path; an import would fetch pointer text, not content. Must fail informatively rather than produce a project full of 130-byte text files.
- A repo **larger than the source cap**, and one large enough to truncate the provider's recursive tree — two different failures, both loud.
- A repo with **no commits** on the branch — `fetchTree` returns `null`; distinct from "could not ask", per §4.5.4b deviation 4's `undefined` vs `null` rule.
- A `.env` or other secret file **in the source repo** — `isSecretPath` governs.
- **Clone from inside an already-open project** — `useGit.spec.ts:198` pins that this acquires and deletes nothing; the new path must preserve that, and `useGit.spec.ts:217` pins that a network retry does not delete the project the first attempt created.
- **Rollback** — `useGit.spec.ts` pins rollback exactly once on 404 and on refused credentials, with the failure still propagating. Server-side clone must keep those properties.
- A **binary-heavy** repo — the case requirement 13 exists for; a `.svg` that is actually gzipped, or a `.json` with invalid UTF-8, must survive byte-identical.
- The **legacy cookie** — a user with a stale `git:<domain>` cookie from the old flow. Decide whether it is ignored or actively cleared; leaving a plaintext credential in the browser after superseding the flow that created it is its own small defect.

## Acceptance Criteria

1. A connected user clones a **private** repo with **zero** credential prompts, and no `git:*` cookie is written.
2. An unconnected user clones a **public** repo successfully, with zero prompts.
3. An unconnected user cloning a **private** repo is offered a **connect** flow, and no `window.prompt` appears anywhere on the path.
4. The clone route rejects an unauthenticated request with 401 and **zero outbound fetch** (the `outbound-auth.spec.ts` shape).
5. The clone route refuses a token supplied in the body/query/header, pinned behaviourally **and** by source scan in `no-client-token.spec.ts`.
6. A repo URL pointing at a private/loopback address is refused before any fetch, and the refusal survives a redirect to such an address.
7. A repo exceeding `DEFAULT_PROJECT_SOURCE_MAX_MB` is refused with a message naming the size, the limit, and the env var — before the bytes are stored anywhere.
8. **Binary byte-identity:** a repo containing a `.wasm`, a `.png`, an `.ico` and a **`.svg` that is not valid UTF-8** clones with every file sha256-identical to the source. (The 2 MB `havok.wasm` case is already the live-verified benchmark for the push direction.)
9. No file is silently dropped from a clone; anything excluded from the artifact is nevertheless present and correct on disk.
10. From the moment the user confirms the clone until the file map has settled, the workspace is **continuously covered** by the boot surface — zero samples of file growth uncovered, and no toggle of the cover in between (the `coverToggles: 2` measurement shape from the 2026-07-31 verification).
11. The clone phase is a member of the declared phase union, has distinct copy in `bootPhaseCopy`, and `boot-progress.spec.ts`'s union scans pass without an allow-list entry.
12. All three entry points — clone button, `/git?url=`, starter templates — reach the same phase and the same code path.
13. An imported project's link tuple is complete or absent; never half-written.
14. `sandbox-seam.spec.ts` and `no-server-storage.spec.ts` still pass — no new WebContainer coupling, no new server-side project file store.
15. The existing `useGit.spec.ts` rollback and retry properties still hold.
16. **Every door that provisions a workspace debits `PROJECT_CREATE_CREDITS` exactly once, on both sandbox providers** — clone, `/git?url=`, starter template, folder import, typed prompt, registry card, guided tour. Asserted against the provider flag being flipped, since today's behaviour differs between the two.
17. **An import into an already-open project charges nothing** — that workspace was already paid for, and a second debit bills twice for one VM.
18. A user who cannot afford the charge gets a 402 naming the price, with **zero project rows and zero ledger rows written, and no sandbox provisioned** — the quote precedes provisioning, not the other way round.

## Open Questions

1. ~~Does an import charge `PROJECT_CREATE_CREDITS`?~~ **DECIDED (owner, 2026-07-31): yes — every project creation, through every door.** See Functional Requirements 24–26. The follow-on question, which is a scoping call rather than a policy one: **is closing the WebContainer no-charge gap part of this feature, or its own?** It is a pre-existing revenue leak on the default provider that this spec merely discovered, it affects folder import as much as git clone, and it is a one-branch fix in `openImportWorkspace` — argues for its own small task, landed first.
2. **Does `useGit` / isomorphic-git remain at all?** Two shapes: (a) server-side `fetchTree` becomes the only clone path and the isomorphic-git client path is hidden-not-deleted per §2.1a; (b) isomorphic-git stays for unauthenticated public clones and the server path handles authenticated ones. (a) is simpler and removes the `/api/git-proxy` dependency from the user-facing import path; (b) keeps a fallback for hosts the seam does not implement. Recommend (a).
3. **Is the arbitrary-URL clone a `GitProvider` seam addition or a route-level concern?** Resolving a user-typed reference to `owner/repo` + default branch is a genuine new capability. §4.5.4c deviation 1 warns that *"a seam that encodes one vendor's call shape is not an abstraction"* — so if it joins the seam it must be expressible for both providers.
4. **Non-GitHub/GitLab hosts** (Bitbucket, Codeberg, self-hosted Gitea): out of scope for v1, but the refusal message should say so rather than fail generically. Note the SSRF guard makes private-network hosts permanently out of scope, not merely unimplemented.
5. **Git-LFS and repo-size policy for imported repos** — §4.5.4c declares LFS out of scope v1 for the save direction only.
6. **The stale `git:<domain>` cookie** — ignore, or clear on next clone?
7. **Does the import still replay files through the message parser at all?** If not, §4.4a's stated reason for the overlay-not-`ready` gate no longer applies to this door and must be rewritten.

## Testing Guidelines

Tests live beside the code they exercise, never in `app/routes/` — a spec file there is compiled as a route and 500s every request. Meaningful cases, without going heavy:

- **Route auth** (`outbound-auth.spec.ts` shape): unauthenticated → 401 with **zero** outbound fetch; a body-supplied token → refused; source scan for `denyUnlessVerified` in the handler.
- **`no-client-token.spec.ts`** — extend to cover the clone route, behaviourally and at source level.
- **SSRF** (`net/ssrf.spec.ts` shape): private/loopback targets refused pre-fetch; refusal re-applied per redirect hop; the origin allow-list is primary.
- **Binary byte-identity** (`binary-files.spec.ts` shape): a fixture repo containing `.wasm`, `.png`, `.ico` and an invalid-UTF-8 `.svg` round-trips sha256-identical. Include a **control** proving the assertion can fail — the fatal-vs-non-fatal decoder distinction is invisible without one.
- **Size caps**: at the cap, one byte over, and provider-truncation — each a distinct, loud failure; the refusal names the env var.
- **`boot-progress.spec.ts`**: the new phase joins every union scan; distinct copy; covered by `coversWorkspace`; not an `isCreationPhase`.
- **Settle**: the clone path uses `IMPORT_SETTLE_OPTIONS` and honours floor, ceiling and `minCount` (mutation check: dropping the floor should fail; dropping the ceiling should hang, which is what it prevents).
- **Provider contract** (`git-provider-contract.spec.ts` + `fake-servers.ts`): any new seam member is implemented and tested for **both** GitHub and GitLab, against the fake servers.
- **Entry-point convergence**: a source scan asserting all three doors call the one clone path — default-deny, **with a control proving the scanner still matches**, per the `no-server-storage.spec.ts` lesson that a scan which silently matches nothing reports a clean bill of health forever.
- **Regression**: `useGit.spec.ts`'s rollback-exactly-once and retry-does-not-delete properties survive whatever happens to `useGit`.

A live drive is owed before this can be called done, in the manner of the 2026-07-18 GitHub verification: a real private repo cloned by a connected account, a real public repo cloned by an unconnected one, binaries sha256-compared against github.com, and the boot surface observed continuously covering the workspace. "Correct by construction" is the state the MCP relay was in before live testing found three defects in it.
