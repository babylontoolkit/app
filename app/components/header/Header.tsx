import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { sidebarDockedStore, toggleSidebarDocked } from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';
import { CreditsIndicator } from '~/components/chat/CreditsIndicator.client';
import { AccountMenu } from '~/components/auth/AccountMenu.client';
import { useDisplayIdentity } from '~/lib/hooks/useSession';

export function Header() {
  const chat = useStore(chatStore);
  const docked = useStore(sidebarDockedStore);

  /*
   * Who you are, and the single `/api/me` fetch for the page (balance, capabilities, the signup grant)
   * — `useDisplayIdentity` composes `useSession`, so this one call still kicks that off exactly once.
   */
  const identity = useDisplayIdentity();

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
       * which would drag this block away from the sidebar. A counter-translate of the dock width (CSS,
       * gated to the same ≥1024px where docking reserves space) slides it back over the sidebar — it has
       * `z-logo` (above the sidebar), so it reads as part of the sidebar. The transition matches the
       * body-padding animation, so it appears to stay put while the header slides.
       *
       * The WORDMARK used to live here and now sits in the sidebar's own footer (`Menu.client.tsx`).
       * The USER'S IDENTITY took its place (2026-08-02), moved out of the sidebar's top strip, and it
       * inherits this block's pinning for exactly the reason the wordmark needed it: docked or not,
       * visible sidebar or not, the name stays put over the sidebar column instead of sliding 340px
       * every time the panel opens.
       *
       * ⚠️ The gradient behind it belongs to the SIDEBAR's top strip, not to this block — see the
       * comment on that (now deliberately empty) strip. This is floated above it by `z-logo`.
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

        {/*
         * Who you are (§4.5.2) — from the SESSION, never the browser's local profile (`~/lib/identity`).
         *
         * `identity.name` is EMPTY while `/api/me` is in flight, deliberately: asserting a name we have
         * not been told and swapping it a moment later is the defect that module exists to remove. The
         * avatar well renders regardless, so the row does not reflow when the name arrives.
         *
         * ── SIZE KNOBS, all three on this block ──────────────────────────────────────────────────
         *   • NAME height  → `text-sm` on the <span> below (text-xs 12px · text-sm 14px · text-base
         *     16px · text-lg 18px). This is the one that reads as "how tall is the user name".
         *   • NAME width   → `max-w-[16ch]`, where it starts truncating with an ellipsis.
         *   • AVATAR size  → `w-[28px] h-[28px]` on the well, and `text-base` on the fallback icon
         *     inside it. Change the well and the icon together or the placeholder stops being centred
         *     in its circle.
         *
         * ⚠️ The header row is a fixed `h-[var(--header-height)]`, so growing either past roughly the
         * avatar's 28px does not make the bar taller — it just crowds it, and on a narrow window it is
         * the CHAT TITLE beside it that gives way first.
         */}
        <div className="flex items-center gap-2 ml-1">
          <span className="font-medium text-md truncate max-w-[16ch]">{identity.name}</span>
          &nbsp;
          <div className="flex items-center justify-center w-[28px] h-[28px] overflow-hidden bg-white/10 rounded-full shrink-0">
            {identity.avatar ? (
              <img
                src={identity.avatar}
                alt={identity.name || 'User'}
                className="w-full h-full object-cover"
                loading="eager"
                decoding="sync"
              />
            ) : (
              <div className="i-ph:user-fill text-base" />
            )}
          </div>
        </div>
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
