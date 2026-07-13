/**
 * Active prompt-version accessor (spec/doc-sync.md, "Runtime").
 *
 * The agent proxy reads the active version once per request, so it is cached in memory with a short
 * TTL and invalidated explicitly on activation. Generation has ZERO network dependency on GitHub —
 * this reads only from our own store.
 */
import { getPromptStore, type PromptVersion } from './store';

const TTL_MS = 30_000;

let cached: { version: PromptVersion | null; at: number } | undefined;

export async function getActivePrompt(): Promise<PromptVersion | null> {
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.version;
  }

  const version = await getPromptStore().getActive();
  cached = { version, at: Date.now() };

  return version;
}

/** Called on activate/rollback so the next generation picks the new version up immediately. */
export function invalidateActivePrompt(): void {
  cached = undefined;
}
