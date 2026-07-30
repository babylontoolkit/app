// @vitest-environment jsdom
/**
 * TWO MOMENTS, TWO MESSAGES — project ready vs. game ready (T12).
 *
 * Creation no longer builds anything: it ends with an untouched starter that RUNS. The first build turn
 * is what produces a game. So the one celebration this product had — "🎮 Your game is ready — open
 * Preview to play it." — had to split, and the split lives in two places that cannot see each other:
 *
 *   1. creation says "Your project is ready" on the HANDOFF CARD (§4.4a) and toasts nothing at all —
 *      the card is the surface for that moment, and a toast repeating it would be a second, shorter-lived
 *      copy of the same sentence competing with the thing the user is meant to read and act on;
 *   2. `creationCompleteRef` is armed in `sendMessage`, on the FIRST BUILD SEND, and consumed in
 *      `onFinish` once every queued action has settled.
 *
 * Both failure modes are silent and both are lies. Armed at creation (where it used to be, one line above
 * the deleted `reload()`), the game-ready toast congratulates the user on a template they have not
 * touched — and it fires on whatever generation happens to come next, which after a project switch is
 * somebody else's edit. Never armed, the turn that actually builds the game says nothing.
 *
 * Behavioural, not structural: the real `ChatImpl` is mounted, the real `useChat` posts to a recorded
 * `fetch`, and the real `waitForActionsSettled` polls the real workbench artifact statuses this file
 * drives. Only `react-toastify` and the chrome are doubled — the toast IS the observable behaviour, so
 * everything between the click and it stays real.
 *
 * The harness is `new-project-mode-wiring.spec.tsx`'s, with two additions: a toast recorder, and control
 * over the action statuses `waitForActionsSettled` reads.
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

/* ------------------------------------------------------------------ the toast: the behaviour under test */

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  ToastContainer: () => null,
}));

/**
 * The workbench double, plus the two things this file needs beyond the wiring spec's.
 *
 * 1. `artifacts` holds real artifacts whose action statuses the test drives, because
 *    `waitForActionsSettled` reads exactly `artifacts.get()[*].runner.actions.get()[*]` and nothing else
 *    can tell the settled branch from the honest "still writing" one.
 *
 * 2. 🔴 IT ALWAYS HOLDS THE CREATION SETUP ARTIFACT — `{shell npm install: complete, start npm run dev:
 *    running}` — because the real tab does, forever. Artifacts are never removed from the store, and the
 *    dev server's `start` action never reaches a terminal state (that is what "the server is up" looks
 *    like to the runner). The first draft of this file gave the double only the TURN's actions, which is
 *    a shape the product never has, and it hid a blocking defect: the wait could never settle in a real
 *    tab, so the game-ready toast would never fire and 120s later the honest variant would fire instead,
 *    counting the dev server as an unwritten file. A double that is tidier than production tests a
 *    product that does not exist.
 */
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

  /** The creation setup artifact's actions — `npm install` then the dev server, exactly as it lands. */
  const setupActions = store({
    'setup-install': { type: 'shell', status: 'complete' },
    'setup-serve': { type: 'start', status: 'running' },
  } as Record<string, { type: string; status: string }>);

  /** The build turn's own actions — the file writes the tests drive. */
  const turnActions = store({} as Record<string, { type: string; status: string }>);

  return {
    files: store({}),
    previews: store([] as unknown[]),
    setupActions,
    turnActions,

    /* `firstArtifact` IS the setup artifact in a real tab — creation's is the first one added. */
    firstArtifact: { runner: { actions: setupActions } },
    alert: store(undefined),
    deployAlert: store(undefined),
    supabaseAlert: store(undefined),
    artifacts: store({ 'project-setup': { runner: { actions: setupActions } } } as Record<
      string,
      { runner: { actions: typeof setupActions } }
    >),
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

/** Whatever the test put in the box — the same real `sendMessage` handles a build and an ordinary edit. */
let outbound = 'build my kart racer';

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
      {/* The real Stop button's prop — `abort`, reached exactly the way the chat row reaches it. */}
      <button type="button" onClick={() => props.handleStop()}>
        stop
      </button>
    </div>
  ),
}));

import { toast } from 'react-toastify';
import { bootProgress } from '~/lib/stores/boot-progress';
import { newProjectModeStore } from '~/lib/stores/new-project-mode';
import { projectId } from '~/lib/persistence/useChatHistory';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import { ChatImpl } from './Chat.client';

const toastSuccess = toast.success as unknown as ReturnType<typeof vi.fn>;
const toastInfo = toast.info as unknown as ReturnType<typeof vi.fn>;

const BRIEF = [CREATION_BRIEF_MARKER, '<creation-brief>the play contract, the scaffolded class</creation-brief>'].join(
  '\n\n',
);

const GAME_READY = '🎮 Your game is ready — open Preview to play it.';

/** Every string this component has toasted as a success, in order. */
const successes = () => toastSuccess.mock.calls.map(([message]) => String(message));
const infos = () => toastInfo.mock.calls.map(([message]) => String(message));

let wire: string[] = [];
const agentRequests = () => wire.filter((call) => call.includes('/api/agent'));

/**
 * Put N file-write actions on the TURN's artifact, alongside the creation setup artifact that is always
 * in the store. `type: 'file'` because these are the writes the wait is actually about — the dev server
 * is a `start`, and mislabelling one as the other is exactly the confusion `settleableStatuses` ends.
 */
function setTurnWrites(statuses: string[]) {
  const actions: Record<string, { type: string; status: string }> = {};

  statuses.forEach((status, index) => {
    actions[`action_${index}`] = { type: 'file', status };
  });

  workbench.turnActions.set(actions);
  workbench.artifacts.set({
    /* Never removed, never terminal — the real tab's permanent resident. */
    'project-setup': { runner: { actions: workbench.setupActions } },
    ...(statuses.length ? { 'artifact-1': { runner: { actions: workbench.turnActions } } } : {}),
  });
}

/**
 * How the NEXT `/api/agent` request behaves. `'ok'` streams and finishes; `'hold'` streams a first chunk
 * and then stays open until the request is aborted (so Stop happens MID-generation, which is the only
 * state `abort()` is ever reached from); `'fail'` is a 500, which drives `onError` — the door the second
 * disarm site exists for, since `abort()` never runs on that path.
 */
let agentBehaviour: 'ok' | 'hold' | 'fail' = 'ok';

beforeEach(() => {
  vi.clearAllMocks();
  wire = [];
  outbound = 'build my kart racer';
  agentBehaviour = 'ok';
  localStorage.clear();
  newProjectModeStore.set(null);
  projectId.set(undefined);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      wire.push(`${init?.method ?? input?.method ?? 'GET'} ${url}`);

      /* A REAL data stream — `useChat` errors on anything else, and its error path skips `onFinish`. */
      if (url.includes('/api/agent')) {
        if (agentBehaviour === 'fail') {
          return new Response('the model died', { status: 500 });
        }

        if (agentBehaviour === 'hold') {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('0:"building"\n'));

              /* Stop aborts the request; without this the reader would hang past the test. */
              init?.signal?.addEventListener('abort', () => {
                try {
                  controller.close();
                } catch {
                  /* already closed */
                }
              });
            },
          });

          return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }

        return new Response('0:"ok"\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }

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
  setTurnWrites([]);
});

/** Drain the in-flight creation chain before the next test resets the module-level stores. */
afterEach(async () => {
  cleanup();

  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  vi.useRealTimers();
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

/** Let real timers run for `ms` while React flushes — the settle waiter polls every 250ms. */
async function settleFor(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function createProject() {
  mountChat();
  await click('new project');

  expect(newProjectModeStore.get()).toMatchObject({ projectId: 'proj_1', brief: BRIEF });
}

/* ------------------------------------------------------------------------------------------ creation */

describe('creation celebrates a PROJECT, never a game', () => {
  it('never says the game-ready line, and does not toast over the handoff card', async () => {
    await createProject();

    expect(successes()).not.toContain(GAME_READY);

    /*
     * And no toast of its own. "Your project is ready" is the card's heading now; it was briefly BOTH,
     * which put the sentence on screen twice and gave the transient copy to the one that disappears.
     */
    expect(successes()).toEqual([]);

    /* CONTROL: the only reason there is no game to celebrate — nothing was built. */
    expect(agentRequests()).toEqual([]);
  });

  /**
   * 🔴 THE MUTATION SENTINEL for the arming site.
   *
   * Arming at creation (where the line used to live) is invisible on the creation itself — creation runs
   * no generation, so nothing consumes the ref and every assertion above still passes. It becomes visible
   * on the NEXT generation the component sees, whichever project that belongs to: a ref is component
   * state and survives an SPA navigate, so a user who creates a project, opens another one from the
   * sidebar and asks for an edit gets "🎮 Your game is ready" for a game this turn did not build.
   *
   * Armed at the first build SEND instead, project B's edit is an ordinary turn and says nothing.
   */
  it('a creation followed by an ordinary edit on ANOTHER project never says game ready', async () => {
    await createProject();

    /* The sidebar navigate. Hydration clears the mode: B was never in New Project mode. */
    await act(async () => {
      projectId.set('proj_b');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(newProjectModeStore.get()).toBeNull();

    outbound = 'make the car red';
    await click('send');
    await settleFor(400);

    /* CONTROL: that really was a generation — it posted, and it finished. */
    expect(agentRequests().length).toBeGreaterThan(0);
    expect(successes()).not.toContain(GAME_READY);
    expect(infos().join('\n')).not.toContain('still writing');
  });
});

/* ---------------------------------------------------------------------------------- the first build turn */

describe('the first build turn celebrates the GAME — once its actions have settled', () => {
  it('says nothing while a file is still being written, then celebrates when it lands', async () => {
    await createProject();

    /* The turn queued one write, and the runner is still on it when the model stops talking. */
    setTurnWrites(['running']);

    outbound = 'build my kart racer';
    await click('send');
    await settleFor(400);

    /*
     * The stream has ended and the toast has NOT fired. This is the whole point of the settle wait: the
     * model stopping is not the project being written.
     */
    expect(successes()).not.toContain(GAME_READY);

    setTurnWrites(['complete']);
    await settleFor(400);

    /* And it is the ONLY success toast in the whole flow — creation contributed none. */
    expect(successes()).toEqual([GAME_READY]);
  });

  /** A prose-only turn queues nothing; an empty action list is settled by definition, so it fires at once. */
  it('celebrates immediately when the turn queued no actions at all', async () => {
    await createProject();

    setTurnWrites([]);

    outbound = 'build my kart racer';
    await click('send');
    await settleFor(400);

    expect(successes()).toContain(GAME_READY);
    expect(infos().join('\n')).not.toContain('still writing');
  });

  /**
   * 🔴 THE HONEST VARIANT. A runner that never settles (a wedged sandbox, a dropped socket) must not turn
   * into a claim that the game is ready — nor into silence. Past the waiter's ceiling the product says
   * what is actually happening, and names the count.
   *
   * Fake timers with `shouldAdvanceTime` so the real awaits in the creation chain still resolve, while
   * the 120s ceiling can be crossed without a 120s test.
   */
  it('a build that ends mid-write reports "still writing N file(s)" instead of ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await createProject();

    /* Two writes that never finish. */
    setTurnWrites(['running', 'pending']);

    outbound = 'build my kart racer';
    await click('send');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000);
    });

    expect(successes()).not.toContain(GAME_READY);
    expect(infos()).toContain('Your project is still writing 2 file(s). It will be ready in the Preview shortly.');
  });

  /**
   * 🔴 THE DEV SERVER IS NOT AN UNFINISHED FILE (the defect a tidier double hid).
   *
   * The store the wait reads holds the creation setup artifact for the whole session, and its
   * `start npm run dev` action is `running` forever — that is what a live server looks like to the
   * runner. Read naively, the first build turn could NEVER settle: no game-ready toast, and 120s later
   * "still writing 1 file(s)" about a dev server that was serving perfectly.
   *
   * Explicit here rather than implicit in the tests above, because this is the assertion that names WHY
   * the double carries the setup artifact — delete it and the next person tidies the double.
   */
  it('settles with a live dev server sitting in the store, and celebrates on time', async () => {
    await createProject();

    /* Exactly the real shape: the permanent setup artifact plus this turn's finished write. */
    setTurnWrites(['complete']);
    expect(workbench.setupActions.get()['setup-serve'].status).toBe('running');
    expect(Object.keys(workbench.artifacts.get())).toEqual(['project-setup', 'artifact-1']);

    outbound = 'build my kart racer';
    await click('send');
    await settleFor(400);

    expect(successes()).toContain(GAME_READY);
    expect(infos().join('\n')).not.toContain('still writing');
  });

  /** Once per project: the second turn is an edit, and an edit is not a game becoming ready. */
  it('the SECOND turn does not celebrate again', async () => {
    await createProject();

    outbound = 'build my kart racer';
    await click('send');
    await settleFor(400);

    expect(successes().filter((message) => message === GAME_READY)).toHaveLength(1);

    outbound = 'now add a boost pad';
    await click('send');
    await settleFor(400);

    expect(successes().filter((message) => message === GAME_READY)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------- the armed ref must disarm */

/**
 * 🔴 AN ARMED CELEBRATION OUTLIVES THE TURN THAT ARMED IT.
 *
 * The ref is armed on the SEND and consumed in `onFinish` — but a build that is STOPPED, or one that dies
 * on `onError`, never reaches `onFinish`. Left armed, the celebration sits there and fires on whatever
 * ordinary turn ends next: ask "what files are there?" three messages later and the product answers
 * "🎮 Your game is ready — open Preview to play it." about a build the user cancelled.
 *
 * Two doors, because `abort()` only runs while a generation is streaming and `onError` is not streaming.
 */
describe('a build that never finished leaves nothing armed', () => {
  it('Stop mid-build: the next ordinary turn does not celebrate', async () => {
    await createProject();

    /* A generation that stays open, so Stop is pressed in the state Stop actually exists for. */
    agentBehaviour = 'hold';
    outbound = 'build my kart racer';
    await click('send');

    await click('stop');

    /* The next turn is an ordinary edit, and it finishes normally. */
    agentBehaviour = 'ok';
    outbound = 'make the car red';
    await click('send');
    await settleFor(400);

    /* CONTROL: two generations really were posted — the assertion is about silence, not inactivity. */
    expect(agentRequests().length).toBeGreaterThan(1);
    expect(successes()).not.toContain(GAME_READY);
    expect(infos().join('\n')).not.toContain('still writing');
  });

  /**
   * The `onError` door. `abort()` never runs here, so `/clear` is the only thing that disarms — and
   * clearing the conversation after a failed build is exactly what a user does before trying again.
   */
  it('a failed build then /clear: the next ordinary turn does not celebrate', async () => {
    await createProject();

    agentBehaviour = 'fail';
    outbound = 'build my kart racer';
    await click('send');
    await settleFor(50);

    /* Nothing to celebrate yet — the generation errored before `onFinish`. */
    expect(successes()).not.toContain(GAME_READY);

    outbound = '/clear';
    await click('send');

    agentBehaviour = 'ok';
    outbound = 'make the car red';
    await click('send');
    await settleFor(400);

    expect(agentRequests().length).toBeGreaterThan(1);
    expect(successes()).not.toContain(GAME_READY);
    expect(infos().join('\n')).not.toContain('still writing');
  });
});

/* ---------------------------------------------------------------------------------------------- control */

describe('CONTROL — an ordinary project', () => {
  /**
   * Without this, "the game-ready toast fired" is unfalsifiable: a component that toasted it on every
   * `onFinish` would pass every assertion above.
   */
  it('never toasts either celebration for a project that was never created here', async () => {
    projectId.set('proj_b');

    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(newProjectModeStore.get()).toBeNull();

    setTurnWrites(['running']);

    outbound = 'make the car red';
    await click('send');
    await settleFor(400);

    expect(agentRequests().length).toBeGreaterThan(0);
    expect(successes()).toEqual([]);
    expect(infos().join('\n')).not.toContain('still writing');
  });
});
