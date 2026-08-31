import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { sidebarDockableStore, sidebarDockedEffective, sidebarOverlayOpen, toggleSidebar } from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ProjectTitle } from './ProjectTitle.client';
import { CreditsIndicator } from '~/components/chat/CreditsIndicator.client';
import { AccountMenu } from '~/components/auth/AccountMenu.client';

/*
 * The ONE sign-in dialog (§4.5.1). Mounted here because the header is present on every route a gate
 * can be raised from, and because a dialog owned by the creation path would unmount the instant that
 * path navigated — taking the form away while the user was typing in it.
 */
import { AuthGate } from '~/components/auth/AuthGate.client';
import { useSession } from '~/lib/hooks/useSession';
import { brand } from '~/config/brand';

export function Header() {
  const chat = useStore(chatStore);

  /*
   * The EFFECTIVE dock plus the overlay, never the raw preference — the button reports what is on
   * screen, and below `SIDEBAR_DOCK_MIN_WIDTH` a stored `docked: true` shows nothing.
   */
  const docked = useStore(sidebarDockedEffective);
  const dockable = useStore(sidebarDockableStore);
  const overlayOpen = useStore(sidebarOverlayOpen);

  const sidebarShowing = dockable ? docked : overlayOpen;
  const sidebarButtonLabel = dockable
    ? docked
      ? 'Undock sidebar'
      : 'Dock sidebar'
    : overlayOpen
      ? 'Hide sidebar'
      : 'Show sidebar';

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
  /*
   * The bar carries the WORKSPACE tone; the brand plaque beside it paints `--chrome-gradient` (the
   * darker sidebar tone), so the top bar reads as two sections — brand on the left, project on the
   * right. The boundary is the plaque's pinned right edge, so unlike the ray glow this replaces, it
   * does not move.
   *
   * ⚠️ `backgroundAttachment: 'fixed'` is required, not cosmetic. Docking changes this element's left
   * edge (0 → `--sidebar-dock-width`), so a percentage-based horizontal ramp painted into its own box
   * would rescale and slide on every toggle. Fixed attachment paints it against the viewport, so the
   * colour under any given pixel is the same docked or not.
   */
  return (
    <header
      data-theme="dark"
      style={{ background: 'var(--chrome-gradient-workspace)', backgroundAttachment: 'fixed' }}
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
      <div
        className={classNames('header-brand flex items-center gap-2 z-logo text-bolt-elements-textPrimary', {
          /*
           * Continues the header's bottom rule across the plaque (0→340), so the top bar's bottom
           * edge is ONE line rather than a rule on the right and a bare colour step on the left.
           * Driven by the SAME `chat.started` as the header's own `border-b` two lines below — if
           * these two ever disagree the seam comes back, mirrored.
           */
          'header-brand-divided': chat.started,
        })}
      >
        {/*
         * The sidebar button. Its MEANING follows the viewport (`~/lib/stores/sidebar`).
         *
         * Wide enough to dock, it pins and unpins. Too narrow, docking is suppressed entirely — so
         * flipping the preference there would move nothing on screen, and a control that visibly does
         * nothing is the dead end §4.1a forbids. It opens and closes the overlay instead, which is
         * also the ONLY way to reach the sidebar on a touch device: the edge-slide is driven by
         * `mousemove`, which a finger never fires.
         *
         * `aria-pressed` follows whatever it currently controls, so the state it reports is the state
         * the user can see.
         */}
        <button
          type="button"
          onClick={toggleSidebar}
          className={classNames(
            'i-ph:sidebar-simple-duotone text-xl transition-colors hover:text-accent',
            sidebarShowing ? 'text-accent' : '',
          )}
          title={sidebarButtonLabel}
          aria-label={sidebarButtonLabel}
          aria-pressed={sidebarShowing}
        />

        {/*
         * The BRAND LOCKUP: the mark, a hairline rule, and the product name (2026-08-02).
         *
         * One link, not two — the mark and the name are one brand object, and splitting them gives a
         * pointer two targets for one destination and a screen reader two announcements of one thing.
         * Hence `aria-label` on the anchor with both children hidden from the a11y tree: the `<img>`
         * would otherwise read its `alt` and the text would read again right after it.
         *
         * ⚠️ The name is `brand.productTitle`, never a literal — the CI brand gate (§2.5 rule 4) fails
         * the build on a hardcoded product name outside `brand.ts`, and the final name is still an
         * open question.
         *
         * `productTitle` is the DISPLAY string for this lockup, deliberately distinct from
         * `productName` (browser title, receipts, prose) — the two are ALLOWED to disagree, which is
         * the whole reason the field exists. So the accessible name takes the same one the eye reads,
         * not the other: an `aria-label` of "App Builder" over text reading "3D APP BUILDER" fails
         * label-in-name (WCAG 2.5.3) and breaks voice control, where the user speaks the words they
         * can see. One element, one name.
         *
         * `text-transform: uppercase` stays in the CSS even though this value already is: the caps
         * are a property of the TREATMENT, so the lockup keeps its shape if the string is ever
         * re-cased in `brand.ts`.
         */}
        <a
          href="/"
          className="flex items-center ml-1 cursor-pointer"
          title={brand.productTitle}
          aria-label={brand.productTitle}
        >
          {/*
           * ── LOGO SIZE LIVES HERE: the `h-7` below ─────────────────────────────────────────────
           * Sized by HEIGHT, never width — the artwork is ~3.5:1, so a width-based size renders it
           * tiny. `h-7` is 28px against the 54px header. The lettering is `fill="#ffffff"` chrome
           * art, legible only on a dark band — which the header itself guarantees, since the brand
           * rides it (see the block comment above).
           */}
          <img src={brand.assets.mark} alt="" className="h-7 w-auto inline-block" />

          {/*
           * Rule + name. Both are `aria-hidden` (the anchor's label already says it) and both live in
           * `index.scss` rather than in utility classes: the name is a gradient-clipped fill with a
           * solid fallback, which is a @supports block, not a class list.
           */}
          <span className="header-lockup-rule" aria-hidden="true" />
          <span className="header-lockup-name" aria-hidden="true">
            {brand.productTitle}
          </span>
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
          {/*
           * The chat title — PINNED to the viewport (`index.scss` `.header-chat-title`), like the
           * brand and for the same reason: docking must not slide it. It is left-aligned and lands on
           * the same vertical line as the chat column's content beneath it.
           *
           * Being `position: fixed` it contributes NO width to the header's flow, so the `flex-1`
           * below is what still pushes the action cluster to the right edge. Remove that and the
           * buttons collapse leftward into the middle of the bar.
           */}
          <span className="header-chat-title truncate text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ProjectTitle />}</ClientOnly>
          </span>
          <div className="flex-1" aria-hidden="true" />
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

      {/*
       * 🔴 OUTSIDE the `chat.started` conditional, and that placement is the point.
       *
       * Both arms above render an action cluster, so a gate mounted in either one unmounts the moment
       * the flag flips — which is exactly what starting a project does. The dialog would vanish from
       * under a visitor part-way through typing their password, on the single flow it exists to serve.
       * It renders a `position: fixed` overlay and contributes no width, so it is inert here.
       */}
      <ClientOnly>{() => <AuthGate />}</ClientOnly>
    </header>
  );
}
