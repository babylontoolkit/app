/**
 * The boot/creation phase store behind `BootScreen` and `CreationSplash`.
 *
 * Two silent failure modes pinned here: a phase `isCreationPhase` does not recognise means the
 * creation splash never shows for it (back to the blank screen it exists to replace), and a phase
 * `bootPhaseCopy` has no case for falls through to the generic "Opening project…" copy — wrong
 * words on a surface whose whole job is to say what is actually happening.
 */
import { describe, expect, it } from 'vitest';
import { bootPhaseCopy, isCreationPhase, type BootPhase } from './boot-progress';

const CREATION_PHASES: BootPhase[] = [
  { step: 'creating-starter' },
  { step: 'creating-workspace' },
  { step: 'creating-mount' },
  { step: 'creating-finalize' },
];

const RESUME_PHASES: BootPhase[] = [{ step: 'idle' }, { step: 'sandbox' }, { step: 'files' }, { step: 'prepare' }];

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
});
