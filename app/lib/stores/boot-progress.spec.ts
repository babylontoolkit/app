/**
 * The boot/creation phase store behind `BootScreen` and `WorkspaceSplash`.
 *
 * Two silent failure modes pinned here: a phase `isCreationPhase` does not recognise means the
 * creation splash never shows for it (back to the blank screen it exists to replace), and a phase
 * `bootPhaseCopy` has no case for falls through to the generic "Opening project…" copy — wrong
 * words on a surface whose whole job is to say what is actually happening.
 *
 * The `failed` phase adds a third: it is the ONLY terminal phase, and the mount path resets to `idle`
 * in a `finally` that runs however the mount ended. If that reset applied to a failure too, the
 * explanation the user just got would be erased a fraction of a second after it appeared — leaving a
 * blank workbench and no sentence about why, which is exactly the state this phase was built for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootPhaseCopy,
  bootProgress,
  bootRetry,
  coversWorkspace,
  effectiveBootPhase,
  endBootPhase,
  importTailActive,
  isCreationPhase,
  reportBootFailure,
  shouldCoverWorkspace,
  type BootPhase,
} from './boot-progress';

const CREATION_PHASES: BootPhase[] = [
  { step: 'creating-starter' },
  { step: 'creating-workspace' },
  { step: 'creating-mount' },
  { step: 'creating-finalize' },
  { step: 'creating-settle' },

  /*
   * The last two steps of creation (T6). A project that is not RUNNING is not created: the owner's
   * success condition is *"npm install + npm run dev and showing the starter app template basic home
   * page"*, so the splash covers those two waits rather than coming down while they run in a terminal
   * nobody is looking at. Both must be creation-family phases or the overlay they narrate never draws.
   */
  { step: 'creating-install' },
  { step: 'creating-serve' },
];

const RESUME_PHASES: BootPhase[] = [
  { step: 'idle' },

  /*
   * The `/remix/:shareId` clone. A resume-family phase ON PURPOSE: it renders the full-page
   * `BootScreen` (first on the remix route, then — because the atom survives `navigate('/')` — in the
   * builder while the clone mounts), never the creation overlay.
   */
  { step: 'remixing' },
  { step: 'sandbox' },
  { step: 'files' },
  { step: 'prepare' },

  /*
   * The tail of a mount, and a RESUME-family phase: the mount holds `ready` until it finishes, so this
   * is drawn by the full-page `BootScreen` like every other phase in this list. It is the resume twin
   * of `creating-settle` — the mount promise resolving is not the workspace having finished filling.
   */
  { step: 'settling' },
];

/**
 * The odd one out, and the reason the overlay gate is no longer a name-prefix test.
 *
 * An IMPORT covers the workspace like a creation does (its files land behind an already-rendered chat),
 * but it is not a creation and must not be named as one. It is deliberately in neither list above: the
 * `CREATION_PHASES` list is asserted against the `creating-` prefix, and `RESUME_PHASES` is asserted to
 * be invisible to the overlay. This phase is a third thing.
 */
const OVERLAY_ONLY_PHASES: BootPhase[] = [{ step: 'importing' }];

/**
 * 🔴 THE LISTS ABOVE ARE HAND-WRITTEN, AND A HAND-WRITTEN LIST CANNOT NOTICE AN OMISSION.
 *
 * Everything below iterates `CREATION_PHASES` / `RESUME_PHASES`, so a phase added to `BootPhase` and
 * forgotten here is simply never tested — the suite stays green and the new phase quietly falls through
 * to the generic "Opening project…" copy, or (worse) is not recognised by `isCreationPhase` and its
 * overlay never draws. That is not hypothetical: `creating-settle` had shipped, and was missing from
 * this file until T6 went looking.
 *
 * TypeScript cannot help — the union is erased at runtime, and `BootPhase[]` accepts a SHORT array
 * happily. So the phase set is derived from the SOURCE of the union and compared against the lists.
 * Being a source scan, it is worthless without controls: one proving the extractor actually reads a
 * real union (not an empty match reporting a clean bill of health forever), and one proving it can
 * SEE an omission on a fixture where an omission exists.
 */
const BOOT_PROGRESS_SOURCE = readFileSync(join(process.cwd(), 'app/lib/stores/boot-progress.ts'), 'utf-8');

/** Every `step: '…'` literal in the `BootPhase` union declaration, in declaration order. */
function declaredPhaseSteps(source: string): string[] {
  const start = source.indexOf('export type BootPhase =');
  const end = source.indexOf('export const bootProgress', start);
  const union = start < 0 || end < 0 ? '' : source.slice(start, end);

  return [...union.matchAll(/\bstep:\s*'([^']+)'/g)].map((match) => match[1]);
}

const DECLARED_STEPS = declaredPhaseSteps(BOOT_PROGRESS_SOURCE);

const COVERED_STEPS = new Set([
  ...CREATION_PHASES.map((phase) => phase.step),
  ...RESUME_PHASES.map((phase) => phase.step),
  ...OVERLAY_ONLY_PHASES.map((phase) => phase.step),
  'failed',
]);

describe('CONTROLS — the phase scanner can see what it judges', () => {
  it('read a real union with the phases it is known to contain', () => {
    expect(DECLARED_STEPS.length).toBeGreaterThan(5);
    expect(DECLARED_STEPS).toContain('idle');
    expect(DECLARED_STEPS).toContain('sandbox');
    expect(DECLARED_STEPS).toContain('failed');
    expect(new Set(DECLARED_STEPS).size).toBe(DECLARED_STEPS.length);
  });

  /* The other direction: on a union that declares a phase the lists do not carry, the check FAILS. */
  it('detects a phase the test lists would have missed', () => {
    const fabricated = declaredPhaseSteps(
      BOOT_PROGRESS_SOURCE.replace(
        'export const bootProgress',
        "  | { step: 'creating-teleport' }\n\nexport const bootProgress",
      ),
    );

    expect(fabricated).toContain('creating-teleport');
    expect(COVERED_STEPS.has('creating-teleport')).toBe(false);
  });
});

describe('every declared phase is covered by this file', () => {
  /*
   * The assertion that makes the parameterized tests below trustworthy. A new phase must be added to
   * one of the two lists — which is also the moment its copy and its `isCreationPhase` answer get
   * checked, because everything else here iterates them.
   */
  it('leaves no phase untested', () => {
    expect([...DECLARED_STEPS].sort()).toEqual([...COVERED_STEPS].sort());
  });

  /*
   * 🔴 EVERY WORKING PHASE COVERS THE WORKSPACE — asserted over the declared union, not over a list.
   *
   * This is the assertion that survives the next door being found. `coversWorkspace` was twice written
   * as "the phases somebody remembered to enumerate" (a `creating-` prefix, then a membership set), and
   * both times a real phase fell outside it and the workspace filled in full view — most recently
   * `files`, on a mount that ran after the chat had rendered. A test written against the same
   * enumeration cannot notice that; a test written against the union can.
   *
   * `idle` and `failed` are the only two exempt, and they are named here rather than derived, so that
   * exempting a third phase has to be a deliberate edit to this line.
   */
  it('covers the workspace for every declared phase except idle and failed', () => {
    for (const step of DECLARED_STEPS) {
      const phase = { step } as BootPhase;
      expect({ step, covers: coversWorkspace(phase) }).toEqual({
        step,
        covers: step !== 'idle' && step !== 'failed',
      });
    }
  });

  /*
   * And the family rule, read off the names rather than off the lists: `isCreationPhase` is a
   * `startsWith('creating-')` prefix test, so a creation phase filed under `RESUME_PHASES` (or the
   * reverse) would be asserted to behave in exactly the way that breaks it.
   */
  it('files each declared phase in the list its own name puts it in', () => {
    for (const step of DECLARED_STEPS) {
      const inCreationList = CREATION_PHASES.some((phase) => phase.step === step);
      expect(inCreationList).toBe(step.startsWith('creating-'));
    }
  });
});

describe('isCreationPhase — the creation family', () => {
  it('recognises every creation phase', () => {
    for (const phase of CREATION_PHASES) {
      expect(isCreationPhase(phase)).toBe(true);
    }
  });

  it('never fires for the resume/open phases (they render the full-page BootScreen instead)', () => {
    for (const phase of RESUME_PHASES) {
      expect(isCreationPhase(phase)).toBe(false);
    }
  });

  /*
   * It is no longer the overlay gate, and this pins the distinction that made the split necessary: an
   * import covers the workspace without being a creation. Collapsing the two back together means either
   * calling an import a creation (a lie the copy would then have to keep) or leaving imports uncovered
   * (the bug).
   */
  it('does not claim the import phase', () => {
    for (const phase of OVERLAY_ONLY_PHASES) {
      expect(isCreationPhase(phase)).toBe(false);
    }
  });
});

/**
 * `coversWorkspace` — the actual gate on `WorkspaceSplash`.
 *
 * Its failure mode is the silent one this whole file exists to prevent: a phase it does not recognise
 * draws NO surface, so the user watches the workspace fill a file at a time. That was the reported bug
 * on the mount path (2026-07-31), and an unrecognised phase is how it comes back.
 */
describe('coversWorkspace — the gate on the workspace splash overlay', () => {
  it('covers every creation phase', () => {
    for (const phase of CREATION_PHASES) {
      expect(coversWorkspace(phase)).toBe(true);
    }
  });

  it('covers the import phase, which is not a creation phase', () => {
    for (const phase of OVERLAY_ONLY_PHASES) {
      expect(coversWorkspace(phase)).toBe(true);
    }
  });

  /*
   * 🔴 AND IT COVERS THE RESUME PHASES, which it used to answer `false` for.
   *
   * The old answer encoded an assumption rather than a fact: that a resume phase only ever runs before
   * the chat exists, so the full-page `BootScreen` would be the surface and the overlay was not needed.
   * The mount effect fires more than once per load, so a second mount narrates exactly these phases with
   * the workbench already on screen — measured live at "35 of 86 files", in full view, with nothing over
   * it. There is no double-render risk: the two surfaces are the two arms of `Chat`'s `ready ? … : …`.
   */
  it('covers the resume/open phases too — a second mount runs after the chat is on screen', () => {
    for (const phase of RESUME_PHASES.filter((candidate) => candidate.step !== 'idle')) {
      expect(coversWorkspace(phase)).toBe(true);
    }
  });

  /* Nothing is happening. Covering here would put a permanent spinner over every open project. */
  it('never fires when idle', () => {
    expect(coversWorkspace({ step: 'idle' })).toBe(false);
  });

  /* A failure is drawn as the failure panel, never as progress over a workspace. */
  it('never fires for a failure', () => {
    expect(coversWorkspace({ step: 'failed', message: 'nope', retryable: true })).toBe(false);
  });
});

describe('bootPhaseCopy — every phase has its own words', () => {
  it('gives each phase a distinct title, none of them the idle fallback', () => {
    const idleTitle = bootPhaseCopy({ step: 'idle' }).title;
    const titles = [
      ...CREATION_PHASES,
      ...OVERLAY_ONLY_PHASES,
      ...RESUME_PHASES.filter((phase) => phase.step !== 'idle'),
    ].map((phase) => bootPhaseCopy(phase).title);

    for (const title of titles) {
      expect(title).toBeTruthy();
      expect(title).not.toBe(idleTitle);
    }

    expect(new Set(titles).size).toBe(titles.length);
  });

  /*
   * The last two sentences of creation, and the ones a user is most likely to sit in front of: a cold
   * `npm install` is the long wait, and the dev server binding a port is the moment their own project
   * appears. Both said "Opening project… / Fetching the conversation and project record" before T6 —
   * copy from the RESUME path, describing work that is not happening, on the splash whose entire job
   * is to say what is.
   */
  it('names the install and serve steps rather than falling through to the idle copy', () => {
    const install = bootPhaseCopy({ step: 'creating-install' });
    const serve = bootPhaseCopy({ step: 'creating-serve' });

    expect(install.title.toLowerCase()).toContain('install');
    expect(install.detail).toContain('npm install');
    expect(serve.title.toLowerCase()).toContain('start');
    expect(serve.detail.toLowerCase()).toContain('dev server');

    for (const copy of [install, serve]) {
      expect(copy.title).not.toBe(bootPhaseCopy({ step: 'idle' }).title);
      expect(copy.detail).not.toBe(bootPhaseCopy({ step: 'idle' }).detail);
    }
  });

  it('shows file counts once the scan knows its total', () => {
    expect(bootPhaseCopy({ step: 'files', done: 3, total: 78 }).detail).toBe('3 of 78 files');
  });

  /*
   * The server's OWN words, verbatim. "Sandbox provider is not configured", "Too many sandboxes
   * started on this account" and "Could not reach the sandbox provider" each name a different action
   * behind them, and a generic "something went wrong" throws all of that away at the one moment it
   * matters.
   */
  it('shows the failure’s own message rather than a generic apology', () => {
    const copy = bootPhaseCopy({ step: 'failed', message: 'Sandbox provider is not configured.', retryable: false });

    expect(copy.detail).toBe('Sandbox provider is not configured.');
    expect(copy.title).not.toBe(bootPhaseCopy({ step: 'idle' }).title);
  });

  /** A failure is not a creation step — it must never be drawn as the creation splash's progress. */
  it('does not treat a failure as a creation phase', () => {
    expect(isCreationPhase({ step: 'failed', message: 'nope', retryable: true })).toBe(false);
  });
});

describe('the failed phase is terminal', () => {
  beforeEach(() => {
    bootProgress.set({ step: 'idle' });
    bootRetry.set(undefined);
  });

  /*
   * 🔴 The mount path resets the phase in a `finally`, because a stale phase on the next open would
   * narrate work that is not happening. But a failure is the OUTCOME, not a leftover: clearing it
   * takes the boot screen down over an empty workbench with nothing on it explaining why, which is
   * the pre-fix behaviour (`logger.warn` + `setReady(true)`) this phase replaced.
   */
  it('endBootPhase clears a working phase but never a failure', () => {
    bootProgress.set({ step: 'sandbox' });
    endBootPhase();
    expect(bootProgress.get()).toEqual({ step: 'idle' });

    reportBootFailure({ message: 'Could not reach the sandbox provider.', retryable: true });
    endBootPhase();

    /* Still failed, and still carrying the message the user is reading. */
    expect(bootProgress.get()).toEqual({
      step: 'failed',
      message: 'Could not reach the sandbox provider.',
      retryable: true,
    });
  });

  /*
   * The retry action is registered only when a retry could plausibly work. A "Try again" button on an
   * unretryable failure ("this tab is bound to another project — reload") is a lie the user presses
   * repeatedly, and the honest instruction is already in the message.
   */
  it('registers the retry action only for a retryable failure', () => {
    const retry = vi.fn();

    reportBootFailure({ message: 'Could not reach the sandbox provider.', retryable: true }, retry);
    expect(bootRetry.get()).toBe(retry);

    reportBootFailure({ message: 'Reload the page to open that project.', retryable: false }, retry);
    expect(bootRetry.get()).toBeUndefined();
  });
});

/**
 * 🔴 AN IMPORT OUTLIVES THE MOUNTS RUNNING BESIDE IT, SO IT CANNOT LIVE IN THE PHASE SLOT.
 *
 * Found live, 2026-07-31, twice. Several components call `useChatHistory`, so several mounts run per
 * page load; each narrates its own phases and then clears to `idle`, while the import's files are
 * still replaying. Written as a phase, the tail and the mounts overwrote each other every few hundred
 * milliseconds and the overlay STROBED (measured: on at 13424ms, off at 13628, on at 13801, off at
 * 14201). Re-asserting the phase on a timer made it strobe more slowly — the same race with a longer
 * period, which is the shape of a fix that is really a workaround.
 *
 * A flag beside the phase removes the contention rather than arbitrating it, and the two are composed
 * by pure functions. These tests are that composition, because the failure mode is not an exception —
 * it is a surface that is not there.
 */
describe('the import flag composes with the phase instead of competing for it', () => {
  beforeEach(() => {
    bootProgress.set({ step: 'idle' });
    bootRetry.set(undefined);
    importTailActive.set(false);
  });

  /* A mount running beside an import has more to say than "importing" does — let it say it. */
  it('shows the running phase when there is one', () => {
    expect(effectiveBootPhase({ step: 'files', done: 3, total: 9 }, true)).toEqual({
      step: 'files',
      done: 3,
      total: 9,
    });
  });

  /* And fills the silence the moment that mount ends, rather than falling back to the idle copy. */
  it('shows importing once the phase goes idle', () => {
    expect(effectiveBootPhase({ step: 'idle' }, true)).toEqual({ step: 'importing' });
    expect(effectiveBootPhase({ step: 'idle' }, false)).toEqual({ step: 'idle' });
  });

  /*
   * 🔴 THE STROBE, pinned. The overlay must stay up across every phase a concurrent mount can be in —
   * reading the phase alone is what made it blink out for as long as the mount was narrating.
   */
  it('keeps the workspace covered through every phase a concurrent mount can reach', () => {
    for (const phase of RESUME_PHASES) {
      expect(shouldCoverWorkspace(phase, true)).toBe(true);
    }
  });

  /*
   * The flag's OWN contribution, isolated: `idle` is the only phase where the answer differs by flag,
   * and it is the one that matters — the replay lands while nothing is narrating. Without this the test
   * above would pass just as happily on a build where the flag were ignored entirely.
   */
  it('CONTROL: idle is covered only because of the flag', () => {
    expect(shouldCoverWorkspace({ step: 'idle' }, true)).toBe(true);
    expect(shouldCoverWorkspace({ step: 'idle' }, false)).toBe(false);
  });

  it('covers the creation phases with or without an import', () => {
    for (const phase of CREATION_PHASES) {
      expect(shouldCoverWorkspace(phase, false)).toBe(true);
      expect(shouldCoverWorkspace(phase, true)).toBe(true);
    }
  });

  /*
   * A failure takes the cover DOWN even mid-import: nothing is arriving any more, and a spinner over a
   * dead workspace hides the one sentence the user needs.
   */
  it('uncovers on a failure, whatever the import flag says', () => {
    const failure: BootPhase = { step: 'failed', message: 'Could not reach the sandbox provider.', retryable: true };

    expect(shouldCoverWorkspace(failure, true)).toBe(false);
    expect(effectiveBootPhase(failure, true)).toEqual(failure);
  });

  /* The flag is plain state with one writer — and it must start down, or every load opens covered. */
  it('defaults to inactive', () => {
    expect(importTailActive.get()).toBe(false);
  });
});
