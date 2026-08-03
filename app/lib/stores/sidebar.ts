import { atom, computed } from 'nanostores';

/**
 * Whether the left sidebar is DOCKED (pinned open) vs. the default auto-slide behavior.
 *
 * The sidebar has two modes:
 *   - undocked (default): hidden, slides out when the pointer nears the left edge;
 *   - docked: stays open, and the edge-hover trigger is disabled.
 *
 * The header's sidebar icon toggles this. State is shared across components (header button ↔ the Menu
 * drawer) through this atom, and persisted so the choice survives a reload.
 *
 * ## 🔴 Docking is a PREFERENCE; the viewport is a CONSTRAINT (2026-08-02)
 *
 * Reported as *"the left sidebar is not responsive… it remains fixed and takes up all the room of
 * screen on smaller devices"*, and measured at a 500px viewport: the drawer sat at `left: 0`,
 * **340px wide — 68% of the screen** — over content that had not moved, because the dock offset
 * (`body.sidebar-docked { padding-left }`) is behind `@media (min-width: 1024px)` while the DRAWER
 * itself had no width guard at all. So below 1024px the two halves of docking disagreed: the column
 * was reserved nowhere and occupied anyway. Being docked also disables the edge-hover auto-close, so
 * it could not be dismissed either.
 *
 * The fix is `sidebarDockedEffective` — the stored preference AND a viewport that can host it. Two
 * properties, both load-bearing:
 *
 * 1. **The constraint is never written back into the preference.** A narrow viewport must not call
 *    `toggleSidebarDocked`, or resizing a window once — or opening the app on a phone — silently
 *    erases a choice the user made on their desktop and never restores it. The preference survives
 *    untouched; only its EFFECT is suppressed, so widening the window brings the dock straight back.
 * 2. **One source of truth for the breakpoint.** `SIDEBAR_DOCK_MIN_WIDTH` is the only place 1024
 *    appears. The CSS used to carry its own `@media (min-width: 1024px)` copy, which is precisely the
 *    "two numbers that must agree and nothing checks" shape this codebase keeps rediscovering — the
 *    class is now applied only when docking is EFFECTIVE, so the stylesheet needs no breakpoint of
 *    its own and the two cannot drift.
 */
export const kSidebarDocked = 'bolt_sidebar_docked';

/**
 * Narrowest viewport that can host a docked sidebar, in px.
 *
 * The dock costs `--sidebar-dock-width` (340px) of permanent horizontal room. Below this the builder
 * is a single column and that column is the product, so the sidebar becomes an overlay you summon.
 *
 * ⚠️ THE source of truth — `index.scss` deliberately has no copy of it. If this ever needs to be a
 * media query too, derive the stylesheet from it rather than typing 1024 a second time.
 */
export const SIDEBAR_DOCK_MIN_WIDTH = 1024;

export const sidebarDockedStore = atom<boolean>(initStore());

/**
 * Is the viewport wide enough to dock at all? Kept in sync with `matchMedia`.
 *
 * Defaults to `true` on the server and before the first measurement: SSR has no viewport, and
 * assuming NARROW would render the desktop-docked case unpinned for a frame on every load, which is
 * the layout jump docking exists to avoid. The listener corrects it on the client immediately.
 */
export const sidebarDockableStore = atom<boolean>(initDockable());

/**
 * What the UI must actually obey — the preference, gated by whether it fits.
 *
 * Every consumer reads THIS, never `sidebarDockedStore`: the raw preference is storage, and a
 * component that reads it directly is the bug above returning (a drawer pinned open on a phone).
 * The one legitimate reader of the raw value is the header toggle, which reports and flips the
 * user's choice.
 */
export const sidebarDockedEffective = computed(
  [sidebarDockedStore, sidebarDockableStore],
  (docked, dockable) => docked && dockable,
);

function initStore(): boolean {
  if (!import.meta.env.SSR) {
    return localStorage.getItem(kSidebarDocked) === 'true';
  }

  return false;
}

function initDockable(): boolean {
  if (import.meta.env.SSR || typeof window === 'undefined' || !window.matchMedia) {
    return true;
  }

  return window.matchMedia(`(min-width: ${SIDEBAR_DOCK_MIN_WIDTH}px)`).matches;
}

let viewportSyncStarted = false;

/**
 * Track viewport width so `sidebarDockedEffective` stays honest as the window resizes.
 *
 * Idempotent and never removed: the query lives as long as the tab, and one listener that outlives a
 * component is cheaper and less fragile than mount/unmount bookkeeping for a value the whole app
 * reads. Started from the Menu, which is the surface that owns the drawer.
 */
export function startSidebarViewportSync(): void {
  if (viewportSyncStarted || typeof window === 'undefined' || !window.matchMedia) {
    return;
  }

  viewportSyncStarted = true;

  const query = window.matchMedia(`(min-width: ${SIDEBAR_DOCK_MIN_WIDTH}px)`);
  const apply = () => sidebarDockableStore.set(query.matches);

  apply();

  // `addEventListener` is the modern form; Safari < 14 only has `addListener`.
  if (query.addEventListener) {
    query.addEventListener('change', apply);
  } else {
    (query as MediaQueryList).addListener(apply);
  }
}

/**
 * Is the drawer showing as an OVERLAY — summoned on a viewport too narrow to dock?
 *
 * Below the breakpoint the header's sidebar button cannot toggle docking (that would be a control
 * with no visible effect, the dead-end §4.1a forbids), so it opens and closes this instead. Lifted
 * out of the Menu's local state because two surfaces now drive it, per the standing rule that an
 * action more than one surface can trigger belongs in shared state rather than in a component.
 *
 * Never persisted: an overlay covering the screen is a transient answer to "show me my chats", and
 * restoring one on a cold load would greet a phone user with a full-screen drawer.
 */
export const sidebarOverlayOpen = atom<boolean>(false);

export function setSidebarOverlayOpen(open: boolean): void {
  sidebarOverlayOpen.set(open);
}

/**
 * The header's sidebar button.
 *
 * Its meaning follows the viewport, because the same gesture answers a different question in each:
 * wide enough to dock, it pins and unpins; too narrow, it summons and dismisses the overlay. What it
 * must never do is flip the stored preference on a narrow screen — see property 1 above.
 */
export function toggleSidebar(): void {
  if (!sidebarDockableStore.get()) {
    sidebarOverlayOpen.set(!sidebarOverlayOpen.get());
    return;
  }

  toggleSidebarDocked();
}

export function toggleSidebarDocked() {
  const next = !sidebarDockedStore.get();

  if (!import.meta.env.SSR) {
    /*
     * Opt into the docking transitions for THIS interaction. The CSS transitions are gated behind
     * `dock-animate` so they never fire on a fresh page load (where they'd desync and slide the logo
     * in) — only a deliberate toggle animates.
     */
    document.body.classList.add('dock-animate');
    localStorage.setItem(kSidebarDocked, String(next));
  }

  sidebarDockedStore.set(next);
}
