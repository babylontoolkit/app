# Late-write loss — implementation plan

> Source: `_specs/late-write-loss_findings.md` (investigated 2026-08-15).
> Reported by the owner: *"right after image generation and you dont save … sometimes any generated
> content, like images and edit on source files are GONE or LOST… they were created and showing, but a
> refresh LOSES them."*

**`spec_impact: yes`** (inferred — the findings file is a root-cause writeup, not a formal spec, so the
field is derived from the analysis below: this changes a durability rule, adds an IndexedDB API,
changes a §4.12 selection function, and closes a §4.5.4c invariant the shipped code violates).

---

## Codebase Analysis

### The defect, re-verified against source

Every link in the findings file was re-checked. All five hold, and the analysis turned up **two things
the findings did not name** (a §4.12 correctness hazard the fix itself creates, and a checkpoint-churn
regression the naive fix causes). Both are tasks below.

1. **The local checkpoint is written at generation end.** `checkpointProject`
   (`app/lib/persistence/useChatHistory.ts:1925`) serializes strictly via `runCheckpointSerialize`
   (`:1969`), writes the local snapshot at `:2037`, then the server copy at `:2057` borrowing
   `snapshot.seq`. It is idempotent per `messageId` (`:1928`, guard ref at `:1142`).
2. **§4.16 media lands after that.** `deliverBytes` writes the bytes with
   `workbenchStore.createFile` at `app/lib/media/tasks.ts:186` and calls
   `refreshWorkingCopySoon` at `:222` — ~25s after the checkpoint, per that call site's own comment.
3. **Only the SERVER copy is topped up.** `app/lib/persistence/refresh-working-copy.ts` is the whole
   mechanism: `push()` (`:51`) reads the current local snapshot (`:71`) purely to **borrow its
   `seq`/`messageId`** and then calls `writeWorkingCopyFromStore(pid, current.seq, current.messageId)`
   (`:90`). **It never writes a local snapshot.** Grep confirms `refreshWorkingCopySoon` has exactly
   **one production call site** — `tasks.ts:222`.
4. **On reload the local copy wins.** `selectMountSource` (`app/lib/persistence/mount-source.ts:90`)
   branches on `hasLocal = localSeq !== undefined` (`:91`) — *presence*, not freshness — at `:99`,
   `:126`, `:136` and the fallthrough at `:181`. Its doc comment states the rule deliberately; `seq` is
   a per-browser counter, so it is correct and **the fix must not touch it**.
5. **The restore then DELETES the late files.** `useChatHistory.ts:645` restores with
   `protect: protectNothing` (`restore-plan.ts:109` — `() => false`); `planRestore`
   (`restore-plan.ts:64`) computes `toDelete` as live-files-minus-incoming-minus-protected.
   `restore-plan.spec.ts:138` already pins that `.env` is deleted under `protectNothing`.

**The destructive branch always runs on this platform.** `decideLiveSandboxIsTruth`
(`mount-source.ts:207`) requires `bootRestoredFilesystem`, which is hard-coded `false` on Nodepod
(`app/lib/sandbox/nodepod-provider.ts:833`) and WebContainer (`webcontainer-provider.ts:72`), and
`ENABLED_SANDBOX_PROVIDERS = ['nodepod']`. So the warm-sandbox escape at `useChatHistory.ts:606-634`
can never open here, and every ordinary refresh takes the `protectNothing` restore at `:645`.

### The wider hole — nothing but media triggers a top-up at all

Confirmed by grep and by reading each path:

| Mutation | Reaches | Path |
|---|---|---|
| Generation end | local + server | `checkpointProject` (`useChatHistory.ts:2037`, `:2057`) |
| **Media delivery** | **server only** | `tasks.ts:222` → `refresh-working-copy.ts:90` |
| **Manual editor save** | **neither** | `Workbench.client.tsx:338` → `workbench.ts:373` → `workbench.ts:351` → `files.ts:677`. Writes the sandbox FS + the map and stops. `#modifiedFiles` (`files.ts:151`) is diff-tracking for the LLM context, cleared wholesale by `resetAllFileModifications()` (`workbench.ts:414`) — it is not a dirty flag. |
| **Agent write landing after `onFinish`** | **neither** | `recordAgentWrite` (`files.ts:661`) is map-only by design. |
| **File-tree create / delete / folder** | **neither** | `files.ts:1291 / 1371 / 1348`. Only `deleteFile` persists anything, and only the deleted-paths list (`:1392`). |
| **Media delivered before the first checkpoint** | **neither** | `refresh-working-copy.ts:77-79` returns early — no seq to borrow. |

That table is the "edits on source files are GONE" half of the report, and it is why the fix is a
**trigger set** plus a **top-up that writes both copies**, not a one-line change to the media path.

### Two findings the source review added

**A. Duplicating `messageId` breaks §4.12 "Restore to after this change" — silently, with wrong bytes.**
`selectRestoreTarget` (`app/lib/persistence/restore-target.ts:32`) is
`snapshots.findIndex((s) => s.messageId === messageId)` over an **oldest-first** list. A top-up
checkpoint must carry the previous checkpoint's `messageId` (see C below), which creates two
checkpoints matching one message. `findIndex` returns the **first** — the pre-top-up one — so *"restore
to after this change"* would restore the state **without** the images that turn produced. That file's
own header calls this the worst bug the feature can have. `'before'` mode stays correct (it wants the
checkpoint *preceding* the first match). **T2 fixes this before any duplicate can exist.**

**B. A naive append evicts the undo history.** `createLocalSnapshot` trims to
`MAX_CHECKPOINTS_PER_PROJECT = 20`, oldest first, inside the write transaction
(`local-snapshots.ts:180-187`). One appended checkpoint per media burst is fine; one per 4-second
editor-save window is not — a ten-minute editing session would evict every generation checkpoint and
leave §4.12 undo pointing only at auto-saves. **T4 bounds it to at most one top-up checkpoint per real
checkpoint by amending its own.**

**C. Three invariants the fix must not trip**, each failing silently:

- **`messageId` must ride along.** `useChatHistory.ts:615` and the working-copy branch's comment at
  `:678-684` record that a snapshot which cannot say which turn it contains makes `checkUnappliedTurn`
  re-offer the §4.5.4c apply dialog *forever*. A top-up with no `messageId` becomes the current
  snapshot and reintroduces that loop.
- **Strict serialization is mandatory for anything a `protectNothing` restore will read.**
  `files.ts:996-1008` states it: non-strict `serializeFiles` *omits* unreadable binaries, and a local
  checkpoint is restored as the whole truth — so a lax top-up would arrange for `havok.wasm` to be
  deleted on the next reload. That is the same defect wearing the fix's clothes.
- **Never rewrite a checkpoint the pointer is parked on.** After a §4.12 undo,
  `Messages.client.tsx:211` parks `currentSnapshotId` on an *older* snapshot. An in-place rewrite of
  "the current snapshot" would therefore overwrite the user's undo target with the state they undid
  from. T4's amend is guarded to the newest-and-current top-up row only, for exactly this reason.

### Why append-then-amend, and not the findings' "rewrite in place, same seq"

The findings recommended rewriting the current checkpoint in place at the same `seq`. That is rejected
as the *primary* mechanism for three reasons found in source:

- `local-snapshots.ts:24-25` states **"The history is append-only… There is no delete-one API,
  deliberately."** A blanket in-place rewrite contradicts a written invariant rather than amending it.
- It rewrites history whenever the pointer is parked on an old snapshot (C above).
- **The seq must move.** `unsavedWork = hasLocal && localSeq > (syncedSeq ?? -1)`
  (`mount-source.ts:92`). If a project was synced at seq N and a late file is folded into seq N, the
  chip reports "everything saved" while a genuinely unpushed file exists. Allocating a new seq makes
  `unsavedWork` true *for free*, which is the truthful answer.

So: **append a real checkpoint** (T3), then **amend that top-up checkpoint in place on subsequent
top-ups** (T4) — narrowly, only when it is the newest row, is the current pointer, and is marked as a
top-up. The amend keeps its own `seq`, so the trim no-ops (row count unchanged) and no counter is burnt.

### Why `protectNothing` stays

The findings flagged it for review. Recommendation: **keep it, and record the decision.**
`Messages.client.tsx:201-209` documents what a superset-only restore costs — undoing past the
generation that added `Boss.ts` left `Boss.ts` on disk, i.e. the undo silently did not undo.
`protectNothing` is correct *given a complete checkpoint*; the defect was the checkpoint being
incomplete, which is what this plan fixes. Changing the protect function would trade a data-loss bug
for a deletions-don't-stick bug and leave the real cause standing. No code task; recorded in T8.

### Files this plan touches

| File | Why |
|---|---|
| `app/lib/persistence/top-up-plan.ts` *(new)* | The pure decision — what a top-up should write, and when it must not run. |
| `app/lib/persistence/restore-target.ts` | Finding A — last-match for `'after'`. |
| `app/lib/persistence/refresh-working-copy.ts` → `refresh-saved-copies.ts` | Becomes the both-copies top-up; name must follow behaviour. |
| `app/lib/persistence/local-snapshots.ts` | New `amendLocalSnapshot` + the `kind: 'top-up'` marker. |
| `app/lib/stores/workbench.ts` | Editor-save and file-tree triggers; the restore-in-flight suppression flag. |
| `app/lib/media/tasks.ts` | One import/name update. |
| `SPEC.md` | §4.5.4c, §4.12, §4.16, and a new `### §8i` decisions log. |

### SPEC.md alignment

Conforms to, and is constrained by:

- **§4.5.4c** (`SPEC.md:863`) — the single server working copy. Invariant 4 (`:878`) reads *"Written on
  the same trigger as a local checkpoint. **One concept, one moment.** A second, independent 'when do we
  save' rule is how two writers end up disagreeing."* **The shipped code violates this** — the media
  top-up is precisely a second, independent save rule that writes only one of the two copies, and the
  two copies duly disagree. This plan restores the invariant rather than deviating from it.
  ⚠️ `SPEC.md:865` still reads **"Status: DECIDED, NOT YET BUILT"** while `working-copy-writer.ts`,
  `working-copy.worker.ts`, `app/lib/.server/projects/working-copy*.ts` and their specs all exist —
  stale, and a T8 write-back item.
- **§4.5.4b** (`SPEC.md:839`), deviation 3 (`:849`, order by `seq` never `createdAt`) and deviation 7
  (`:853`, a restore deletes, `protect` is required) — both preserved unchanged.
- **§4.12** (`SPEC.md:1326`) — *"the restore **is itself checkpointed** … Nothing is ever destroyed."*
  T2 makes the selection honest under duplicate `messageId`s; T4 keeps the 20-slot history from being
  crowded out by auto-saves.
- **§4.16** (`SPEC.md:1440`). ⚠️ `SPEC.md:1448` claims generated bytes *"ride the repo on save (§4.5.4b:
  **the platform stores no copy**)"* — false since §4.5.4c shipped; T8 corrects it.
- **`spec/binary-files.md`** — byte identity across the checkpoint round trip
  (`local-snapshots.ts:18-22`, pinned by `local-snapshots.spec.ts:93`); the on-loan-bytes rule at
  `files.ts:970-983`. Nothing here reads or transfers bytes directly; the top-up reuses
  `serializeFiles` and `writeWorkingCopyFromStore` unchanged.
- **`spec/fail-loud.md`** — a top-up is best-effort by design (`refresh-working-copy.ts:100-102`) and
  must stay silent to the user, but every skip/failure must be logged with its reason. The one loud
  signal it may set is `unsavedWork`.

**No conflict with SPEC.md was found.** Every change either implements an existing invariant more
faithfully or corrects a spec statement that the code has already outgrown.

### Conventions in force

- Co-located `*.spec.ts` beside the module. Runner: `pnpm test` (vitest). **Never** put a spec in
  `app/routes/`.
- Anything that overwrites the user's project is a **pure function with exhaustive tests**
  (`CLAUDE.md:223`) — exemplars: `restore-target.spec.ts`, `restore-plan.spec.ts`,
  `working-copy-size.spec.ts`.
- **Mutation verification is hand-discharged and recorded in prose**: revert the guard, assert exactly N
  named tests fail, write the count into the spec header and the SPEC entry.
- **CONTROLS**: every suite here needs a test proving it would still fail if the behaviour were simply
  deleted — precedent `working-copy-detach.spec.ts:158-162`, `mount-source.spec.ts:407`.
- Gates before any box is checked: `pnpm typecheck && pnpm lint:fix && pnpm lint && pnpm test`.
- `CLAUDE.md:315` — **drive the real UI**; every defect in this area historically lived in the wiring
  the unit tests drove around. T7 is not optional.

---

## Tasks

- [x] **T1** — Pure top-up decision (`planTopUp`)
  - Files: `app/lib/persistence/top-up-plan.ts` *(new)*, `app/lib/persistence/top-up-plan.spec.ts` *(new)*
  - Details: Extract the "should we top up, and what do we write?" decision as a pure function so it can
    be tested exhaustively (`CLAUDE.md:223` — this decides what gets written over the user's project).
    Signature roughly:
    `planTopUp(facts: { hasProject: boolean; hasDb: boolean; streaming: boolean; restoreInFlight: boolean; current?: { id: string; seq: number; messageId?: string; kind?: 'top-up'; isNewest: boolean; isCurrent: boolean } }): TopUpPlan`
    with `TopUpPlan = { action: 'defer' } | { action: 'skip'; reason: string } | { action: 'append'; messageId?: string } | { action: 'amend'; snapshotId: string; seq: number; messageId?: string }`.
    Rules, each with the reason in a comment above its test: `streaming` → `defer` (never serialize
    mid-stream — `refresh-working-copy.ts:58-64`); `restoreInFlight` → `skip` (a restore's own deletes
    and writes must not be captured as a user checkpoint — see T6); no project / no db → `skip`;
    no current snapshot → `append` with no `messageId` (this closes the media-before-first-checkpoint
    hole at `refresh-working-copy.ts:77-79`); current snapshot is a `'top-up'` **and** newest **and**
    current → `amend` carrying its `id`, `seq` and `messageId`; otherwise → `append` carrying the
    current snapshot's `messageId` forward. **`amend` requires all three conditions** — a parked pointer
    (post-undo, `Messages.client.tsx:211`) or a non-newest row must fall through to `append`.
  - Acceptance: `top-up-plan.ts` exports a function with no imports from stores, IndexedDB or the DOM.
    `top-up-plan.spec.ts` covers every rule above including all three ways `amend` degrades to `append`,
    plus a **CONTROL** proving a function that always returned `{action:'append'}` fails the suite.
    Mutation-verified: dropping the `isNewest` condition fails ≥1 named test; dropping the `streaming`
    check fails ≥1; record both counts in the spec header. Gates green.

- [x] **T2** — `selectRestoreTarget` must pick the LAST checkpoint for a message
  - Files: `app/lib/persistence/restore-target.ts`, `app/lib/persistence/restore-target.spec.ts`
  - Details: With top-up checkpoints (T3) two rows can carry one `messageId`.
    `restore-target.ts:32`'s `findIndex` returns the oldest, so `mode: 'after'` would restore the state
    *before* the late files that turn produced — wrong bytes, silently, on the §4.12 undo button.
    Change `'after'` to resolve the **last** index matching `messageId`; leave `'before'` resolving the
    checkpoint preceding the **first** match (that is genuinely "the state the previous generation left
    behind"). Do not use `Array.prototype.findLastIndex` unless `tsconfig`'s `lib` already includes
    ES2023 — a reverse `for` loop is fine and has no config coupling. Update the file's header to state
    both rules and why they differ. This must land **before** T3, or duplicates exist against the old
    selection.
  - Acceptance: new tests — three checkpoints where the middle two share a `messageId`: `'after'`
    returns the **newer** of the pair; `'before'` returns the checkpoint preceding the **older** of the
    pair; a single-match history behaves exactly as before (regression control); `'nothing-before'` and
    `'no-checkpoint-for-message'` unchanged. Mutation-verified: reverting `'after'` to `findIndex` fails
    exactly the new duplicate test(s) and nothing else — record the count. Gates green.

- [x] **T3** — The top-up writes BOTH copies; rename the module to match
  - Files: `app/lib/persistence/refresh-working-copy.ts` → `app/lib/persistence/refresh-saved-copies.ts`,
    `app/lib/persistence/refresh-working-copy.spec.ts` → `refresh-saved-copies.spec.ts`,
    `app/lib/media/tasks.ts`
  - Details: Rename `refreshWorkingCopySoon` → `refreshSavedCopiesSoon` and the file with it — after this
    task the module writes the local checkpoint too, and a name asserting otherwise is how the next
    reader gets it wrong. Update the sole production call site (`tasks.ts:222`) and the spec.
    In `push()`: consult `planTopUp` (T1) instead of the inline `streaming` / `!current` checks; keep the
    existing `defer` behaviour (re-arm the same debounce). On `append`/`amend`:
    1. Serialize **strictly** — reuse `runCheckpointSerialize({ serialize: () => workbenchStore.serializeFiles({ strict: true }) })`
       (`checkpoint-run.ts:107`) rather than re-deriving a timeout/retry policy; pass **no**
       `waitForWrites` (the top-up already runs post-stream). A non-`ok` outcome **skips the local write
       entirely, leaving the existing checkpoint untouched**, and logs the reason — a lax map restored
       under `protectNothing` deletes the binary it failed to read (`files.ts:996-1008`).
    2. `append` → `createLocalSnapshot(db, { projectId, files, messageId, label, kind: 'top-up' })`
       (the `kind` field lands in T4; if T4 has not run yet, add the optional field here and leave the
       amend path for T4). Carry the previous checkpoint's `messageId` forward — a top-up that cannot
       name its turn re-opens the §4.5.4c dialog loop (`useChatHistory.ts:678-684`).
       `label` is a small fixed set (e.g. `'Generated assets'` / `'Unsaved changes'`), **never** the
       free-form `reason` string — that string is a log line, not §4.12 history copy.
    3. Wrap the local write in try/catch: `QuotaExceededError` is a real outcome on a 5–10MB map
       (`local-snapshots.ts:27-34`) and must not prevent the server top-up.
    4. Then write the server copy with the **new** seq: `writeWorkingCopyFromStore(pid, snapshot.seq, snapshot.messageId)`.
       Keep the existing result handling verbatim.
    5. `unsavedWork.set(true)` after a successful local write — a late file is genuinely unpushed, and
       the mount-time computation (`mount-source.ts:92`) will now agree because the seq moved.
    Leave `selectMountSource`, `protectNothing`, and `writeWorkingCopyFromStore` **unchanged**.
  - Acceptance: `refresh-saved-copies.spec.ts` (extending the existing cases, which must still pass):
    a delivery after a checkpoint writes a **local snapshot** and then a server copy **at the new seq**;
    a strict-serialize failure writes **no** local snapshot and leaves the previous one intact; a
    delivery with **no** prior checkpoint now creates one (previously a silent no-op — assert the old
    `:72` no-op test is replaced deliberately, not deleted); streaming still defers and a burst still
    coalesces to one write; a local-write throw still lets the server write proceed. A **CONTROL** proves
    the server copy still carries the real files (a top-up that wrote only locally is the mirror bug).
    `grep -rn "refreshWorkingCopySoon" app` returns nothing. Mutation-verified: removing the
    `createLocalSnapshot` call fails ≥2 named tests. Gates green.

- [x] **T4** — Amend the previous top-up instead of appending a new one
  - Files: `app/lib/persistence/local-snapshots.ts`, `app/lib/persistence/local-snapshots.spec.ts`,
    `app/lib/persistence/refresh-saved-copies.ts`
  - Details: Bound the history churn (Finding B): at most **one** top-up checkpoint per real checkpoint.
    Add `kind?: 'top-up'` to `LocalSnapshot` (optional field — IndexedDB stores records structurally, so
    no `db.ts` version bump; confirm no schema migration is required and say so in the task report) and
    export `amendLocalSnapshot(db, { snapshotId, files })`. It must:
    - run in **one** readwrite transaction over both stores, like `createLocalSnapshot:150`;
    - `get` the row, **refuse** (return `false`, no write) unless it exists, `kind === 'top-up'`, it is
      the highest `seq` for that project, and it is the project's `currentSnapshotId` — the three guards
      from T1, re-asserted at the store because that is where they are load-bearing;
    - `put` the row back with the **same `id`, same `seq`, same `messageId`**, new `files`, and refreshed
      `createdAt`; **never** touch `nextSeq` (advancing it burns a counter; reusing it creates two rows
      with one `seq`, which is the tie `local-snapshots.ts:57-65` says the ledger already paid for);
    - leave the trim a no-op (row count unchanged — do **not** implement this as delete-then-create,
      which on a project at 20 checkpoints evicts the oldest on every editor save).
    Amend the module header: the history stays append-only for *checkpoints*; a top-up row is amendable
    in place under exactly these guards, and here is why. Then wire `refresh-saved-copies.ts` to the
    `amend` branch of `planTopUp`, falling back to `append` when `amendLocalSnapshot` returns `false`.
  - Acceptance: `local-snapshots.spec.ts` gains: amend replaces files and keeps `id`/`seq`/`messageId`;
    `nextSeq` is unchanged after an amend (assert the *next* `createLocalSnapshot` gets the seq it would
    have got anyway); amend refuses a row that is not `kind:'top-up'`; refuses a row that is not the
    newest; refuses a row that is not `currentSnapshotId` (**the post-undo case — assert the parked
    older snapshot's files are byte-identical afterwards**); byte identity of a binary across
    create→amend→read (`local-snapshots.spec.ts:93`'s round-trip pattern); the 20-checkpoint trim is
    unaffected by repeated amends. Plus a **CONTROL**: a repeated *append* on the same fixture does grow
    the history, proving the amend test is measuring something. Mutation-verified: dropping the
    `isCurrent` guard fails the post-undo test; dropping the `kind` guard fails ≥1. Gates green.

- [x] **T5** — A manual editor save schedules a top-up
  - Files: `app/lib/stores/workbench.ts`, `app/lib/stores/workbench-save-trigger.spec.ts` *(new, or
    extend the nearest existing workbench spec)*
  - Details: `WorkbenchStore.saveFile` (`workbench.ts:351`) writes the sandbox FS and the map and stops —
    a manual save reaches **neither** persistence store, which is the "edits on source files are GONE"
    half of the report. After the `unsavedFiles` update (`:367-370`), call `refreshSavedCopiesSoon('editor save')`.
    `saveAllFiles` (`:400`) loops `saveFile`, so the 4s debounce coalesces it — do not add a second call
    there. Wire it at the **`WorkbenchStore`** level only: `FilesStore.saveFile`/`deleteFile`/`createFile`
    are reused by `restoreFiles` (`files.ts:1220`) and by the action runner, so a trigger inside those
    primitives would fire during a restore (T6) and on every agent write.
  - Acceptance: a test drives `workbenchStore.saveFile` with the persistence module mocked and asserts
    exactly one scheduling call; `saveAllFiles` over N files still results in one *written* copy (assert
    via the debounce, or assert N schedule calls collapse — whichever the existing spec style supports);
    a **CONTROL** asserting the file is still written to the store/FS (a "fix" that stopped saving would
    otherwise pass). Gates green.

- [x] **T6** — File-tree mutations trigger a top-up; a restore never does
  - Files: `app/lib/stores/workbench.ts`, `app/lib/persistence/top-up-plan.ts` (wiring only),
    `app/lib/stores/files.ts` (flag only), plus the relevant spec files
  - Details: Two halves, and the second is what makes the first safe.
    (a) A file created, deleted or renamed from the file tree after the last checkpoint has the same
    fate as a media file — and a **deletion** is the mirror bug: on reload the restore brings the file
    back, so the delete silently did not stick. Route the user-initiated tree mutations through
    `WorkbenchStore` wrappers that call `refreshSavedCopiesSoon` after the store mutation.
    (b) `restoreFiles` writes and deletes files as its normal operation (`files.ts:1120`, `:1220`), and
    `mountProjectFiles` runs it on every open. Without suppression, T5/T6(a) would schedule a top-up
    that checkpoints the restore itself — appending a duplicate checkpoint on every mount, and after a
    §4.12 undo appending a checkpoint of the undone state. Add a `restoreInFlight` signal set around
    `FilesStore.restoreFiles` (and the mount sequence), read into `planTopUp`'s facts (T1 already
    accepts it), so a top-up during a restore **skips**. Prefer a single exported flag/atom over a
    parameter threaded through call sites — one writer, one reader.
  - Acceptance: a delete from the tree schedules a top-up and the deletion survives a simulated
    reload-restore (assert the deleted path is absent from the checkpoint that would be restored);
    a create schedules one; **`workbenchStore.restoreFiles` over a map containing creates *and* deletes
    schedules ZERO top-ups**, and the flag is cleared even when the restore throws (assert with a
    rejecting write); a **CONTROL** proving the suppression is scoped — a save immediately *after* the
    restore completes does schedule one. Mutation-verified: removing the suppression fails the
    restore test. Gates green.

- [x] **T7** — Drive the real UI and prove the loss is gone
  - Files: none (verification); write findings into `_specs/late-write-loss_findings.md` under a
    `## Verified` section
  - Details: `CLAUDE.md:315` — every defect in this area historically lived in the wiring the unit tests
    drove around, so this task is not optional and its evidence must be verbatim. Using chrome-devtools
    against `pnpm dev`, on a real project: (1) generate an image, wait for delivery, **hard reload**, and
    confirm the file is still in the tree and still renders in the preview; (2) edit a source file, save,
    reload, confirm the edit survives; (3) delete a file from the tree, reload, confirm it stays
    deleted; (4) §4.12 **undo** to before a generation and confirm it restores the correct state — with
    the media top-up in the history, "restore to after this change" must land on the state **with** the
    images (Finding A); (5) confirm the §4.5.4c apply dialog does **not** re-appear on the next mount
    (the `messageId` carry-forward); (6) read the IndexedDB `projectSnapshots` rows and confirm repeated
    editor saves produce **one** amended top-up row, not N appended ones. Record the actual row counts,
    seqs and file counts — numbers, not narration. Clean up any test artifacts from the project
    afterwards.
  - Acceptance: all six scenarios pass with the observed values written into the findings file. Any
    scenario that fails leaves this box unchecked and the failure reported — a partial pass is a FAIL.
    No console errors introduced. Gates green.

- [x] **T8** — Update SPEC.md to match what was built
  - Files: `SPEC.md`
  - Details: Follow SPEC.md's "How to update this spec" contract — **replace/merge** current-state
    sections, **append** to a decisions log.
    1. **§4.5.4c** (`SPEC.md:863`): flip the stale `Status: DECIDED, NOT YET BUILT` at `:865` to BUILT
       with the date (the code shipped long ago). Amend invariant 4 (`:878`) to state what "the same
       trigger" now means: a top-up writes **both** copies, and a top-up is a real checkpoint — that
       invariant was being violated by the shipped media path, and this is the fix, not a deviation.
    2. **§4.12** (`SPEC.md:1326`): record that the history can contain top-up checkpoints, that
       `selectRestoreTarget` resolves `'after'` to the **last** checkpoint for a message and why (T2),
       and that at most one top-up row exists per real checkpoint (T4).
    3. **§4.16** (`SPEC.md:1448`): correct *"the platform stores no copy"* — false since §4.5.4c.
    4. **§4.5.4b** deviation list (`:847-858`): add a deviation only if the fix genuinely adds one;
       otherwise say in the T8 report that it does not, rather than padding the register.
    5. New **`### §8i Decisions log (late-write durability — newest last)`**, inserted after `SPEC.md:1750`
       and before the `---` preceding `## 9. Milestones`, matching §8h's format (an ordered `1.` list,
       each entry a **bolded claim carrying its date and file**, then prose). Entries to record, at
       minimum: the append-then-amend choice and why in-place-at-the-same-seq was rejected (three
       reasons, incl. `unsavedWork` going silently false); Finding A (`findIndex` returning the oldest
       match would have restored wrong bytes from the §4.12 undo button); **`protectNothing` was
       examined and deliberately kept**, with the `Boss.ts` reasoning; the trim/eviction hazard T4
       exists to prevent; and the mutation counts from T1–T6.
    Also update `CLAUDE.md`'s persistence block if any rule there is now stale.
  - Acceptance: SPEC.md describes the shipped behaviour with no section contradicting the code; the two
    stale claims (`:865`, `:1448`) are corrected; §8i exists with the required entries in the house
    format; no existing decisions-log entry was deleted or reworded. No new dependencies were
    introduced (confirm explicitly). Gates green. *(No test surface — the acceptance verifier alone
    gates this task.)*

---

## How to execute this plan

Each task above is a checkbox. To implement:
- Run a single task with the bt-execute command (e.g. `bt-execute <this-file> T<n>`), run every remaining task in order with `bt-execute <this-file> ALL` (resumable — it skips tasks already checked), or implement the whole plan from a prompt like "implement the plan at <this-file>".
- Work the tasks top to bottom unless a task notes a different dependency order.
- When a task is fully implemented and its **Acceptance** criteria are met, mark it complete by editing this file and changing that task's `- [ ]` to `- [x]`.
- Stop and report if a task cannot be completed. Do NOT check a box for partial, skipped, or unverified work.
