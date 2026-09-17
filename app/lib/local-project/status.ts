/**
 * What the disk link is doing right now — the store the Settings card, the ⋯ menu and the boot
 * screen render from (SPEC §4.5.4d). Nothing here does IO; `index.ts` writes it.
 */
import { atom } from 'nanostores';

export interface ProjectMirrorStatus {
  /** The project's folder name under the parent. */
  dirName: string;

  /** Queued disk writes not yet landed. */
  pending: number;
  lastWriteAt?: number;

  /** The last disk error, verbatim. Cleared by the next successful write. */
  error?: string;
}

export type LocalProjectState =
  | { kind: 'unavailable' } // this browser cannot write to a picked folder (Safari, Firefox); nothing is offered

  /** Supported, and no projects folder has been chosen for this account. */
  | { kind: 'unset' }

  /** A folder is remembered but this session has not granted access to it yet (a click is needed). */
  | { kind: 'needs-permission'; folderName: string }

  /** The folder is open. `project` is present while a project is mirrored into it. */
  | { kind: 'connected'; folderName: string; project?: ProjectMirrorStatus }

  /** Accounts are on and nobody is signed in. The folder is per account, so there is nothing to choose yet. */
  | { kind: 'signed-out' }

  /** Not answerable yet — before the account is known. */
  | { kind: 'unknown' };

export const localProjectState = atom<LocalProjectState>({ kind: 'unknown' });

/**
 * The user pressed "Not now" on the first-run gate this session (`folder-gate.ts`). Only meaningful
 * while `saving.requireProjectsFolder` is off; read by the save nudges so a declined folder hands the
 * first-save moment back to the GitHub toast instead of leaving the project with no reminder at all.
 */
export const folderGateSkipped = atom(false);

/**
 * Strings for the UI, from the state and nothing else. Tested, because a sentence invented in a
 * component is a sentence nothing checks (§4.1a).
 */
export interface LocalProjectView {
  headline: string;
  detail: string;
  tone: 'quiet' | 'info' | 'warn' | 'error';

  /** The ONE action the surface may offer, if any. */
  action?: 'choose' | 'reconnect' | 'change';
}

export function describeLocalProject(state: LocalProjectState): LocalProjectView {
  switch (state.kind) {
    case 'unavailable':
      return {
        headline: 'Projects folder',
        detail:
          'Not available in this browser. Chrome, Edge and other Chromium browsers can keep your projects in a folder on this computer.',
        tone: 'quiet',
      };
    case 'unset':
      return {
        headline: 'Projects folder',
        detail:
          'Choose a folder on this computer and every project you open will live there — editable in VS Code, kept as you work.',
        tone: 'info',
        action: 'choose',
      };
    case 'needs-permission':
      return {
        headline: `Reconnect ${state.folderName}`,
        detail: 'Your browser needs a click before this session can read and write the folder.',
        tone: 'warn',
        action: 'reconnect',
      };
    case 'connected': {
      const project = state.project;

      if (!project) {
        return {
          headline: state.folderName,
          detail: 'Projects you open are kept in this folder.',
          tone: 'quiet',
          action: 'change',
        };
      }

      if (project.error) {
        return {
          headline: `${state.folderName}/${project.dirName}`,
          detail: `Could not write to the folder: ${project.error}`,
          tone: 'error',
          action: 'change',
        };
      }

      if (project.pending > 0) {
        return {
          headline: `${state.folderName}/${project.dirName}`,
          detail: `Writing ${project.pending} file${project.pending === 1 ? '' : 's'} to disk…`,
          tone: 'info',
          action: 'change',
        };
      }

      return {
        headline: `${state.folderName}/${project.dirName}`,
        detail: 'This project is on disk. Edit it here or in your own editor.',
        tone: 'quiet',
        action: 'change',
      };
    }
    case 'signed-out':
      return {
        headline: 'Projects folder',
        detail: 'Sign in to choose the folder on this computer your projects live in.',
        tone: 'quiet',
      };
    case 'unknown':
    default:
      return { headline: 'Projects folder', detail: 'Checking your account…', tone: 'quiet' };
  }
}
