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
