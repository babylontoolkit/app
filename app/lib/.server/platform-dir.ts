/**
 * Where locally-persisted platform data lives.
 *
 * A LEAF module on purpose — it imports nothing. It used to live in `prompt/store.ts`, which was fine
 * while nothing in the storage layer needed it; the moment the prompt store began persisting through
 * `ObjectStore` (so that a version survives a container being replaced, see `prompt/store.ts`), that
 * placement became a cycle: `storage/index` → `prompt/store` → `storage/index`.
 *
 * `prompt/store.ts` re-exports it, so the ~19 modules that already import it from there keep working.
 * New code should import it from here.
 */
import path from 'node:path';

/** Root for all locally-persisted platform data. Overridable so tests never touch the real store. */
export function platformDataDir(): string {
  return process.env.PLATFORM_DATA_DIR || path.join(process.cwd(), '.data');
}
