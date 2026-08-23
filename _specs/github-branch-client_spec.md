# Spec for github-branch-client

branch: project/feature/github-branch-client
design_system: DESIGN.md
spec_impact: yes

> 🔴 **SPEC.md §4.13's "sync bridge, not a git client" posture is SUPERSEDED BY OWNER DECISION
> (2026-08-21).** Verbatim: *"the no git client thing has changed… we are now relying on the git repo
> as the primary long term storage and sharable project repo. We now need full git client functions
> like creating and switching to branches."* The rule it replaces read: *"Deliberately a **sync bridge,
> not a git client** — the platform tracks exactly ONE linked repo+branch per project; branching,
> rebasing, merging, and PRs happen in the user's own git tooling."*
>
> **The reason it stopped being true is recorded in SPEC.md itself.** That sentence was written while
> §4.13 was an optional bridge. §4.5.4b then promoted it — *"this is no longer a bridge, it is the
> storage backbone"* — and §4.5.4c made the repository the project's permanent, shareable home. A
> posture premised on the repo being a convenience does not survive the repo becoming the product's
> only durable copy: **you cannot tell someone their code lives in git and then withhold git.**
>
> The supersession is still narrower than "we are a git client now", and *Project Spec Alignment ›
> Conflicts* states the exact boundary — three of that sentence's four nouns survive intact.

## Summary

Turn the project↔repo bridge into a **working git client for the one workflow the product actually
needs**: cut a feature branch off what you are looking at, vibe-code into it, and then either **throw
all of it away** and get back to a known-good tree, or **commit it to the branch you chose** and open
the provider's own web UI to raise the pull request. Today the platform tracks exactly one linked
repo + branch per project, the branch is a free-text `useState('main')` in one dialog, there is no way
to see what branches exist, no way to move between them, and no way to abandon a bad session other than
undoing generations one at a time through §4.12 local checkpoints. The result is that the moment a
build goes wrong, the user's only real options are to keep editing forwards or to lose the project's
correspondence with its repository — which is precisely the situation branches exist to prevent.

The feature is built as an **extension of the existing `GitProvider` seam and the existing project↔repo
route**, not as a new subsystem: four new seam methods (`listBranches`, `createBranch`, `deleteBranch`,
`listCommits`), seven new ops on `POST /api/projects/:id/github`, and a new group inside the header's
existing `GitStatusChip` menu. Alongside branch management it carries the two surfaces that make a
branch workflow usable rather than merely possible — **a pre-commit diff** (*what am I about to push?*)
and **branch history** — both decided in scope by the owner on 2026-08-21. Nothing about the storage model changes — one linked branch per project remains
true at any instant; what changes is that the user can *choose which one*, and that choosing is a
first-class, checkpointed, loudly-failing operation rather than a text field.

Three things stay off the platform on purpose: **merging, rebasing, and pull requests**. Those are the
half of §4.13's rule that this feature actively preserves — "Open a pull request" is a link to the
provider, not a feature we implement. A fourth, **resetting to an arbitrary historical commit**, is
excluded deliberately and with its reason written down, because it is one line of JSX away from the
history list and is a bigger gun than Discard.

## Project Spec Alignment (from SPEC.md — REQUIRED)

### SPEC.md sections this feature relies on or must conform to

- **§4.13 GitHub Sync (two-way project ↔ repo bridge) — AVAILABLE TO ALL USERS.** The whole feature
  lives here. Binding rules inherited unchanged: *"Fast-forward only: if the remote branch head ≠
  `last_synced_commit_sha`, push is refused → divergence flow"*; *"the platform NEVER merges"*;
  *"Manual 'Commit changes' only (the header git chip). **No auto-push**"*; *"`.env`-family excluded
  from every push"*; *"Pull ALWAYS checkpoints current platform state first (§4.12)."*
- **§4.13a Import / Clone — the fifth operation.** Its hard-won ingest rule governs every new read this
  feature adds: *"the rule is ONE exported function called by both callers… placed inside the route's
  shared `pull` helper rather than on `op === 'pull'`, because `op: 'resolve' { choice:
  'pull-overwrite' }` is a **second door onto the same read** and a membership list of 'the ops that
  pull' is the `coversWorkspace` mistake."* Branch-switch and discard are the **third and fourth**
  doors onto that read.
- **§4.5.4b Persistence model — repo-primary.** The link is a TUPLE (`provider` + `linked_repo` +
  `linked_branch`, all-or-nothing, migration 0006 `projects_link_complete_check`); LINKED ≠ SYNCED;
  *"NOTHING PUSHES TO THE USER'S REPOSITORY WITHOUT THEM PRESSING A BUTTON"*; the restore rules
  (`planRestore`, required `protect`, an empty incoming map deletes nothing).
- **§4.5.4c Durability — the server working copy.** Exactly ONE working copy per project, a
  crash-recovery buffer and never a history; `unsavedWork = localSeq > syncedSeq`. 🔴 Invariant 4 is
  the binding one here: *"**Written on the same trigger as a local checkpoint, and every trigger writes
  BOTH.** One concept, one moment. A second, independent 'when do we save' rule is how two writers end
  up disagreeing."* A branch switch and a discard are both moments the files change, so both owe **both
  copies**. ⚠️ And the working copy is **keyed per project and carries no branch at all**, which makes
  it stale-by-branch the instant a switch lands — see Open Question 8, the sharpest unresolved hazard
  in this spec.
- **§4.12 Generation Controls & Project History.** The undo the product sells to non-developers.
  🔴 **§4.12 already names this feature, by name**: the creation checkpoint
  (`CREATION_CHECKPOINT_LABEL`, `'Project created'`) is described as *"the one state a user can always
  be returned to and the anchor a **"discard my changes"** is measured against."* The section also
  binds the rest of it: *"the restore **is itself checkpointed** … so history stays append-only and the
  undo can always be undone. **Nothing is ever destroyed.**"* Checkpoints are LOCAL
  (`local-snapshots.ts`, IndexedDB, `MAX_CHECKPOINTS_PER_PROJECT = 20`, ordered by monotonic `seq`,
  never by timestamp).
- **§4.5.3 Authorization — the two walls.** Every new op is `requireVerifiedUser` +
  `requireOwnedProject`, and reports **404, not 403**, for someone else's project.
- **§4.6.1 Pro vs credits split.** *"GitHub Sync and Export are both available to every user, always."*
  Every control in this feature is **ungated**. No entitlement check anywhere, no credit charge.
- **§4.1a The builder toolbar.** One shared button style; fill reserved for exactly two controls (the
  git chip and ⋯); `modal={false}` on every header dropdown; *"an action that more than one surface can
  trigger is a HOOK, not a button"*; and the governing precedent — *"**A name collision between
  siblings is usually a missing parent.** The chip shows the state and opens a menu holding every
  action on it."*
- **§5 Security & Abuse.** Authentication inside the handler; the client never holds or sends a git
  token (`no-client-token.spec.ts`, behavioural **and** source-level); no caller-supplied URL is ever
  fetched.
- **§1.3 principle 10 / `spec/binary-files.md`.** Every tree this feature moves carries binaries as
  bytes losslessly, and never through a `boltArtifact`.
- **`spec/fail-loud.md`.** A failed switch, create or discard must name its cause and never report
  false success. ⚠️ Branch ops are **free** (§4.13: *"sync operations are free (no LLM involved); only
  generations bill"*), so this document's *money* rules do not bind — its **posture** rules do, and
  three bind hard: *"**A best-effort step that cannot fail the request must still REPORT**"*;
  *"**A guard is only real if a test fails when it is removed.** Mutation-verify."*; and
  *"**The provider's word is not evidence** — deliverables are judged from what we measured"* (a 200
  from the refs API is not proof the branch exists). Its closing checklist is the right lens: *"ask what
  the silent version of this feature failing would look like — then make that version impossible to ship
  quietly."* Here those are **a discard that reports success and left files behind**, **a switch that
  half-writes the tuple**, and **a commit that "succeeded" against a head the project never read**.
  The direct precedents are §4.5.4c's *"a failed save is LOUD"* and §4.13's live-verified network-kill
  result: *"badge stayed 'Not synced' with the error surfaced + a 'Try again' affordance, no false
  success."*
- **`spec/spend-holes.md`.** Every new outbound git op is a route that reaches out on the platform's
  behalf and lands under this document's wall.
- ⚠️ **There is no `spec/git.md` / `spec/github.md`.** §4.13 is the only §4-level area of this size
  with no sub-spec. If this feature lands at the scope described here, that gap is worth closing in the
  same PR.

### How this feature fits the existing architecture

It is an extension of a live seam to new operations — the §2.1a-compliant shape, the same one
§4.13a's clone took. Concretely, **most of the machinery already exists and is already tested**:

- `GitProvider` (`app/lib/.server/git/provider.ts`) already carries `getDefaultBranch`,
  `getBranchHead`, `fetchTree` and `fastForwardPush`, with a `git-provider-contract.spec.ts` that runs
  **one suite against both adapters** and content-addressed fakes in `fake-servers.ts`.
- `FastForwardPushInput` already declares **`createBranchIfMissing`**, implemented on both adapters
  (`github.ts` `createRef`, `gitlab.ts`) — and, today, **passed by no caller at all**. Branch creation
  is therefore already reachable through the seam; what is missing is a caller and a name the user
  chose.
- `divergenceBranchName` + `choice: 'push-to-new-branch'` already create a branch as the divergence
  escape hatch. That path is this feature's ancestor and, as noted below, its first bug.
- The shared `pull()` helper already does the whole read half of a branch switch: `fetchTree` →
  `assertFetchedTreeUsable` → move `lastSyncedCommitSha` → return the map.
- `planRestore` + `protectForRepoRestore` + `restoreFiles` already do the whole write half, and
  `ensureProjectRunnable` already installs and starts a project after its files land — the mechanism
  a switch reuses rather than re-derives (requirement 22). ⚠️ `decideDependencyInstall` also exists and
  is deliberately **not** used on this path; requirement 23 records why, so it is not adopted later as
  an obvious optimisation.

So the new code is small and the new *decisions* are the deliverable: what a switch does to unsaved
work, what a create does to the sync pointer, and what a discard is allowed to delete.

### spec_impact = yes → what will change in SPEC.md and which sections

1. **§4.13 (primary) — the "sync bridge, not a git client" sentence is rewritten**, narrowly:
   branching moves onto the platform; rebasing, merging and pull requests explicitly stay in the user's
   own tooling and on the provider's website. The "Linking" bullet gains a **third** way a project's
   link changes (Save, Import, and now **Switch**), and the note that a project still tracks exactly one
   branch *at a time* is preserved as the storage invariant it actually is.
2. **§4.13 — a new sub-section §4.13b "The git client: branches, discard, review, history"**, recording
   the ten operations, the ordering rules that fail silently, and the deliberate exclusions. ⚠️ At this
   scope §4.13 is the largest §4-level area with **no sub-spec**; `spec/git.md` should be created in the
   same PR rather than growing §4.13 by another screen.
3. **§4.5.4b — the LINKED lifecycle gains a branch axis.** The recorded lifecycle (UNLINKED → SAVE =
   LINK → LINKED, plus §4.13a's born-LINKED import) says nothing about the linked branch ever
   changing. It now can, under user control, and the tuple stays complete across the change.
4. **§4.12 — Discard joins the list of operations that checkpoint before acting**, beside Pull. It is
   the first operation in the product whose *entire purpose* is destruction, so its checkpoint is not a
   courtesy, it is the feature's safety contract.
5. **§4.1a — the git chip's menu inventory is extended** (current branch, Switch, New branch, Review
   changes, History, Open a pull request, Discard, Delete a branch) and the "no new toolbar button"
   reasoning is restated for the branch controls, which are the most obvious candidate for a second
   sibling since the four-controls-became-one fix. The record also notes that the group has reached the
   size at which the ⋯ menu's own anti-appending rule starts to apply to the chip.
6. **§4.5.4b — the reason the posture changed is recorded, not just the change.** The repo is the
   primary long-term storage and the shareable artifact (owner, 2026-08-21), which is what makes
   withholding branches untenable rather than merely conservative.
7. **§10 Open Questions** — candidates for branch deletion, remote-branch pruning, and whether a
   project should be allowed to hold more than one sandbox per branch.

### Conflicts with SPEC.md

**One, and it is RESOLVED — superseded by owner decision, 2026-08-21** (see the header note). It is
recorded here rather than silently overridden, because the sentence being replaced was a deliberate
prior decision and a future reader must be able to see that it was retired on purpose, by whom, and
how far.

> §4.13, superseded: *"Deliberately a **sync bridge, not a git client** — the platform tracks exactly
> ONE linked repo+branch per project; branching, rebasing, merging, and PRs happen in the user's own
> git tooling."*

**Scope of the supersession — three of the four nouns survive:**

| Noun in the rule | After this feature |
|---|---|
| **branching** | 🔴 **Moves onto the platform.** This is the superseded clause. |
| rebasing | Unchanged — never on the platform. |
| merging | Unchanged — *"the platform NEVER merges"* remains absolute, including for branches. |
| PRs | Unchanged — raised on github.com/gitlab.com. This feature adds a *link*, not an implementation. |

And the clause the sentence opens with — *"the platform tracks exactly ONE linked repo+branch per
project"* — **remains true as a storage invariant.** At any instant a project has exactly one
`linked_branch`; the change is that the user can now choose which one, instead of it being whatever was
typed into a text box at link time. The row shape, the tuple constraint and the fast-forward rule are
all untouched.

**Why the decision is right, in the terms the rule itself used.** §4.13 justifies the
sync-bridge posture with the graduate path: *"create/vibe-code on the platform → real engineering in
local git → sync back."* That reasoning assumes the risky work happens in local git, where branches
already exist. But the product's own most expensive and least reversible operation — a build turn that
rewrites the landing page, the chrome and the game script in one artifact — happens **on the platform**,
and the platform gives it no branch to happen in. The one place the safety net is missing is the one
place the danger was moved to. The brief names exactly that: *"vibe code out a feature, if things go
bad, discard all changes."*

⚠️ **And the owner's stated reason widens the stakes beyond convenience.** *"Primary long term storage
and sharable project repo"* means a branch is not a power-user nicety here — it is the unit in which
work is kept and handed to someone else. That raises the cost of every silent failure in this spec by
one level: a half-written tuple or a discard that leaves files behind does not spoil a session, it
corrupts the correspondence between a project and its only durable copy.

**Nothing else conflicts.** No section forbids a branch operation; the constraints that bind are the
ordering and safety rules catalogued above, all of which this spec adopts rather than works around.

### Two live defects this feature must resolve rather than inherit

1. 🔴 **`push-to-new-branch` creates a branch and leaves the project pointing at the old one.** In
   `app/routes/api.projects.$projectId.github.ts`, the `resolve` handler pushes to
   `divergenceBranchName(...)` and returns `{ ok: true, branch, commitSha }` — with **no
   `projects.update`**. So the project's `linked_branch` still names the branch it just escaped, and
   `lastSyncedCommitSha` still names a commit on it. The user is told *"Saved your changes to a new
   branch: platform/2026-08-21"* and the next push aims somewhere else. Once branches are a first-class
   concept this stops being an obscure edge and becomes the ordinary way people end up on a new branch.
2. 🔴 **Not recording the head of a tree you just read manufactures a permanent divergence.** The
   `link` op carries a long comment recording this exact bug, measured live on 2026-08-03: a
   freshly-cloned project mounted as `diverged` against the very commit it was cloned from, because
   `selectMountSource` computes `remoteMoved = remoteHead !== lastSyncedCommitSha`. A branch switch
   reads a tree at a known head and is therefore the same trap with a new name. The consequences are
   the ones already recorded there — a choice between two byte-identical versions, a full restore that
   rewrites `vite.config.ts`, and a Vite restart.

## Functional Requirements

### A. The provider seam — four new operations, on both adapters

1. **`listBranches(ref: Pick<RepoRef,'owner'|'repo'>)`** returns every branch with its head sha and
   which one is the repository default. It takes the **coordinate, not a `RepoRef`** — asking for a
   branch in order to list the branches is the contradiction `getDefaultBranch`'s doc comment already
   calls out.
2. **`createBranch(ref: Pick<RepoRef,'owner'|'repo'>, name: string, fromSha: string)`** creates the ref
   and returns its head. A name that already exists raises `GitProviderError{ kind: 'name-taken' }` —
   the existing kind, reused, because the caller's recovery ("pick another name") is identical to
   `ensureRepo`'s.
3. **Absent is `null`, never a throw**, for the read (`listBranches` on a repository with no commits
   returns an empty list, not an error) — the `getBranchHead` rule, for its stated reason: a caller must
   be able to tell "there is nothing there" from "we could not ask".
4. **Both adapters, one contract suite.** Every new method is implemented in `github.ts` (Octokit Git
   Data API: `git.listMatchingRefs` / `git.createRef`) **and** `gitlab.ts` (`/api/v4` branches), added to
   `git-provider-contract.spec.ts` (which asserts on serialized request bodies, not just responses), and
   supported in `fake-servers.ts`. A seam method that exists on one adapter is the
   `setPreviewScript`-wired-to-one-provider defect in a new place.
5. **`createBranch` never force-updates an existing ref.** The platform does not force-push; a create
   that silently moved someone's branch would be a force-push wearing a friendlier verb.
6. **`deleteBranch(ref: Pick<RepoRef,'owner'|'repo'>, name: string)`** deletes the ref (GitHub
   `git.deleteRef`, GitLab `DELETE /branches/:name`). A branch that does not exist is **not an error** —
   the caller's intent is already satisfied — but a refusal by the provider (protected branch, no
   permission) surfaces with the provider's own reason.
7. **`listCommits(ref: RepoRef, { limit, cursor? })`** returns the branch's history — sha, short
   message, author name, ISO date — newest first, **paginated and bounded**. It never returns file
   contents or diffs: an unbounded history read on a large repository is an availability problem for
   everyone sharing the process, the lesson `assertFetchedTreeUsable` already paid for.
8. **The diff needs NO new seam method** — it is `fetchTree` at the linked branch, compared against the
   local map. That is deliberate: adding a provider `compare` call would answer a *different* question
   (commit-to-commit), and the question the user is asking before a commit is "what have I changed since
   the branch head", which only the browser can answer because only the browser holds the changes.

### B. Route operations — seven new ops on the existing project↔repo route

9. Seven new ops on `POST /api/projects/:projectId/github`: **`branches`** (list),
   **`create-branch`**, **`switch-branch`**, **`delete-branch`**, **`discard`**, **`tree`** (read a
   branch WITHOUT applying it — the diff's source), and **`commits`** (history). They join
   `clone`/`link`/`save`/`push`/`pull`/`resolve` on the route that already carries both walls,
   `providerErrorResponse`, and the token resolution.
10. 🔴 **`tree` reads a branch WITHOUT moving `lastSyncedCommitSha`, and that is the whole reason it is
    its own op.** The existing `pull()` helper does two things — it reads a tree *and* it records that
    the platform now agrees with that commit. A diff must do only the first: showing the user what has
    changed is not agreeing to it, and moving the pointer on a read would make the next push
    fast-forward against a commit this project never applied — §4.13a's ordering defect, arriving
    through a door that never writes a file. The guard is therefore **factored out of `pull()` into a
    shared function both call**, exactly as `assertFetchedTreeUsable` was factored out of
    `cloneRepository`; what must NOT happen is a second copy of the guard, or a `tree` op that reuses
    `pull()` and quietly stamps the pointer.
11. **Both walls on every one of them** — `requireVerifiedUser` + `requireOwnedProject`, 404-not-403.
12. **No token, username or password in the body, query or headers**, for any of them.
   `no-client-token.spec.ts` is extended to cover the new ops the way it covers the existing ones —
   behaviourally *and* by source scan.
13. 🔴 **Every op that READS A TREE goes through the shared `pull()` helper**, so
   `assertFetchedTreeUsable` (size cap + Git-LFS refusal) and the before-the-pointer-moves ordering are
   inherited rather than re-implemented. `switch-branch` and `discard` are the third and fourth doors
   onto that read; a membership list of "the ops that pull" is exactly the mistake §4.13a records.
   Only the refusal **wording** varies by door (`TreeIngestOperation` gains cases), because a user
   pressing "Discard" is not importing anything.
14. **The inherited pickers are NOT reused.** `api.github-branches.ts` and `api.gitlab-branches.ts`
    exist, but they are GitHub-/GitLab-shaped separately, are not project-scoped (`denyUnlessVerified`
    only, no `requireOwnedProject`), return different field sets, and still accept a browser-supplied
    `token` in the body. Routing a storage-backbone operation through them would re-open the credential
    path §4.13a was built to close. They stay where they are, unused by this feature.
15. **Branch names are validated server-side** against git ref rules — no `..`, no leading/trailing `/`
    or `-`, no whitespace, no `~^:?*[\`, no `refs/` prefix, no `.lock` suffix, length-capped — and the
    refusal **names the rule that was broken**, not "invalid name". The name reaches a provider API
    path, so it is also URL-encoded at the adapter, never string-concatenated into a URL by the route.
16. **A rate limit on `create-branch`, `delete-branch` and `tree`**, reusing `enforceUserRateLimit` (`security/user-rate-limit.ts`)
    the way `clone` does — per USER, not per IP (*"on a route behind two walls the IP is the wrong key
    in both directions"*), and counted **before** any outbound call. Two are writes against the user's
    account and the third is a whole-tree read; "verified" is not "unmetered".
17. ⚠️ **Two traps the clone work already paid for, inherited verbatim.** (a) `withSecurity` catches any
    throw into a **500**, bypassing `errorResponse` — so a wall must be the early-return
    `denyUnlessVerified` form, never a bare throw. (b) `GitProviderError` is **not** a `SAFE_ERRORS`
    member and has no `statusCode`; it carries `status`/`kind`/`retryable`, so every new op routes its
    failures through the route's own `providerErrorResponse` mapper (`auth`→401 `{reconnect:true}`,
    `not-found`→404, `forbidden`→403, else 409).

### C. Switching branches

18. **A switch is a tuple write plus a full read.** There is no working tree and no local git: switching
    means `fetchTree(new branch)` → `assertFetchedTreeUsable` → client checkpoints → `restoreFiles` →
    update `linked_branch` **and** `last_synced_commit_sha` together.
19. 🔴 **`last_synced_commit_sha` MUST be set to the new branch's head, in the same update as
    `linked_branch`.** Leaving it stale re-creates the measured 2026-08-03 false divergence against the
    commit we just read; leaving `linked_branch` stale points every later push at the old branch. The
    tuple stays complete throughout (migration 0006 `projects_link_complete_check`).
20. **`protectForRepoRestore`, never `protectNothing`.** The incoming tree is a repository tree, and
    `isSecretPath` kept the `.env` family out of every push — so their absence says "never sent", not
    "deleted". `protectNothing` here deletes the user's API keys, the one thing on disk with no other
    copy.
21. **After the restore, the client reproduces the full post-mount triple** the repo mount already
    performs: `createLocalSnapshot(db, { projectId, files, label })`, `markSynced(db, pid)`, and
    `unsavedWork.set(false)`. Skipping `markSynced` leaves `localSeq > syncedSeq` and the chip reports
    unsaved work on a tree that is byte-identical to the branch it was just read from.
22. 🔴 **The project reinstalls UNCONDITIONALLY after a switch — `decideDependencyInstall` is NOT
    called on this path (owner decision, 2026-08-21, FINAL after considering both).** Two branches
    routinely differ in `package.json`/lockfile, and a switch that leaves `node_modules` describing the
    other branch produces a project that mounts cleanly and cannot run. This path takes the same answer
    `ensureProjectRunnable` already embodies and whose header **deliberately refuses** to consult the
    conditional helper — §4.5.4b's *"opening a project must not be a decision… there should not be a
    decision making"*.
23. 🔴 **The conditional version was specified, costed, and REJECTED — and the reasons are recorded
    here so it is not "optimised" back in.** It is the obviously cheaper design and a future reader will
    reach for it, so:
    - **What it would have bought:** the repo's own figure is *"reinstalling every mount wastes **30+
      seconds** of a user's time on every reload"* (`dependencies.ts`). For a feature branch with
      identical dependencies — the common case — a conditional install skips that entirely.
    - 🔴 **What it would have cost, and why that decided it:** `DependencyFacts.installedLockfile` means
      *"the lockfile content that was present when dependencies were last installed"*, which on a switch
      is the **OLD** branch's lockfile — so the switch must read it **before** it writes the new tree.
      Compare the post-restore map against itself and the answer is always `up-to-date`, silently
      skipping **every** install that was actually needed, leaving a project that simply cannot run with
      nothing thrown. Owner, verbatim: *"I would rather it be reliable."*
    - **The decisive property is not that the bug is unfixable — it is testable — but that the
      unconditional path has no correctness question at all.** There is no comparison to get wrong, no
      capture point to order wrong, and no test that can go vacuous while looking green. Its entire cost
      is TIME, and time is **visible** — section L makes it visible on purpose. A visible cost is
      strictly better than a silent wrong answer, which is `spec/fail-loud.md`'s reasoning applied to a
      path that spends seconds instead of credits.
    - ⚠️ **Therefore: `decideDependencyInstall` stays uncalled here. A future reader finding it unused
      on this path should leave it that way, and read this requirement before changing it.**
24. **The 30s does NOT fall on the workflow the brief describes, and that is what makes the cost
    acceptable.** *"Create a new feature branch, vibe code out a feature… otherwise we commit"* touches
    it nowhere: **create-and-switch writes no files and runs no install** (requirement 34), coding is
    unaffected, and a commit is a push. The install is paid only by **switching to an existing branch**
    and by **discard** — both of which genuinely replace the whole tree, and both of which a user
    reaches deliberately and infrequently.
25. **The dev-server start is unconditional too**, and was never in question: whether the project ends
    up running is decided from the preview store (`shouldStartDevServer`) — a fact, not a guess.
26. **Four constraints follow from reusing that mechanism, each a real hazard:** **(a)** it is
    single-flighted **per PAGE LOAD** (`runnableInFlight`) and `mountProjectFiles` is deduped by
    `mountedThisLoad`, so a switch **cannot** obtain an install by re-calling the mount — it needs its
    own entry point that can run more than once per load; **(b)** `BoltShell.executeCommand` writes
    `\x03` and interrupts whatever is running, so it must never fire while the agent's shell is busy;
    **(c)** 🔴 the mount's own call to it must still **not raise `bootProgress`** — see section L, which
    explains why that ban is about OWNERSHIP rather than about installs, and why a branch switch is on
    the legal side of it; **(d)** the install is single-flighted against itself, so two rapid switches
    cannot run two installs into one shell.
27. 🔴 **The reinstall is NARRATED on the existing boot splash, not endured** (owner, 2026-08-21:
    *"some sort of splash screen like our other project loading splash screen with a switching branches
    type status message… for that 30s dead time"*), and the same for the seconds of file-writing that
    precede it. Requirement 22 buys reliability with **time**, and the entire justification for spending
    it is that the time is made VISIBLE rather than endured — `spec/fail-loud.md`'s *"silence is
    narrated, never endured"* and *"'working' and 'dead' are never the same pixels"*. 🔴 **The splash is
    not a nicety attached to that decision; it is the half that makes the decision defensible.**
    Section L specifies the surface.
28. **The LLM's diff baselines are reset.** `restoreFiles` does **not** clear `FilesStore`'s
    `#modifiedFiles` — it is LLM diff-tracking, not a dirty flag — so after a switch or a discard the
    model is shown "original content" baselines belonging to a tree that no longer exists, and every
    subsequent `type="edit"` is computed against fiction. `workbenchStore.resetAllFileModifications()`
    already exists and is called from exactly one place; both new doors owe it. **This fails silently
    and only in output quality** — §4.2.8's stated failure mode.
29. **Both saved copies are refreshed, on the one trigger.** §4.5.4c invariant 4: every moment the files
    change writes the local checkpoint **and** the server working copy. After a switch or a discard,
    `refreshSavedCopiesSoon(<reason>)` runs — otherwise the server copy still holds the previous
    branch's tree under a key that records no branch at all, and a crash-recovery restore silently
    resurrects it.
30. 🔴 **A switch with unsaved work is a THREE-WAY CHOICE, never a silent overwrite:** *commit my
    changes first* / *discard them and switch* / *cancel*. This is the two-button divergence discipline
    applied to a new door — the platform does not decide which of two versions of the user's work
    survives. A switch with **no** unsaved work proceeds without a prompt.
31. **A switch is refused while a build generation is in flight** for that project. `inflight.ts`
    currently exports only `claimProject` (which throws and *takes* the claim) and `shouldClaimProject`;
    this feature adds a **pure, read-only `isProjectClaimed(projectId)`** so a switch can ask without
    claiming. Interleaving a full-tree replacement with streaming file actions is precisely the silent
    corruption that lock exists to prevent.
32. **Switching to the branch you are already on is a no-op that says so** — not a full restore, not a
    Vite restart.

### D. Creating a branch

33. **A new branch is cut from the CURRENT branch's head, not the repository default.** You branch off
    what you are looking at. The base is the project's `last_synced_commit_sha` when it is in sync, and
    the live head otherwise.
34. 🔴 **Create-and-switch does NOT touch the working tree, and that is the whole point.** Switching to
    an *existing* branch replaces the files (requirement 18); creating a new one leaves every local file
    exactly where it is and simply re-points the project, so the user's in-progress work carries onto
    the new branch. This asymmetry is the feature: *"create a new feature branch, vibe code out a
    feature."* Restoring the tree on create would throw away the work the branch was created to hold.
35. **After a create, `linked_branch` is the new name and `last_synced_commit_sha` is the BASE head** —
    the new branch is, at that instant, exactly that commit. The first push then fast-forwards cleanly
    instead of reporting a divergence against a branch nobody has touched.
36. **Uncommitted work is preserved and still reported as unsaved.** `unsavedWork` stays `true` across a
    create; nothing is pushed (§4.5.4b: nothing reaches the user's repository without a button press).
37. **The divergence escape hatch is reconciled with this path.** `choice: 'push-to-new-branch'` must
    write the tuple like every other branch move — it currently writes nothing (defect 1 above) — so
    however a user arrives on a new branch, the project agrees with them about where they are.
38. **A create that collides reports the collision and keeps the user's typed name** for editing; it
    does not silently suffix, and it does not adopt the existing branch (the `adoptExisting: false`
    reasoning, one level down: adopting a branch the user did not mean puts their work on top of
    someone else's).

### E. Discarding all changes

39. **Discard means "reset this project to the head of its linked branch"** — `fetchTree(linked
    branch)` → guard → **local checkpoint first** → `restoreFiles(protectForRepoRestore)` →
    `createLocalSnapshot` + `markSynced` + `unsavedWork.set(false)`.
40. 🔴 **The §4.12 checkpoint is taken BEFORE anything is written, and it is the feature's safety
    contract, not a courtesy.** Discard is the only control in the product whose purpose is to destroy
    the user's work; the checkpoint is what makes "if things go bad" survivable in both directions,
    including the direction where the discard itself was the mistake. Pull already does this and the
    pattern is copied, not re-invented.
41. **`protectForRepoRestore`** — same reasoning as requirement 20, with more at stake: a discard is
    the operation a user runs when they are already unhappy, and taking their `.env` with it is
    unrecoverable.
42. **Discard is REFUSED on an unlinked project, and the refusal says why.** There is nothing to reset
    *to*; a project that exists only in the browser has no known-good state on any server. The refusal
    names the missing link and offers the link action — it must never degrade to "delete everything".
43. **Discard requires an explicit destructive confirmation** that names what is about to happen: the
    branch being reset to, and that the changes are recoverable from the checkpoint it is about to take.
    A single-click menu item that wipes a session is not acceptable regardless of how loud its label is.
44. **Discard is refused mid-generation**, on the same `isProjectClaimed` reader as a switch, for the
    same reason.
45. **Discard clears the unsaved-work signal on both copies.** After a discard the local checkpoint IS
    the post-discard state and the seq moves forward, so a reload cannot resurrect the discarded work
    through §4.5.4c's `selectMountSource` — which branches on *presence*, not freshness.
46. **The project is made runnable again, the diff baselines are reset, and both saved copies are
    refreshed** — requirements 22–29 apply identically to this door.

### F. Deleting a branch

47. **Delete removes the remote ref and nothing else.** It touches no local file. Deleting a branch you
    are not standing on changes what is on screen not at all, and the UI must not imply otherwise.
48. 🔴 **You cannot delete the branch the project is on.** The project would be left linked to a branch
    that does not exist — a complete tuple pointing at nothing, which every later push, pull and mount
    reads as "branch not found", i.e. indistinguishable from the repository having been deleted. The
    refusal says so and offers to switch first.
49. **You cannot delete the repository's default branch**, whatever it is called (`getDefaultBranch`,
    never a guessed `main`). Providers refuse it anyway; refusing it ourselves means the user gets a
    sentence instead of an API error.
50. 🔴 **Delete is the one operation in this feature with NO undo, and it must say so.** Every other
     destructive path here is covered by a §4.12 local checkpoint — but a checkpoint is a snapshot of
     *files*, and it cannot restore a remote ref. The commits survive as dangling objects in the user's
     repository for a while and can be recovered with `git reflog` **from their own clone**, which is
     not something this product can do for them. The confirmation names the branch and states plainly
     that the platform cannot bring it back.
51. **A protected branch refusal surfaces the provider's reason**, not a generic failure — both
     branch-list APIs already return a `protected` flag, so the item can be disabled with an
     explanation before the user presses it.
52. **Deleting a branch that is already gone is a success, not an error** — the intent is satisfied.
     The list refreshes either way.

### G. Seeing what changed (the pre-commit diff)

53. **"What changed" means: the local file map against the head of the linked branch.** There is no
     local git and no index, so this is the only honest definition — and it is exactly the question
     asked before a commit: *what am I about to push?*
54. **It is a two-level surface.** A **changed-file list** (path + `added` / `modified` / `deleted`)
     is the primary artifact and is cheap once the tree is in hand; a **per-file text diff** is rendered
     **on demand**, one file at a time, never eagerly for the whole tree.
55. 🔴 **Both sides are normalised through `toRepoRelativePath` before comparison.** The store keys
     `/home/project/src/main.ts` and a repo tree returns `src/main.ts`. Compare them raw and **nothing
     matches** — every local file reads as `added` and every remote file as `deleted`, i.e. the diff
     reports that the user rewrote their entire project. This is the identical trap `planRestore`
     documents, where the same mistake wiped projects; here it merely lies, which is why it would
     survive longer.
56. 🔴 **`isSecretPath` files are EXCLUDED from the changed list.** `.env` is never in the repository,
     so an honest set-difference reports it as `added` on every single diff, forever. A permanent false
     positive at the top of a list is worse than no list: it trains the user to skim past exactly the
     surface built to make them read carefully. The same applies to `MAP_EXCLUDED_DIRS`
     (`node_modules`, `.git`, `dist`, `.codesandbox`).
57. **Binaries are compared, never diffed.** A binary that differs is reported as changed with its
     sizes (`player.png — binary, 107 KB → 131 KB`); the viewer never attempts to render bytes as text.
     🔴 Comparison uses **size plus a hash of the bytes**, never `File.content`, which is ALWAYS empty
     for a binary (the map holds `isBinary` + `size` only) — a content comparison would report every
     binary as identical, silently, and the one file class most likely to have changed after an asset
     generation would be the one class the diff could never see.
58. **The tree is fetched through the `tree` op** (requirement 10) so the diff is a read that agrees
     to nothing, and it passes the shared ingest guard like every other read.
59. **The fetched tree is cached for the session, keyed by `(branch, head sha)`.** Opening the diff,
     closing it and opening it again must not re-download the repository; a head that moved invalidates
     the entry by construction.
60. **The comparison is a pure, exported, exhaustively tested function** — it is the code that tells a
     user what they are about to publish, and every failure mode above produces a *confident wrong
     answer* rather than an error.
61. **The diff is offered where the decision is made:** in the commit flow, before the push, and from
     the chip menu. It is not a new top-level surface.
62. **An unlinked project has no diff** — there is nothing to compare against — and the control says
     that rather than showing an empty list.

### H. Branch history

63. **History is read-only, paginated, and honest about what it is.** It lists the linked branch's
     commits (sha, message, author, date), newest first, bounded per page. Commit messages are already
     meaningful here — §4.13 defaults them to the generation summary (*"AI: add boost pads to
     RaceMode"*), so the history is a readable record of what the agent did.
64. **Every entry links to the provider** for the full commit view. The platform renders no commit
     diff of its own — that is the provider's surface, and duplicating it is how a git *client* becomes
     a git *GUI*.
65. 🔴 **History does NOT offer "restore this commit" in v1, and the reason is worth writing down.**
     It is one small step from a list of commits to a button that resets to one, and that button is
     `reset --hard <sha>` — a strictly bigger gun than Discard, which at least targets a head the
     project already agreed with. It would also need `fetchTree` extended to take a sha rather than a
     branch. Named here as the obvious next feature so that it is added *deliberately*, with its own
     confirmation and checkpoint rules, rather than as a two-line addition to a list view.
66. **History never blocks** — it is informational, so a provider failure greys the panel with a
     reason and never prevents a commit, a switch or a discard.

### I. Committing to the selected branch

67. **Commit is the existing path, unchanged.** It goes through the sanctioned single writer —
    `useSaveProject().run()` → `requestSave` → `SaveQueue` → `op: 'save'` — which coalesces, retries on
    `RETRY_DELAYS_MS`, and reports failure loudly. **No new push path is introduced.**
    `GitHubSyncDialog`'s inline `fetch` calls are the cautionary example already in the codebase: a
    second, uncoordinated writer that bypasses the queue.
68. **The commit targets whatever `linked_branch` currently names** — which, after this feature, is
    whatever the user selected. Fast-forward-only and the two-button divergence flow are unchanged.
69. **The chip's action label names the branch it will commit to.** "Commit changes" is ambiguous the
    moment there is more than one branch; the sanctioned git word (§4.1a scopes `commit` to
    `actionLabel` and bans it everywhere else) now carries a destination.

### J. Opening the provider — branch links and the pull request

70. **"Open a pull request"** opens the provider's own PR/MR creation page for the current branch in a
    new tab. GitHub: the compare URL against the repository default with the form expanded. GitLab: the
    new-merge-request URL with the source branch pre-selected. This is a **link**, not an
    implementation — §4.13's "PRs happen in the user's own tooling" is preserved.
71. **It is only offered when it can work:** the current branch is not the repository default, and it
    has been pushed at least once. Otherwise the provider renders an empty or nonsensical compare, which
    reads as the button being broken.
72. **"Open <repo>" becomes branch-aware** — the existing item points at the repository root; it now
    offers the current branch's tree.
73. 🔴 **Every provider URL is built in ONE module beside `PROVIDER_ORIGIN`, never inline in a menu
    item.** GitHub and GitLab differ in path shape (`/tree/<branch>` vs `/-/tree/<branch>`,
    `/compare/a...b` vs `/-/merge_requests/new`), branch names may contain `/` and must be encoded, and
    a URL assembled at three call sites is three chances to ship a broken link. It is a pure, tested
    function — the `isSecretPath` rule applied to link building.

### K. UI — inside the chip, not beside it (§4.1a)

74. 🔴 **No new toolbar button. Every control lives in the existing `GitStatusChip` menu.** Branch
    controls are the single most obvious candidate for a second sibling since the four-git-controls
    fix, and adding a "Branch ▾" button beside the chip would reproduce that defect exactly: two
    adjacent controls answering one question — *where does my game live?* — each named against the
    other. The chip is the parent; this is its content.
75. **The chip's menu gains a Branch group**, under a separator: the **current branch shown read-only
    at the top of the group** (so "which branch am I on?" is answered by opening one menu), then
    **Switch branch…**, **New branch…**, **Review changes…**, **Branch history…**, **Open a pull
    request**, and — separated, last, styled as destructive — **Discard all changes…** and **Delete a
    branch…**.
76. 🔴 **The branch name stays OUT of the chip's label (owner decision, 2026-08-21).** The chip keeps
    its short `describeSaveStatus` strings ("Linked to GitHub", "Changes not synced"); the branch lives
    in the menu and in the commit action's own label. The reason is §4.1a's measured one: the header
    row is right-aligned, so a control that grows with its content shoves everything to its left —
    measured at 16px → 486px when preview-gated controls appeared — and a branch name is unbounded
    user-chosen text. **Truncating it in the label was considered and rejected**: a hard-capped
    `feature/boost-…` is ambiguous between exactly the similarly-named branches a user is most likely
    to confuse, which is worse than not showing it.
77. ⚠️ **This group is now large enough to be its own submenu or dialog, and that is a real design
    decision rather than a formatting one.** §4.1a's ⋯ rule — *"a menu that grows by appending becomes
    an undifferentiated list"* — applies to the chip's own menu the moment it carries eight items. A
    submenu keeps the top level about *state*; a dedicated dialog suits Review changes and History,
    which want room. Whichever is chosen, the rule that holds is that **the row does not grow**.
78. **The chip's own label/tone continues to come from the pure, tested describe-function.** The branch
    name joins `SaveStatusView` (or a sibling `describeBranchState`) rather than being formatted in the
    component: *"a string invented in the component is a string nothing tests"*, and this string now
    tells the user which branch their next commit lands on.
79. **`modal={false}` on every new dropdown or dialog trigger** in the header, or Radix's scroll-lock
    body padding shifts the in-flow chat column while the fixed workbench stays put.
80. **Fill stays reserved** for the chip and ⋯ (§4.1a). The destructive item is distinguished by colour
    and placement, never by becoming a filled control.
81. **The branch list is fetched when the menu opens, not on every render**, and shows a loading state
    rather than an empty list — an empty list reads as "this repository has no branches".
82. **The shared action lives in a hook/module, not in the menu item** — §4.1a: *"An action that more
    than one surface can trigger is a HOOK, not a button."* Switch is reachable from the chip and from
    the sync dialog's branch field, which is two surfaces on day one.
83. **Every failure is LOUD** (`spec/fail-loud.md`): named cause, the provider's own message where it
    has one, a retry affordance, and never a success toast for an operation that did not happen. The
    §4.5.4b precedent is explicit — a revoked token must route to reconnect, not report a save.

### L. The progress surface — the boot splash, narrating the switch

> Owner, 2026-08-21: *"can there be some sort of splash screen like our other project loading splash
> screen with a switching branches type status message… for that 30s dead time."* Yes — and the switch
> turns out to be a **better** candidate for that surface than the reload path which famously could not
> have it. The reason is worth stating precisely, because getting it wrong reproduces a live 2026-08-03
> defect exactly.

84. 🔴 **The 2026-08-03 ban is about OWNERSHIP, not about installs.** `useChatHistory`'s post-mount
    installer carries a loud comment — *"NEVER `bootProgress.set(...)` FROM HERE — it hangs the splash
    forever"* — and the cause named there is the whole rule: `ensureProjectRunnable` is invoked
    **detached** from the mount, so the mount's `.finally(endBootPhase)` has already fired by the time
    the install begins; the phase went up with **nothing left to bring it down**, and since
    `coversWorkspace` covers every phase but `idle`/`failed`, the result was a full-page spinner
    counting up forever over a project that was installing perfectly well. The comment's own conclusion
    is the general rule: ***"`bootProgress` is ONE SLOT owned by the mount; a task that outlives the
    mount must never write to it."*** Generalised: **whoever raises a phase must be the one that
    guarantees it comes down.**
85. **A branch switch satisfies that rule and the detached installer does not.** A switch is a
    user-initiated, awaited, single-owner sequence with a definite beginning and end — it already needs
    its own install entry point (requirement 26), so its install runs *inside* the operation rather
    than detached from a mount that has finished. It can therefore own the slot legitimately, and
    **raises its phases in a `try` whose `finally` calls `endBootPhase()`**, unconditionally, on every
    exit path including a throw and an abort. That `finally` is the entire licence for this section; a
    switch that can return without it is the 2026-08-03 hang with a new name.
86. **The surface is `WorkspaceSplash`, never `BootScreen`.** A switch is pressed inside a workspace the
    user is already looking at, so `ready` is true and `Chat` renders the two in mutually exclusive
    branches (`ready ? WorkspaceSplash : BootScreen`). This is the clone door's situation exactly, and
    SPEC §4.4a already records the amendment for it.
87. **No gate needs changing, and that is the 2026-07-31 rewrite paying off.** `coversWorkspace` is
    *"every phase except `idle` and `failed`"*, asserted over the **declared union** rather than a
    membership list, precisely so a new door cannot walk past it — as three previous doors did. A new
    phase is covered automatically the moment it is declared.
88. **Adding a phase means adding it everywhere the union is enumerated**, because
    `boot-progress.spec.ts` reads the union out of the SOURCE (the runtime type is erased, and a short
    `BootPhase[]` would otherwise pass happily) and fails on any phase missing from its lists —
    by design. Each new phase needs its union member with a doc block and a `bootPhaseCopy` case whose
    title is **distinct and is not the idle fallback**; both are asserted.
89. **The switch narrates four steps, mirroring creation's progression at smaller scale:**
    **(a)** reading the branch from the provider; **(b)** writing the files; **(c)** installing
    dependencies — **always** (requirement 22), and the 30+s this section exists for; **(d)** starting
    the dev server. All four run every time, so there is **one path to narrate and one path to test** —
    the same simplicity argument that chose the unconditional install, arriving in the UI.
90. **Each step is raised once, in order, and every step is real work.** No phase is raised
    speculatively and taken down again: a phase that appears for a single frame is a **strobe**, which
    this codebase has measured and fixed once already (`importTailActive`: on at 13424ms, off at 13628,
    on at 13801, off at 14201). The unconditional install removes the only place that could have
    happened on this path.
91. **Step (b) reuses the existing `{ step: 'files'; done?; total? }` phase and gets a real progress
    bar for free.** `restoreFiles` already takes `onProgress: (done, total)` and every other restore
    door already pumps it into that phase, and `BootScreen` draws its bar only for `step === 'files'`.
    Do not invent a parallel file phase.
92. **The branch name rides ON the phase**, e.g. `{ step: 'switching-branch'; branch: string }`, so
    `bootPhaseCopy` can say *"Switching to feature/boost-pads"* rather than something generic. Carrying
    data on a phase is established — `files` already carries `done`/`total` — and `bootPhaseCopy` takes
    only the phase, so a branch name that is not on it cannot reach the copy.
93. 🔴 **The install step shows the ELAPSED CLOCK — the actual answer to "30s of
    dead time".** `npm install` emits no structured progress, so there is no honest bar to draw — but the
    splash already rides a clock at the end of the detail line (tabular figures, after 5s), and a
    visibly counting number is what distinguishes *slow* from *stuck*. ⚠️ **Never draw a fake progress
    bar for this step**: a bar that fills and then keeps spinning converts "slow" into "stuck", which is
    the despair the surface exists to prevent (`PROGRESS_CAP`'s reasoning, one subsystem over).
94. **Discard gets the same treatment; create and delete do not.** Discard replaces the tree and runs
    the same unconditional install, so it narrates identically with its own copy. **Create-and-switch touches no file and
    runs no install** (requirement 34), so covering the workspace for it would be a spinner over
    nothing happening. **Delete** changes no local state at all.
95. **A failure UNCOVERS.** `coversWorkspace` returns false for `failed`, so `reportBootFailure` swaps
    the spinner for the failure panel with its retry affordance — which means this section delivers
    §M's loud-failure requirement for these doors rather than duplicating it. A spinner left over a dead
    workspace hides the one sentence the user needs.
96. ⚠️ **The splash must not become the switch's confirmation surface.** The three-way unsaved-work
    choice (requirement 30) is decided BEFORE any phase is raised. A covering surface that appears and
    then asks a question is a modal wearing a spinner's clothes.
97. ⚠️ **One slot, one owner — and a switch is only safe because it cannot overlap a mount.** A switch
    runs in a settled workspace (the mount is finished and the phase is back to `idle`) and is refused
    mid-generation (requirement 31), so it can own the slot outright and needs no second flag. **This is
    a property to preserve, not an accident**: if a switch ever becomes reachable during a mount or an
    import tail, it needs the `importTailActive` treatment — a separate flag composed through
    `effectiveBootPhase` — because `bootProgress` is one slot and the last writer wins.

### M. Explicitly out of scope

98. Merging, rebasing, cherry-picking, conflict resolution, force-push, tags, stashes, per-file or
    partial (staged) commits, per-file discard, and remote pruning. Pull requests are **opened**, never
    created or reviewed by the platform. ⚠️ Branch deletion, the pre-commit diff and branch history are
    **IN scope** (owner decision, 2026-08-21) — sections F, G and H.
99. **Restoring the project to an arbitrary historical commit** — deliberately excluded and explained
    in section H, because the step from a history list to that button is one line of JSX and the
    button is a bigger gun than Discard.
100. Multiple simultaneous branches per project (one sandbox, one linked branch at a time).
101. Anything that would make the platform merge. *"The platform NEVER merges"* is unqualified and this
    feature does not qualify it.

## Design System Reference

**There is no `DESIGN.md` in this repository.** No project-level design-system document exists at the
root or under `docs/`. The UI conventions this feature must follow live instead in **CLAUDE.md §"The
builder toolbar (SPEC §4.1a)"** and **SPEC.md §4.1a**, and are treated as the design system here.

- **Shared button style — imported, never re-typed:** `app/components/header/toolbar-button.ts`
  (`TOOLBAR_BUTTON`, `TOOLBAR_SHAPE`, `TOOLBAR_ICON_BUTTON_FILLED`, `TOOLBAR_MENU_CONTENT`,
  `TOOLBAR_MENU_ITEM`). New menu items use `TOOLBAR_MENU_ITEM`; the menu uses `TOOLBAR_MENU_CONTENT`.
- ⚠️ **UnoCSS does not scan plain `.ts` by default** — `uno.config.ts` sets `content.pipeline.include`
  to add it. Any new class string placed in a `.ts` constants module depends on that setting, and its
  removal deletes styles *partially*, which reads as a design regression in components that are correct.
- **Fill is reserved** for the git chip and the ⋯ main menu; every other control is bordered-only.
- **Chip tones** (`SaveTone`): `busy`/`neutral` deliberately match `TOOLBAR_BUTTON` exactly; only
  `warning` and `danger` break out. A project on a clean branch should feel like nothing; a project with
  uncommitted work should feel like something.
- **Icons** are the `ph` (Phosphor) collection already registered in `uno.config.ts` —
  `i-ph:git-branch` is already in use for the sync item; the new controls draw from the same set
  (`i-ph:git-branch`, `i-ph:git-pull-request`, `i-ph:arrow-square-out`, `i-ph:trash`/`i-ph:warning`).
- **Menu structure is groups with separators**, not an appended list — the ⋯-menu rule applied one
  control over: a new item joins the group it belongs to, and if it belongs to none, it gets a group.
- **Copy discipline:** `commit` is the ONE sanctioned piece of git jargon and only in `actionLabel`;
  every other git word is banned from user-facing strings by `save-status.spec.ts`. "Branch" is
  necessarily introduced by this feature and should be added to that spec's allow-list **deliberately,
  with its scope stated**, rather than by widening the ban.
- **`app/components/ui/BranchSelector.tsx` already exists** — an inherited branch picker, used today
  only by the GitLab repository selector. **Reuse the visual, never the token model**: it posts a
  browser-held `token` to `api.github-branches.ts`, which is precisely the credential path §4.13a closed.
- ⚠️ The **brand gate** (`scripts/check-brand.mjs`, in the pre-commit hook) fails the build on hardcoded
  product names outside `app/config/brand.ts`. New copy comes from the tested describe-functions;
  provider names come from `PROVIDER_LABEL`.
- No sibling-skill behavioural pattern applies (this is not a 3D-hero/atlas/convert feature).

## Possible Edge Cases

1. **Branch has no commits** (created and never pushed) — `fetchTree` returns `null`; a switch to it
   must not wipe the project. An empty incoming map deletes nothing (`planRestore`), but the switch
   should refuse with an explanation rather than restore emptiness.
2. **Empty repository** — GitHub answers **409 "Git Repository is empty"** where GitLab answers 404;
   `listBranches` must normalise both to an empty list, not an error.
3. **Repository default branch is `master`, not `main`** — never guess; `getDefaultBranch` exists for
   exactly this and was added because a guessed `main` reads to a user as "your repository does not
   exist".
4. **Branch name contains `/`** (`feature/foo`) — legal, extremely common, and must survive URL
   construction in both adapters and every provider link.
5. **Branch name is a unicode / RTL / homoglyph string** — accepted by git, hostile in a menu; render
   with `truncate` and do not let it break the layout.
6. **Someone deletes the linked branch on github.com while the project is open** — `remoteHead` reads
   `null`; the chip must distinguish "branch is empty" from "branch is gone" from "we could not ask"
   (`remoteHead === undefined`), the three-way distinction `mount-source.ts` already depends on.
7. **The remote branch moved between listing and switching** — the switch reads whatever is there now
   and records *that* head; it must never record the head it saw in the list.
8. **Switch while a generation is in flight** — refused (requirement 31).
9. **Switch while a save is queued or retrying** — the `SaveQueue` holds a push aimed at the old
   branch. The switch must either drain or cancel it; a queued push landing after the branch changed
   commits the old branch's work to the new branch.
10. **Discard on a project whose linked branch was force-pushed backwards** — the reset target is
    genuinely older than what the user has. The checkpoint makes it recoverable; the confirmation
    should name the commit.
11. **Discard with nothing to discard** — a no-op that says so; it must not perform a full restore
    (which would rewrite `vite.config.ts` and restart Vite for no reason, the exact cost recorded in the
    clone divergence comment).
12. **Switch/discard on a project over the working-copy size budget** — §4.16's `withinWorkingCopyBudget`
    skips the server copy for large projects. The local checkpoint is still written; the operation must
    not silently proceed with *neither* copy.
13. **A branch whose tree exceeds `GIT_CLONE_MAX_MB`, or contains Git-LFS pointers** — refused by
    `assertFetchedTreeUsable` with the door's own wording. This is not hypothetical: the workflow this
    product recommends is committing assets from a local git client.
14. **The tree contains a `.env`** — `isSecretPath` governs the inbound direction too; a branch is under
    no obligation to gitignore secrets.
15. **Token expired / revoked between listing and acting** — `resolveProvider` refreshes, and on failure
    deletes the record and throws `auth`; the UI routes to reconnect and never reports success.
16. **Rate limit hit mid-operation** — `GitProviderError{kind:'rate-limit'}` is `retryable`; surface the
    retry-after rather than a generic failure.
17. **Two tabs open on the same project, one switches** — the other tab's `linked_branch` is stale and
    its next push aims at the wrong branch. At minimum, `refreshRepoStatus` on focus.
18. **Protected branch** — the provider refuses the push. Both branch-list APIs already return a
    `protected` flag; a commit to a protected branch should fail with the provider's reason, not a
    generic error.
19. **Repository with hundreds of branches** — the list needs pagination or a search field; GitHub
    paginates and an unpaginated first page silently omits branches.
20. **Unlinked project** — every branch control is unavailable, and the menu says *why* and offers the
    link action rather than showing dead items.
21. **GitLab has no compare-and-swap on commits** — the fast-forward guarantee is weaker there than on
    GitHub, a pre-existing asymmetry that branch work makes more visible and must not silently paper
    over.
22. **`package.json` is IDENTICAL across the two branches** — the install runs anyway (requirement 22)
    and costs 30+s for no change. This is the accepted cost of the reliability decision, and it is the
    case the splash exists to keep honest: the user must see work happening rather than a project that
    appears to hang.
23. **Switch immediately after project creation, before the mount has settled** — the settle rules
    (`settleAfterCreation`) exist because a file map that is still filling is not a tree.
24. **The user types a branch name that already exists remotely but not locally** — a create becomes a
    collision, and the honest offer is "switch to it instead".
25. **Deleted-file tombstones survive the switch.** `FilesStore` keeps `#deletedPaths` and
    `refreshFiles` skips them. A file the user deleted on branch A, which legitimately exists on branch
    B, can be written by the restore and then suppressed from the map — present on disk, invisible in
    the tree. That set is per-tree state, and a branch switch invalidates it.
26. **A warm server pod may treat the sandbox as truth.** `decideLiveSandboxIsTruth` makes the mount
    call `refreshFiles()` instead of restoring for `local | diverged | working` sources. A switch must
    never be routed through a path that can decide the existing filesystem wins — that would silently
    turn the switch into a no-op.
27. **Both existing "before" checkpoints use NON-strict `serializeFiles()`**, unlike `checkpointProject`,
    which is strict. For discard that matters more than anywhere else: a lax map means the checkpoint —
    the only copy of what is about to be destroyed — can silently omit an unreadable binary. This needs
    a deliberate answer rather than copying whichever precedent was nearest.
28. **A generation completes while the branch menu is open** — the listed heads and the local tree are
    both stale by the time the user presses Switch.

## Acceptance Criteria

1. `listBranches` and `createBranch` exist on `GitProvider`, are implemented on **both** adapters, and
   are covered by `git-provider-contract.spec.ts` running against both fakes.
2. `POST /api/projects/:id/github` accepts `branches`, `create-branch`, `switch-branch` and `discard`,
   each behind **both walls**, each returning 404 (not 403) for a project the caller does not own.
3. `no-client-token.spec.ts` is extended so the new ops are pinned — behaviourally and by source scan —
   as unable to accept a credential.
4. `switch-branch` and `discard` both pass through `assertFetchedTreeUsable`, verified by a test that
   fails if either bypasses it, with the refusal wording asserted per door.
5. A switch writes `linked_branch` **and** `last_synced_commit_sha` in one update; a test proves the
   project does not read as `diverged` immediately after a switch (`selectMountSource` returns a
   non-divergent source for the post-switch facts).
6. A switch restores with `protectForRepoRestore`; a test proves a local `.env` survives a switch.
7. A create-and-switch leaves the file map **byte-identical** — a test asserts no restore occurs — while
   `linked_branch` changes and `unsavedWork` stays `true`.
8. `push-to-new-branch` writes the complete tuple; a test proves the project's linked branch equals the
   branch it was told about.
9. Discard takes a §4.12 local checkpoint **before** any write; a test proves the checkpoint exists and
   contains the pre-discard files, and that undoing it restores them.
10. Discard on an unlinked project is refused with a message naming the missing link, and writes
    nothing.
11. A switch and a discard are both refused while a generation holds the project claim, via a pure
    `isProjectClaimed` reader that does not take the claim (mutation-verified: removing the check fails
    the test).
12. Branch-name validation refuses `..`, `refs/`, whitespace, `~^:?*[\`, leading `-`, and `.lock`
    suffixes, and each refusal names the rule. **With a control** proving a legal name containing `/`
    is accepted.
13. Provider URLs are built by one pure exported function; tests cover GitHub and GitLab tree and
    PR/MR shapes, and a branch name containing `/` round-trips encoded.
14. "Open a pull request" is absent when the current branch is the repository default or has never been
    pushed.
15. Every new user-facing string originates from a tested describe-function; `save-status.spec.ts`'s
    git-jargon ban still passes, with "branch" allow-listed deliberately and scoped.
16. All new header menus/dialogs set `modal={false}`; verified with the menu open, `body`'s
    `padding-right` stays `0px`.
17. A switch and a discard each reinstall **unconditionally** and start the dev server; a source-level
    assertion proves `decideDependencyInstall` is **not** consulted on either path, so the rejected
    design cannot be reintroduced silently (requirement 23).
18. The switch raises its phases through `bootProgress` and **always calls `endBootPhase()` in a
    `finally`** — asserted on the success path, the throw path and the abort path. 🔴 Mutation-verify by
    removing the `finally` and confirming a test fails: without it this is the 2026-08-03
    splash-hangs-forever defect with a new name.
19. `WorkspaceSplash` covers the workspace for the whole switch, and `boot-progress.spec.ts`'s
    union-scanning tests still pass — every new phase has a distinct `bootPhaseCopy` title and none
    falls through to the idle fallback.
20. The install step renders the elapsed clock and **no progress bar**; a test asserts no bar is drawn
    for that phase (a filling-then-spinning bar converts "slow" into "stuck").
21. A failed switch **uncovers** and shows the failure panel with its retry, rather than leaving a
    spinner over a dead workspace.
22. Binary byte-identity across a branch switch: a PNG and a multi-MB `.wasm` are sha256-identical
    before and after.
23. `deleteBranch` refuses the currently-linked branch and the repository default, each with its own
    sentence; deleting an already-absent branch succeeds; and a test proves **no local file is touched**
    by any delete.
24. The pre-commit diff reports **zero changes** for a project freshly restored from its branch — the
    control that catches the path-normalisation trap, which otherwise reports every file as changed.
    Mutation-verify by comparing raw paths and confirming this test fails.
25. The diff **never lists an `isSecretPath` file or a `MAP_EXCLUDED_DIRS` path**, and a test proves a
    local `.env` is absent from the list rather than shown as added.
26. A changed **binary** is detected via size + byte hash, never `File.content`; a test with a modified
    PNG proves it is reported as changed (the content-comparison version of this reports nothing, so the
    test must fail without the fix).
27. The `tree` op does **not** move `lastSyncedCommitSha`; mutation-verify by routing it through
    `pull()` and confirming the test fails.
28. Branch history is bounded and paginated, and a provider failure greys the panel without blocking a
    commit, switch or discard.
29. **SPEC.md is updated in the same PR** — §4.13's sync-bridge sentence rewritten, §4.13b added,
    §4.5.4b's lifecycle extended, §4.12's checkpoint list extended, §4.1a's chip inventory extended.
30. `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test` all green, and the app still runs.
31. **Live-driven against real github.com**, not only against fakes: create a branch, make a change,
    commit it, discard a second change, switch back to the default branch, and open the PR page. The
    §4.13 live-verification precedent applies — this codebase's recorded lesson is that the defects live
    in the wiring the unit tests drove around.

## Open Questions

1. **Does a switch keep or discard uncommitted work when the user chooses "discard and switch"** —
   should that path take a checkpoint too? (Recommendation: yes, unconditionally; a checkpoint is cheap
   and this is the same regret window Discard has.)
2. **Should Pull and the divergence resolve ALSO reinstall + narrate, now that a switch does?** They
   perform the same full-tree replacement and today reinstall not at all and narrate nothing — so once
   this lands, one underlying operation behaves differently depending on which door reached it. That is
   the one-half-of-a-pair-guarded shape this codebase keeps rediscovering
   (`recordAgentWrite`/`#recordRestoredFiles`, `prepareMountedProject`/`mountedThisLoad`, clone/pull).
   ⚠️ **The unconditional install makes this question cost real time rather than being free**: converging
   them adds 30+s to every Pull, which is a product decision, not a tidiness one. (Recommendation:
   converge them — a Pull that leaves `node_modules` describing the pre-pull tree is the same latent
   broken project, and the argument that chose reliability for a switch applies unchanged to a pull.)
3. **Should the diff be computed for the whole tree, or capped?** A project with thousands of files
   fetches and compares an entire tree to answer "what changed". The cache (requirement 59) makes the
   second open free, but the first is a full ingest. Is a file-count ceiling with an honest "too large
   to review here — open it on GitHub" acceptable, or must it always work?
4. **Should `auto_push` finally be dropped**, now that a project can move between branches? An inert
   column whose name implies automatic writes is a hazard in a feature about deliberate ones.
5. **Does the Branch group become a submenu or a dialog?** Decided in principle (requirement 77 — the
   row must not grow), undecided in form. Review changes and History both want more room than a
   dropdown item, which argues for a dialog; Switch and New branch are fine as menu items.
6. **Pagination or search for the branch list and the history** — at what count does a flat list stop
   working, and does the switch UI need a filter?
7. **Should a switch be offered at all when the project has never been pushed** (linked but zero
   commits)? There is a branch to move to, but nothing of the user's on it.
8. **Does the §4.5.4c server working copy need a branch stamp?** Today it is one object per project. A
   recovery that restores a working copy taken on a different branch than the one now linked would be
   silently wrong — this may be the sharpest unresolved hazard in the spec.

## Testing Guidelines

⚠️ **This repository does NOT use a `./tests` folder.** Tests are colocated `*.spec.ts` /
`*.spec.tsx` files beside the code they exercise, run by Vitest. Follow that convention.
⚠️ **A spec file must never live in `app/routes/`** — Remix compiles it as a route, the manifest
imports `vitest` at runtime, and every request 500s.

Extend or add, keeping each suite meaningful rather than exhaustive:

- **`app/lib/.server/git/git-provider-contract.spec.ts`** *(extend)* — all four new methods against
  **both** fakes: list on a repo with several branches, list on an empty repo (both providers' distinct
  empty responses), create from a sha, create onto an existing name → `name-taken`, **a control proving
  create does not move an existing ref**, delete an existing branch, delete an absent one (success, not
  error), and a bounded `listCommits` page.
- **`app/lib/persistence/tree-diff.spec.ts`** *(new, pure — the highest-value suite here)* — the
  comparison function: added / modified / deleted classification; **a control proving an unchanged tree
  yields zero changes** (this is the one that catches the path-normalisation trap, and without it every
  other assertion passes while the diff claims the user rewrote their project); `isSecretPath` and
  `MAP_EXCLUDED_DIRS` exclusion; and a binary compared by size + hash with a control proving a
  `File.content` comparison would have missed it.
- **`app/lib/.server/git/no-client-token.spec.ts`** *(extend)* — the four new ops reject a body carrying
  a token, plus the source-level scan.
- **`app/lib/.server/git/clone.spec.ts`** *(extend)* — `assertFetchedTreeUsable` fires on the switch and
  discard doors, before the sync pointer moves, with door-specific wording. **Control first**, per the
  existing pull-op block.
- **`app/lib/.server/git/branch-name.spec.ts`** *(new, pure)* — validation: every refused shape names
  its rule, plus controls for legal names including one containing `/` and one at the length cap.
- **`app/lib/git/provider-urls.spec.ts`** *(new, pure)* — tree and PR/MR URLs for both providers;
  encoding of `/` and unicode in branch names; the "not offered on default branch / never pushed"
  predicate.
- **`app/lib/persistence/branch-switch.spec.ts`** *(new, pure)* — the decision core: what a switch does
  with unsaved work (three-way), that create-and-switch performs **no** restore while switch-to-existing
  does, that both write a complete tuple, and that the post-switch facts do not read as `diverged`
  through `selectMountSource`. **Mutation-verify** by dropping the `last_synced_commit_sha` write and
  confirming the divergence test fails.
- **`app/lib/persistence/branch-delete.spec.ts`** *(new, pure)* — refuses the current branch and the
  default branch with distinct reasons; treats an absent branch as success; and a control proving the
  decision never returns a file-mutating instruction.
- **`app/lib/persistence/discard.spec.ts`** *(new, pure)* — checkpoint-before-write ordering, refusal
  when unlinked, no-op when there is nothing to discard, `protectForRepoRestore` selected (with a
  control proving `protectNothing` would delete a `.env`), and the post-discard seq/`unsavedWork` state.
- **`app/lib/.server/agent/inflight.spec.ts`** *(extend)* — `isProjectClaimed` reports a live claim,
  reports `false` for an expired one, and — the control that matters — **does not take the claim**.
- **`app/lib/persistence/save-status.spec.ts`** *(extend)* — the branch name reaches the view model from
  the describe-function; the git-jargon ban still holds with "branch" scoped.
- **`app/components/header/GitStatusChip.spec.tsx`** *(new/extend)* — the branch group renders for a
  linked project and is absent/explained for an unlinked one; "Open a pull request" is absent on the
  default branch; `modal={false}` is set. Drive **real pointer events** — `.click()` does not open a
  Radix menu.
- **`app/lib/stores/files-restore-writethrough.spec.ts`** *(extend)* — write-through and foreign-root
  rebasing for the new door, parameterized over both workdirs; plus the `#modifiedFiles` reset and the
  `#deletedPaths` invalidation (requirement 28, edge case 25) — both fail silently and only in output
  quality, so neither has a natural symptom.
- **Binary round-trip** — extend the existing byte-identity discipline to a branch switch (PNG + a
  multi-MB `.wasm`, sha256 before and after).

**Default-deny guards that must still pass, and be extended where they enumerate:**
`outbound-auth.spec.ts` (an unguarded outbound route → 401 with ZERO outbound `fetch`),
`outbound-enumerate.spec.ts` (walks `app/routes/` and fails any `api.*` handler that references no
wall), `sandbox-seam.spec.ts` (every write goes through `SandboxProvider`), `no-server-storage.spec.ts`
and `one-working-copy.spec.ts` (nothing here may become server-side project storage), and
`toolbar-button.spec.ts` — ⚠️ any new class string in a `.ts` constants module depends on
`uno.config.ts`'s `content.pipeline.include`, and without it the styles are silently not generated.

**Mutation-verify the destructive paths.** The recorded lesson in this codebase is that a test whose
input cannot reach the rule it names is not a weak test, it is no test — and the paths this feature
adds delete the user's files.
