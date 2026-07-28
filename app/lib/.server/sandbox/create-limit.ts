/**
 * A ceiling on how fast one account may fork VMs (`spec/sandbox-codesandbox.md` §11 M2).
 *
 * Forking a template is the one sandbox operation that both spends money and consumes a PLATFORM-wide
 * resource: the provider's fork budget is measured per hour for the whole API key, not per user. So an
 * unbounded `{ reset: true }` loop from one browser tab is not "that user's problem" — it is an outage
 * lever for everybody, and it arrives looking exactly like an enthusiastic user pressing a button.
 *
 * Same shape and scope as `failure-rate.ts`: a bounded in-process ring per user, no database read (the
 * limit must hold when the database is what is down), and the JUDGEMENT is a pure function so it can be
 * tested exhaustively without a clock.
 *
 * ⚠️ In-process means per-container: with N app containers the effective ceiling is N × the limit. That
 * is deliberate rather than overlooked — a shared counter would put a network round trip in front of
 * every sandbox boot to defend against a case a generous limit already survives. The number below is
 * chosen so N × limit still sits under the provider budget for launch-sized deployments; revisit it
 * with the T12 VM report rather than by guessing.
 */

/** Rolling window the limit is measured over. One hour matches how the provider states its own budget. */
export const CREATE_LIMIT_WINDOW_MS = 60 * 60_000;

/**
 * Forks per user per hour.
 *
 * Generous on purpose: a real session creates ONE sandbox per project, and a user genuinely working
 * through several projects plus a couple of resets must never meet this. It exists to stop a loop, not
 * to ration ordinary use — a limit that refuses a real user is a worse failure than the abuse it stops.
 */
export const DEFAULT_SANDBOX_CREATES_PER_HOUR = 20;

export type CreateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number; limit: number };

/**
 * May this account fork another sandbox right now?
 *
 * `recent` is every create timestamp we hold for the user; entries older than the window are ignored
 * here rather than assumed pruned, so a caller that never prunes still gets the right answer.
 *
 * `retryAfterSeconds` is derived from the OLDEST in-window create — the moment the window first has
 * room again — because a refusal that cannot say when to come back is indistinguishable from a stall.
 */
export function decideCreateAllowed(
  recent: readonly number[],
  now: number,
  limit: number = DEFAULT_SANDBOX_CREATES_PER_HOUR,
  windowMs: number = CREATE_LIMIT_WINDOW_MS,
): CreateLimitDecision {
  /*
   * A nonsensical limit falls back rather than being obeyed — the same rule as `sandboxHibernationSeconds`.
   * Obeying `0` or `NaN` would refuse every sandbox on the platform from a typo in an env var.
   */
  const effective = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SANDBOX_CREATES_PER_HOUR;

  const inWindow = recent.filter((at) => Number.isFinite(at) && now - at < windowMs);

  if (inWindow.length < effective) {
    return { allowed: true, remaining: effective - inWindow.length };
  }

  const oldest = Math.min(...inWindow);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));

  return { allowed: false, retryAfterSeconds, limit: effective };
}

/**
 * The process-wide record of recent forks, by user.
 *
 * Pruned on every read so an idle user's entry disappears instead of accumulating — this map is the
 * only thing here that could grow without bound.
 */
const creates = new Map<string, number[]>();

/** Every create timestamp we still hold for this user, oldest first. Prunes as it reads. */
export function recentSandboxCreates(userId: string, now: number = Date.now()): number[] {
  const kept = (creates.get(userId) ?? []).filter((at) => now - at < CREATE_LIMIT_WINDOW_MS);

  if (kept.length === 0) {
    creates.delete(userId);
  } else {
    creates.set(userId, kept);
  }

  return kept;
}

/** Record a fork. Called AFTER a successful create, so a provider failure never consumes budget. */
export function recordSandboxCreate(userId: string, now: number = Date.now()): void {
  creates.set(userId, [...recentSandboxCreates(userId, now), now]);
}

/** Test seam — a rate that leaks between tests is not a rate (`resetRateWindows` sets the precedent). */
export function resetSandboxCreateLimits(): void {
  creates.clear();
}
