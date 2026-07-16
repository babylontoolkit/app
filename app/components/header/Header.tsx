import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { sidebarDockedStore, toggleSidebarDocked } from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';
import { CreditsIndicator } from '~/components/chat/CreditsIndicator.client';
import { AccountMenu } from '~/components/auth/AccountMenu.client';
import { useSession } from '~/lib/hooks/useSession';

export function Header() {
  const chat = useStore(chatStore);
  const docked = useStore(sidebarDockedStore);

  // Kicks off the single `/api/me` fetch for the page (balance, capabilities, and the signup grant).
  useSession();

  /*
   * The top bar is ALWAYS dark purple chrome (matches the always-dark sidebar), independent of the app
   * theme. `data-theme="dark"` re-scopes the `--bolt-elements-*` tokens so the title/credits/menu text
   * stays light and legible on the gradient, and the white wordmark reads in light mode too.
   */
  return (
    <header
      data-theme="dark"
      style={{ background: 'var(--chrome-gradient)' }}
      className={classNames(
        'flex items-center px-4 border-b h-[var(--header-height)] shrink-0 text-bolt-elements-textPrimary',
        {
          'border-transparent': !chat.started,
          'border-bolt-elements-borderColor': chat.started,
        },
      )}
    >
      {/*
       * `header-brand`: when the sidebar docks, the whole header is pushed right by the reserved column,
       * which would drag the wordmark away from the sidebar. A counter-translate of the dock width (CSS,
       * gated to the same ≥1024px where docking reserves space) slides the logo back over the sidebar —
       * it has `z-logo` (above the sidebar), so it reads as the sidebar's own brand. The transition
       * matches the body-padding animation, so the logo appears to stay put while the header slides.
       */}
      <div className="header-brand flex items-center gap-2 z-logo text-bolt-elements-textPrimary">
        {/* Dock / undock the left sidebar. Undocked, it auto-slides on edge hover; docked, it stays pinned. */}
        <button
          type="button"
          onClick={toggleSidebarDocked}
          className={classNames(
            'i-ph:sidebar-simple-duotone text-xl transition-colors hover:text-accent',
            docked ? 'text-accent' : '',
          )}
          title={docked ? 'Undock sidebar' : 'Dock sidebar'}
          aria-label={docked ? 'Undock sidebar' : 'Dock sidebar'}
          aria-pressed={docked}
        />
        <a href="/" className="text-2xl font-semibold text-accent flex items-center cursor-pointer">
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
