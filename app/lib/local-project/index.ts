/**
 * The disk link, wired to the app (SPEC §4.5.4d). Everything with a store, a sandbox or a browser in
 * it lives here; the modules beside it are pure or take their dependencies as arguments.
 *
 * Three doors call in:
 *   - the MOUNT (`useChatHistory.ts`): `openFolderForProject` → `readFolderForMount` → `attachFolder`;
 *   - CREATION (`Chat.client.tsx`): `ensureFolderForProject` after the creation checkpoint;
 *   - the UI: `chooseProjectsFolder` / `reconnectProjectsFolder` / `disconnectProjectsFolder` /
 *     `reloadFromDisk`, plus `grantFolderAccess` / `skipFolderAccess` shared by the first-run gate
 *     (`ProjectsFolderGate.client.tsx`) and the boot panel.
 */
import { toast } from 'react-toastify';
import { MAP_EXCLUDE_GLOBS, isMapExcludedDir } from '~/lib/stores/files';
import { isRestoreInFlight } from '~/lib/stores/restore-flag';
import { streamingState } from '~/lib/stores/streaming';
import { bootProgress } from '~/lib/stores/boot-progress';
import { localViewerStore } from '~/lib/persistence/local-owner';
import { getProject } from '~/lib/persistence/projects';
import { protectNothing } from '~/lib/persistence/restore-plan';
import { toProjectRelativePath } from '~/lib/common/sandbox-paths';
import { WORK_DIR } from '~/utils/constants';
import { MAX_FILES } from '~/utils/fileUtils';
import { createScopedLogger } from '~/utils/logger';
import { createProjectFolder, findProjectFolder, ProjectFolder, type ProjectFolderOptions } from './fsa-store';
import { projectsRoot } from './projects-root';
import {
  clearParentHandle,
  isLocalFolderSupported,
  loadParentHandle,
  ownerKeyFor,
  pickParentFolder,
  queryFolderPermission,
  requestFolderPermission,
  saveParentHandle,
} from './handles';
import { LocalMirror } from './mirror';
import { applyExternalChanges, startExternalChangePoll } from './external-changes';
import { treeToSerializedFileMap } from './scan';
import { localProjectState, folderGateSkipped, type ProjectMirrorStatus } from './status';
import { folderGateRequest, type FolderGateOutcome, type WorkspaceIntent } from './folder-gate';
import { runFolderGate, type RunningFolderGate } from './workspace-gate';
import { saving } from '~/config/saving';
import type { DiskIndex, LocalDirectoryHandle } from './types';
import type { SerializedFileMap } from '~/lib/binary/binary-files';

export { localProjectState, folderGateSkipped, describeLocalProject } from './status';
export type { LocalProjectState } from './status';
export { decideFolderGate, folderGateCopy, folderGateRequest } from './folder-gate';
export { ProjectsFolderDeclinedError } from './workspace-gate';
export type { FolderGate, FolderGateOutcome, FolderGateRequest, WorkspaceIntent } from './folder-gate';

const logger = createScopedLogger('local-project');

/*
 * 🔴 The sandbox boot module and the workbench store are imported LAZILY, on purpose. This module is
 * imported by the boot screen, the ⋯ menu and a Settings card — components whose specs mount them in
 * jsdom — and `~/lib/sandbox` runs boot-state code at module evaluation. Pulling it into every
 * component's import graph is how a settings card's test comes to fail on a line about sandbox
 * hot-reload state. Only the functions that genuinely need a runtime load it, when they run.
 */
const runtime = () => import('~/lib/sandbox').then((m) => m.sandbox);
const workbench = () => import('~/lib/stores/workbench').then((m) => m.workbenchStore);

const FOLDER_OPTIONS: ProjectFolderOptions = { isExcludedDir: isMapExcludedDir, maxFiles: MAX_FILES };

let parentHandle: LocalDirectoryHandle | undefined;
let active: { projectId: string; folder: ProjectFolder; mirror: LocalMirror; stopPoll: () => void } | undefined;

/* ------------------------------------------------------------------------------ the parent folder */

function ownerKey(): string | undefined {
  return ownerKeyFor(localViewerStore.get());
}

/** Re-derive the state from the account + what IndexedDB remembers. Silent — never prompts. */
export async function refreshLocalFolderState(): Promise<void> {
  if (!isLocalFolderSupported()) {
    localProjectState.set({ kind: 'unavailable' });
    return;
  }

  const viewer = localViewerStore.get();
  const owner = ownerKeyFor(viewer);

  if (!owner) {
    // `nobody` = accounts are on and no one is signed in; `unknown` = the session has not answered yet.
    localProjectState.set(viewer.status === 'nobody' ? { kind: 'signed-out' } : { kind: 'unknown' });
    return;
  }

  try {
    parentHandle = await loadParentHandle(owner);
  } catch (error) {
    logger.warn(`Could not read the remembered projects folder: ${(error as Error)?.message}`);
    parentHandle = undefined;
  }

  if (!parentHandle) {
    localProjectState.set({ kind: 'unset' });
    return;
  }

  const permission = await queryFolderPermission(parentHandle);

  if (permission === 'granted') {
    localProjectState.set({
      kind: 'connected',
      folderName: parentHandle.name,
      project: active ? currentProjectStatus() : undefined,
    });
  } else {
    localProjectState.set({ kind: 'needs-permission', folderName: parentHandle.name });
  }
}

/** Subscribe the state to the account. Idempotent; call once at app start. */
let syncing = false;

export function startLocalProjectSync(): void {
  if (syncing) {
    return;
  }

  syncing = true;
  folderGateSkipped.set(readGateSkipped());
  localViewerStore.subscribe(() => void refreshLocalFolderState());
}

/* ------------------------------------------------------------------------ the workspace gate */

/**
 * Once per SESSION (a tab), never per project: "not now" is an answer about THIS MACHINE, and the
 * folder is a machine-level fact. Persisted in `sessionStorage` so it survives the reloads a build can
 * cause, and dies with the tab so the question is asked again tomorrow.
 */
const FOLDER_GATE_SKIPPED_KEY = 'bt_folder_gate_skipped';

function readGateSkipped(): boolean {
  try {
    return sessionStorage.getItem(FOLDER_GATE_SKIPPED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberGateSkipped(): void {
  folderGateSkipped.set(true);

  try {
    sessionStorage.setItem(FOLDER_GATE_SKIPPED_KEY, '1');
  } catch {
    // Storage blocked (private mode): the atom still holds it for this page.
  }
}

let liveGate: RunningFolderGate | undefined;

/**
 * Hold a workspace until this machine has a projects folder (SPEC §4.5.4d).
 *
 * 🔴 **This is the ONLY thing that decides when the gate is seen**, and it is called from the two doors
 * into a workspace — `runStartProject` (creation) and `mountProjectFiles` (open/resume/remix/import).
 * Nothing about a ROUTE is consulted, which is what stops the front page of the app builder being
 * covered by a question that has no meaning until there is a project.
 *
 * Concurrent callers JOIN the gate in flight rather than raising a second one: several
 * `useChatHistory` instances reach the mount, and two panels asking one question is the two-writers
 * drift this repo keeps rediscovering.
 */
export async function requireProjectsFolderForWorkspace(intent: WorkspaceIntent): Promise<FolderGateOutcome> {
  if (liveGate) {
    return liveGate.outcome;
  }

  const running = runFolderGate(intent, {
    refresh: refreshLocalFolderState,
    readState: () => localProjectState.get(),
    subscribeState: (listener) => localProjectState.subscribe(listener),
    readSkipped: () => folderGateSkipped.get(),
    rememberSkipped: rememberGateSkipped,
    required: saving.requireProjectsFolder,
    ceilingMs: saving.folderGateCheckCeilingMs,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    open: (request) => folderGateRequest.set(request),
    close: () => folderGateRequest.set(null),
  });

  liveGate = running;

  try {
    return await running.outcome;
  } finally {
    liveGate = undefined;
  }
}

/** The panel's *Not now* — open the workspace with no folder, for the rest of this session. */
export function skipFolderGate(): void {
  liveGate?.skip();
}

/** The panel's *Cancel* — the workspace is not opened at all. */
export function cancelFolderGate(): void {
  liveGate?.cancel();
}

/** USER GESTURE. Pick (or change) the parent folder and remember it for this account. */
export async function chooseProjectsFolder(): Promise<boolean> {
  const owner = ownerKey();

  if (!isLocalFolderSupported() || !owner) {
    return false;
  }

  const picked = await pickParentFolder();

  if (!picked) {
    return false;
  }

  await saveParentHandle(owner, picked);
  parentHandle = picked;

  /*
   * D61: the user sees `Apps/` and `Unity/` the moment they choose the folder. Nothing else in it is
   * touched. A failure is loud but does not un-choose the folder — the next project door retries the
   * same helper, since `findProjectFolder` / `createProjectFolder` resolve `Apps/` through it too.
   */
  try {
    await projectsRoot(picked);
  } catch (error) {
    logger.error(`Could not create the Web and Unity folders in ${picked.name}`, error);
    toast.error(
      `Could not create the Web and Unity folders in ${picked.name}: ${(error as Error)?.message ?? 'unknown error'}`,
    );
  }
  localProjectState.set({ kind: 'connected', folderName: picked.name });

  /*
   * A mount may be parked on the OLD folder's permission click. The new folder is open, so let it go:
   * `openFolderForProject` continues against the new parent, finds no folder there, mounts from the
   * project's other copies, and `ensureFolderForProject` then creates one — which is exactly "use a
   * different folder".
   */
  releasePermissionGate('granted');

  return true;
}

/** USER GESTURE. Re-grant this session's access to the remembered folder. */
export async function reconnectProjectsFolder(): Promise<boolean> {
  if (!parentHandle) {
    await refreshLocalFolderState();
  }

  if (!parentHandle) {
    return false;
  }

  const permission = await requestFolderPermission(parentHandle);
  await refreshLocalFolderState();

  return permission === 'granted';
}

/** Forget the folder. Nothing on disk is touched — it is the user's. */
export async function disconnectProjectsFolder(): Promise<void> {
  const owner = ownerKey();

  detachFolder();

  if (owner) {
    await clearParentHandle(owner);
  }

  parentHandle = undefined;
  localProjectState.set(isLocalFolderSupported() ? { kind: 'unset' } : { kind: 'unavailable' });
}

/* --------------------------------------------------------------------------- the permission gate */

let permissionGate: { resolve: (decision: 'granted' | 'skipped') => void } | undefined;

/**
 * Hold the mount on a click. The browser will not re-grant folder access without a user gesture, so
 * the boot screen shows a button and the mount waits here for it; "skip" opens the project from its
 * other copies exactly as if no folder were connected.
 */
function awaitFolderPermission(folderName: string): Promise<'granted' | 'skipped'> {
  return new Promise((resolve) => {
    permissionGate = { resolve };
    bootProgress.set({ step: 'disk-permission', folderName });
  });
}

/** Let a parked mount continue. `true` when one was waiting. */
function releasePermissionGate(decision: 'granted' | 'skipped'): boolean {
  const gate = permissionGate;
  permissionGate = undefined;
  gate?.resolve(decision);

  return gate !== undefined;
}

/**
 * The reconnect button — a user gesture, which is what `requestPermission` needs. Shared by the first-run
 * gate and the boot panel: whichever the user clicks, the same click re-grants access AND releases a
 * mount parked on it, so the two surfaces can never ask for the same click twice.
 */
export async function grantFolderAccess(): Promise<boolean> {
  const granted = await reconnectProjectsFolder();
  const wasWaiting = releasePermissionGate(granted ? 'granted' : 'skipped');

  if (!granted && wasWaiting) {
    toast.warn('Access to your projects folder was not granted. Opening from your other copies instead.');
  }

  return granted;
}

export function skipFolderAccess(): void {
  releasePermissionGate('skipped');
}

/* ------------------------------------------------------------------------------ project folders */

/**
 * The project's folder on disk, if this browser has one — for the mount to decide `disk` as a source.
 * May hold the mount on the permission gate. `undefined` = no folder (unsupported, unset, declined, or
 * the project has never been on this disk).
 */
export async function openFolderForProject(projectId: string): Promise<ProjectFolder | undefined> {
  await refreshLocalFolderState();

  const state = localProjectState.get();

  if (state.kind === 'needs-permission') {
    /*
     * The workspace gate takes this click BEFORE the mount runs, so reaching here means the user
     * already declined it this session (`skipFolderGate`). Parking on the boot panel would ask the
     * same question a second time, one screen later, having been told no — so it opens from the
     * project's other copies instead. The panel remains the answer for any door that mounts without
     * the gate.
     */
    if (folderGateSkipped.get()) {
      return undefined;
    }

    const decision = await awaitFolderPermission(state.folderName);

    if (decision !== 'granted') {
      return undefined;
    }
  } else if (state.kind !== 'connected') {
    return undefined;
  }

  if (!parentHandle) {
    return undefined;
  }

  try {
    return await findProjectFolder(parentHandle, projectId, await projectNameOf(projectId), FOLDER_OPTIONS);
  } catch (error) {
    logger.error(`Could not look for project ${projectId} in ${parentHandle.name}`, error);
    toast.error(`Could not read your projects folder: ${(error as Error)?.message ?? 'unknown error'}`);

    return undefined;
  }
}

/**
 * The project's title, for the folder's slug. Only asked once a projects folder is known to exist, so
 * a user without one never pays the request; `undefined` on failure — the marker scan still finds an
 * existing folder, and a new one gets the fallback slug.
 */
async function projectNameOf(projectId: string): Promise<string | undefined> {
  try {
    return (await getProject(projectId)).name;
  } catch (error) {
    logger.warn(`Could not read the name of project ${projectId}: ${(error as Error)?.message}`);
    return undefined;
  }
}

/** Read the whole folder for a mount: the map every restore door speaks, plus the stamps. */
export async function readFolderForMount(
  folder: ProjectFolder,
): Promise<{ files: SerializedFileMap; index: DiskIndex }> {
  const tree = await folder.readTree({ withBytes: true });

  return { files: treeToSerializedFileMap(tree, WORK_DIR), index: tree.index };
}

function currentProjectStatus(): ProjectMirrorStatus | undefined {
  if (!active) {
    return undefined;
  }

  return { dirName: active.folder.name, pending: active.mirror.pending };
}

function publishProject(status: Omit<ProjectMirrorStatus, 'dirName'>): void {
  const state = localProjectState.get();

  if (state.kind !== 'connected' || !active) {
    return;
  }

  localProjectState.set({ ...state, project: { dirName: active.folder.name, ...status } });
}

/**
 * Start mirroring the open project into its folder. `initialIndex` is what a disk mount just read, so
 * the replayed watcher events compare as identical rather than rewriting the project.
 */
export async function attachFolder(
  projectId: string,
  folder: ProjectFolder,
  initialIndex: DiskIndex = {},
): Promise<void> {
  detachFolder();

  const sandbox = await runtime();
  let lastErrorToasted: string | undefined;

  const mirror = new LocalMirror(
    {
      sandbox,
      folder,
      excludeGlobs: MAP_EXCLUDE_GLOBS,
      isRestoreInFlight,
      onStatus: (status) => {
        publishProject(status);

        // LOUD, once per distinct error — the card and the menu keep showing it after the toast goes.
        if (status.error && status.error !== lastErrorToasted) {
          lastErrorToasted = status.error;
          toast.error(`Could not write to your project folder — ${status.error}`);
        }
      },
    },
    initialIndex,
  );

  mirror.start();

  const stopPoll = startExternalChangePoll({
    folder,
    mirror,
    sandbox,
    isBusy: () => streamingState.get() || isRestoreInFlight(),
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onApplied: (diff) => {
      const n = diff.changed.length + diff.removed.length;
      logger.info(`Applied ${n} external change(s) from ${folder.name}`);
      toast.info(`${n} file${n === 1 ? '' : 's'} changed on disk — loaded into your project.`);
    },
    onError: (error) => logger.warn(`External change poll failed: ${(error as Error)?.message}`),
  });

  active = { projectId, folder, mirror, stopPoll };
  publishProject({ pending: 0 });
  logger.info(`Project ${projectId} is mirrored to ${folder.name}`);
}

export function detachFolder(): void {
  if (!active) {
    return;
  }

  active.stopPoll();
  active.mirror.stop();
  active = undefined;

  const state = localProjectState.get();

  if (state.kind === 'connected') {
    localProjectState.set({ kind: 'connected', folderName: state.folderName });
  }
}

/** Project-relative paths of every FILE the store currently holds. */
async function storeFilePaths(): Promise<string[]> {
  return Object.entries((await workbench()).files.get())
    .filter(([, dirent]) => dirent?.type === 'file')
    .map(([key]) => toProjectRelativePath(key));
}

/**
 * Make sure the open project has a folder and is mirrored into it — after creation, and after a mount
 * that came from somewhere other than the disk. Creates the folder if the disk has none, then writes
 * everything the store holds. Never throws: the project is already open; the disk is the extra.
 */
export async function ensureFolderForProject(projectId: string, name?: string): Promise<void> {
  if (active?.projectId === projectId) {
    return;
  }

  /*
   * Two doors can call this for one project at the same moment — the mount's post-settle call and the
   * gate's "you just chose a folder" call. Two creations racing past `findProjectFolder` before either
   * has written its marker would produce `<slug>` AND `<slug>-2`; the second caller joins the first.
   */
  let work = ensuring.get(projectId);

  if (!work) {
    work = ensureFolderNow(projectId, name).finally(() => ensuring.delete(projectId));
    ensuring.set(projectId, work);
  }

  await work;
}

const ensuring = new Map<string, Promise<void>>();

async function ensureFolderNow(projectId: string, name?: string): Promise<void> {
  await refreshLocalFolderState();

  if (localProjectState.get().kind !== 'connected' || !parentHandle) {
    return;
  }

  try {
    const folder = await createProjectFolder(
      parentHandle,
      projectId,
      name ?? (await projectNameOf(projectId)),
      FOLDER_OPTIONS,
    );
    await attachFolder(projectId, folder);
    await active!.mirror.syncAll(await storeFilePaths());
  } catch (error) {
    logger.error(`Could not put project ${projectId} on disk`, error);
    toast.error(
      `Could not write your project to ${parentHandle.name}: ${(error as Error)?.message ?? 'unknown error'}`,
    );
  }
}

/** The ⋯ menu's "Reload from disk": pull external edits in now, or re-read the whole folder. */
export async function reloadFromDisk(): Promise<void> {
  if (!active) {
    toast.info('This project is not in your projects folder.');
    return;
  }

  try {
    const diff = await applyExternalChanges({ folder: active.folder, mirror: active.mirror, sandbox: await runtime() });
    const n = diff.changed.length + diff.removed.length;
    toast.success(
      n === 0
        ? 'Your project already matches the folder on disk.'
        : `Loaded ${n} change${n === 1 ? '' : 's'} from disk.`,
    );
  } catch (error) {
    toast.error(`Could not reload from disk: ${(error as Error)?.message ?? 'unknown error'}`);
  }
}

/** Is the open project mirrored right now? (The menu item is offered only when this is true.) */
export function isProjectOnDisk(projectId: string | undefined): boolean {
  return active !== undefined && active.projectId === projectId;
}

/** Everything a full re-read needs, for a caller that wants to REPLACE the sandbox with the folder. */
export async function restoreProjectFromDisk(): Promise<void> {
  if (!active) {
    return;
  }

  const { files, index } = await readFolderForMount(active.folder);
  await (await workbench()).restoreFiles(files, { protect: protectNothing });
  Object.assign(active.mirror.index, index);
}
