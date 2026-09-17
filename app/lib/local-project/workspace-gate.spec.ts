/**
 * The gate a workspace waits on (§4.5.4d).
 *
 * Every assertion here is about a promise SETTLING, because the failure this module can have is that it
 * does not: a New Project button that spins forever, or a project that never opens, with nothing on
 * screen and nothing in a log. The timer is injected for the same reason — a real ceiling would make
 * the hang look like a slow test.
 */
import { describe, expect, it, vi } from 'vitest';
import { runFolderGate, type FolderGateDeps } from './workspace-gate';
import type { FolderGateRequest } from './folder-gate';
import type { LocalProjectState } from './status';

function harness(initial: LocalProjectState, over: Partial<FolderGateDeps> = {}) {
  let state = initial;
  let skipped = false;

  const listeners = new Set<() => void>();
  const opened: FolderGateRequest[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  const closed = vi.fn();
  const cleared = vi.fn();

  const deps: FolderGateDeps = {
    refresh: async () => undefined,
    readState: () => state,
    subscribeState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readSkipped: () => skipped,
    rememberSkipped: () => {
      skipped = true;
    },
    required: true,
    ceilingMs: 8_000,
    setTimer: (run) => {
      const handle = nextTimer++;
      timers.set(handle, run);

      return handle;
    },
    clearTimer: (handle) => {
      cleared(handle);
      timers.delete(handle as number);
    },
    open: (request) => opened.push(request),
    close: closed,
    ...over,
  };

  return {
    deps,
    opened,
    closed,
    cleared,
    listenerCount: () => listeners.size,
    setState(next: LocalProjectState) {
      state = next;
      listeners.forEach((listener) => listener());
    },
    fireCeiling() {
      [...timers.values()].forEach((run) => run());
    },
    wasSkipped: () => skipped,
  };
}

/** Let the internal `refresh().then(...)` run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runFolderGate — holding a workspace until the folder is answered', () => {
  it('proceeds without ever drawing anything when a folder is already connected', async () => {
    const h = harness({ kind: 'connected', folderName: 'Projects' });
    const gate = runFolderGate('create', h.deps);

    await expect(gate.outcome).resolves.toBe('proceed');
    expect(h.opened).toHaveLength(0);
  });

  it.each([
    ['a browser that cannot pick a folder', { kind: 'unavailable' } as LocalProjectState],
    ['a signed-out visitor', { kind: 'signed-out' } as LocalProjectState],
  ])('proceeds for %s', async (_label, state) => {
    const gate = runFolderGate('open', harness(state).deps);
    await expect(gate.outcome).resolves.toBe('proceed');
  });

  it('opens the panel and waits — carrying the intent the door asked with', async () => {
    const h = harness({ kind: 'unset' });
    const gate = runFolderGate('open', h.deps);
    const settled = vi.fn();
    void gate.outcome.then(settled);

    await flush();

    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatchObject({ gate: 'choose', intent: 'open', required: true });
    expect(settled).not.toHaveBeenCalled();
  });

  it('closes itself when the user picks a folder — the disk state is the signal, not a callback', async () => {
    const h = harness({ kind: 'unset' });
    const gate = runFolderGate('create', h.deps);
    await flush();

    h.setState({ kind: 'connected', folderName: 'Projects' });

    await expect(gate.outcome).resolves.toBe('proceed');
    expect(h.closed).toHaveBeenCalledTimes(1);
    expect(h.listenerCount(), 'the subscription must not outlive the gate').toBe(0);
    expect(h.cleared, 'nor the ceiling timer').toHaveBeenCalledTimes(1);
  });

  it('cancel abandons the workspace', async () => {
    const h = harness({ kind: 'unset' });
    const gate = runFolderGate('create', h.deps);
    await flush();

    gate.cancel();

    await expect(gate.outcome).resolves.toBe('cancelled');
    expect(h.closed).toHaveBeenCalledTimes(1);
  });

  it('settles exactly once however many times it is told to stop', async () => {
    const h = harness({ kind: 'unset' });
    const gate = runFolderGate('create', h.deps);
    await flush();

    gate.cancel();
    gate.cancel();
    h.setState({ kind: 'connected', folderName: 'Projects' });

    await expect(gate.outcome).resolves.toBe('cancelled');
    expect(h.closed).toHaveBeenCalledTimes(1);
  });

  describe('not now', () => {
    it('records the skip and proceeds when the folder is not required', async () => {
      const h = harness({ kind: 'unset' }, { required: false });
      const gate = runFolderGate('create', h.deps);
      await flush();

      gate.skip();

      await expect(gate.outcome).resolves.toBe('proceed');
      expect(h.wasSkipped()).toBe(true);
    });

    /* 🔴 The decision is the only thing that may conclude "no folder needed" — skip just re-asks it. */
    it('CONTROL: does nothing while the folder is required', async () => {
      const h = harness({ kind: 'unset' });
      const gate = runFolderGate('create', h.deps);
      const settled = vi.fn();
      void gate.outcome.then(settled);
      await flush();

      gate.skip();
      await flush();

      expect(settled).not.toHaveBeenCalled();
      expect(h.closed).not.toHaveBeenCalled();
    });
  });

  describe('an account we cannot read yet', () => {
    it('covers with the checking panel, then PROCEEDS at the ceiling — never cancels', async () => {
      const h = harness({ kind: 'unknown' });
      const gate = runFolderGate('open', h.deps);
      await flush();

      expect(h.opened[0]).toMatchObject({ gate: 'checking' });

      h.fireCeiling();

      await expect(gate.outcome).resolves.toBe('proceed');
    });

    it('asks properly if the account resolves before the ceiling', async () => {
      const h = harness({ kind: 'unknown' });
      const gate = runFolderGate('create', h.deps);
      const settled = vi.fn();
      void gate.outcome.then(settled);
      await flush();

      h.setState({ kind: 'needs-permission', folderName: 'Projects' });
      await flush();

      expect(h.opened.at(-1)).toMatchObject({ gate: 'reconnect' });
      expect(settled).not.toHaveBeenCalled();
    });
  });

  /* A state we could not read is `unknown`, which the gate covers — never a silent free pass. */
  it('still asks when the refresh itself fails', async () => {
    const h = harness({ kind: 'unset' }, { refresh: async () => Promise.reject(new Error('indexeddb is gone')) });
    const gate = runFolderGate('create', h.deps);
    const settled = vi.fn();
    void gate.outcome.then(settled);

    await flush();

    expect(h.opened).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();
  });
});
