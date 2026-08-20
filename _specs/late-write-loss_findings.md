# Late writes are lost on reload — root cause (investigated 2026-08-15)

> Reported by the owner: *"right after image generation and you dont save … sometimes any generated
> content, like images and edit on source files are GONE or LOST… they were created and showing, but a
> refresh LOSES them."*

**Confirmed. This is a real defect, and it is an active DELETE, not merely a failure to save.**

## The chain (every link verified in source)

1. **The local checkpoint is written at generation END.** `checkpointProject`
   (`useChatHistory.ts:2037`) calls `createLocalSnapshot(db, { projectId, files, messageId })` with the
   file map *as it stands at that moment*.
2. **§4.16 media is async-enqueue, so renders land AFTER that.** The tool returns the destination path
   immediately and the bytes arrive ~25s later (`lib/media/tasks.ts:222`). The checkpoint therefore
   contains `<img src="/assets/generated/hero.jpg">` and **not** `hero.jpg`.
3. **Only the SERVER copy is topped up.** `refreshWorkingCopySoon` → `push()` calls
   `writeWorkingCopyFromStore` and nothing else. Grep for `createLocalSnapshot(` confirms its callers
   are: the apply dialog, GitHub sync, the divergence dialog, repo load, "Opened", import, and
   `checkpointProject`. **Nothing writes a local snapshot when a late render lands.**
4. **On reload the LOCAL copy wins, and the server copy is never consulted.** `selectMountSource`
   returns `{ source: 'local' }` whenever `hasLocal`; its own doc comment states the rule outright —
   *"this decision never ranks the working copy against a local copy: it is consulted only when this
   browser has NOTHING"*. That rule is deliberate and correct for its stated reason (`seq` is a
   per-browser counter), which is exactly why the fix must not be "compare seqs".
5. **The restore then DELETES the late files.** `useChatHistory.ts:645` restores with
   `protect: protectNothing` — a local checkpoint is treated as the whole truth — and `planRestore`
   computes `toDelete` = live files absent from the incoming map, minus protected. `protectNothing`
   protects nothing.

**Every reload gets a fresh pod** (observed: `podc99557ad → pod3e93ad5e → pod5c88a43c → podf62b610f`),
so `bootRestoredFilesystem` is false, `decideLiveSandboxIsTruth` returns false, and step 5 runs. The
warm-sandbox branch that would have saved the files is not taken on an ordinary refresh.

## Scope — this is wider than images

Anything written after the last checkpoint dies the same way: generated media, an agent write that
landed after `onFinish`, and **manual editor edits made after the last generation** (no checkpoint
fires on an editor save). That matches the "edits on source files are GONE" half of the report.

## Measured

- Local checkpoint for `prj_20260815035847_6bkfk4jp`: **seq 0, 76 files**, no `assets/generated`.
- Server working copy on disk: `.data/storage/working/…json` — **seq 0, 76 files**, mtime 17:59 the
  previous day, no `assets/generated`.
- A file written the way a media delivery writes one was present in the store and in **neither** copy.

## ⚠️ One finding RETRACTED

An earlier pass concluded that `projectId` was unset and therefore `refreshWorkingCopySoon` silently
no-ops for everyone. **That was an artifact of the investigation, not a product defect.** Reading the
stores via `await import('/app/lib/persistence/useChatHistory.ts')` in the page console returns a
**second module instance** whose atoms are fresh — `description` and `chatId` also read unset while the
header was plainly rendering the project title. Writes still appeared in the UI because the *sandbox
FS* is the shared substrate and the app's own watcher picked them up, which made the duplicate look
shared. **The server top-up is NOT proven broken**; steps 1–5 above are proven, and none of them depend
on module identity.

## The fix (recommended)

`refreshWorkingCopySoon`'s `push()` already borrows the current checkpoint's `seq` and `messageId` for
the server copy. It should **also rewrite that local checkpoint in place, same seq**, from the current
store — the local copy is the one that actually decides what a reload restores, so topping up only the
remote one fixes the rarer case (crash / new device) and leaves the common one (refresh) broken.

That keeps the existing seq semantics intact — a late asset is "the same checkpoint, finally complete",
which is the reasoning already written into that module's header — and needs no change to
`selectMountSource`, whose per-browser-counter rule stays correct.

Two adjacent things worth deciding at the same time:

- **an editor save should mark the project dirty for the same top-up**, or manual edits keep dying on
  refresh even after media is fixed;
- **`protectNothing` deserves a second look.** Deleting live files because a checkpoint predates them
  is the destructive half; a restore that is a strict superset would fail safe. It exists to make
  deletions stick, so this is a real trade, not an oversight.


---

## Verified

Live drive of the real UI (Chrome via chrome-devtools) against `pnpm dev`, **2026-08-15**, after T1–T6.
Project `prj_20260815130148_l9tfd8y0` ("Blank Canvas"), Nodepod sandbox. Every number below is read from
the live IndexedDB `projectSnapshots` / `projectState` rows or from the running preview.

⚠️ **Recorded in the order the drive actually ran, which is NOT the order T7 numbers the scenarios.**
The first write-up of this section presented them in T7's order and back-filled a starting file count
from the wrong step, producing a transition (`78 → 75` for a single deletion) that cannot be true. The
endpoints were real; the arrow between them was not. Order matters here because the counts only
reconcile in sequence.

**Drive order:** baseline → editor saves → delete → reload → image → reload → restore → post-undo save →
reload.

**Baseline after creation:** 1 row — `seq 0`, `kind: null`, `messageId 2-1786798909038`, **76 entries**,
`nextSeq 1`. (`serializeFileMap` emits folder dirents as well as files, so these counts are map entries,
not file counts — which is why one image adds 3.)

### 6. Repeated editor saves produce ONE amended row, not N ✅ (Finding B)

Four saves to `src/pages/Home.tsx` through the real editor + Save button. The first **appended** the
top-up row (`seq 1`, `kind: 'top-up'`, label `Unsaved changes`, `messageId 2-1786798909038` carried
forward from `seq 0`, 76 entries). The next three **amended it**: row count stayed **2**, the row kept
`id snp_msue1t65_6yrjxc5z` and `seq 1`, `nextSeq` stayed **2** (no counter burnt), `createdAt` advanced
`13:04:59.885Z → 13:05:37.362Z` (37.5s), and the content was the newest edit. Appending instead would have
pushed four rows through the twenty-slot history for one minute of typing.

### 3. A file-tree deletion stays deleted ✅

Deleted root `README.md` (tree count 3 → 2). The top-up row went **76 → 75 entries** with
`/home/project/README.md` absent, while `seq 0` still lists all three READMEs. Row count stayed **2** —
amended, not appended. After a hard reload the tree count is still 2: the deletion stuck, i.e. the
mirror bug (a deleted file returning from a stale checkpoint) does not occur.

### 2. A manual editor save survives a hard reload ✅

After that reload `src/pages/Home.tsx` begins `// T7-SAVE-3 / // T7-SAVE-2 / // T7-SAVE-1 /
// T7-EDIT-SURVIVES-RELOAD`. Pre-fix these reached neither persistence store and were overwritten by the
`protectNothing` restore.

### 1. A generated image survives a hard reload ✅

Media panel → Nano Banana 2 Lite → `public/assets/generated/red-circle-msuece.jpg`, 8 credits, delivered
13:13:22.982Z. The top-up row went **75 → 78 entries** (+3: the file plus the new `public/assets` and
`public/assets/generated` folder dirents) and carried the image as `isBinary: true`, `size: 362314`,
base64 length **483088** — exactly `ceil(362314/3)*4`, i.e. byte identity preserved through the
checkpoint codec. It was **absent from `seq 0`**, which is the pre-fix state that used to be restored
over it.

After a hard reload the file is in the tree, and the running preview serves it:
`GET …/5173/assets/generated/red-circle-msuece.jpg` → **200, `image/jpeg`, 362314 bytes**, JPEG magic
`FF D8 FF`, byte-count identical to the checkpoint. This is the reported defect, gone.

⚠️ Scope of that last claim: this is proof the preview **serves the exact bytes**, which is byte-level
evidence of survival. A visual render was not screenshotted on this drive.

⚠️ Three earlier attempts were refused by the provider and each was **refunded in full**, verified in
the ledger (debits 24 / 15 / 29, all returned, balance back to 25800; the successful 8-credit task
correctly not refunded). `med_msue53s0` (nano-banana-2) reached KIE and failed at poll time — *"The
provider reported the generation failed."*; `med_msueat0h` (flux-2-pro) and `med_msuebcee`
(seedream-5-pro) were refused at dispatch — *"provider refused deterministically, not retrying"*.
External to this change, and it incidentally confirmed the §4.16 refund path end to end.

### 4. §4.12 "restore to after this change" lands on the state WITH the image ✅ (Finding A)

Two rows shared `messageId 2-1786798909038`: `seq 0` (76 entries, no image, README present) and `seq 1`
(top-up, 78 entries, image present, README deleted). Clicking **"Restore the project files to how they
were AFTER this change"** → *"Restored the project files to the checkpoint taken after this change."*
and the project kept the image, kept the README deleted, and kept the edits. The pointer landed on
`snp_msue1t65_6yrjxc5z` = **`seq 1`, the LAST match**. Pre-T2 `findIndex` would have selected `seq 0`
and silently destroyed the image and every hand-edit — the wrong-bytes failure `restore-target.ts`'s
header calls the worst bug the feature can have. Because the two candidate rows differ in three visible
ways, a wrong pick could not have looked like a no-op.

The restore was itself checkpointed (`seq 2`, `kind: null`, 78 entries) — §4.12's "nothing is ever
destroyed" — leaving the pointer parked on `seq 1` while `seq 2` is newer.

**The post-undo amend guard, verified on that live state:** the next editor save (the fifth, and the
only one after the restore) **appended `seq 3`** (`kind: 'top-up'`) instead of amending the parked
`seq 1`. `seq 1`'s `createdAt` stayed `13:13:27.698Z` and its `Home.tsx` does **not** contain the new
edit — the user's undo target was not overwritten with the state they had undone from.

### 5. The §4.5.4c apply dialog does not re-appear ✅ (with a stated limit)

Reload after all of the above: **no dialog**, and no "apply" copy anywhere in the document. The
mechanism is corroborated rather than merely asserted — scenario 4 shows `seq 0` and `seq 1` sharing
`messageId 2-1786798909038`, i.e. every top-up carried the id forward from the checkpoint it completes,
so `checkUnappliedTurn` sees a known turn rather than an unknown one.

⚠️ This is an observed ABSENCE with no positive control: no attempt was made to provoke the dialog on
this project, so the observation is also consistent with the dialog being unable to appear at all. The
carry-forward itself is pinned by `top-up-plan.spec.ts` and `refresh-saved-copies.spec.ts`.

### Final history

**4 rows** — `seq 0` (generation), `seq 1` (top-up), `seq 2` (restore), `seq 3` (top-up) — for one
creation, **five** editor saves, one delete, one image delivery and one restore. Every auto-save
collapsed into the top-up row beside its generation checkpoint; the only reason there are two top-up
rows is the restore between them, which is exactly the guard working.

### Console

No errors introduced. Two messages total: one `404` from a probe **this drive** issued against the wrong
origin, and the pre-existing `allow-scripts and allow-same-origin` iframe sandbox warning. The
`beforeunload` prompt fired as designed — `unsavedWork` is true (T3 sets it after a local top-up write — though note this project was never
linked, so it would read true at any seq; the prompt firing is not by itself evidence the top-up set it).

### Cleanup

The scratch project was deleted server-side (`DELETE /api/projects/…` → `{"ok":true}`) and its
IndexedDB rows removed (`projectSnapshots` and `projectState` both 0 for that id). No test artifacts
remain in the repo. (`_specs/t7-evidence/` predates this work — it belongs to the earlier
binary-media-viewer plan, committed in `6e6b681e`.)
