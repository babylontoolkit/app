// @vitest-environment jsdom
/**
 * THE REVIEW AND HISTORY DIALOGS (§4.13a, T19 scope gap).
 *
 * These two surfaces were named in T19's plan text, built last, and are the only consumers of two
 * fully-tested cores — `compareTrees` and `listCommits`. A core with no consumer is worth nothing, and
 * a consumer that renders it dishonestly is worth less than nothing, because every failure available
 * here produces a **confident wrong answer** rather than an error:
 *
 *   - 🔴 a **capped** list that does not admit it is capped reads as completeness. `DIFF_MAX_FILES`
 *     exists precisely because refusing to show a list is worse than truncating one — and a silent
 *     truncation is worse than both. The cap's own comment says so; only a test can enforce it;
 *   - **loading is not empty** (`BranchList`'s rule, one file up). "Nothing has changed" shown while
 *     the comparison is still running is the same sentence as a clean tree, on the screen a user opens
 *     to decide whether to publish;
 *   - a **binary** row that offers a text diff offers something nobody can read;
 *   - 🔴 **"Load more" that REPLACES the list** is a pager pretending to be one. The list even grows
 *     and shrinks plausibly, and the user simply never sees the older commits.
 *
 * ## Driving them
 *
 * The dialogs are rendered directly, with `load` as the seam — that is the whole contract between them
 * and `useBranchActions`, whose own suite drives the real hook. Radix's `Dialog` portals its content,
 * so every query goes through `screen` (the document) rather than the render result.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TreeDiff } from '~/lib/persistence/tree-diff';
import type { CommitSummary } from '~/lib/persistence/projects';
import { BranchHistoryDialog, ReviewChangesDialog } from './BranchDialogs.client';

afterEach(() => cleanup());

const onClose = vi.fn();

const CHANGES: TreeDiff = {
  changes: [
    { path: 'public/logo.png', status: 'modified', bytes: { from: 4096, to: 8192 }, isBinary: true },
    { path: 'src/gone.ts', status: 'deleted', bytes: { from: 20 }, isBinary: false },
    { path: 'src/scripts/Boost.ts', status: 'added', bytes: { to: 900 }, isBinary: false },
  ],
};

/** Render the review dialog with a `load` that resolves to `diff`, and wait for the read to settle. */
async function review(diff: TreeDiff | undefined, extra: { compareUrl?: string } = {}) {
  const load = vi.fn(async () => diff);

  render(<ReviewChangesDialog open onClose={onClose} load={load} branch="feature/boost-pads" {...extra} />);

  await waitFor(() => expect(load).toHaveBeenCalled());

  return load;
}

describe('Review changes — what am I about to publish?', () => {
  /**
   * Each status carries its own WORD, not a colour. The tones are `text-green-500`/`text-amber-500`/
   * the error token, and a row distinguished only by colour is distinguished for nobody using a
   * screen reader and for a good fraction of everyone else.
   */
  it('renders added, modified and deleted rows with distinguishable labels', async () => {
    await review(CHANGES);

    await waitFor(() => expect(screen.getByText('src/scripts/Boost.ts')).toBeTruthy());

    expect(screen.getByText('public/logo.png')).toBeTruthy();
    expect(screen.getByText('src/gone.ts')).toBeTruthy();

    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.getByText('Removed')).toBeTruthy();
  });

  /**
   * 🔴 A TRUNCATED LIST SAYS SO, WITH HONEST COUNTS — both numbers, because either one alone is
   * unreadable: "showing the first 500" does not say of how many, and "1200 changed files" beside a
   * list of 500 does not say the list is short. The failure this guards is not a crash; it is a user
   * publishing 700 files they were never shown, having read a list that looked complete.
   */
  it('says the list is truncated, and names both counts', async () => {
    await review({ changes: CHANGES.changes, truncated: { shown: 500, total: 1200 } });

    const note = await screen.findByText(/Showing the first/);

    expect(note.textContent).toContain('500');
    expect(note.textContent).toContain('1200');
  });

  /** The CONTROL: an ordinary, uncapped diff must not claim to be truncated. */
  it('CONTROL — an uncapped list says nothing about truncation', async () => {
    await review(CHANGES);

    await waitFor(() => expect(screen.getByText('src/gone.ts')).toBeTruthy());
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  /** The overflow link goes to the provider's own compare view, for the rows the cap dropped. */
  it('offers the provider compare view when there is one', async () => {
    await review(
      { changes: CHANGES.changes, truncated: { shown: 500, total: 1200 } },
      { compareUrl: 'https://github.com/jane/space-racer/compare/main...feature/boost-pads' },
    );

    expect(await screen.findByRole('button', { name: /See them all/ })).toBeTruthy();
  });

  /**
   * An empty diff is a SENTENCE. An empty box is indistinguishable from a dialog that failed to
   * render its list, and the user's next move — publish, or go looking for a bug — depends entirely
   * on which of those it is.
   */
  it('says nothing has changed rather than rendering an empty box', async () => {
    await review({ changes: [] });

    const message = await screen.findByText(/Nothing has changed/);

    expect(message.textContent).toContain('feature/boost-pads');
  });

  /**
   * 🔴 LOADING IS NOT EMPTY — `BranchList`'s rule, and it matters more here. "Nothing has changed" is
   * the exact sentence a clean tree gets, so showing it during the comparison tells the user their
   * work is already published. The comparison reads binaries over sandbox round trips, so this window
   * is real time on an asset-heavy project, not a frame.
   */
  it('says it is comparing while it reads, and does NOT say nothing has changed', async () => {
    /*
     * A `load` that never settles — the executor never resolves — so the dialog is pinned in its
     * loading state for the duration of the assertion.
     */
    const load = vi.fn(() => new Promise<TreeDiff | undefined>(() => undefined));

    render(<ReviewChangesDialog open onClose={onClose} load={load} branch="feature/boost-pads" />);

    expect(await screen.findByText(/Comparing…/)).toBeTruthy();
    expect(screen.queryByText(/Nothing has changed/)).toBeNull();
  });

  /**
   * A binary row shows SIZES. There is no text diff of a PNG, and a row that implies there is sends
   * the user looking for a control that cannot exist.
   */
  it('shows sizes for a binary row instead of offering a diff', async () => {
    await review({ changes: [CHANGES.changes[0]] });

    expect(await screen.findByText('4 KB → 8 KB')).toBeTruthy();
  });

  /** The CONTROL for the row above: a text row carries no size annotation to confuse it with. */
  it('CONTROL — a text row shows no size pair', async () => {
    await review({ changes: [CHANGES.changes[2]] });

    await waitFor(() => expect(screen.getByText('src/scripts/Boost.ts')).toBeTruthy());
    expect(screen.queryByText(/KB/)).toBeNull();
  });
});

const PAGE_ONE: CommitSummary[] = [
  { sha: 'aaa1', message: 'Add boost pads', author: 'jane', date: '2026-08-01T00:00:00Z' },
  { sha: 'bbb2', message: 'Tune the drift', author: 'jane', date: '2026-08-02T00:00:00Z' },
];

const PAGE_TWO: CommitSummary[] = [
  { sha: 'ccc3', message: 'Scaffold the track', author: 'jane', date: '2026-07-30T00:00:00Z' },
];

describe('Branch history', () => {
  /** Short messages only — no diff, no file contents. The row is the message and who wrote it. */
  it('renders the commits it was given', async () => {
    const load = vi.fn(async () => ({ commits: PAGE_ONE }));

    render(<BranchHistoryDialog open onClose={onClose} load={load} branch="feature/boost-pads" />);

    expect(await screen.findByText('Add boost pads')).toBeTruthy();
    expect(screen.getByText('Tune the drift')).toBeTruthy();
  });

  /**
   * 🔴 "LOAD MORE" APPENDS. A pager that REPLACES the list looks like it is working — rows change,
   * the cursor advances, nothing throws — and the user can never reach the older commits it just
   * scrolled past. Both pages must be on screen at once, which is the only assertion that can tell
   * the two implementations apart.
   */
  it('appends the next page rather than replacing the first', async () => {
    const load = vi.fn(async (cursor?: string) =>
      cursor ? { commits: PAGE_TWO } : { commits: PAGE_ONE, nextCursor: 'cursor-2' },
    );

    render(<BranchHistoryDialog open onClose={onClose} load={load} branch="feature/boost-pads" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByText('Scaffold the track')).toBeTruthy());

    // The point: page one is STILL there.
    expect(screen.getByText('Add boost pads')).toBeTruthy();
    expect(screen.getByText('Tune the drift')).toBeTruthy();

    expect(load).toHaveBeenLastCalledWith('cursor-2');
  });

  /**
   * No cursor means the end of the history. A "Load more" that is always offered ends in a click that
   * silently does nothing, which reads as a broken button rather than as the end of the list.
   */
  it('offers no Load more when there is nothing more', async () => {
    const load = vi.fn(async () => ({ commits: PAGE_ONE }));

    render(<BranchHistoryDialog open onClose={onClose} load={load} branch="feature/boost-pads" />);

    await screen.findByText('Add boost pads');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  /** An empty history is a sentence, for the review dialog's reason. */
  it('says the branch has no commits rather than rendering an empty list', async () => {
    const load = vi.fn(async () => ({ commits: [] }));

    render(<BranchHistoryDialog open onClose={onClose} load={load} branch="feature/boost-pads" />);

    expect(await screen.findByText(/Nothing has been committed/)).toBeTruthy();
  });

  /**
   * The diff lives at the provider, not here — so a row must actually GO there. `commitUrlFor` is the
   * chip's `commitUrl(provider, repo, sha)`; what is asserted is that the sha of the row clicked is
   * the sha that was opened, since a row wired to the wrong commit is a wrong answer with a plausible
   * page attached to it.
   */
  it('opens the provider commit page for the row that was clicked', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);

    const load = vi.fn(async () => ({ commits: PAGE_ONE }));

    render(
      <BranchHistoryDialog
        open
        onClose={onClose}
        load={load}
        branch="feature/boost-pads"
        commitUrlFor={(sha) => `https://github.com/jane/space-racer/commit/${sha}`}
      />,
    );

    fireEvent.click(await screen.findByText('Tune the drift'));

    expect(open).toHaveBeenCalledWith('https://github.com/jane/space-racer/commit/bbb2', '_blank');

    vi.unstubAllGlobals();
  });
});
