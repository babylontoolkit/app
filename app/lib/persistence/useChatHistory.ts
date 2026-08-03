import { useLoaderData, useNavigate, useSearchParams } from '@remix-run/react';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { atom } from 'nanostores';
import { useStore } from '@nanostores/react';
import { generateId, type JSONValue, type Message } from 'ai';
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { bootProgress, endBootPhase, importTailActive, reportBootFailure } from '~/lib/stores/boot-progress';
import {
  bootForProject,
  bootedProjectId,
  describeSandboxFailure,
  runtimeSupportsNativeAddons,
  SANDBOX_REQUIRES_PROJECT,
} from '~/lib/sandbox';
import { readSandboxIdentity, writeSandboxIdentity } from '~/lib/sandbox/identity';
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
import { CoalescedTask } from './coalesce';
import { streamingState } from '~/lib/stores/streaming';
import { detectProjectCommands, createCommandActionsString } from '~/utils/projectCommands';
import type { ContextAnnotation } from '~/types/context';
import { localViewer, localViewerStore, ownsLocalRecord } from './local-owner';
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
import { decideLiveSandboxIsTruth, selectMountSource, type MountSource } from './mount-source';
import { detectUnappliedTurn, resolvedUnappliedTurn } from './unapplied-turn';
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
import { awaitRunningPreview } from './port-settle';
import { awaitShellAttached } from './shell-attach';
import { SaveQueue, saveState } from './save-queue';
import { takePendingProjectMount, hasPendingProjectMount, setPendingRemix } from './pending-remix';
import { setPendingImport, takePendingImport } from './pending-import';
import {
  settleAfterCreation,
  IMPORT_SETTLE_OPTIONS,
  MOUNT_SETTLE_OPTIONS,
  type SettleOptions,
  type SettleResult,
} from '~/lib/registry/settle';
import { identityForMount } from './mount-identity';
import { runCheckpointSerialize, CHECKPOINT_SETTLE_TIMEOUT_MS } from './checkpoint-run';
import { waitForActionsSettled } from '~/lib/runtime/actions-settled';
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

  /**
   * The account this browser-local record belongs to (`local-owner.ts`).
   *
   * IndexedDB is per-browser-profile and sign-out does not clear it, so without this two people on one
   * computer read each other's conversations. Optional because records written before it existed carry
   * none — `planAdoption` attributes those from the server's own chat list rather than by guessing.
   */
  ownerId?: string;
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
 * "A parked project (remix / dashboard open) is being mounted right now" — the gate that keeps
 * `BootScreen` up while it happens (owner report 2026-07-29: remix booted behind an already-rendered
 * empty chat with no splash, unlike creation/resume).
 *
 * 🔴 MODULE state, not hook state, because the mount and the splash belong to DIFFERENT hook
 * instances: several components call `useChatHistory` and the baton is read-once, so the instance
 * that consumes it (measured live: the sidebar Menu's — child effects run first) is not the instance
 * whose `ready` decides what renders. A per-instance flag was tried first and the Chat instance
 * found the baton already eaten, set itself ready, and dismissed the splash while the mount ran on.
 *
 * Initialized by PEEKING the baton at module evaluation — before any React render, so the splash is
 * up from the first client paint of a full page load (SSR-safe: no `sessionStorage` → `false`).
 * The consuming effect re-asserts it on consumption (the SPA-transition case evaluates the module
 * long before the baton exists) and clears it on completion — except a CLASSIFIED boot failure,
 * which keeps the gate up so `BootScreen` shows the failure + Retry instead of a broken empty chat.
 */
export const pendingMountGate = atom<boolean>(hasPendingProjectMount());

/**
 * "This page load is the tail of an import — keep the workspace covered while its files replay."
 *
 * Consumed at MODULE EVALUATION, which is the one difference from `pendingMountGate`'s peek-then-take
 * and is deliberate. The mount baton has to be peeked because a decision hangs off it in a specific
 * hook instance's render (`ready`); this one drives nothing but a module-level atom, so any instance
 * may act on it and the only thing that matters is that exactly ONE does. Reading it once per page
 * load, before React exists, gives that for free. SSR-safe: no `sessionStorage` → `false`.
 */
let importTailPending = takePendingImport();

/**
 * Cover the workspace while an import's artifact replays into it, once per page load.
 *
 * Fire-and-forget on purpose: the files it is waiting for are written by the message parser, which
 * cannot run until the chat has rendered — so awaiting this before `ready` would deadlock the very
 * replay it is waiting for. It runs ALONGSIDE the chat coming up, with the overlay drawn over the top.
 */
function startImportTail(): void {
  if (!importTailPending) {
    return;
  }

  // Cleared before the await, so two hook instances reaching this line cannot both start one.
  importTailPending = false;

  /*
   * A FLAG, never a phase. `bootProgress` is one slot and the mounts running beside this import own
   * it — the phase version of this raced them and the overlay strobed (see `importTailActive`).
   */
  importTailActive.set(true);

  void settleWorkspaceFiles(IMPORT_SETTLE_OPTIONS).finally(() => importTailActive.set(false));
}

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
 * One "checkpoints are failing" toast per project per session (T17c). The logger still records every
 * individual failure; the toast is the user-facing half and would otherwise nag on every generation
 * of a session whose sandbox connection is gone.
 */
const warnedCheckpointFailure = new Set<string>();

/**
 * Trailing window for the per-chat snapshot (see `snapshotTask`).
 *
 * Deliberately short: the deferral that actually matters is `isBusy` (never serialize mid-stream), so
 * this only has to absorb the settling ticks after the stream ends rather than span a generation.
 */
const SNAPSHOT_COALESCE_MS = 1_000;

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
      resolvedMessageId: resolvedUnappliedTurn(pid),
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

/*
 * However the mount ends, the boot screen's phase must end with it — a stale phase would report
 * progress for work that is not happening the next time a project opens. `endBootPhase` makes the one
 * exception: a FAILED phase is the outcome, not a leftover, and clearing it would erase the only
 * explanation the user gets.
 */
/**
 * Projects whose files this PAGE LOAD has already mounted successfully.
 *
 * 🔴 `mountInFlight` only dedupes CONCURRENT calls, and the repeated mounts are SEQUENTIAL — the mount
 * effect fires more than once per load (its deps include `searchParams`, whose reference changes on
 * hydration) and several components call `useChatHistory`. `prepareMountedProject` has carried a guard
 * against exactly this since it was written, and its comment says so; the FILE half never got one.
 *
 * Measured live 2026-07-31 on an ordinary reload: the whole mount ran TWICE, back to back — sandbox
 * wake, an 86-file re-scan, and a settle, ~9 seconds of work on a project that was already complete and
 * on screen. It was invisible before because nothing narrated it. It stopped being invisible the moment
 * the splash started covering mounts properly, which is how it was found: the surface came down at the
 * end of the first mount and went straight back up for the second, one flash apart.
 *
 * Only SUCCESSES are recorded, so a failed mount is fully retryable — which is what the failure
 * surface's "Try again" runs. Per page load, never persisted: a reload must always re-mount.
 */
const mountedThisLoad = new Set<string>();

function mountProjectFiles(pid: string, opts: MountOptions = {}): Promise<void> {
  if (mountedThisLoad.has(pid)) {
    logger.debug(`Project ${pid} is already mounted in this page load — skipping a duplicate mount.`);
    return Promise.resolve();
  }

  return mountInFlight(pid, () =>
    doMountProjectFiles(pid, opts)
      /*
       * 🔴 THE MOUNT RESOLVING IS NOT THE WORKSPACE BEING FULL, and the boot surface belongs to the
       * second fact (owner report 2026-07-31: "I see all the files loading in the workspace view…
       * that is the whole point of that splash screen").
       *
       * Which branch of `doMountProjectFiles` ran decides how much of the map is filled when it
       * returns, and only one of them fills it completely. `refreshFiles` walks the tree itself; a
       * restore writes through synchronously — but the branch that restores NOTHING (no local
       * checkpoint, no working copy, no seed) leaves the WATCHER as the map's only writer, and the
       * watcher is buffered and asynchronous, an RTT per file on a server provider. So `ready` flipped,
       * `ChatImpl` mounted the workbench, and ~88 files arrived into a file tree the user was already
       * looking at. Exactly what the splash exists to prevent, and it varied by branch — which is why
       * it was reported as "sometimes".
       *
       * Chained on SUCCESS only: a mount that failed has a failure surface to show and nothing to wait
       * for. `settleAfterCreation` is reused rather than re-derived — the floor/ceiling/quiescence
       * rules are the same rules, already tested against an injected clock — with the mount's own
       * profile (`MOUNT_SETTLE_OPTIONS`), whose `minCount` is what makes it safe on the empty branch.
       */
      .then(async () => {
        /* Recorded here — inside the success path, before the settle — so only a real mount counts. */
        mountedThisLoad.add(pid);

        await settleWorkspaceFiles(MOUNT_SETTLE_OPTIONS, 'settling');
      })
      .finally(endBootPhase),
  );
}

/**
 * Hold a boot phase until the file map stops changing.
 *
 * One helper for both doors (the mount tail and the import replay) so they cannot drift into two
 * different ideas of "the workspace has finished filling". The phase is set here rather than by the
 * caller for the same reason: the wait and the sentence describing it are one thing.
 *
 * Never throws. A settle is a cosmetic wait around work that has already succeeded — failing it would
 * turn a slightly ugly file tree into a failed open, which is the wrong trade in every case.
 */
async function settleWorkspaceFiles(
  options: Partial<SettleOptions>,
  step?: 'settling',
): Promise<SettleResult | undefined> {
  try {
    if (step) {
      bootProgress.set({ step });
    }

    const result = await settleAfterCreation({ ...options, readCount: () => workbenchStore.filesCount });

    if (!result.quiesced) {
      /*
       * The ceiling ended it. Normal and bounded — a dev server writing into the tree never goes quiet
       * — but worth saying once, because the visible consequence is the thing this whole wait exists to
       * avoid: the last of the files landing in a workspace the user can already see.
       */
      logger.warn(
        `The workspace was still changing after ${result.elapsedMs}ms (${result.finalCount} files) — showing it anyway.`,
      );
    }

    return result;
  } catch (error) {
    logger.warn(`Could not wait for the workspace to settle: ${(error as Error)?.message}`);
    return undefined;
  }
}

/**
 * An open failed. Decide whether the page is usable anyway.
 *
 * 🔴 The two outcomes are deliberately different, and conflating them is the defect this replaces. A
 * mount that fails for an ordinary reason (a repo fetch, a bad checkpoint) still leaves a usable
 * project: warn, mark the page ready, let the user work. A mount whose SANDBOX never started leaves
 * NOTHING — and it used to take exactly the same path, so the boot screen came down over a workbench
 * with no filesystem behind it and no sentence explaining why.
 *
 * `onUsable` is therefore called only when there is something to be ready for. On a sandbox failure
 * the boot surface stays up carrying the server's own words and, when the failure is retryable, a
 * button that runs `retry`.
 */
function handleOpenFailure(pid: string, error: unknown, onUsable: () => void, retry: () => void): void {
  const failure = describeSandboxFailure(error);

  if (!failure) {
    logger.warn(`Could not load project ${pid}: ${(error as Error)?.message}`);
    onUsable();

    return;
  }

  logger.error(`Could not open the workspace for project ${pid}: ${failure.message}`);
  reportBootFailure(failure, retry);
}

async function doMountProjectFiles(pid: string, opts: MountOptions = {}): Promise<void> {
  const prepareToRun = opts.prepareToRun ?? true;

  // The first long await below is the sandbox runtime itself; say so while we wait.
  bootProgress.set({ step: 'sandbox' });

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

  /*
   * 🔴 THE BOOT IS PER PROJECT, AND THIS IS WHERE THE PROJECT ID FINALLY EXISTS.
   *
   * `~/lib/sandbox` no longer boots at module-evaluation time on a server-backed provider: a sandbox
   * belongs to a project (its id lives on the project row), and at module load there is no project.
   * `bootForProject` is idempotent — a second mount of the same project joins the same connection —
   * and it REJECTS rather than silently rebinding if this tab is already connected to a different
   * project, which is what makes A→B→A in one tab a page load instead of a quiet cross-project mix.
   */
  const runtime = await bootForProject(pid);

  // Sandbox is up — everything from here is file work, whichever branch runs.
  bootProgress.set({ step: 'files' });

  /*
   * A restored filesystem means a RESUMED VM, which may already have a dev server listening — and its
   * ports are replayed asynchronously, so "is one serving?" is not answerable yet. Every prepare call
   * below carries this, whichever branch reaches it: the question is about the SANDBOX, not about
   * where the files came from.
   */
  const awaitPortReplay = runtime.bootRestoredFilesystem;

  /*
   * 🔴 Does this sandbox agree that it belongs to this project? (`spec/sandbox-codesandbox.md` §11 C1.)
   *
   * Read BEFORE the write below, and read from the provider's `fs` rather than the file map — the map
   * is filled by a watcher and by the very restore this gate is deciding about, so asking it would be
   * asking the answer to check the question. Only a sentinel that is PRESENT and names ANOTHER project
   * closes the gate; a sandbox that predates the sentinel makes no claim and is treated as it always
   * was. With per-project VMs this should never fire, which is exactly why it is worth having: the
   * failure it catches (a mis-pointed `sandbox_id`) is otherwise silent, and its consequence is one
   * project's files becoming another project's truth and then being pushed to that project's repo.
   */
  const identity = SANDBOX_REQUIRES_PROJECT ? await readSandboxIdentity(runtime, pid) : 'unknown';

  if (identity === 'mismatch') {
    logger.error(
      `The sandbox for project ${pid} carries another project's identity — ignoring its filesystem and ` +
        `restoring from this project's own copies.`,
    );
  }

  /*
   * 🔴 A LIVE PERSISTENT SANDBOX OUTRANKS EVERY CLIENT-HELD COPY (`spec/sandbox-codesandbox.md` §1:
   * the working copy is a recovery buffer, never the primary wake mechanism). The decision itself is
   * pure and exhaustively tested — see `decideLiveSandboxIsTruth`, which documents why each of its
   * three conditions is load-bearing and what each wrong answer destroys. When it opens, the store
   * fills FROM the sandbox and the copies stay what they are: recovery for the day it comes back
   * CLEAN or gone.
   */
  const liveSandboxIsTruth = decideLiveSandboxIsTruth({
    bootRestoredFilesystem: runtime.bootRestoredFilesystem,
    identity,
    source: decision.source,
  });

  /*
   * Stamp the sentinel now the gate has read it. Every mount, not only creation, so sandboxes that
   * predate it stop being permanently unverifiable. Best-effort inside; a marker file that cannot be
   * written must never stop a project from opening.
   */
  if (SANDBOX_REQUIRES_PROJECT) {
    void writeSandboxIdentity(runtime, pid);
  }

  if (liveSandboxIsTruth) {
    await workbenchStore.refreshFiles((done, total) => bootProgress.set({ step: 'files', done, total }));

    if (prepareToRun) {
      // Serialized from the store just filled from disk — the wake path's install/dev-server check.
      await prepareMountedProject(await workbenchStore.serializeFiles(), { awaitPortReplay });
    }

    /*
     * Carry the checkpoint's messageId even though its FILES were not used: it names the last turn
     * this project is known to contain, and the sandbox is at least that new. Dropping it makes
     * `checkUnappliedTurn` read "unknown turn" as "not the last one" and re-offer the §4.5.4c apply
     * dialog forever — the exact loop the working-copy branch's comment warns about.
     */
    const local = decision.source !== 'working' && db ? await readCurrentLocalSnapshot(db, pid) : undefined;
    lastMount = { source: decision.source, messageId: local?.messageId ?? working?.messageId };

    /*
     * Spelled out per source rather than leaning on the enclosing `if` to narrow `decision`: the gate
     * is a pure function now (`decideLiveSandboxIsTruth`), so TypeScript can no longer see that this
     * branch means local/diverged/working — and `unsavedWork` exists only on `local`.
     */
    unsavedWork.set(
      decision.source === 'working' ||
        decision.source === 'diverged' ||
        (decision.source === 'local' && decision.unsavedWork),
    );

    if (decision.source === 'diverged') {
      mountDivergence.set({ projectId: pid, remoteHead: decision.remoteHead });
    }

    return;
  }

  if (decision.source === 'local' || decision.source === 'diverged') {
    const local = db ? await readCurrentLocalSnapshot(db, pid) : undefined;

    if (local) {
      /*
       * A local checkpoint is the whole truth (it serialized the entire store), so `protectNothing`:
       * a file it does not have is one the project does not have. Without this the mount is an
       * overlay, and a file deleted before the checkpoint would come back from the template mount.
       */
      await workbenchStore.restoreFiles(local.files, {
        protect: protectNothing,
        onProgress: (done, total) => bootProgress.set({ step: 'files', done, total }),
      });

      if (prepareToRun) {
        // The container was torn down on reload; reinstall and start the dev server so the game runs.
        await prepareMountedProject(local.files, { awaitPortReplay });
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
    await workbenchStore.restoreFiles(working!.files, {
      protect: protectForRepoRestore,
      onProgress: (done, total) => bootProgress.set({ step: 'files', done, total }),
    });

    if (db) {
      /*
       * Make it this browser's checkpoint too, so undo works and the next mount reads locally.
       *
       * 🔴 It MUST carry the working copy's `messageId`. Without it this snapshot said "I do not know
       * which turn I contain", every later mount read that as "not the last one", and the §4.5.4c
       * dialog re-asked forever — the recovery itself was what made the question permanent.
       */
      await createLocalSnapshot(db, {
        projectId: pid,
        files: working!.files,
        messageId: working!.messageId,
        label: 'Recovered',
      });
    }

    /*
     * Honest: recovered work has NOT been pushed anywhere the user controls. Saying otherwise would
     * silence the very nudges that exist to stop this happening again.
     */
    unsavedWork.set(true);

    if (prepareToRun) {
      await prepareMountedProject(working!.files, { awaitPortReplay });
    }

    lastMount = { source: 'working', messageId: working!.messageId };
    toast.success('Recovered your project from the last checkpoint.');

    return;
  }

  if (decision.source === 'repo') {
    lastMount = { source: 'repo' };
    await mountFromRepo(pid, prepareToRun, { awaitPortReplay });

    return;
  }

  if (decision.source === 'empty') {
    /*
     * `empty` for a LINKED project is not necessarily nothing — it can be a remix seed we did not know
     * about, since `hasServerSeed` needs a round-trip we do not make on the common path. Trying the
     * seed here costs one request on a path that had nothing to show anyway.
     */
    lastMount = { source: 'empty' };
    await mountFromSeed(pid, prepareToRun, { awaitPortReplay });

    return;
  }

  lastMount = { source: 'empty' };
  await mountFromSeed(pid, prepareToRun, { awaitPortReplay });
}

/**
 * Fetch the linked repo and put it on screen.
 *
 * The pulled files become this browser's first checkpoint AND are marked as synced — they came FROM
 * the repo, so they are by definition saved. Skipping the mark would make a freshly-opened project
 * claim unsaved work it does not have, and nag the user to save what they just downloaded.
 */
async function mountFromRepo(pid: string, prepareToRun = true, opts: PrepareOptions = {}): Promise<void> {
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
  await workbenchStore.restoreFiles(files, {
    protect: protectForRepoRestore,
    onProgress: (done, total) => bootProgress.set({ step: 'files', done, total }),
  });

  if (db) {
    await createLocalSnapshot(db, { projectId: pid, files, label: 'Loaded from repository' });
    await markSynced(db, pid);
  }

  unsavedWork.set(false);

  if (prepareToRun) {
    await prepareMountedProject(files, opts);
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

/**
 * Options for {@link prepareMountedProject}.
 *
 * `awaitPortReplay` is the boot's own `bootRestoredFilesystem` fact, threaded rather than read from a
 * module-level variable: it belongs to ONE mount, and a value that outlives its mount is how the
 * chat-identity bug (§4.5.6) and `lastMount` both went wrong. False on a tab-local runtime — the
 * WebContainer dies with the tab, so there is never a port to wait for and the wait would be pure
 * dead time on every reload.
 */
interface PrepareOptions {
  awaitPortReplay?: boolean;
}

async function prepareMountedProject(files: SerializedFileMap, opts: PrepareOptions = {}): Promise<void> {
  if (workbenchStore.previews.get().length > 0 || preparingContainer) {
    return;
  }

  preparingContainer = true;
  bootProgress.set({ step: 'prepare' });

  /*
   * 🔴 On a RESUMED sandbox the port list arrives after this point, so the check above answered a
   * question it could not yet see (`awaitRunningPreview` documents both wrong answers). Wait for the
   * provider's replay to settle before concluding anything is or is not serving. Inside the guard and
   * inside the `prepare` phase on purpose: the boot screen must narrate this wait rather than sit on
   * the previous phase, and a concurrent mount must not slip past while we are in it.
   */
  if (opts.awaitPortReplay) {
    const serving = await awaitRunningPreview({
      runningPreviews: () => workbenchStore.previews.get().length,
      wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    });

    if (serving) {
      // A dev server survived the sleep. The container is prepared; leave the guard set.
      return;
    }
  }

  /*
   * 🔴 **DETACHED FROM THE MOUNT, and that is the whole fix.**
   *
   * The install needs the agent's shell, the shell is spawned by the workbench's `<Terminal>` on
   * mount, and the workbench does not render until THIS function's caller has finished. MEASURED on
   * a resumed 76-file project: `showWorkbench`, the xterm element and the shell process all appeared
   * at **22,433 ms — the same millisecond**, because they are one event. Awaiting the install here
   * therefore waits for something that cannot happen until we return: any bound short enough not to
   * hang the mount is too short to win, and a larger project loses by more.
   *
   * So it runs alongside the mount instead of inside it. The user gets their workbench immediately
   * and watches `npm install` in the terminal — exactly what creation already does. `preparingContainer`
   * still guards against a second mount starting a second install.
   */
  void (async () => {
    try {
      const ready = await installDependencies(files);

      if (ready) {
        await startDevServer(files);
      } else {
        // Not installed — let a later mount try again rather than wedging this container as "prepared".
        preparingContainer = false;
      }
    } catch (error) {
      preparingContainer = false;
      logger.error('Could not prepare the mounted project', error);
    }
  })();
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
    /*
     * 🔴 WAIT for the terminal to attach, EXPLICITLY — see `awaitShellAttached` for the full story.
     *
     * `executeCommand` silently drops the command and returns `undefined` when the shell has no
     * process yet, and the shell is spawned by the workbench's `<Terminal>` on mount. This used to be
     * survivable because the mount effect ran more than once per page load and a later cycle picked
     * the install up; the `mountedThisLoad` dedupe removed that second cycle, and with it the only
     * thing that ever retried. A resumed project then mounted every file, never installed, never
     * started its dev server, and showed an empty terminal and no preview — silently (MEASURED live
     * 2026-07-31 on Nodepod; CodeSandbox cannot reach it, because its VM never needs the install).
     */
    const attached = await awaitShellAttached({
      attached: () => Boolean(shell.process),
      wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });

    const result = attached ? await shell.executeCommand(`deps-${Date.now()}`, 'npm install') : undefined;

    /*
     * Still nothing: the terminal never attached (the workbench can stay closed, and waiting forever
     * would hang the mount instead of the install). Treat it as "not yet", NOT a failure — dismiss
     * the toast quietly and return false so `prepareMountedProject` frees its guard, leaving a later
     * mount free to try again.
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
      // STRICT: a push that silently drops `havok.wasm` writes a broken project into the user's repo.
      const files = await workbenchStore.serializeFiles({ strict: true });
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
async function mountFromSeed(pid: string, prepareToRun = true, opts: PrepareOptions = {}): Promise<void> {
  const { files } = await readRemixSeed(pid);

  if (!files) {
    return;
  }

  // The seed is built with the same secret rule (`buildRemixSeed` → `isSecretPath`), so it is protected the same way.
  await workbenchStore.restoreFiles(files, {
    protect: protectForRepoRestore,
    onProgress: (done, total) => bootProgress.set({ step: 'files', done, total }),
  });

  if (db) {
    await createLocalSnapshot(db, { projectId: pid, files, label: 'Opened' });
  }

  unsavedWork.set(true);

  if (prepareToRun) {
    await prepareMountedProject(files, opts);
  }
}

export function useChatHistory() {
  const navigate = useNavigate();
  const { id: mixedId } = useLoaderData<{ id?: string }>();
  const [searchParams] = useSearchParams();

  /** Who is signed in, for the local-record ownership check in the mount effect (`local-owner.ts`). */
  const localViewerState = useStore(localViewerStore);

  const [archivedMessages, setArchivedMessages] = useState<Message[]>([]);
  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const [urlId, setUrlId] = useState<string | undefined>();

  /*
   * The shared pending-mount gate (see `pendingMountGate`). Subscribed here so the instance whose
   * `ready` decides what renders re-renders when the CONSUMING instance (often a different one)
   * finishes the mount and drops the gate.
   */
  const pendingMountActive = useStore(pendingMountGate);

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

    /*
     * 🔴 Wait for the session before deciding whether this browser's copy is openable.
     *
     * `/api/me` resolves AFTER first paint, so this effect runs at least once with the viewer still
     * `unknown` — and an unknown viewer owns nothing, by design (`local-owner.ts`). Deciding on that
     * would bounce every user off their OWN chat URL on every cold load, and the re-run once the
     * session arrived would not undo the navigation. Not-yet-known is not an answer, so we do not give
     * one; the store change re-runs this effect within one round trip.
     *
     * Deliberately narrow: only the `mixedId` branch reads local records. A fresh builder has nothing
     * to be denied and must not be made to wait on the network to render.
     */
    if (mixedId && localViewerState.status === 'unknown') {
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
    /*
     * 🔴 Tri-state, because "could not find it" and "found it and the MOUNT blew up" are opposite
     * answers (T17a, measured live). The old boolean folded both into `false`, so a provider fs error
     * mid-mount (`21: Os { … IsADirectory }`) silently dropped the user onto the legacy IndexedDB
     * mount — `prepareToRun: false`, no wake hook, a raw Rust error in a `warn` nobody reads.
     *
     *   - 'not-found'  — the chat is not in the caller's list (someone else's id, or the server could
     *     not answer). Falling back to the browser's copy is DESIRED here — offline-stale beats gone.
     *   - 'failed'     — the chat is ours and opening it broke. `handleOpenFailure` decides: a
     *     classified sandbox failure keeps the boot surface up with the provider's words and a Retry;
     *     anything else warns and lets the chat render (the mount may be partial, but it is THIS
     *     project's mount, not the legacy one).
     */
    const openFromServer = async (id: string): Promise<'opened' | 'not-found' | 'failed'> => {
      let chat: Awaited<ReturnType<typeof listAllChats>>[number] | undefined;

      try {
        const chats = await listAllChats();
        chat = chats.find((candidate) => candidate.serverChatId === id);
      } catch (error) {
        logger.warn(`Could not list chats from the server: ${(error as Error).message}`);
        return 'not-found';
      }

      if (!chat) {
        return 'not-found';
      }

      try {
        projectId.set(chat.projectId);
        chatMetadata.set({ projectId: chat.projectId, serverChatId: chat.serverChatId });

        await Promise.all([mountProjectFiles(chat.projectId), restoreTranscript(chat.projectId, chat.serverChatId)]);

        /*
         * AFTER both — the check compares what was mounted against what the transcript says was paid
         * for, and either half alone answers nothing (§4.5.4c).
         */
        await checkUnappliedTurn(chat.projectId);

        return 'opened';
      } catch (error) {
        handleOpenFailure(
          chat.projectId,
          error,
          () => setReady(true),
          () => void openFromServer(id),
        );
        return 'failed';
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
          if (isServerChatId(mixedId)) {
            const outcome = await openFromServer(mixedId);

            if (outcome === 'opened') {
              /*
               * The third door to `ready`, covered for completeness rather than for a known case: a
               * fresh import always lands on a LOCAL chat id (`createChatFromMessages` mints one from
               * `getNextId`), so today it never arrives here. `startImportTail` is self-clearing and
               * costs nothing when there is no import, and the rule worth being able to state is
               * "every path that reaches `ready` starts the tail" — a path that quietly does not is
               * exactly how the workspace ends up filling in full view again.
               */
              startImportTail();
              setReady(true);

              return;
            }

            /*
             * 'failed' means OUR chat's mount broke and `handleOpenFailure` has already surfaced it
             * (boot failure + Retry, or warn + ready). Falling through to the legacy IndexedDB mount
             * from here is the T17a silent degrade — it must not happen. Only 'not-found' falls back.
             */
            if (outcome === 'failed') {
              return;
            }
          }

          /*
           * 🔴 The browser's copy is only openable by the account that WROTE it (`local-owner.ts`).
           *
           * Everything above this line has an ownership answer: a server chat id goes through
           * `openFromServer`, which searches the caller's OWN `/api/chats` list, so a stranger's UUID
           * is simply absent and falls through — 404-not-403 applied to a URL (§4.5.3). This branch
           * had none. A local id is not a UUID, so it never reaches that check, and `getMessages` +
           * `getSnapshot` read straight out of a database that is shared by everyone using the browser
           * profile: the whole conversation and the snapshot's files, to whoever typed the URL.
           *
           * Refusing here is not a dead end for the rightful owner — the same id opens normally once
           * they sign in, because the records are filtered, never deleted.
           */
          const openable = storedMessages && ownsLocalRecord(storedMessages, localViewer());

          if (storedMessages && !openable) {
            logger.warn(`Chat ${mixedId} belongs to a different account on this browser — not opening it.`);
            navigate('/', { replace: true });
            setReady(true);

            return;
          }

          if (openable && storedMessages.messages.length > 0) {
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
              const projectCommands = await detectProjectCommands(files, {
                nativeAddons: await runtimeSupportsNativeAddons(),
              });

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
              /*
               * prepareToRun: false — the artifact spread into `filteredMessages` above carries this
               * project's `npm install` + `npm run dev` (createCommandActionsString) and the parser
               * replays them. Installing here as well would race that first installer on the shared
               * boltTerminal and flash a spurious "dependencies failed" toast over a project that is
               * installing and starting perfectly well.
               */
              const openStoredProject = (): Promise<void> =>
                mountProjectFiles(pid, { prepareToRun: false })
                  .then(() => setReady(true))
                  .catch((error) => handleOpenFailure(pid, error, () => setReady(true), openStoredProject));

              // Awaited so the ordinary path still reaches `setReady` before this effect's turn ends.
              await openStoredProject();

              /*
               * AFTER the mount, never before: `mountProjectFiles` ends in `endBootPhase`, so an
               * `importing` phase raised any earlier would be cleared by the mount finishing and the
               * replay — the part that actually trickles — would run uncovered.
               */
              startImportTail();

              return;
            }
          } else {
            // The server did not have it and neither does this browser. Nothing to open.
            navigate('/', { replace: true });
          }

          /*
           * The second door into the same tail: an import with NO project behind it (the WebContainer
           * runtime creates none), which reaches `ready` without ever calling `mountProjectFiles`. Its
           * files still arrive by replay, so it still needs covering. Self-clearing, so the branch above
           * having already started one makes this a no-op.
           */
          startImportTail();
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

        /*
         * Re-assert the gate (the SPA path evaluated the module before the baton existed) and drop
         * this instance's own ready — on a full page load both are already in this state.
         */
        pendingMountGate.set(true);
        setReady(false);

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
        /*
         * Named so the failure surface can run it AGAIN. `createSingleFlight` frees its slot on
         * rejection and `bootForProject` no longer caches one, so "Try again" is a genuinely fresh
         * attempt rather than a replay of the first rejection — which is what a page reload used to be
         * the only cure for.
         */
        const openPendingProject = (): Promise<void> =>
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
            .then(() => {
              setReady(true);
              pendingMountGate.set(false);
            })
            /*
             * The ready callback also drops the gate (the warn-and-continue path). A CLASSIFIED
             * failure does not run it, which KEEPS the gate up — `BootScreen` then shows the
             * failure + Retry instead of an empty chat, and a successful retry clears it above.
             */
            .catch((error) =>
              handleOpenFailure(
                mountProjectId,
                error,
                () => {
                  setReady(true);
                  pendingMountGate.set(false);
                },
                openPendingProject,
              ),
            );

        void openPendingProject();
      } else if (!pendingMountGate.get()) {
        setReady(true);
      }

      /*
       * else: no baton HERE, but the gate is up — a sibling `useChatHistory` instance consumed the
       * baton and is driving the mount. Setting this instance ready would flip the `|| ready` arm and
       * dismiss the splash mid-mount (the exact live failure the gate exists for); the gate's own
       * clear re-renders us when the mount lands.
       */
    }

    /*
     * `localViewerState` is a dependency because the effect RETURNS EARLY while the viewer is unknown
     * (see the guard at the top). Without it the effect never re-runs when the session resolves and
     * `/chat/:id` renders an empty chat forever — the guard would have turned a race into a hang.
     */
  }, [mixedId, db, navigate, searchParams, localViewerState]); // Added db, navigate, searchParams dependencies

  /**
   * The LATEST snapshot request. Overwritten, never queued — see `snapshotTask`.
   *
   * The snapshot is keyed by chat id and overwritten on every write, so within a burst only the last
   * request has any effect. Holding the newest one and running once is byte-identical to running for
   * every one of them.
   */
  const pendingSnapshot = useRef<{ chatIndex: string; summary?: string } | undefined>(undefined);

  /**
   * 🔴 SERIALIZING THE WHOLE PROJECT IS NOT A PER-KEYSTROKE OPERATION (measured live 2026-07-27).
   *
   * This used to run inline on every `storeMessageHistory`, which the 50ms sampler calls on every
   * mutation of the message array — several times a second while a generation streams. Each run reads
   * EVERY binary in the project out of the sandbox and base64s it.
   *
   * On WebContainer a binary read is a memory copy, so this was invisible waste. On CodeSandbox each
   * read is a round trip, and the passes piled up on top of each other: hundreds of
   * `Pitcher message fs/readFile timed out` errors for `havok.wasm` / `glslang.wasm` / `twgsl.wasm` and
   * every starter image, an 870MB heap, a tab that crawled — and, because each failed pass toasted,
   * a wall of error toasts. `checkpointProject` below already documents this exact trap; only its
   * SERVER UPLOAD was moved off the sampler, and the expensive local half stayed behind.
   *
   * Coalesced and deferred until the stream ends, so a generation produces ONE serialization instead of
   * a few hundred. `CoalescedTask` also refuses to start a second pass while one is in flight, which is
   * the part a plain debounce cannot do — the work is slower than the window that schedules it.
   */
  const snapshotTask = useMemo(
    () =>
      new CoalescedTask({
        delayMs: SNAPSHOT_COALESCE_MS,
        isBusy: () => streamingState.get(),
        run: async () => {
          const id = chatId.get();
          const request = pendingSnapshot.current;

          if (!id || !db || !request) {
            return;
          }

          /**
           * Serialize from the sandbox rather than snapshotting the in-memory FileMap:
           * binary files hold no content in the map, so persisting it directly wrote empty
           * PNGs/GLBs into the snapshot (SPEC §1.3 principle 10).
           */
          const files = await workbenchStore.serializeFiles({ strict: true });

          const snapshot: Snapshot = {
            chatIndex: request.chatIndex,
            files,
            summary: request.summary,
          };

          await setSnapshot(db, id, snapshot);
        },
        onError: (error) => {
          /*
           * ONE toast per failure, and there is now at most one failure per generation rather than one
           * per sampler tick. The local checkpoint (`checkpointProject`) is the copy §4.12 restores
           * from; this snapshot is upstream's per-chat copy, so a failure here is worth saying once and
           * is not worth saying two hundred times.
           */
          console.error('Failed to save snapshot:', error);
          toast.error('Failed to save chat snapshot.');
        },
      }),
    [db],
  );

  const takeSnapshot = useCallback(
    (chatIdx: string, _files: FileMap, _chatId?: string | undefined, chatSummary?: string) => {
      pendingSnapshot.current = { chatIndex: chatIdx, summary: chatSummary };
      snapshotTask.request();
    },
    [snapshotTask],
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
      /*
       * T17c: a skipped checkpoint says WHY. The `already checkpointed` case is the idempotency
       * guard doing its job; the other two mean the safety net is OFF for this turn, and a silent
       * `return` here is exactly how "checkpoints stopped on CSB" went undiagnosed for a day.
       */
      if (lastCheckpointedMessage.current !== messageId) {
        logger.warn(`Checkpoint skipped for message ${messageId}: ${!db ? 'no local database' : 'no project id'}`);
      }

      return;
    }

    lastCheckpointedMessage.current = messageId;
    lastSummary = summarizeRequest(latestMessages.current);

    /*
     * The CONVERSATION save no longer rides on the file serialize (T17c). It needs no file bytes,
     * and coupling the two (the old `Promise.all`) meant a sandbox read failure also silently lost
     * the server transcript for the turn — a chat is recoverable on another device only if this
     * upload happened.
     */
    const chatSaved = saveCurrentChat(pid).catch((error) => {
      logger.error(`Failed to save conversation for ${pid}: ${(error as Error).message}`);
    });

    try {
      /*
       * 🔴 STRICT. This map becomes the LOCAL CHECKPOINT, and a checkpoint restores with
       * `protectNothing` — "this map is the whole truth", so anything missing from it is DELETED on
       * undo (§4.12, `restore-plan.ts`). Serializing while `havok.wasm` was unreadable therefore does
       * not write a slightly-smaller checkpoint; it writes one that destroys the physics engine the
       * moment the user presses undo. Better to have no checkpoint than a poisoned one.
       *
       * 🔴 And STRICT runs through the T17c policy, never bare: `onFinish` fires when the model stops
       * TALKING, while the `<boltAction>` writes are still landing over RTT on a server sandbox — so
       * the serialize must wait for the turn's actions to SETTLE first (photographing the race is the
       * same poisoned checkpoint, made of not-yet-written files instead of unreadable ones). A dead
       * sandbox connection makes `fs` calls hang FOREVER rather than error (measured), so each
       * attempt is time-boxed; transient reads racing the write-queue tail get spaced retries.
       */
      const outcome = await runCheckpointSerialize({
        serialize: () => workbenchStore.serializeFiles({ strict: true }),
        waitForWrites: () =>
          waitForActionsSettled({
            readStatuses: () =>
              Object.values(workbenchStore.artifacts.get()).flatMap((artifact) =>
                Object.values(artifact.runner.actions.get())
                  // The dev server (`start`) runs for the life of the project — waiting on it is the stuck-closed trap.
                  .filter((action) => action.type !== 'start')
                  .map((action) => action.status),
              ),
            timeoutMs: CHECKPOINT_SETTLE_TIMEOUT_MS,
          }),
      });

      if (outcome.kind !== 'ok') {
        /*
         * LOUD (§4.5.4b: a failed save is never silent). This is the user's undo net and the §4.5.4c
         * recovery copy both going dark for this turn — the exact failure that shipped as a
         * console-only `.catch(() => {})` and cost a 500-credit creation on kill-recovery. The guard
         * resets so the NEXT generation retries, and `workingCopySafe` flips pessimistic so the
         * beforeunload warning tells the truth.
         */
        lastCheckpointedMessage.current = undefined;
        workingCopySafe.set(false);
        logger.error(
          `Checkpoint failed for ${pid} at message ${messageId} ` +
            `(${outcome.reason}, ${outcome.attempts} attempt(s)): ${outcome.detail}`,
        );

        if (!warnedCheckpointFailure.has(pid)) {
          warnedCheckpointFailure.add(pid);
          toast.error(
            'A checkpoint could not be saved — Undo and crash recovery will not cover this change. ' +
              'It will retry after your next change.',
            { autoClose: 12000 },
          );
        }

        await chatSaved;

        return;
      }

      const files = outcome.files;

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
       * So there are now THREE writes here, and each degrades ALONE:
       *
       *   1. the LOCAL checkpoint — the copy the user is about to rely on for undo, written first;
       *   2. the CONVERSATION — §4.5.4b has always kept this (resume on another machine, §4.5) —
       *      started BEFORE the serialize (T17c), because it needs no file bytes and must survive a
       *      serialize failure;
       *   3. the server WORKING COPY — ONE object per project, overwritten, keyed on the project id.
       *
       * The working copy is deliberately sequenced after the checkpoint: a failed upload must degrade
       * to "no recovery copy", never to "no checkpoint".
       */
      const snapshot = await createLocalSnapshot(db, { projectId: pid, files, messageId });

      await chatSaved;

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

        await saveWorkingCopy(pid, snapshot.seq, files, messageId);
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
       * Reset the guard so the next turn retries — and be LOUD (T17c). The old reasoning ("the files
       * are still live on screen, nothing is lost yet") was written for WebContainer, where the
       * browser held the runtime; on a server sandbox a dead tab or a killed VM makes THIS checkpoint
       * the difference between undo working and the project reverting to its last photograph. This
       * branch now mostly covers the IndexedDB write itself — as fatal to the safety net as a
       * serialize failure, so it gets the same telling.
       */
      lastCheckpointedMessage.current = undefined;
      workingCopySafe.set(false);
      logger.error(`Failed to checkpoint project ${pid}: ${(error as Error).message}`);

      if (!warnedCheckpointFailure.has(pid)) {
        warnedCheckpointFailure.add(pid);
        toast.error(
          'A checkpoint could not be saved — Undo and crash recovery will not cover this change. ' +
            'It will retry after your next change.',
          { autoClose: 12000 },
        );
      }
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
    await workbenchStore.restoreFiles(validSnapshot.files, {
      // No `protect`: this legacy path has always been an OVERLAY (writes, deletes nothing) — only progress rides along.
      onProgress: (done, total) => bootProgress.set({ step: 'files', done, total }),
    });
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
    /*
     * Ready means "there is nothing left to mount before the chat can render". Three cases: a
     * `/chat/:id` open (`mixedId`) waits on this instance's own `ready`; a parked remix/dashboard
     * mount waits on the SHARED `pendingMountGate` (the mount may be driven by a sibling instance —
     * see the atom's doc); a bare `/` with neither is ready immediately. While the gate is up,
     * `Chat` renders `BootScreen`, which is the whole feature.
     */
    ready: (!mixedId && !pendingMountActive) || ready,
    initialMessages,

    /**
     * "New chat, same game" WITHOUT re-mounting the project (§4.5.6, §4.2.9).
     *
     * The conversation-side half of the in-place reset (`chat-reset.ts` explains why it is in place at
     * all). Everything here is chat identity or chat history; nothing here is the project — the files,
     * the WebContainer, the workbench and `projectId` are deliberately untouched, because they did not
     * change and re-mounting them is exactly the "the whole workspace reloaded" symptom this replaces.
     *
     * The identity comes from `identityForMount({ freshChat: true })` — the SAME pure decision the mount
     * path uses — and never from spreading what the atoms hold. An inherited `serverChatId` makes the
     * new chat save over the old chat's server transcript, which is the only copy we hold (§4.5.4b); an
     * inherited `chatId` does the same to its IndexedDB record. Both are silent.
     *
     * The URL goes back to `/` by `replaceState`, NOT `navigate`: a real navigation re-runs the mount
     * effect and remounts the route — the reload we are removing. The chat gets its own `/chat/:id` back
     * on its first save, exactly as a chat started from the landing page does.
     */
    startFreshChat: () => {
      const pid = projectId.get();

      if (!pid) {
        return;
      }

      const identity = identityForMount({
        current: {
          chatId: chatId.get(),
          description: description.get(),
          urlId: urlIdRef.current,
          metadata: chatMetadata.get() ?? {},
        },
        projectId: pid,
        freshChat: true,
      });

      chatId.set(identity.chatId);
      description.set(identity.description);
      chatMetadata.set(identity.metadata);

      // Ref and state together, always — `storeMessageHistory` reads the ref (see `urlIdRef`).
      urlIdRef.current = identity.urlId;
      setUrlId(identity.urlId);

      setArchivedMessages([]);
      setInitialMessages([]);
      latestMessages.current = [];
      lastCheckpointedMessage.current = undefined;
      chatCreatedAt.current = new Date().toISOString();

      /*
       * The unapplied-turn offer belongs to the conversation it was raised from (§4.5.4c): it asks
       * whether THAT turn's files ever landed. Carrying it into a chat that cannot show the turn leaves
       * a banner offering to re-apply something the user can no longer see.
       */
      unappliedTurn.set(undefined);

      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', '/');
      }
    },
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
            setPendingRemix(data.projectId);

            /*
             * ONE TAB, ONE SANDBOX CONNECTION (the dashboard's `openBuilder` rule): when this tab is
             * holding a project's sandbox, an SPA navigate cannot mount the clone — `bootForProject`
             * refuses to re-point live stores at a second VM. A real page load starts fresh; the
             * baton is sessionStorage, so it survives, and the boot splash narrates the open.
             */
            if (bootedProjectId()) {
              window.location.href = '/';
            } else {
              navigate('/', { replace: true });
              toast.success('Project remixed');
            }

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

        /*
         * 🔴 Set BEFORE the navigation, because the navigation is a full page load — this page and
         * everything it is holding is about to cease to exist. The load that comes back is otherwise
         * indistinguishable from opening any other chat, and it would render the workbench and then
         * replay the imported artifact into it one file at a time, in full view. The baton is what
         * lets it know to keep the splash up instead (`pending-import.ts`).
         *
         * Every importer — folder, git clone button, the `/git?url=` route — funnels through here, so
         * this one line covers all of them and a future one gets it without having to know.
         */
        setPendingImport();

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
