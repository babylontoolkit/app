/**
 * The Save button and the LINKED/UNLINKED indicator (SPEC §4.5.4b).
 *
 * This is the whole of what a user sees about where their game lives, so two things about it are not
 * negotiable:
 *
 * **It renders whenever there is a project.** The GitHub button next to it hides until a preview is
 * running, which was correct while syncing was an optional extra — you cannot sync a project that has
 * not built yet. Saving is not an extra: a project that failed to build is *exactly* the one whose
 * code the user cannot afford to lose. Gating this on `activePreview` would hide Save from the people
 * who need it most, silently.
 *
 * **It is asymmetric on purpose.** Unlinked is amber and says the awkward thing out loud; saved is grey
 * and nearly invisible. A user's default belief in 2026 is that everything saves itself, so the state
 * that contradicts that belief has to carry the weight.
 *
 * All the wording and every tone lives in `describeSaveStatus` (pure, exhaustively tested — including
 * a sweep proving no combination of states can produce a badge that claims "saved" when it is not).
 * This file draws what that function returns and calls the three functions it names. Adding a string
 * here rather than there means adding a string nothing tests.
 */
import { useStore } from '@nanostores/react';
import { classNames } from '~/utils/classNames';
import { projectId as projectIdStore, repoStatus, unsavedWork, requestSave, startGitConnect } from '~/lib/persistence';
import { saveState } from '~/lib/persistence/save-queue';
import { describeSaveStatus, type SaveTone } from '~/lib/persistence/save-status';

const TONE_CLASSES: Record<SaveTone, string> = {
  danger: 'text-red-400 border-red-500/40 bg-red-500/10',
  warning: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
  busy: 'text-bolt-elements-textSecondary border-bolt-elements-borderColor',
  neutral: 'text-bolt-elements-textSecondary border-bolt-elements-borderColor',
};

const TONE_ICONS: Record<SaveTone, string> = {
  danger: 'i-ph:warning-circle-fill',
  warning: 'i-ph:warning-circle',
  busy: 'i-svg-spinners:90-ring-with-bg',
  neutral: 'i-ph:check-circle',
};

export function SaveStatus() {
  const activeProjectId = useStore(projectIdStore);
  const repo = useStore(repoStatus);
  const unsaved = useStore(unsavedWork);
  const state = useStore(saveState);

  if (!activeProjectId) {
    return null;
  }

  const view = describeSaveStatus({ repo, unsavedWork: unsaved, saveState: state });

  const onAction = () => {
    if (view.action === 'reconnect') {
      startGitConnect(repo?.provider ?? 'github');
      return;
    }

    // `save` and `retry` are the same call. The distinction is what the user is told, not what we do.
    void requestSave(activeProjectId);
  };

  return (
    <div className="flex items-center gap-1.5">
      {/*
       * The badge links to the help page (§4.5.4b). "Not saved — browser only" raises a question in
       * the reader's head — where IS it, then, and why isn't it saved? — and the answer has to be one
       * click from the place the question is asked, or the badge is just an unexplained worry.
       */}
      <a
        href="/help/saving-projects"
        className={classNames(
          'flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border whitespace-nowrap hover:opacity-80 transition-opacity',
          TONE_CLASSES[view.tone],
        )}
        title={`${view.detail} — click to learn more`}
      >
        <div className={classNames(TONE_ICONS[view.tone], 'shrink-0')} />
        <span>{view.label}</span>
      </a>

      {view.action !== 'none' && (
        <button
          onClick={onAction}
          title={view.detail}
          className={classNames(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors',
            view.tone === 'danger' || view.tone === 'warning'
              ? 'bg-accent-500 text-white hover:bg-bolt-elements-button-primary-backgroundHover'
              : 'border border-bolt-elements-borderColor text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2',
          )}
        >
          <div className={view.action === 'reconnect' ? 'i-ph:plugs' : 'i-ph:cloud-arrow-up'} />
          <span>{view.actionLabel}</span>
        </button>
      )}
    </div>
  );
}
