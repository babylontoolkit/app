/**
 * Holding a workspace open until the projects folder is answered (SPEC §4.5.4d, owner 2026-09-17).
 *
 * Every door into a workspace — New Project's `runStartProject`, the mount's `mountProjectFiles` —
 * awaits this before it makes or opens anything. It resolves `proceed` the instant no question needs
 * asking, so the common case (a folder already connected, a browser that cannot do it, a signed-out
 * visitor) costs one synchronous decision and renders nothing at all.
 *
 * Dependencies are injected because this owns a timer, a subscription and a promise that a workspace is
 * blocked on, and the failure that matters — it never settles — is invisible without a fake clock.
 * `index.ts` supplies the real ones.
 *
 * ## Never regress, each silent
 *
 * 🔴 **It always settles.** Every exit runs through `finish`, which is idempotent and unsubscribes,
 * clears the timer and closes the panel. A path that returns without settling hangs the door forever:
 * a New Project button that does nothing, or a project that never opens, with no error anywhere.
 *
 * 🔴 **The ceiling passes, never cancels.** Not knowing the account is OUR problem, not a decision the
 * user made; turning it into `cancelled` would refuse to open a project because a session request was
 * slow.
 *
 * 🔴 **`skip` re-decides, it does not settle directly.** `decideFolderGate` is the only thing that may
 * conclude "no folder is needed", so a skip recorded while the folder is REQUIRED changes nothing —
 * pressing a button that is not on screen cannot be a way past the gate.
 *
 * 🔴 **A refresh that throws still opens the gate.** `refresh` reads IndexedDB and a permission API;
 * treating a failure there as "proceed" would silently drop the folder for the rest of the session,
 * which is the one outcome the whole feature exists to prevent.
 */
import { decideFolderGate, type FolderGateOutcome, type FolderGateRequest, type WorkspaceIntent } from './folder-gate';
import type { LocalProjectState } from './status';

export interface FolderGateDeps {
  /** Re-derive the disk state from the account and IndexedDB. Never prompts. */
  refresh(): Promise<void>;

  readState(): LocalProjectState;

  /** Notified whenever the disk state changes — how choosing a folder closes the gate by itself. */
  subscribeState(listener: () => void): () => void;

  readSkipped(): boolean;
  rememberSkipped(): void;

  required: boolean;
  ceilingMs: number;

  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;

  /** Show (or update) the panel. */
  open(request: FolderGateRequest): void;

  /** Take the panel down. */
  close(): void;
}

/**
 * The user declined to set up a projects folder, so the workspace was not opened.
 *
 * 🔴 It is an ERROR rather than a quiet return, and that is the whole correction of a defect found by
 * driving it (2026-09-17): the mount door first reported a boot failure and RESOLVED, which every one
 * of its three callers reads as "the mount is done" — so they set `ready`, the workbench rendered over
 * the failure panel, and cancelling opened the project anyway. **A refusal that resolves is a success.**
 * Thrown, it reaches `handleOpenFailure`, the one place that decides surface-versus-continue for an
 * open, and the callers' own retry is offered with it.
 */
export class ProjectsFolderDeclinedError extends Error {
  constructor() {
    super('This project was not opened, because your projects folder has not been set up on this computer yet.');
    this.name = 'ProjectsFolderDeclinedError';
  }
}

export interface RunningFolderGate {
  /** Resolves once — the door awaits this. */
  outcome: Promise<FolderGateOutcome>;

  /** *Not now*: record the skip, then re-decide. Only passes when the folder is not required. */
  skip(): void;

  /** *Cancel*: the workspace is not opened. */
  cancel(): void;
}

export function runFolderGate(intent: WorkspaceIntent, deps: FolderGateDeps): RunningFolderGate {
  let settle!: (outcome: FolderGateOutcome) => void;
  const outcome = new Promise<FolderGateOutcome>((resolve) => {
    settle = resolve;
  });

  let unsubscribe: (() => void) | undefined;
  let timer: unknown;
  let settled = false;
  let waitedTooLong = false;

  const finish = (result: FolderGateOutcome) => {
    if (settled) {
      return;
    }

    settled = true;
    unsubscribe?.();

    if (timer !== undefined) {
      deps.clearTimer(timer);
    }

    deps.close();
    settle(result);
  };

  const evaluate = () => {
    if (settled) {
      return;
    }

    const state = deps.readState();
    const gate = decideFolderGate({
      state,
      required: deps.required,
      skippedThisSession: deps.readSkipped(),
      waitedTooLong,
    });

    if (gate === 'pass') {
      finish('proceed');
      return;
    }

    deps.open({ gate, intent, required: deps.required, state });
  };

  /*
   * The refresh is awaited before the first decision so a connected folder never flashes the panel,
   * and its failure is swallowed on purpose: a state we could not read is `unknown`, which the gate
   * already covers (spinner, then the ceiling) rather than a reason to skip the question.
   */
  void deps
    .refresh()
    .catch(() => undefined)
    .then(() => {
      if (settled) {
        return;
      }

      unsubscribe = deps.subscribeState(evaluate);
      timer = deps.setTimer(() => {
        waitedTooLong = true;
        evaluate();
      }, deps.ceilingMs);

      evaluate();
    });

  return {
    outcome,
    skip() {
      if (settled) {
        return;
      }

      deps.rememberSkipped();
      evaluate();
    },
    cancel() {
      finish('cancelled');
    },
  };
}
