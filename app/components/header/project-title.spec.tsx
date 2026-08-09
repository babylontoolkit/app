// @vitest-environment jsdom
/**
 * 🔴 THE HEADER TITLE MUST NEVER GO BLANK WITHOUT SAYING WHY (owner report 2026-08-09:
 * *"What happened to the Project Title name on the top header bar?… Sometimes it disappears"*).
 *
 * `ProjectTitle` fetched the project and swallowed every failure with `.catch(() => undefined)`,
 * commented as *"an offline miss leaves the bar empty, exactly as it was before a name arrived"*. That
 * treats a PERMANENT failure as a slow success, and the failure here is not transient:
 * `requireOwnedProject` answers **404, not 403**, for a project that is missing or belongs to someone
 * else (§4.5.3's enumeration-oracle rule), so a project whose server row is gone returns the same
 * answer forever. The component rendered `null` and the one always-visible label naming what you are
 * looking at simply vanished, with nothing anywhere reporting it.
 *
 * MEASURED live: `GET /api/projects/prj_20260808175334_11t7jmh1` → `404 {"message":"That project does
 * not exist."}` for a project the browser still held with six local checkpoints, while a project
 * created after the server store was reset rendered its title normally — same build, same header,
 * which is exactly why it presents as intermittent.
 *
 * It matters past the label: a project the server cannot resolve also cannot be renamed, shared,
 * deployed, or given a §4.5.4c working copy. A blank bar hides a half-dead project behind what looks
 * like a cosmetic gap.
 *
 * The three states are asserted separately because the bug was precisely that two of them were one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { atom } from 'nanostores';

/*
 * `~/lib/persistence` boots the sandbox as an import side effect (the `sandbox-seam` rule), so it is
 * stubbed. The atom is created INSIDE the factory: `vi.mock` is hoisted above every import, so a
 * factory closing over a top-level binding throws at collect time.
 */
vi.mock('~/lib/persistence', () => ({ projectId: atom<string | undefined>('prj_test') }));

const getProject = vi.fn();
const renameProject = vi.fn();

vi.mock('~/lib/persistence/projects', () => ({
  getProject: (...args: unknown[]) => getProject(...args),
  renameProject: (...args: unknown[]) => renameProject(...args),
}));

vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));

const { ProjectTitle } = await import('./ProjectTitle.client');

/** A promise that never settles — the genuine "still asking" state. */
const pending = () => new Promise(() => undefined);

describe('ProjectTitle', () => {
  beforeEach(() => {
    getProject.mockReset();
    renameProject.mockReset();
  });

  afterEach(cleanup);

  it('renders the project name once it resolves', async () => {
    getProject.mockResolvedValue({ name: 'Mario Kart Racer Clone' });

    render(<ProjectTitle />);

    expect(await screen.findByText('Mario Kart Racer Clone')).toBeTruthy();
  });

  /*
   * A fallback label flashed on every open would be a worse lie than a brief gap, and this state
   * always resolves — so "still asking" is the ONE case that may legitimately render nothing.
   */
  it('renders nothing while the fetch is still in flight', () => {
    getProject.mockReturnValue(pending());

    const { container } = render(<ProjectTitle />);

    expect(container.textContent).toBe('');
  });

  /*
   * THE REGRESSION. Before the fix this rendered `null` — identical to the pending state above — and
   * the header silently lost its title.
   */
  it('says so when the project cannot be loaded, instead of going blank', async () => {
    getProject.mockRejectedValue(Object.assign(new Error('That project does not exist.'), { status: 404 }));

    render(<ProjectTitle />);

    expect(await screen.findByText(/project unavailable/i)).toBeTruthy();
  });

  /*
   * Renaming posts to the same project the server just refused to resolve, so the pencil could only
   * ever produce an error toast. Offering a control that cannot work is §4.1a's dead-end rule.
   */
  it('offers no rename control when the project is unavailable', async () => {
    getProject.mockRejectedValue(new Error('nope'));

    const { container } = render(<ProjectTitle />);

    await screen.findByText(/project unavailable/i);
    expect(container.querySelector('button')).toBeNull();
  });

  /*
   * CONTROL — without this, every assertion above passes for a component that renders "Project
   * unavailable" unconditionally, which is the same bug pointing the other way.
   */
  it('CONTROL: a resolved project shows its name and its rename control, not the failure text', async () => {
    getProject.mockResolvedValue({ name: '3d Pac Man' });

    const { container } = render(<ProjectTitle />);

    await screen.findByText('3d Pac Man');
    expect(screen.queryByText(/project unavailable/i)).toBeNull();

    await waitFor(() => expect(container.querySelector('button')).not.toBeNull());
  });

  /* A row with no name is as unusable as one that failed, and it reaches the user the same way. */
  it('treats a project that resolves with an empty name as unavailable', async () => {
    getProject.mockResolvedValue({ name: '' });

    render(<ProjectTitle />);

    expect(await screen.findByText(/project unavailable/i)).toBeTruthy();
  });
});
