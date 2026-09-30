/**
 * The local-scene explainer (D27): when the running game fails to load something from the user's own
 * machine, say WHY in plain words — once per cause per session — instead of leaving a blank scene.
 *
 * Fed by `previewErrorsStore`, which the injected preview agent fills with `resource`/`network` entries
 * for loopback URLs only (see `agent-script.ts`). The store is a capped ring REPLACED on every push, so
 * "new" is tracked by key, never by index.
 */
import { atom } from 'nanostores';
import { previewErrorsStore } from '~/lib/preview/bridge';
import type { PreviewErrorEntry } from '~/lib/preview/protocol';
import { checkDevServer, type DevServerState } from './devserver';

export type ExplainerCause = 'not-running' | 'blocked' | 'old-exporter';

export const localSceneExplainerStore = atom<{ cause: ExplainerCause; origin: string } | null>(null);

/** Entries already handled, keyed `${at}|${url}`. Module-level: survives the ring being replaced. */
const seen = new Set<string>();

/** Causes already shown this session. */
const shown = new Set<ExplainerCause>();

type Checker = (origin: string) => Promise<DevServerState>;

async function handle(entry: PreviewErrorEntry, check: Checker): Promise<void> {
  let origin: string;

  try {
    origin = new URL(entry.url as string).origin;
  } catch {
    return;
  }

  let state: DevServerState;

  try {
    state = await check(origin);
  } catch {
    return;
  }

  if (state === 'running' || shown.has(state)) {
    return;
  }

  shown.add(state);
  localSceneExplainerStore.set({ cause: state, origin });
}

/** Start watching preview errors. Returns the unsubscribe function. */
export function startLocalSceneExplainer(deps?: { check?: Checker }): () => void {
  const check: Checker = deps?.check ?? ((origin) => checkDevServer(origin));

  return previewErrorsStore.subscribe((entries) => {
    for (const entry of entries) {
      const key = `${entry.at}|${entry.url}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      if ((entry.type !== 'resource' && entry.type !== 'network') || !entry.url) {
        continue;
      }

      void handle(entry, check);
    }
  });
}

export function resetLocalSceneExplainerForTests(): void {
  seen.clear();
  shown.clear();
  localSceneExplainerStore.set(null);
}
