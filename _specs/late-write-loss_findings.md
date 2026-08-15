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
