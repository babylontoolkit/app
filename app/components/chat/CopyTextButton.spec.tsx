// @vitest-environment jsdom
/**
 * THE COPY BUTTON (owner, 2026-08-09).
 *
 * Two things are worth a test here, and neither is "does it call `writeText`":
 *
 *   1. **A failure is not reported as a success.** `navigator.clipboard` is undefined outside a secure
 *      context and `writeText` rejects when the permission is denied. The obvious implementation flips
 *      to a green checkmark first and writes second, so both failures render as "Copied" over an empty
 *      clipboard — the user pastes nothing and has no idea which end broke.
 *   2. **It is reachable from the keyboard.** The button is hidden with `opacity`, never `hidden`, so
 *      it stays in the tab order; the day someone "tidies" that into `hidden` or `display:none` the
 *      button silently stops existing for anyone not using a mouse, and no visual check would notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toasts }));

import { CopyTextButton } from './CopyTextButton';

const button = () => screen.getByRole('button');

function withClipboard(writeText: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value: writeText ? { writeText } : undefined, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('CopyTextButton', () => {
  it('writes the given text and reports it', async () => {
    const writeText = vi.fn(async () => undefined);
    withClipboard(writeText);

    render(<CopyTextButton text="/bt-execute _specs/kart_plan.md ALL" />);
    fireEvent.click(button());

    expect(writeText).toHaveBeenCalledWith('/bt-execute _specs/kart_plan.md ALL');
    await waitFor(() => expect(button()).toHaveAccessibleName('Copied'));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  /* 🔴 A rejected write must not leave a checkmark over an empty clipboard. */
  it('reports a rejected write instead of claiming success', async () => {
    withClipboard(vi.fn(async () => Promise.reject(new Error('denied'))));

    render(<CopyTextButton text="hello" />);
    fireEvent.click(button());

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(button()).toHaveAccessibleName('Copy message');
  });

  /* Same, for the browser that has no clipboard API at all (any non-secure context). */
  it('reports a missing clipboard API instead of throwing', async () => {
    withClipboard(undefined);

    render(<CopyTextButton text="hello" />);

    expect(() => fireEvent.click(button())).not.toThrow();
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(button()).toHaveAccessibleName('Copy message');
  });

  /*
   * Hidden by OPACITY, so it is still focusable. `hidden`/`display:none` would look identical on screen
   * and remove it from the tab order entirely.
   */
  it('stays reachable from the keyboard while it is visually hidden', () => {
    withClipboard(vi.fn(async () => undefined));
    render(<CopyTextButton text="hello" />);

    expect(button().className).toContain('opacity-0');
    expect(button().className).toContain('group-hover:opacity-100');
    expect(button().className).toContain('focus-visible:opacity-100');
    expect(button()).not.toHaveAttribute('hidden');

    button().focus();
    expect(document.activeElement).toBe(button());
  });
});
