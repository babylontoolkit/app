/**
 * NEW PROJECT MODE — "this project exists and runs, but nothing has been built in it yet" (§4.4a, T7).
 *
 * Creation no longer sends anything to a model: it clones the starter, installs it, runs it, and hands
 * the user's own prompt back to them in the chat box. So there is a state between "the project exists"
 * and "the game has been built" that did not exist before, and two things depend on knowing it:
 *
 *   - the visible banner telling the user this next message is the one that builds their game, and
 *   - the hidden creation BRIEF appended to that message (the play contract, the scaffolded class name,
 *     the images actually on disk) — which is why the brief is CARRIED here rather than rebuilt at send
 *     time. It is a fact about the moment of creation; rebuilding it later from whatever the store
 *     happens to hold is how it comes to describe a project that has since changed.
 *
 * 🔴 **KEYED PER PROJECT, NOT PER USER OR PER TAB.** The key is `bt_new_project_mode:<projectId>`,
 * following the fix `SavingSurface` already needed for exactly this mistake: its "one-time" reminder
 * shipped as a single per-user flag and so fired for a user's FIRST project and never again, silently
 * protecting only one artifact. A single record here would be worse — creating a second project would
 * overwrite the first one's brief, and the first project would reopen with no banner and no brief, with
 * nothing anywhere reporting that anything was lost.
 *
 * 🔴 **CLEARED ON SEND, NOT ON FINISH.** The mode ends the moment the build turn is POSTED. Waiting for
 * it to succeed sounds safer and is not: a generation that fails is one the user will retry, and if the
 * mode were still set the brief would be appended a second time — while a mode that outlives its send
 * makes a double-send double-append. The brief is a fact about the FIRST message, not about the first
 * successful one.
 *
 * ⚠️ **A slash command must never clear it.** `/context` on a freshly created project is an ordinary
 * thing to type, and client commands are intercepted before anything is posted — so the clear belongs
 * strictly after that interception, beside the send, never at the top of the handler.
 */
import { atom } from 'nanostores';

export const NEW_PROJECT_MODE_PREFIX = 'bt_new_project_mode:';

export interface NewProjectMode {
  /** Whose mode this is. Read back on hydrate so one project can never answer for another. */
  projectId: string;

  /**
   * The machine-written creation brief, appended hidden to the first build message.
   *
   * Must contain `CREATION_BRIEF_MARKER` verbatim: the server recognises the first build turn by
   * sniffing for it, and ten behavioural protections (premium lock, skill preload, the bounded
   * media-only tool loop, `requiresAction`, the liveness copy) hang off that one string.
   */
  brief: string;
}

/**
 * The minimum of `Storage` this module uses.
 *
 * Declared rather than imported so the tests can drive a plain object, and so nothing here depends on a
 * DOM global that does not exist on the server.
 */
export interface ModeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export function newProjectModeKey(projectId: string): string {
  return `${NEW_PROJECT_MODE_PREFIX}${projectId}`;
}

/**
 * The live mode for the project currently open, or `null`.
 *
 * A store rather than a bare read because the banner has to appear and disappear without a reload. It is
 * always a value for the OPEN project — `hydrateNewProjectMode` sets it on mount and clears it when the
 * project it belongs to is not the one being opened.
 */
export const newProjectModeStore = atom<NewProjectMode | null>(null);

function defaultStorage(): ModeStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/**
 * Read a project's stored mode. Returns `null` for anything that is not a well-formed record for THIS
 * project — a corrupt value, a truncated write, or (the one that matters) a record belonging to another
 * project. A stored brief is instructions that reach the model; a shape check is cheap and the failure
 * of not doing one is a different project's brief being sent as this one's.
 */
export function readNewProjectMode(
  projectId: string,
  storage: ModeStorage | null = defaultStorage(),
): NewProjectMode | null {
  if (!storage || !projectId) {
    return null;
  }

  try {
    const raw = storage.getItem(newProjectModeKey(projectId));

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<NewProjectMode>;

    if (parsed?.projectId !== projectId || typeof parsed.brief !== 'string' || parsed.brief.length === 0) {
      return null;
    }

    return { projectId, brief: parsed.brief };
  } catch {
    /*
     * Swallowed on purpose. A banner and a hidden brief are not worth an exception on the mount path,
     * and every failure here degrades to the honest answer: this project is not in New Project mode, so
     * it behaves like any ordinary project.
     */
    return null;
  }
}

/** Enter the mode for a project — called once, by creation, after the project exists. */
export function enterNewProjectMode(mode: NewProjectMode, storage: ModeStorage | null = defaultStorage()): void {
  newProjectModeStore.set(mode);

  /*
   * An unregistered project (the WebContainer-only fallback, where the server could not be reached) has
   * no id to key on. It still gets the mode for this session — the banner and the brief are exactly as
   * useful there — it just cannot survive a reload. Writing it under the bare prefix instead would give
   * every such project ONE shared record, which is the per-user-flag bug this module exists to avoid.
   */
  if (!mode.projectId) {
    return;
  }

  try {
    storage?.setItem(newProjectModeKey(mode.projectId), JSON.stringify(mode));
  } catch {
    /*
     * Persistence is best-effort (private browsing, a full quota). The in-memory store still carries the
     * mode for this session, so the user gets the banner and the brief; only surviving a reload is lost.
     */
  }
}

/**
 * Leave the mode — the build turn has been sent.
 *
 * Takes the project id explicitly rather than reading the open project: the caller knows which project
 * it just posted for, and a clear that resolves its own target can clear the wrong one after a switch.
 */
export function exitNewProjectMode(projectId: string, storage: ModeStorage | null = defaultStorage()): void {
  if (newProjectModeStore.get()?.projectId === projectId) {
    newProjectModeStore.set(null);
  }

  try {
    storage?.removeItem(newProjectModeKey(projectId));
  } catch {
    // As above: losing the removal costs a banner on the next reload, never correctness of the send.
  }
}

/**
 * Point the live store at the project being opened.
 *
 * Called on every mount, including for projects that were never in the mode — the `null` write is the
 * load-bearing half. Without it the store keeps the PREVIOUS project's mode across an SPA navigate
 * (module-level state survives one), and the banner plus the brief would follow the user into a project
 * they had already built, which is the inherited-identity class of bug §4.5.6 records twice.
 */
export function hydrateNewProjectMode(
  projectId: string | undefined,
  storage: ModeStorage | null = defaultStorage(),
): NewProjectMode | null {
  const mode = projectId ? readNewProjectMode(projectId, storage) : null;
  newProjectModeStore.set(mode);

  return mode;
}
