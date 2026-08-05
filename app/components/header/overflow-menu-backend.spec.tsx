// @vitest-environment jsdom
/**
 * THE GAME BACKEND MOVED FROM THE COMPOSER ROW TO THE ⋯ MAIN MENU (owner, 2026-08-04).
 *
 * The green Supabase mark used to sit alone on the right of the composer row. Connecting a backend is
 * something a user goes LOOKING for, which is §4.1a's stated rule for what belongs behind the ⋯ — so
 * the trigger is hidden and the menu opens the same dialog.
 *
 * ## Why this file exists
 *
 * The move has two halves and BOTH fail silently, in ways nothing else in the suite would notice:
 *
 *   1. **The menu item opens nothing.** It reaches the dialog by dispatching the document event
 *      `SupabaseConnection` already listens for — the two components live in different trees (header
 *      vs `ChatBox`), and that component owns the dialog, the token state and the per-chat project
 *      persistence, so lifting its state would put a second writer on a connection the Settings tab
 *      also writes. An event has no type-checking and no import: rename it on either side and the menu
 *      row simply does nothing, forever, with no error anywhere.
 *   2. **`SupabaseConnection` gets deleted from `ChatBox` as "dead code".** Its button is now behind
 *      `{false && …}`, which makes the whole component look inert — but hiding the button is not
 *      hiding the component: the event listener, three per-chat `supabase-project-<chatId>` effects,
 *      the stats fetch and the API-key fetch all live there. Unmounting it leaves a menu item that
 *      opens nothing AND silently drops the project selection when the chat changes.
 *
 * The label is the fixed noun "Game Backend" in both states (owner, 2026-08-04) — it names what the
 * row opens rather than describing the press, and the dialog reports the connection itself. Both
 * states are still asserted, because a label that silently starts varying with the connection is the
 * regression that change reversed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { atom } from 'nanostores';
import { supabaseConnection } from '~/lib/stores/supabase';

/*
 * `~/lib/persistence` boots the sandbox as an import side effect, so it is stubbed rather than loaded
 * — the menu only reads the atom to decide whether it renders at all.
 *
 * ⚠️ The atom is created INSIDE the factory and read back through the mocked import below. `vi.mock`
 * is hoisted above every import, so a factory closing over a top-level binding (or over a `vi.hoisted`
 * value built from one) throws "cannot access before initialization" at collect time. The factory
 * itself is lazy, so `atom` is initialized by the time it runs.
 */
vi.mock('~/lib/persistence', () => ({ projectId: atom<string | undefined>(undefined) }));

vi.mock('~/components/chat/NewChatButton.client', () => ({ useStartNewChat: () => vi.fn() }));
vi.mock('~/components/chat/RemixProjectButton.client', () => ({
  useRemixProject: () => ({ remix: vi.fn(), busy: false }),
}));
vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: { downloadZip: vi.fn() } }));

import { projectId as projectIdStore } from '~/lib/persistence';
import { OverflowMenu } from './OverflowMenu.client';

const REPO = process.cwd();

/** Comment-stripped, so a rule QUOTED in prose can never be mistaken for the rule being in force. */
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const chatBox = strip(readFileSync(join(REPO, 'app/components/chat/ChatBox.tsx'), 'utf-8'));
const connection = strip(readFileSync(join(REPO, 'app/components/chat/SupabaseConnection.tsx'), 'utf-8'));

const DISCONNECTED = { user: null, token: '', stats: undefined, selectedProjectId: undefined, isConnected: false };

beforeEach(() => {
  projectIdStore.set('proj_1');
  supabaseConnection.set({ ...DISCONNECTED } as never);
});

afterEach(() => {
  cleanup();
  projectIdStore.set(undefined);
  supabaseConnection.set({ ...DISCONNECTED } as never);
  vi.clearAllMocks();
});

/**
 * Radix menus never open on a scripted `.click()` (§4.1a) — they open on `pointerdown`, and jsdom has
 * no real `PointerEvent`, so `fireEvent.pointerDown` reaches the trigger without the `button: 0` it
 * gates on and the menu stays shut. The keyboard path is the one that works headlessly and is a real
 * user path besides.
 */
function openMenu() {
  render(<OverflowMenu />);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Menu' }), { key: 'Enter' });
}

describe('the ⋯ menu is how you reach the Game Backend', () => {
  it('offers the connect row, and a select dispatches the event the dialog listens for', () => {
    const dispatched: string[] = [];
    const spy = vi.spyOn(document, 'dispatchEvent').mockImplementation((event: Event) => {
      dispatched.push(event.type);
      return true;
    });

    openMenu();
    fireEvent.click(screen.getByText('Game Backend'));

    expect(dispatched).toContain('open-supabase-connection');

    spy.mockRestore();
  });

  it('reads the same when connected — the label names the thing, not the action', () => {
    supabaseConnection.set({
      ...DISCONNECTED,
      user: { email: 'a@b.c', role: 'owner' },
      token: 't',
      isConnected: true,
      project: { id: 'p', name: 'Kart Leaderboards' },
    } as never);

    openMenu();

    expect(screen.getByText('Game Backend')).toBeTruthy();

    // The connection's own details belong to the dialog, never to a menu row that has to fit on one line.
    expect(screen.queryByText(/Kart Leaderboards/)).toBeNull();
    expect(screen.queryByText(/Connect/)).toBeNull();
  });

  /*
   * CONTROL. Every assertion above is satisfied by a menu that renders its rows unconditionally, which
   * would put a project-scoped action in front of a user with no project.
   */
  it('CONTROL — renders nothing at all without a project', () => {
    projectIdStore.set(undefined);
    render(<OverflowMenu />);

    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  });
});

describe('the component behind the menu row stays mounted', () => {
  it('SupabaseConnection is still rendered by ChatBox — hiding a button is not deleting a component', () => {
    expect(chatBox).toContain('<SupabaseConnection />');
  });

  it('and it still listens for the event the menu dispatches', () => {
    expect(connection).toContain("addEventListener('open-supabase-connection'");
  });

  it('still owns the per-chat project persistence that would vanish with it', () => {
    expect(connection).toContain('supabase-project-${currentChatId}');
  });

  /*
   * CONTROL for the two scans above: prove the stripper leaves ordinary source intact. Without it a
   * stripper that ate too much would report every rule satisfied by matching nothing — which reads
   * exactly like a clean bill of health.
   */
  it('CONTROL — the scanner can still see ordinary source in both files', () => {
    expect(chatBox).toContain('export const ChatBox');
    expect(connection).toContain('export function SupabaseConnection');
  });
});
