/**
 * Functions for managing chat data in IndexedDB
 */

import type { Message } from 'ai';
import type { IChatMetadata } from './db'; // Import IChatMetadata
import { filterOwnedRecords, localViewer } from './local-owner';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface Chat {
  id: string;
  description?: string;
  messages: Message[];
  timestamp: string;
  urlId?: string;
  metadata?: IChatMetadata;

  /** The account that wrote it — see `local-owner.ts`. Absent on records predating ownership. */
  ownerId?: string;
}

/**
 * Get the SIGNED-IN ACCOUNT's chats from the database.
 *
 * 🔴 The scoping is inside this function rather than at its call sites, deliberately. Every caller —
 * the Settings → Data tab's list, "Export all your chats to a JSON file", the bulk delete — means
 * "mine", and one that forgot to filter would quietly hand another account's whole conversation
 * history to a `.json` download on a shared computer. There is no caller that wants the unscoped
 * read, so the unscoped read is not offered; see `local-owner.ts` for why the browser's stores need
 * this at all.
 *
 * Consequences worth stating, both intended: an unresolved session gets NOTHING (the export button
 * reports "no chats available" for a moment on a cold load, rather than exporting someone else's),
 * and "delete all chats" clears only the caller's own.
 *
 * @param db The IndexedDB database instance
 * @returns A promise that resolves to an array of chats
 */
export async function getAllChats(db: IDBDatabase): Promise<Chat[]> {
  console.log(`getAllChats: Using database '${db.name}', version ${db.version}`);

  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(['chats'], 'readonly');
      const store = transaction.objectStore('chats');
      const request = store.getAll();

      request.onsuccess = () => {
        const result = filterOwnedRecords((request.result || []) as Chat[], localViewer());
        console.log(`getAllChats: Found ${result.length} chats in database '${db.name}'`);
        resolve(result);
      };

      request.onerror = () => {
        console.error(`getAllChats: Error querying database '${db.name}':`, request.error);
        reject(request.error);
      };
    } catch (err) {
      console.error(`getAllChats: Error creating transaction on database '${db.name}':`, err);
      reject(err);
    }
  });
}

/**
 * Get a chat by ID
 * @param db The IndexedDB database instance
 * @param id The ID of the chat to get
 * @returns A promise that resolves to the chat or null if not found
 */
export async function getChatById(db: IDBDatabase, id: string): Promise<Chat | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.get(id);

    request.onsuccess = () => {
      resolve(request.result || null);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Save a chat to the database
 * @param db The IndexedDB database instance
 * @param chat The chat to save
 * @returns A promise that resolves when the chat is saved
 */
export async function saveChat(db: IDBDatabase, chat: Chat): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.put(chat);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Delete a chat by ID
 * @param db The IndexedDB database instance
 * @param id The ID of the chat to delete
 * @returns A promise that resolves when the chat is deleted
 */
export async function deleteChat(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.delete(id);

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/**
 * Delete all chats
 * @param db The IndexedDB database instance
 * @returns A promise that resolves when all chats are deleted
 */
export async function deleteAllChats(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['chats'], 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.clear();

    request.onsuccess = () => {
      resolve();
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}
