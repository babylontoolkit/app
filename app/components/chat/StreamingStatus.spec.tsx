// @vitest-environment jsdom
/**
 * The render line on the live status indicator (§4.16 + SPEC §4.2a).
 *
 * Reported as the product "spinning for nothing, burning credits". Half of that was the unnamed provider
 * retry (`agent/heartbeat.ts`); the other half is this: media generation is ASYNC-ENQUEUE, so the tool
 * call returns in milliseconds while the picture takes 20–60s at KIE. The heartbeat has stopped, the
 * message is finished, and the only thing still happening — the art the user asked for — was invisible.
 *
 * 🔴 THE BRANCH THAT MATTERS IS THE FALLBACK ONE. A render routinely outlives the whole generation, so by
 * the time it is the only work left there is no fresh heartbeat and `StreamingStatus` is rendering plain
 * dots. A render line that lived only inside the heartbeat panel would be hidden during exactly the
 * stretch it exists to explain — which is the bug, not the fix. These drive the REAL component, because
 * "is it rendered in both branches" is a wiring fact a pure test of the string builder cannot see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { atom } from 'nanostores';
import { vi } from 'vitest';

/*
 * `~/lib/media/tasks` transitively pulls the workbench store and `~/utils/constants` (the whole LLM
 * manager). The component reads exactly one atom from it.
 */
const holder = vi.hoisted(() => ({
  store: null as unknown as ReturnType<typeof atom<{ images: number; videos: number }>>,
}));
vi.mock('~/lib/media/tasks', () => ({
  get mediaRenderStore() {
    return holder.store;
  },
}));

import { agentStatusStore, resetAgentStatus, updateAgentStatus } from '~/lib/stores/agent-status';
import { activeSkillsStore } from '~/lib/stores/active-skills';
import { StreamingStatus } from './StreamingStatus';

function renders(images: number, videos: number) {
  holder.store.set({ images, videos });
}

/** A heartbeat that arrived just now — the panel branch. Absent → the fallback dots branch. */
function liveHeartbeat() {
  updateAgentStatus({ type: 'agent-status', generationId: 'gen-1', seq: 1, phase: 'thinking', elapsedMs: 5000 });
}

beforeEach(() => {
  holder.store = atom({ images: 0, videos: 0 });
  resetAgentStatus();
  activeSkillsStore.set(null);
});

afterEach(() => cleanup());

describe('StreamingStatus — the render line', () => {
  describe('the FALLBACK (no heartbeat) branch — a render outliving the generation', () => {
    it('names the renders still in flight', () => {
      renders(2, 0);
      render(<StreamingStatus />);

      expect(agentStatusStore.get()).toBeNull(); // the branch under test really is the fallback one
      expect(screen.getByText('Generating 2 images…')).toBeInTheDocument();
    });

    /*
     * CONTROL: the same branch with nothing rendering shows NO line. Without this, the assertion above
     * passes for a component that always prints something.
     */
    it('says nothing when no render is in flight', () => {
      renders(0, 0);
      render(<StreamingStatus />);

      expect(screen.queryByText(/Generating/)).not.toBeInTheDocument();
    });
  });

  it('also shows in the heartbeat PANEL branch — a render commissioned mid-turn', () => {
    renders(1, 0);
    liveHeartbeat();
    render(<StreamingStatus />);

    expect(screen.getByText(/Working on your changes —/)).toBeInTheDocument(); // the panel is up
    expect(screen.getByText('Generating 1 image…')).toBeInTheDocument();
  });

  describe('pluralisation', () => {
    const cases: Array<[number, number, string]> = [
      [1, 0, 'Generating 1 image…'],
      [3, 0, 'Generating 3 images…'],
      [0, 1, 'Generating 1 video…'],
      [0, 2, 'Generating 2 videos…'],
      [1, 1, 'Generating 1 image and 1 video…'],
      [2, 3, 'Generating 2 images and 3 videos…'],
    ];

    it.each(cases)('%i images / %i videos → %s', (images, videos, expected) => {
      renders(images, videos);
      render(<StreamingStatus />);

      expect(screen.getByText(expected)).toBeInTheDocument();
    });
  });
});

/**
 * The expectation bar and the delivery note reach the DOM (2026-08-03).
 *
 * `agent-status.spec.ts` proves the strings and the fraction are correct; these prove they are
 * actually RENDERED. That gap is where this repo keeps finding its defects — the §4.14 relay and the
 * §4.5.6 chat work were both "correct by construction" with green unit suites and broken wiring — and
 * it is a live risk here specifically because the new values arrive by destructuring, where a typo or
 * a forgotten field costs nothing at typecheck and simply renders nothing.
 */
describe('StreamingStatus — what the user reads during a long silence', () => {
  /** A batched-provider heartbeat mid-creation: the reported 2026-08-03 turn, at three minutes in. */
  function batchedCreation(elapsedMs = 180_000, silentMs = 180_000) {
    updateAgentStatus({
      type: 'agent-status',
      generationId: 'gen-1',
      seq: 1,
      phase: 'thinking',
      kind: 'creation',
      elapsedMs,
      silentMs,
      deliveryMode: 'batched',
      typicalMs: 300_000,
    });
  }

  it('renders the explanation for a silence the user cannot otherwise interpret', () => {
    batchedCreation();
    render(<StreamingStatus />);

    expect(screen.getByText(/one batch/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is stuck/i)).toBeInTheDocument();
  });

  it('renders the baseline caption, so elapsed time means something', () => {
    batchedCreation();
    render(<StreamingStatus />);

    expect(screen.getByText('usually about 5m')).toBeInTheDocument();
    expect(screen.getByText(/Building your project — 3m 0s/)).toBeInTheDocument();
  });

  it('draws a bar that is part-full — and never full', () => {
    batchedCreation();

    const { container } = render(<StreamingStatus />);

    const bar = container.querySelector('[style*="width"]') as HTMLElement | null;
    expect(bar).not.toBeNull();

    const width = Number.parseInt(bar!.style.width, 10);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(100);
  });

  it('says it is still connected once past the baseline, instead of predicting', () => {
    batchedCreation(600_000, 600_000);
    render(<StreamingStatus />);

    expect(screen.getByText(/longer than usual — still connected/)).toBeInTheDocument();
  });

  /*
   * CONTROL. Without this, every assertion above would still pass if the component rendered the note
   * unconditionally — which would put "your provider sends everything at the end" on a provider that
   * streams, i.e. tell the user to stop expecting the output they are about to receive.
   */
  it('CONTROL: a streaming provider gets no batch explanation at all', () => {
    updateAgentStatus({
      type: 'agent-status',
      generationId: 'gen-2',
      seq: 1,
      phase: 'thinking',
      kind: 'creation',
      elapsedMs: 180_000,
      silentMs: 180_000,
      deliveryMode: 'streamed',
      typicalMs: 300_000,
    });
    render(<StreamingStatus />);

    expect(screen.queryByText(/one batch/i)).not.toBeInTheDocument();
  });

  /* CONTROL: an older server sends no baseline, and the panel must fall back to exactly its old shape. */
  it('CONTROL: no baseline from the server means no bar and no caption', () => {
    updateAgentStatus({
      type: 'agent-status',
      generationId: 'gen-3',
      seq: 1,
      phase: 'thinking',
      kind: 'creation',
      elapsedMs: 180_000,
      silentMs: 180_000,
    });

    const { container } = render(<StreamingStatus />);

    expect(container.querySelector('[style*="width"]')).toBeNull();
    expect(screen.queryByText(/usually about/)).not.toBeInTheDocument();
  });
});
