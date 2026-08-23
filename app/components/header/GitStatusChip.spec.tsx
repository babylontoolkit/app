// @vitest-environment jsdom
/**
 * THE BRANCH SUBMENU (§4.13a, §4.1a, T19).
 *
 * This is a MENU test, and it exists because the four things T19's acceptance names are all things no
 * unit test of `describeBranchState` can see. That function can be perfect and every one of these can
 * still be wrong:
 *
 *   - **the group renders explained-and-unavailable for an unlinked project.** A greyed list of dead
 *     rows is indistinguishable from a broken feature, and the failure is invisible in code review
 *     because both branches of the ternary "look fine";
 *   - **"Open a pull request" is absent on the default branch.** A predicate computed correctly and
 *     then not consulted compiles, lints and ships an item that opens an empty compare page;
 *   - **the destructive pair is separated and LAST.** A menu where "Delete a branch" sits between two
 *     ordinary actions is a menu you delete a branch from by mis-aiming, and this is the one operation
 *     in the feature with no undo. Order is a property of JSX, so only the DOM can assert it;
 *   - 🔴 **`modal={false}`.** Radix's modal default scroll-locks the body and pads it to compensate for
 *     the scrollbar; the chat column is IN FLOW so that padding shifts it, while the workbench
 *     (`position: fixed`, placed by `--workbench-left`) stays put — opening this menu shoved the whole
 *     chat off-screen. It has bitten Deploy once and the git chip once. A prop that is silently right
 *     until someone adds a sibling menu is exactly the thing that needs an executable check.
 *
 * ## Driving it
 *
 * ⚠️ **`.click()` does not open a Radix menu** — the trigger opens on `pointerdown`. A test that
 * clicked and then asserted "the item is absent" would pass for every implementation, including one
 * with no menu at all, so every query below is preceded by an assertion that the menu really opened.
 *
 * The SUBMENU trigger is a different mechanism again: Radix's `MenuSubTrigger` opens on hover after a
 * timer, on `ArrowRight`, and on `click` — the last is the only one that is deterministic in jsdom, and
 * it is what these tests use.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

const seams = vi.hoisted(() => ({
  refreshBranches: vi.fn(async () => {}),
  switchTo: vi.fn(async () => undefined),
  switchDiscardingChanges: vi.fn(async () => {}),
  create: vi.fn(async () => ({ ok: true })),
  discard: vi.fn(async () => {}),
  remove: vi.fn(async () => ({ ok: true })),

  /*
   * ⚠️ `review`/`history` are stubbed even though no test here opens their dialogs. The chip MOUNTS
   * both, so a fixture missing them hands `load === undefined` to a component that calls it the
   * moment it opens — and the next person to write a test that opens one gets a `TypeError` instead
   * of a meaningful failure. A mock that is incomplete in a way nothing currently exercises is a trap
   * laid for whoever exercises it next.
   */
  review: vi.fn(async () => ({ changes: [] })),
  history: vi.fn(async () => ({ commits: [] })),
  run: vi.fn(),
  chooseProvider: vi.fn(),
}));

/** The `useSaveProject` view the mock below serves. Rewritten per test, reset in `beforeEach`. */
const saveState = vi.hoisted(() => ({
  view: {} as { tone: string; label: string; detail: string; action: string; actionLabel?: string },
}));

const SYNCED_VIEW = {
  tone: 'neutral',
  label: 'Linked to GitHub',
  detail: 'Your code is in jane/space-racer.',
  action: 'none',
} as const;

/* `~/lib/persistence` boots a sandbox at import time; the chip needs exactly one atom from it. */
vi.mock('~/lib/persistence', async () => {
  const { atom: makeAtom } = await import('nanostores');

  return {
    repoStatus: makeAtom<
      { linked: boolean; provider?: string; repo?: string; branch?: string; lastSyncedCommitSha?: string } | undefined
    >(undefined),
  };
});

/**
 * `useSaveProject` is the chip's OTHER half and has its own tests. Stubbed to a controllable view so
 * the assertions below are about the branch group rather than about the badge.
 *
 * ⚠️ The view is MUTABLE (`saveState`, reset in `beforeEach`) rather than a frozen literal, because
 * the top-level ordering test needs the commit row to EXIST — and the synced default deliberately
 * renders no action at all. A fixture that cannot produce the row makes an assertion about where the
 * row sits pass for a menu that never had one.
 */
vi.mock('~/lib/persistence/useSaveProject', () => ({
  PROVIDER_LABEL: { github: 'GitHub', gitlab: 'GitLab' },
  useSaveProject: () => ({
    projectId: 'prj_1',
    view: saveState.view,
    provider: 'github',
    providerName: 'GitHub',
    hasChoice: false,
    configured: ['github'],
    chooseProvider: seams.chooseProvider,
    run: seams.run,
  }),
}));

vi.mock('~/components/github/GitHubSyncButton', () => ({ GitHubSyncDialog: () => null }));

/**
 * The hook is mocked, not the module graph beneath it: `useBranchActions.spec.tsx` drives the real one.
 * Here it is a controllable source of `branches`, which is what decides the DEFAULT branch — and the
 * default branch is what decides whether "Open a pull request" may be offered.
 */
vi.mock('~/lib/persistence/useBranchActions', () => ({
  useBranchActions: () => ({
    branches: branchList,
    loadingBranches: false,
    busy: false,
    refreshBranches: seams.refreshBranches,
    switchTo: seams.switchTo,
    switchDiscardingChanges: seams.switchDiscardingChanges,
    create: seams.create,
    discard: seams.discard,
    remove: seams.remove,
    review: seams.review,
    history: seams.history,
  }),
}));

import { GitStatusChip } from './GitStatusChip.client';
import { repoStatus } from '~/lib/persistence';

type Branch = { name: string; head: string; isDefault: boolean; protected: boolean };

/** Rewritten per test, read by the mocked hook above. */
let branchList: Branch[] | undefined;

const BRANCHES: Branch[] = [
  { name: 'main', head: 'a1', isDefault: true, protected: true },
  { name: 'feature/boost-pads', head: 'b2', isDefault: false, protected: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  branchList = BRANCHES;
  saveState.view = { ...SYNCED_VIEW };
  repoStatus.set({
    linked: true,
    provider: 'github',
    repo: 'jane/space-racer',
    branch: 'feature/boost-pads',
    lastSyncedCommitSha: 'b2',
  });

  /* Radix's popper measures its trigger; jsdom has no ResizeObserver. */
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  /**
   * ⚠️ jsdom implements no `PointerEvent`, so `fireEvent.pointerDown` falls back to a bare `Event` —
   * which carries no `button`, and Radix's trigger only opens for `event.button === 0`. Without this
   * the menu never opens and every "…is absent" assertion in this file passes vacuously. Aliased to
   * `MouseEvent`, which carries the button semantics Radix reads.
   */
  if (!(window as unknown as { PointerEvent?: unknown }).PointerEvent) {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;
  }

  /* Radix's `DismissableLayer` captures the pointer on some paths. */
  Element.prototype.hasPointerCapture ??= () => false;

  Element.prototype.setPointerCapture ??= () => {};

  Element.prototype.releasePointerCapture ??= () => {};

  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();

  /* The modal CONTROL below locks the body; leaving that behind would poison the next test. */
  document.body.removeAttribute('data-scroll-locked');
  document.body.removeAttribute('style');
});

/**
 * Open the chip's menu with a real pointer event and PROVE it opened.
 *
 * ⚠️ The proof is not politeness. Every "…is absent" assertion in this file is trivially true against a
 * closed menu, so without this the strongest tests here would be the vacuous ones.
 */
async function openMenu() {
  render(<GitStatusChip />);

  const trigger = screen.getByRole('button', { name: /Linked to GitHub/ });

  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });

  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());

  return trigger;
}

/** Open the menu, then the Branch submenu. Returns the submenu's own content element. */
async function openBranchSubmenu() {
  await openMenu();

  const subTrigger = screen.getByRole('menuitem', { name: /Branch/ });

  fireEvent.click(subTrigger);

  return waitFor(() => {
    const menus = screen.getAllByRole('menu');
    const sub = menus.find((m) => m.textContent?.includes('Switch branch') || m.textContent?.includes('branches live'));

    expect(sub, 'the Branch submenu never opened').toBeTruthy();

    return sub!;
  });
}

describe('the branch row comes before the actions scoped to it', () => {
  /**
   * Owner, 2026-08-22: the Branch submenu sits ABOVE the commit action.
   *
   * Every action beneath it — commit, pull, open the repo — is scoped to whichever branch that row
   * names, so naming the branch after offering to write to it puts the answer below the question.
   *
   * ⚠️ Asserted as INDICES over the top-level menu, never as a `toEqual` over its labels. This menu's
   * contents vary with state (the action row disappears when there is nothing to do, "Open <repo>"
   * needs a linked repo, the provider radio group appears only on a choice), so an exhaustive list
   * would pin one fixture's shape and fail on every other — the opposite trade-off from the submenu
   * below, whose membership is fixed and whose last two rows destroy things.
   */
  it('puts the Branch row above the commit action', async () => {
    /* The synced default renders no action row at all — give the menu something to order against. */
    saveState.view = {
      ...SYNCED_VIEW,

      /* `label` stays put: `openMenu` finds the trigger by it, and the badge is not what is under test. */
      tone: 'warning',
      action: 'save',
      actionLabel: 'Commit changes',
    };

    await openMenu();

    const menu = screen.getByRole('menu');
    const rows = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');

    const branch = rows.findIndex((t) => t.includes('Branch'));
    const commit = rows.findIndex((t) => t.includes('Commit changes'));

    expect(branch, 'the Branch row is missing').toBeGreaterThan(-1);
    expect(commit, 'the commit action is missing — the fixture no longer exercises the ordering').toBeGreaterThan(-1);
    expect(branch).toBeLessThan(commit);
  });

  /** And above the other two branch-scoped rows, for the same reason. */
  it('puts the Branch row above the pull and open-repository rows', async () => {
    await openMenu();

    const menu = screen.getByRole('menu');
    const rows = [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');

    const branch = rows.findIndex((t) => t.includes('Branch'));
    const pull = rows.findIndex((t) => t.includes('Pull from'));
    const open = rows.findIndex((t) => t.includes('Open jane/space-racer'));

    expect(pull, 'the pull row is missing').toBeGreaterThan(-1);
    expect(open, 'the open-repository row is missing').toBeGreaterThan(-1);
    expect(branch).toBeLessThan(pull);
    expect(branch).toBeLessThan(open);
  });
});

describe('the submenu trigger is the current-branch row', () => {
  /**
   * Requirement 75, and requirement 77's other half: the branch is readable by opening ONE menu, and
   * the header row does not grow. The name is NOT in the chip's own label — the row is right-aligned,
   * so a control that grows with unbounded user-chosen text shoves everything left.
   */
  it('names the branch on the submenu trigger, and NOT on the chip', async () => {
    const chip = await openMenu();

    expect(screen.getByRole('menuitem', { name: /Branch: feature\/boost-pads/ })).toBeTruthy();
    expect(chip.textContent).not.toContain('feature/boost-pads');
  });

  /** The list is a provider round trip most sessions never need, so it is read when the menu OPENS. */
  it('reads the branch list when the menu opens, not on mount', async () => {
    render(<GitStatusChip />);
    expect(seams.refreshBranches).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole('button', { name: /Linked to GitHub/ }), { button: 0 });

    await waitFor(() => expect(seams.refreshBranches).toHaveBeenCalled());
  });
});

describe('an unlinked project gets an explanation, not dead rows', () => {
  /**
   * 🔴 The acceptance's "absent with an explanation". Both halves are asserted: the sentence is there
   * AND the actions are not. Asserting only the sentence would pass for a submenu that showed the
   * explanation *above* a full set of items that cannot work.
   */
  it('explains why the group is unavailable and offers no branch actions', async () => {
    repoStatus.set({ linked: false });
    branchList = undefined;

    const sub = await openBranchSubmenu();

    expect(sub.textContent).toMatch(/branches live in your repository/i);
    expect(screen.queryByRole('menuitem', { name: /Switch branch/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /New branch/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Discard all changes/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Delete a branch/ })).toBeNull();
  });

  /** The unlinked chip must not fetch a branch list it has no repository to fetch from. */
  it('does not go looking for branches it cannot have', async () => {
    repoStatus.set({ linked: false });
    render(<GitStatusChip />);

    fireEvent.pointerDown(screen.getByRole('button', { name: /Linked to GitHub/ }), { button: 0 });

    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
    expect(seams.refreshBranches).not.toHaveBeenCalled();
  });

  /** The CONTROL: a linked project really does get the items. */
  it('a linked project gets the actions', async () => {
    await openBranchSubmenu();

    expect(screen.getByRole('menuitem', { name: /Switch branch/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /New branch/ })).toBeTruthy();
  });
});

describe('"Open a pull request" is offered only where it would work', () => {
  /**
   * The default branch has nothing to compare against, and the provider answers with an empty compare
   * page — which reads as our button being broken rather than as the state it reflects.
   */
  it('is absent on the default branch', async () => {
    repoStatus.set({
      linked: true,
      provider: 'github',
      repo: 'jane/space-racer',
      branch: 'main',
      lastSyncedCommitSha: 'a1',
    });

    await openBranchSubmenu();

    expect(screen.queryByRole('menuitem', { name: /pull request/i })).toBeNull();

    /* The menu really is open and populated — so the absence above is the rule, not a dead render. */
    expect(screen.getByRole('menuitem', { name: /Switch branch/ })).toBeTruthy();
  });

  /** Never pushed: the provider has no ref to compare, whatever this browser holds. */
  it('is absent on a branch that has never been pushed', async () => {
    repoStatus.set({ linked: true, provider: 'github', repo: 'jane/space-racer', branch: 'feature/boost-pads' });

    await openBranchSubmenu();

    expect(screen.queryByRole('menuitem', { name: /pull request/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Switch branch/ })).toBeTruthy();
  });

  /** The CONTROL. Without it both assertions above pass for an item that is never rendered at all. */
  it('IS offered on a pushed branch that is not the default', async () => {
    await openBranchSubmenu();

    expect(screen.getByRole('menuitem', { name: /Open a pull request/ })).toBeTruthy();
  });

  /**
   * The item has to AIM somewhere, and the base of the comparison is the default branch that was READ
   * from the list — never a literal.
   *
   * ⚠️ An earlier draft of this comment reported that the chip falls back to `'main'` when the list
   * has not answered. It did, briefly, and it does not now: the chip passes `defaultBranch` through
   * undefined and `newPullRequestUrl` omits the base ref entirely, letting the provider supply its own
   * default (pinned in `provider-urls.spec.ts`). A test comment reporting a defect that no longer
   * exists sends the next reader hunting for it.
   */
  it('compares against the default branch that was actually read', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);

    await openBranchSubmenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Open a pull request/ }));

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0][0]).toBe(
      'https://github.com/jane/space-racer/compare/main...feature%2Fboost-pads?expand=1',
    );
  });

  /**
   * 🔴 IT IS CALLED A PULL REQUEST (owner, 2026-08-22), and this test used to assert the opposite.
   *
   * The §4.5.4b plain-language sweep bans `pull` from everything the user reads, and this item was
   * "Open a change request" on that basis. The owner overruled it for this one row, and the reasoning
   * holds up: the item does not describe something the platform does, it is a DOOR to the provider's
   * own site, and it lands the user on a page GitHub itself labels "pull request". Inventing a
   * synonym for a screen we do not control makes the destination harder to recognise, not easier —
   * which is the opposite of what the plain-language rule is for.
   *
   * ⚠️ The sweep is untouched and still binding: it runs over `describeBranchState`'s OUTPUT, and
   * every string that function returns is still jargon-free. This is a JSX label, which that sweep
   * has never covered — as the "Pull from GitHub…" row one level up has always demonstrated.
   */
  it("calls it a pull request, in the provider's own words", async () => {
    const sub = await openBranchSubmenu();

    expect(sub.textContent).toContain('Open a pull request');
    expect(sub.textContent, 'the old name survived somewhere').not.toMatch(/change request/i);
  });
});

/** A row is an item, not the separator. Kept out of the assertion so the intent stays readable. */
const isMenuItem = (el: Element) => el.getAttribute('role') === 'menuitem';

describe('the destructive row is separated and last', () => {
  /**
   * 🔴 Order is a property of the JSX and nothing but the DOM can assert it. A menu where "Delete a
   * branch" sits between two ordinary actions is a menu you delete a branch from by mis-aiming — and
   * deleting a branch is the one operation in this feature with no undo (a checkpoint is a snapshot of
   * FILES and cannot restore a remote ref).
   */
  it('puts Discard after every ordinary action', async () => {
    const sub = await openBranchSubmenu();
    const labels = [...sub.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');

    /*
     * ⚠️ AN EXHAUSTIVE `toEqual` OVER A MENU IS A DOUBLE-EDGED ASSERTION, and it cut the wrong way
     * once already: it was written listing the five items that existed, which meant adding either of
     * the two the plan also calls for ("Review changes…", "Branch history…") FAILED the suite. A test
     * written in the same task as the gap it describes had pinned the gap in place.
     *
     * Kept exhaustive rather than loosened to `toContain`, because ORDER is the property under test
     * and a subset check cannot see an item that moved. The cost is that a genuinely new item must be
     * added here deliberately — which is the right cost for a menu whose last two entries destroy
     * things.
     */
    expect(labels).toEqual([
      expect.stringContaining('New branch'),
      expect.stringContaining('Switch branch'),
      expect.stringContaining('Branch history'),
      expect.stringContaining('Review changes'),
      expect.stringContaining('Open a pull request'),
      expect.stringContaining('Discard all changes'),
    ]);
  });

  /**
   * 🔴 HIDDEN, not greyed (owner, 2026-08-22). *"I don't want them doing that for now — they can
   * always open on GitHub and delete the branch there."*
   *
   * ⚠️ This is the COSMETIC half and is worth exactly what it says: the wall is
   * `branchDeleteAvailability`, asserted at the route in `clone.spec.ts` and at the hook in
   * `useBranchActions.spec.tsx`. A menu item's absence is not a permission — `op: 'delete-branch'`
   * is reachable without ever opening this menu.
   */
  it('offers no way to delete a branch', async () => {
    const sub = await openBranchSubmenu();

    expect(sub.textContent).not.toMatch(/delete a branch/i);
    expect(screen.queryByRole('menuitem', { name: /Delete a branch/i })).toBeNull();
  });

  /**
   * Separated, not merely last. The separator is what makes the gap readable as "these two are
   * different"; without it, "last" is just a position the eye slides past.
   */
  it('puts a separator between the ordinary actions and the destructive ones', async () => {
    const sub = await openBranchSubmenu();
    const rows = [...sub.querySelectorAll('[role="menuitem"], [role="separator"]')];
    const index = (predicate: (el: Element) => boolean) => rows.findIndex(predicate);

    /*
     * ⚠️ Anchored on EVERY ordinary row, not on one named item — and that is the third version of
     * this assertion in one day. It read `New branch` until the owner moved that item to the top
     * (whereupon "the separator is below New branch" was true of a separator anywhere after the
     * first row), then `Branch history` until the owner moved that one too. Each rewrite named the
     * row that happened to be last, and each stopped guarding the boundary the moment the list was
     * reordered — silently, still green.
     *
     * A named anchor is a guess about a list that keeps changing. The property is "the separator is
     * below all of them", so assert that, and it survives any future reorder or addition.
     */
    const separator = index((el) => el.getAttribute('role') === 'separator');
    const discard = index((el) => (el.textContent ?? '').includes('Discard all changes'));

    const ordinary = rows
      .map((el, at) => ({ text: el.textContent ?? '', at }))
      .filter(({ text, at }) => at !== discard && isMenuItem(rows[at]) && text.trim().length > 0)
      .map(({ at }) => at);

    expect(separator, 'the destructive row has no separator above it').toBeGreaterThan(-1);
    expect(ordinary.length, 'no ordinary rows — the fixture stopped exercising the boundary').toBeGreaterThan(3);
    expect(Math.max(...ordinary), 'an ordinary row sits BELOW the separator').toBeLessThan(separator);
    expect(separator).toBeLessThan(discard);
  });
});

/**
 * 🔴 `modal={false}` — SPEC §4.1a, and the reason every header dropdown carries it.
 *
 * Radix's modal default scroll-locks the body (`react-remove-scroll`) and pads it to compensate for the
 * scrollbar it just removed. The chat column is in flow, so that padding SHIFTS it; the workbench is
 * `position: fixed` and placed by `--workbench-left`, so it does not move. Opening the menu therefore
 * shoved the whole chat off-screen — it has bitten Deploy (2026-07-18) and this chip (2026-07-22), and
 * a `Sub` inherits the root's modality, so the branch group rides on the same prop.
 *
 * ⚠️ **`document.body.style.paddingRight` alone CANNOT catch this in jsdom**, and asserting only it was
 * the first draft of these tests: jsdom has no scrollbar to measure, so the lock computes a gap of zero
 * and writes nothing — the assertion passed with `modal={false}` deleted. What jsdom CAN see is the lock
 * itself (`data-scroll-locked` on the body, and the `pointer-events: none` that comes with it), which is
 * the mechanism rather than its measured side effect. The padding assertion is kept as the acceptance's
 * literal wording; the lock assertions are the ones that fail.
 */
describe('opening the menu does not shift the layout', () => {
  const locked = () => ({
    scrollLocked: document.body.hasAttribute('data-scroll-locked'),
    pointerEvents: document.body.style.pointerEvents,
    paddingRight: document.body.style.paddingRight,
  });

  it('leaves the body alone with the menu open', async () => {
    await openMenu();

    expect(screen.getByRole('menu')).toBeTruthy();
    expect(locked()).toEqual({ scrollLocked: false, pointerEvents: '', paddingRight: '' });
  });

  /** And with the submenu open too — that is the state the branch group is actually used in. */
  it('leaves the body alone with the branch submenu open', async () => {
    await openBranchSubmenu();

    expect(locked()).toEqual({ scrollLocked: false, pointerEvents: '', paddingRight: '' });
  });

  /**
   * 🔴 THE CONTROL, and it is the whole reason the two assertions above mean anything: the SAME
   * environment, the SAME Radix version, one prop different. If this does not lock the body, jsdom
   * cannot see the defect at all and the tests above are decoration.
   */
  it('a deliberately modal menu DOES lock the body here — so the assertions above can fail', async () => {
    render(
      <DropdownMenu.Root modal>
        <DropdownMenu.Trigger>a modal menu</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item>an item</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>,
    );

    fireEvent.pointerDown(screen.getByText('a modal menu'), { button: 0 });
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());

    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);
    expect(document.body.style.pointerEvents).toBe('none');
  });
});

/**
 * 🔴 THE SUBMENU SURFACE KEEPS `z-[1000]`, AND NOTHING WAS CHECKING.
 *
 * T19 marks this red for a measured reason: Radix copies the content's COMPUTED z-index onto its own
 * fixed popper wrapper, and the workbench sits at `.z-workbench` (3). When the shared toolbar classes
 * silently stopped being extracted by UnoCSS in 2026-07-22, every menu in the header fell behind the
 * workbench — a whole class of controls that opened into nothing.
 *
 * ⚠️ A SOURCE SCAN, deliberately, and the doc comment says why: jsdom computes no cascade, so a
 * rendered assertion here would read `z-index: ''` whatever the class says. What can be checked is
 * that the surface uses the SHARED constant rather than a hand-rolled class — which is the actual
 * regression (a plausible bare class was substituted during review and the whole suite stayed green).
 */
describe('the branch submenu draws on the shared menu surface', () => {
  const CHIP = readFileSync(join(process.cwd(), 'app/components/header/GitStatusChip.client.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('SubContent uses TOOLBAR_MENU_CONTENT, never a hand-rolled class', () => {
    const sub = CHIP.match(/<DropdownMenu\.SubContent[^>]*>/s);

    expect(sub, 'no SubContent found — this scan is reading nothing').toBeTruthy();
    expect(sub![0]).toContain('TOOLBAR_MENU_CONTENT');
  });

  /*
   * CONTROLS: the scanner reads real code, the comment strip really stripped (the file names the
   * z-index rule in prose, so an unstripped scan would pass on the explanation alone), and a class
   * that is not there is not found.
   */
  it('the scan can fail', () => {
    expect(CHIP).toContain('DropdownMenu.SubTrigger');
    expect(CHIP).not.toContain('z-workbench');
    expect(CHIP).not.toContain('TOOLBAR_MENU_SURFACE_THAT_DOES_NOT_EXIST');
  });
});
