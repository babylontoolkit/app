// @vitest-environment jsdom
/**
 * NEW PROJECT MODE — THE WIRING (T7).
 *
 * `new-project-mode.spec.ts` proves the store. This file proves the three things only the component can
 * be wrong about, each of which fails silently and costs the user their creation brief:
 *
 *   1. creation ENTERS the mode, carrying the brief it built at the moment its facts were true;
 *   2. a CLIENT COMMAND does not clear it — `/context`, `/effort` and `/clear` are intercepted before
 *      anything is posted, and typing one on a freshly created project is an ordinary thing to do. A
 *      clear placed at the top of `sendMessage` would spend the mode on a command that was never a build;
 *   3. an ORDINARY message clears it, at the SEND.
 *
 * Behavioural, not structural: the real `ChatImpl` is mounted and its real `sendMessage` is driven, so
 * the assertion is about where the clear actually sits relative to the interceptions rather than about a
 * line of source being present. The harness is `creation-no-agent-request.spec.tsx`'s — chrome stubbed,
 * `fetch` recorded, everything between the click and the store real.
 *
 * The `/api/agent` recorder rides along as the CONTROL that gives "the mode survived" its meaning: a
 * command that posted a generation would be a different bug, and a send that posted nothing would make
 * "the mode was cleared" vacuous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ------------------------------------------------ the creation seams (mount, settle, sandbox, files) */

const seams = vi.hoisted(() => ({
  createProjectFromRegistry: vi.fn(),
  waitForMountVisible: vi.fn(),
  settleAfterCreation: vi.fn(),
  awaitStarterRunning: vi.fn(),
}));

vi.mock('~/lib/registry/create-project', () => ({
  createProjectFromRegistry: seams.createProjectFromRegistry,
}));
vi.mock('~/lib/registry/mount', () => ({
  waitForMountVisible: seams.waitForMountVisible,
  mountTemplate: vi.fn(),
  clearInheritedDevServer: vi.fn(),
}));
vi.mock('~/lib/registry/settle', () => ({ settleAfterCreation: seams.settleAfterCreation }));
vi.mock('~/lib/registry/starter-ready', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/registry/starter-ready')>()),
  awaitStarterRunning: seams.awaitStarterRunning,
}));
vi.mock('~/lib/sandbox', () => ({ onSandboxFailure: vi.fn(), SANDBOX_REQUIRES_PROJECT: false, sandbox: {} }));

const workbench = vi.hoisted(() => {
  const store = <T,>(value: T) => {
    let current = value;
    const listeners = new Set<(next: T) => void>();

    return {
      get: () => current,
      set: (next: T) => {
        current = next;
        listeners.forEach((listen) => listen(current));
      },
      subscribe: (listen: (next: T) => void) => {
        listeners.add(listen);
        listen(current);

        return () => listeners.delete(listen);
      },
      listen: (listen: (next: T) => void) => {
        listeners.add(listen);

        return () => listeners.delete(listen);
      },
    };
  };

  return {
    files: store({}),
    previews: store([] as unknown[]),
    firstArtifact: { runner: { actions: store({} as Record<string, { type: string; status: string }>) } },
    alert: store(undefined),
    deployAlert: store(undefined),
    supabaseAlert: store(undefined),
    artifacts: store({}),
    showWorkbench: store(false),
    addArtifact: vi.fn(),
    updateArtifact: vi.fn(),
    addAction: vi.fn(),
    runAction: vi.fn(),
    addCompletedAction: vi.fn(),
    clearAlert: vi.fn(),
    clearDeployAlert: vi.fn(),
    clearSupabaseAlert: vi.fn(),
    abortAllActions: vi.fn(),
    getModifiedFiles: vi.fn(),
    resetAllFileModifications: vi.fn(),
    setReloadedMessages: vi.fn(),
  };
});
vi.mock('~/lib/stores/workbench', () => ({ workbenchStore: workbench }));
vi.mock('~/lib/stores/mcpBridge', async () => {
  const { atom } = await import('nanostores');

  return { syncMcpBridge: vi.fn(async () => undefined), callMcpTool: vi.fn(), mcpToolsAtom: atom([]) };
});
vi.mock('~/lib/media/tasks', () => ({ trackMediaTask: vi.fn(), mediaRenderStore: null }));

vi.mock('framer-motion', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  useAnimate: () => [{ current: null }, vi.fn(async () => undefined)],
}));
vi.mock('~/components/sidebar/Menu.client', () => ({ Menu: () => null }));
vi.mock('./BootScreen', () => ({ BootScreen: () => null, CreationSplash: () => null }));
vi.mock('@remix-run/react', () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));

/**
 * The send button carries whatever text the test put in the box, so the SAME real handler is driven for
 * an ordinary message and for each slash command. That is the whole point: the rule under test is where
 * the clear sits relative to the interceptions, and a stub that could only send one string cannot see it.
 */
let outbound = 'add a boost pad';

vi.mock('./BaseChat', () => ({
  BaseChat: (props: any) => (
    <div>
      <button
        type="button"
        onClick={() => void props.onSelectEntry({ id: 'gm_racing_v1', title: 'Arcade Racing', genre: 'racing' })}
      >
        new project
      </button>
      <button type="button" onClick={() => void props.sendMessage({} as React.UIEvent, outbound)}>
        send
      </button>
    </div>
  ),
}));

import { bootProgress } from '~/lib/stores/boot-progress';
import {
  enterNewProjectMode,
  newProjectModeKey,
  newProjectModeStore,
  readNewProjectMode,
} from '~/lib/stores/new-project-mode';
import { projectId } from '~/lib/persistence/useChatHistory';
import { ChatImpl } from './Chat.client';

const BRIEF = '<creation-brief>the play contract, the scaffolded class, the images on disk</creation-brief>';

let wire: string[] = [];

const agentRequests = () => wire.filter((call) => call.includes('/api/agent'));

beforeEach(() => {
  vi.clearAllMocks();
  wire = [];
  outbound = 'add a boost pad';
  localStorage.clear();
  newProjectModeStore.set(null);

  /* Module-level, and it survives a `cleanup()` — leave it set and the next mount opens the last project. */
  projectId.set(undefined);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      wire.push(`${init?.method ?? input?.method ?? 'GET'} ${url}`);

      const body = url.includes('/repo') ? { linked: false } : { project: { id: 'proj_1', name: 'Arcade Racing' } };

      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );

  seams.createProjectFromRegistry.mockResolvedValue({
    assistantMessage: '<boltArtifact id="project-setup" title="Arcade Racing"></boltArtifact>',
    userMessage: BRIEF,
    className: 'ArcadeRacingMode',
  });
  seams.waitForMountVisible.mockResolvedValue(undefined);
  seams.settleAfterCreation.mockResolvedValue({ elapsedMs: 12, finalCount: 78, quiesced: true });
  seams.awaitStarterRunning.mockResolvedValue({ installed: true, serving: true, elapsedMs: 3_400 });
  bootProgress.set({ step: 'idle' });
  workbench.previews.set([]);
  workbench.firstArtifact.runner.actions.set({});
});

/**
 * 🔴 DRAIN BEFORE THE NEXT TEST RESETS THE STORES.
 *
 * `runStartProject` is a long async chain and `cleanup()` only unmounts the component — it does not
 * cancel the chain. A creation still in flight when a test ends calls `enterNewProjectMode` on its way
 * out, and the mode store is MODULE-LEVEL: that write lands in whichever test is running by then,
 * re-populating a store the next `beforeEach` had just emptied. It is invisible in a fast solo run and
 * appears under full-suite load, which is the worst shape a flake can take — it reads as a product bug
 * in whichever test happened to be unlucky. Letting the chain finish HERE, after the unmount and before
 * the reset, closes the window instead of re-rolling it.
 */
afterEach(async () => {
  cleanup();

  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
});

const noop = vi.fn();

function mountChat() {
  render(
    <ChatImpl
      initialMessages={[]}
      storeMessageHistory={async () => undefined}
      checkpointProject={async () => undefined}
      importChat={async () => undefined}
      exportChat={noop}
      startFreshChat={noop}
    />,
  );
}

async function click(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Create the project and assert it landed in the mode — every test below starts from here. */
async function createProjectInMode() {
  mountChat();
  await click('new project');

  expect(newProjectModeStore.get()).toEqual({ projectId: 'proj_1', brief: BRIEF });
}

/**
 * 🔴 THE COMPONENT MUST ACTUALLY CALL `hydrateNewProjectMode` — and nothing else can see that.
 *
 * `new-project-mode.spec.ts` proves the hydrate is correct; this proves it is REACHED. The whole app-level
 * guarantee rides on one `useEffect` keyed on the open project, and deleting it breaks nothing loudly: a
 * reloaded project silently loses its brief, and a mode entered for project A follows the user into
 * project B — module state survives an SPA navigate, which is what makes the `null` write load-bearing.
 *
 * Driven through the `projectId` nanostore (the component's own source for `activeProjectId`), so the
 * dependency array is exercised too — not just the mount.
 *
 * These two run FIRST in the file on purpose: they are the only tests here that assert on a store value
 * they did not themselves put there, so they are the ones a leaked creation continuation would corrupt.
 * The `afterEach` drain is the actual fix; this ordering is the belt to its braces.
 */
describe('the open project is hydrated by the component', () => {
  it('mounting on a project whose mode is in storage puts that mode in the live store', async () => {
    /* Persist A's mode, then wipe the live store: exactly the state a page reload leaves behind. */
    enterNewProjectMode({ projectId: 'proj_a', brief: BRIEF }, localStorage);
    newProjectModeStore.set(null);

    projectId.set('proj_a');

    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(newProjectModeStore.get()).toEqual({ projectId: 'proj_a', brief: BRIEF });
  });

  /**
   * 🔴 THE LEAK. Project B has no stored mode, and the store is holding A's in memory. The component has
   * to WRITE the null — a hydrate that only writes when it finds something leaves A's banner and A's
   * hidden creation brief attached to a game the user had already built.
   */
  it('switching to a project with no mode CLEARS the store — B never inherits A’s mode', async () => {
    projectId.set('proj_a');

    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    /* A is in the mode, in memory only (no stored record — the mode was entered this session). */
    await act(async () => {
      newProjectModeStore.set({ projectId: 'proj_a', brief: BRIEF });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(newProjectModeStore.get()?.projectId).toBe('proj_a');

    /* The SPA navigate to B. */
    await act(async () => {
      projectId.set('proj_b');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(newProjectModeStore.get()).toBeNull();
  });
});

describe('creation enters New Project mode', () => {
  it('sets the live store with the brief creation built', async () => {
    await createProjectInMode();
  });

  /** Persisted under this project's own key, so a user who refreshes and then types still gets the brief. */
  it('persists it per project, so it survives a reload', async () => {
    await createProjectInMode();

    expect(localStorage.getItem(newProjectModeKey('proj_1'))).toBeTruthy();
    expect(readNewProjectMode('proj_1', localStorage)).toEqual({ projectId: 'proj_1', brief: BRIEF });
  });

  it('CONTROL — and contacted no model on the way in', async () => {
    await createProjectInMode();
    expect(agentRequests()).toEqual([]);
  });
});

/**
 * 🔴 THE RULE THIS FILE EXISTS FOR. A client command is intercepted before anything is posted, so it
 * cannot be the build turn — and the mode must still be there afterwards, brief intact.
 */
describe('a slash command never consumes the mode', () => {
  it.each(['/context', '/effort', '/clear'])('%s leaves the mode intact and posts nothing', async (command) => {
    await createProjectInMode();

    outbound = command;
    await click('send');

    expect(newProjectModeStore.get()).toEqual({ projectId: 'proj_1', brief: BRIEF });
    expect(readNewProjectMode('proj_1', localStorage)?.brief).toBe(BRIEF);

    /* CONTROL: nothing was posted — which is what makes "the mode survived" the right answer. */
    expect(agentRequests()).toEqual([]);
  });

  it('a command then a real build still carries the brief’s mode to the send', async () => {
    await createProjectInMode();

    outbound = '/context';
    await click('send');
    expect(newProjectModeStore.get()?.brief).toBe(BRIEF);

    outbound = 'build my kart racer';
    await click('send');

    expect(newProjectModeStore.get()).toBeNull();
    expect(agentRequests().length).toBeGreaterThan(0);
  });
});

describe('the first build send leaves the mode', () => {
  it('clears the live store AND the persisted record', async () => {
    await createProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    expect(newProjectModeStore.get()).toBeNull();
    expect(localStorage.getItem(newProjectModeKey('proj_1'))).toBeNull();
  });

  it('CONTROL — that send really did post a generation', async () => {
    await createProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    expect(agentRequests().length).toBeGreaterThan(0);
    expect(agentRequests()[0]).toContain('POST');
  });

  /**
   * A message that merely BEGINS with a command word is a message, not a command (`parseClientCommand`
   * is exact-match). It is a build, and it must take the mode with it.
   */
  it('“/clear the obstacles” is a message, so it clears the mode and posts', async () => {
    await createProjectInMode();

    outbound = '/clear the obstacles from the track';
    await click('send');

    expect(newProjectModeStore.get()).toBeNull();
    expect(agentRequests().length).toBeGreaterThan(0);
  });
});
