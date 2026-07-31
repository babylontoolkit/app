// @vitest-environment jsdom
/**
 * A CREATION DRIVES ZERO `/api/agent` REQUESTS — read off the wire (T5, owner rule 2026-07-29).
 *
 * `runStartProject` used to end with `reload()`: one line that fired the most expensive generation in
 * the product at the end of what the user had asked to be a clone. Its absence is asserted structurally
 * in `creation-no-build.spec.ts` (that file can also see the doors `reload` might come back through);
 * this file asserts the PROPERTY that structure is a proxy for — that pressing New Project puts nothing
 * on the wire for `/api/agent` — because a regression here throws nothing, breaks nothing, and simply
 * bills the user for a game build they did not ask for.
 *
 * ## Why this is a real wire assertion and not a mock count
 *
 * `useChat` is NOT mocked. The real `@ai-sdk/react` hook is mounted with the real `api: '/api/agent'`
 * body this component sends, and the only thing swapped out is `globalThis.fetch`. So `reload()`,
 * `append()`, `handleSubmit()` — every door a generation could come back through, including one nobody
 * has thought of yet — lands in the same recorder. That is the difference between "we did not call the
 * function we remembered to spy on" and "nothing was sent".
 *
 * Two controls make the zero mean something, and both are load-bearing:
 *
 *   1. **The double is on this code path**: creation's own `POST /api/projects` is recorded, so an empty
 *      `/api/agent` list is a fact about creation rather than a fact about a fetch that was never used.
 *   2. **The double can SEE a generation**: the same rendered component, driven through `sendMessage`
 *      (the user's own send), does POST `/api/agent`. Without this, the assertion passes just as well
 *      for a harness in which no request could ever be observed.
 *
 * `ChatImpl`'s chrome (`BaseChat`, the sidebar, the boot screen) is stubbed, and the workbench store is
 * taken by shape — it builds a `FilesStore`/`PreviewsStore` against the sandbox at module load. What is
 * NOT stubbed is anything between the New Project click and the network: `runStartProject` itself, the
 * component's `useChat` wiring, and `fetch`.
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

/*
 * 🔴 A SEAM, NOT A CONVENIENCE. Creation now waits for `npm install` and the dev server before it
 * finishes (T6), and the real `awaitStarterRunning` reads the action runner and the previews store —
 * neither of which exists on the shape-only workbench double below, so it would poll its full 180s
 * install ceiling with a REAL `setTimeout` and never reach the success tail this file reads. That
 * would not fail loudly; it would report zero `/api/agent` requests off a creation that stopped
 * halfway, which is the quiet way this assertion stops meaning anything. The bounds themselves are
 * pinned where they live, in `app/lib/registry/starter-ready.spec.ts`.
 */
/*
 * PARTIAL mock, and deliberately so. Only the WAIT is replaced — a real `awaitStarterRunning` here would
 * park creation on its real 3-minute install ceiling against a shape-only workbench and never reach the
 * success tail, which is how a "zero /api/agent requests" assertion silently becomes a fact about a
 * creation that never finished. `isInstallFinished` stays REAL, because the tests below assert the
 * predicate the component actually hands over; stubbing it would assert the stub.
 */
vi.mock('~/lib/registry/starter-ready', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/registry/starter-ready')>()),
  awaitStarterRunning: seams.awaitStarterRunning,
}));
vi.mock('~/lib/sandbox', () => ({ onSandboxFailure: vi.fn(), SANDBOX_REQUIRES_PROJECT: false, sandbox: {} }));

/*
 * The workbench store constructs a `FilesStore` + `PreviewsStore` at MODULE LOAD and binds them to the
 * sandbox. This file is about what creation puts on the wire, so it takes the store's shape only.
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

  return {
    files: store({}),

    /*
     * The two readers T6's wait is handed. Real stores rather than stubs, because the predicates the
     * component builds over them are the thing under test below.
     */
    previews: store([] as unknown[]),
    firstArtifact: { runner: { actions: store({} as Record<string, { type: string; status: string }>) } },
    alert: store(undefined),
    deployAlert: store(undefined),
    supabaseAlert: store(undefined),
    artifacts: store({}),
    showWorkbench: store(false),

    /*
     * The message parser runs on a 50ms sampler, so the send CONTROL's parse can land after its test
     * has finished. Without these the callback throws into the run as an unhandled error — noise that
     * looks like a product failure and is really a missing method on a shape-only double.
     */
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

/* The chrome. `useAnimate` needs a mounted scope element the stub does not provide. */
vi.mock('framer-motion', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  useAnimate: () => [{ current: null }, vi.fn(async () => undefined)],
}));
vi.mock('~/components/sidebar/Menu.client', () => ({ Menu: () => null }));
vi.mock('./BootScreen', () => ({ BootScreen: () => null, WorkspaceSplash: () => null }));
vi.mock('@remix-run/react', () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));

/**
 * `BaseChat` stands in for every surface that can start work: the New Project card (`onSelectEntry`,
 * §4.4a path B) and the user's own send (`sendMessage`). Both are the component's REAL handlers.
 */
vi.mock('./BaseChat', () => ({
  BaseChat: (props: any) => (
    <div>
      <button
        type="button"
        onClick={() => void props.onSelectEntry({ id: 'gm_racing_v1', title: 'Arcade Racing', genre: 'racing' })}
      >
        new project
      </button>
      <button type="button" onClick={() => void props.sendMessage({} as React.UIEvent, 'add a boost pad')}>
        send
      </button>
      {/*
       * The committed messages, ids only. The creation checkpoint is passed the setup artifact's id, and
       * asserting that id against `/^2-\d+$/` alone would pass just as well for a second `2-` minted next
       * to the real one — which is the way this can be wrong and still look right. Reading the ids the
       * component actually committed makes the assertion an EQUALITY.
       */}
      <div data-testid="message-ids">{props.messages.map((message: any) => message.id).join(',')}</div>
    </div>
  ),
}));

import Cookies from 'js-cookie';
import { PROMPT_COOKIE_KEY } from '~/utils/constants';
import { bootProgress } from '~/lib/stores/boot-progress';
import { ChatImpl } from './Chat.client';

/* ------------------------------------------------------------------------------- the fetch double */

let wire: string[] = [];

const agentRequests = () => wire.filter((call) => call.includes('/api/agent'));

beforeEach(() => {
  vi.clearAllMocks();
  wire = [];

  /*
   * `useChat`'s `initialInput` is seeded from this cookie, and the jar survives `cleanup()`. Left over
   * from a previous test it would put words in the box that this file never typed — and a card click
   * with a non-empty box is now a DIFFERENT path (it carries them), so the leak would silently change
   * which behaviour every test here drives.
   */
  Cookies.remove(PROMPT_COOKIE_KEY);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      wire.push(`${init?.method ?? input?.method ?? 'GET'} ${url}`);

      /*
       * Answered for real, so creation runs to its LAST line — the one `reload()` used to occupy.
       * A double that fails `createProject` would send it down the error branch and never reach the
       * code this file is about, which is the quiet way an assertion like this stops meaning anything.
       */
      const body = url.includes('/repo') ? { linked: false } : { project: { id: 'proj_1', name: 'Arcade Racing' } };

      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );

  seams.createProjectFromRegistry.mockResolvedValue({
    assistantMessage: '<boltArtifact id="project-setup" title="Arcade Racing"></boltArtifact>',
    className: 'ArcadeRacingMode',
  });
  seams.waitForMountVisible.mockResolvedValue(undefined);
  seams.settleAfterCreation.mockResolvedValue({ elapsedMs: 12, finalCount: 78, quiesced: true });
  seams.awaitStarterRunning.mockResolvedValue({ installed: true, serving: true, elapsedMs: 3_400 });
  bootProgress.set({ step: 'idle' });
  workbench.previews.set([]);
  workbench.firstArtifact.runner.actions.set({});
  checkpointProject = vi.fn(async (_messageId: string) => undefined);
});

afterEach(() => cleanup());

const noop = vi.fn();

/**
 * 🔴 THE END MARKER, AND THE FEATURE.
 *
 * This is both the last statement of `runStartProject`'s success tail (so a call proves creation did not
 * fall into the catch branch — the job the now-carried prompt cookie used to do here) and the thing the
 * checkpoint tests below are about. One spy, declared per test in `beforeEach`.
 */
let checkpointProject = vi.fn(async (_messageId: string) => undefined as void | undefined);

function mountChat() {
  render(
    <ChatImpl
      initialMessages={[]}
      storeMessageHistory={async () => undefined}
      checkpointProject={checkpointProject}
      importChat={async () => undefined}
      exportChat={noop}
      startFreshChat={noop}
    />,
  );
}

/** Click and let every promise `runStartProject` awaits settle before reading the wire. */
async function click(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('a creation contacts no model at all', () => {
  it('drives ZERO /api/agent requests', async () => {
    mountChat();
    await click('new project');

    expect(seams.createProjectFromRegistry).toHaveBeenCalledTimes(1);
    expect(seams.settleAfterCreation).toHaveBeenCalledTimes(1);

    /*
     * 🔴 The end marker. `reload()` was the LAST thing `runStartProject` did, so a creation that fell
     * into the catch branch would never have reached it — and a zero read off a half-run creation is
     * the quiet way this assertion stops meaning anything.
     *
     * It used to be "the prompt cookie was cleared", which stopped being an end marker the moment the
     * card path started CARRYING what the user typed: `applyCreationDraft` clears the cookie and then
     * writes the carried prompt straight back into it, so a completed creation now leaves it SET. The
     * creation checkpoint is the honest replacement — it is literally the last statement before
     * `return true`, exactly where `reload()` was.
     */
    expect(checkpointProject).toHaveBeenCalledTimes(1);

    expect(agentRequests()).toEqual([]);
  });

  it('CONTROL — the double is on this path: creation’s own project-create request was recorded', async () => {
    mountChat();
    await click('new project');

    expect(wire.some((call) => call.startsWith('POST') && call.includes('/api/projects'))).toBe(true);
  });

  /**
   * T6 — creation is not "done" until the starter is RUNNING, so the wait is ON this path.
   *
   * Pinned here rather than only in `starter-ready.spec.ts` because that file proves the wait is
   * correct and this one proves it is REACHED: a creation that skips it dismisses the splash over a
   * blank preview, which is exactly the state the owner's success condition names.
   */
  it('waits for the starter to install and serve before creation finishes', async () => {
    mountChat();
    await click('new project');

    expect(seams.awaitStarterRunning).toHaveBeenCalledTimes(1);

    /* The settle comes first: there is nothing to install until the files have stopped arriving. */
    expect(seams.awaitStarterRunning.mock.invocationCallOrder[0]).toBeGreaterThan(
      seams.settleAfterCreation.mock.invocationCallOrder[0],
    );

    /* And it is handed real readers plus a narrator, not defaults. */
    const options = seams.awaitStarterRunning.mock.calls[0][0];
    expect(typeof options.installComplete).toBe('function');
    expect(typeof options.runningPreviews).toBe('function');
    expect(typeof options.onStage).toBe('function');

    /* The narrator writes the two creation phases the splash renders. */
    options.onStage('install');
    expect(bootProgress.get()).toEqual({ step: 'creating-install' });
    options.onStage('serve');
    expect(bootProgress.get()).toEqual({ step: 'creating-serve' });
  });

  /**
   * 🔴 THE DEGRADED PATH. A port that never opens is NORMAL and SILENT (§1.3 principle 0): the project
   * exists, so creation must finish anyway, run its success tail, and take the splash down. Hanging
   * here — or branching to the failure path — leaves a full-screen overlay squatting on a usable chat,
   * which is worse than the blank screen it replaced.
   */
  it('finishes creation and dismisses the splash even when nothing ever serves', async () => {
    seams.awaitStarterRunning.mockResolvedValue({ installed: false, serving: false, elapsedMs: 240_000 });

    mountChat();
    await click('new project');

    /* Reached the success tail (its last statement, the creation checkpoint), not the catch branch. */
    expect(checkpointProject).toHaveBeenCalledTimes(1);

    /* Splash down — `startProject`'s `finally` owns this on every exit. */
    expect(bootProgress.get()).toEqual({ step: 'idle' });

    /* And still no model was contacted on the way through. */
    expect(agentRequests()).toEqual([]);
  });

  /**
   * 🔴 "FINISHED" INCLUDES FAILED AND ABORTED.
   *
   * The install predicate is built in the component over the setup artifact's shell actions, and the
   * tempting version — "wait until it SUCCEEDED" — spends the entire 180s install window narrating
   * `npm install` at a user whose install already gave up, then dismisses the splash as if it had
   * timed out. An install that errors is a project the user needs to LOOK at, immediately.
   *
   * Driven through the predicate the component actually handed to the wait, not a copy of it.
   */
  describe('the install predicate the component hands to the wait', () => {
    const shells = (...statuses: string[]) =>
      Object.fromEntries(statuses.map((status, index) => [`a${index}`, { type: 'shell', status }]));

    async function installComplete(actions: Record<string, { type: string; status: string }>) {
      mountChat();
      await click('new project');
      workbench.firstArtifact.runner.actions.set(actions);

      return seams.awaitStarterRunning.mock.calls[0][0].installComplete() as boolean;
    }

    it.each([
      ['pending', false],
      ['running', false],
      ['complete', true],
      ['failed', true],
      ['aborted', true],
    ])('reads a single %s shell action as complete=%s', async (status, expected) => {
      expect(await installComplete(shells(status))).toBe(expected);
    });

    it('waits for ALL shell actions, not just the first', async () => {
      expect(await installComplete(shells('complete', 'running'))).toBe(false);
    });

    /* Nothing to wait for yet is NOT "done" — the artifact's actions arrive after it is committed. */
    it('is not complete before any shell action exists', async () => {
      expect(await installComplete({})).toBe(false);
    });

    /* `start` (the dev server) never ends, so counting it would make the install wait unreachable. */
    it('ignores non-shell actions', async () => {
      expect(await installComplete({ dev: { type: 'start', status: 'running' }, ...shells('complete') })).toBe(true);
    });
  });

  /** The serve reader is the previews store — the same signal `awaitRunningPreview` polls on the wake path. */
  it('reads the running previews from the workbench store', async () => {
    mountChat();
    await click('new project');

    const { runningPreviews } = seams.awaitStarterRunning.mock.calls[0][0];

    expect(runningPreviews()).toBe(0);
    workbench.previews.set([{ port: 5173 }]);
    expect(runningPreviews()).toBe(1);
  });

  /**
   * 🔴 A CREATED PROJECT UPLOADS ITS CONVERSATION — nothing else will (found live, 2026-07-29).
   *
   * The server copy of a chat is written by `checkpointProject` at the END of a generation, and creation
   * no longer runs one (T5). So a created-but-not-yet-built project uploaded NOTHING: `/api/chats`
   * returned `[]` and the sidebar read "No previous conversations" beside the open chat. Nothing threw —
   * the old flow uploaded the transcript as a SIDE EFFECT of the generation it fired, a dependency
   * nobody had written down, so deleting the generation deleted the upload with it.
   *
   * Which makes the id the whole assertion: a checkpoint against the wrong message id is a checkpoint
   * that runs, succeeds, and stores the wrong thing.
   */
  describe('creation checkpoints the fresh project', () => {
    it('exactly once, with the setup artifact’s message id', async () => {
      mountChat();
      await click('new project');

      expect(checkpointProject).toHaveBeenCalledTimes(1);

      const [id] = checkpointProject.mock.calls[0];

      /* The id of the ONE message creation committed — read back off the render, not pattern-matched. */
      expect(screen.getByTestId('message-ids').textContent).toBe(id);
      expect(id).toMatch(/^2-\d+$/);
    });

    /**
     * 🔴 FIRE-AND-FORGET MEANS THE NET NEVER TAKES DOWN THE THING IT PROTECTS.
     *
     * The project is mounted, installed and serving by the time this runs; a failed upload is a chat
     * that is missing from the sidebar until the first build turn, which is precisely the state that
     * existed before the fix. Letting the rejection escape would instead send a perfectly good creation
     * into the catch branch and tell the user their setup did not finish — and an unawaited rejection in
     * jsdom surfaces as an unhandled error, i.e. loudly wrong for a strictly better outcome.
     */
    it('a REJECTED checkpoint does not fail the creation or strand the splash', async () => {
      checkpointProject = vi.fn(async () => {
        throw new Error('the working copy could not be uploaded');
      });

      mountChat();
      await click('new project');

      expect(checkpointProject).toHaveBeenCalledTimes(1);

      /* The success tail still ran to the end: the mode was entered and the splash came down. */
      expect(bootProgress.get()).toEqual({ step: 'idle' });

      /* And the project is still there — no rollback, no error alert, no second attempt. */
      expect(seams.createProjectFromRegistry).toHaveBeenCalledTimes(1);
      expect(agentRequests()).toEqual([]);
    });
  });

  it('CONTROL — the double CAN see a generation: the user’s own send posts /api/agent', async () => {
    mountChat();
    await click('new project');
    expect(agentRequests()).toEqual([]); // still zero on the way in

    await click('send');

    expect(agentRequests().length).toBeGreaterThan(0);
    expect(agentRequests()[0]).toContain('POST');
  });
});
