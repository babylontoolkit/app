// @vitest-environment jsdom
/**
 * The workbench Search tab's "not supported" state (plan T10).
 *
 * Text search is an OPTIONAL sandbox capability (`spec/sandbox-seam.md`): a server-container provider
 * may have no ripgrep-class index to offer. Before T10 the tab ran the search anyway, hit the
 * capability check, logged to the console and fell through to the ordinary empty state — so a user on
 * a runtime without a text index was told, in the product's own words, that their code does not
 * contain what they just searched for. "Not supported" is not "no results".
 *
 * These tests drive the REAL `Search` component against provider DOUBLES, because the whole property
 * is the wiring between a capability flag the provider declares and what the panel renders — the two
 * things a pure extraction would have separated. Three states, not two:
 *
 *  - `textSearch: false` → the panel explains itself, the input is disabled, and NO search is ever
 *    dispatched (the provider's `textSearch` must not be called even after typing + the 300ms debounce).
 *  - `textSearch: true`  → behaviour unchanged: input enabled, no "not available" copy, typing searches.
 *  - still connecting     → neither the panel nor a disabled input. `undefined` is a deliberate THIRD
 *    state: claiming "unavailable" for a second on every load of a provider that CAN search is wrong,
 *    and disabling the input under the user's cursor afterwards is worse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/*
 * `~/utils/constants` pulls the whole LLM manager in transitively; the component reads exactly one
 * constant from it. `~/lib/stores/workbench` is only touched when a result is CLICKED.
 */
vi.mock('~/utils/constants', () => ({ WORK_DIR: '/project/workspace' }));
vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: { setSelectedFile: vi.fn(), setCurrentDocumentScrollPosition: vi.fn() },
}));

/*
 * The seam under test. `sandbox` is a module-level PROMISE, so the double is installed per test
 * through a mutable holder rather than by re-mocking.
 */
const holder = vi.hoisted(() => ({ sandbox: null as unknown as Promise<unknown> }));
vi.mock('~/lib/sandbox', () => ({
  get sandbox() {
    return holder.sandbox;
  },
}));

import { Search } from './Search';

/** How long the debounced dispatch waits before it would fire. */
const DEBOUNCE_MS = 300;

interface Double {
  instance: { capabilities: { textSearch: boolean }; textSearch?: ReturnType<typeof vi.fn> };
  textSearch: ReturnType<typeof vi.fn>;
}

function providerDouble(textSearchSupported: boolean): Double {
  const textSearch = vi.fn(async () => undefined);

  return {
    textSearch,
    instance: {
      capabilities: { textSearch: textSearchSupported },

      // A provider that declares the capability off does not carry the method either.
      textSearch: textSearchSupported ? textSearch : undefined,
    },
  };
}

/** Real timers: the debounce is 300ms and the whole file spends well under two seconds waiting. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NOT_AVAILABLE = /Text search isn't available on this workspace runtime yet/i;

function input() {
  return screen.getByRole('textbox') as HTMLInputElement;
}

let consoleError: ReturnType<typeof vi.spyOn>;

describe('Search tab — text-search capability', () => {
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('provider reporting textSearch: false', () => {
    it('renders the explanatory panel instead of an empty-results state', async () => {
      const double = providerDouble(false);
      holder.sandbox = Promise.resolve(double.instance);

      render(<Search />);

      await waitFor(() => expect(screen.getByText(NOT_AVAILABLE)).toBeInTheDocument());
      expect(screen.getByText(/use the editor's own find instead/i)).toBeInTheDocument();
    });

    it('disables the input and labels it', async () => {
      holder.sandbox = Promise.resolve(providerDouble(false).instance);

      render(<Search />);

      await waitFor(() => expect(input()).toBeDisabled());
      expect(input()).toHaveAttribute('placeholder', 'Search unavailable');
    });

    it('never dispatches a search, even after typing and the full debounce window', async () => {
      const double = providerDouble(false);
      holder.sandbox = Promise.resolve(double.instance);

      render(<Search />);
      await waitFor(() => expect(screen.getByText(NOT_AVAILABLE)).toBeInTheDocument());

      /*
       * The input is disabled, so a user cannot type — but `fireEvent.change` sets the state anyway,
       * which is exactly the pin worth having: the guard must live on the DISPATCH, not only on the
       * input's `disabled` attribute (a styling detail one refactor away from being lost).
       */
      fireEvent.change(input(), { target: { value: 'GameManager' } });
      await sleep(DEBOUNCE_MS + 150);

      expect(double.textSearch).not.toHaveBeenCalled();

      /*
       * 🔴 The line above is necessary but NOT sufficient, and mutation-testing proved it: dropping the
       * `textSearchSupported === false` guard on the debounced dispatch leaves it green, because
       * `performTextSearch` has its own capability check that returns before touching the provider.
       * What that second wall CANNOT hide is that a search ran at all — it announces itself on the
       * console. Assert the dispatch never happened, not merely that the provider was never reached.
       */
      expect(consoleError).not.toHaveBeenCalled();
    });

    /*
     * 🔴 THE RACE IS THE ONLY THING THAT MAKES THE JSX GATE TESTABLE — AND THE OBVIOUS VERSION OF THIS
     * TEST CANNOT FAIL. Typing AFTER the capability has already resolved `false` is vacuous: the
     * dispatch guard keeps `hasSearched` false, so "No results found." was never going to render and
     * the assertion passes with `textSearchSupported !== false &&` deleted from the gate.
     *
     * The user's actual path is a race. The capability resolves asynchronously, the input is ENABLED
     * while it is `undefined` (the third state — we claim nothing), and the debounce is 300ms. Type
     * into that window and a `handleSearch` call is ALREADY QUEUED when the answer arrives: the guard
     * re-runs the effect but does not cancel the pending timer, so the search fires, sets `hasSearched`,
     * finds nothing (the runtime has no index), and the JSX gate is the last thing standing between the
     * user and the product telling them their code does not contain what they just searched for.
     */
    it('does not fall through to "No results found." when the capability resolves mid-debounce', async () => {
      const double = providerDouble(false);

      let resolveSandbox: (instance: unknown) => void = () => undefined;
      holder.sandbox = new Promise((resolve) => {
        resolveSandbox = resolve;
      });

      render(<Search />);

      // Still connecting: the input is live, so the user types.
      expect(input()).not.toBeDisabled();
      fireEvent.change(input(), { target: { value: 'GameManager' } });

      // The answer lands BEFORE the debounce fires — the search is already queued.
      await sleep(100);
      resolveSandbox(double.instance);

      await waitFor(() => expect(screen.getByText(NOT_AVAILABLE)).toBeInTheDocument());

      /*
       * Past the debounce AND past `handleSearch`'s 300ms minimum loader time, so the component has
       * settled into whatever empty state it is going to show.
       */
      await sleep(DEBOUNCE_MS * 2 + 200);

      expect(screen.getByText(NOT_AVAILABLE)).toBeInTheDocument();
      expect(screen.queryByText(/No results found/i)).not.toBeInTheDocument();
      expect(double.textSearch).not.toHaveBeenCalled();
    });
  });

  describe('provider reporting textSearch: true (behaviour unchanged)', () => {
    it('leaves the input enabled and shows no "not available" copy', async () => {
      holder.sandbox = Promise.resolve(providerDouble(true).instance);

      render(<Search />);

      await waitFor(() => expect(input()).not.toBeDisabled());
      expect(input()).toHaveAttribute('placeholder', 'Search');
      expect(screen.queryByText(NOT_AVAILABLE)).not.toBeInTheDocument();
    });

    it('dispatches the search when the user types', async () => {
      const double = providerDouble(true);
      holder.sandbox = Promise.resolve(double.instance);

      render(<Search />);
      await waitFor(() => expect(input()).not.toBeDisabled());

      fireEvent.change(input(), { target: { value: 'GameManager' } });

      await waitFor(() => expect(double.textSearch).toHaveBeenCalled(), { timeout: 2000 });
      expect(double.textSearch.mock.calls[0][0]).toBe('GameManager');
    });
  });

  describe('sandbox still connecting (the undefined third state)', () => {
    it('claims nothing: no panel, no disabled input', async () => {
      // A promise that never settles — the component must not decide anything on its own.
      holder.sandbox = new Promise(() => undefined);

      render(<Search />);
      await sleep(DEBOUNCE_MS + 150);

      expect(screen.queryByText(NOT_AVAILABLE)).not.toBeInTheDocument();
      expect(input()).not.toBeDisabled();
      expect(input()).toHaveAttribute('placeholder', 'Search');
    });

    it('stays undefined when the sandbox fails to boot (the boot failure has its own surface)', async () => {
      holder.sandbox = Promise.reject(new Error('sandbox unavailable'));

      render(<Search />);
      await sleep(50);

      expect(screen.queryByText(NOT_AVAILABLE)).not.toBeInTheDocument();
      expect(input()).not.toBeDisabled();
    });
  });
});
