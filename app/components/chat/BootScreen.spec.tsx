// @vitest-environment jsdom
/**
 * What the boot surface DRAWS for a phase — specifically, which phases get a progress bar.
 *
 * `bootPhaseCopy` is pure and pinned to death in `boot-progress.spec.ts`, but the bar is not copy: it
 * is a rule that lives in this component (`fraction` is non-null only for `files` with `done`/`total`)
 * and nowhere else. The store-level spec can assert the necessary half — a phase carrying no
 * `done`/`total` cannot produce one — and is structurally incapable of asserting the sufficient half,
 * because re-typing the component's predicate over there would pin the spec's MEMORY of the renderer
 * rather than the renderer. That is the shape of the `retryThinkingMode` defect: two sides of one seam
 * each correctly documented in isolation, disagreeing about the thing between them.
 *
 * 🔴 THE RULE THIS PROTECTS: `branch-install` gets NO bar and the elapsed clock instead. `npm install`
 * emits no structured progress, so any bar drawn here would be invented — it would fill, reach the end,
 * and keep spinning, which converts "slow" into "stuck". That is the despair the whole surface exists
 * to prevent, and it is the same rule the batched-delivery expectation bar is capped for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { bootProgress, importTailActive, type BootPhase } from '~/lib/stores/boot-progress';
import { WorkspaceSplash } from './BootScreen';

/**
 * The bar's FILL — the one element `fraction !== null` puts on the page.
 *
 * Matched on `bg-bolt-elements-loader-progress`, which is the fill and only the fill: the spinner
 * beside it carries `text-bolt-elements-loader-progress`, a different class. A class query can go
 * silently vacuous if the class is renamed, which is exactly why every "no bar" assertion below is
 * paired with the `files` control that proves the query can still FIND one.
 */
function progressBars(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('.bg-bolt-elements-loader-progress')];
}

function draw(phase: BootPhase) {
  bootProgress.set(phase);

  return render(<WorkspaceSplash />).container;
}

describe('the boot surface draws a progress bar only where there is real progress to report', () => {
  beforeEach(() => {
    bootProgress.set({ step: 'idle' });
    importTailActive.set(false);
  });

  afterEach(() => {
    cleanup();
    bootProgress.set({ step: 'idle' });
  });

  /*
   * 🔴 THE CONTROL FIRST, because without it every assertion below passes on a component that draws no
   * bar for anything — or on a query that matches nothing at all. `files` is the one phase that knows
   * a real numerator and denominator (`restoreFiles`' `onProgress`), and it is the phase the branch
   * flow reuses for its own file-writing step rather than inventing a parallel one.
   */
  it('CONTROL: draws a bar for the files phase, which has a real count', () => {
    const container = draw({ step: 'files', done: 3, total: 9 });

    expect(progressBars(container)).toHaveLength(1);
    expect(screen.getByText('3 of 9 files')).toBeInTheDocument();
  });

  /* And not even for `files` until the scan knows its total — a bar with no denominator is a guess. */
  it('draws no bar for the files phase before the count is known', () => {
    expect(progressBars(draw({ step: 'files' }))).toHaveLength(0);
  });

  it('draws no bar while reinstalling dependencies for a new branch', () => {
    const container = draw({ step: 'branch-install' });

    /* Rendered, and rendered as this phase — or "no bar" would be true of a blank page. */
    expect(screen.getByText('Reinstalling project dependencies')).toBeInTheDocument();
    expect(progressBars(container)).toHaveLength(0);
  });

  /*
   * The other branch phases, for the same reason: reading a branch from the provider, resetting to a
   * commit, pulling, and waiting for a port to bind are all waits with no countable unit. The elapsed
   * clock (automatic, after 5s) is the honest signal for all of them.
   *
   * ⚠️ `pulling` joined this list LATE — it was added to the union in T18 and this table still said
   * "the other three". A table that enumerates the phases somebody thought of cannot cover the one
   * they added afterwards, which is exactly how the Pull ended up narrated as a switch.
   */
  it.each<[string, BootPhase]>([
    ['switching-branch', { step: 'switching-branch', branch: 'feature/boost-pads' }],
    ['discarding', { step: 'discarding', branch: 'feature/boost-pads' }],
    ['pulling', { step: 'pulling', branch: 'feature/boost-pads' }],
    ['branch-serve', { step: 'branch-serve' }],
  ])('draws no bar for %s', (_step, phase) => {
    expect(progressBars(draw(phase))).toHaveLength(0);
  });

  /*
   * The branch phases are overlay-only (§4.13a): they are entered from a workspace the user is already
   * looking at, so `ready` is true and `WorkspaceSplash` is the surface that actually draws them. If
   * `shouldCoverWorkspace` stopped recognising one, this component would return `null` — no copy, no
   * spinner, and the workspace visibly rewriting itself underneath, which is the reported bug the
   * `coversWorkspace` rewrite was for.
   */
  it('renders at all for a branch phase, naming the branch', () => {
    draw({ step: 'switching-branch', branch: 'feature/boost-pads' });
    expect(screen.getByText(/feature\/boost-pads/)).toBeInTheDocument();
  });
});
