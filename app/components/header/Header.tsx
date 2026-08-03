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
import { brand } from '~/config/brand';

export function Header() {
  const chat = useStore(chatStore);
  const docked = useStore(sidebarDockedStore);

  /*
   * The single `/api/me` fetch for the page (balance, capabilities, the signup grant). The identity
   * this used to render moved into the sidebar's top strip (2026-08-02, `SidebarIdentity`), but the
   * kick-off stays HERE: the header is on every page, the sidebar is not, and `useSession` is
   * once-per-page-load however many components call it.
   */
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
       * `header-brand`: the dock toggle + the wordmark, `position: fixed` at the viewport's top-left
       * (`index.scss`). It does not move for docking, undocking, or the hover slide-out — not because
       * two animations are kept in step, but because it is not in the flow that moves. `z-logo` keeps
       * it above the drawer, so the sidebar's gradient strip slides in UNDERNEATH it and the two read
       * as one continuous top bar. Read the rule block before changing any of this.
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

        <a href="/" className="flex items-center ml-1 cursor-pointer" title={brand.productName}>
          {/*
           * ── LOGO SIZE LIVES HERE: the `h-8` below ──────────────────────────────────────────────
           * Sized by HEIGHT, never width — the artwork is ~3.5:1, so a width-based size renders it
           * tiny. `h-8` is 32px against the 54px header. The lettering is `fill="#ffffff"` chrome
           * art, legible only on a dark band — which the header itself guarantees, since the brand
           * rides it (see the block comment above).
           */}
          <img src={brand.assets.mark} alt={brand.productName} className="h-8 w-auto inline-block" />
        </a>
      </div>

      {/*
       * Holds the fixed brand's footprint open in the header's flow (`--header-brand-width`), so the
       * chat title and the credits pill start exactly where they did when the brand was in flow.
       * Without it they slide left under the logo.
       */}
      <div className="header-brand-spacer" aria-hidden="true" />
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
