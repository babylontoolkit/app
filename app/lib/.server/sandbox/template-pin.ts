/**
 * The CodeSandbox template pin (plan T14, SPEC §4.4 applied to the runtime).
 *
 * §4.4's pin-and-promote exists because a push to the starter repo used to reach every new project
 * with no review step. Forking `btk@starter` re-opens exactly that hole one level down: an ALIAS is a
 * mutable pointer, so whoever last ran `csb build --alias` decides what every new project boots from,
 * and nothing here reviews it or can undo it.
 *
 * This is `templates/pin.ts` for the VM — the same rules, with one real difference:
 *
 * 🔴 **CodeSandbox holds the bytes; we hold only the POINTER HISTORY.** `templates/pin.ts` can promise
 * that a rollback target's bytes are unchanged because it stored them. We cannot. A rollback here
 * re-points at a template id that CodeSandbox still owns — recorded, auditable, and one click, but not
 * byte-immutable. Anything written here that implies otherwise would be a false claim about somebody
 * else's storage.
 *
 * The rest holds: validate BEFORE re-pointing (a promotion that breaks every new project is the exact
 * failure the pin exists to prevent, delivered by the mechanism meant to prevent it); roll back only
 * onto a target already in the history; and a corrupt or unreadable pin is a MISSING pin, never an
 * outage.
 */
import type { ObjectStore } from '~/lib/.server/storage';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('sandbox-template-pin');

/** One object, not a prefix: the pin and its history are read together on every fork decision. */
export const SANDBOX_TEMPLATE_PIN_KEY = 'sandbox/template-pin.json';

export interface SandboxTemplatePin {
  /** The CodeSandbox template id or alias new projects fork. */
  target: string;

  promotedAt: string;

  /** How it got here. Never a secret, and it is what makes the history auditable rather than a list. */
  promotedBy: 'promote' | 'rollback';

  /** Free text from the promoting admin — what this build is, why it was promoted. */
  provenance?: string;
}

export interface SandboxTemplatePinFile {
  current: SandboxTemplatePin | null;

  /** Append-only, oldest first. Every target ever promoted — the rollback menu. */
  history: SandboxTemplatePin[];
}

const EMPTY: SandboxTemplatePinFile = { current: null, history: [] };

/**
 * How many history entries are kept.
 *
 * Bounded because this is one JSON object read on a hot-ish path, and because a rollback menu nobody
 * can read is not a menu. Old entries falling off is safe in a way it would NOT be for
 * `templates/pin.ts`: there, dropping an entry could orphan stored bytes; here the target still
 * exists at CodeSandbox and an operator can always promote it again by name.
 */
export const MAX_PIN_HISTORY = 20;

export type SandboxTemplateSource = 'pin' | 'env' | 'default';

export interface SandboxTemplateDecision {
  template: string;
  source: SandboxTemplateSource;
}

export interface SandboxTemplateInput {
  /** The promoted pin, or null when nothing has been promoted (or the pin could not be read). */
  pin: SandboxTemplatePin | null;

  /** `CODESANDBOX_TEMPLATE`, if the operator set one. */
  envTemplate?: string;

  /** The baked default (`btk@starter`). Always a valid answer — this function never returns nothing. */
  baked: string;
}

/**
 * Which template does a new project fork?
 *
 * PURE and exhaustively tested, for the same reason `decideTemplateSource` is: it decides which BYTES
 * land in a user's brand-new project, and every way it can be wrong is silent — nobody sees "we forked
 * last month's starter", they see a project that behaves oddly and blame the agent.
 *
 * Precedence is **promoted pin > `CODESANDBOX_TEMPLATE` > baked default**, and the order is the point:
 * the pin is the reviewed decision, the env var is the escape hatch for template development, and the
 * baked default means a fresh deploy with no configuration at all still forks the blessed starter
 * rather than CodeSandbox's generic universal template (which would boot, install nothing, and produce
 * a project that is not a Babylon Toolkit project at all).
 *
 * ⚠️ A pin whose TARGET no longer exists at CodeSandbox is not detectable here and is deliberately not
 * guessed at: the fork simply fails, loudly, through `createSandboxForProject` and the T13 rate window.
 * Silently falling through to the env default on a missing target would be the unreviewed jump to
 * whatever-is-live that this whole mechanism exists to prevent — and it would do it at the exact moment
 * an operator was relying on the pin.
 */
export function decideSandboxTemplate(input: SandboxTemplateInput): SandboxTemplateDecision {
  const pinned = input.pin?.target?.trim();

  if (pinned) {
    return { template: pinned, source: 'pin' };
  }

  const fromEnv = input.envTemplate?.trim();

  if (fromEnv) {
    return { template: fromEnv, source: 'env' };
  }

  return { template: input.baked, source: 'default' };
}

/** Add a promotion to the history and make it current. Pure — the IO half is `writeSandboxTemplatePin`. */
export function applyPromotion(file: SandboxTemplatePinFile, pin: SandboxTemplatePin): SandboxTemplatePinFile {
  /*
   * De-duplicated by target so promoting the same alias twice does not fill the menu with one name.
   * The NEW entry wins — it carries the later timestamp and provenance, which is what an operator
   * reading the history wants to see.
   */
  const history = [...file.history.filter((entry) => entry.target !== pin.target), pin];

  return { current: pin, history: history.slice(-MAX_PIN_HISTORY) };
}

export async function readSandboxTemplatePin(store: ObjectStore): Promise<SandboxTemplatePinFile> {
  const bytes = await store.get(SANDBOX_TEMPLATE_PIN_KEY);

  if (!bytes) {
    return EMPTY;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SandboxTemplatePinFile>;

    return {
      // A corrupt pin is a MISSING pin, not an outage: every project would otherwise fail to open.
      current: parsed?.current?.target ? parsed.current : null,
      history: Array.isArray(parsed?.history) ? parsed.history.filter((entry) => Boolean(entry?.target)) : [],
    };
  } catch {
    logger.warn('Sandbox template pin is unreadable — falling back to the configured template.');
    return EMPTY;
  }
}

export async function writeSandboxTemplatePin(store: ObjectStore, file: SandboxTemplatePinFile): Promise<void> {
  await store.put(
    SANDBOX_TEMPLATE_PIN_KEY,
    new TextEncoder().encode(JSON.stringify(file, null, 2)),
    'application/json',
  );
}

/*
 * ---------------------------------------------------------------------------------------------
 * The sync/async seam
 * ---------------------------------------------------------------------------------------------
 *
 * `sandboxTemplate()` is called synchronously from `service.ts` while building a fork request, and
 * the pin lives in object storage. This is the same shape as the market price list
 * (`activeMarketPrices()` / `ensureMarketPrices()`) and it is solved the same way, deliberately: an
 * in-process cache, refreshed at the async doorways, with a failed load serving the previous answer
 * rather than blocking anything. Nobody should invent a second pattern for this.
 */

let cached: SandboxTemplatePinFile = EMPTY;
let loadedAt = 0;

/** How long a loaded pin is trusted before the next doorway re-reads it. */
export const PIN_CACHE_TTL_MS = 60_000;

/** The pin as of the last successful load. Sync, never throws, `null` until something loads one. */
export function activeSandboxTemplatePin(): SandboxTemplatePin | null {
  return cached.current;
}

/**
 * Refresh the cache. Call at async doorways (the session route, the admin route) — never on a path
 * that cannot afford a storage read.
 *
 * A failed load keeps the previous answer and is logged: falling back to "no pin" on a transient
 * storage blip would silently return every new project to the env default, which is precisely the
 * unreviewed template the pin was promoted to replace.
 */
export async function ensureSandboxTemplatePin(store: ObjectStore, now = Date.now()): Promise<void> {
  if (now - loadedAt < PIN_CACHE_TTL_MS) {
    return;
  }

  try {
    cached = await readSandboxTemplatePin(store);
    loadedAt = now;
  } catch (error) {
    logger.warn(`Could not load the sandbox template pin: ${(error as Error)?.message}`);
  }
}

/** Test seam, and the write path's way of making a promotion take effect immediately. */
export function setSandboxTemplatePinCache(file: SandboxTemplatePinFile, now = Date.now()): void {
  cached = file;
  loadedAt = now;
}

/** Test seam — forget everything, including the load timestamp. */
export function resetSandboxTemplatePinCache(): void {
  cached = EMPTY;
  loadedAt = 0;
}
