// @vitest-environment jsdom
/**
 * THE CARRIED PROMPT — THE WIRING (T8).
 *
 * `~/lib/chat/new-project-draft.spec.ts` proves the DECISION (clear, then apply, then focus). This file
 * proves it is wired to the real thing, which is the half no pure test can see and the half this repo
 * keeps getting caught by ("correct by construction" is exactly what the MCP relay was before live
 * testing found three defects in it). Five ways the wiring can be wrong while every unit test passes:
 *
 *   1. `clearDraft` is handed something that is not `clearDraftPrompt`, so the pending debounced cookie
 *      write fires a second later and resurrects the old draft over the fill;
 *   2. creation prefills the box again, or writes the prompt back to the `cachedPrompt` cookie — the
 *      two behaviours the handoff card replaced, both of which look harmless and neither of which
 *      throws (the cookie one leaks this project's brief onto the next landing page);
 *   3. the caret lands at 0 because the deferred `setSelectionRange` ran against the controlled
 *      textarea's still-stale DOM value;
 *   4. the card path invents words the user never typed;
 *   5. **Build** grows its own send path and silently loses the hidden brief — the protection that
 *      only exists because it goes through the ordinary `sendMessage`.
 *
 * The `/api/agent` recorder is the CONTROL that keeps this honest about WHICH flow it drove: creation
 * must contact no model at all (T5), so a request here would mean the prompt was sent rather than
 * carried — the exact behaviour T8 replaced.
 *
 * Harness is `new-project-mode-wiring.spec.tsx`'s, with two differences: the stub `BaseChat` renders a
 * REAL textarea bound to `props.input` and `props.textareaRef` (there is nothing to assert otherwise),
 * and `decideSeed` is stubbed because the registry fetch returns no entries under this harness — an
 * empty registry makes every prompt "vague", which routes to the wizard offer and never creates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import Cookies from 'js-cookie';

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
 * The typed-prompt path (§4.4a Path A) routes through `decideSeed`, which reads the game registry — and
 * the registry fetch returns no entries under this harness, making every prompt "vague". Stubbed to the
 * matched decision a real registry would produce, so the test drives creation rather than the offer.
 */
vi.mock('~/lib/registry/match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/registry/match')>()),
  decideSeed: () => ({
    kind: 'matched',
    entry: { id: 'gm_racing_v1', title: 'Arcade Racing', genre: 'racing' },
    matched: ['racer'],
  }),
}));

vi.mock('./BaseChat', () => ({
  BaseChat: (props: any) => (
    <div>
      <button
        type="button"
        onClick={() => void props.onSelectEntry({ id: 'gm_racing_v1', title: 'Arcade Racing', genre: 'racing' })}
      >
        new project
      </button>
      <button type="button" onClick={() => void props.sendMessage({} as React.UIEvent, TYPED_PROMPT)}>
        send
      </button>

      {/*
       * The handoff card's three actions. The CARD itself is covered by `CreationHandoffCard.spec.tsx`
       * (which handler each button calls, and the dismissal); what only this file can see is what
       * `Chat.client` DOES with them — the box, the cookie, the caret, and the wire.
       */}
      <button type="button" onClick={() => props.onCreationEdit(newProjectModeStore.get()?.userPrompt ?? '')}>
        edit brief
      </button>
      <button type="button" onClick={() => props.onCreationDismiss(newProjectModeStore.get()?.userPrompt ?? '')}>
        close card
      </button>
      <button type="button" onClick={() => props.onCreationBuild(newProjectModeStore.get()?.userPrompt ?? '')}>
        build my game
      </button>

      {/* The component under test writes through `handleInputChange` and focuses `textareaRef`. */}
      <textarea data-testid="box" ref={props.textareaRef} value={props.input} onChange={props.handleInputChange} />
    </div>
  ),
}));

import { bootProgress } from '~/lib/stores/boot-progress';
import { newProjectModeStore } from '~/lib/stores/new-project-mode';
import { projectSeedStore, setProjectSeed } from '~/lib/stores/project';
import { projectId } from '~/lib/persistence/useChatHistory';
import { PROMPT_COOKIE_KEY } from '~/utils/constants';
import { ChatImpl } from './Chat.client';

const BRIEF = '<creation-brief>the play contract, the scaffolded class, the images on disk</creation-brief>';

/** The user's own words — what the textbox must hold, byte-exact, when creation is done. */
const TYPED_PROMPT = 'make a neon kart racer with drift boost pads';

let wire: string[] = [];

/** Request bodies too — the project title reaches the server in one, and only the bytes can prove it. */
let bodies: { method: string; url: string; body: any }[] = [];

const agentRequests = () => wire.filter((call) => call.includes('/api/agent'));

beforeEach(() => {
  vi.clearAllMocks();
  wire = [];
  bodies = [];
  Cookies.remove(PROMPT_COOKIE_KEY);
  localStorage.clear();
  newProjectModeStore.set(null);
  setProjectSeed(null);

  /* Module-level, and it survives a `cleanup()` — leave it set and the next mount opens the last project. */
  projectId.set(undefined);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      const method = init?.method ?? input?.method ?? 'GET';
      wire.push(`${method} ${url}`);

      /*
       * The bytes, not just the URL. Two facts are only visible in a request BODY — the title the
       * project is registered under, and whether the first build turn really carried the hidden
       * creation brief — and both are the kind of thing that goes silently missing.
       */
      const raw = init?.body ?? (typeof input === 'object' ? input?.body : undefined);
      let parsed: any;

      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined;
      } catch {
        parsed = raw;
      }

      bodies.push({ method, url, body: parsed });

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

/** Creation is a long async chain behind two bounded waits; let it run out before reading the box. */
async function settle() {
  for (let tick = 0; tick < 8; tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

const box = () => screen.getByTestId('box') as HTMLTextAreaElement;

describe('a typed-prompt creation hands the prompt to the CARD, not to the box', () => {
  it('carries the words on the mode, byte-exact, and leaves the box empty and uncookied', async () => {
    mountChat();
    await click('send');
    await settle();

    /*
     * 🔴 The words live on the MODE now (owner, 2026-07-29). They used to be prefilled straight into the
     * textbox, which reads as leftover state rather than as the next step — *"it kind of feels
     * disconnected to the initial project creation process"* — so the handoff card holds them and only
     * Edit/X put them in the box.
     */
    expect(newProjectModeStore.get()?.userPrompt).toBe(TYPED_PROMPT);

    expect(box().value).toBe('');
    expect(document.activeElement).not.toBe(box());

    /*
     * And NOT in the `cachedPrompt` cookie. That cookie seeds `initialInput` on the next mount — for
     * ANY chat, including the landing page — so a copy here leaked this project's brief onto the next
     * thing the user opened. The mode is the one writer, and it survives a reload on its own.
     */
    expect(Cookies.get(PROMPT_COOKIE_KEY)).toBeUndefined();
  });

  it('CONTROL — and carried it rather than sending it: no model was contacted', async () => {
    mountChat();
    await click('send');
    await settle();

    expect(agentRequests()).toEqual([]);
  });
});

/**
 * THE CARD'S ACTIONS, WIRED (§4.4a).
 *
 * `CreationHandoffCard.spec.tsx` proves which handler each button calls. This proves what `Chat.client`
 * then does — the half no component test can see, and the half this repo keeps getting caught by.
 */
describe('the handoff card puts the prompt in the box only when asked', () => {
  async function createThen(action: string) {
    mountChat();
    await click('send');
    await settle();
    await click(action);
    await settle();
  }

  it('Edit brief fills the box and takes the caret to the end', async () => {
    await createThen('edit brief');

    expect(box().value).toBe(TYPED_PROMPT);
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(TYPED_PROMPT.length);
  });

  /*
   * 🔴 ONCE THE USER HAS TAKEN THE TEXT, IT IS AN ORDINARY DRAFT — AND ORDINARY DRAFTS SURVIVE A RELOAD
   * (found live, 2026-07-29).
   *
   * Both actions also CLOSE the card, and that dismissal is persisted. So without this write, "press
   * Edit, get distracted, reload" came back to a dismissed card AND an empty box, with the words still
   * on the mode where nothing surfaces them — silently unreachable. `useChat` seeds `initialInput` from
   * this cookie, which is the same thing that would have happened had the user typed the words.
   */
  it.each([['edit brief'], ['close card']])('%s persists the draft for a reload', async (action) => {
    await createThen(action);

    expect(Cookies.get(PROMPT_COOKIE_KEY)).toBe(TYPED_PROMPT);
  });

  /*
   * The X is not a request to start typing. Nothing is destroyed — the words are still there to send —
   * but stealing focus would scroll a fresh project's chat box into view for a user who just said "not
   * now".
   */
  it('the X fills the box without stealing focus', async () => {
    await createThen('close card');

    expect(box().value).toBe(TYPED_PROMPT);
    expect(document.activeElement).not.toBe(box());
  });

  /** CONTROL — neither action posts anything. Only Build sends. */
  it.each([['edit brief'], ['close card']])('CONTROL — %s contacts no model', async (action) => {
    await createThen(action);

    expect(agentRequests()).toEqual([]);
  });

  /*
   * 🔴 Build goes through the ORDINARY `sendMessage`, so the first build turn keeps every protection
   * that hangs off it: exactly one `/api/agent` request, carrying the user's words and nothing hidden
   * (the machine-written brief is retired — owner, 2026-08-08).
   */
  it('Build my game posts exactly ONE turn, carrying the user’s words alone', async () => {
    await createThen('build my game');

    expect(agentRequests()).toHaveLength(1);

    const posted = bodies.find((call) => call.url.includes('/api/agent'));
    const contents = (posted?.body?.messages ?? []).map((message: any) => message.content).join('\n');

    expect(contents).toContain(TYPED_PROMPT);
    expect(contents).not.toContain(BRIEF);

    // Sent, so the mode is over — the card cannot come back offering to build a game already building.
    expect(newProjectModeStore.get()).toBeNull();
  });
});

/**
 * A card click on an EMPTY box puts NOTHING IN THE BOX — which is a different statement from "carries
 * nothing".
 *
 * ⚠️ This describe used to assert `userPrompt` was undefined here, on the reasoning that inventing words
 * puts the machine's phrasing in the user's mouth. The owner overruled that for the quick-pick row
 * (2026-07-29): a card's title and copy are the offer the user READ AND CLICKED, so echoing them back is
 * a quotation, and asking someone to describe the genre they just picked from a menu defeats the row
 * entirely. What survives unchanged is everything about the BOX — the whole point of the handoff card is
 * that text does not silently reappear in the composer.
 */
describe('a card-path creation on an empty box leaves the box alone', () => {
  it('empty, uncookied and unfocused — the brief goes to the CARD, never the composer', async () => {
    mountChat();
    expect(box().value).toBe('');

    await click('new project');
    await settle();

    expect(box().value).toBe('');
    expect(Cookies.get(PROMPT_COOKIE_KEY)).toBeUndefined();
    expect(document.activeElement).not.toBe(box());

    /* The card names the project, because nothing else does — the carried brief must not rename it. */
    expect(seams.createProjectFromRegistry.mock.calls[0][0].title).toBe('Arcade Racing');
  });

  /* And the card DOES carry the genre forward, so the handoff offers Build rather than Describe. */
  it('carries the picked card as the brief', async () => {
    mountChat();
    await click('new project');
    await settle();

    expect(newProjectModeStore.get()?.userPrompt).toContain('Arcade Racing');
  });
});

/**
 * 🔴 A CARD IS A GENRE CHOICE, NOT A REASON TO THROW THE USER'S WORDS AWAY (fixed 2026-07-29, reported
 * live).
 *
 * This describe replaces a clause that asserted the OPPOSITE — "a half-typed draft is forgotten" — and
 * that clause was the bug, written down and pinned. The landing page shows a textbox AND a row of genre
 * cards, so "type what you want, then click the genre you meant" is an obvious thing to do, and
 * `handleSelectEntry` never read `input`: the project came out named after the CARD, the carried prompt
 * was empty because there was no prompt to carry, and the New Project banner told the user to edit a
 * prompt that had just been deleted. Nothing threw. The only signal was the user's own report.
 *
 * §4.4a's precedence is explicit-input-over-INFERENCE, and nothing here is inferred: the card picks the
 * entry (better than keyword seeding could), the typed words are the brief AND the title. So all three
 * consumers of the prompt are asserted, because a fix that reaches only some of them is the same bug
 * with a smaller blast radius.
 */
describe('a card-path creation with typed words honours BOTH', () => {
  /** The live report, verbatim. Its derived title is "Shopping Cart Racing" — not the card's. */
  const TYPED_WITH_CARD = 'shopping cart racing through a supermarket at night';

  async function typeThenPickCard() {
    mountChat();

    /*
     * Through the REAL `handleInputChange` the textarea is given — the same path typing takes. It also
     * arms the 1s debounced cookie write that `clearDraftPrompt` must cancel before the prefill.
     */
    await act(async () => {
      fireEvent.change(box(), { target: { value: TYPED_WITH_CARD } });
    });
    expect(box().value).toBe(TYPED_WITH_CARD);

    await click('new project');
    await settle();
  }

  it('names the project from the PROMPT, not the card', async () => {
    await typeThenPickCard();

    /* CONTROL — the card really was the entry that was picked, so this is a title fact, not a path fact. */
    const created = seams.createProjectFromRegistry.mock.calls[0][0];
    expect(created.entry.id).toBe('gm_racing_v1');

    expect(created.title).toBe('Shopping Cart Racing');
    expect(created.title).not.toBe('Arcade Racing');

    /* And the same title is what the server was asked to register the project under. */
    const registration = bodies.find((call) => call.url.includes('/api/projects') && call.method === 'POST');
    expect(registration?.body?.name).toBe('Shopping Cart Racing');
  });

  it('carries the words into the seed and onto the mode, for the card to offer', async () => {
    await typeThenPickCard();

    /* The seed is where the prompt lives during creation (T5 acceptance 5)… */
    expect(projectSeedStore.get()?.prompt).toBe(TYPED_WITH_CARD);

    /* …and the mode is where it lives afterwards, because the seed does not survive a reload. */
    expect(newProjectModeStore.get()?.userPrompt).toBe(TYPED_WITH_CARD);

    /* The box stays empty until the user presses Edit or X on the card. */
    expect(box().value).toBe('');
    expect(Cookies.get(PROMPT_COOKIE_KEY)).toBeUndefined();
  });

  /** CONTROL — carried, not sent. A card click still contacts no model (T5). */
  it('CONTROL — no model was contacted', async () => {
    await typeThenPickCard();

    expect(agentRequests()).toEqual([]);
  });

  /** Whitespace is not words: a box holding only spaces is an empty box, and the card names the project. */
  it('a whitespace-only box is treated as empty', async () => {
    mountChat();
    await act(async () => {
      fireEvent.change(box(), { target: { value: '   ' } });
    });

    await click('new project');
    await settle();

    expect(seams.createProjectFromRegistry.mock.calls[0][0].title).toBe('Arcade Racing');
    expect(projectSeedStore.get()?.prompt).toBeUndefined();
    expect(box().value).toBe('');
  });
});
