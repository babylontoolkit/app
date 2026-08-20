/**
 * Should we top up the saved copies right now, and what should we write? (SPEC §4.5.4c, §4.12, §4.16)
 *
 * A top-up WRITES A CHECKPOINT, and a checkpoint is what a `protectNothing` restore treats as the whole
 * truth of the project (`restore-plan.ts`) — so a wrong answer here DELETES the user's files on the next
 * reload. That puts this in the same category as `selectMountSource`, `selectRestoreTarget` and
 * `planRestore`: enumerated rather than spot-checked, because every case below is somebody's only copy
 * of a game and none of them raises anything.
 *
 * The four silent losses, one per rule:
 *
 *   - top up MID-STREAM → the whole project is serialized on the main thread while a generation is still
 *     landing, which is the shape that froze the tab on a media-heavy run (§4.16);
 *   - top up DURING A RESTORE → the restore's own writes and deletes are photographed as if the user had
 *     made them, so a §4.12 undo is immediately followed by a checkpoint of the state it undid;
 *   - APPEND EVERY TIME → the 20-slot history (`MAX_CHECKPOINTS_PER_PROJECT`) fills with auto-saves and
 *     evicts the generation checkpoints undo actually reaches for;
 *   - AMEND THE WRONG ROW → after an undo the pointer is parked on an OLDER checkpoint, and rewriting
 *     "the current snapshot" overwrites the user's undo target with the very state they undid from.
 *
 * ## Mutation verification (hand-discharged 2026-08-15)
 *
 * Both guards were reverted in `top-up-plan.ts`, the suite re-run, and the file restored:
 *
 *   - dropping the `isNewest` condition from the amend guard (leaving `current.kind === 'top-up' &&
 *     current.isCurrent`) fails **2 of 28** named tests: "degrades to append when the row is not the
 *     newest — the post-undo pointer" and "amends only when all three conditions hold". Note which test
 *     does NOT fail: the suite CONTROL, because its amend fixture satisfies all three conditions and so
 *     still disagrees with the always-append stand-in. A control proves the suite measures something; it
 *     is not a substitute for a case per guard.
 *   - dropping the `streaming` check entirely (the `if (facts.streaming) return { action: 'defer' }`
 *     block removed) fails **4 of 28** named tests: "defers rather than serializing mid-generation",
 *     "defers whatever the checkpoint history looks like", "still defers when there is no checkpoint at
 *     all", and "CONTROL — a function that always appended would fail this suite". The two
 *     skip-outranks-defer tests survive it, correctly — they assert a `skip`, which the streaming check
 *     never reaches.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planTopUp, type TopUpCurrentSnapshot, type TopUpFacts, type TopUpPlan } from './top-up-plan';

/** A project that is open, idle, and free to be topped up. Each test perturbs one fact. */
const ready: TopUpFacts = {
  hasProject: true,
  hasDb: true,
  streaming: false,
  restoreInFlight: false,
};

/** The row an amend is allowed to rewrite: our own previous top-up, newest, and the current pointer. */
const amendable: TopUpCurrentSnapshot = {
  id: 'snap_topup',
  seq: 7,
  messageId: 'msg_boost',
  kind: 'top-up',
  isNewest: true,
  isCurrent: true,
};

/** An ordinary generation checkpoint — the history is append-only for these. */
const generationCheckpoint: TopUpCurrentSnapshot = {
  id: 'snap_gen',
  seq: 6,
  messageId: 'msg_boost',
  isNewest: true,
  isCurrent: true,
};

describe('there is nowhere to write (§4.5.4c)', () => {
  it('skips when no project is open', () => {
    expect(planTopUp({ ...ready, hasProject: false })).toEqual({ action: 'skip', reason: 'no-project' });
  });

  it('skips when the database is unavailable', () => {
    expect(planTopUp({ ...ready, hasDb: false })).toEqual({ action: 'skip', reason: 'no-db' });
  });

  /*
   * 🔴 Skip must outrank defer. `defer` means "ask me again in a moment", and the caller answers it by
   * re-arming the debounce — so deferring a state that can never resolve schedules a timer that wakes up
   * forever and does nothing. The "come back later" answer is reserved for states that actually change.
   */
  it('skips rather than defers when there is no project — a defer would re-arm a dead timer', () => {
    expect(planTopUp({ ...ready, hasProject: false, streaming: true })).toEqual({
      action: 'skip',
      reason: 'no-project',
    });
    expect(planTopUp({ ...ready, hasProject: false, streaming: true, restoreInFlight: true })).toEqual({
      action: 'skip',
      reason: 'no-project',
    });
  });

  it('skips rather than defers when the database is unavailable', () => {
    expect(planTopUp({ ...ready, hasDb: false, streaming: true })).toEqual({ action: 'skip', reason: 'no-db' });
  });

  /* A missing project is reported as such even when the database is missing too — the caller logs it. */
  it('names the project before the database when both are missing', () => {
    expect(planTopUp({ ...ready, hasProject: false, hasDb: false })).toEqual({
      action: 'skip',
      reason: 'no-project',
    });
  });

  /* Nothing to write to means nothing to write, however amendable the history looks. */
  it('never reaches the checkpoint history at all', () => {
    expect(planTopUp({ ...ready, hasProject: false, current: amendable })).toMatchObject({ action: 'skip' });
    expect(planTopUp({ ...ready, hasDb: false, current: amendable })).toMatchObject({ action: 'skip' });
  });
});

describe('a restore is in flight (§4.12)', () => {
  /*
   * A restore writes and deletes files as its normal operation, so a top-up landing inside one
   * photographs the restore itself: a duplicate checkpoint on every mount, and — after an undo — a
   * checkpoint of the state the user just undid, sitting on top of the history as the newest row.
   */
  it('skips while a restore is writing and deleting', () => {
    expect(planTopUp({ ...ready, restoreInFlight: true })).toEqual({ action: 'skip', reason: 'restore-in-flight' });
  });

  /*
   * 🔴 Terminal, not deferred, and this is the whole reason it sits ABOVE the streaming check. A restore
   * replaces the tree wholesale, so whatever change asked for this top-up no longer exists — deferring
   * would simply move the same wrong capture a few seconds later, once the restore had finished.
   */
  it('outranks the streaming defer', () => {
    expect(planTopUp({ ...ready, restoreInFlight: true, streaming: true })).toEqual({
      action: 'skip',
      reason: 'restore-in-flight',
    });
  });

  it('skips regardless of what the checkpoint history holds', () => {
    expect(planTopUp({ ...ready, restoreInFlight: true, current: amendable })).toEqual({
      action: 'skip',
      reason: 'restore-in-flight',
    });
    expect(planTopUp({ ...ready, restoreInFlight: true, current: generationCheckpoint })).toEqual({
      action: 'skip',
      reason: 'restore-in-flight',
    });
  });
});

describe('the stream is live (§4.16 — the freeze)', () => {
  /*
   * Serializing base64s every binary and assembles the whole envelope on the main thread. This used to
   * fire ~4s after the FIRST media render landed, i.e. squarely mid-stream while more renders were still
   * arriving — measured at 8,011 MB and a dead-locked renderer.
   */
  it('defers rather than serializing mid-generation', () => {
    expect(planTopUp({ ...ready, streaming: true })).toEqual({ action: 'defer' });
  });

  /*
   * The change is real and still needs saving, so this is a DEFER and never a skip: the caller re-arms
   * the same debounce and asks again once the stream ends. A skip here loses the late write outright,
   * which is the bug this whole mechanism exists to fix.
   */
  it('defers whatever the checkpoint history looks like', () => {
    expect(planTopUp({ ...ready, streaming: true, current: amendable })).toEqual({ action: 'defer' });
    expect(planTopUp({ ...ready, streaming: true, current: generationCheckpoint })).toEqual({ action: 'defer' });
  });

  it('still defers when there is no checkpoint at all', () => {
    expect(planTopUp({ ...ready, streaming: true, current: undefined })).toEqual({ action: 'defer' });
  });
});

describe('the very first checkpoint (§4.16 — media before any checkpoint exists)', () => {
  /*
   * Previously a silent no-op: the old code read the current snapshot purely to borrow its `seq`, so
   * with no snapshot to borrow from it returned early and the first render of a brand-new project
   * reached NEITHER saved copy. A top-up is a real checkpoint now, so it allocates its own seq.
   */
  it('appends the first checkpoint instead of doing nothing', () => {
    expect(planTopUp(ready)).toEqual({ action: 'append' });
  });

  /*
   * And it must not invent a `messageId`. There is no turn to name — the checkpoint precedes every
   * generation — and a fabricated id would anchor §4.12's "restore to after this change" to a message
   * whose state this checkpoint does not contain.
   */
  it('carries no messageId, because there is no turn to name', () => {
    const plan = planTopUp(ready) as Extract<TopUpPlan, { action: 'append' }>;

    expect(plan.messageId).toBeUndefined();
  });
});

describe('amending the previous top-up (the 20-slot trim)', () => {
  /*
   * Bounds the churn to at most one top-up row per real checkpoint. Without it a ten-minute editing
   * session appends a checkpoint every debounce window, and the trim — oldest first, inside the write
   * transaction — evicts every generation checkpoint, leaving §4.12 undo pointing only at auto-saves.
   */
  it('amends the row in place, carrying its id, seq and messageId', () => {
    expect(planTopUp({ ...ready, current: amendable })).toEqual({
      action: 'amend',
      snapshotId: 'snap_topup',
      seq: 7,
      messageId: 'msg_boost',
    });
  });

  /*
   * The seq must be handed back unchanged. Reusing it is what makes the store's trim a no-op (the row
   * count does not move) and what stops a counter being burnt on every editor save.
   */
  it('reuses the row’s own seq rather than asking for a new one', () => {
    const plan = planTopUp({ ...ready, current: { ...amendable, seq: 0 } }) as Extract<TopUpPlan, { action: 'amend' }>;

    expect(plan.seq).toBe(0);
  });

  /* A top-up appended before any generation has a messageId legitimately has none to hand back. */
  it('amends a first-checkpoint top-up that has no messageId', () => {
    expect(planTopUp({ ...ready, current: { ...amendable, messageId: undefined } })).toEqual({
      action: 'amend',
      snapshotId: 'snap_topup',
      seq: 7,
    });
  });
});

describe('the three ways amend degrades to append', () => {
  /*
   * (1) WRONG KIND. The history is append-only for generation checkpoints — they are what §4.12 undo
   * reaches for, and rewriting one replaces a state the user can still see in the timeline with a later
   * one, under the same label.
   */
  it('degrades to append when the row is an ordinary generation checkpoint', () => {
    expect(planTopUp({ ...ready, current: generationCheckpoint })).toEqual({
      action: 'append',
      messageId: 'msg_boost',
    });
  });

  /*
   * (2) NOT THE NEWEST. A newer row exists behind this one, so rewriting it puts the current state into
   * the middle of the timeline — the version history would read forward through a checkpoint containing
   * files that did not exist when the rows after it were taken.
   */
  it('degrades to append when the row is not the newest — the post-undo pointer', () => {
    expect(planTopUp({ ...ready, current: { ...amendable, isNewest: false } })).toEqual({
      action: 'append',
      messageId: 'msg_boost',
    });
  });

  /*
   * (3) NOT THE CURRENT POINTER. After an undo `currentSnapshotId` is parked on an OLDER snapshot, and
   * an in-place rewrite of "the current snapshot" would overwrite the user's undo target with the very
   * state they undid from — the worst outcome the feature can produce, and silent.
   */
  it('degrades to append when the row is not the current pointer', () => {
    expect(planTopUp({ ...ready, current: { ...amendable, isCurrent: false } })).toEqual({
      action: 'append',
      messageId: 'msg_boost',
    });
  });

  it('degrades to append when all three conditions fail at once', () => {
    expect(
      planTopUp({
        ...ready,
        current: { ...amendable, kind: undefined, isNewest: false, isCurrent: false },
      }),
    ).toEqual({ action: 'append', messageId: 'msg_boost' });
  });

  /*
   * The matrix, enumerated rather than spot-checked: `amend` is the ONE cell where all three hold, and
   * every other cell must fall through to the always-safe `append` — which only ever adds history.
   * Written as a loop so that a fourth condition, or a later relaxation of one of them, cannot pass by
   * satisfying the three named cases above.
   */
  it('amends only when all three conditions hold', () => {
    for (const kind of ['top-up', undefined] as const) {
      for (const isNewest of [true, false]) {
        for (const isCurrent of [true, false]) {
          const plan = planTopUp({ ...ready, current: { ...amendable, kind, isNewest, isCurrent } });
          const shouldAmend = kind === 'top-up' && isNewest && isCurrent;

          expect(plan.action, `kind=${kind} isNewest=${isNewest} isCurrent=${isCurrent}`).toBe(
            shouldAmend ? 'amend' : 'append',
          );
        }
      }
    }
  });
});

describe('carrying the messageId forward (§4.5.4c — the apply-dialog loop)', () => {
  /*
   * A checkpoint that cannot say which turn it contains becomes the current snapshot and makes
   * `checkUnappliedTurn` re-offer the "apply this turn?" dialog on every mount, forever — the user is
   * asked to re-apply a turn that is already in their files, every time they open the project.
   */
  it('appends carrying the previous checkpoint’s messageId', () => {
    const plan = planTopUp({
      ...ready,
      current: { ...generationCheckpoint, messageId: 'msg_wreck' },
    }) as Extract<TopUpPlan, { action: 'append' }>;

    expect(plan.messageId).toBe('msg_wreck');
  });

  /* But it never invents one: a history whose newest row names no turn still names no turn. */
  it('does not invent a messageId the history does not have', () => {
    const plan = planTopUp({
      ...ready,
      current: { ...generationCheckpoint, messageId: undefined },
    }) as Extract<TopUpPlan, { action: 'append' }>;

    expect(plan).toEqual({ action: 'append' });
    expect(plan.messageId).toBeUndefined();
  });
});

/**
 * The acceptance criterion that keeps this function testable at all: it decides what gets written over
 * the user's project, so it must stay reachable from a plain unit test — no store, no IndexedDB, no DOM.
 * A source scan rather than a behavioural assertion, because an import is a fact about the FILE: a
 * module that imported `./db` would still return the right answers here while making the next caller
 * unable to exercise it without a fake database.
 */
describe('purity', () => {
  const sourceOf = (file: string) =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  /*
   * `import[\s({]`, not `import\s` — a dynamic `await import('./db')` and a minified
   * `import{x}from'y'` are both imports, and a scanner that cannot see them would report a clean bill
   * of health for exactly the impurity a later edit is most likely to introduce.
   */
  const IMPORTS = /^\s*import[\s({]|(?:^|[^.\w])require\s*\(/m;

  it('imports nothing at all', () => {
    expect(IMPORTS.test(sourceOf('./top-up-plan.ts'))).toBe(false);
  });

  /*
   * CONTROL for the scanner. A regex that silently matched nothing would report a clean bill of health
   * forever, including for a version of the module that had grown an IndexedDB import.
   */
  it('CONTROL — the scanner does detect imports in a neighbouring module', () => {
    expect(IMPORTS.test(sourceOf('./local-snapshots.ts'))).toBe(true);
  });
});

/**
 * 🔴 CONTROL for the whole suite.
 *
 * `append` is the safe fallback — it only ever adds history — which makes "just always append" a
 * plausible-looking implementation that would quietly reintroduce three of the four losses in this
 * file's header: serializing mid-stream, checkpointing a restore, and filling the 20-slot history with
 * auto-saves. This proves the tests above are measuring the decision and not merely agreeing with a
 * constant.
 */
describe('CONTROL — the suite measures something', () => {
  const alwaysAppend = (_facts: TopUpFacts): TopUpPlan => ({ action: 'append' });

  /** One fixture per rule that is NOT an append, named so a failure says which rule stopped mattering. */
  const cases: Array<[string, TopUpFacts]> = [
    ['no project', { ...ready, hasProject: false }],
    ['no database', { ...ready, hasDb: false }],
    ['restore in flight', { ...ready, restoreInFlight: true }],
    ['streaming', { ...ready, streaming: true }],
    ['an amendable top-up row', { ...ready, current: amendable }],
  ];

  it('CONTROL — a function that always appended would fail this suite', () => {
    expect(cases.length).toBeGreaterThan(0);

    for (const [name, facts] of cases) {
      expect(planTopUp(facts), name).not.toEqual(alwaysAppend(facts));
    }
  });

  /*
   * And the mirror: the append cases really are appends, so the control above is not passing merely
   * because `planTopUp` never appends anything.
   */
  it('CONTROL — the append cases genuinely agree with the stand-in', () => {
    expect(planTopUp(ready)).toEqual(alwaysAppend(ready));
    expect(planTopUp({ ...ready, current: { ...generationCheckpoint, messageId: undefined } })).toEqual(
      alwaysAppend(ready),
    );
  });
});
