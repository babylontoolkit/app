/**
 * The Share dialog (SPEC §4.8).
 *
 * The user-facing half of publishing: name the game, optionally submit it to the gallery, hit Share.
 * Behind the button, `useShareGame` builds the project in the WebContainer and posts `dist/` to the
 * publish route, which runs the checklist. This dialog's real job is rendering the THREE non-trivial
 * outcomes the checklist produces:
 *
 * - **blocked** — a secret was found. A refusal, shown in red, with the offending files. No "publish
 *   anyway"; the only way forward is to remove the secret (§4.8: a secret is never a warning).
 * - **needs-acknowledgement** — debug overlays or similar. Shown once as a warning with a "Publish
 *   anyway" button, because it is the user's game and they may ship a rough one.
 * - **published** — the share URL, with copy + open, and an Unpublish that takes it back down.
 *
 * Uses the shared `~/components/ui/Dialog` primitive rather than the deploy family's hand-rolled Radix,
 * because this is a simple form, not a multi-step wizard.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import { Dialog, DialogRoot, DialogTitle, DialogDescription, DialogButton } from '~/components/ui/Dialog';
import { useShareGame, type ShareOutcome } from './useShareGame';
import type { ChecklistFinding } from '~/types/share';

interface ShareDialogProps {
  isOpen: boolean;
  onClose: () => void;

  /** Pre-filled from the project name. */
  defaultTitle?: string;

  /** If the project is already shared, its id — so the dialog opens on the "live" state. */
  existingShareId?: string;
}

/** Absolute play URL. `PLAY_URL` is server config; the client builds a same-origin URL as the default. */
function playUrl(shareId: string): string {
  if (typeof window === 'undefined') {
    return `/play/${shareId}`;
  }

  return `${window.location.origin}/play/${shareId}`;
}

export function ShareDialog({ isOpen, onClose, defaultTitle, existingShareId }: ShareDialogProps) {
  const { isPublishing, publish, unpublish } = useShareGame();
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [description, setDescription] = useState('');
  const [submitToGallery, setSubmitToGallery] = useState(false);
  const [shareId, setShareId] = useState<string | undefined>(existingShareId);
  const [findings, setFindings] = useState<ChecklistFinding[]>([]);
  const [awaitingAck, setAwaitingAck] = useState(false);

  /**
   * Set when the game published but its source could not be stored, so nobody can remix it (§4.8).
   *
   * Only ever known from a publish we just performed — the server does not report it on an already-live
   * game, so re-opening the dialog shows nothing rather than a stale or invented claim.
   */
  const [remixBlockedReason, setRemixBlockedReason] = useState<string | undefined>();

  const handleOutcome = (outcome: ShareOutcome) => {
    if (outcome.status === 'published') {
      setShareId(outcome.shareId);
      setFindings([]);
      setAwaitingAck(false);
      setRemixBlockedReason(outcome.remixBlockedReason);

      // The publish DID succeed — celebrating it is right. The remix caveat is shown in the dialog below.
      toast.success('Your game is live! 🎉');
    } else if (outcome.status === 'blocked') {
      setFindings(outcome.findings);
      setAwaitingAck(false);
    } else if (outcome.status === 'needs-acknowledgement') {
      setFindings(outcome.findings);
      setAwaitingAck(true);
    } else {
      toast.error(outcome.message);
    }
  };

  const doPublish = async (acknowledgeWarnings = false) => {
    handleOutcome(await publish({ title, description, submitToGallery, acknowledgeWarnings }));
  };

  const doUnpublish = async () => {
    if (await unpublish()) {
      setShareId(undefined);
      setRemixBlockedReason(undefined);
      toast.success('Your game is no longer shared.');
    } else {
      toast.error('Could not unpublish. Please try again.');
    }
  };

  const copyLink = () => {
    if (shareId) {
      navigator.clipboard.writeText(playUrl(shareId)).then(() => toast.success('Link copied.'));
    }
  };

  const blocking = findings.filter((f) => f.level === 'blocking');
  const warnings = findings.filter((f) => f.level === 'warning');

  return (
    <DialogRoot open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog className="!max-w-lg !w-[90vw]" onClose={onClose}>
        <div className="p-6 flex flex-col gap-4">
          <div>
            <DialogTitle>{shareId ? 'Your game is shared' : 'Share your game'}</DialogTitle>
            <DialogDescription>
              {shareId
                ? remixBlockedReason
                  ? 'Anyone with the link can play it.'
                  : 'Anyone with the link can play it. Sharing it lets others remix it too.'
                : 'We build your game and host it at a public link. Nobody can see your project — only the finished game.'}
            </DialogDescription>
          </div>

          {shareId ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 rounded-lg border border-bolt-elements-borderColor px-3 py-2 bg-bolt-elements-background-depth-2">
                <span className="text-sm text-bolt-elements-textPrimary truncate flex-1">{playUrl(shareId)}</span>
                <button
                  className="i-ph:copy text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                  onClick={copyLink}
                  title="Copy link"
                />
                <a
                  className="i-ph:arrow-square-out text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                  href={playUrl(shareId)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open"
                />
              </div>
              {remixBlockedReason && (
                <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3 flex flex-col gap-1">
                  <span className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                    This game can't be remixed
                  </span>
                  <span className="text-xs text-bolt-elements-textSecondary">{remixBlockedReason}</span>
                </div>
              )}

              <div className="flex justify-between items-center">
                <DialogButton type="danger" onClick={doUnpublish} disabled={isPublishing}>
                  Unpublish
                </DialogButton>
                <DialogButton type="primary" onClick={() => doPublish(true)} disabled={isPublishing}>
                  {isPublishing ? 'Re-publishing…' : 'Update with latest changes'}
                </DialogButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm text-bolt-elements-textSecondary">
                Title
                <input
                  className="px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="My awesome game"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-bolt-elements-textSecondary">
                Description (optional)
                <input
                  className="px-3 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A short blurb for the play page"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-bolt-elements-textSecondary">
                <input
                  type="checkbox"
                  checked={submitToGallery}
                  onChange={(e) => setSubmitToGallery(e.target.checked)}
                />
                Submit to the public gallery (a moderator reviews it first)
              </label>

              {blocking.length > 0 && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 flex flex-col gap-1">
                  <span className="text-sm font-medium text-red-500">This game can't be shared yet:</span>
                  {blocking.map((f) => (
                    <span key={f.code + f.path} className="text-xs text-red-400">
                      {f.message}
                    </span>
                  ))}
                </div>
              )}

              {awaitingAck && warnings.length > 0 && (
                <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3 flex flex-col gap-1">
                  <span className="text-sm font-medium text-yellow-600 dark:text-yellow-400">Before you share:</span>
                  {warnings.map((f) => (
                    <span key={f.code + f.path} className="text-xs text-yellow-600 dark:text-yellow-400">
                      {f.message}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2 mt-1">
                <DialogButton type="secondary" onClick={onClose}>
                  Cancel
                </DialogButton>
                {awaitingAck ? (
                  <DialogButton type="primary" onClick={() => doPublish(true)} disabled={isPublishing}>
                    {isPublishing ? 'Publishing…' : 'Publish anyway'}
                  </DialogButton>
                ) : (
                  <DialogButton type="primary" onClick={() => doPublish(false)} disabled={isPublishing}>
                    {isPublishing ? 'Building & publishing…' : 'Share'}
                  </DialogButton>
                )}
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </DialogRoot>
  );
}
