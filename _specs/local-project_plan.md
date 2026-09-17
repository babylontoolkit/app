# Local-disk projects — the project lives in a folder on the user's hard disk

> Owner ask (2026-09-15): *"I JUST WANT THE PROJECT TO PHYSICALLY LIVE ON THE USERS HARD DISK FROM JUMP STREET IN
> SOME APP BUILD PROJECTS FOLDER and all projects get dumped in… NOT JUST LIVE IN THE VOLATILE SANDBOX FOR NODEPOD."*
> Answer: yes, without a rewrite. This plan is the record of how. Full reasoning in the approved plan; this file is
> the executable task list and ticks as work lands.

## Shape

- **A MIRROR beside Nodepod, not a fourth `SandboxProvider`.** Nodepod stays the runtime; the disk is a persistence
  backing. `sandbox.watchPaths` out (write-through), `restoreFiles` in (mount from disk). No provider file touched.
- **Vehicle: the browser's File System Access API** (Chromium). Safari/Firefox report "unavailable" and keep
  today's behaviour. Electron later = a second `LocalProjectStore` backend behind the same interface.
- **One parent "projects" folder per browser profile + account**, chosen once; each project is
  `<parent>/<slug>/` with a `.btk-project.json` marker naming the project id (the marker is what makes "is this
  folder mine?" answerable — never the folder name alone).
- **Disk ranks FIRST in `selectMountSource`** when the folder exists. IndexedDB checkpoints (undo), the server
  working copy (crash recovery elsewhere) and the remix seed are unchanged.
- **`node_modules`, `.git`, `.codesandbox`, `dist` are never mirrored** (`MAP_EXCLUDED_DIRS`, one list).

## Tasks

- [x] T1 `app/lib/local-project/{types,fsa-store,handles,dir-name}.ts` — interface, FSA backend, persisted parent
      handle (IndexedDB `btk-local-projects`, keyed by account), slug + marker.
- [x] T2 `scan.ts` — folder → `SerializedFileMap`, excludes, byte-identity spec.
- [x] T3 `mirror.ts` — write-through on `watchPaths`, coalesced, restore-aware (queue during a restore, then
      compare-before-write so a disk-sourced mount never rewrites itself), LOUD failures.
- [x] T4 `selectMountSource` gains `disk`; `mountProjectFiles` disk branch; `disk-permission` boot phase.
- [x] T5 Creation writes the folder after the creation checkpoint; never fails creation.
- [x] T6 UI — Settings → Features "Projects folder" card; ⋯ menu "Reload from disk"; boot-screen reconnect panel.
- [x] T7 External edits — disk index poll while visible, deferred during a generation or a restore.
- [x] T8 Specs/docs — SPEC §4.5.4d, `spec/local-project.md`, CLAUDE.md persistence block.
- [x] T9 Gates green + live drive in Chrome (2026-09-15, OPFS stand-in for the picked folder — the native
      picker cannot be automated): Blank Canvas creation → `BTK Projects/blank-canvas/.btk-project.json` naming the
      project, 64/64 store files on disk, `havok.wasm` 2,094,566 bytes sha256-identical; `createFile` → on disk in
      <1 s; a file written straight to disk → in the store via the poll, mtime unchanged after 3 s (no bounce);
      reload → "Loaded from disk" checkpoint (seq 2), both files present; ⋯ menu shows *Reload from disk*, body
      padding stays 0px; Settings card reads "BTK Projects/blank-canvas — This project is on disk". NOT driven:
      the native picker click, the `disk-permission` panel (OPFS is always granted), a GitHub commit / publish
      (those paths are untouched code).

## Follow-up (owner, 2026-09-15, same day)

- [x] T10 The folder is PROMPTED once per machine, replacing the GitHub save-reminder toast on browsers that
      can keep projects on disk (`folder-prompt.ts`, `SavingSurface` `FolderPrompt`; `decideNudge` gains
      `onDisk` + `folderPromptCoversFirstSave`; `saving.folderPromptAutoCloseMs`). GitHub is optional for a
      project on disk. Safari/Firefox keep the GitHub toast.
- [x] T11 A first-run GATE replaces the T10 toast (owner "build it", 2026-09-15): `folder-gate.ts` (pure) +
      `ProjectsFolderGate.client.tsx` mounted in `root.tsx`. Shipped as a cover over the builder ROUTES
      (`isGatedPath`), superseded the same week by T12. `folder-prompt.ts` + `SavingSurface`'s `FolderPrompt`
      deleted; `saving.requireProjectsFolder`; a new `signed-out` state; `ensureFolderForProject` de-duplicates
      concurrent callers.
- [x] T12 The gate is tied to the WORKSPACE, not to a page (owner, 2026-09-17: *"that whole thing should be
      GATED with actually loading the WORKSPACE… not just simply hitting the main page of the app builder"*).
      `workspace-gate.ts` `runFolderGate` (injected deps) + `requireProjectsFolderForWorkspace`, awaited by
      BOTH doors: `runStartProject` before the project row/credit debit/first byte, and `mountProjectFiles`
      outside `mountInFlight`. `isGatedPath` DELETED and scanned for in two specs; the panel is a dumb renderer
      of `folderGateRequest`. Outcome `proceed | cancelled`: cancel makes no project (creation) or reports a
      retryable boot failure (open). The ceiling proceeds, never cancels; `skip` re-decides rather than
      settling; the boot `disk-permission` park is suppressed once the gate was declined this session.
