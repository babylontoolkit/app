/**
 * The boot/creation phase store behind `BootScreen` and `CreationSplash`.
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
  endBootPhase,
  isCreationPhase,
  reportBootFailure,
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
];

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

describe('isCreationPhase — the gate on the creation splash overlay', () => {
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
});

describe('bootPhaseCopy — every phase has its own words', () => {
  it('gives each phase a distinct title, none of them the idle fallback', () => {
    const idleTitle = bootPhaseCopy({ step: 'idle' }).title;
    const titles = [...CREATION_PHASES, ...RESUME_PHASES.filter((phase) => phase.step !== 'idle')].map(
      (phase) => bootPhaseCopy(phase).title,
    );

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
