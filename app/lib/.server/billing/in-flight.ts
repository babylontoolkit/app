/**
 * What this PROCESS is running right now — the billing sweep's "do not touch" list
 * (`_specs/no-unbilled-usage_plan.md` D3).
 *
 * The sweep settles `running` rows a dead process left behind, and managed chats nobody settled. It must
 * never settle work that is still under way HERE: a live legacy turn will settle itself, and a managed
 * chat whose turn is in flight would have part of that turn billed under the sweep's id — so a refund of
 * the turn, if it fails, would miss it. The engine runs on ONE instance (`--scale 1`, the tool relay's
 * constraint), so "not in this process" means "not running anywhere".
 *
 * Every mark carries its start time and EXPIRES (`IN_FLIGHT_MAX_MS`): a generator that is never consumed
 * never reaches the `finally` that releases its mark, and a mark that never expires would hide its chat
 * from the sweep for the life of the process — usage unbilled, silently, which is the failure this whole
 * plan exists to remove. Expiry trades that for a sweep that may, after two hours, settle a turn that is
 * somehow still running — billed by cursor, so never twice.
 */

/** A mark older than this is treated as released (see above). */
export const IN_FLIGHT_MAX_MS = 2 * 60 * 60_000;

const generations = new Map<string, Set<number>>();
const managedChats = new Map<string, Set<number>>();

let token = 0;

function mark(map: Map<string, Set<number>>, key: string, now: () => number): () => void {
  const started = now() + ++token / 1e6;

  if (!map.has(key)) {
    map.set(key, new Set());
  }

  map.get(key)!.add(started);

  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;

    const set = map.get(key);

    set?.delete(started);

    if (set && set.size === 0) {
      map.delete(key);
    }
  };
}

function live(map: Map<string, Set<number>>, key: string, at: number): boolean {
  const set = map.get(key);

  return Boolean(set && [...set].some((started) => at - started < IN_FLIGHT_MAX_MS));
}

/** Mark a legacy / enhancer generation as running in this process. Returns its idempotent release. */
export function trackGeneration(generationId: string, now: () => number = Date.now): () => void {
  return mark(generations, generationId, now);
}

export function isGenerationInFlight(generationId: string, at: number = Date.now()): boolean {
  return live(generations, generationId, at);
}

/** Mark a chat as having a managed turn in flight in this process. Returns its idempotent release. */
export function trackManagedTurn(chatId: string, now: () => number = Date.now): () => void {
  return mark(managedChats, chatId, now);
}

export function isManagedTurnInFlight(chatId: string, at: number = Date.now()): boolean {
  return live(managedChats, chatId, at);
}

/** Specs only. */
export function resetInFlightForTests(): void {
  generations.clear();
  managedChats.clear();
}
