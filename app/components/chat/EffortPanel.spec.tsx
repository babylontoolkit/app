// @vitest-environment jsdom
/**
 * The effort control, rendered (`_specs/effort-selector_plan.md` T8, D7, D11).
 *
 * The panel is a notched slider over the levels THIS deploy offers — three by default (Medium · High ·
 * Extra high), four when the operator switches Max on, and never Low. The pill beside the model pill is
 * the always-visible readout, and its width must not depend on the level (§4.1a: a right-aligned toolbar
 * must not resize).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { EffortPanel } from './EffortPanel';
import { EFFORT_PILL_CLASS, EffortPill } from './EffortPill';
import { baseEffortStore, effortPanelOpen, setBaseEffort } from '~/lib/stores/effort';
import { EMPTY_SESSION, sessionStore } from '~/lib/stores/session';
import { DEFAULT_OFFERED_EFFORT_LEVELS, EFFORT_LEVELS } from '~/lib/modules/llm/capabilities';

function session(levels: readonly string[], agentEngine: 'managed' | 'legacy' = 'managed') {
  sessionStore.set({ ...EMPTY_SESSION, loading: false, agentEngine, effortLevels: levels as never });
}

function openPanel() {
  render(<EffortPanel />);
  act(() => effortPanelOpen.set(true));
}

function notches() {
  return within(screen.getByRole('radiogroup', { name: 'Thinking effort' })).getAllByRole('radio');
}

beforeEach(() => {
  window.localStorage.clear();
  session(DEFAULT_OFFERED_EFFORT_LEVELS);
  setBaseEffort('medium');
  effortPanelOpen.set(false);
});

afterEach(() => {
  cleanup();
  effortPanelOpen.set(false);
  window.localStorage.clear();
});

describe('EffortPanel — the notches are the offered levels', () => {
  it('renders nothing but its anchor while closed', () => {
    render(<EffortPanel />);

    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('shows 3 notches by default — Medium, High, Extra high; no Low, no Max', () => {
    openPanel();

    expect(notches().map((notch) => notch.textContent)).toEqual(['Medium', 'High', 'Extra high']);
    expect(screen.queryByText('Low')).toBeNull();
    expect(screen.queryByText('Max')).toBeNull();
  });

  it('shows 4 notches when the deploy offers Max', () => {
    session(EFFORT_LEVELS);
    openPanel();

    expect(notches().map((notch) => notch.textContent)).toEqual(['Medium', 'High', 'Extra high', 'Max']);
  });

  it('marks the current level as the checked notch, and only it is a tab stop', () => {
    setBaseEffort('high');
    openPanel();

    const [medium, high, xhigh] = notches();
    expect(high).toHaveAttribute('aria-checked', 'true');
    expect(medium).toHaveAttribute('aria-checked', 'false');
    expect(xhigh).toHaveAttribute('aria-checked', 'false');
    expect(high).toHaveAttribute('tabindex', '0');
    expect(medium).toHaveAttribute('tabindex', '-1');
  });

  it('every notch is a real button (type="button"), so it can never submit the composer form', () => {
    openPanel();

    for (const notch of notches()) {
      expect(notch).toHaveAttribute('type', 'button');
    }
  });
});

describe('EffortPanel — choosing', () => {
  it('clicking a notch sets the store and the description follows', () => {
    openPanel();

    fireEvent.click(screen.getByRole('radio', { name: 'Extra high' }));

    expect(baseEffortStore.get()).toBe('xhigh');
    expect(screen.getByTestId('effort-description')).toHaveTextContent(/hard bugs and big systems/);
    expect(screen.getByTestId('effort-description')).toHaveTextContent(/more credits per turn/);
  });

  it('ArrowRight moves the selection one notch up, ArrowLeft back down', () => {
    openPanel();

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Medium' }), { key: 'ArrowRight' });
    expect(baseEffortStore.get()).toBe('high');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'High' }), { key: 'ArrowRight' });
    expect(baseEffortStore.get()).toBe('xhigh');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Extra high' }), { key: 'ArrowLeft' });
    expect(baseEffortStore.get()).toBe('high');
  });

  it('ArrowRight at the top notch stays there — it never walks onto a level the deploy does not offer', () => {
    setBaseEffort('xhigh');
    openPanel();

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Extra high' }), { key: 'ArrowRight' });

    expect(baseEffortStore.get()).toBe('xhigh');
  });

  it('Home and End jump to the ends', () => {
    openPanel();

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Medium' }), { key: 'End' });
    expect(baseEffortStore.get()).toBe('xhigh');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Extra high' }), { key: 'Home' });
    expect(baseEffortStore.get()).toBe('medium');
  });

  it('Escape closes it', () => {
    openPanel();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(effortPanelOpen.get()).toBe(false);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('says a change starts a fresh agent session on the managed engine', () => {
    openPanel();

    expect(screen.getByText(/starts a fresh agent session on your next message/)).toBeInTheDocument();
  });

  it('CONTROL — no session note on the legacy engine, where effort is per turn', () => {
    session(DEFAULT_OFFERED_EFFORT_LEVELS, 'legacy');
    openPanel();

    expect(screen.queryByText(/fresh agent session/)).toBeNull();
  });

  it('no longer claims the choice resets each session (it persists now)', () => {
    openPanel();

    expect(screen.queryByText(/Resets to Medium/)).toBeNull();
  });
});

describe('EffortPill — the always-visible readout', () => {
  it('names the current level in its accessible name and toggles the panel', () => {
    setBaseEffort('high');
    render(<EffortPill />);

    const pill = screen.getByRole('button', { name: 'Thinking effort: High' });
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    expect(pill).toHaveAttribute('type', 'button');

    fireEvent.click(pill);
    expect(effortPanelOpen.get()).toBe(true);
    expect(pill).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(pill);
    expect(effortPanelOpen.get()).toBe(false);
  });

  /*
   * The row-width pin. jsdom has no layout, so the honest static assertion is the mechanism: the class
   * string does not depend on the level, and EVERY label is rendered into the sizer (only the current
   * one visible) — so the pill is as wide as the widest label whatever is selected. Measured live too.
   */
  it('its class string and its sizer do not change with the level', () => {
    const seen: Array<{ className: string; labels: string[] }> = [];

    for (const level of ['medium', 'xhigh', 'high'] as const) {
      setBaseEffort(level);

      const { unmount } = render(<EffortPill />);
      const pill = screen.getByRole('button', { name: /^Thinking effort:/ });
      const sizer = screen.getByTestId('effort-pill-label');

      seen.push({
        className: pill.className,
        labels: Array.from(sizer.children).map((child) => child.textContent ?? ''),
      });
      unmount();
    }

    expect(new Set(seen.map((entry) => entry.className)).size).toBe(1);
    expect(seen[0].className).toContain(EFFORT_PILL_CLASS);

    for (const entry of seen) {
      expect(entry.labels).toEqual(['Medium', 'High', 'Extra high', 'Max']);
    }
  });

  it('only the current label is visible', () => {
    setBaseEffort('xhigh');
    render(<EffortPill />);

    const sizer = screen.getByTestId('effort-pill-label');
    const visible = Array.from(sizer.children).filter((child) => child.className.includes(' visible'));

    expect(visible.map((child) => child.textContent)).toEqual(['Extra high']);
  });

  describe('compact (the open-project row — measured: no room for a label)', () => {
    it('renders a meter with one bar per offered level, filled up to the current one', () => {
      setBaseEffort('high');
      render(<EffortPill compact />);

      const bars = Array.from(screen.getByTestId('effort-pill-meter').children);
      expect(bars.map((bar) => bar.getAttribute('data-filled'))).toEqual(['true', 'true', 'false']);
      expect(screen.queryByTestId('effort-pill-label')).toBeNull();
    });

    it('shows four bars when Max is offered', () => {
      session(EFFORT_LEVELS);
      setBaseEffort('max');
      render(<EffortPill compact />);

      const bars = Array.from(screen.getByTestId('effort-pill-meter').children);
      expect(bars.map((bar) => bar.getAttribute('data-filled'))).toEqual(['true', 'true', 'true', 'true']);
    });

    it('still names the level in its accessible name and tooltip', () => {
      setBaseEffort('xhigh');
      render(<EffortPill compact />);

      const pill = screen.getByRole('button', { name: 'Thinking effort: Extra high' });
      expect(pill).toHaveAttribute('title', expect.stringContaining('Extra high'));
    });

    it('its meter box is a fixed width whatever the level or the offered list', () => {
      const boxes = new Set<string>();

      for (const [levels, level] of [
        [DEFAULT_OFFERED_EFFORT_LEVELS, 'medium'],
        [DEFAULT_OFFERED_EFFORT_LEVELS, 'xhigh'],
        [EFFORT_LEVELS, 'max'],
      ] as const) {
        session(levels);
        setBaseEffort(level);

        const { unmount } = render(<EffortPill compact />);
        boxes.add(screen.getByTestId('effort-pill-meter').className);
        boxes.add(screen.getByRole('button').className);
        unmount();
      }

      expect(boxes.size).toBe(2);
      expect([...boxes].some((cls) => cls.includes('w-[18px]'))).toBe(true);
    });
  });
});
