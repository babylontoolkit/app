# spec/local-project.md — The project lives on the user's disk (SPEC §4.5.4d)

> **Status: BUILT + DRIVEN LIVE 2026-09-15** (Chrome against the dev server, with an OPFS directory standing in for the picked folder — the native picker cannot be automated; results in `_specs/local-project_plan.md` T9). Owner ask: *"I JUST WANT THE PROJECT TO
> PHYSICALLY LIVE ON THE USERS HARD DISK FROM JUMP STREET IN SOME APP BUILD PROJECTS FOLDER and all projects
> get dumped in… NOT JUST LIVE IN THE VOLATILE SANDBOX FOR NODEPOD."* Plan: `_specs/local-project_plan.md`.

## What it is

The user picks ONE parent folder on their computer (Settings → Features → *Where your projects live*). From
then on every project they create or open here gets `<parent>/<slug>/` on disk, every change the agent, the
editor, undo, a pull, a media render or an import makes is written through as it lands, and opening the
project reads that folder FIRST — ahead of the browser checkpoint, the server recovery copy, the remix seed
and the repo. Edits made in VS Code on the same folder flow back in while the tab is open.

Nothing else moved. GitHub commit/pull, Share, Remix, Deploy, Export ZIP, undo and the crash-recovery copy all
read bytes through `FilesStore` / `sandbox.fs`, never from "where the project lives", so they are untouched
(verified against every byte-touching feature before building — the table is in the approved plan).

## The shape — a MIRROR beside Nodepod, not a fourth `SandboxProvider`

Nodepod stays the runtime: it runs `npm install`, Vite and the preview, which a folder on disk cannot. The
disk is a **persistence backing** that sits beside it:

- **out**: `LocalMirror` subscribes to `sandbox.watchPaths` — the same VFS-level stream that fills
  `FilesStore`, so every writer is covered without knowing the mirror exists;
- **in**: a mount reads the folder whole (`ProjectFolder.readTree` → `treeToSerializedFileMap`) and hands it
  to `restoreFiles` with `protectNothing`, i.e. the folder is the whole truth.

A fourth provider would have had to answer `spawn`/preview/`onServerReady` (the `SANDBOX_PROVIDER_TRAITS`
record forces it) for a thing that runs nothing, and `ENABLED_SANDBOX_PROVIDERS` is a deliberate wall. The
mirror touches no provider file and the seam scan is untouched.

**Vehicle: the browser's File System Access API.** Chromium only (Chrome, Edge, Brave, Opera). Safari and
Firefox cannot write to a picked folder; there the state is `unavailable`, the card says so, and the project
behaves exactly as before. Electron — already in the tree, real Node — is the way to every OS later, as a
second backend behind `LocalDirectoryHandle` (the interface declares its own types for that reason).

## Files

| File | Role |
|---|---|
| `app/lib/local-project/types.ts` | The interface. Declares its own handle types — no DOM/Electron type leaks past it. |
| `fsa-store.ts` | `ProjectFolder` over a handle: validated project-relative paths, read/write/remove/readTree, the marker; `findProjectFolder` / `createProjectFolder`. |
| `dir-name.ts` | Slug + `.btk-project.json` marker (pure). |
| `handles.ts` | The remembered PARENT handle (IndexedDB `btk-local-projects`, keyed by account), permission query/request, the picker, `isLocalFolderSupported`. |
| `scan.ts` | Disk tree → `SerializedFileMap` (sandbox-absolute keys, binaries base64), `sameBytes`. |
| `mirror.ts` | `LocalMirror`: coalesced, restore-aware, compare-before-write, LOUD, bounded retries. |
| `external-changes.ts` | `diffDiskIndex` (pure) + the stamp poll that copies VS Code edits into the sandbox. |
| `status.ts` | `localProjectState` + `describeLocalProject` (every UI string). |
| `index.ts` | The wiring: parent folder lifecycle, the permission gate, `openFolderForProject` / `readFolderForMount` / `attachFolder` / `ensureFolderForProject` / `reloadFromDisk`. |
| `memory-directory.ts` | The test double — performs every write and delete for real. |

Wired at: `mount-source.ts` (`hasLocalDir` → `disk`, ranked first), `useChatHistory.ts` (the `disk` branch;
`ensureFolderForProject` after every other mount), `Chat.client.tsx` (after the creation checkpoint),
`boot-progress.ts` + `BootScreen.tsx` (`disk-permission`), `FeaturesTab.tsx` (`ProjectsFolderCard`),
`OverflowMenu.client.tsx` (*Reload from disk*), `useSession.ts` (`startLocalProjectSync`).

## Never regress — each fails silently

1. **A folder is identified by its MARKER, never its name.** Two projects called "Kart Racer" on one machine
   are ordinary; mounting the wrong one puts someone's other game on screen and pushes it to this project's
   repo. `findProjectFolder` reads `.btk-project.json`; a same-named folder with another project's marker, or
   with no marker at all, is never adopted — the next free `slug-N` is created instead (Save-never-adopts).
2. **Paths are validated at the folder.** `splitRelativePath` refuses absolute paths and `.`/`..` segments.
   This module holds write access to a real directory; a sandbox path that escaped the project must not be
   able to write outside the folder the user chose.
3. **Bytes are copied before they are written** (`new Uint8Array(bytes)`): the provider's bytes are on loan
   (`spec/sandbox-seam.md`). The disk copy must not follow later mutations of the sandbox's own storage.
4. **A disk-sourced mount never rewrites itself.** The watcher replays the whole restore; events queued
   while a restore is in flight are COMPARED before writing, and the mirror starts with the stamps the mount
   just read. Without this every open rewrites the project (30 MB of media, silently, every time).
5. **An external edit never bounces back out.** The poll records the disk stamp and marks the path
   `expectEcho` BEFORE writing into the sandbox; the watcher's echo compares equal and skips. Without this
   the mirror writes the file back with a new mtime, the next poll reads that as another external change,
   and the loop never throws.
6. **A failed disk write is LOUD and never poisons the queue** (`spec/fail-loud.md`; `execution-queue.ts`'s
   lesson): each entry is tried on its own, reported through `onStatus` (toast once per distinct error; the
   card and the menu keep showing it), retried a bounded number of times, and the rest proceed.
7. **The disk mount is a RESTORE, not an overlay** — `protectNothing`. The folder is the whole truth,
   including `.env` (it is the user's own machine; `isSecretPath` still governs GitHub).
8. **The permission prompt runs in a user gesture.** Browsers answer `denied` to a silent request. The
   workspace gate takes that click before a project is created or opened; if a mount still reaches
   `needs-permission` having NOT been declined this session, it holds on the `disk-permission` phase and the
   boot screen offers *Open my projects folder* / *Not now*; skipping opens the project from its other
   copies exactly as if no folder were connected.
9. **Excluded directories are ONE list** (`MAP_EXCLUDED_DIRS`): `node_modules`, `.git`, `.codesandbox`,
   `dist` are never mirrored and never scanned. The pod keeps its own `node_modules`.
10. **Creation never fails on the disk.** `ensureFolderForProject` runs after the creation checkpoint,
    fire-and-forget, loud on failure — §8a rule 4: only the credit refusal may stop a creation.
11. **The project is never deleted from disk by the platform.** Disconnecting the folder forgets the handle
    and touches nothing; deleting a project leaves its folder.

## The folder is a precondition of the WORKSPACE (owner, 2026-09-17)

*"The selecting a folder part ALL USERS are going to have to do… remove the long running toast about
syncing to GitHub for safety and replace it with a check for a local project folder"* (2026-09-15), then
*"you must select your project folder before you even see the main GUI"* (same day), and finally the
correction that settled the shape (2026-09-17): *"that whole thing should be GATED with actually loading
the WORKSPACE… Before project creation, or project loading or anything with a project, it loads the
workspace… that is when the required project save folder is required… not just simply hitting the main
page of the app builder."*

Built three times, and the first two are worth recording because each failure was a different answer to
"when?": a **toast** (missable, and outlived by the work it was about), a **route cover** (met people on
the front page, before they had asked for anything), and now a **precondition of the workspace**.

### How it works

- Both doors into a workspace `await requireProjectsFolderForWorkspace(intent)`:
  - `runStartProject` (`Chat.client.tsx`) — **before the project row, the credit debit and the first
    byte**, so the project is on the user's disk from its first file rather than being relocated later.
  - `mountProjectFiles` (`useChatHistory.ts`) — open, resume, remix, an import's own mount. It sits
    OUTSIDE `mountInFlight` so concurrent callers join one gate rather than queue behind a mount that
    has not been allowed to start.
- `runFolderGate` (`workspace-gate.ts`, dependencies injected) refreshes the disk state, asks
  `decideFolderGate`, and either resolves at once or publishes a `folderGateRequest` and waits.
  `ProjectsFolderGate` renders that request and nothing else — no route, no timer, no state of its own.
- Choosing a folder or granting permission writes `localProjectState`, which the gate is subscribed to,
  so the panel closes itself and the door continues. A picker the user dismissed writes nothing, so the
  gate simply stays — the right answer to "I opened the file dialog and changed my mind".
- Outcome is `proceed` or `cancelled`. On `cancelled`: creation unwinds exactly like its other refusals
  (401/402/no-sandbox) — nothing was made, `setFakeLoading(false)`, `return false` — and an open THROWS
  `ProjectsFolderDeclinedError`, which `handleOpenFailure` turns into a **retryable** boot failure whose
  "Try again" raises the gate again (`mountedThisLoad` is untouched, so the retry is genuinely fresh).

  🔴 **The open must THROW, and the first version did not — found by driving it, not by reasoning.** It
  reported a boot failure and RESOLVED, which all three mount callers read as "the mount is done": they
  set `ready` and the workbench rendered straight over the failure panel, so Cancel opened the project
  anyway. `handleOpenFailure` is the single place that decides surface-versus-continue, and its
  `describeSandboxFailure` classifies PROVIDER failures only — so an unrecognised error takes the
  warn-and-CONTINUE arm. **A refusal that resolves is a success: check what the caller does with a
  resolved promise.**

### Never regress, each silent

1. **No route may decide this.** `isGatedPath` is deleted and both `folder-gate.spec.ts` and
   `ProjectsFolderGate.spec.tsx` scan for its return (plus `useLocation` / `pathname`), with controls.
   `/` is the front page AND the builder, so a path cannot answer the question the gate asks.
2. **The gate always settles.** Every exit runs `finish`, which is idempotent and unsubscribes, clears
   the ceiling and closes the panel. A path that returns without settling hangs a New Project button or
   a project open forever, with nothing on screen and nothing in a log.
3. **The ceiling PROCEEDS, never cancels.** Not knowing the account is our problem, not the user's
   decision; cancelling there refuses to open a project because `/api/me` was slow.
4. **`skip` re-decides rather than settling.** `decideFolderGate` is the only thing that may conclude
   "no folder needed", so a skip recorded while the folder is REQUIRED changes nothing — pressing a
   button that is not on screen can never be a way past the gate (pinned with a control).
5. **A failed refresh still asks.** A state we could not read is `unknown`, which the gate covers;
   treating it as "proceed" drops the folder silently for the rest of the session.
6. **Skip and cancel are separate copy fields** although they share a slot: one opens the workspace, the
   other abandons it, and a single `secondary` label whose meaning flips on a boolean is how a door ends
   up proceeding when the user pressed the button that said Cancel.
7. **The boot `disk-permission` panel does not ask twice.** The gate takes the permission click before
   the mount, so reaching that park means the user already declined this session; `openFolderForProject`
   checks `folderGateSkipped` and opens from the project's other copies instead. The panel stays as the
   answer for any door that mounts without the gate.
8. **`ensureFolderForProject` de-duplicates concurrent callers** (the mount tail and any other caller),
   or two creations racing past `findProjectFolder` produce `<slug>` AND `<slug>-2`.

### What the user sees

`saving.requireProjectsFolder` (default ON) is the only way into a workspace without a folder: on, the
second button is *Cancel*; off, it is *Not now*, which opens the workspace anyway and is remembered for
the session (`folderGateSkipped` + `sessionStorage`, seeded in `startLocalProjectSync`). A declined gate
hands the first-save moment back to the GitHub toast (`folderSetupCoversFirstSave` false). The choice of
folder is saved for good (IndexedDB, per account); ACCESS is the browser's, re-asked once per session and
only inside a click — the gate is that click. Settings → Features → *Where your projects live* changes or
forgets the folder at any time. GitHub is optional from here: `decideNudge` treats a project on disk like
a linked one and never nudges it.

Pinned by `folder-gate.spec.ts` (decision + copy + the no-route scan), `workspace-gate.spec.ts` (12 tests
against an injected clock — settle-once, the ceiling, the skip control, a throwing refresh),
`ProjectsFolderGate.spec.tsx` (which buttons each request draws, and source scans that `root.tsx` mounts
the panel and that BOTH doors await the gate, with controls), `status.spec.ts` (`signed-out` offers no
action), the "nudges and the projects folder" block in `save-status.spec.ts`, and
`overlay-centering.spec.ts`'s named exemption.

## Ranking (`selectMountSource`)

`hasLocalDir` → `{ source: 'disk', unsavedWork, divergedFrom? }`, in every linked/unlinked branch. The disk is
the one copy the user may have edited elsewhere since the last checkpoint, so it can never rank below a
checkpoint; it is theirs, on their machine, so it never ranks below the repo. Reporting stays honest: an
unlinked project is unsaved; a linked one is unsaved when the browser checkpointed past the last push; a
remote that moved WITH unsaved work is a divergence (`divergedFrom`) the user resolves with the same
two-button dialog, over the DISK files. A remote that moved with nothing unsaved is NOT auto-mounted over the
disk (a commit from VS Code on the same folder means the disk already equals it).

## Honest limits

- Chromium only in the browser. One permission click per session (Chrome 122+ remembers it for an installed
  PWA — worth enabling `display: standalone` in the manifest).
- External edits are POLLED (stamps, 2 s, while the tab is visible, never mid-generation or mid-restore).
  `FileSystemObserver` is Chromium-experimental; probe it before depending on it.
- Every disk mount appends a "Loaded from disk" local checkpoint (the undo baseline for external edits),
  which the 20-slot history absorbs like "Loaded from repository" does.
- **Driven live 2026-09-15** with an OPFS directory as the parent (a real `FileSystemDirectoryHandle`, always
  granted): creation → marker + 64/64 files + byte-identical `havok.wasm`; write-through < 1 s; an external
  write reached the store through the poll and did not bounce; reload mounted from disk (`Loaded from disk`);
  the menu item and the Settings card rendered. **Still undriven, by hand only:** the native picker click,
  the `disk-permission` panel on a real picked folder (a fresh session must show it and *Open my projects
  folder* must re-grant), and a GitHub commit / publish from a disk-mounted project (untouched code paths).
  ⚠️ The drive found one defect: `ownerKeyFor` mapped an anonymous viewer to the local developer's key —
  a folder scoped to an account must answer nothing for nobody. Fixed and pinned.
- **Driven live 2026-09-17** (the workspace-gate rebuild, same OPFS stand-in): the app builder's front page
  with no folder stored showed **no gate** and a reachable chat box — the correction itself; `/dashboard`
  likewise. **Open** on a project raised the gate with the *open this project* wording and *Cancel*;
  cancelling showed *"This project was not opened…"* with **Try again** and the workspace did NOT render
  behind it. Seeding a folder and pressing Try again opened the project with **zero** gate samples, and the
  mirror wrote 65 files plus `.btk-project.json`. A genre card on the landing page raised the gate with the
  *create this project* wording, and cancelling left `/api/projects` unchanged at 1 — nothing was made.
  ⚠️ This drive found the resolve-reads-as-success defect above. **Still undriven:** the native picker, and
  reconnect on a real (non-OPFS) folder, which is always granted and so cannot reach `needs-permission`.
