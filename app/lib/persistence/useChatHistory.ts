import { useLoaderData, useNavigate, useSearchParams } from '@remix-run/react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { atom } from 'nanostores';
import { generateId, type JSONValue, type Message } from 'ai';
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { logStore } from '~/lib/stores/logs'; // Import logStore
import {
  getAll,
  getMessages,
  getNextId,
  getUrlId,
  openDatabase,
  setMessages,
  duplicateChat,
  createChatFromMessages,
  getSnapshot,
  setSnapshot,
  type IChatMetadata,
} from './db';
import type { FileMap } from '~/lib/stores/files';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import type { Snapshot } from './types';
import { detectProjectCommands, createCommandActionsString } from '~/utils/projectCommands';
import type { ContextAnnotation } from '~/types/context';
import {
  getRepoStatus,
  isServerChatId,
  listAllChats,
  listChats,
  loadMessages,
  loadWorkingCopy,
  mintServerChatId,
  pullFromRepo,
  readRemixSeed,
  saveMessages,
  saveProjectToRepo,
  saveWorkingCopy,
  type RepoStatus,
} from './projects';
import { withinWorkingCopyBudget } from './working-copy-size';
import {
  createLocalSnapshot,
  getLocalSyncState,
  markSynced,
  readCurrentLocalSnapshot,
  type LocalSyncState,
} from './local-snapshots';
import { selectMountSource, type MountSource } from './mount-source';
import { detectUnappliedTurn } from './unapplied-turn';
import { applyTranscriptArtifact } from './apply-artifact';
import { protectForRepoRestore, protectNothing } from './restore-plan';
import { hasRestorableHistory, markAsTranscript } from './transcript';
import {
  decideDependencyInstall,
  devScriptFromManifest,
  findLockfile,
  findManifest,
  hasManifest,
  shouldStartDevServer,
} from './dependencies';
import { SaveQueue, saveState } from './save-queue';
import { takePendingProjectMount, PENDING_REMIX_KEY } from './pending-remix';
import { identityForMount } from './mount-identity';
import { slugForChat } from './chat-slug';
import { createScopedLogger } from '~/utils/logger';
import { createSingleFlight } from '~/utils/single-flight';

const logger = createScopedLogger('ChatHistory');

export interface ChatHistoryItem {
  id: string;
  urlId?: string;
  description?: string;
  messages: Message[];
  timestamp: string;
  metadata?: IChatMetadata;
}

const persistenceEnabled = !import.meta.env.VITE_DISABLE_PERSISTENCE;

export const db = persistenceEnabled ? await openDatabase() : undefined;

export const chatId = atom<string | undefined>(undefined);
export const description = atom<string | undefined>(undefined);
export const chatMetadata = atom<IChatMetadata | undefined>(undefined);

/**
 * The server-side project this chat is building (§4.5.5).
 *
 * `undefined` for a chat that has no project yet (a fresh page, or an upstream blank/import flow that
 * has not created one). Everything that talks to the server keys off this: the agent route's ownership
 * check, checkpoints, and the message history. It is persisted in the chat's IndexedDB metadata, which
 * is what lets a reload find its way back to the project.
 */
export const projectId = atom<string | undefined>(undefined);

/**
 * Whether the project currently on screen has work that exists only in this browser (§4.5.4b).
 *
 * Read by the LINKED/UNLINKED indicator, the nudges, and the beforeunload warning. An atom rather than
 * a fetch, because those three must agree with each other and with what just happened, without three
 * independent round-trips racing.
 */
export const unsavedWork = atom<boolean>(false);

/** The project's repo link, as of the last time we looked. `undefined` = not loaded yet. */
export const repoStatus = atom<RepoStatus | undefined>(undefined);

/** The repo moved AND this browser has unsaved work. The user must choose (§4.13) — we never merge. */
export const mountDivergence = atom<{ projectId: string; remoteHead: string } | undefined>(undefined);

/**
 * A PAID generation whose files never reached this project (§4.5.4c, §4.6).
 *
 * Set when the mounted copy is older than the last assistant turn — which means the user was charged
 * for work they cannot see. The artifact still holds the file bodies, so this is an offer to apply
 * them, never an automatic write: an older copy can also be one the user deliberately restored
 * (§4.12), and the two are indistinguishable (`unapplied-turn.ts`).
 */
export const unappliedTurn = atom<{ projectId: string; message: Message } | undefined>(undefined);

/**
 * Did the latest checkpoint reach the server's recovery copy? (§4.5.4c)
 *
 * Drives the beforeunload warning, which must fire only when work would genuinely be LOST. The upload
 * is best-effort — offline, or the project past the size cap — so this is the difference between "not
 * in your repository yet" (safe, common, must not nag) and "this browser has the only copy".
 *
 * Starts `false`: before the first successful upload nothing is recoverable, and the safe default for
 * a question about data loss is the pessimistic one.
 */
export const workingCopySafe = atom<boolean>(false);

/** One "you are not protected" warning per project per session — see `checkpointProject`. */
const warnedNoRecoveryCopy = new Set<string>();

/**
 * What the last mount produced, for `checkUnappliedTurn` to read.
 *
 * Module-level rather than returned, because the mount and the transcript restore run concurrently and
 * the check needs both. Written synchronously at the end of the mount, read immediately after both
 * settle — never across a user interaction.
 */
let lastMount: { source: MountSource['source']; messageId?: string } | undefined;

/** The conversation the last `restoreTranscript` put on screen, for the same reason as `lastMount`. */
let restoredTranscript: Message[] | undefined;

/** Does this assistant turn actually write files? A prose answer has nothing to apply. */
function turnWritesFiles(message: Message): boolean {
  return typeof message.content === 'string' && message.content.includes('<boltAction type="file"');
}

/**
 * Did the last paid turn ever land? If not, raise the offer (§4.5.4c).
 *
 * Deliberately non-throwing: this is a remedy for a failure that already happened, and it must never
 * become a second reason a project fails to open.
 */
async function checkUnappliedTurn(pid: string): Promise<void> {
  try {
    const lastAssistant = [...(restoredTranscript ?? [])].reverse().find((message) => message.role === 'assistant');

    const decision = detectUnappliedTurn({
      source: lastMount?.source ?? 'empty',
      lastAssistantMessageId: lastAssistant?.id,
      hasFileActions: lastAssistant ? turnWritesFiles(lastAssistant) : false,
      mountedMessageId: lastMount?.messageId,
    });

    if (decision.action === 'none') {
      return;
    }

    if (decision.action === 'apply') {
      /*
       * Nothing exists from any source, so there is nothing to overwrite and no earlier state the user
       * could have chosen — the one case where writing without asking is safe.
       */
      await applyTranscriptArtifact(lastAssistant!);
      return;
    }

    /*
     * The MESSAGE travels, not its id. The dialog would otherwise have to find it again, and the only
     * place to look is the rendered conversation — a second source that can disagree with this one
     * about which turn "the last" is.
     */
    unappliedTurn.set({ projectId: pid, message: lastAssistant! });
  } catch (error) {
    logger.warn(`Could not check for an unapplied turn on ${pid}: ${(error as Error)?.message}`);
  }
}

/**
 * How many things the user has made in this project — the nudge MILESTONE counter (§4.5.4b).
 *
 * §4.5.4b forbids a timed nudge, so this is the only clock the nudges get: the user's own progress. It
 * counts checkpoints rather than generations exactly (a pull or a restore also checkpoints), and that
 * imprecision is fine and deliberate — it drives chrome, never a decision about anyone's files. It is
 * seeded on mount from the local checkpoint seq, which is monotonic and survives the 20-checkpoint
 * trim, so a long-lived project's milestones do not silently stop at the trim boundary.
 */
export const generationCount = atom<number>(0);

/**
 * Put a project's files on screen (§4.5.4b) — from this browser, or from the user's repo.
 *
 * This is the "load from GitHub seamlessly" half. It does no deciding of its own: it gathers the three
 * facts (is it linked, where is the repo, how far has this browser moved) and hands them to
 * `selectMountSource`, which is pure and exhaustively tested precisely because every wrong answer here
 * silently destroys someone's work.
 *
 * What it does with each answer:
 *
 *   - `local`     — mount this browser's current checkpoint. No network.
 *   - `repo`      — fetch the linked repo and mount it. This is the new-device path: clear your
 *                   storage, open the project, and the game comes back from your repository.
 *   - `seed`      — read the one-time remix copy and adopt it as the first local checkpoint.
 *   - `diverged`  — mount LOCAL (it is the unsaved side) and raise the two-button choice. Mounting the
 *                   repo here would destroy the very work that caused the divergence.
 *   - `empty`     — nothing to mount. A brand-new project before its first generation.
 *
 * Single-flighted per project id: the mount effect can re-fire for the same project (StrictMode's
 * double-invoke, a `searchParams`/`navigate` identity change), and two concurrent mounts would pull
 * the repo twice and — the part that actually corrupts — run two `npm install`s into the one shared
 * WebContainer. Concurrent callers share the running mount; a later call (a real re-open) runs afresh.
 */
const mountInFlight = createSingleFlight<string>();

/**
 * Options for a mount.
 *
 * `prepareToRun` — whether this mount should reinstall dependencies and start the dev server. Default
 * true, because the common paths (a new device, a dashboard Open, a remix) have no other way to make
 * the project runnable. The ONE caller that passes false is the `/chat/:id` reload path, which rebuilds
 * an artifact carrying `npm install` + `npm run dev` (`createCommandActionsString`) and replays it — so
 * preparing here as well would run a SECOND installer into the one shared `boltTerminal`, which races
 * the first and surfaces a spurious "installing dependencies failed" toast over a project that is, in
 * fact, installing and running fine.
 */
interface MountOptions {
  prepareToRun?: boolean;
}

function mountProjectFiles(pid: string, opts: MountOptions = {}): Promise<void> {
  return mountInFlight(pid, () => doMountProjectFiles(pid, opts));
}

async function doMountProjectFiles(pid: string, opts: MountOptions = {}): Promise<void> {
  const prepareToRun = opts.prepareToRun ?? true;

  /*
   * 🔴 RESET, never inherit. These two module-level values are how `checkUnappliedTurn` sees both
   * halves of a mount, and a navigate between projects does not unload the module — so without this
   * they arrive still holding the PREVIOUS project's mount and transcript, and the check would offer
   * to apply one project's artifact onto another. Same class as the §4.5.6 chat-identity bug, where
   * state surviving an SPA navigation was the whole defect. Cleared synchronously at entry, before
   * anything can await, so the concurrent `restoreTranscript` cannot lose its own write to it.
   */
  lastMount = undefined;
  restoredTranscript = undefined;

  const [status, sync] = await Promise.all([
    getRepoStatus(pid),
    db ? getLocalSyncState(db, pid) : Promise.resolve({} as LocalSyncState),
  ]);

  repoStatus.set(status);

  /*
   * Seed the milestone counter (§4.5.4b). `localSeq` is monotonic and unaffected by the checkpoint
   * trim, so a project reopened after twenty generations resumes counting where it was rather than
   * restarting its nudges from zero.
   */
  generationCount.set(sync.localSeq === undefined ? 0 : sync.localSeq + 1);

  /*
   * The recovery copy (§4.5.4c), fetched ONLY when this browser has nothing of its own.
   *
   * Two reasons for the condition. It is the only case the decision can use it in (a local checkpoint
   * always wins — the seqs are per-browser and not comparable), and the copy is the whole project, so
   * fetching it to answer "does one exist?" on every mount would download megabytes to discard them.
   * Fetched as the object rather than a probe, so the mount below needs no second request.
   */
  const working = sync.localSeq === undefined ? await loadWorkingCopy(pid) : null;

  const decision = selectMountSource({
    linked: status.linked,
    lastSyncedCommitSha: status.lastSyncedCommitSha,

    // Deliberately preserves the absent/null distinction — see `RepoStatus.remoteHead`.
    remoteHead: status.remoteHead,
    localSeq: sync.localSeq,
    syncedSeq: sync.syncedSeq,
    hasServerSeed: undefined,
    hasWorkingCopy: Boolean(working),
  });

  logger.info(`Mounting project ${pid} from: ${decision.source}`);

  if (decision.source === 'local' || decision.source === 'diverged') {
    const local = db ? await readCurrentLocalSnapshot(db, pid) : undefined;

    if (local) {
      /*
       * A local checkpoint is the whole truth (it serialized the entire store), so `protectNothing`:
       * a file it does not have is one the project does not have. Without this the mount is an
       * overlay, and a file deleted before the checkpoint would come back from the template mount.
       */
      await workbenchStore.restoreFiles(local.files, { protect: protectNothing });

      if (prepareToRun) {
        // The container was torn down on reload; reinstall and start the dev server so the game runs.
        await prepareMountedProject(local.files);
      }
    }

    lastMount = { source: decision.source, messageId: local?.messageId };
    unsavedWork.set(decision.source === 'diverged' || decision.unsavedWork);

    if (decision.source === 'diverged') {
      mountDivergence.set({ projectId: pid, remoteHead: decision.remoteHead });
    }

    return;
  }

  if (decision.source === 'working') {
    /*
     * Recovering work that exists NOWHERE else (§4.5.4c) — a tab crash, cleared site data, or a new
     * device on an unlinked project. Without this the user got an empty editor for a project they had
     * built and, in the measured case, already paid 427 credits for.
     *
     * `protectForRepoRestore`, NOT `protectNothing`: `saveWorkingCopy` strips the `.env` family before
     * upload, so this map's silence about those files means "never sent", not "deleted". Treating it as
     * the whole truth would wipe the user's API keys — the one thing here with no other copy, and the
     * exact bug §4.5.4b deviation 7 records for the repo path.
     */
    await workbenchStore.restoreFiles(working!.files, { protect: protectForRepoRestore });

    if (db) {
      /* Make it this browser's checkpoint too, so undo works and the next mount reads locally. */
      await createLocalSnapshot(db, { projectId: pid, files: working!.files, label: 'Recovered' });
    }

    /*
     * Honest: recovered work has NOT been pushed anywhere the user controls. Saying otherwise would
     * silence the very nudges that exist to stop this happening again.
     */
    unsavedWork.set(true);

    if (prepareToRun) {
      await prepareMountedProject(working!.files);
    }

    lastMount = { source: 'working', messageId: undefined };
    toast.success('Recovered your project from the last checkpoint.');

    return;
  }

  if (decision.source === 'repo') {
    lastMount = { source: 'repo' };
    await mountFromRepo(pid, prepareToRun);

    return;
  }

  if (decision.source === 'empty') {
    /*
     * `empty` for a LINKED project is not necessarily nothing — it can be a remix seed we did not know
     * about, since `hasServerSeed` needs a round-trip we do not make on the common path. Trying the
     * seed here costs one request on a path that had nothing to show anyway.
     */
    lastMount = { source: 'empty' };
    await mountFromSeed(pid, prepareToRun);

    return;
  }

  lastMount = { source: 'empty' };
  await mountFromSeed(pid, prepareToRun);
}

/**
 * Fetch the linked repo and put it on screen.
 *
 * The pulled files become this browser's first checkpoint AND are marked as synced — they came FROM
 * the repo, so they are by definition saved. Skipping the mark would make a freshly-opened project
 * claim unsaved work it does not have, and nag the user to save what they just downloaded.
 */
async function mountFromRepo(pid: string, prepareToRun = true): Promise<void> {
  const { files, message } = await pullFromRepo(pid);

  if (!files) {
    // LOUD: this is the path where the repo is the only copy, so failing quietly means an empty screen.
    toast.error(message ?? 'Could not load this project from its repository.');
    return;
  }

  /*
   * `protectForRepoRestore`: the repo is authoritative about everything EXCEPT the `.env` family and
   * `.npmrc`, which `isSecretPath` kept out of every push — so their absence from the tree says
   * nothing, and deleting them would destroy the user's keys, the one thing here with no other copy.
   */
  await workbenchStore.restoreFiles(files, { protect: protectForRepoRestore });

  if (db) {
    await createLocalSnapshot(db, { projectId: pid, files, label: 'Loaded from repository' });
    await markSynced(db, pid);
  }

  unsavedWork.set(false);

  if (prepareToRun) {
    await prepareMountedProject(files);
  }
}

/**
 * Make a freshly-mounted project runnable: reinstall dependencies, then start its dev server.
 *
 * Every mount path funnels through here, because the reason a project cannot run is the same wherever
 * its files came from. The WebContainer is torn down on every page reload, and `node_modules` is in
 * neither a checkpoint (the watcher ignores it) nor a repository (it is gitignored) — so a mounted
 * project always has all of its source and none of its dependencies. Without this, the single most
 * common user action, a page reload, mounts from the local checkpoint and leaves a complete, correct,
 * entirely non-running game with an empty terminal and "No preview available" — the exact broken-
 * looking state the repo-mount install was added to prevent, on the far more frequent path.
 *
 * Skipped when this container is already prepared (or being prepared). Two independent signals:
 *
 *   - `previews.length > 0` — a dev server is already serving, whoever started it (a project switched
 *     to and back, or the mixedId reload path's command-replay). Reinstalling under a live Vite would
 *     disrupt it and a second `npm run dev` would fight it for the port.
 *   - `preparingContainer` — THIS module already began preparing this page's container. The mount
 *     effect fires more than once per load (its deps include `searchParams`, whose reference changes on
 *     hydration), and the runs are SEQUENTIAL, so `mountInFlight` (which only dedupes concurrent calls)
 *     does not catch them. Without this flag the second run reinstalls and starts a SECOND dev server
 *     in the window before the first registers its preview. Reset on failure so a real error can retry;
 *     left set on success, and cleared for the whole page only by a reload (the module re-evaluates).
 */
let preparingContainer = false;

async function prepareMountedProject(files: SerializedFileMap): Promise<void> {
  if (workbenchStore.previews.get().length > 0 || preparingContainer) {
    return;
  }

  preparingContainer = true;

  const ready = await installDependencies(files);

  if (ready) {
    await startDevServer(files);
  } else {
    // Install failed — let a later mount try again rather than wedging this container as "prepared".
    preparingContainer = false;
  }
}

/**
 * Reinstall a mounted project's dependencies (see `prepareMountedProject` for who calls this and why).
 *
 * `decideDependencyInstall` decides; this only runs it. Failure is reported, never swallowed: a
 * project that cannot install is one the user needs to know about, and the alternative is a blank
 * preview with no explanation.
 *
 * Returns whether the project is ready to run — install succeeded, or was unnecessary because
 * `node_modules` is already present. The caller uses that to decide whether to start the dev server:
 * starting it on a failed install just produces a second, more confusing error.
 */
async function installDependencies(files: SerializedFileMap): Promise<boolean> {
  const paths = Object.keys(files);

  const decision = decideDependencyInstall({
    // The repo never carries `node_modules`, and `restoreFiles` writes exactly what the repo had.
    hasNodeModules: paths.some((path) => path.includes('/node_modules/')),
    hasManifest: hasManifest(paths),
    lockfile: (() => {
      const lock = findLockfile(paths);
      const dirent = lock ? files[lock] : undefined;

      return dirent?.type === 'file' ? dirent.content : undefined;
    })(),
  });

  if (!decision.install) {
    // Nothing to install (already present, or no manifest) — the project is as ready as it will get.
    return true;
  }

  const shell = workbenchStore.boltTerminal;
  const toastId = toast.loading('Getting this project ready — installing its dependencies…');

  try {
    const result = await shell.executeCommand(`deps-${Date.now()}`, 'npm install');

    /*
     * `undefined` means the boltTerminal had not attached yet — `executeCommand` drops the command and
     * returns nothing (it is not a non-zero exit). On a fresh page the mount effect can reach here
     * before the terminal's process exists, and the effect re-fires (its deps include `searchParams`),
     * so a later cycle runs the install once the terminal is up. Treat this as "not yet", NOT a
     * failure: dismiss the toast quietly and return false so `prepareMountedProject` frees its guard and
     * lets that later cycle retry. Deliberately NOT `await shell.ready()` — the terminal may never
     * attach (the workbench can stay closed), and an unbounded wait there hangs the whole mount.
     */
    if (!result) {
      toast.dismiss(toastId);
      return false;
    }

    if (result.exitCode !== 0) {
      toast.update(toastId, {
        render: 'This project loaded, but installing its dependencies failed. Open the terminal to see why.',
        type: 'error',
        isLoading: false,
        autoClose: 8000,
      });

      return false;
    }

    toast.update(toastId, { render: 'Ready.', type: 'success', isLoading: false, autoClose: 2000 });

    return true;
  } catch (error) {
    toast.update(toastId, {
      render: `Could not install this project's dependencies: ${(error as Error).message}`,
      type: 'error',
      isLoading: false,
      autoClose: 8000,
    });

    return false;
  }
}

/**
 * Start the dev server for a freshly-mounted project so its preview comes up on its own (SPEC §4.5.4b).
 *
 * A created project gets this for free — its artifact carries a `start` action. A project mounted from
 * a repo has no artifact to replay, so without this it installs cleanly and then sits at
 * "No preview available" until the user discovers they must open a terminal and run `npm run dev` — a
 * complete, correct, entirely non-running game, which reads as a broken product.
 *
 * Non-blocking by design: the dev server runs for the life of the session and never exits, so awaiting
 * it would hang the mount forever. The preview populates itself from the WebContainer `server-ready`
 * event once Vite is listening. A project that declares no dev/start script is a no-op — nothing to
 * run, and inventing a command would trip the shell allow-list.
 */
async function startDevServer(files: SerializedFileMap): Promise<void> {
  const manifestPath = findManifest(Object.keys(files));
  const dirent = manifestPath ? files[manifestPath] : undefined;
  const script = devScriptFromManifest(dirent?.type === 'file' ? dirent.content : undefined);

  /*
   * The container is a page-level singleton, so a dev server started for one project keeps running as
   * the user moves between projects. `shouldStartDevServer` skips when one is already serving — a second
   * `npm run dev` would only fight it for the port. See its doc for the full reasoning.
   */
  if (!script || !shouldStartDevServer({ script, runningPreviews: workbenchStore.previews.get().length })) {
    return;
  }

  const shell = workbenchStore.boltTerminal;

  /*
   * Fire and forget — `npm run dev` stays alive for the whole session; the preview store takes it from here.
   * Reached only after a successful install, which already proved the terminal is attached.
   */
  void shell.executeCommand(`dev-${Date.now()}`, `npm run ${script}`).catch((error) => {
    logger.error('Dev server failed to start after mount', error);
  });
}

/**
 * The save queue for the project currently open (§4.5.4b).
 *
 * Rebuilt per project rather than shared: `saveState` is what the header badge reads, and a
 * module-level queue would carry one project's `failed` badge into the next project the user opens.
 */
let queue: SaveQueue | undefined;
let queueProjectId: string | undefined;

function saveQueueFor(pid: string): SaveQueue {
  if (queue && queueProjectId === pid) {
    return queue;
  }

  queueProjectId = pid;
  saveState.set({ status: 'idle' });

  queue = new SaveQueue({
    /*
     * The files are read HERE, at push time — never captured when the save was requested. A retry that
     * runs 30 seconds later would otherwise push a stale snapshot, silently reverting whatever the
     * user did in between.
     */
    push: async () => {
      const files = await workbenchStore.serializeFiles();
      const outcome = await saveProjectToRepo(pid, { files, summary: lastSummary, provider: preferredProvider });

      if (outcome.ok && db) {
        /*
         * Mark synced only after the push LANDED. This is what the indicator, the nudges and the
         * beforeunload warning all read — marking optimistically would tell the user their only copy
         * is safe at the exact moment it is not.
         */
        await markSynced(db, pid);
        unsavedWork.set(false);
      }

      return outcome;
    },
  });

  return queue;
}

/**
 * What the last generation was for — becomes the commit message (§4.13).
 *
 * The user's own request, not the assistant's reply. It is what they would recognise scrolling their
 * repo's history six months later ("add boost pads to the track"), and it is a single short line,
 * where the reply is an artifact full of code. `buildCommitMessage` bounds and prefixes it.
 */
let lastSummary: string | undefined;

/**
 * The provider chosen for the FIRST save of an unlinked project (which account the repo is created in).
 * Read by the queue's push callback. Only meaningful before a project is linked; once linked, the
 * server uses the project's own provider and ignores this.
 */
let preferredProvider: 'github' | 'gitlab' | undefined;

/** The last thing the user asked for, as plain text. */
function summarizeRequest(messages: Message[]): string | undefined {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');

  if (!lastUserMessage) {
    return undefined;
  }

  const text =
    typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : // A multimodal message (text + images): the text parts are the request.
        (lastUserMessage.content as Array<{ type: string; text?: string }>)
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join(' ');

  /*
   * Strip the model-directed prefixes the chat prepends to a user's words (skills, context markers).
   * They are instructions to us, not something a person wants to read in their commit log.
   */
  return text.replace(/\[[^\]]*\]/g, '').trim() || undefined;
}

/**
 * Refresh what we know about the project's repository after a checkpoint.
 *
 * 🔴 **THIS USED TO PUSH (removed by owner decision, 2026-07-23).** §4.5.4b's "auto-push on checkpoint
 * defaults ON once linked" is RETIRED: a checkpoint fires after every generation, so a linked project
 * was writing to the user's own repository on its own initiative, and the header said "Synced to
 * GitHub" because it had just done it. Writing to somebody's repository is not a background chore —
 * it is the one action in this product that leaves the platform and lands somewhere they own, under
 * their name, visible to anyone they have shared it with. It needs a person to press a button.
 *
 * What is left is the READ: the link state still refreshes here, so the chip can go amber ("Changes
 * not synced") the moment a generation produces work the repository does not have. That is the whole
 * replacement for the automatic push — say it plainly and let the user decide.
 *
 * ⚠️ Do not "restore" this as an opt-in preference without the owner asking. `autoPush` survives as a
 * stored field (§4.5.4b, migration 0006) and nothing reads it any more; a toggle that silently pushes
 * is the same decision wearing a checkbox.
 */
async function refreshRepoStatus(pid: string): Promise<void> {
  repoStatus.set(repoStatus.get() ?? (await getRepoStatus(pid)));
}

/**
 * Sync, because the user pressed Commit changes (§4.5.4b).
 *
 * The ONLY path that writes to the user's repository. It goes through the save queue, which
 * coalesces concurrent requests and owns the "did it land?" logic — the half that must never be wrong.
 *
 * It handles being UNLINKED too: pressing the button on an unlinked project is the user asking for
 * exactly the thing that makes it linked, so the route creates the repository.
 *
 * Never throws. The outcome is reported through `saveState`, which the header badge reads.
 */
export async function requestSave(pid: string, provider?: 'github' | 'gitlab'): Promise<void> {
  /*
   * The first save of an unlinked project may name a provider (which account to create the repo in).
   * It is stored where the queue's push callback reads it — like `lastSummary` — because the push runs
   * later (at flush time, after any retries) and must not capture a value from when Save was clicked.
   * A linked project ignores it server-side, so leaving a stale choice set does no harm.
   */
  if (provider) {
    preferredProvider = provider;
  }

  const outcome = await saveQueueFor(pid).request();

  if (!outcome) {
    // Coalesced into a save already in flight. That save reports for both of us.
    return;
  }

  if (outcome.divergence) {
    mountDivergence.set({ projectId: pid, remoteHead: '' });
    return;
  }

  if (outcome.reconnect) {
    // The badge offers the reconnect button; `saveState` already carries it. Nothing to add here.
    return;
  }

  if (outcome.ok) {
    /*
     * Refresh the link. On a FIRST save this is what turns the badge from "browser only" into the
     * user's own repo name — the whole point of having pressed the button, and invisible without it.
     */
    repoStatus.set(await getRepoStatus(pid));

    toast.success(outcome.created ? `Saved. Your game is now in your own repository.` : 'Saved.');
  }
}

/** Send the user through OAuth and bring them back to this page. */
export function startGitConnect(provider: 'github' | 'gitlab' = 'github'): void {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/git/connect/${provider}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Read the one-time remix seed, if there is one, and adopt it as this browser's first checkpoint. */
async function mountFromSeed(pid: string, prepareToRun = true): Promise<void> {
  const { files } = await readRemixSeed(pid);

  if (!files) {
    return;
  }

  // The seed is built with the same secret rule (`buildRemixSeed` → `isSecretPath`), so it is protected the same way.
  await workbenchStore.restoreFiles(files, { protect: protectForRepoRestore });

  if (db) {
    await createLocalSnapshot(db, { projectId: pid, files, label: 'Opened' });
  }

  unsavedWork.set(true);

  if (prepareToRun) {
    await prepareMountedProject(files);
  }
}

export function useChatHistory() {
  const navigate = useNavigate();
  const { id: mixedId } = useLoaderData<{ id?: string }>();
  const [searchParams] = useSearchParams();

  const [archivedMessages, setArchivedMessages] = useState<Message[]>([]);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const [urlId, setUrlId] = useState<string | undefined>();

  /** Guards against re-checkpointing the same message — see `checkpointProject`. */
  const lastCheckpointedMessage = useRef<string | undefined>(undefined);

  /** The conversation as last stored locally — uploaded to the server once a generation finishes. */
  const latestMessages = useRef<Message[]>([]);

  /**
   * The chat's `urlId`, mirrored in a ref because `storeMessageHistory` needs it SYNCHRONOUSLY.
   *
   * 🔴 `setUrlId` is a React state setter: it does not update the `urlId` captured by the current
   * closure. `storeMessageHistory` fires many times per generation (every mutation of the message
   * array), so a guard reading the state variable is still `undefined` on the second call and mints a
   * SECOND slug — whose `getUrlId` then collides with the chat the first call just wrote and returns
   * `…-2`. Measured: a brand-new chat, alone in the database, landed on
   * `/chat/how-does-the-boost-pad-work-in-this-game-2`, renaming its own URL mid-generation.
   */
  const urlIdRef = useRef<string | undefined>(undefined);

  /**
   * When THIS chat began (§4.5.6).
   *
   * Sent on every save so the server's `createdAt` stays the chat's real birthday rather than becoming
   * "the last time it was written" — which is what `updatedAt` already means, and what a chat picker
   * would otherwise sort by twice.
   */
  const chatCreatedAt = useRef<string>(new Date().toISOString());

  useEffect(() => {
    if (!db) {
      setReady(true);

      if (persistenceEnabled) {
        const error = new Error('Chat persistence is unavailable');
        logStore.logError('Chat persistence initialization failed', error);
        toast.error('Chat persistence is unavailable');
      }

      return;
    }

    /**
     * Bring back the conversation from the server (§4.5.4b).
     *
     * This is the half of "server = project record + chat" that was never built: `saveMessages` had
     * been uploading every conversation and `loadMessages` had ZERO call sites, so a project opened
     * on a second device got its files back from the repo and lost its history entirely.
     *
     * 🔴 The messages are marked `NO_REPLAY` before they go anywhere near the parser. Parsing an
     * assistant message RUNS its actions — that is how upstream rebuilds a project with no snapshot
     * — and these files came from the user's repository moments ago. Replaying them would write
     * stale bodies over the real ones, silently. `markAsTranscript` is what stops that, and the mark
     * rides along into IndexedDB so a later reload cannot lose it.
     *
     * Cosmetic by construction: any failure leaves the user with their game and no transcript, which
     * is exactly where they were before this existed. It must never cost them the mount.
     */
    const restoreTranscript = async (pid: string, wantedChatId?: string) => {
      if (!db) {
        return;
      }

      try {
        /*
         * A project has MANY chats (§4.5.6), so "restore the conversation" is now a choice. Default to
         * the most recently touched one — `listChats` sorts newest-first, and the chat you were last
         * in is the one you meant. The dashboard can ask for a specific one by id.
         */
        const chats = await listChats(pid);
        const wanted = wantedChatId ? chats.find((chat) => chat.serverChatId === wantedChatId) : chats[0];

        if (!wanted) {
          return;
        }

        const serverMessages = await loadMessages<Message>(pid, wanted.serverChatId);

        if (!hasRestorableHistory(serverMessages)) {
          return;
        }

        const transcript = markAsTranscript(serverMessages);
        setInitialMessages(transcript);
        restoredTranscript = transcript;

        const firstUserMessage = transcript.find((message) => message.role === 'user');
        const title =
          wanted.title ?? (firstUserMessage ? summarizeRequest([firstUserMessage])?.slice(0, 60) : undefined);

        if (title) {
          description.set(title);
        }

        /*
         * Persist it as a local chat so a plain reload finds it — the pending-mount baton is
         * one-shot (sessionStorage), so without this the history would come back once and vanish on
         * F5. `navigateChat` uses replaceState: the URL becomes /chat/:id WITHOUT re-running this
         * effect, which would otherwise take the mixedId branch and replay everything we just
         * marked as not-for-replay.
         *
         * 🔴 REUSE the local chat this conversation already has, if there is one. This used to mint a
         * fresh `getNextId` every time, so every open of the same project deposited ANOTHER local copy
         * of the same conversation: four opens of "Kart Racer" left four identical chats, all carrying
         * the same `serverChatId`. The server id is the conversation's identity (§4.5.6) — the local
         * record is just this browser's cache of it, so there must be at most one per server id.
         */
        const existing = (await getAll(db)).find((chat) => chat.metadata?.serverChatId === wanted.serverChatId);
        const localId = existing?.id ?? (await getNextId(db));
        chatId.set(localId);

        /*
         * The chat's SERVER id is its URL — see `mintUrlId` for why that is a uuid and not a title.
         *
         * This used to mint `getUrlId(db, slugForChat(title, pid))`: a slug of the title, de-duplicated
         * against THIS browser's IndexedDB. On a restore that is doubly wrong. It is not unique across
         * users (every account that types "start dev server" gets the same one, and the de-duplication
         * cannot see them), and it means the SAME conversation gets a different URL on every device —
         * on a machine that already had an unrelated `start-dev-server`, this one silently became
         * `start-dev-server-2`. Measured: the sidebar linked `/chat/ed04b49f-…`, the chat opened
         * correctly, and then this rewrote the address bar to `/chat/start-dev-server`.
         *
         * A chat has one identity. It is the id, and it is the same everywhere.
         */
        const urlSlug = wanted.serverChatId;

        // Ref and state together, always — `storeMessageHistory` reads the ref (see `urlIdRef`).
        urlIdRef.current = urlSlug;
        setUrlId(urlSlug);

        /*
         * The chat keeps its SERVER id across the device switch — that is the whole point. Minting a
         * new one here would upload this same conversation a second time under a second id, so the
         * user would watch their chat list grow by one every time they opened the project elsewhere.
         */
        const metadata: IChatMetadata = { projectId: pid, serverChatId: wanted.serverChatId };
        chatMetadata.set(metadata);
        chatCreatedAt.current = wanted.createdAt;

        await setMessages(db, localId, transcript, urlSlug, title, undefined, metadata);
        navigateChat(urlSlug);

        logger.info(`Restored ${transcript.length} message(s) for project ${pid} from the server.`);
      } catch (error) {
        // Never fatal, and never silent to US — the user still has their project.
        logger.warn(`Could not restore the conversation for ${pid}: ${(error as Error).message}`);
      }
    };

    /**
     * Open `/chat/:id` for a chat this browser has never seen (§4.5.6, §4.5.4b).
     *
     * This is what makes a chat URL mean anything on a second device. Before it, the miss branch was a
     * bare `navigate('/')`: IndexedDB had no record, so the URL was treated as garbage and the user was
     * bounced to the landing page — even though the conversation was sitting on the server the whole
     * time. A link to your own chat, opened on your own laptop, went nowhere.
     *
     * The id is the chat's `serverChatId` (see `mintUrlId` for why it is a UUID and not a title slug).
     * Ownership is the server's business: `/api/chats` only ever returns the caller's own chats, so a
     * UUID belonging to someone else simply is not in the list and falls through to the landing page —
     * the same answer as a nonexistent one, which is the 404-not-403 rule (§4.5.3) applied to a URL.
     *
     * Returns false for "not mine / not found", so the caller keeps its existing behaviour.
     */
    const openFromServer = async (id: string): Promise<boolean> => {
      try {
        const chats = await listAllChats();
        const chat = chats.find((candidate) => candidate.serverChatId === id);

        if (!chat) {
          return false;
        }

        projectId.set(chat.projectId);
        chatMetadata.set({ projectId: chat.projectId, serverChatId: chat.serverChatId });

        await Promise.all([mountProjectFiles(chat.projectId), restoreTranscript(chat.projectId, chat.serverChatId)]);

        /*
         * AFTER both — the check compares what was mounted against what the transcript says was paid
         * for, and either half alone answers nothing (§4.5.4c).
         */
        await checkUnappliedTurn(chat.projectId);

        return true;
      } catch (error) {
        logger.warn(`Could not open chat ${id} from the server: ${(error as Error).message}`);
        return false;
      }
    };

    if (mixedId) {
      Promise.all([
        getMessages(db, mixedId),
        getSnapshot(db, mixedId), // Fetch snapshot from DB
      ])
        .then(async ([storedMessages, snapshot]) => {
          /**
           * 🔴 ALWAYS FETCH. The server is the truth; the browser is a staging area (§4.5.6, §4.5.4b).
           *
           * This used to be local-first with no freshness check — the `storedMessages` branch below ran
           * whenever the browser had a copy, and the server was consulted only when it did not. That was
           * survivable while the sidebar listed only THIS browser's chats, because a stale local copy
           * was the only copy you could reach. Making the list account-wide turned it into a data-loss
           * path AND made it the common one:
           *
           *   1. Desktop opens chat X — local copy, 10 messages.
           *   2. Laptop continues X — the server now has 15.
           *   3. Desktop opens X from the sidebar → the local copy wins → the 5 newer are invisible.
           *   4. Desktop sends a message → `putChat` is a blind overwrite → the laptop's 5 are GONE.
           *
           * One user, two devices — the exact case "chats follow you" exists to serve.
           *
           * The local read above is not wasted: it is the FALLBACK. If the server cannot answer (offline,
           * a blip) we still open the browser's copy, because stale-but-present beats a conversation that
           * appears to have vanished, and the next successful open reconciles it. That is also why the
           * local record is kept rather than deleted — `storeMessageHistory` writes it on every message
           * while the server is only written at the END of a generation (`checkpointProject`), so it is
           * the write-ahead buffer that survives a crash, a closed tab, or a failed generation.
           */
          if (isServerChatId(mixedId) && (await openFromServer(mixedId))) {
            setReady(true);
            return;
          }

          if (storedMessages && storedMessages.messages.length > 0) {
            /*
             * const snapshotStr = localStorage.getItem(`snapshot:${mixedId}`); // Remove localStorage usage
             * const snapshot: Snapshot = snapshotStr ? JSON.parse(snapshotStr) : { chatIndex: 0, files: {} }; // Use snapshot from DB
             */
            const validSnapshot = snapshot || { chatIndex: '', files: {} }; // Ensure snapshot is not undefined
            const summary = validSnapshot.summary;

            const rewindId = searchParams.get('rewindTo');
            let startingIdx = -1;
            const endingIdx = rewindId
              ? storedMessages.messages.findIndex((m) => m.id === rewindId) + 1
              : storedMessages.messages.length;
            const snapshotIndex = storedMessages.messages.findIndex((m) => m.id === validSnapshot.chatIndex);

            if (snapshotIndex >= 0 && snapshotIndex < endingIdx) {
              startingIdx = snapshotIndex;
            }

            if (snapshotIndex > 0 && storedMessages.messages[snapshotIndex].id == rewindId) {
              startingIdx = -1;
            }

            let filteredMessages = storedMessages.messages.slice(startingIdx + 1, endingIdx);
            let archivedMessages: Message[] = [];

            if (startingIdx >= 0) {
              archivedMessages = storedMessages.messages.slice(0, startingIdx + 1);
            }

            setArchivedMessages(archivedMessages);

            if (startingIdx > 0) {
              const files = Object.entries(validSnapshot?.files || {})
                .map(([key, value]) => {
                  // Binaries carry no text content and no project commands (package.json etc.).
                  if (value?.type !== 'file' || value.isBinary) {
                    return null;
                  }

                  return {
                    content: value.content,
                    path: key,
                  };
                })
                .filter((x): x is { content: string; path: string } => !!x); // Type assertion
              const projectCommands = await detectProjectCommands(files);

              // Call the modified function to get only the command actions string
              const commandActionsString = createCommandActionsString(projectCommands);

              filteredMessages = [
                {
                  id: generateId(),
                  role: 'user',
                  content: `Restore project from snapshot`, // Removed newline
                  annotations: ['no-store', 'hidden'],
                },
                {
                  id: storedMessages.messages[snapshotIndex].id,
                  role: 'assistant',

                  // Combine followup message and the artifact with files and command actions
                  content: `Bolt Restored your chat from a snapshot. You can revert this message to load the full chat history.
                  <boltArtifact id="restored-project-setup" title="Restored Project & Setup" type="bundled">
                  ${Object.entries(snapshot?.files || {})
                    .map(([key, value]) => {
                      /**
                       * Binary files are deliberately omitted: their bytes are already on
                       * disk via restoreSnapshot. Emitting them here would inline base64
                       * into LLM context (SPEC §1.3 principle 10) and have the action
                       * runner rewrite them as UTF-8 text, corrupting them.
                       */
                      if (value?.type === 'file' && !value.isBinary) {
                        return `
                      <boltAction type="file" filePath="${key}">
${value.content}
                      </boltAction>
                      `;
                      } else {
                        return ``;
                      }
                    })
                    .join('\n')}
                  ${commandActionsString} 
                  </boltArtifact>
                  `, // Added commandActionsString, followupMessage, updated id and title
                  annotations: [
                    'no-store',
                    ...(summary
                      ? [
                          {
                            chatId: storedMessages.messages[snapshotIndex].id,
                            type: 'chatSummary',
                            summary,
                          } satisfies ContextAnnotation,
                        ]
                      : []),
                  ],
                },

                // Remove the separate user and assistant messages for commands
                /*
                 *...(commands !== null // This block is no longer needed
                 *  ? [ ... ]
                 *  : []),
                 */
                ...filteredMessages,
              ];

              /*
               * Upstream called `restoreSnapshot(mixedId)` with NO snapshot, so it restored `{}` and
               * wrote nothing. The files came back only by replaying the `<boltAction>` artifact
               * above — which is TEXT ONLY, so every binary (textures, models, audio, the framework's
               * own PNGs) was silently missing after a reload. Passing the snapshot restores the
               * bytes; the artifact still replays the text.
               */
              await restoreSnapshot(mixedId, validSnapshot);
            }

            setInitialMessages(filteredMessages);

            // Ref and state together, always — `storeMessageHistory` reads the ref (see `urlIdRef`).
            urlIdRef.current = storedMessages.urlId;
            setUrlId(storedMessages.urlId);
            description.set(storedMessages.description);
            chatId.set(storedMessages.id);
            chatMetadata.set(storedMessages.metadata);
            projectId.set(storedMessages.metadata?.projectId);

            /*
             * 🔴 The hierarchy INVERTED here (§4.5.4b).
             *
             * This used to fetch the SERVER's checkpoint and unconditionally overwrite whatever the
             * local snapshot had just restored — because the platform was the authority on files. It
             * holds none now, and "overwrite local with remote, always" is precisely the bug that
             * would eat a user's unsaved work on every reload.
             *
             * `mountProjectFiles` decides properly: local, the linked repo, or a divergence the user
             * resolves. Reloading a project saved on another device is what makes it come back here.
             */
            const pid = storedMessages.metadata?.projectId;

            if (pid) {
              try {
                /*
                 * prepareToRun: false — the artifact spread into `filteredMessages` above carries this
                 * project's `npm install` + `npm run dev` (createCommandActionsString) and the parser
                 * replays them. Installing here as well would race that first installer on the shared
                 * boltTerminal and flash a spurious "dependencies failed" toast over a project that is
                 * installing and starting perfectly well.
                 */
                await mountProjectFiles(pid, { prepareToRun: false });
              } catch (error) {
                logger.warn(`Could not restore project ${pid}: ${(error as Error).message}`);
              }
            }
          } else {
            // The server did not have it and neither does this browser. Nothing to open.
            navigate('/', { replace: true });
          }

          setReady(true);
        })
        .catch((error) => {
          console.error(error);

          logStore.logError('Failed to load chat messages or snapshot', error); // Updated error message
          toast.error('Failed to load chat: ' + error.message); // More specific error
        });
    } else {
      /*
       * No mixedId — a fresh builder. But a remix (§4.8) or a dashboard "Open" (§4.1) may have parked a
       * project id here on its way in. If so, adopt it and mount its files. The conversation is fresh
       * (both start a new chat), but the files are the real project, ready to build on.
       *
       * Local checkpoints first, then the server SEED (§4.5.4b). The seed is not ambient persistence —
       * it is the one-time copy a remix leaves behind so the clone has something to open (`api.remix`),
       * and it exists precisely because the source project's own repo belongs to someone else. A
       * project that has been worked on in this browser has local checkpoints and never reads it.
       */

      const pendingMount = takePendingProjectMount();

      if (pendingMount) {
        const { projectId: mountProjectId, serverChatId, freshChat } = pendingMount;

        projectId.set(mountProjectId);

        /*
         * 🔴 A NEW CHAT MUST BE BORN WITH NO IDENTITY — these atoms are MODULE-level, and "New chat"
         * reaches this code by `navigate('/')`, which is an SPA transition. Nothing unloads. So every
         * atom below arrives still holding the PREVIOUS chat's values, and the previous chat is a real
         * conversation with a real transcript.
         *
         * This block used to be `chatMetadata.set({ ...chatMetadata.get(), projectId })`, which spread
         * the old metadata forward — carrying `serverChatId` into a chat that is not that chat. Three
         * things then quietly destroyed the old conversation on the first message of the new one:
         *
         *   - `ensureServerChatId` returns the EXISTING id if the atom has one, so the new chat saved
         *     its messages over the old chat's server object (§4.5.4b: the only copy we hold).
         *   - `storeMessageHistory` mints a local id only `if (!chatId.get())`, so the new chat also
         *     wrote over the old chat's IndexedDB record.
         *   - `description` survived, so the header labelled the new chat "start dev server" — the old
         *     chat's title. That was the only visible symptom, and it read as a cosmetic glitch.
         *
         * Net effect: "New chat, same game" REPLACED the chat you started it from, on both copies, and
         * the sidebar count never moved. The decision is `identityForMount` — pure and exhaustively
         * tested, like every other path that overwrites the user's data without being asked.
         */
        const identity = identityForMount({
          current: {
            chatId: chatId.get(),
            description: description.get(),
            urlId: urlIdRef.current,
            metadata: chatMetadata.get() ?? {},
          },
          projectId: mountProjectId,
          freshChat,
        });

        chatId.set(identity.chatId);
        description.set(identity.description);
        chatMetadata.set(identity.metadata);

        // Ref and state together, always — `storeMessageHistory` reads the ref (see `urlIdRef`).
        urlIdRef.current = identity.urlId;
        setUrlId(identity.urlId);

        /*
         * `freshChat` is "New chat, same game" (§4.5.6): mount the files, restore NO transcript. It is
         * deliberately not a variant of `restoreTranscript` — the whole point of the feature is that
         * the conversation does NOT come back, so the code path that brings conversations back is not
         * involved. The files still mount, which is the other half of the point: the new chat opens on
         * the same game, and the agent reads it from the FS the way it always does.
         */
        Promise.all([
          mountProjectFiles(mountProjectId),
          freshChat ? Promise.resolve() : restoreTranscript(mountProjectId, serverChatId),
        ])
          /*
           * AFTER both, and only for a chat that actually came back: the check compares what was
           * mounted against what the transcript says was paid for, so a fresh chat (no transcript)
           * has nothing to compare and must not raise an offer (§4.5.4c).
           */
          .then(() => (freshChat ? undefined : checkUnappliedTurn(mountProjectId)))
          .catch((error) => logger.warn(`Could not load project ${mountProjectId}: ${error.message}`))
          .finally(() => setReady(true));
      } else {
        setReady(true);
      }
    }
  }, [mixedId, db, navigate, searchParams]); // Added db, navigate, searchParams dependencies

  const takeSnapshot = useCallback(
    async (chatIdx: string, _files: FileMap, _chatId?: string | undefined, chatSummary?: string) => {
      const id = chatId.get();

      if (!id || !db) {
        return;
      }

      /**
       * Serialize from the WebContainer rather than snapshotting the in-memory FileMap:
       * binary files hold no content in the map, so persisting it directly wrote empty
       * PNGs/GLBs into the snapshot (SPEC §1.3 principle 10).
       */
      const files = await workbenchStore.serializeFiles();

      const snapshot: Snapshot = {
        chatIndex: chatIdx,
        files,
        summary: chatSummary,
      };

      // localStorage.setItem(`snapshot:${id}`, JSON.stringify(snapshot)); // Remove localStorage usage
      try {
        await setSnapshot(db, id, snapshot);
      } catch (error) {
        console.error('Failed to save snapshot:', error);
        toast.error('Failed to save chat snapshot.');
      }
    },
    [db],
  );

  /**
   * This chat's identity on the server, minting one if it does not have it yet (§4.5.6).
   *
   * 🔴 The id is a UUID and deliberately NOT the local chat id: `getNextId` is a per-browser counter,
   * so every browser's first chat is "1" and keying the server transcript by it would make two devices
   * collide on one object. See `IChatMetadata.serverChatId`.
   *
   * Minted at FIRST SAVE rather than at chat creation, so an abandoned empty chat costs nothing. It is
   * written into IndexedDB here rather than left on the atom for the next `storeMessageHistory` to
   * persist: if the tab closed in between, the id would be lost, and the next save would mint a second
   * one — quietly duplicating the conversation on the server.
   */
  const ensureServerChatId = useCallback(async (): Promise<string | undefined> => {
    const existing = chatMetadata.get()?.serverChatId;

    if (existing) {
      return existing;
    }

    const id = chatId.get();

    if (!db || !id) {
      return undefined;
    }

    const metadata: IChatMetadata = { ...chatMetadata.get(), serverChatId: mintServerChatId() };
    chatMetadata.set(metadata);

    /*
     * `urlIdRef.current`, NOT `urlId` — the stale-state trap again, and here it WIPES.
     *
     * This runs from `checkpointProject` at the end of a generation, after `storeMessageHistory` has
     * already written the chat's slug. Passing this closure's `urlId` (still `undefined`, because
     * `setUrlId` never updates a captured value) rewrote the record with NO urlId — so the chat became
     * invisible in the sidebar at the exact moment it was first saved to the server. Measured: a chat
     * with a correct `/chat/how-does-the-boost-pad-work-in-this-game` URL and no sidebar entry.
     */
    await setMessages(db, id, latestMessages.current, urlIdRef.current, description.get(), undefined, metadata);

    return metadata.serverChatId;

    // No deps: everything read here is a ref or an atom, deliberately — that is what makes it not stale.
  }, []);

  /** Upload THIS conversation to its own object (§4.5.6) — one chat among the project's many. */
  const saveCurrentChat = useCallback(
    async (pid: string) => {
      const serverChatId = await ensureServerChatId();

      if (!serverChatId) {
        return;
      }

      await saveMessages(pid, serverChatId, latestMessages.current, {
        title: description.get(),
        createdAt: chatCreatedAt.current,
      });
    },
    [ensureServerChatId],
  );

  /**
   * Push a checkpoint to the server (§4.5.5, §4.12).
   *
   * DELIBERATELY NOT called from `takeSnapshot`. Upstream fires that on every mutation of the message
   * array — which, while a generation streams, is every few hundred milliseconds. Hooking a server
   * upload to it produced 160+ checkpoints for ONE message, each a 5.9MB copy of the whole project:
   * about a gigabyte of uploads competing with the stream the user is waiting on. It made the build
   * visibly crawl.
   *
   * SPEC §4.5.5 says it plainly — snapshot "after each APPLIED generation", not per token. So this is
   * called once, from `onFinish`, when the files have stopped moving.
   *
   * Idempotent on `messageId`: a re-render, a retry, or a double `onFinish` cannot mint a duplicate.
   */
  const checkpointProject = useCallback(async (messageId: string) => {
    const pid = projectId.get();

    if (!pid || !db || lastCheckpointedMessage.current === messageId) {
      return;
    }

    lastCheckpointedMessage.current = messageId;
    lastSummary = summarizeRequest(latestMessages.current);

    try {
      const files = await workbenchStore.serializeFiles();

      /*
       * ⚠️ **AMENDED (§4.5.4c).** This comment used to say the files stay in this browser, full stop —
       * that a server-side copy "is not a backup, it is the old model under a new name". That was true
       * of what it replaced (`createSnapshot` per generation: an unbounded, caller-addressed HISTORY),
       * and it is why none of what follows reintroduces one.
       *
       * What it missed is that the browser was then the ONLY copy. Measured: a `/bt-landing` run
       * finished, settled 427 credits, the tab died, and the work — plus every trace that it had
       * happened — was gone. §4.12 sells checkpoints as the safety net for non-developers, i.e. the
       * users least likely to have a git remote, and that net lived only in IndexedDB.
       *
       * So there are now THREE writes here, and the ORDER is load-bearing:
       *
       *   1. the LOCAL checkpoint — the copy the user is about to rely on for undo, written first;
       *   2. the CONVERSATION — §4.5.4b has always kept this (resume on another machine, §4.5);
       *   3. the server WORKING COPY — ONE object per project, overwritten, keyed on the project id.
       *
       * The working copy is deliberately NOT in the `Promise.all`: a failed upload must degrade to "no
       * recovery copy", never to "no checkpoint".
       */
      const [snapshot] = await Promise.all([
        createLocalSnapshot(db, { projectId: pid, files, messageId }),
        saveCurrentChat(pid),
      ]);

      /*
       * Best-effort, and it shares the local checkpoint's `seq` rather than minting its own — resume
       * compares the two, and one monotonic counter is what makes that comparison mean anything. A
       * second counter, or a timestamp, is migration 0003's ledger bug in a third place.
       */
      try {
        /*
         * Size gate (§4.16): above the client budget, do not stringify + upload the whole base64 map —
         * that synchronous pass is what froze the tab on media-heavy projects. The LOCAL checkpoint
         * above is the durable copy; the server copy is best-effort and simply absent until the project
         * shrinks. Treated exactly like a failed upload (the warning below explains it and is actionable).
         */
        if (!withinWorkingCopyBudget(workbenchStore.files.get())) {
          throw new Error('project exceeds the client working-copy budget');
        }

        await saveWorkingCopy(pid, snapshot.seq, files);
        workingCopySafe.set(true);
      } catch (error) {
        /*
         * The local checkpoint is intact, but this browser now holds the only copy — which is exactly
         * the state the beforeunload warning exists for.
         */
        workingCopySafe.set(false);
        logger.warn(`Working copy not saved for ${pid} (local checkpoint is intact): ${(error as Error)?.message}`);

        /*
         * LOUD (§4.5.4b: failed saves are never silent).
         *
         * This used to be a console warn only, which is the worst possible shape: the user believes
         * the platform is protecting them and it is not. The most likely cause is a project past
         * `WORKING_COPY_MAX_MB` — large generated PNGs — and that is actionable, so say it.
         *
         * Once per project per session: the checkpoint fires on every generation, and a toast on each
         * one would be nagging that gets dismissed unread.
         */
        if (!warnedNoRecoveryCopy.has(pid)) {
          warnedNoRecoveryCopy.add(pid);
          toast.warn(
            'This project is not being backed up for crash recovery — sync it to a repository to keep it safe.',
            { autoClose: 8000 },
          );
        }
      }

      /*
       * A generation just produced work that exists in this browser and nowhere else. Everything that
       * warns the user — the indicator, the nudges, the beforeunload prompt — reads this atom, and it
       * is only honest if it is set HERE, at the moment the work becomes unsaved. Auto-push (§4.5.4b)
       * clears it again when it lands.
       */
      unsavedWork.set(true);
      generationCount.set(generationCount.get() + 1);

      logger.info(`Checkpointed project ${pid} at message ${messageId}`);

      /*
       * Refresh the link state so the chip can say "Changes not synced" (§4.5.4b). This used to PUSH;
       * it does not any more (owner decision — see `refreshRepoStatus`). Nothing reaches the user's
       * repository without them pressing Commit changes.
       */
      void refreshRepoStatus(pid);
    } catch (error) {
      /*
       * Reset the guard so the next turn retries.
       *
       * Still not surfaced here, but the reasoning CHANGED and is worth stating: it used to be "their
       * game is on disk and in IndexedDB, so a failed upload is our problem". The local half of that
       * is now the only copy, so a failure to write it is not merely our problem. It stays quiet only
       * because the files are still live in the WebContainer and on screen — nothing is lost yet, and
       * the next generation checkpoints again. The LOUD path is the save to the repo (§4.5.4b), which
       * is the one that decides whether the work survives this browser.
       */
      lastCheckpointedMessage.current = undefined;
      logger.error(`Failed to checkpoint project ${pid}: ${(error as Error).message}`);
    }
  }, []);

  const restoreSnapshot = useCallback(async (_id: string, snapshot?: Snapshot) => {
    const validSnapshot = snapshot || { chatIndex: '', files: {} };

    if (!validSnapshot?.files) {
      return;
    }

    /**
     * Binary entries are base64-decoded and written as bytes. Upstream passed the raw
     * `content` string to `fs.writeFile` for every file, which UTF-8 encoded it — so a
     * binary was written either as a 0-byte file or as literal base64 text.
     */
    await workbenchStore.restoreFiles(validSnapshot.files);
  }, []);

  /**
   * The id this chat lives at in the URL — its SERVER id, not a title (§4.5.6).
   *
   * 🔴 A title slug cannot be a chat's address once there is more than one user.
   *
   * Upstream minted `/chat/<slug-of-the-title>` and de-duplicated it with `getUrlId`, which walks THIS
   * BROWSER's IndexedDB and appends `-2`. That is coherent in bolt.diy: one user, one machine, the chat
   * IS the project, and the slug never leaves the tab. It does not survive anything we have built on
   * top. `/chat/start-dev-server` is not unique — every user who types "start dev server" gets it, and
   * the de-duplication cannot see them because it only knows one browser. The moment the sidebar lists
   * the ACCOUNT's chats rather than the browser's (§4.5.6), that slug has to resolve on the SERVER, and
   * there it is ambiguous. It also puts the conversation's title into the URL bar, browser history, and
   * every proxy log between here and us.
   *
   * So the URL is the `serverChatId`: a v4 UUID, globally unique, unguessable, the same on every device,
   * and already the chat's identity everywhere else in the system (`messages/{projectId}/{id}.json`).
   *
   * Minting it here rather than at first save is free — it is `crypto.randomUUID()`, not a write — and
   * it means the address bar is right from the first message instead of being a slug that later
   * disagrees with what the sidebar links to. `ensureServerChatId` finds it on the atom and reuses it.
   *
   * The fallback is for a chat with no project (nothing to save it against): a local slug, which stays
   * purely local and is exactly as valid as it always was.
   */
  const mintUrlId = useCallback(async (): Promise<string> => {
    const existing = chatMetadata.get()?.serverChatId;

    if (existing) {
      return existing;
    }

    if (projectId.get()) {
      const serverChatId = mintServerChatId();
      chatMetadata.set({ ...chatMetadata.get(), serverChatId });

      return serverChatId;
    }

    // `slugForChat` never returns empty and `getUrlId` de-duplicates against this browser's slugs.
    return getUrlId(db!, slugForChat(description.get(), 'chat'));

    // No deps: everything read here is an atom or a ref, deliberately — that is what makes it not stale.
  }, []);

  return {
    ready: !mixedId || ready,
    initialMessages,
    updateChatMestaData: async (metadata: IChatMetadata) => {
      const id = chatId.get();

      if (!db || !id) {
        return;
      }

      try {
        // `urlIdRef.current` — see `urlIdRef`. The state variable is stale here too, and writing it wipes the slug.
        await setMessages(db, id, initialMessages, urlIdRef.current ?? urlId, description.get(), undefined, metadata);
        chatMetadata.set(metadata);
      } catch (error) {
        toast.error('Failed to update chat metadata');
        console.error(error);
      }
    },

    /** Call once a generation has finished and the files have stopped moving (§4.5.5). */
    checkpointProject,
    storeMessageHistory: async (messages: Message[]) => {
      if (!db || messages.length === 0) {
        return;
      }

      const { firstArtifact } = workbenchStore;
      messages = messages.filter((m) => !m.annotations?.includes('no-store'));

      /*
       * 🔴 A chat is INVISIBLE without BOTH a `urlId` and a `description` — that is what the sidebar
       * filters on — and upstream sourced BOTH solely from `firstArtifact`. So any conversation the
       * model never wrote a file in simply never appeared: a question answered in prose, a generation
       * that failed, a Stop before the first artifact.
       *
       * That was survivable when a chat was always a brand-new project whose first act was writing a
       * game. It is not now: "New chat, same game" (§4.5.6) makes "ask a question about the project I
       * already have" an ordinary thing to do, and every one of those conversations would vanish.
       *
       * The title is settled FIRST because the slug falls back to it. The artifact is preferred for
       * both (it names the game, which is the nicest title and URL); the user's own first message is the
       * fallback, which is what `restoreTranscript` already does for a chat coming back from the server.
       */
      if (!description.get()) {
        const firstUserMessage = messages.find((message) => message.role === 'user');
        description.set(
          firstArtifact?.title ?? (firstUserMessage ? summarizeRequest([firstUserMessage])?.slice(0, 60) : undefined),
        );
      }

      // The REF, not the state — see `urlIdRef`. Reading `urlId` here mints a second slug and lands on `…-2`.
      let _urlId = urlIdRef.current ?? urlId;

      if (!_urlId) {
        _urlId = await mintUrlId();
        urlIdRef.current = _urlId;
        navigateChat(_urlId);
        setUrlId(_urlId);
      }

      let chatSummary: string | undefined = undefined;
      const lastMessage = messages[messages.length - 1];

      if (lastMessage.role === 'assistant') {
        const annotations = lastMessage.annotations as JSONValue[];
        const filteredAnnotations = (annotations?.filter(
          (annotation: JSONValue) =>
            annotation && typeof annotation === 'object' && Object.keys(annotation).includes('type'),
        ) || []) as { type: string; value: any } & { [key: string]: any }[];

        if (filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')) {
          chatSummary = filteredAnnotations.find((annotation) => annotation.type === 'chatSummary')?.summary;
        }
      }

      takeSnapshot(messages[messages.length - 1].id, workbenchStore.files.get(), _urlId, chatSummary);

      /*
       * The title is set above, before the slug that falls back to it. This used to happen here, which
       * was fine while the slug came only from the artifact and the two never referred to each other.
       */

      // Ensure chatId.get() is used here as well
      if (initialMessages.length === 0 && !chatId.get()) {
        const nextId = await getNextId(db);

        chatId.set(nextId);

        /*
         * `_urlId`, NOT `urlId` — the same stale-state trap as above, and this one CLOBBERS.
         *
         * It runs after the slug navigation, so reading the state variable (still `undefined` on this
         * first call) sent the user to `/chat/1`, overwriting `/chat/kart-racer`. It hid because the
         * NEXT `storeMessageHistory` re-minted the slug and navigated again — landing on `…-2`, since
         * `getUrlId` now collided with the chat just written. Two bugs cancelling into a plausible URL:
         * the `-2` on a brand-new chat, alone in the database, was the only visible trace.
         *
         * `_urlId` is always set by now (`slugForChat` never returns empty), so this no longer fires —
         * a chat with a real slug never wants a numeric URL.
         */
        if (!_urlId) {
          navigateChat(nextId);
        }
      }

      // Ensure chatId.get() is used for the final setMessages call
      const finalChatId = chatId.get();

      if (!finalChatId) {
        console.error('Cannot save messages, chat ID is not set.');
        toast.error('Failed to save chat messages: Chat ID missing.');

        return;
      }

      const allMessages = [...archivedMessages, ...messages];

      /*
       * `_urlId`, NOT `urlId` — the slug just computed above, not the stale render's state.
       *
       * `setUrlId` is a React state setter: it does not update the `urlId` captured by THIS closure, so
       * on a new chat's first save this wrote `urlId: undefined` — and a chat with no `urlId` is
       * invisible in the sidebar (it renders only `urlId && description`). It self-healed on the next
       * save, which is why it survived: `storeMessageHistory` fires many times per generation, so the
       * chat appeared a moment later and nobody caught the gap. A generation that failed or was stopped
       * before its second save left an invisible chat permanently. `_urlId` was computed for exactly
       * this and then not used.
       */
      await setMessages(
        db,
        finalChatId, // Use the potentially updated chatId
        allMessages,
        _urlId,
        description.get(),
        undefined,
        chatMetadata.get(),
      );

      /*
       * The server copy of the conversation is written by `checkpointProject` at the END of a
       * generation, NOT here. This function runs on every mutation of the message array — many times
       * a second while streaming — and uploading the whole conversation on each of those ticks is the
       * same mistake that made checkpoints storm the server.
       */
      latestMessages.current = allMessages;
    },

    /**
     * Remix — clone this project into a new owned copy (SPEC §4.8 self-remix).
     *
     * The platform's unit is the server PROJECT (files + snapshot), not the local conversation. So this
     * runs the self-remix (`/api/remix { projectId }`, `deriveRemix`) using the project id in the chat's
     * metadata, and hands the clone to the builder's resume path (the same baton a shared-game remix
     * uses). Only a pure-legacy chat with no server project (`metadata.projectId` absent) falls back to
     * cloning just the local conversation, so the action never silently produces a dangling copy.
     */
    duplicateCurrentChat: async (listItemId: string) => {
      const id = mixedId || listItemId;

      if (!db || !id) {
        return;
      }

      try {
        const chat = await getMessages(db, id);
        const sourceProjectId = chat?.metadata?.projectId;

        if (sourceProjectId) {
          const response = await fetch('/api/remix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: sourceProjectId }),
          });
          const data = (await response.json()) as { projectId?: string; message?: string };

          if (response.ok && data.projectId) {
            sessionStorage.setItem(PENDING_REMIX_KEY, data.projectId);
            navigate('/', { replace: true });
            toast.success('Project remixed');

            return;
          }

          toast.error(data.message ?? 'Failed to remix project');

          return;
        }

        // Legacy fallback: a local-only chat with no server project — clone just the conversation.
        const newId = await duplicateChat(db, id);
        navigate(`/chat/${newId}`);
        toast.success('Chat remixed successfully');
      } catch (error) {
        toast.error('Failed to remix');
        console.log(error);
      }
    },
    importChat: async (description: string, messages: Message[], metadata?: IChatMetadata) => {
      if (!db) {
        return;
      }

      try {
        const newId = await createChatFromMessages(db, description, messages, metadata);
        window.location.href = `/chat/${newId}`;
        toast.success('Chat imported successfully');
      } catch (error) {
        if (error instanceof Error) {
          toast.error('Failed to import chat: ' + error.message);
        } else {
          toast.error('Failed to import chat');
        }
      }
    },
    exportChat: async (id = urlId) => {
      if (!db || !id) {
        return;
      }

      const chat = await getMessages(db, id);
      const chatData = {
        messages: chat.messages,
        description: chat.description,
        exportDate: new Date().toISOString(),
      };

      const blob = new Blob([JSON.stringify(chatData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-${new Date().toISOString()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  };
}

function navigateChat(nextId: string) {
  /**
   * FIXME: Using the intended navigate function causes a rerender for <Chat /> that breaks the app.
   *
   * `navigate(`/chat/${nextId}`, { replace: true });`
   */
  const url = new URL(window.location.href);
  url.pathname = `/chat/${nextId}`;

  window.history.replaceState({}, '', url);
}
