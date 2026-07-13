/**
 * The active game registry, fetched rather than imported (SPEC §4.4).
 *
 * Going through `/api/registry` means Stage 3's move to a Supabase table changes the store and
 * nothing else — no client code knows where the rows come from.
 */
import { useEffect, useState } from 'react';
import type { GameRegistryEntry } from '~/types/game-registry';

export function useGameRegistry(): { entries: GameRegistryEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<GameRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/registry')
      .then((response) =>
        response.ok ? (response.json() as Promise<{ entries?: GameRegistryEntry[] }>) : { entries: [] },
      )
      .then((data) => {
        if (!cancelled) {
          setEntries(data.entries ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { entries, loading };
}
