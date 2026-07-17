import { motion, type Variants } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { Dialog, DialogButton, DialogDescription, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import { ThemeSwitch } from '~/components/ui/ThemeSwitch';
import { ControlPanel } from '~/components/@settings/core/ControlPanel';
import { SettingsButton, HelpButton } from '~/components/ui/SettingsButton';
import { Button } from '~/components/ui/Button';
import { db, deleteById, getAll, chatId, type ChatHistoryItem, useChatHistory } from '~/lib/persistence';
import { deleteChat as deleteServerChat, listAllChats } from '~/lib/persistence/projects';
import { mergeChatList, localChatList, type SidebarChat } from '~/lib/persistence/chat-list';
import { createScopedLogger } from '~/utils/logger';
import { cubicEasingFn } from '~/utils/easings';
import { HistoryItem } from './HistoryItem';
import { binDates } from './date-binning';
import { useSearchFilter } from '~/lib/hooks/useSearchFilter';
import { classNames } from '~/utils/classNames';
import { useStore } from '@nanostores/react';
import { profileStore } from '~/lib/stores/profile';
import { sidebarDockedStore } from '~/lib/stores/sidebar';
import { brand } from '~/config/brand';

const logger = createScopedLogger('sidebar');

const menuVariants = {
  closed: {
    opacity: 0,
    visibility: 'hidden',
    left: '-340px',
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
  open: {
    opacity: 1,
    visibility: 'initial',
    left: 0,
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
} satisfies Variants;

type DialogContent = { type: 'delete'; item: SidebarChat } | { type: 'bulkDelete'; items: SidebarChat[] } | null;

function CurrentDateTime() {
  const [dateTime, setDateTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setDateTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800/50">
      <div className="h-4 w-4 i-ph:clock opacity-80" />
      <div className="flex gap-2">
        <span>{dateTime.toLocaleDateString()}</span>
        <span>{dateTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  );
}

export const Menu = () => {
  const { duplicateCurrentChat, exportChat } = useChatHistory();
  const menuRef = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<SidebarChat[]>([]);
  const [open, setOpen] = useState(false);
  const [dialogContent, setDialogContent] = useState<DialogContent>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const profile = useStore(profileStore);
  const docked = useStore(sidebarDockedStore);

  // Docked pins the drawer open; otherwise it follows the edge-hover `open` state.
  const isOpen = open || docked;
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);

  const { filteredItems: filteredList, handleSearchChange } = useSearchFilter({
    items: list,
    searchFields: ['description'],
  });

  /**
   * The sidebar's chats — from the SERVER, merged with this browser's (§4.5.6, §4.5.4b).
   *
   * This used to be `getAll(db)` filtered by `urlId && description`: a view of the BROWSER rather than
   * of the account. A chat started on a laptop did not exist on a desktop and clearing site data
   * destroyed the list, while the transcripts sat on the server the whole time with nothing listing
   * them. The browser is a local staging area now; the platform holds the project record and the
   * conversation; the user's CODE lives in their own repo.
   *
   * 🔴 A failed fetch falls back to the LOCAL list, never to an empty one. `mergeChatList` drops a local
   * chat whose server chat has gone (that is how a delete on another device sticks here) — which is
   * only safe while "the server said nothing" and "the server said none" stay distinguishable. Treating
   * a network error as an authoritative empty list would blank the sidebar and, on the next merge, look
   * exactly like every chat having been deleted.
   */
  const loadEntries = useCallback(() => {
    if (!db) {
      return;
    }

    const local = getAll(db).catch(() => [] as ChatHistoryItem[]);

    listAllChats()
      .then(async (server) => mergeChatList(server, await local))
      .catch(async (error) => {
        logger.warn(`Could not load chats from the server, showing this browser's: ${error.message}`);

        // `localChatList`, NOT `mergeChatList([], …)` — the latter would drop every synced chat. See it.
        return localChatList(await local);
      })
      .then(setList)
      .catch((error) => toast.error(error.message));
  }, []);

  /**
   * Delete one conversation — locally AND on the server (§4.5.6).
   *
   * 🔴 **The server half was missing, and the result was worse than a leak.** This deleted the
   * IndexedDB record and stopped, so `messages/{projectId}/…` survived — and since `restoreTranscript`
   * pulls the server's copy when a project is opened, the chat the user deleted CAME BACK on the next
   * open. The delete did not delete it; it hid it until the next mount.
   *
   * It was upstream's code, and upstream had no server: there the chat WAS the project, and IndexedDB
   * was the only place it lived. We added a server copy underneath and never revisited this.
   *
   * The project is deliberately untouched. Under §4.5.6 a project holds many chats, so removing one is
   * removing one — the game, its files, and its other conversations all survive. Deleting the PROJECT
   * is the dashboard's job, and it sweeps every chat with it.
   *
   * 🔴 It takes the ITEM, not an id. The ids that address the server copy used to be read back out of
   * IndexedDB (`getMessages(db, id).metadata`), which worked only while every listed chat was a local
   * one. Now that the sidebar lists the ACCOUNT's chats (§4.5.6), a chat from another device has no
   * local record — so the lookup would find no metadata, the server delete would be skipped silently,
   * and the chat would reappear on the next load. The row already carries its own ids; use them.
   */
  const deleteChat = useCallback(
    async (item: SidebarChat): Promise<void> => {
      if (!db) {
        throw new Error('Database not available');
      }

      const { projectId, serverChatId } = item.metadata ?? {};

      /*
       * Server first. Delete locally first and a failure here strands the transcript with nothing left
       * that can name it — the orphan shape §4.5.4b keeps producing. If the server delete throws, the
       * whole action fails and the chat stays in the sidebar, which is honest: the user can see it, and
       * can try again.
       */
      if (projectId && serverChatId) {
        await deleteServerChat(projectId, serverChatId);
      }

      /*
       * Upstream's per-chat localStorage snapshot. Dead in our fork (§4.12 checkpoints are IndexedDB),
       * but old browsers still carry the keys, so keep reaping them.
       */
      try {
        localStorage.removeItem(`snapshot:${item.id}`);
      } catch (snapshotError) {
        console.error(`Error deleting snapshot for chat ${item.id}:`, snapshotError);
      }

      // Absent-is-fine: a chat from another device has no local record to remove.
      if (item.local) {
        await deleteById(db, item.id);
      }

      console.log('Successfully deleted chat:', item.id);
    },
    [db],
  );

  const deleteItem = useCallback(
    (event: React.UIEvent, item: SidebarChat) => {
      event.preventDefault();
      event.stopPropagation();

      // Log the delete operation to help debugging
      console.log('Attempting to delete chat:', { id: item.id, description: item.description });

      deleteChat(item)
        .then(() => {
          toast.success('Chat deleted successfully', {
            position: 'bottom-right',
            autoClose: 3000,
          });

          // Always refresh the list
          loadEntries();

          if (chatId.get() === item.id) {
            // hard page navigation to clear the stores
            console.log('Navigating away from deleted chat');
            window.location.pathname = '/';
          }
        })
        .catch((error) => {
          console.error('Failed to delete chat:', error);
          toast.error('Failed to delete conversation', {
            position: 'bottom-right',
            autoClose: 3000,
          });

          // Still try to reload entries in case data has changed
          loadEntries();
        });
    },
    [loadEntries, deleteChat],
  );

  const deleteSelectedItems = useCallback(
    async (itemsToDelete: SidebarChat[]) => {
      if (!db || itemsToDelete.length === 0) {
        console.log('Bulk delete skipped: No DB or no items to delete.');
        return;
      }

      console.log(`Starting bulk delete for ${itemsToDelete.length} chats`);

      let deletedCount = 0;
      const errors: string[] = [];
      const currentChatId = chatId.get();
      let shouldNavigate = false;

      // Process deletions sequentially using the shared deleteChat logic
      for (const item of itemsToDelete) {
        try {
          await deleteChat(item);
          deletedCount++;

          if (item.id === currentChatId) {
            shouldNavigate = true;
          }
        } catch (error) {
          console.error(`Error deleting chat ${item.id}:`, error);
          errors.push(item.id);
        }
      }

      // Show appropriate toast message
      if (errors.length === 0) {
        toast.success(`${deletedCount} chat${deletedCount === 1 ? '' : 's'} deleted successfully`);
      } else {
        toast.warning(`Deleted ${deletedCount} of ${itemsToDelete.length} chats. ${errors.length} failed.`, {
          autoClose: 5000,
        });
      }

      // Reload the list after all deletions
      await loadEntries();

      // Clear selection state
      setSelectedItems([]);
      setSelectionMode(false);

      // Navigate if needed
      if (shouldNavigate) {
        console.log('Navigating away from deleted chat');
        window.location.pathname = '/';
      }
    },
    [deleteChat, loadEntries, db],
  );

  const closeDialog = () => {
    setDialogContent(null);
  };

  const toggleSelectionMode = () => {
    setSelectionMode(!selectionMode);

    if (selectionMode) {
      // If turning selection mode OFF, clear selection
      setSelectedItems([]);
    }
  };

  const toggleItemSelection = useCallback((id: string) => {
    setSelectedItems((prev) => {
      const newSelectedItems = prev.includes(id) ? prev.filter((itemId) => itemId !== id) : [...prev, id];
      console.log('Selected items updated:', newSelectedItems);

      return newSelectedItems; // Return the new array
    });
  }, []); // No dependencies needed

  const handleBulkDeleteClick = useCallback(() => {
    if (selectedItems.length === 0) {
      toast.info('Select at least one chat to delete');
      return;
    }

    const selectedChats = list.filter((item) => selectedItems.includes(item.id));

    if (selectedChats.length === 0) {
      toast.error('Could not find selected chats');
      return;
    }

    setDialogContent({ type: 'bulkDelete', items: selectedChats });
  }, [selectedItems, list]); // Keep list dependency

  const selectAll = useCallback(() => {
    const allFilteredIds = filteredList.map((item) => item.id);
    setSelectedItems((prev) => {
      const allFilteredAreSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => prev.includes(id));

      if (allFilteredAreSelected) {
        // Deselect only the filtered items
        const newSelectedItems = prev.filter((id) => !allFilteredIds.includes(id));
        console.log('Deselecting all filtered items. New selection:', newSelectedItems);

        return newSelectedItems;
      } else {
        // Select all filtered items, adding them to any existing selections
        const newSelectedItems = [...new Set([...prev, ...allFilteredIds])];
        console.log('Selecting all filtered items. New selection:', newSelectedItems);

        return newSelectedItems;
      }
    });
  }, [filteredList]); // Depends only on filteredList

  useEffect(() => {
    if (isOpen) {
      loadEntries();
    }
  }, [isOpen, loadEntries]);

  /*
   * Reserve a column on <body> while docked so page content reflows beside the sidebar instead of
   * being overlapped. Only runs where the Menu is mounted, and cleans up on unmount / undock.
   */
  useEffect(() => {
    if (docked) {
      document.body.classList.add('sidebar-docked');
    } else {
      document.body.classList.remove('sidebar-docked');
    }

    return () => document.body.classList.remove('sidebar-docked');
  }, [docked]);

  // Exit selection mode when sidebar is closed
  useEffect(() => {
    if (!open && selectionMode) {
      /*
       * Don't clear selection state anymore when sidebar closes
       * This allows the selection to persist when reopening the sidebar
       */
      console.log('Sidebar closed, preserving selection state');
    }
  }, [open, selectionMode]);

  useEffect(() => {
    // When docked, the sidebar is pinned open — the edge-hover auto-slide is disabled entirely.
    if (docked) {
      return undefined;
    }

    const enterThreshold = 20;
    const exitThreshold = 20;

    function onMouseMove(event: MouseEvent) {
      if (isSettingsOpen) {
        return;
      }

      if (event.pageX < enterThreshold) {
        setOpen(true);
      }

      if (menuRef.current && event.clientX > menuRef.current.getBoundingClientRect().right + exitThreshold) {
        setOpen(false);
      }
    }

    window.addEventListener('mousemove', onMouseMove);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, [isSettingsOpen, docked]);

  const handleDuplicate = async (id: string) => {
    await duplicateCurrentChat(id);
    loadEntries(); // Reload the list after duplication
  };

  const handleSettingsClick = () => {
    setIsSettingsOpen(true);
    setOpen(false);
  };

  const handleSettingsClose = () => {
    setIsSettingsOpen(false);
  };

  const setDialogContentWithLogging = useCallback((content: DialogContent) => {
    console.log('Setting dialog content:', content);
    setDialogContent(content);
  }, []);

  return (
    <>
      {/*
       * The sidebar is ALWAYS dark chrome, regardless of the app's light/dark theme. `data-theme="dark"`
       * on a display:contents wrapper re-scopes both the `dark:` variants and the `--bolt-elements-*`
       * tokens for its subtree (variables.scss), without a layout box that would disturb the fixed
       * drawer. The settings ControlPanel below stays OUTSIDE this wrapper so it follows the app theme.
       */}
      <div className="contents" data-theme="dark">
        {/*
         * `initial={isOpen...}`: mount already in the current open/closed state so a docked sidebar does
         * NOT replay its slide-in on every route change (each view mounts its own Menu). Only genuine
         * open/close transitions animate; navigating while docked is seamless.
         */}
        <motion.div
          ref={menuRef}
          initial={isOpen ? 'open' : 'closed'}
          animate={isOpen ? 'open' : 'closed'}
          variants={menuVariants}
          style={{ width: 'var(--sidebar-dock-width, 340px)' }}
          className={classNames(
            'flex selection-accent flex-col side-menu fixed top-0 h-full',
            'bg-white dark:bg-gray-950 border-r border-bolt-elements-borderColor text-sm',

            // Docked reads as an attached column (square edge, no float); undocked floats as a drawer.
            docked ? '' : 'rounded-r-2xl shadow-sm',
            isSettingsOpen ? 'z-40' : 'z-sidebar',
          )}
        >
          <div
            style={{ background: 'var(--chrome-gradient)' }}
            className={classNames(
              'h-[var(--header-height)] flex items-center justify-between px-4 border-b border-gray-100 dark:border-gray-800/50',
              docked ? '' : 'rounded-tr-2xl',
            )}
          >
            <div className="text-gray-900 dark:text-white font-medium"></div>
            <div className="flex items-center gap-3">
              <HelpButton onClick={() => window.open(brand.urls.docs, '_blank')} />
              <span className="font-medium text-sm text-gray-900 dark:text-white truncate">
                {profile?.username || 'Guest User'}
              </span>
              <div className="flex items-center justify-center w-[32px] h-[32px] overflow-hidden bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-500 rounded-full shrink-0">
                {profile?.avatar ? (
                  <img
                    src={profile.avatar}
                    alt={profile?.username || 'User'}
                    className="w-full h-full object-cover"
                    loading="eager"
                    decoding="sync"
                  />
                ) : (
                  <div className="i-ph:user-fill text-lg" />
                )}
              </div>
            </div>
          </div>
          <CurrentDateTime />
          <div className="flex-1 flex flex-col h-full w-full overflow-hidden">
            <div className="p-4 space-y-3">
              {/* The whole project library (server-backed, cross-device) — the chat UI below is local chats only (§4.1). */}
              <a
                href="/dashboard"
                className="flex gap-2 items-center bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg px-4 py-2 transition-colors border border-gray-200 dark:border-gray-700"
              >
                <span className="inline-block i-ph:squares-four h-4 w-4" />
                <span className="text-sm font-medium">Dashboard</span>
              </a>
              <div className="relative w-full">
                <div className="absolute left-3 top-1/2 -translate-y-1/2">
                  <span className="i-ph:magnifying-glass h-4 w-4 text-gray-400 dark:text-gray-500" />
                </div>
                <input
                  className="w-full bg-gray-50 dark:bg-gray-900 relative pl-9 pr-3 py-2 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500/50 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-500 border border-gray-200 dark:border-gray-800"
                  type="search"
                  placeholder="Search chats..."
                  onChange={handleSearchChange}
                  aria-label="Search chats"
                />
              </div>
              <div className="flex gap-2">
                <a
                  href="/"
                  className="flex-1 flex gap-2 items-center bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-500/20 rounded-lg px-4 py-2 transition-colors"
                >
                  <span className="inline-block i-ph:plus-circle h-4 w-4" />
                  <span className="text-sm font-medium">Start new chat</span>
                </a>
                <button
                  onClick={toggleSelectionMode}
                  className={classNames(
                    'flex gap-1 items-center rounded-lg px-3 py-2 transition-colors',
                    selectionMode
                      ? 'bg-purple-600 dark:bg-purple-500 text-white border border-purple-700 dark:border-purple-600'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700',
                  )}
                  aria-label={selectionMode ? 'Exit selection mode' : 'Enter selection mode'}
                >
                  <span className={selectionMode ? 'i-ph:x h-4 w-4' : 'i-ph:check-square h-4 w-4'} />
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between text-sm px-4 py-2">
              <div className="font-medium text-gray-600 dark:text-gray-400">Your Chats</div>
              {selectionMode && (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={selectAll}>
                    {selectedItems.length === filteredList.length ? 'Deselect all' : 'Select all'}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleBulkDeleteClick}
                    disabled={selectedItems.length === 0}
                  >
                    Delete selected
                  </Button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-auto px-3 pb-3">
              {filteredList.length === 0 && (
                <div className="px-4 text-gray-500 dark:text-gray-400 text-sm">
                  {list.length === 0 ? 'No previous conversations' : 'No matches found'}
                </div>
              )}
              <DialogRoot open={dialogContent !== null}>
                {binDates(filteredList).map(({ category, items }) => (
                  <div key={category} className="mt-2 first:mt-0 space-y-1">
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400 sticky top-0 z-1 bg-white dark:bg-gray-950 px-4 py-1">
                      {category}
                    </div>
                    <div className="space-y-0.5 pr-1">
                      {items.map((item) => (
                        <HistoryItem
                          key={item.id}
                          item={item}
                          exportChat={exportChat}
                          onDelete={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            console.log('Delete triggered for item:', item);
                            setDialogContentWithLogging({ type: 'delete', item });
                          }}
                          onDuplicate={() => handleDuplicate(item.id)}
                          selectionMode={selectionMode}
                          isSelected={selectedItems.includes(item.id)}
                          onToggleSelection={toggleItemSelection}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <Dialog onBackdrop={closeDialog} onClose={closeDialog}>
                  {dialogContent?.type === 'delete' && (
                    <>
                      <div className="p-6 bg-white dark:bg-gray-950">
                        <DialogTitle className="text-gray-900 dark:text-white">Delete Chat?</DialogTitle>
                        <DialogDescription className="mt-2 text-gray-600 dark:text-gray-400">
                          <p>
                            You are about to delete{' '}
                            <span className="font-medium text-gray-900 dark:text-white">
                              {dialogContent.item.description}
                            </span>
                          </p>
                          <p className="mt-2">Are you sure you want to delete this chat?</p>
                        </DialogDescription>
                      </div>
                      <div className="flex justify-end gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
                        <DialogButton type="secondary" onClick={closeDialog}>
                          Cancel
                        </DialogButton>
                        <DialogButton
                          type="danger"
                          onClick={(event) => {
                            console.log('Dialog delete button clicked for item:', dialogContent.item);
                            deleteItem(event, dialogContent.item);
                            closeDialog();
                          }}
                        >
                          Delete
                        </DialogButton>
                      </div>
                    </>
                  )}
                  {dialogContent?.type === 'bulkDelete' && (
                    <>
                      <div className="p-6 bg-white dark:bg-gray-950">
                        <DialogTitle className="text-gray-900 dark:text-white">Delete Selected Chats?</DialogTitle>
                        <DialogDescription className="mt-2 text-gray-600 dark:text-gray-400">
                          <p>
                            You are about to delete {dialogContent.items.length}{' '}
                            {dialogContent.items.length === 1 ? 'chat' : 'chats'}:
                          </p>
                          <div className="mt-2 max-h-32 overflow-auto border border-gray-100 dark:border-gray-800 rounded-md bg-gray-50 dark:bg-gray-900 p-2">
                            <ul className="list-disc pl-5 space-y-1">
                              {dialogContent.items.map((item) => (
                                <li key={item.id} className="text-sm">
                                  <span className="font-medium text-gray-900 dark:text-white">{item.description}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <p className="mt-3">Are you sure you want to delete these chats?</p>
                        </DialogDescription>
                      </div>
                      <div className="flex justify-end gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
                        <DialogButton type="secondary" onClick={closeDialog}>
                          Cancel
                        </DialogButton>
                        <DialogButton
                          type="danger"
                          onClick={() => {
                            /*
                             * Pass the current selectedItems to the delete function.
                             * This captures the state at the moment the user confirms.
                             */
                            const itemsToDeleteNow = list.filter((chat) => selectedItems.includes(chat.id));
                            console.log(
                              'Bulk delete confirmed for',
                              itemsToDeleteNow.length,
                              'items',
                              itemsToDeleteNow,
                            );
                            deleteSelectedItems(itemsToDeleteNow);
                            closeDialog();
                          }}
                        >
                          Delete
                        </DialogButton>
                      </div>
                    </>
                  )}
                </Dialog>
              </DialogRoot>
            </div>
            <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-800 px-4 py-3">
              <div className="flex items-center gap-3">
                <SettingsButton onClick={handleSettingsClick} />
              </div>
              <ThemeSwitch />
            </div>
          </div>
        </motion.div>
      </div>

      <ControlPanel open={isSettingsOpen} onClose={handleSettingsClose} />
    </>
  );
};
