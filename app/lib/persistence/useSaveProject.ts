/**
 * "SAVE MY PROJECT" — ONE DECISION, ONE WRITER, TWO DOORWAYS (§4.5.4b, §4.5.4c).
 *
 * The header's git chip owns saving. This hook is the part of it that is not a chip: which provider are
 * we talking about, what does the button say, and what does pressing it do. It exists because a SECOND
 * surface now needs the same answer — the creation handoff card, where the owner wants a one-press
 * baseline save of the freshly cloned project *"so we can easily reset from"* it.
 *
 * 🔴 **IT IS EXTRACTED, NOT COPIED, AND THAT IS THE WHOLE POINT.** This repo has already shipped the bug
 * where two surfaces answered one question independently: the header carried **two adjacent buttons both
 * labelled "Sync"**, because a rename made each one right against its neighbour and nothing was checking
 * the row as a whole. The lesson recorded then was that a name collision between siblings is usually a
 * missing parent. So a second save button gets the SAME parent — the same `describeSaveStatus` view, the
 * same provider resolution, the same `requestSave` call — and therefore cannot invent a second meaning
 * for "saved", a second label, or a second way to push to somebody's repository.
 *
 * Two rules travel with it, both of them things a fresh copy would quietly get wrong:
 *
 *   - **Every string comes from `describeSaveStatus`** (pure, exhaustively tested, and it bans the git
 *     vocabulary everywhere except one sanctioned `actionLabel`). A label written at a call site is a
 *     label nothing tests, and this is the one place in the product where a wrong word — "saved" when it
 *     is not — costs somebody their only copy.
 *   - **Nothing pushes without a press** (owner, 2026-07-23). This hook returns a function; it never
 *     fires on mount, on a checkpoint, or on any timer. Writing to a repository with the user's name on
 *     it needs a person.
 */
import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { projectId as projectIdStore, repoStatus, unsavedWork, requestSave, startGitConnect } from '~/lib/persistence';
import { saveState } from '~/lib/persistence/save-queue';
import { describeSaveStatus, type SaveStatusView } from '~/lib/persistence/save-status';

export type GitProvider = 'github' | 'gitlab';

export const PROVIDER_LABEL: Record<GitProvider, string> = { github: 'GitHub', gitlab: 'GitLab' };

/**
 * After an OAuth round trip the provider comes back on the URL. Read once as the initial choice so the
 * user lands on the account they just authorised rather than on the default.
 */
export function providerFromReturn(): GitProvider {
  if (typeof window === 'undefined') {
    return 'github';
  }

  return new URLSearchParams(window.location.search).get('provider') === 'gitlab' ? 'gitlab' : 'github';
}

export interface SaveProjectAction {
  /** No project open — every consumer renders nothing rather than a button that cannot do anything. */
  projectId: string | undefined;

  /** The tested view: badge, tone, detail, and the one sanctioned action label. */
  view: SaveStatusView;

  /** The provider every label and action must agree on: the project's own once linked, else the chosen one. */
  provider: GitProvider;

  /** Human name for that provider, for copy that has to say where the code is going. */
  providerName: string;

  /** Is there a genuine choice to offer? Only while unlinked, and only when the deployment configured both. */
  hasChoice: boolean;

  /** Providers this deployment can actually save to. */
  configured: GitProvider[];

  /** The user's pick while unlinked (ignored once the project has a provider of its own). */
  chooseProvider: (provider: GitProvider) => void;

  /** Do it. Reconnect if the token is dead, otherwise save — `save` and `retry` are the same call. */
  run: () => void;
}

export function useSaveProject(): SaveProjectAction {
  const activeProjectId = useStore(projectIdStore);
  const repo = useStore(repoStatus);
  const unsaved = useStore(unsavedWork);
  const state = useStore(saveState);

  const [chosenProvider, setChosenProvider] = useState<GitProvider>(providerFromReturn);

  /*
   * A brand-new project can be saved to more than one account when the deployment has both providers
   * configured. Offer the choice ONLY while unlinked and only when there IS a choice — once linked, the
   * project's own provider is authoritative. Without this, GitLab is unreachable: every action silently
   * defaults to GitHub.
   */
  const configured = (repo?.configuredProviders ?? []) as GitProvider[];
  const hasChoice = !repo?.linked && configured.length > 1;
  const provider: GitProvider = repo?.provider ?? (hasChoice ? chosenProvider : (configured[0] ?? 'github'));

  const view = describeSaveStatus({ repo, unsavedWork: unsaved, saveState: state, chosenProvider: provider });

  const run = () => {
    if (!activeProjectId) {
      return;
    }

    if (view.action === 'reconnect') {
      startGitConnect(provider);
      return;
    }

    // `save` and `retry` are the same call. The distinction is what the user is told, not what we do.
    void requestSave(activeProjectId, provider);
  };

  return {
    projectId: activeProjectId,
    view,
    provider,
    providerName: PROVIDER_LABEL[provider],
    hasChoice,
    configured,
    chooseProvider: setChosenProvider,
    run,
  };
}
