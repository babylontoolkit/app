import { useState, useMemo, useCallback } from 'react';
import { debounce } from '~/utils/debounce';
import type { ChatHistoryItem } from '~/lib/persistence';

interface UseSearchFilterOptions<T extends ChatHistoryItem> {
  items: T[];
  searchFields?: (keyof ChatHistoryItem)[];
  debounceMs?: number;
}

/**
 * Generic over the item so a caller can pass a RICHER row and get the same row back.
 *
 * The sidebar's list is `SidebarChat` (a chat plus which game it belongs to, §4.5.6), and a hook
 * hard-typed to `ChatHistoryItem` silently widened it back on the way out.
 */
export function useSearchFilter<T extends ChatHistoryItem>({
  items = [] as unknown as T[],
  searchFields = ['description'],
  debounceMs = 300,
}: UseSearchFilterOptions<T>) {
  const [searchQuery, setSearchQuery] = useState('');

  const debouncedSetSearch = useCallback(debounce(setSearchQuery, debounceMs), []);

  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      debouncedSetSearch(event.target.value);
    },
    [debouncedSetSearch],
  );

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) {
      return items;
    }

    const query = searchQuery.toLowerCase();

    return items.filter((item) =>
      searchFields.some((field) => {
        const value = item[field];

        if (typeof value === 'string') {
          return value.toLowerCase().includes(query);
        }

        return false;
      }),
    );
  }, [items, searchQuery, searchFields]);

  return {
    searchQuery,
    filteredItems,
    handleSearchChange,
  };
}
