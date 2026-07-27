/**
 * The SETTLE window between "project created" and "start building it" (SPEC §4.4b, §4.2.8).
 *
 * ## The hard rule this enforces
 *
 * The project is created FIRST, completely, and only then does the build generation start. That rule
 * already had one guard — `waitForMountVisible`, which blocks until the exact files §4.4b wrote are
 * visible in `workbenchStore.files` — and that guard remains the correctness mechanism. This is the
 * second half of the same rule: **visible is not the same as finished settling.**
 *
 * `waitForMountVisible` returns the instant its sentinels appear. The watcher is still draining the
 * rest of the tree behind them (a starter is ~78 files; the sentinels are a handful), the sandbox is
 * still finishing its own bookkeeping, and on a server provider each of those is an RTT rather than a
 * memory write. Firing the most expensive generation in the product into that tail is how the model
 * ends up reasoning about a project that is still arriving — the §4.2.8 failure that throws nothing,
 * costs nothing, and simply makes the output worse.
 *
 * ## Quiescence, not a blind sleep
 *
 * A fixed `setTimeout` would satisfy the letter of "wait a bit" and answer no question: too short on a
 * cold VM, pure dead time on a warm one. So this waits for the file map to STOP CHANGING — `quietMs`
 * with no change in the count — inside a floor and a ceiling:
 *
 *  - **`minMs`** — a floor, because a watcher that has not started yet is trivially "quiet". Without it
 *    the check can pass before any work has happened, which is the bug it exists to prevent.
 *  - **`maxMs`** — a ceiling, because a project whose count never stabilises (a dev server writing into
 *    the tree, a provider with a chatty watcher) must not hang the New Project button. §1.3 principle 0:
 *    degrade, never refuse. Reaching the ceiling is normal and silent — it is a bound, not an error.
 *
 * Pure except for the two injected seams (`readCount`, `onTick`), so the timing rules are unit-testable
 * without a sandbox, a watcher, or a real clock's worth of waiting.
 */

/** Floor: a settle shorter than this is not a settle, it is a race with the watcher's first callback. */
export const SETTLE_MIN_MS = 5_000;

/** Ceiling: past this we build anyway. The user is watching a spinner, and the files are already visible. */
export const SETTLE_MAX_MS = 10_000;

/** No change for this long counts as "the tree stopped arriving". */
export const SETTLE_QUIET_MS = 1_500;

/** How often the count is sampled. */
export const SETTLE_POLL_MS = 250;

export interface SettleOptions {
  /** How many files the store currently shows. Any monotonic-ish "size of what has arrived" works. */
  readCount: () => number;

  minMs?: number;
  maxMs?: number;
  quietMs?: number;
  pollMs?: number;

  /** Called after each sample with elapsed ms — lets the caller narrate the wait. */
  onTick?: (elapsedMs: number, count: number) => void;

  /** Injectable for tests. Defaults to the real clock and a real timer. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SettleResult {
  /** True when the count went quiet on its own; false when the ceiling ended it. */
  quiesced: boolean;
  elapsedMs: number;
  finalCount: number;
}

export async function settleAfterCreation(options: SettleOptions): Promise<SettleResult> {
  const {
    readCount,
    minMs = SETTLE_MIN_MS,
    maxMs = SETTLE_MAX_MS,
    quietMs = SETTLE_QUIET_MS,
    pollMs = SETTLE_POLL_MS,
    onTick,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const startedAt = now();
  let lastCount = readCount();
  let lastChangeAt = startedAt;

  for (;;) {
    await sleep(pollMs);

    const elapsed = now() - startedAt;
    const count = readCount();

    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = now();
    }

    onTick?.(elapsed, count);

    /*
     * The ceiling is checked FIRST so a tree that never stops changing still ends the wait. Checking
     * quiescence first would be correct in every case except the one this bound exists for.
     */
    if (elapsed >= maxMs) {
      return { quiesced: false, elapsedMs: elapsed, finalCount: count };
    }

    if (elapsed >= minMs && now() - lastChangeAt >= quietMs) {
      return { quiesced: true, elapsedMs: elapsed, finalCount: count };
    }
  }
}
