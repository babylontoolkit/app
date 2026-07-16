import { atom } from 'nanostores';

/**
 * Whether the left sidebar is DOCKED (pinned open) vs. the default auto-slide behavior.
 *
 * The sidebar has two modes:
 *   - undocked (default): hidden, slides out when the pointer nears the left edge;
 *   - docked: stays open, and the edge-hover trigger is disabled.
 *
 * The header's sidebar icon toggles this. State is shared across components (header button ↔ the Menu
 * drawer) through this atom, and persisted so the choice survives a reload.
 */
export const kSidebarDocked = 'bolt_sidebar_docked';

export const sidebarDockedStore = atom<boolean>(initStore());

function initStore(): boolean {
  if (!import.meta.env.SSR) {
    return localStorage.getItem(kSidebarDocked) === 'true';
  }

  return false;
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
