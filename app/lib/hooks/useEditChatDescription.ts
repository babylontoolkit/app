import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  chatId as chatIdStore,
  db,
  description as descriptionStore,
  getMessages,
  updateChatDescription,
} from '~/lib/persistence';
import { renameServerChat } from '~/lib/persistence/projects';

interface EditChatDescriptionOptions {
  initialDescription?: string;
  customChatId?: string;
  syncWithGlobalStore?: boolean;

  /**
   * Where this chat lives on the SERVER (§4.5.6). When present, a rename is written there FIRST —
   * the sidebar is the server's chat list, so a rename that only touched IndexedDB was overwritten
   * on the next refresh (the server title wins in `mergeChatList`) and never reached other devices.
   * Absent for a local-only chat (never saved), where IndexedDB really is the whole truth.
   */
  serverTarget?: { projectId: string; serverChatId: string };

  /** Called after a successful rename — the sidebar uses it to re-fetch the list it renders. */
  onRenamed?: () => void;
}

type EditChatDescriptionHook = {
  editing: boolean;
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleBlur: () => Promise<void>;
  handleSubmit: (event: React.FormEvent) => Promise<void>;
  handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => Promise<void>;
  currentDescription: string;
  toggleEditMode: () => void;
};

/**
 * Hook to manage the state and behavior for editing chat descriptions.
 *
 * Offers functions to:
 * - Switch between edit and view modes.
 * - Manage input changes, blur, and form submission events.
 * - Save updates to IndexedDB and optionally to the global application state.
 *
 * @param {Object} options
 * @param {string} options.initialDescription - The current chat description.
 * @param {string} options.customChatId - Optional ID for updating the description via the sidebar.
 * @param {boolean} options.syncWithGlobalStore - Flag to indicate global description store synchronization.
 * @returns {EditChatDescriptionHook} Methods and state for managing description edits.
 */
export function useEditChatDescription({
  initialDescription = descriptionStore.get()!,
  customChatId,
  syncWithGlobalStore,
  serverTarget,
  onRenamed,
}: EditChatDescriptionOptions): EditChatDescriptionHook {
  const chatIdFromStore = useStore(chatIdStore);
  const [editing, setEditing] = useState(false);
  const [currentDescription, setCurrentDescription] = useState(initialDescription);

  const [chatId, setChatId] = useState<string>();

  useEffect(() => {
    setChatId(customChatId || chatIdFromStore);
  }, [customChatId, chatIdFromStore]);
  useEffect(() => {
    setCurrentDescription(initialDescription);
  }, [initialDescription]);

  const toggleEditMode = useCallback(() => setEditing((prev) => !prev), []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentDescription(e.target.value);
  }, []);

  const fetchLatestDescription = useCallback(async () => {
    if (!db || !chatId) {
      return initialDescription;
    }

    try {
      const chat = await getMessages(db, chatId);
      return chat?.description || initialDescription;
    } catch (error) {
      console.error('Failed to fetch latest description:', error);
      return initialDescription;
    }
  }, [db, chatId, initialDescription]);

  const handleBlur = useCallback(async () => {
    const latestDescription = await fetchLatestDescription();
    setCurrentDescription(latestDescription);
    toggleEditMode();
  }, [fetchLatestDescription, toggleEditMode]);

  const isValidDescription = useCallback((desc: string): boolean => {
    const trimmedDesc = desc.trim();

    if (trimmedDesc === initialDescription) {
      toggleEditMode();
      return false; // No change, skip validation
    }

    const lengthValid = trimmedDesc.length > 0 && trimmedDesc.length <= 100;

    // Allow letters, numbers, spaces, and common punctuation but exclude characters that could cause issues
    const characterValid = /^[a-zA-Z0-9\s\-_.,!?()[\]{}'"]+$/.test(trimmedDesc);

    if (!lengthValid) {
      toast.error('Description must be between 1 and 100 characters.');
      return false;
    }

    if (!characterValid) {
      toast.error('Description can only contain letters, numbers, spaces, and basic punctuation.');
      return false;
    }

    return true;
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      if (!isValidDescription(currentDescription)) {
        return;
      }

      try {
        /*
         * A chat with no server home is local-only, and the old requirements stand: without
         * IndexedDB there is nowhere at all to write the rename.
         */
        if (!serverTarget) {
          if (!db) {
            toast.error('Chat persistence is not available');
            return;
          }

          if (!chatId) {
            toast.error('Chat Id is not available');
            return;
          }
        }

        const title = currentDescription.trim();

        // The server FIRST — it is the copy the sidebar renders and every other device sees.
        if (serverTarget) {
          await renameServerChat(serverTarget.projectId, serverTarget.serverChatId, title);
        }

        /*
         * The local mirror, best-effort once the server has the truth: a chat from another device
         * has no IndexedDB record here, and that must not fail a rename the server accepted.
         */
        if (db && chatId) {
          try {
            await updateChatDescription(db, chatId, title);
          } catch (error) {
            if (!serverTarget) {
              throw error;
            }
          }
        }

        if (syncWithGlobalStore) {
          descriptionStore.set(title);
        }

        toast.success('Chat renamed');
        onRenamed?.();
      } catch (error) {
        toast.error('Failed to rename chat: ' + (error as Error).message);
      }

      toggleEditMode();
    },
    [currentDescription, db, chatId, initialDescription, customChatId, serverTarget, onRenamed, syncWithGlobalStore],
  );

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        await handleBlur();
      }
    },
    [handleBlur],
  );

  return {
    editing,
    handleChange,
    handleBlur,
    handleSubmit,
    handleKeyDown,
    currentDescription,
    toggleEditMode,
  };
}
