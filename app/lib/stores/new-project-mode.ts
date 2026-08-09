/**
 * NEW PROJECT MODE — "this project exists and runs, but nothing has been built in it yet" (§4.4a, T7).
 *
 * Creation no longer sends anything to a model: it clones the starter, installs it, runs it, and hands
 * the user's own prompt back to them in the chat box. So there is a state between "the project exists"
 * and "the game has been built" that did not exist before, and the handoff card (plus the premium
 * lock) depends on knowing it.
 *
 * 🔴 **THERE IS NO CREATION BRIEF (owner, 2026-08-08).** This mode used to carry a machine-written
 * hidden brief appended to the first build message. Retired: the baked system prompt plus the file
 * context proved more reliable, so the first build turn is an ordinary turn carrying only the user's
 * own words (`userPrompt`). The mode now exists to track "created but never built" — the card, the
 * carried prompt, and the send that ends it.
 *
 * 🔴 **KEYED PER PROJECT, NOT PER USER OR PER TAB.** The key is `bt_new_project_mode:<projectId>`,
 * following the fix `SavingSurface` already needed for exactly this mistake: its "one-time" reminder
 * shipped as a single per-user flag and so fired for a user's FIRST project and never again, silently
 * protecting only one artifact. A single record here would be worse — creating a second project would
 * overwrite the first one's brief, and the first project would reopen with no banner and no brief, with
 * nothing anywhere reporting that anything was lost.
 *
 * 🔴 **THE MODE IS CLEARED ON SEND, NOT ON FINISH.** A generation that fails is one the user will
 * retry, and a mode that outlives its own send is a mode a second, fast send reads again.
 *
 * 🔴 **THE PLAN OUTLIVES IT, AND THAT IS THE ONE THING HERE THAT CHANGED (§4.4e, 2026-08-08).** A
 * creation is now several phases (Game → Frontend → Art → Verify), because one turn asking for all of
 * it hit the provider's 64,000-token output ceiling and shipped a project with nine files welded into
 * one. So `plan` is the record of which phases are still owed, and it must survive the send that
 * clears the brief — otherwise a tab that dies mid-build strands a half-written project with nothing
 * able to resume it, after the user has paid for the phases that ran. The mode therefore ends at the
 * LAST PHASE, not the first send; only the brief ends at the send.
 *
 * ⚠️ **The row is the SOURCE, this is the CACHE.** `projects.creation_handoff` survives a device
 * switch and a cleared browser; this copy exists so the common case paints without a round trip. Two
 * writers of "is creation over" is the drift this codebase keeps rediscovering, so: the row wins, the
 * merge is monotonic and happens SERVER-side (`api.projects.$projectId.ts`), and nothing here may
 * decide that a plan is further along than the row says.
 *
 * ⚠️ **A slash command must never clear it.** `/context` on a freshly created project is an ordinary
 * thing to type, and client commands are intercepted before anything is posted — so the clear belongs
 * strictly after that interception, beside the send, never at the top of the handler.
 */
import { atom } from 'nanostores';
import { parseCreationPlan, type CreationPlan } from '~/lib/agent/creation-plan';

export const NEW_PROJECT_MODE_PREFIX = 'bt_new_project_mode:';

export interface NewProjectMode {
  /** Whose mode this is. Read back on hydrate so one project can never answer for another. */
  projectId: string;

  /**
   * The user's OWN words — what they typed on the landing page, or the wizard's short summary.
   *
   * 🔴 **Persisted here because nothing else persists it.** It used to live only in `projectSeedStore`
   * (in-memory, gone on reload) with the `cachedPrompt` cookie quietly covering the gap — and that
   * cookie is exactly what made the prompt reappear in the chat box like leftover state, and what
   * leaked it onto the NEXT visit to the landing page. The handoff card shows these words and its
   * actions send or edit them, so a reload mid-decision must not lose the one prompt in the product
   * the user did not just type and cannot retype from memory.
   *
   * Absent on the card path with an empty box: there were no words, and inventing some would put the
   * machine's phrasing in the user's mouth.
   */
  userPrompt?: string;

  /**
   * Has the user closed the handoff card (the `X`, or one of its actions) IN THIS SESSION?
   *
   * 🔴 **Dismissing the CARD is not leaving the MODE.** The hidden brief must still ride on whatever
   * they send next — drop it and the play contract, the scaffolded class name and the on-disk image
   * list vanish from the most expensive turn in the product, silently. So this hides one panel and
   * nothing else; only a SEND clears the mode.
   *
   * 🔴 **AND IT IS NOT PERSISTED (owner, 2026-07-29).** It was, and that was wrong: until the first
   * build, this card IS the state of the project — one action outstanding, and nothing else on screen
   * says so. A dismissal that outlives a reload is right for a NAG, and this is not one, because it
   * ends by itself the moment the user builds. So the card comes back on reload and on any device
   * until there has actually been a build, and `X` means "hide it for now" rather than "never again".
   *
   * Deliberately absent from the persisted record and never read back by `readNewProjectMode`.
   */
  handoffDismissed?: boolean;

  /**
   * The phase plan, once the build has started (`~/lib/agent/creation-plan`).
   *
   * A CACHE of `projects.creation_handoff.plan` — see the module header. Absent means "no plan",
   * which every reader treats as the pre-phase single-turn creation, so a project made before phases
   * and a project whose build never started behave identically and correctly.
   */
  plan?: CreationPlan;
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
 * project. The stored prompt reaches the chat box and the model; a shape check is cheap and the failure
 * of not doing one is a different project's prompt being offered as this one's.
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

    if (parsed?.projectId !== projectId) {
      return null;
    }

    /*
     * Rebuilt field by field, never spread. A spread carries whatever a future version of this record
     * happens to hold — including a field written by a NEWER build of the app in another tab — into
     * code that has no idea what it means. Both optionals are validated to their own type so a corrupt
     * `userPrompt` degrades to "no words" rather than putting `[object Object]` in the chat box.
     *
     * `handoffDismissed` is NOT read back — it is a session fact, so a reload deliberately reopens the
     * card on a project that has still never been built (see its doc comment).
     */
    return {
      projectId,
      userPrompt: typeof parsed.userPrompt === 'string' ? parsed.userPrompt : undefined,
      plan: parseCreationPlan(parsed.plan),
    };
  } catch {
    /*
     * Swallowed on purpose. A banner and a carried prompt are not worth an exception on the mount path,
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
   * no id to key on. It still gets the mode for this session — the banner and the carried prompt are
   * exactly as useful there — it just cannot survive a reload. Writing it under the bare prefix instead
   * would give every such project ONE shared record, which is the per-user-flag bug this module exists
   * to avoid.
   */
  if (!mode.projectId) {
    return;
  }

  try {
    storage?.setItem(newProjectModeKey(mode.projectId), JSON.stringify(mode));
  } catch {
    /*
     * Persistence is best-effort (private browsing, a full quota). The in-memory store still carries the
     * mode for this session, so the user gets the banner and the prompt; only surviving a reload is lost.
     */
  }
}

/**
 * Close the handoff card — the `X`, or any of its actions once they have done their work.
 *
 * 🔴 **This is NOT `exitNewProjectMode`, and the difference is the whole point.** Closing the card
 * hides one panel; the mode lives on — the project is still unbuilt, the carried prompt still exists,
 * and only a SEND ends the mode. Collapsing the two would mean that clicking `X` — the most casual
 * gesture on the screen — silently ended a state the rest of the flow still needs.
 *
 * A no-op when the project is not the one in the mode: same scoping rule as everywhere else here, so a
 * stale card in a background tab cannot dismiss the card of the project actually open.
 */
export function dismissCreationHandoff(projectId: string): void {
  const mode = newProjectModeStore.get();

  if (!mode || mode.projectId !== projectId) {
    return;
  }

  /*
   * IN MEMORY ONLY — nothing is written back. The card reappearing after a reload is the intended
   * behaviour, not a failure to persist: until the project has been built there is exactly one action
   * outstanding, and hiding it for good would leave an unbuilt project with nothing saying so.
   */
  newProjectModeStore.set({ ...mode, handoffDismissed: true });
}

/**
 * Record the plan's progress locally, mirroring what has just been written to the row.
 *
 * ⚠️ **The row is the source; this only mirrors it.** The server merge is what guarantees `next`
 * never goes backwards, so this must be called with the plan the server ACCEPTED, never with a plan
 * this tab computed and hoped for. Writing an optimistic value here would give the runner a local
 * copy that is ahead of the truth, and it would skip a phase the user paid for.
 *
 * A no-op when the project is not the one in the mode — the same scoping rule as every other writer
 * here, so a background tab cannot advance the plan of the project actually open.
 */
export function updateCreationPlan(
  projectId: string,
  plan: CreationPlan,
  storage: ModeStorage | null = defaultStorage(),
): void {
  const mode = newProjectModeStore.get();

  if (!mode || mode.projectId !== projectId) {
    return;
  }

  const next: NewProjectMode = { ...mode, plan };
  newProjectModeStore.set(next);

  if (!projectId) {
    return;
  }

  try {
    /*
     * `handoffDismissed` is a session fact and must not reach storage (see its doc comment) — the
     * persisted record is rebuilt from the fields `readNewProjectMode` reads back, nothing more.
     */
    storage?.setItem(newProjectModeKey(projectId), JSON.stringify({ projectId, userPrompt: mode.userPrompt, plan }));
  } catch {
    // Best-effort, as everywhere else here: the in-memory store still carries the plan this session.
  }
}

/**
 * Leave the mode — the plan is complete (or the user has taken the wheel).
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
