import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';
import { CreditsIndicator } from '~/components/chat/CreditsIndicator.client';
import { AccountMenu } from '~/components/auth/AccountMenu.client';
import { useSession } from '~/lib/hooks/useSession';

export function Header() {
  const chat = useStore(chatStore);

  // Kicks off the single `/api/me` fetch for the page (balance, capabilities, and the signup grant).
  useSession();

  return (
    <header
      className={classNames('flex items-center px-4 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <div className="i-ph:sidebar-simple-duotone text-xl" />
        <a href="/" className="text-2xl font-semibold text-accent flex items-center">
          {/* sized by height: the wordmark is ~6.2:1, so a width-based size renders it tiny */}
          <img src="/logo-babylontoolkit.svg" alt="babylontoolkit" className="h-[32px] w-auto inline-block" />
        </a>
      </div>
      {chat.started ? ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="flex items-center gap-2">
                <CreditsIndicator />
                <HeaderActionButtons chatStarted={chat.started} />
                <AccountMenu />
              </div>
            )}
          </ClientOnly>
        </>
      ) : (
        <ClientOnly>
          {() => (
            <div className="flex items-center gap-2 ml-auto">
              <CreditsIndicator />
              <AccountMenu />
            </div>
          )}
        </ClientOnly>
      )}
    </header>
  );
}
