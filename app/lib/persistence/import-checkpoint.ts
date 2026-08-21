/**
 * The first durable copy of an IMPORTED project (SPEC §4.5.4b, §4.5.4c, §4.12, §4.13a).
 *
 * ## Why an import has to checkpoint itself
 *
 * Every import ends in `importChat`, which sets `window.location.href` — a FULL PAGE LOAD. The only
 * enabled sandbox provider is session-scoped (`SANDBOX_PROVIDER_TRAITS.nodepod.outlivesSession ===
 * false`), so the runtime holding the freshly-written bytes does not survive it. Whatever the reload
 * mounts from (`selectMountSource`) IS the import — nothing else carries it across.
 *
 * That is why this is a module and not a `try` at each door. The git door has checkpointed since
 * server-side clone shipped; the FOLDER door did not, and its two consequences were silent and
 * different:
 *
 *   - its binaries were written straight into a sandbox that was about to be destroyed, so an imported
 *     game came back after the reload without a single texture, model or sound — the exact failure
 *     `writeBinaryFiles` was written to fix, one layer further down the same path;
 *   - its text survived only because it rode in the chat as a `<boltArtifact>` of file bodies, i.e. the
 *     replay design the git door removed for corrupting every binary AND for buying a permanent
 *     per-turn context bill (§4.2.8) — on the highest-variance ingest this platform has.
 *
 * One door checkpointed, the other kept the artifact, and neither fact was written down next to the
 * other. That is this codebase's recurring shape: one half of a pair guarded, the other not
 * (`recordAgentWrite`/`#recordRestoredFiles`, `prepareMountedProject`/`mountedThisLoad`, clone/pull).
 *
 * ## The two shapes, and why the map is optional
 *
 * A clone holds the whole tree in memory before it writes a byte, so it hands that map straight in: it
 * IS the project. A folder import ADDS files to a workspace it does not necessarily own the whole of
 * (`openImportWorkspace` hands back the ALREADY-BOOTED project when an import is started from inside
 * one), so its own map is not the whole truth — and a checkpoint that is not the whole truth is a
 * DELETION, because a local checkpoint is restored with `protectNothing` ("this map is everything the
 * project has", `restore-plan.ts`). With no map the STORE is serialized instead, which is the whole
 * truth by construction whichever workspace the import landed in.
 *
 * 🔴 That serialize is STRICT, and it runs through the shared policy rather than a bare call
 * (`checkpoint-run.ts`): a lax `serializeFiles` silently OMITS binaries it could not read, and this map
 * is restored as the whole truth — so a lax import checkpoint arranges for `havok.wasm` to be deleted
 * on the next reload. Better no checkpoint than a poisoned one. The policy also time-boxes each attempt
 * (a dead sandbox connection HANGS rather than erroring) and spaces retries (reads racing the tail of
 * the write queue).
 *
 * ## Loud, always
 *
 * A failure here means the import may simply not come back, and the user is the only party who can act
 * on it (`spec/fail-loud.md`). A `logger.error` on this path is a silent data loss with a receipt
 * nobody reads — so every exit that did not write a checkpoint toasts, names the cause in its own
 * words, and keeps the detail in the log for us.
 */
import { toast } from 'react-toastify';
import type { SerializedFileMap } from '~/lib/binary/binary-files';
import { runCheckpointSerialize } from '~/lib/persistence/checkpoint-run';
import { createLocalSnapshot } from '~/lib/persistence/local-snapshots';
import { saveWorkingCopy } from '~/lib/persistence/projects';
import { db } from '~/lib/persistence/useChatHistory';
import { withinWorkingCopyBudget } from '~/lib/persistence/working-copy-size';
import { workbenchStore } from '~/lib/stores/workbench';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ImportCheckpoint');

export interface ImportCheckpointInput {
  projectId: string;

  /** The folder or repository being imported — names the §4.12 history row and the warning. */
  name: string;

  /**
   * The whole project, when the caller already holds it (a clone's server-returned tree).
   *
   * Omit it when the caller wrote into a workspace it is not authoritative about — see the header.
   */
  files?: SerializedFileMap;

  /**
   * Also write the server recovery copy (§4.5.4c).
   *
   * For an import with NO repository (a folder) this checkpoint is the only copy of the project that
   * exists anywhere, in one browser's IndexedDB — precisely the case §4.5.4c was written for. A git
   * import is born LINKED, so a browser that loses its checkpoint mounts from the repo
   * (`selectMountSource` → `repo`, which deliberately outranks the working copy): a server copy there
   * would be written and never read.
   */
  serverCopy?: boolean;
}

/** LOUD: the log line for us, the toast for the one person who can still act on it. */
function reportFailure(name: string, detail: string, error?: unknown): void {
  const message = `Could not checkpoint the imported project ${name}: ${detail}`;

  if (error === undefined) {
    logger.error(message);
  } else {
    logger.error(message, error);
  }

  toast.warn(
    `Could not save a local checkpoint of ${name}: ${detail}. The files are in your workspace, but they may not ` +
      `survive a reload — commit them to a repository before closing this tab.`,
  );
}

/**
 * Capture an imported project as the copy its hand-off's page load will mount from.
 *
 * Best-effort by contract: never throws, and returns whether a checkpoint was actually written. The
 * files are already correct on disk, so a caller must not fail an import over this — it must not
 * SWALLOW it either, which is what `reportFailure` is for.
 */
export async function checkpointImportedProject(input: ImportCheckpointInput): Promise<boolean> {
  const database = db;

  if (!database) {
    reportFailure(input.name, 'this browser has no local database');
    return false;
  }

  let files = input.files;

  if (!files) {
    /*
     * No `waitForWrites`: this door wrote the bytes itself and awaited every write, so there is no
     * action queue to settle. Asking for one would make the import wait on a runner it never used.
     */
    const outcome = await runCheckpointSerialize({
      serialize: () => workbenchStore.serializeFiles({ strict: true }),
    });

    if (outcome.kind !== 'ok') {
      reportFailure(input.name, `${outcome.reason} — ${outcome.detail} (${outcome.attempts} attempt(s))`);
      return false;
    }

    files = outcome.files;
  }

  let snapshot: Awaited<ReturnType<typeof createLocalSnapshot>>;

  try {
    snapshot = await createLocalSnapshot(database, {
      projectId: input.projectId,
      files,
      label: `Imported ${input.name}`,
    });
  } catch (error) {
    /*
     * `QuotaExceededError` on a 5–10MB map is a real outcome here, not an exceptional one
     * (`local-snapshots.ts`) — and on this door it is the difference between an import that comes back
     * and one that does not.
     */
    reportFailure(input.name, error instanceof Error ? error.message : String(error), error);

    return false;
  }

  if (!input.serverCopy) {
    return true;
  }

  /*
   * Its own `try`, and sequenced AFTER the checkpoint: a failed upload must degrade to "no recovery
   * copy", never to "no checkpoint". Logged rather than toasted for the same reason
   * `checkpointProject` treats it as best-effort — the local checkpoint is the durable copy, and the
   * user has already been told everything actionable about the one that matters.
   *
   * 🔴 `saveWorkingCopy` with the map already in hand, NOT `writeWorkingCopyFromStore` (found live,
   * 2026-08-21). Two reasons, and the second one is a defect in the other path rather than a
   * preference:
   *
   *   - this function is holding the whole serialized project already, so re-reading every binary out
   *     of the sandbox to build the identical map would be a second whole-project read for nothing;
   *   - the store writer offloads to a Web Worker, and **a dedicated worker cannot be created from a
   *     script URL while the page is cross-origin isolated unless that script's own response carries
   *     `Cross-Origin-Embedder-Policy: require-corp`** — which `entry.server.tsx` sets on the DOCUMENT
   *     only. Measured live: `crossOriginIsolated === true`, a blob worker (which inherits the policy)
   *     starts, the same-origin script-URL worker fires `onerror` before any fetch. Since that path
   *     TRANSFERS its buffers before it discovers this, they are detached and it cannot fall back —
   *     the first call of every page load returns `'failed'` and the save is simply lost.
   *
   * This path is the one `checkpointProject` and creation already take, and it is `seq`-identical to
   * the local checkpoint above. See SPEC §10 for the worker defect, which is NOT ours to fix here.
   */
  try {
    /*
     * The same size gate the generation checkpoint applies (§4.16): above the client budget, do not
     * stringify and upload the whole base64 map. The local checkpoint above is the durable copy; the
     * server copy is best-effort and simply absent until the project shrinks.
     */
    if (!withinWorkingCopyBudget(workbenchStore.files.get())) {
      logger.warn(`No server recovery copy for the imported project ${input.name}: over the client budget`);
      return true;
    }

    await saveWorkingCopy(input.projectId, snapshot.seq, files);
  } catch (error) {
    logger.warn(`No server recovery copy for the imported project ${input.name}`, error);
  }

  return true;
}
