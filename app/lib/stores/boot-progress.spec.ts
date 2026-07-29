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
