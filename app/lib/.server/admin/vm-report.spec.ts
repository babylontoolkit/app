/**
 * `buildVmReport` — sandbox VM-hours from lifecycle marks (plan T12, SPEC §4.10).
 *
 * Why this is tested exhaustively rather than smoke-tested: this report is the ONLY measurement of the
 * number T11's margin floor guesses (`SANDBOX_EST_VM_HOURS_PER_KCREDIT`), and every way it can be
 * wrong is silent. It throws nothing on a malformed mark, it reports a plausible-looking number on a
 * clamp it forgot to apply, and it under-reports — the flattering direction — on a duplicate open. A
 * wrong number here does not break the product; it makes the bake-vs-meter decision look settled when
 * it is not.
 *
 * The function takes `now` as an argument, so every assertion about an OPEN interval (the VM that is
 * billing right now, i.e. the case that matters most) is exact rather than timing-dependent.
 */
import { describe, expect, it } from 'vitest';
import type { SandboxMark } from '~/lib/.server/sandbox/usage-store';
import { buildVmReport, DEFAULT_MAX_OPEN_INTERVAL_MS, UNATTRIBUTED } from './vm-report';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 27, 12, 0, 0);

/** Terse mark builder — these tests are about the SHAPE of a stream, not about field plumbing. */
const mark = (
  event: SandboxMark['event'],
  sandboxId: string,
  atHours: number,
  userId?: string,
  projectId?: string,
): SandboxMark => ({ event, sandboxId, at: T0 + atHours * HOUR, userId, projectId });

describe('pairing marks into intervals', () => {
  it('pairs create→hibernate into hours', () => {
    const report = buildVmReport([mark('create', 'sb-1', 0, 'u1'), mark('hibernate', 'sb-1', 2, 'u1')], T0 + 5 * HOUR);

    expect(report.vmHours).toBe(2);
    expect(report.running).toBe(0);
    expect(report.sandboxes).toBe(1);
    expect(report.marks).toBe(2);
  });

  it('pairs resume→delete as well — the opening event is create OR resume', () => {
    const report = buildVmReport([mark('resume', 'sb-1', 1, 'u1'), mark('delete', 'sb-1', 1.5, 'u1')], T0 + 9 * HOUR);

    expect(report.vmHours).toBe(0.5);
    expect(report.running).toBe(0);
  });

  it('counts an UNCLOSED interval up to `now` and reports it as running', () => {
    /*
     * This is the VM billing while the operator reads the panel. Counting it to `now` is the whole
     * reason `now` is a parameter; omitting it would make a busy platform look idle.
     */
    const report = buildVmReport([mark('create', 'sb-1', 0, 'u1')], T0 + 3 * HOUR);

    expect(report.vmHours).toBe(3);
    expect(report.running).toBe(1);
    expect(report.clamped).toBe(0);
  });

  it('sorts marks itself — the store lists NEWEST first and two servers write concurrently', () => {
    /*
     * The route hands this the store's output verbatim, which is descending by `at`. If the walk
     * trusted caller order it would see hibernate-before-create on every single real request: no open
     * interval, zero hours, and a dashboard that reads as "nobody used the platform".
     */
    const ordered = [mark('create', 'sb-1', 0, 'u1'), mark('hibernate', 'sb-1', 4, 'u1')];

    expect(buildVmReport([...ordered].reverse(), T0 + 9 * HOUR).vmHours).toBe(4);
    expect(buildVmReport(ordered, T0 + 9 * HOUR).vmHours).toBe(4);
  });

  it('walks several intervals on ONE sandbox and sums them', () => {
    const report = buildVmReport(
      [
        mark('create', 'sb-1', 0, 'u1'),
        mark('hibernate', 'sb-1', 1, 'u1'),
        mark('resume', 'sb-1', 5, 'u1'),
        mark('hibernate', 'sb-1', 6.5, 'u1'),
      ],
      T0 + 9 * HOUR,
    );

    expect(report.vmHours).toBe(2.5);
    expect(report.sandboxes).toBe(1);
    expect(report.topUsers[0]).toMatchObject({ userId: 'u1', sandboxes: 1, running: 0 });
  });

  it('keeps sandboxes separate — a close on one never ends the other’s interval', () => {
    const report = buildVmReport(
      [mark('create', 'sb-1', 0, 'u1'), mark('create', 'sb-2', 0, 'u1'), mark('hibernate', 'sb-2', 1, 'u1')],
      T0 + 2 * HOUR,
    );

    // sb-1 open for 2h, sb-2 closed after 1h.
    expect(report.vmHours).toBe(3);
    expect(report.running).toBe(1);
    expect(report.sandboxes).toBe(2);
  });
});

describe('the truncated ends of an append-only window', () => {
  it('contributes NOTHING for a close with no open', () => {
    /*
     * The resume happened before the window started. Charging back to the window's start would invent
     * hours out of wherever the operator happened to set `limit` — a cost report whose total moves when
     * you change the page size is a report nobody can act on.
     */
    const report = buildVmReport([mark('hibernate', 'sb-1', 3, 'u1')], T0 + 9 * HOUR);

    expect(report.vmHours).toBe(0);
    expect(report.running).toBe(0);
    expect(report.users).toBe(0);
    expect(report.sandboxes).toBe(1);
  });

  it('keeps the FIRST of two opens — never the later one', () => {
    /*
     * A resume against an already-running VM is a legitimate provider no-op, so duplicate opens are
     * ordinary. Taking the later one would discount the time in between, i.e. UNDER-report cost, which
     * is the direction that makes the bake-in decision look better than it is.
     */
    const report = buildVmReport(
      [mark('create', 'sb-1', 0, 'u1'), mark('resume', 'sb-1', 2, 'u1'), mark('hibernate', 'sb-1', 3, 'u1')],
      T0 + 9 * HOUR,
    );

    expect(report.vmHours).toBe(3);
  });

  it('resolves a close before an open stamped at the SAME millisecond', () => {
    /*
     * A hibernate immediately followed by a resume is far more common than the reverse. Resolving the
     * open first would leave a phantom VM running to `now` forever.
     */
    const report = buildVmReport(
      [mark('create', 'sb-1', 0, 'u1'), mark('resume', 'sb-1', 1, 'u1'), mark('hibernate', 'sb-1', 1, 'u1')],
      T0 + 9 * HOUR,
    );

    expect(report.vmHours).toBe(1 + 8);
    expect(report.running).toBe(1);
  });
});

describe('the open-interval clamp', () => {
  it('clamps an open interval at 24h by default and COUNTS the clamp', () => {
    /*
     * 🔴 The provider hibernates an idle VM on its own timeout and does not tell us, so those intervals
     * never receive a closing mark. Without the clamp a month-old resume contributes a month of
     * VM-hours for a VM that ran six minutes — three orders of magnitude of fiction, in the direction
     * that looks like a crisis.
     */
    const report = buildVmReport([mark('create', 'sb-1', 0, 'u1')], T0 + 30 * 24 * HOUR);

    expect(report.vmHours).toBe(DEFAULT_MAX_OPEN_INTERVAL_MS / HOUR);
    expect(report.clamped).toBe(1);
    expect(report.running).toBe(1);
  });

  it('does not count a clamp for an open interval inside the limit', () => {
    const report = buildVmReport([mark('create', 'sb-1', 0, 'u1')], T0 + 4 * HOUR);

    expect(report.clamped).toBe(0);
    expect(report.vmHours).toBe(4);
  });

  it('never clamps a CLOSED interval — a real 40h session is a measurement, not a guess', () => {
    const report = buildVmReport(
      [mark('create', 'sb-1', 0, 'u1'), mark('hibernate', 'sb-1', 40, 'u1')],
      T0 + 99 * HOUR,
    );

    expect(report.vmHours).toBe(40);
    expect(report.clamped).toBe(0);
  });

  it('honours an explicit maxIntervalMs', () => {
    const report = buildVmReport([mark('create', 'sb-1', 0, 'u1')], T0 + 10 * HOUR, { maxIntervalMs: 2 * HOUR });

    expect(report.vmHours).toBe(2);
    expect(report.clamped).toBe(1);
  });

  it('falls back to the default for a nonsensical maxIntervalMs instead of obeying it', () => {
    /*
     * `0` would report zero hours forever — a silent, total loss of the measurement, from one typo in
     * an override. A negative or NaN value is the same class of accident.
     */
    for (const maxIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const report = buildVmReport([mark('create', 'sb-1', 0, 'u1')], T0 + 30 * 24 * HOUR, { maxIntervalMs });

      expect(report.vmHours, `maxIntervalMs=${maxIntervalMs} must fall back`).toBe(DEFAULT_MAX_OPEN_INTERVAL_MS / HOUR);
      expect(report.clamped).toBe(1);
    }
  });
});

describe('per-user aggregation', () => {
  it('aggregates several users and sorts the leaderboard heaviest first', () => {
    const report = buildVmReport(
      [
        mark('create', 'sb-a', 0, 'light'),
        mark('hibernate', 'sb-a', 1, 'light'),
        mark('create', 'sb-b', 0, 'heavy'),
        mark('hibernate', 'sb-b', 5, 'heavy'),
        mark('create', 'sb-c', 0, 'heavy'),
        mark('hibernate', 'sb-c', 3, 'heavy'),
      ],
      T0 + 9 * HOUR,
    );

    expect(report.vmHours).toBe(9);
    expect(report.users).toBe(2);
    expect(report.topUsers.map((u) => u.userId)).toEqual(['heavy', 'light']);
    expect(report.topUsers[0]).toMatchObject({ vmHours: 8, sandboxes: 2, running: 0 });
    expect(report.topUsers[1]).toMatchObject({ vmHours: 1, sandboxes: 1 });
  });

  it('credits an interval to the user on the OPENING mark', () => {
    /*
     * A close may carry no attribution at all (the cap sweep hibernates a VM it selected from a row).
     * The account that started the VM owns its time.
     */
    const report = buildVmReport([mark('create', 'sb-1', 0, 'opener'), mark('hibernate', 'sb-1', 2)], T0 + 9 * HOUR);

    expect(report.topUsers).toEqual([{ userId: 'opener', vmHours: 2, sandboxes: 1, running: 0 }]);
    expect(report.unattributedHours).toBe(0);

    /*
     * And the opener still wins when the closing mark names somebody ELSE — the reaper closes VMs it
     * selected from a row, so a close is the one mark whose attribution can be wrong. Billing the
     * closer would move a heavy account's hours onto whoever happened to sweep them.
     */
    const swept = buildVmReport(
      [mark('create', 'sb-2', 0, 'opener'), mark('hibernate', 'sb-2', 2, 'reaper')],
      T0 + 9 * HOUR,
    );

    expect(swept.topUsers).toEqual([{ userId: 'opener', vmHours: 2, sandboxes: 1, running: 0 }]);
  });

  it('reports unattributed hours as their OWN number, never folded away', () => {
    /*
     * An unattributed hour is still an hour on the bill. Dropping it would make the total under-state
     * cost; folding it into a user's row would blame the wrong account. A report whose per-user rows do
     * not add to its own total gets argued with instead of acted on — so the gap is named.
     */
    const report = buildVmReport(
      [mark('create', 'sb-1', 0), mark('hibernate', 'sb-1', 2), mark('create', 'sb-2', 0, 'u1')],
      T0 + 1 * HOUR,
    );

    expect(report.vmHours).toBe(3);
    expect(report.unattributedHours).toBe(2);
    expect(report.topUsers.find((u) => u.userId === UNATTRIBUTED)).toMatchObject({ vmHours: 2 });
  });

  it('counts a user’s still-running VMs', () => {
    const report = buildVmReport(
      [mark('create', 'sb-1', 0, 'u1'), mark('create', 'sb-2', 0, 'u1'), mark('hibernate', 'sb-2', 1, 'u1')],
      T0 + 2 * HOUR,
    );

    expect(report.topUsers[0]).toMatchObject({ userId: 'u1', running: 1, sandboxes: 2 });
  });

  it('truncates topUsers while `users` still reports the FULL count', () => {
    /*
     * The panel shows a leaderboard, not a directory — but a truncated list that also truncated the
     * count would tell the operator the platform has 3 accounts using VMs when it has 12.
     */
    const marks = Array.from({ length: 12 }, (_, i) => [
      mark('create', `sb-${i}`, 0, `u${i}`),
      mark('hibernate', `sb-${i}`, i + 1, `u${i}`),
    ]).flat();

    const report = buildVmReport(marks, T0 + 99 * HOUR, { topN: 3 });

    expect(report.users).toBe(12);
    expect(report.topUsers).toHaveLength(3);
    expect(report.topUsers.map((u) => u.userId)).toEqual(['u11', 'u10', 'u9']);
  });

  it('falls back to the default topN for a nonsensical override', () => {
    const marks = Array.from({ length: 12 }, (_, i) => [
      mark('create', `sb-${i}`, 0, `u${i}`),
      mark('hibernate', `sb-${i}`, i + 1, `u${i}`),
    ]).flat();

    for (const topN of [0, -3, Number.NaN]) {
      expect(buildVmReport(marks, T0 + 99 * HOUR, { topN }).topUsers, `topN=${topN}`).toHaveLength(10);
    }
  });
});

describe('robustness and the window', () => {
  it('skips malformed marks instead of throwing', () => {
    /*
     * The rows come from a JSONL tail or a database, i.e. from outside this module. One bad row must
     * not take the operator's whole dashboard down — that is the failure the route's try/catch guards
     * against, and this is the layer that makes it never fire.
     */
    const marks = [
      mark('create', 'sb-1', 0, 'u1'),
      mark('hibernate', 'sb-1', 1, 'u1'),
      { event: 'create', sandboxId: '', at: T0 },
      { event: 'create', at: T0 },
      { event: 'create', sandboxId: 'sb-2', at: 'nonsense' },
      { event: 'create', sandboxId: 'sb-3', at: Number.NaN },
      null,
      undefined,
    ] as unknown as SandboxMark[];

    const report = buildVmReport(marks, T0 + 9 * HOUR);

    expect(report.vmHours).toBe(1);
    expect(report.sandboxes).toBe(1);

    /*
     * `marks` is what was HANDED to it — a zero there means "nothing recorded", and hiding skips
     * behind a filtered count would make a broken writer look like an idle platform.
     */
    expect(report.marks).toBe(marks.length);
  });

  it('reports an empty window as empty rather than as an error', () => {
    const report = buildVmReport([], T0);

    expect(report).toMatchObject({ marks: 0, sandboxes: 0, vmHours: 0, running: 0, clamped: 0, users: 0 });
    expect(report.windowStart).toBeUndefined();
    expect(report.windowEnd).toBeUndefined();
    expect(report.topUsers).toEqual([]);
  });

  it('reports the window bounds from the marks it accepted', () => {
    const report = buildVmReport(
      [mark('hibernate', 'sb-1', 6, 'u1'), mark('create', 'sb-1', 2, 'u1'), mark('create', 'sb-2', 4, 'u1')],
      T0 + 9 * HOUR,
    );

    expect(report.windowStart).toBe(T0 + 2 * HOUR);
    expect(report.windowEnd).toBe(T0 + 6 * HOUR);
  });
});
