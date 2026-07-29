/**
 * Sandbox VM-hours, aggregated from lifecycle marks (plan T12, SPEC §4.10).
 *
 * This is the other half of T11. That task put VM compute into the margin floor using an ESTIMATE
 * (`SANDBOX_EST_VM_HOURS_PER_KCREDIT`); this one measures what the estimate was estimating. Together
 * they answer the only question the bake-vs-meter decision left open: is one account's VM time close
 * enough to the average that a flat margin is honest, or is somebody running a build farm on a
 * Starter pack.
 *
 * **Pure, and no clock.** `now` is an argument, exactly like `buildUsageReport`'s inputs are: an
 * unclosed interval has to be measured against something, and a `Date.now()` inside would make every
 * assertion about an open VM untestable — which is the case that matters most, because an open
 * interval is a VM that is billing right now.
 */
import type { SandboxLifecycleEvent, SandboxMark } from '~/lib/.server/sandbox/usage-store';

/** Marks that START a billing interval. Everything else ends one. */
const OPENS: ReadonlySet<SandboxLifecycleEvent> = new Set<SandboxLifecycleEvent>(['create', 'resume']);

/** Where marks with no user id are aggregated. Visible on purpose — see `unattributedHours`. */
export const UNATTRIBUTED = 'unattributed';

export interface VmUserUsage {
  userId: string;
  vmHours: number;

  /** Distinct sandboxes seen for this user in the window. */
  sandboxes: number;

  /** How many of this user's VMs are still running at `now` (an interval opened and never closed). */
  running: number;
}

export interface VmReport {
  /** Marks the report was built from — a zero here means "nothing recorded", not "nothing happened". */
  marks: number;

  /** Distinct sandboxes seen in the window. */
  sandboxes: number;

  /** Total paired VM-hours, unclosed intervals counted up to `now`. */
  vmHours: number;

  /** Intervals still open at `now` — VMs billing this second. */
  running: number;

  /**
   * How many open intervals hit `maxIntervalMs` instead of running to `now`.
   *
   * Reported rather than silently applied, because this number IS the accuracy warning: the provider
   * hibernates an idle VM on its own timeout and does not tell us, so those intervals never receive a
   * closing mark. A handful is the ordinary state of the world; a count near `running` means the
   * report is mostly clamps and its hours are a ceiling, not a measurement.
   */
  clamped: number;

  /**
   * Hours we could not attribute to an account.
   *
   * Called out as its own number rather than quietly dropped: an unattributed hour is still an hour
   * on the bill, and a report whose rows do not add up to its own total is a report that gets argued
   * with instead of acted on. The bucket ALSO appears in `topUsers` under the id `unattributed` and
   * counts toward `users` — it is a row like any other, plus a headline so it cannot hide inside a
   * truncated leaderboard.
   */
  unattributedHours: number;

  /** Oldest and newest mark in the window, epoch-ms. Absent when there are no marks. */
  windowStart?: number;
  windowEnd?: number;

  /** Heaviest accounts first. Truncated to `topN`; `users` says how many there were in total. */
  users: number;
  topUsers: VmUserUsage[];
}

export interface VmReportOptions {
  /** How many per-user rows to return. The panel shows a leaderboard, not a directory. */
  topN?: number;

  /**
   * The longest an UNCLOSED interval may be counted for. Default 24h.
   *
   * 🔴 Without this the report is unbounded fiction. A close mark is written when WE hibernate or
   * delete a VM — but the common way a VM stops is the provider's own idle timeout
   * (`hibernationTimeoutSeconds`), which happens with nobody to tell. Every one of those intervals
   * stays open forever, so a month-old resume would contribute a month of VM-hours to a VM that ran
   * for six minutes, and the number the bake-vs-meter decision is checked against would be off by
   * three orders of magnitude — in the direction that looks like a crisis rather than the direction
   * that hides one, but wrong either way.
   *
   * A clamp is a ceiling, not a measurement, which is why `clamped` is reported beside it.
   */
  maxIntervalMs?: number;
}

/** 24 hours. Longer than any plausible single working session, shorter than any accounting period. */
export const DEFAULT_MAX_OPEN_INTERVAL_MS = 24 * 3_600_000;

const HOUR_MS = 3_600_000;

interface OpenInterval {
  at: number;
  userId?: string;
}

/**
 * Pair lifecycle marks into VM-hours.
 *
 * The walk is per sandbox, in time order, and it is deliberately forgiving in both directions,
 * because a window over an append-only stream is always truncated at BOTH ends:
 *
 * - A **close with no open** (the resume happened before the window started) contributes nothing.
 *   Charging it back to the window's start would invent hours out of where the operator set `limit`.
 * - A **second open while one is already running** keeps the FIRST. Duplicate opens happen (a resume
 *   against an already-running VM is a legitimate no-op at the provider), and taking the later one
 *   would silently discount the time in between — the direction that under-reports cost, which is the
 *   direction that lets the bake-in decision look better than it is.
 * - An **unclosed open** runs to `now`. That is the VM that is billing while you read the report.
 *
 * Marks may arrive in any order (the store lists newest-first, and two servers write concurrently), so
 * this sorts rather than trusting the caller.
 */
export function buildVmReport(marks: readonly SandboxMark[], now: number, options: VmReportOptions = {}): VmReport {
  const topN = Number.isFinite(options.topN) && (options.topN as number) > 0 ? Math.floor(options.topN as number) : 10;

  // A nonsensical override falls back rather than being obeyed — `0` would report zero hours forever.
  const maxIntervalMs =
    Number.isFinite(options.maxIntervalMs) && (options.maxIntervalMs as number) > 0
      ? (options.maxIntervalMs as number)
      : DEFAULT_MAX_OPEN_INTERVAL_MS;

  const bySandbox = new Map<string, SandboxMark[]>();
  let windowStart: number | undefined;
  let windowEnd: number | undefined;

  for (const mark of marks) {
    if (!mark || typeof mark.sandboxId !== 'string' || !mark.sandboxId || !Number.isFinite(mark.at)) {
      // A malformed row must not take the operator's whole dashboard down with it.
      continue;
    }

    const list = bySandbox.get(mark.sandboxId);

    if (list) {
      list.push(mark);
    } else {
      bySandbox.set(mark.sandboxId, [mark]);
    }

    windowStart = windowStart === undefined ? mark.at : Math.min(windowStart, mark.at);
    windowEnd = windowEnd === undefined ? mark.at : Math.max(windowEnd, mark.at);
  }

  /** Accumulated ms per attributed user, plus their sandbox set and running count. */
  const perUser = new Map<string, { ms: number; sandboxes: Set<string>; running: number }>();

  const credit = (userId: string | undefined, sandboxId: string, ms: number, running: boolean) => {
    const key = userId || UNATTRIBUTED;
    let entry = perUser.get(key);

    if (!entry) {
      entry = { ms: 0, sandboxes: new Set(), running: 0 };
      perUser.set(key, entry);
    }

    entry.ms += ms;
    entry.sandboxes.add(sandboxId);

    if (running) {
      entry.running += 1;
    }
  };

  let totalMs = 0;
  let running = 0;
  let clamped = 0;

  for (const [sandboxId, sandboxMarks] of bySandbox) {
    /*
     * Ties break on the event: an `open` and a `close` stamped at the same millisecond are a
     * hibernate immediately followed by a resume far more often than the reverse, and resolving the
     * close first keeps the interval count honest instead of leaving a phantom VM running forever.
     */
    const ordered = [...sandboxMarks].sort(
      (a, b) => a.at - b.at || Number(OPENS.has(a.event)) - Number(OPENS.has(b.event)),
    );

    let open: OpenInterval | undefined;

    for (const mark of ordered) {
      if (OPENS.has(mark.event)) {
        if (!open) {
          open = { at: mark.at, userId: mark.userId };
        }

        continue;
      }

      if (!open) {
        // Closed something that opened before this window. Nothing to charge.
        continue;
      }

      const ms = Math.max(0, mark.at - open.at);
      totalMs += ms;

      // The user on the OPENING mark owns the interval; a close may carry no attribution at all.
      credit(open.userId ?? mark.userId, sandboxId, ms, false);
      open = undefined;
    }

    if (open) {
      const elapsed = Math.max(0, now - open.at);
      const ms = Math.min(elapsed, maxIntervalMs);

      if (elapsed > maxIntervalMs) {
        clamped += 1;
      }

      totalMs += ms;
      running += 1;
      credit(open.userId, sandboxId, ms, true);
    }
  }

  const users = [...perUser.entries()]
    .map(([userId, entry]) => ({
      userId,
      vmHours: entry.ms / HOUR_MS,
      sandboxes: entry.sandboxes.size,
      running: entry.running,
    }))
    .sort((a, b) => b.vmHours - a.vmHours || a.userId.localeCompare(b.userId));

  return {
    marks: marks.length,
    sandboxes: bySandbox.size,
    vmHours: totalMs / HOUR_MS,
    running,
    clamped,
    unattributedHours: (perUser.get(UNATTRIBUTED)?.ms ?? 0) / HOUR_MS,
    windowStart,
    windowEnd,
    users: users.length,
    topUsers: users.slice(0, topN),
  };
}
