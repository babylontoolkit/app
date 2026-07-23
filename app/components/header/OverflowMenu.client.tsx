/**
 * The header's MAIN MENU — the home for general options, now and as they accumulate (SPEC §4.5.6, §5A).
 *
 * ## Why this exists
 *
 * Every general-purpose action used to be its own top-level button. `Report Bug` and `Debug Log` were
 * accent-filled pills sitting between Deploy and the git controls; `New chat` was pinned to the far
 * right. None of them is wrong to have — they are wrong to have *at the same visual weight as shipping
 * your game*, and a toolbar where everything is primary has no primary.
 *
 * This is where general options live from now on. The rule for what belongs here: **real, but not on
 * the path you walk every session.** Anything needed mid-flow (share, sync, media, the workbench) stays
 * visible; anything a user goes LOOKING for belongs behind the ⋯. New options go here by default — the
 * row is the exception, not the destination.
 *
 * ## The menu is GROUPS, not a list — add to a group, never to the bottom
 *
 * Separators here are structure, not decoration. Each group answers a different question, so a reader
 * scanning the menu can skip two-thirds of it:
 *
 *   1. **Session** — what am I doing with this conversation? (`New chat`)
 *   2. **Take it with you** — how do I get my game out of the platform? (`Export as ZIP`)
 *   3. **Help & diagnostics** — something is wrong, or I want to tell you about it.
 *
 * A menu that grows by appending becomes an undifferentiated list of a dozen items, which is the same
 * failure the toolbar itself just came back from: enough individually-reasonable additions and the
 * whole reads as noise. **A new item joins the group it belongs to**; if it belongs to none, that is
 * the signal to add a fourth group with its own separator — not to drop it at the end.
 *
 * Likely future groups, so the shape is obvious rather than guessed: **Project** (settings, rename,
 * duplicate, delete), **Connections** (Unity bridge, game backend, MCP), **View** (theme, layout).
 *
 * Export ZIP is in group 2 because it had no header home at all despite being, under repo-primary
 * persistence, one of the few ways to get your game out of the browser — and it is available to ALL
 * users, never Pro-gated (§4.6.1: Pro gates exactly one thing, BYOK).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { toast } from 'react-toastify';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench';
import { projectId as projectIdStore } from '~/lib/persistence';
import { useStartNewChat } from '~/components/chat/NewChatButton.client';
import { classNames } from '~/utils/classNames';
import { brand } from '~/config/brand';
import { TOOLBAR_ICON_BUTTON_FILLED, TOOLBAR_MENU_CONTENT, TOOLBAR_MENU_ITEM } from './toolbar-button';

/** One definition, so the group boundaries stay identical as groups are added. */
const SEPARATOR = 'h-px bg-bolt-elements-borderColor my-1';

export function OverflowMenu() {
  const activeProjectId = useStore(projectIdStore);
  const startNewChat = useStartNewChat();

  if (!activeProjectId) {
    return null;
  }

  const exportZip = async () => {
    try {
      await workbenchStore.downloadZip();
    } catch (error) {
      // Never fails silently: the user asked for their files and has to know if they did not get them.
      toast.error(`Could not export your project: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const downloadDebugLog = async () => {
    try {
      const { downloadDebugLog: download } = await import('~/utils/debugLogger');
      await download();
    } catch (error) {
      toast.error(`Could not download the debug log: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {/*
         * Filled in the ACCENT, by owner request — the main menu reads as a persistent affordance
         * rather than a bare icon, and fill is reserved for it and the git chip alone (§4.1a). One
         * complete constant, never `classNames(TOOLBAR_ICON_BUTTON, …)`: the base style's quiet hover
         * is emitted later in the stylesheet and would strip the fill on hover.
         */}
        <button type="button" title="Menu" aria-label="Menu" className={TOOLBAR_ICON_BUTTON_FILLED}>
          <div className="i-ph:dots-three-bold text-sm" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={classNames(TOOLBAR_MENU_CONTENT, 'min-w-[220px]')}>
          {/* ── 1. Session ─────────────────────────────────────────────────────────── */}
          <DropdownMenu.Group>
            <DropdownMenu.Item className={TOOLBAR_MENU_ITEM} onSelect={startNewChat}>
              <div className="i-ph:chat-teardrop-dots" />
              <span>New chat</span>
            </DropdownMenu.Item>
          </DropdownMenu.Group>

          <DropdownMenu.Separator className={SEPARATOR} />

          {/* ── 2. Take it with you ────────────────────────────────────────────────── */}
          <DropdownMenu.Group>
            <DropdownMenu.Item className={TOOLBAR_MENU_ITEM} onSelect={() => void exportZip()}>
              <div className="i-ph:file-zip" />
              <span>Export as ZIP</span>
            </DropdownMenu.Item>
          </DropdownMenu.Group>

          <DropdownMenu.Separator className={SEPARATOR} />

          {/* ── 3. Help & diagnostics ──────────────────────────────────────────────── */}
          <DropdownMenu.Group>
            <DropdownMenu.Item
              className={TOOLBAR_MENU_ITEM}
              onSelect={() => window.open(`mailto:${brand.support.email}?subject=Bug%20report`, '_blank')}
            >
              <div className="i-ph:bug" />
              <span>Report a bug</span>
            </DropdownMenu.Item>

            <DropdownMenu.Item className={TOOLBAR_MENU_ITEM} onSelect={() => void downloadDebugLog()}>
              <div className="i-ph:download-simple" />
              <span>Download debug log</span>
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
