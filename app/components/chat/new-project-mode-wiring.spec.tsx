// @vitest-environment jsdom
/**
 * NEW PROJECT MODE — THE WIRING (T7).
 *
 * `new-project-mode.spec.ts` proves the store. This file proves the three things only the component can
 * be wrong about, each of which fails silently and costs the user their carried prompt (the
 * machine-written creation BRIEF is retired — owner, 2026-08-08 — so the first build turn is an
 * ordinary turn, and these tests pin exactly that):
 *
 *   1. creation ENTERS the mode, carrying the user's own prompt;
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
vi.mock('./BootScreen', () => ({ BootScreen: () => null, WorkspaceSplash: () => null }));
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

/** Per-test switch for the degraded creation path — `POST /api/projects` fails, the project has no id. */
let registrationFails = false;

/**
 * The registry `/api/registry` serves. Only Path A reads it (`decideSeed` ranks a typed prompt against
 * `match_keywords`); every other test in this file enters through a card or the wizard and never looks.
 */
const REGISTRY_ENTRIES = [
  {
    id: 'gm_racing_v1',
    title: 'Arcade Racing',
    genre: 'racing',
    description: 'Drive fast around a track.',
    source_class: 'RacingMode.ts',
    match_keywords: ['racing', 'race', 'kart', 'drift'],
    is_active: true,
  },
  {
    id: 'gm_blank_v1',
    title: 'Blank Canvas',
    genre: 'blank',
    description: 'An empty scene.',
    source_class: 'BlankMode.ts',
    match_keywords: [],
    is_active: true,
    is_fallback: true,
  },
];

/**
 * The four wizard steps, as the real `GuidedTour` hands them to `onCompleteTour`. Deliberately rich —
 * a vibe, two mechanics from two different lists (genre + cross-genre) and a twist — because the whole
 * point of the rule under test is that ALL of it survives the trip.
 */
const WIZARD_SELECTION = {
  entry: REGISTRY_ENTRIES[0] as any,
  vibeId: 'neon-night',
  mechanicIds: ['boost', 'score-hud'],
  twist: 'the track melts behind you',
};

vi.mock('./BaseChat', () => ({
  BaseChat: (props: any) => (
    <div>
      {/*
       * 🔴 The REAL registry row, description and all. It used to pass a three-field literal, which was
       * harmless while the card path carried no words — and would have quietly made the card-brief tests
       * below assert a title with no copy after it, i.e. pass while testing half the behaviour.
       */}
      <button type="button" onClick={() => void props.onSelectEntry(REGISTRY_ENTRIES[0])}>
        new project
      </button>
      {/* The FALLBACK row. "Blank Canvas" means "I have no brief", so it must stay on the describe path. */}
      <button type="button" onClick={() => void props.onSelectEntry(REGISTRY_ENTRIES[1])}>
        blank canvas
      </button>
      <button type="button" onClick={() => void props.onCompleteTour(WIZARD_SELECTION)}>
        guided tour
      </button>
      <button type="button" onClick={() => void props.sendMessage({} as React.UIEvent, outbound)}>
        send
      </button>
      {/* The chat box itself — creation writes the carried draft into it through `handleInputChange`. */}
      <div data-testid="chat-input">{props.input}</div>
      {/*
       * The paperclip, driven through the SAME props the real `ChatBox` uses. Attaching is React state on
       * `ChatImpl`, so the only honest way to test it is to set it the way the UI does and then send.
       */}
      <button
        type="button"
        onClick={() => {
          props.setUploadedFiles([new File(['reference-bytes'], 'reference.png', { type: 'image/png' })]);
          props.setImageDataList(['data:image/png;base64,cmVmZXJlbmNlLWJ5dGVz']);
        }}
      >
        attach
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
import { isCreationTurn } from '~/lib/chat/creation-turn';
import { CREATION_BRIEF_MARKER } from '~/types/creation';
import { compileWizardPrompt, summarizeSelection } from '~/lib/registry/wizard';
import { ChatImpl } from './Chat.client';

/** What a picked card carries as the user's words (`briefFromRegistryEntry`). */
const CARD_PROMPT = 'Arcade Racing — Drive fast around a track.';

let wire: string[] = [];

/** What the SDK actually put on the wire — including whether an attachment survived the trip. */
type WireMessage = {
  role: string;
  content: string;
  annotations?: unknown;
  experimental_attachments?: { name?: string; contentType?: string; url?: string }[];
};

/** Every `/api/agent` POST body, parsed — the wire truth about what the model was actually sent. */
let posted: { messages: WireMessage[] }[] = [];

/** Every `POST /api/projects` body — the project NAME, which is derived separately from the brief. */
let created: { name?: string }[] = [];

const agentRequests = () => wire.filter((call) => call.includes('/api/agent'));

/** The user-role messages of the Nth agent request, in the order they ride on the wire. */
const userMessagesOf = (index: number) => (posted[index]?.messages ?? []).filter((message) => message.role === 'user');

beforeEach(() => {
  vi.clearAllMocks();
  wire = [];
  posted = [];
  created = [];
  outbound = 'add a boost pad';
  registrationFails = false;
  localStorage.clear();
  newProjectModeStore.set(null);

  /* Module-level, and it survives a `cleanup()` — leave it set and the next mount opens the last project. */
  projectId.set(undefined);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      wire.push(`${init?.method ?? input?.method ?? 'GET'} ${url}`);

      /*
       * 🔴 THE AGENT RESPONSE MUST BE A REAL DATA STREAM, NOT JSON.
       *
       * `useChat` errors on an unparseable stream, and its error path is not inert: the next send runs
       * `setMessages(messages.slice(0, -1))` to drop the failed turn before retrying. A JSON stub therefore
       * makes every second send a RETRY rather than a new turn — which silently deletes the very message
       * the double-append test is looking for, and would have been read as "the brief was not re-sent".
       */
      if (url.includes('/api/agent')) {
        if (typeof init?.body === 'string') {
          posted.push(JSON.parse(init.body));
        }

        return new Response('0:"ok"\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }

      /*
       * The UNREGISTERED-PROJECT fallback: `POST /api/projects` fails, the runtime is a WebContainer
       * (`SANDBOX_REQUIRES_PROJECT: false`), so creation carries on and produces a local-only project
       * with NO project id. See the describe at the bottom of this file for why that path needs its own
       * coverage rather than being treated as a degenerate case of the happy one.
       */
      if (url.includes('/api/projects') && (init?.method ?? 'GET') === 'POST' && typeof init?.body === 'string') {
        // The project NAME is derived separately from the carried brief — see the card-brief tests.
        created.push(JSON.parse(init.body));
      }

      if (registrationFails && url.includes('/api/projects') && (init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ error: 'registration unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('/api/registry')) {
        return new Response(JSON.stringify({ entries: REGISTRY_ENTRIES }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

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

  expect(newProjectModeStore.get()).toMatchObject({ projectId: 'proj_1', userPrompt: CARD_PROMPT });
}

/**
 * 🔴 THE COMPONENT MUST ACTUALLY CALL `hydrateNewProjectMode` — and nothing else can see that.
 *
 * `new-project-mode.spec.ts` proves the hydrate is correct; this proves it is REACHED. The whole app-level
 * guarantee rides on one `useEffect` keyed on the open project, and deleting it breaks nothing loudly: a
 * reloaded project silently loses its carried prompt, and a mode entered for project A follows the user into
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
    enterNewProjectMode({ projectId: 'proj_a', userPrompt: CARD_PROMPT }, localStorage);
    newProjectModeStore.set(null);

    projectId.set('proj_a');

    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(newProjectModeStore.get()).toMatchObject({ projectId: 'proj_a', userPrompt: CARD_PROMPT });
  });

  /**
   * 🔴 THE LEAK. Project B has no stored mode, and the store is holding A's in memory. The component has
   * to WRITE the null — a hydrate that only writes when it finds something leaves A's banner and A's
   * carried prompt attached to a game the user had already built.
   */
  it('switching to a project with no mode CLEARS the store — B never inherits A’s mode', async () => {
    projectId.set('proj_a');

    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    /* A is in the mode, in memory only (no stored record — the mode was entered this session). */
    await act(async () => {
      newProjectModeStore.set({ projectId: 'proj_a', userPrompt: CARD_PROMPT });
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
  it('sets the live store with the carried prompt', async () => {
    await createProjectInMode();
  });

  /** Persisted under this project's own key, so a user who refreshes still gets the card + prompt. */
  it('persists it per project, so it survives a reload', async () => {
    await createProjectInMode();

    expect(localStorage.getItem(newProjectModeKey('proj_1'))).toBeTruthy();
    expect(readNewProjectMode('proj_1', localStorage)).toMatchObject({ projectId: 'proj_1', userPrompt: CARD_PROMPT });
  });

  it('CONTROL — and contacted no model on the way in', async () => {
    await createProjectInMode();
    expect(agentRequests()).toEqual([]);
  });
});

/**
 * 🔴 THE RULE THIS FILE EXISTS FOR. A client command is intercepted before anything is posted, so it
 * cannot be the build turn — and the mode must still be there afterwards, prompt intact.
 */
describe('a slash command never consumes the mode', () => {
  it.each(['/context', '/effort', '/clear'])('%s leaves the mode intact and posts nothing', async (command) => {
    await createProjectInMode();

    outbound = command;
    await click('send');

    expect(newProjectModeStore.get()).toMatchObject({ projectId: 'proj_1', userPrompt: CARD_PROMPT });
    expect(readNewProjectMode('proj_1', localStorage)?.userPrompt).toBe(CARD_PROMPT);

    /* CONTROL: nothing was posted — which is what makes "the mode survived" the right answer. */
    expect(agentRequests()).toEqual([]);
  });

  it('a command then a real build still carries the mode to the send', async () => {
    await createProjectInMode();

    outbound = '/context';
    await click('send');
    expect(newProjectModeStore.get()?.userPrompt).toBe(CARD_PROMPT);

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

/**
 * 🔴 THE FIRST BUILD TURN IS AN ORDINARY TURN (owner, 2026-08-08).
 *
 * The hidden creation brief is RETIRED. These tests pin the negative space it left: the first build
 * send posts ONE plain user message — no second hidden message, no `CREATION_BRIEF_MARKER` anywhere
 * on the wire — and attachments ride on that one message. A regression that quietly reintroduces a
 * hidden machine message is exactly the complexity the owner removed, and nothing about it would throw.
 *
 * ⚠️ **AMENDED 2026-08-14 (§4.4e): the build is now several REQUESTS, and still exactly one user
 * message per turn.** Phased creation posts a turn per phase, so "ONE request" stopped being the
 * rule — but the rule that mattered never was about the count. It was that nothing MACHINE-WRITTEN
 * hides inside the user's words, and that is asserted harder here than before: the first turn carries
 * the user's text verbatim, and every later phase carries one short visible line. The phase TASK
 * lives in the server's system tail (`creationPhaseNote`), which is why no request body contains it.
 *
 * An earlier draft of phases DID append the task to the user's message. It was visible rather than
 * hidden, so it was not literally the retired brief — and it was the same idea wearing a better hat.
 * These assertions are what caught it.
 */
describe('the first build turn is an ordinary turn — no hidden brief', () => {
  it("posts the user's words alone, with no marker and nothing hidden", async () => {
    await createProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    const users = userMessagesOf(0);
    expect(users).toHaveLength(1);
    expect(users[0].annotations).toBeUndefined();
    expect(users[0].content).toContain('build my kart racer');
    expect(JSON.stringify(posted[0])).not.toContain(CREATION_BRIEF_MARKER);

    /*
     * The phase TASK must not be on the wire from the client. It is a system note the server adds for
     * the turn it applies to — putting it in a message would pay for it on every later turn forever,
     * in an uncached history.
     */
    expect(JSON.stringify(posted[0])).not.toContain('bt-landing skill');
  });

  /**
   * 🔴 EVERY PHASE IS ITS OWN TURN, AND EVERY ONE OF THEM SAYS WHICH PHASE IT IS.
   *
   * The `creationPhase` field is what makes a phase a phase server-side: it selects the tool set (only
   * `art` gets the media tools) and the step ceiling derived from it. A phase turn that forgot it
   * would run with the ordinary policy — which is the monolithic creation this feature replaced.
   */
  it('runs a turn per phase, each naming its phase in the body', async () => {
    await createProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    expect(agentRequests().length).toBeGreaterThan(1);

    const phases = posted.map((body) => (body as { creationPhase?: string }).creationPhase);

    expect(phases[0]).toBe('frontend');
    expect(phases.filter(Boolean).length).toBe(posted.length);

    // No phase runs twice — the latch and the monotonic merge exist to make this impossible.
    expect(new Set(phases).size).toBe(phases.length);
  });

  it('a SECOND send is equally plain — nothing hidden ever enters the history', async () => {
    await createProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    outbound = 'now add a boost pad';
    await click('send');

    expect(agentRequests().length).toBeGreaterThan(1);

    const second = posted[posted.length - 1];
    expect(JSON.stringify(second)).not.toContain(CREATION_BRIEF_MARKER);
    expect(second.messages.filter((message) => message.annotations != null)).toHaveLength(0);
  });

  /** CONTROL — an ordinary project posts the same shape, so "one plain message" is not vacuous. */
  it('CONTROL — an ordinary project posts one plain user message too', async () => {
    projectId.set('proj_b');

    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(newProjectModeStore.get()).toBeNull();

    outbound = 'now add a boost pad';
    await click('send');

    expect(agentRequests()).toHaveLength(1);

    const users = userMessagesOf(0);
    expect(users).toHaveLength(1);
    expect(users[0].content).toContain('now add a boost pad');
    expect(users[0].annotations).toBeUndefined();
  });

  /**
   * 🔴 THE ATTACHMENT RIDES ON THE ONE MESSAGE. "build my game like this" + a reference image is the
   * archetypal first build message; asserted on the WIRE because `useChat`'s `reload()` drops
   * `experimental_attachments` and `convertToCoreMessages` keeps only text parts — both invisible at
   * the component level.
   */
  it('an attached image rides on the first build message', async () => {
    await createProjectInMode();

    await click('attach');

    outbound = 'build my game like this';
    await click('send');

    const users = userMessagesOf(0);
    expect(users).toHaveLength(1);
    expect(users[0].experimental_attachments).toHaveLength(1);
    expect(users[0].experimental_attachments?.[0]).toMatchObject({
      name: 'reference.png',
      contentType: 'image/png',
    });
    expect(users[0].experimental_attachments?.[0].url).toContain('base64');
  });

  /** CONTROL — the ordinary path still carries its attachment, so the assertion above has a baseline. */
  it('CONTROL — an ordinary (non-New-Project) send still carries its attachment', async () => {
    projectId.set('proj_b');

    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(newProjectModeStore.get()).toBeNull();

    await click('attach');

    outbound = 'make the car look like this';
    await click('send');

    const users = userMessagesOf(0);
    expect(users).toHaveLength(1);
    expect(users[0].experimental_attachments).toHaveLength(1);
    expect(users[0].experimental_attachments?.[0]).toMatchObject({ name: 'reference.png' });
  });

  /** A slash command posts nothing, so there is no body at all — and the mode is still armed. */
  it('a slash command in the mode puts NOTHING on the wire', async () => {
    await createProjectInMode();

    outbound = '/context';
    await click('send');

    expect(posted).toEqual([]);
    expect(newProjectModeStore.get()?.userPrompt).toBe(CARD_PROMPT);
  });
});

/**
 * 🔴 THE UNREGISTERED-PROJECT FALLBACK — the path where the send read the mode with the WRONG rule.
 *
 * When `POST /api/projects` fails on a WebContainer runtime, creation deliberately carries on and hands
 * the user a local-only project (§1.3 principle 0 — nothing may stop a project from being created). It
 * has no project id, so `enterNewProjectMode` stores the mode under an EMPTY one: the mode belongs to
 * whatever is open, and writing it under the bare prefix instead would give every such project one
 * shared record.
 *
 * `sendMessage` once read and cleared it `if (activeProjectId)` — a rule that is false on exactly this
 * path, so the mode was never cleared and the premium pill stayed LOCKED for the rest of the session on
 * a project that had since been built. The degraded path is the branch nobody drives by hand, so it is
 * tested rather than trusted.
 */
describe('the unregistered-project fallback (no project id)', () => {
  /** Create with registration failing — the project is local-only and the mode is keyed on ''. */
  async function createUnregisteredProjectInMode() {
    registrationFails = true;
    mountChat();
    await click('new project');

    expect(newProjectModeStore.get()).toMatchObject({ projectId: '', userPrompt: CARD_PROMPT });

    /* CONTROL — this really is the degraded path: nothing registered, so there is no project id. */
    expect(projectId.get()).toBeUndefined();
  }

  it('enters the mode under an empty project id when registration fails', async () => {
    await createUnregisteredProjectInMode();
  });

  it('the first build send is an ordinary turn here too — one plain message, no marker', async () => {
    await createUnregisteredProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    const users = userMessagesOf(0);
    expect(users).toHaveLength(1);
    expect(users[0].annotations).toBeUndefined();
    expect(users[0].content).toContain('build my kart racer');
    expect(JSON.stringify(posted[0])).not.toContain(CREATION_BRIEF_MARKER);
  });

  /**
   * 🔴 **AMENDED 2026-08-14 (§4.4e): the mode now ends with the PLAN, not with the send.**
   *
   * It used to clear the instant the build was posted. Phased creation makes that wrong twice: the
   * plan is the only record of which phases are still owed (a tab that dies mid-build would strand a
   * half-written project), and the mode's presence is what keeps the premium pill locked for EVERY
   * phase rather than only the first — every phase is a build turn.
   *
   * The rule this test defends is unchanged in substance: the mode must not outlive the work. It just
   * ends one moment later, and the assertion is now that it ends when the plan is complete.
   */
  it('the first build send CLEARS the mode — it does not outlive the project it belongs to', async () => {
    await createUnregisteredProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    expect(newProjectModeStore.get()).toBeNull();
    expect(localStorage.getItem(newProjectModeKey(''))).toBeNull();
  });

  /**
   * 🔴 NO PLAN ON THIS PATH, AND THAT IS THE POINT (§4.4e, 2026-08-14).
   *
   * Phased creation needs a project ROW: the server derives "this is a build turn" from
   * `creation_handoff` (`projectOwesBuild`), and with no project id `/api/agent` never loads one. A
   * plan here would post four turns the server treats as ordinary EDITS — four times the cost of the
   * single turn it replaced, with none of the protections it exists to buy.
   *
   * So this path keeps the pre-phase behaviour exactly, and the assertion is the request count: one
   * send, one turn.
   */
  it('runs a single turn — a plan without a project row would be four ordinary edits', async () => {
    await createUnregisteredProjectInMode();

    outbound = 'build my kart racer';
    await click('send');

    expect(agentRequests()).toHaveLength(1);
    expect((posted[0] as { creationPhase?: string }).creationPhase).toBeUndefined();
  });

  /**
   * The premium pill UNLOCKS after. Asserted by driving `isCreationTurn` — the one function the pill
   * reads — over the state this send actually left behind, rather than over a hand-built input: a mode
   * that no code path clears is a lock nothing lifts, and that is what this pairing exists to prove.
   */
  it('leaves isCreationTurn FALSE once the build has been sent', async () => {
    await createUnregisteredProjectInMode();

    /* Locked while the mode is armed. */
    expect(isCreationTurn({ messages: [], newProjectMode: newProjectModeStore.get() })).toBe(true);

    outbound = 'build my kart racer';
    await click('send');

    expect(
      isCreationTurn({
        messages: [{ role: 'user', content: 'build my kart racer' }],
        newProjectMode: newProjectModeStore.get(),
      }),
    ).toBe(false);
  });
});

/**
 * 🔴 THE WIZARD'S COMPILED SELECTIONS (§4.7) — they ride as the CARRIED PROMPT now.
 *
 * On the wizard path the seed carries TWO texts: `prompt` is the compiled selections (preamble + genre
 * + vibe fragment + every mechanic fragment + the twist) and `visiblePrompt` the short friendly
 * summary. The hidden brief that used to smuggle the compiled text to the model is retired (owner,
 * 2026-08-08), so the compiled text IS the carried prompt: the handoff card shows it, and Build sends
 * it. That is a quotation of choices the user explicitly made — four wizard steps — not machine words
 * in their mouth, and dropping it instead would silently discard everything the wizard asked.
 */
describe('the wizard path carries its compiled selections', () => {
  const compiled = () => compileWizardPrompt(WIZARD_SELECTION);
  const summary = () => summarizeSelection(WIZARD_SELECTION);

  async function createViaWizard() {
    mountChat();
    await click('guided tour');
  }

  it('carries the COMPILED selections as the prompt the handoff will offer to build', async () => {
    await createViaWizard();

    const carried = newProjectModeStore.get()?.userPrompt ?? '';

    expect(carried).toBe(compiled());

    /* Not a token of it — the mechanic fragments are the part a regression silently drops. */
    expect(carried).toContain('Features to build:');
    expect(carried).toContain('the track melts behind you');

    /* CONTROL — the summary really is the short one, so "the compiled text travels" has meaning. */
    expect(summary()).not.toBe(compiled());

    /* And creation writes nothing into the box: the card holds it until the user presses Edit or X. */
    expect(screen.getByTestId('chat-input').textContent).toBe('');
  });

  it('the send puts the selections on the wire as the user message — nothing hidden', async () => {
    await createViaWizard();

    outbound = compiled();
    await click('send');

    const users = userMessagesOf(0);
    expect(users).toHaveLength(1);
    expect(users[0].annotations).toBeUndefined();
    expect(users[0].content).toContain('Features to build:');
    expect(users[0].content).toContain('the track melts behind you');
    expect(JSON.stringify(posted[0])).not.toContain(CREATION_BRIEF_MARKER);
  });

  /**
   * CONTROL — PATH A (§4.4a), the typed prompt: the user's own words are the carried prompt, and no
   * wizard heading appears anywhere. The real Path A route: an empty chat with no project, a typed
   * message, `decideSeed` against the registry, `startProject` — no wizard anywhere in it.
   */
  it('CONTROL — a typed-prompt (Path A) creation carries the typed words alone', async () => {
    await act(async () => {
      mountChat();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    outbound = 'build a kart racing game with drifting and boost pads';
    await click('send');

    /* CONTROL — this really was a creation, not an ordinary send: the mode was entered, no model contacted. */
    const mode = newProjectModeStore.get();
    expect(agentRequests()).toEqual([]);

    expect(mode?.userPrompt).toBe('build a kart racing game with drifting and boost pads');
    expect(mode?.userPrompt).not.toContain('Features to build:');
  });
});

/**
 * 🔴 A PICKED GAME TYPE IS A BRIEF (owner, 2026-07-29, reported live).
 *
 * The quick-pick row exists so a user does not have to write a description — and clicking a card used to
 * carry NOTHING, so the handoff offered *Describe your game*: the one screen in the product that asks you
 * to type out the thing you just chose from a menu.
 *
 * `creation-handoff.spec.ts` proves the text is derived correctly. These prove it REACHES the mode, and
 * that it does not disturb the project TITLE derived one line apart.
 */
describe('a picked game type carries its own brief', () => {
  it('carries the card title and copy as the words the handoff will offer to build', async () => {
    await createProjectInMode();

    expect(newProjectModeStore.get()?.userPrompt).toBe(CARD_PROMPT);
  });

  /*
   * 🔴 The regression this fix could easily have introduced. The carried prompt rides on `visiblePrompt`
   * precisely because `prompt` is what `deriveProjectTitle` reads — send it there and the project stops
   * being called "Arcade Racing" and starts being called something squeezed out of the card's copy.
   */
  it('does NOT rename the project after the card copy', async () => {
    await createProjectInMode();

    expect(created.at(-1)?.name).toBe('Arcade Racing');
  });

  /*
   * The fallback stays a fallback. "Blank Canvas — an empty scene" is the choice that MEANS "I do not
   * have a brief yet"; turning it into one would build a random game out of a request for a blank page.
   */
  it('CONTROL — the fallback row still carries no words, so Blank Canvas offers Describe', async () => {
    mountChat();
    await click('blank canvas');

    expect(newProjectModeStore.get()).toMatchObject({ projectId: 'proj_1' });
    expect(newProjectModeStore.get()?.userPrompt).toBeUndefined();
  });
});
