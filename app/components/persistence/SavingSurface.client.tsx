/**
 * Everything the platform says about saving, in one place (SPEC §4.5.4b).
 *
 * The header's `GitStatusChip` carries the state and every action on it; this carries the three things
 * that interrupt: the
 * one-time toast after a first creation, the recurring banner, and the browser's own unload warning.
 * Plus the divergence dialog, which is the only one of the four the user did not implicitly ask for.
 *
 * ## The rule this file exists to keep
 *
 * **A nudge never blocks a generation, and never fires on a timer** (§4.5.4b). Both are easy to break
 * here and nowhere else, so both are worth stating at the top: there is no `setTimeout` in this file
 * and there must not be one. The only thing that moves is `generationCount` — the user's own progress.
 * A timer fires while someone is mid-sentence describing their game, which is the one moment the
 * platform has nothing worth saying.
 *
 * `decideNudge` decides (pure, tested); this renders. The dismissal is remembered per project in
 * localStorage rather than on the server: it is a UI preference about a browser-only project, and a
 * round-trip to store "not now" would be the platform taking a dismissal more seriously than the work.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { generationCount, projectId as projectIdStore, repoStatus, requestSave, unsavedWork } from '~/lib/persistence';
import { decideNudge, shouldWarnBeforeUnload } from '~/lib/persistence/save-status';
import { workingCopySafe } from '~/lib/persistence/useChatHistory';
import { saving } from '~/config/saving';
import { SaveDivergenceDialog } from './SaveDivergenceDialog.client';
import { UnappliedTurnDialog } from './UnappliedTurnDialog.client';

/** The one-time toast is per USER, not per project — it teaches a fact about the product, once. */
const FIRST_TOAST_KEY = 'bt_saving_intro_shown';

const dismissKey = (projectId: string) => `bt_saving_banner_dismissed:${projectId}`;

function readNumber(key: string): number | undefined {
  const raw = localStorage.getItem(key);
  const value = raw === null ? NaN : Number(raw);

  return Number.isFinite(value) ? value : undefined;
}

export function SavingSurface() {
  return (
    <>
      <SaveDivergenceDialog />
      <UnappliedTurnDialog />
      <SaveNudges />
      <UnloadWarning />
    </>
  );
}

function SaveNudges() {
  const activeProjectId = useStore(projectIdStore);
  const repo = useStore(repoStatus);
  const count = useStore(generationCount);
  const [dismissedAt, setDismissedAt] = useState<number | undefined>();
  const toastShown = useRef(false);

  const linked = repo?.linked === true;

  // Dismissals are per project, so re-read them when the user opens a different one.
  useEffect(() => {
    setDismissedAt(activeProjectId ? readNumber(dismissKey(activeProjectId)) : undefined);
  }, [activeProjectId]);

  const nudge = activeProjectId
    ? decideNudge({
        linked,
        generationCount: count,
        firstToastShown: toastShown.current || localStorage.getItem(FIRST_TOAST_KEY) === '1',
        bannerDismissedAtCount: dismissedAt,
        bannerEvery: saving.bannerEveryNGenerations,
      })
    : 'none';

  useEffect(() => {
    if (nudge !== 'toast' || !saving.toastAfterFirstCreation || !activeProjectId) {
      return;
    }

    /*
     * The ref guards the double-fire that `localStorage` alone cannot: React can render twice before
     * the effect commits (StrictMode does exactly this in dev), and two identical toasts about losing
     * your work is a worse introduction to the idea than one.
     */
    if (toastShown.current) {
      return;
    }

    toastShown.current = true;
    localStorage.setItem(FIRST_TOAST_KEY, '1');

    toast.info(
      <div className="flex flex-col gap-2">
        <div>
          <strong>Nice — that is your game.</strong> Right now it only exists in this browser tab. Save it to your own
          GitHub account and you can open it from any device.
        </div>
        <button
          onClick={() => void requestSave(activeProjectId)}
          className="self-start px-3 py-1.5 text-xs rounded-md bg-accent-500 text-white"
        >
          Save it now
        </button>
      </div>,
      { autoClose: 12_000, closeOnClick: false },
    );
  }, [nudge, activeProjectId]);

  if (nudge !== 'banner' || !activeProjectId) {
    return null;
  }

  const dismiss = () => {
    localStorage.setItem(dismissKey(activeProjectId), String(count));
    setDismissedAt(count);
  };

  return (
    <div className="px-4 pt-3">
      <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
        <div className="i-ph:warning-circle shrink-0 text-lg" />
        <div className="flex-1">
          This project is only in this browser. If you clear your browsing data or switch devices, it is gone. Saving
          puts it in your own GitHub account, where it stays yours.
        </div>
        <button
          onClick={() => void requestSave(activeProjectId)}
          className="px-3 py-1.5 text-xs rounded-md bg-accent-500 text-white shrink-0"
        >
          Save
        </button>
        <button
          onClick={dismiss}
          className="i-ph:x text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary shrink-0"
          title="Not now"
          aria-label="Dismiss"
        />
      </div>
    </div>
  );
}

/**
 * The browser's own "you have unsaved changes" prompt.
 *
 * Only when work would genuinely be lost — `shouldWarnBeforeUnload` is strict about this, and the
 * reason is that this prompt cannot be styled, explained, or reworded. Firing it on a saved project
 * teaches the user to click straight through it, which disarms it for the one time it mattered.
 */
function UnloadWarning() {
  const unsaved = useStore(unsavedWork);
  const count = useStore(generationCount);

  /*
   * §4.5.4c: "unsaved" now means "not in your own repository", which is safe and common. Only work the
   * recovery copy never received would actually be lost — see `shouldWarnBeforeUnload`.
   */
  const recoverySafe = useStore(workingCopySafe);

  useEffect(() => {
    if (!shouldWarnBeforeUnload({ unsavedWork: unsaved, generationCount: count, recoverable: recoverySafe })) {
      return undefined;
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();

      // Legacy browsers key off the return value; modern ones show their own wording regardless.
      event.returnValue = '';

      return '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);

    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved, count]);

  return null;
}
