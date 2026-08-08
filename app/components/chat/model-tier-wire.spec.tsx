// @vitest-environment jsdom
/**
 * THE CHOSEN RUNG RIDES EVERY SEND PATH (§4.6.1a, T12) — read off the wire.
 *
 * `Chat.client.tsx` sends the model tier ONE way: `tier: tierRequested` in the `useChat` **hook body**.
 * Nothing else in the file mentions a tier on a request. That single placement is load-bearing, because
 * the hook body is the BASE that every door into a generation extends:
 *
 *   - the composer (`append(message)`)
 *   - the auto-repair loop (`append(message, { body: { errors, repairOf, repairAttempt } })`)
 *   - the first build turn (`reload()`)
 *
 * ## Why this file is behavioural and not only a scan
 *
 * The whole design rests on a claim about a THIRD-PARTY package: that `append(message, { body })`
 * MERGES its per-call body over the hook's rather than replacing it, and that `reload()` — which passes
 * no body at all — leaves the hook's intact. That is true of the installed `@ai-sdk/react@1.2.12`:
 *
 *   node_modules/@ai-sdk/react/dist/index.mjs:316-318
 *       data: chatRequest.data,
 *       ...extraMetadataRef.current.body,   // the hook body
 *       ...chatRequest.body                 // the per-call body, spread OVER it
 *
 * A source scan of our file cannot see that. So if an SDK upgrade ever flipped the merge to a replace,
 * every scan here would stay green while **every repair turn silently downgraded to Standard** — a
 * repair being exactly the moment a user most wants the model they paid for, and a downgrade being
 * invisible: nothing throws, the build still gets fixed or does not, and the bill goes DOWN.
 *
 * So the tier is asserted where it actually matters: in the JSON body of a real `POST /api/agent`,
 * driven through the real `useChat` with only `globalThis.fetch` swapped out. Same harness shape as
 * `creation-no-agent-request.spec.tsx` — `ChatImpl`'s chrome is stubbed, the network is not.
 *
 * What the wire cannot prove is kept as a scoped, comment-stripped source scan at the bottom: that the
 * fallback rung is `'standard'` and not some other rung, that the tier is read as a RENDER CAPTURE, and
 * that the repair call does not re-declare `tier` (a re-declaration would win the spread, and only for
 * repairs — the wire tests would still pass for the composer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/*
 * The workbench store constructs a `FilesStore` + `PreviewsStore` at MODULE LOAD and binds them to the
 * sandbox. Taken by shape — except `alert`, which is a REAL store here because setting it is how the
 * auto-repair turn below is fired.
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
    previews: store([] as unknown[]),
    firstArtifact: { runner: { actions: store({} as Record<string, { type: string; status: string }>) } },
    alert: store(undefined as unknown),
    deployAlert: store(undefined),
    supabaseAlert: store(undefined),
    artifacts: store({}),
    showWorkbench: store(false),
    addArtifact: vi.fn(),
    updateArtifact: vi.fn(),
    addAction: vi.fn(),
    runAction: vi.fn(),
    addCompletedAction: vi.fn(),
    clearAlert: vi.fn(() => workbenchAlertReset()),
    clearDeployAlert: vi.fn(),
    clearSupabaseAlert: vi.fn(),
    abortAllActions: vi.fn(),
    getModifiedFiles: vi.fn(),
    resetAllFileModifications: vi.fn(),
    setReloadedMessages: vi.fn(),
  };
});

/* `clearAlert` really clears, so the repair effect cannot re-fire off a stale alert on the next render. */
function workbenchAlertReset() {
  workbench.alert.set(undefined);
}

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

/** `BaseChat` stands in for the two surfaces that start work: the New Project card and the composer. */
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
    </div>
  ),
}));

import Cookies from 'js-cookie';
import { PROMPT_COOKIE_KEY } from '~/utils/constants';
import { bootProgress } from '~/lib/stores/boot-progress';
import { modelTierStore } from '~/lib/stores/settings';
import { sessionStore } from '~/lib/stores/session';
import type { SessionState } from '~/lib/stores/session';
import { ChatImpl } from './Chat.client';

/* ------------------------------------------------------------------------------- the fetch double */

interface WireCall {
  method: string;
  url: string;
  body: Record<string, any> | undefined;
}

let wire: WireCall[] = [];

/** Every `POST /api/agent` this render actually put on the network, bodies parsed. */
const agentPosts = () => wire.filter((call) => call.method === 'POST' && call.url.includes('/api/agent'));

/**
 * A minimal but REAL AI SDK data-stream response (`@ai-sdk/ui-utils` part codes: `0` text, `8` message
 * annotations, `d` finish). The `agentMeta` annotation is not decoration — `onFinish` reads
 * `generationId` out of it to arm the auto-repair watch, so without it the repair turn below can never
 * fire and its assertion would silently be about nothing.
 */
function agentStream(generationId: string): Response {
  const parts = [
    `0:${JSON.stringify('Done — I added the boost pad.')}\n`,
    `8:${JSON.stringify([{ type: 'agentMeta', value: { generationId } }])}\n`,
    `d:${JSON.stringify({ finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } })}\n`,
  ].join('');

  return new Response(parts, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-vercel-ai-data-stream': 'v1' },
  });
}

/** A session in which every rung is genuinely available — so a narrowing to Standard is a real choice. */
function eligibleSession(balance = 100_000): SessionState {
  return {
    ...sessionStore.get(),
    loading: false,
    authenticated: true,
    accountsEnabled: true,
    credits: {
      ...sessionStore.get().credits,
      balance,
      modelTiers: {
        standardModel: 'claude-sonnet-5',
        tiers: [
          {
            id: 'standard',
            label: 'Standard',
            model: 'claude-sonnet-5',
            minimumCredits: 0,
            available: true,
            serveable: true,
          },
          {
            id: 'premium',
            label: 'Premium',
            model: 'claude-opus-5',
            minimumCredits: 1200,
            available: true,
            serveable: true,
          },
        ],
      },
    },
  } as SessionState;
}

let generationSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  wire = [];
  generationSeq = 0;

  Cookies.remove(PROMPT_COOKIE_KEY);
  modelTierStore.set('standard');
  sessionStore.set(eligibleSession());
  workbench.alert.set(undefined);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      const method = init?.method ?? input?.method ?? 'GET';

      let body: Record<string, any> | undefined;

      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      } catch {
        body = undefined;
      }

      wire.push({ method, url, body });

      if (url.includes('/api/agent')) {
        return agentStream(`gen_${++generationSeq}`);
      }

      const payload = url.includes('/repo') ? { linked: false } : { project: { id: 'proj_1', name: 'Arcade Racing' } };

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );

  seams.createProjectFromRegistry.mockResolvedValue({
    assistantMessage: '<boltArtifact id="project-setup" title="Arcade Racing"></boltArtifact>',
    userMessage: 'CREATION BRIEF — build the game described above.',
    className: 'ArcadeRacingMode',
  });
  seams.waitForMountVisible.mockResolvedValue(undefined);
  seams.settleAfterCreation.mockResolvedValue({ elapsedMs: 12, finalCount: 78, quiesced: true });
  seams.awaitStarterRunning.mockResolvedValue({ installed: true, serving: true, elapsedMs: 3_400 });
  bootProgress.set({ step: 'idle' });
  workbench.previews.set([]);
  workbench.firstArtifact.runner.actions.set({});
});

afterEach(() => cleanup());

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

/** Click and let every promise the handler awaits — including the whole stream — settle. */
async function click(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Create a project, then send an ordinary composer turn. Returns the bodies of every agent POST. */
async function createThenSend() {
  mountChat();
  await click('new project');
  await click('send');

  return agentPosts();
}

/* ================================================================== 1. the wire: every send path */

describe('CONTROLS — the double is on the path and can read what it claims to read', () => {
  it('records a real POST /api/agent with a parseable body carrying the component’s own fields', async () => {
    const posts = await createThenSend();

    expect(posts.length).toBeGreaterThan(0);

    const body = posts[0].body!;

    /*
     * Fields this file is not about, asserted so an empty/undefined body cannot be what satisfies the
     * `tier` assertions below — those would read `undefined === undefined` and pass forever.
     */
    expect(body).toBeTruthy();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.projectId).toBe('proj_1');
    expect(body).toHaveProperty('effort');
  });

  it('records creation’s own project-create request — the double sees non-agent traffic too', async () => {
    mountChat();
    await click('new project');

    expect(wire.some((call) => call.method === 'POST' && call.url.includes('/api/projects'))).toBe(true);
  });
});

describe('the composer carries the chosen rung', () => {
  /*
   * 🔴 THE ORDINARY EDIT TURN — the most common generation in the product, and the one path every other
   * test in this file was silently missing.
   *
   * `createThenSend()` clicks *new project* first, so `creationBrief` is set and its send goes down the
   * `setMessages(...) + reload()` branch. Every case below it therefore exercised ONE path under two
   * describe headings. Measured: injecting `body: { tier: 'BOGUS' }` into `postTurn`'s plain
   * `append(message, attachmentOptions)` — the branch an ordinary edit takes — left all 23 tests and all
   * 195 chat tests green, because nothing here ever reached it.
   *
   * Sending TWICE is what separates them: the first send consumes the creation brief, the second is a
   * plain composer append. The assertion is that the SECOND post carries the rung too, which is the
   * whole point of putting `tier` on the hook body rather than on any one call site.
   */
  it('carries the rung on an ORDINARY edit turn, not only on the first build', async () => {
    modelTierStore.set('premium');

    mountChat();
    await click('new project');
    await click('send');
    await click('send');

    const posts = agentPosts();

    expect(posts.length, 'the second send must have reached the wire as its own generation').toBeGreaterThan(1);
    expect(posts[posts.length - 1].body!.tier).toBe('premium');
  });

  it('sends `standard` by default', async () => {
    const posts = await createThenSend();

    expect(posts[0].body!.tier).toBe('standard');
  });

  /*
   * 🔴 THE RENDER-CAPTURE PROPERTY, BEHAVIOURALLY.
   *
   * `useChat` refreshes its request body from a `useEffect` over `[credentials, headers, body]`
   * (index.mjs:252-263), so the wire carries only what React last COMMITTED. A tier read outside render
   * (`modelTierStore.get()`, or a ref) does not subscribe, so switching rungs would not re-render, the
   * effect would not re-run, and the send would carry the PREVIOUS rung — the `projectId: undefined`
   * bug in the other direction. Switching and immediately sending is the acceptance for T12.
   */
  it('sends the NEW rung when the tier is switched immediately before sending', async () => {
    mountChat();
    await click('new project');

    await act(async () => {
      modelTierStore.set('premium');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await click('send');

    expect(agentPosts()[0].body!.tier).toBe('premium');
  });

  /*
   * NARROWED, and narrowed DOWN. An ineligible rung must fall to Standard and never to another paid
   * rung: falling to `premium` would ask the server for a model the user cannot have, which the server
   * declines — so the visible symptom is a "declined" notice for a rung the user never selected.
   */
  it('narrows an unaffordable rung to `standard`, not to another paid rung', async () => {
    sessionStore.set(eligibleSession(0)); // balance below every paid rung's minimum
    modelTierStore.set('premium');

    const posts = await createThenSend();

    expect(posts[0].body!.tier).toBe('standard');
  });

  /*
   * A rung the operator cannot serve is narrowed for the same reason, on a balance that would otherwise
   * afford it — so this cannot be the affordability rule passing under another name.
   */
  it('narrows an unserveable rung to `standard` even when the balance affords it', async () => {
    const session = eligibleSession();
    session.credits.modelTiers.tiers = session.credits.modelTiers.tiers.map((tier) =>
      tier.id === 'premium' ? { ...tier, serveable: false } : tier,
    );
    sessionStore.set(session);
    modelTierStore.set('premium');

    const posts = await createThenSend();

    expect(posts[0].body!.tier).toBe('standard');
  });
});

/*
 * 🔴 THE FIRST BUILD TURN GOES THROUGH `reload()`, WHICH PASSES NO BODY AT ALL.
 *
 * After a creation the component is in New Project mode carrying the hidden brief, so the user's first
 * send commits both messages and calls `reload()` rather than `append()`. `reload` forwards
 * `body: undefined` (index.mjs:428-441) and `...undefined` is a no-op spread, so the hook body survives
 * whole. That is the most expensive generation in the product; a tier lost here is lost on the turn
 * that matters most.
 */
describe('the first build turn (reload) carries the rung', () => {
  it('sends the tier on the creation-brief send path', async () => {
    modelTierStore.set('premium');

    mountChat();
    await click('new project');
    await click('send');

    const posts = agentPosts();

    expect(posts.length).toBe(1);
    expect(posts[0].body!.tier).toBe('premium');

    /* CONTROL — this really was the brief path: the hidden brief travelled with the user's words. */
    const contents = (posts[0].body!.messages as { content: string }[]).map((m) => m.content).join('\n');
    expect(contents).toContain('CREATION BRIEF');
    expect(contents).toContain('add a boost pad');
  });
});

/*
 * 🔴 THE MERGE ITSELF — the auto-repair turn, which is the ONLY send path with a per-call body.
 *
 * This is the assertion the whole T12 design rests on and the one no source scan can make: the repair's
 * `{ errors, repairOf, repairAttempt }` must arrive ALONGSIDE the hook's `tier`, not instead of it.
 */
describe('the auto-repair turn carries the rung it never mentions', () => {
  /** Create → first build turn → arm the repair watch off its `agentMeta` → break the build. */
  async function driveRepair(tier: 'standard' | 'premium') {
    modelTierStore.set(tier);

    mountChat();
    await click('new project');
    await click('send'); // generation 1 — finishes, arming the repair watch from `gen_1`

    await act(async () => {
      workbench.alert.set({
        type: 'error',
        title: 'Build failed',
        description: 'Failed to resolve import "./Boost"',
        content: 'src/scripts/ArcadeRacingMode.ts:12:8',
        source: 'preview',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    return agentPosts();
  }

  it('fires a second generation off a preview error', async () => {
    const posts = await driveRepair('standard');

    // CONTROL — the repair really happened. Without this every assertion below is about post[0].
    expect(posts.length).toBe(2);
    expect(posts[1].body!.repairOf).toBe('gen_1');
    expect(posts[1].body!.repairAttempt).toBe(1);
    expect(posts[1].body!.errors).toContain('Failed to resolve import "./Boost"');
  });

  it.each(['standard', 'premium'] as const)(
    'carries `%s` on the repair, merged over the per-call body',
    async (tier) => {
      const posts = await driveRepair(tier);

      expect(posts[1].body!.tier).toBe(tier);

      /* And it is the SAME rung the turn being repaired ran on — the T12 acceptance, stated directly. */
      expect(posts[1].body!.tier).toBe(posts[0].body!.tier);
    },
  );

  /*
   * The per-call body must not have cost the hook body anything ELSE either. If a future SDK ever
   * replaced rather than merged, `tier` would be the quiet casualty and `projectId`/`effort` the loud
   * ones — pinning all three makes the failure legible instead of mysterious.
   */
  it('keeps the rest of the hook body on the repair request', async () => {
    const posts = await driveRepair('premium');

    expect(posts[1].body!.projectId).toBe('proj_1');
    expect(posts[1].body).toHaveProperty('effort');
    expect(posts[1].body).toHaveProperty('files');
  });
});

/*
 * The retired field. `premium: boolean` was the T12 predecessor and `premiumModelStore` still exists as
 * a deprecated read-only VIEW, so a well-meaning re-add is one import away — and two fields disagreeing
 * about the same choice is a mis-billed generation the server has no way to adjudicate.
 */
describe('the retired `premium` boolean is off the wire', () => {
  it.each(['standard', 'premium'] as const)('sends no `premium` field on a %s turn', async (tier) => {
    modelTierStore.set(tier);

    const posts = await createThenSend();

    expect(posts[0].body).not.toHaveProperty('premium');
  });
});

/* ============================================ 2. the source scan: what the wire structurally cannot see */

/**
 * Three properties survive a green wire suite:
 *
 *   1. The FALLBACK RUNG. Every wire test above narrows to `'standard'` — but a fallback of `'premium'`
 *      also produces `'standard'` for a user who is not eligible for premium either, so the literal
 *      itself has to be read.
 *   2. The RENDER CAPTURE. The behavioural test catches it today, but only because nothing else
 *      re-renders between the switch and the send; any unrelated re-render would repair a `.get()` and
 *      hand back a false pass.
 *   3. The repair call NOT re-declaring `tier`. A re-declaration wins the spread and downgrades only
 *      repairs — the composer and reload tests above would stay green.
 */
describe('the source scan — the fallback rung, the render capture, and the untouched repair body', () => {
  const REPO = process.cwd();
  const chatRaw = readFileSync(join(REPO, 'app/components/chat/Chat.client.tsx'), 'utf-8');
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const chat = strip(chatRaw);

  /** One statement, from `const <name> =` to the end of its line. */
  function statement(source: string, name: string): string {
    const start = source.indexOf(`const ${name} =`);

    if (start < 0) {
      return '';
    }

    const end = source.indexOf('\n', start);

    return source.slice(start, end < 0 ? source.length : end);
  }

  /** The arguments of one call, brace-matched from `name(` to its balanced close. */
  function callArgs(source: string, name: string): string {
    const start = source.indexOf(`${name}(`);

    if (start < 0) {
      return '';
    }

    const open = source.indexOf('(', start);
    let depth = 0;

    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') {
        depth++;
      } else if (source[i] === ')' && --depth === 0) {
        return source.slice(open, i + 1);
      }
    }

    return '';
  }

  /** The `useChat({ body: { … } })` object, brace-matched from `body: {`. */
  function hookBody(source: string): string {
    const chatCall = source.indexOf('useChat({');

    if (chatCall < 0) {
      return '';
    }

    const start = source.indexOf('body: {', chatCall);

    if (start < 0) {
      return '';
    }

    const open = source.indexOf('{', start);
    let depth = 0;

    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') {
        depth++;
      } else if (source[i] === '}' && --depth === 0) {
        return source.slice(open, i + 1);
      }
    }

    return '';
  }

  /* ------------------------------------------------------------------------------------ controls */

  it('CONTROL — a real Chat.client.tsx was read and its comments are stripped', () => {
    expect(chat.length).toBeGreaterThan(10_000);
    expect(chat).toContain('export const Chat');

    /*
     * 🔴 STRIPPING IS LOAD-BEARING HERE, LITERALLY. The doc comments T12 added contain the words
     * `tier`, `premium` and `reload()` while narrating the design — so an unstripped scan would find
     * the wiring "present" in prose alone, which is exactly the false all-clear this section exists to
     * prevent (the `shell-strip.ts` lesson: a comment cannot fail).
     */
    const prose = 'auto-repair `append` (whose per-call `body` extends rather than replaces this one)';

    expect(chatRaw).toContain(prose);
    expect(chat).not.toContain(prose);
  });

  it('CONTROL — every extractor finds real, non-empty code', () => {
    expect(hookBody(chat)).toContain('projectId');
    expect(statement(chat, 'tierRequested')).toContain('canUseTier');
    expect(statement(chat, 'selectedTier')).toContain('modelTier');
    expect(callArgs(chat, 'decideAutoRepair')).toContain('alert');
  });

  /* --------------------------------------------------------------------------------- the wirings */

  it('sets `tier` in the useChat hook body — scoped to that object, not anywhere in the file', () => {
    expect(hookBody(chat)).toMatch(/[{,]\s*tier:\s*tierRequested\s*,/);
  });

  /*
   * The fallback is `'standard'` — the only rung with no eligibility rule attached. A fallback to any
   * other rung asks the server for something it will decline, and the user sees a refusal for a choice
   * they did not make.
   */
  it('narrows through `canUseTier` and falls back to `standard`, never to another rung', () => {
    const tierRequested = statement(chat, 'tierRequested');

    expect(tierRequested).toMatch(/canUseTier\(session, selectedTier\)\s*\?\s*selectedTier\s*:\s*'standard'/);
    expect(tierRequested).not.toMatch(/:\s*'premium'/);
  });

  /*
   * 🔴 A RENDER CAPTURE, not a ref and not a bare `.get()`. `useChat` reads its body from committed
   * render state; a value read outside render is invisible to it until something else happens to
   * re-render — the shape of the `projectId: undefined` bug.
   */
  it('reads the selected rung with `useStore`, not a ref or a bare store read', () => {
    expect(statement(chat, 'selectedTier')).toBe('const selectedTier = useStore(modelTierStore);');
    expect(chat).not.toContain('modelTierStore.get()');
    expect(chat).not.toContain('useRef(modelTierStore');
  });

  /*
   * The repair's per-call body extends the hook body, so anything it names WINS. It must therefore name
   * only what is specific to a repair.
   */
  it('the auto-repair `append` body names only repair fields — it inherits the tier', () => {
    const repairBody = chat.slice(chat.indexOf("append(\n        { role: 'user', content: repairMessage("));
    const scoped = repairBody.slice(0, repairBody.indexOf('}, [actionAlert'));

    expect(scoped).toContain('errors: decision.errors');
    expect(scoped).toContain('repairOf: decision.repairOf');
    expect(scoped).toContain('repairAttempt: decision.repairAttempt');

    // It must not re-declare the tier, nor spread anything that could shadow it.
    expect(scoped).not.toMatch(/\btier\s*:/);
    expect(scoped).not.toMatch(/\.\.\./);
  });

  /*
   * ONE writer of the rung on a request. `tier:` appearing twice would mean two send paths disagreeing
   * about the same choice, which the server cannot adjudicate — it sees only the winner.
   */
  it('sets `tier:` on exactly one request body in the whole file', () => {
    expect(chat.match(/\btier:\s*tierRequested\b/g)).toHaveLength(1);
    expect(chat.match(/^\s*tier:/gm) ?? []).toHaveLength(1);
  });

  /* The retired boolean, structurally: no field, no import, no store read. */
  it('carries no trace of the retired `premium` request field', () => {
    expect(chat).not.toMatch(/^\s*premium:/m);
    expect(chat).not.toContain('premiumModelStore');
    expect(chat).not.toContain('canUsePremium');
  });
});
