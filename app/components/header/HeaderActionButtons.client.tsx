import { useState } from 'react';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench';
import { DeployButton } from '~/components/deploy/DeployButton';
import { ShareButton } from '~/components/share/ShareButton';
import { GitHubSyncButton } from '~/components/github/GitHubSyncButton';
import { SaveStatus } from '~/components/persistence/SaveStatus.client';
import { NewChatButton } from '~/components/chat/NewChatButton.client';
import { brand } from '~/config/brand';

interface HeaderActionButtonsProps {
  chatStarted: boolean;
}

export function HeaderActionButtons({ chatStarted: _chatStarted }: HeaderActionButtonsProps) {
  const [activePreviewIndex] = useState(0);
  const previews = useStore(workbenchStore.previews);
  const activePreview = previews[activePreviewIndex];

  const shouldShowButtons = activePreview;

  /*
   * 🔴 ORDER IS LOAD-BEARING: CONDITIONAL BUTTONS FIRST, ALWAYS-PRESENT ONES LAST.
   *
   * This row is right-aligned (the header gives the chat title `flex-1` and pins this group against the
   * account menu), so it grows LEFTWARD. Anything that appears to the RIGHT of a button shoves that
   * button left.
   *
   * `Save` and `New chat` are the only two here that do not need a running preview, and the preview
   * takes seconds to boot. With them listed first, `New chat` rendered in the top-right corner on load
   * and then jumped 470px left the moment vite came up and Share/GitHub/Deploy/Debug appeared beside it
   * — measured: 16px from the right edge at t=0, 486px at t=4s. Reported as "the New chat button is very
   * inconsistent, sometimes it's in the top right corner and sometimes it's not".
   *
   * Listing the preview-gated group first means it expands leftward into empty space, and the two
   * always-present controls stay pinned to the right edge for the whole session. The general rule: in a
   * right-aligned toolbar, a conditional item placed right of an unconditional one MOVES it.
   */
  return (
    <div className="flex items-center gap-1">
      {/* Share the game as a public /play build (§4.8) */}
      {shouldShowButtons && <ShareButton />}

      {/* GitHub Sync — link/push/pull, available to ALL users (§4.13) */}
      {shouldShowButtons && <GitHubSyncButton />}

      {/* Deploy Button */}
      {shouldShowButtons && <DeployButton />}

      {/* Debug Tools */}
      {shouldShowButtons && (
        <div className="flex border border-bolt-elements-borderColor rounded-md overflow-hidden text-sm">
          <button
            onClick={() => window.open(`mailto:${brand.support.email}?subject=Bug%20report`, '_blank')}
            className="rounded-l-md items-center justify-center [&:is(:disabled,.disabled)]:cursor-not-allowed [&:is(:disabled,.disabled)]:opacity-60 px-3 py-1.5 text-xs bg-accent-500 text-white hover:text-bolt-elements-item-contentAccent [&:not(:disabled,.disabled)]:hover:bg-bolt-elements-button-primary-backgroundHover outline-accent-500 flex gap-1.5"
            title="Report Bug"
          >
            <div className="i-ph:bug" />
            <span>Report Bug</span>
          </button>
          <div className="w-px bg-bolt-elements-borderColor" />
          <button
            onClick={async () => {
              try {
                const { downloadDebugLog } = await import('~/utils/debugLogger');
                await downloadDebugLog();
              } catch (error) {
                console.error('Failed to download debug log:', error);
              }
            }}
            className="rounded-r-md items-center justify-center [&:is(:disabled,.disabled)]:cursor-not-allowed [&:is(:disabled,.disabled)]:opacity-60 px-3 py-1.5 text-xs bg-accent-500 text-white hover:text-bolt-elements-item-contentAccent [&:not(:disabled,.disabled)]:hover:bg-bolt-elements-button-primary-backgroundHover outline-accent-500 flex gap-1.5"
            title="Download Debug Log"
          >
            <div className="i-ph:download" />
            <span>Debug Log</span>
          </button>
        </div>
      )}

      {/*
       * Save + the saved/not-saved indicator (§4.5.4b).
       *
       * 🔴 Deliberately NOT behind `shouldShowButtons`. Everything above needs a running preview — you
       * cannot share or deploy a game that has not built. Saving is the opposite: a project that failed
       * to build is precisely the one whose code the user cannot afford to lose, and under repo-primary
       * persistence this button is the only thing standing between them and a closed tab. `SaveStatus`
       * renders nothing until there is a project, which is the correct gate.
       */}
      <SaveStatus />

      {/*
       * New chat, same game (§4.5.6).
       *
       * Also NOT behind `shouldShowButtons`, and for a related reason: a project whose preview is broken
       * is one of the likeliest times to want a clean context to debug from. It gates itself on there
       * being a project, which is the only precondition it actually has.
       *
       * Last, so it is pinned to the right edge — see the order note at the top of this component.
       */}
      <NewChatButton />
    </div>
  );
}
