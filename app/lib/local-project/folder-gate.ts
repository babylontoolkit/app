/**
 * The projects-folder gate — a precondition of the WORKSPACE, never a cover on a page
 * (SPEC §4.5.4d; owner 2026-09-17: *"that whole thing should be GATED with actually loading the
 * WORKSPACE… before project creation, or project loading, or anything with a project… not just simply
 * hitting the main page of the app builder"*).
 *
 * ## Why this is not a route rule
 *
 * It shipped as one: `isGatedPath` covered `/`, `/chat/*`, `/git` and `/dashboard`. But `/` is BOTH the
 * marketing-ish front page (a textbox, some genre cards) AND the builder once a project is mounted, so
 * a path can never tell "someone is looking at the app" from "someone is opening a workspace" — and
 * the front page is exactly where the gate must not appear. The question the gate asks is *where should
 * this project be written*, which has no meaning until there is a project, so it belongs to the MOMENT
 * a workspace opens and to nothing else. Every door to a workspace awaits `runFolderGate`
 * (`workspace-gate.ts`); browsing, the gallery, help, a shared game and the landing page never call it,
 * so they cannot be covered by construction rather than by a list somebody maintains.
 *
 * That is the third time a list-of-doors has been the defect here (`coversWorkspace`, the outbound-route
 * sweep, and now this): **an enumeration cannot see the door nobody enumerated.** Awaiting at the door
 * inverts it — a new workspace door that forgets to await simply does not gate, which is visible, rather
 * than a new PAGE silently inheriting a cover it should never have had.
 *
 * ## The three pass-throughs, each a locked door if it goes missing
 *
 *   - `unavailable` — this browser cannot pick a folder (Safari, Firefox). A gate that cannot be
 *     satisfied is not a setup step.
 *   - `signed-out` — the folder handle is keyed by account, so there is nothing to choose yet.
 *   - `unknown` — the account is not answerable yet: cover with a spinner, then PASS at the ceiling.
 *     A cover that waits on `/api/me` forever is a trap.
 *
 * `required` (`saving.requireProjectsFolder`, default ON) decides only what the second button is: with
 * it, *Cancel*, which abandons the workspace and leaves the user exactly where they were; without it,
 * *Not now*, which opens the workspace with no folder and is remembered for the session.
 */
import { atom } from 'nanostores';
import type { LocalProjectState } from './status';

/** Which door is waiting. It changes one word of copy and nothing about the decision. */
export type WorkspaceIntent = 'create' | 'open';

export type FolderGate = 'checking' | 'choose' | 'reconnect' | 'pass';

/** What the waiting door does next. */
export type FolderGateOutcome = 'proceed' | 'cancelled';

/** The open gate, or `null`. Written only by `workspace-gate.ts`; read by the one mounted component. */
export interface FolderGateRequest {
  gate: Exclude<FolderGate, 'pass'>;
  intent: WorkspaceIntent;
  required: boolean;

  /** Snapshotted so the copy can name the remembered folder. */
  state: LocalProjectState;
}

export const folderGateRequest = atom<FolderGateRequest | null>(null);

export interface FolderGateFacts {
  state: LocalProjectState;

  /** `saving.requireProjectsFolder`: there is no way into a workspace without a folder. */
  required: boolean;

  /** The user pressed *Not now* this session (only offered when not required). */
  skippedThisSession: boolean;

  /** The account has been unanswerable for longer than `saving.folderGateCheckCeilingMs`. */
  waitedTooLong: boolean;
}

export function decideFolderGate(facts: FolderGateFacts): FolderGate {
  const mayPass = !facts.required && facts.skippedThisSession;

  switch (facts.state.kind) {
    case 'unknown':
      return facts.waitedTooLong ? 'pass' : 'checking';
    case 'unset':
      return mayPass ? 'pass' : 'choose';
    case 'needs-permission':
      return mayPass ? 'pass' : 'reconnect';
    case 'unavailable':
    case 'signed-out':
    case 'connected':
    default:
      return 'pass';
  }
}

export interface FolderGateCopy {
  title: string;
  detail: string;

  /** The button that moves forward. Empty while checking, which has no buttons at all. */
  primary: string;

  /** `reconnect` only: pick a different folder instead of reopening the remembered one. */
  alternate?: string;

  /** Open the workspace WITHOUT a folder. Present only when the folder is not required. */
  skip?: string;

  /** Abandon the workspace. Present only when the folder IS required. */
  cancel?: string;
}

/**
 * Every string the gate shows, from the request and nothing else (§4.1a: a sentence written inside a
 * component is a sentence nothing checks).
 *
 * `skip` and `cancel` are separate fields although they share a slot on screen, because they are
 * opposite outcomes — one opens the workspace, the other abandons it — and a single `secondary` label
 * whose meaning flips on a boolean is how a door ends up proceeding when the user pressed the button
 * that said Cancel.
 */
export function folderGateCopy(request: FolderGateRequest): FolderGateCopy {
  const { gate, intent, required, state } = request;
  const secondary = required ? { cancel: 'Cancel' } : { skip: 'Not now' };

  switch (gate) {
    case 'checking':
      return { title: 'Checking your account…', detail: 'One moment.', primary: '' };
    case 'choose':
      return {
        title: 'Where should your projects live?',
        detail: `Your projects are kept in a folder on this computer, so they stay real files you can open in your own editor, back up, or push to GitHub. Choose that folder to ${
          intent === 'create' ? 'create this project' : 'open this project'
        }. You can change it any time in Settings.`,
        primary: 'Choose a folder on this computer',
        ...secondary,
      };
    case 'reconnect': {
      const folderName = state.kind === 'needs-permission' ? state.folderName : 'your projects folder';

      return {
        title: `Reconnect ${folderName}`,
        detail: `Your projects live in ${folderName}. Your browser needs a click before this session can open it.`,
        primary: `Open ${folderName}`,
        alternate: 'Use a different folder…',
        ...secondary,
      };
    }
    default:
      return { title: '', detail: '', primary: '' };
  }
}
