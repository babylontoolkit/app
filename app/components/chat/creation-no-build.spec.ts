/**
 * CREATION DOES NOT BUILD THE GAME (T5, owner rule 2026-07-29).
 *
 * `runStartProject` used to end with `reload()` — ONE line that fired the most expensive generation in
 * the product automatically, at the end of what the user had asked to be a clone. T5 deleted it, along
 * with the two messages that existed only to feed that generation (the visible `1-` user prompt and
 * the hidden `3-` creation brief). What remains is the `2-` assistant setup artifact, and it is not
 * decoration: its `shell`/`start` actions ARE the install and the dev server, and its title is what
 * makes the chat visible in the sidebar with no user message present.
 *
 * ## Why this file is shaped like this
 *
 * Every acceptance here fails SILENTLY and in the expensive direction. Re-adding `reload()` is one
 * line, it throws nothing, the project still works — the user is simply billed for a game build they
 * did not ask for. Deleting the `2-` message is also one line, it throws nothing, the project still
 * installs — the chat just never appears in the sidebar again (§4.5.6: a chat needs BOTH a `urlId`
 * and a `description`, and with no user message the artifact title is the only source of either).
 *
 * So the assertions are split by what each seam can honestly prove:
 *
 *   1. **Behaviourally**, where a real seam exists. `createProjectFromRegistry` really builds the
 *      artifact and the real `StreamingMessageParser` really reads it, so "npm install and npm run dev
 *      reach the action runner" and "the artifact is titled with the project title" are driven end to
 *      end, not asserted about a string this file wrote.
 *   2. **Structurally**, for `runStartProject` itself — as a COMPLEMENT to a wire assertion, not as a
 *      substitute for one. `creation-no-agent-request.spec.tsx` renders `ChatImpl` in jsdom with the
 *      real `useChat` and a `fetch` double, drives a New Project, and proves the property directly:
 *      zero `POST /api/agent`. That is what the acceptance asks for, and it is mutation-verified.
 *      The source scan earns its place by catching what a wire assertion structurally cannot — a
 *      generation door re-added but not yet REACHED (a `reload()` behind a branch, in the catch, or
 *      after an early return puts nothing on the wire in a passing run), plus `creationCompleteRef`
 *      and the message-shape rules, which have no network signature at all. It is comment-stripped,
 *      scoped to the one function by its boundaries, and guarded by CONTROLS proving every token it
 *      looks for is one the scanner can actually see.
 *
 * ⚠️ The controls are load-bearing here in a way that is easy to miss: `runStartProject`'s own doc
 * comments QUOTE the deleted code ("`reload()` used to be the next line", "`creationCompleteRef` is
 * NOT armed"). An unstripped scan would find every deleted thing present in prose and report the
 * feature broken; a scan that stripped too much would find nothing and report it fixed forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameRegistryEntry } from '~/types/game-registry';
import type { TemplateFile } from '~/types/template';
import type { BoltAction } from '~/types/actions';
import { StreamingMessageParser } from '~/lib/runtime/message-parser';
import { projectSeedStore, setProjectSeed } from '~/lib/stores/project';

/* ------------------------------------------------------------------ the source scan + its controls */

const REPO = process.cwd();
const chatRaw = readFileSync(join(REPO, 'app/components/chat/Chat.client.tsx'), 'utf-8');
const historyRaw = readFileSync(join(REPO, 'app/lib/persistence/useChatHistory.ts'), 'utf-8');

const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const chat = strip(chatRaw);
const history = strip(historyRaw);

/**
 * The body of `runStartProject`, from its declaration to the declaration of `startProject` (the
 * wrapper that immediately follows it). A boundary rather than a brace match because the function is
 * an async arrow with a destructured options type — the first `{` belongs to the parameter, not the
 * body, and brace-matching from there ends 300 lines early with a plausible-looking string.
 */
function runStartProjectBody(source: string): string {
  const start = source.indexOf('const runStartProject =');
  const end = source.indexOf('const startProject =', start);

  return start < 0 || end < 0 ? '' : source.slice(start, end);
}

const body = runStartProjectBody(chat);

describe('CONTROLS — the scanner can see the code it judges', () => {
  it('read a real Chat.client.tsx and isolated a real, substantial runStartProject', () => {
    expect(chat).toContain('export const Chat');
    expect(body.length).toBeGreaterThan(2_000);

    // The parts T5 KEPT — if these are missing, the region is not the function this file is about.
    expect(body).toContain('createProjectFromRegistry(');
    expect(body).toContain('waitForMountVisible(');
    expect(body).toContain('settleAfterCreation(');
  });

  /*
   * 🔴 THE CONTROL THAT MAKES EVERY `not.toContain` BELOW MEAN ANYTHING. The function documents its
   * own deletions by quoting them, so the UNSTRIPPED region contains the exact tokens the assertions
   * require to be absent. Without stripping, this file would fail on correct code; without this
   * control, a stripper that ate the whole region would pass forever.
   */
  it('strips comments, so a post-mortem quoting the deleted build call is not the build call', () => {
    const rawBody = runStartProjectBody(chatRaw);

    expect(rawBody).toContain('reload()');
    expect(rawBody).toContain('creationCompleteRef');
    expect(body).not.toContain('creationCompleteRef');
  });

  /*
   * And the other direction: `reload(` is a token this scanner CAN find in this file — it is still
   * how the user's own send fires a generation (`sendMessage`). So its absence from the creation
   * region is a fact about creation, not a fact about the scanner.
   */
  it('can still find reload( elsewhere in the file — the token is greppable', () => {
    expect(chat).toContain('reload(');
    expect(chat.indexOf('reload(')).toBeGreaterThan(-1);
  });
});

/* ------------------------------------------------- 1. a creation drives ZERO /api/agent requests */

describe('acceptance 1 — creation contacts no model at all', () => {
  /*
   * `reload()` is the AI SDK's "send the committed messages" — the one and only way this component
   * POSTs to `/api/agent`. Its absence from `runStartProject` IS "zero generations", and re-adding it
   * is the single-line regression this assertion exists to catch.
   */
  it('never calls reload() — the automatic game build is gone', () => {
    expect(body).not.toMatch(/\breload\s*\(/);
  });

  /** Nor by any other name: no append/complete/submit path may smuggle a generation back in. */
  it('does not fire a generation by any other AI SDK door', () => {
    expect(body).not.toMatch(/\bappend\s*\(/);
    expect(body).not.toMatch(/\bhandleSubmit\s*\(/);
    expect(body).not.toMatch(/\bsendMessage\s*\(/);
    expect(body).not.toContain('/api/agent');
  });

  /*
   * `creationCompleteRef` fires "🎮 Your game is ready" when the build turn lands. Arming it at the
   * end of a creation celebrates an untouched starter — and it is one line, in a function whose
   * comments still name it, which is exactly the kind of thing a later edit re-adds by reflex.
   */
  it('does not arm the build-turn completion ref', () => {
    expect(body).not.toContain('creationCompleteRef');
  });
});

/* --------------------------------------------- 3. the chat holds exactly one assistant message */

describe('acceptance 3 — one message, and it is not the user’s', () => {
  it('commits messages exactly once', () => {
    expect(body.match(/setMessages\(/g) ?? []).toHaveLength(1);
  });

  /*
   * 🔴 THE RULE, NOT THE PUNCTUATION — and this is the SECOND time a scan in this file has been pinned
   * to the shape of an expression rather than to the rule it was protecting (the first was `brief:
   * creationBrief`, see the comment further down).
   *
   * This assertion used to require the literal ``id: `2-${new Date().getTime()}` `` INSIDE the
   * `setMessages` call. The id is now hoisted to a `setupMessageId` const because the creation
   * checkpoint needs it too (T-fix 2026-07-29) — a change that keeps every word of the rule true and
   * broke the test anyway. What matters is: exactly one message, role `assistant`, content
   * `assistantMessage`, and its id is the `2-` artifact id. Where the id is minted is not the rule.
   *
   * So the id is read back through whatever binding `setMessages` was handed: a literal is checked
   * directly, an identifier is resolved to its declaration. That survives a rename and a re-hoist, and
   * still fails if the id stops being a `2-` one.
   */
  it('commits a single ASSISTANT message, the `2-` setup artifact', () => {
    const call = body.match(/setMessages\(\[\{([^}]*)\}\]\)/);
    expect(call).not.toBeNull();

    const fields = call![1];

    expect(fields).toMatch(/role:\s*'assistant'/);
    expect(fields).toMatch(/content:\s*assistantMessage/);

    const id = fields.match(/id:\s*([^,]+),/)?.[1].trim() ?? '';
    expect(id).not.toBe('');

    /* Either minted inline, or minted into a const that is handed over here. */
    const mint = id.startsWith('`') ? id : (body.match(new RegExp(`const ${id}\\s*=\\s*(\`[^\`]*\`)`))?.[1] ?? '');

    expect(mint).toMatch(/^`2-/);
  });

  /*
   * The `1-` (the user's visible prompt) and `3-` (the hidden creation brief) ids are gone. They are
   * asserted by ID rather than by role because that is what makes the intent unambiguous: a future
   * edit that re-commits the user's words would reach for `1-` again, and `role: 'user'` alone would
   * also match unrelated code.
   */
  it('commits neither the user prompt (`1-`) nor the hidden creation brief (`3-`)', () => {
    expect(body).not.toContain('`1-');
    expect(body).not.toContain('`3-');
    expect(body).not.toContain("role: 'user'");
  });

  /*
   * The creation BRIEF is retired outright (owner, 2026-08-08): creation builds no machine message at
   * all, and what reaches New Project mode is the user's own words. The identifier `creationBrief`
   * must therefore be gone from this function entirely — its reappearance is the retired hidden-message
   * layer growing back under whatever name.
   */
  it('enters New Project mode with the user’s own words, and builds no brief', () => {
    expect(body).toContain('enterNewProjectMode(');
    expect(body).toMatch(/userPrompt:/);
    expect(body).not.toContain('creationBrief');
    expect(body).not.toContain('buildCreationBrief');
  });

  /*
   * Two deletions that look like tidy-up and are not: the caret belongs in the textbox this function
   * is about to prefill, and the attachments the user picked BEFORE pressing New Project must survive
   * to ride their build turn.
   */
  it('does not blur the textarea or destroy the pending attachments', () => {
    expect(body).not.toContain('textareaRef.current?.blur()');
    expect(body).not.toContain('setUploadedFiles([])');
    expect(body).not.toContain('setImageDataList([])');
  });
});

/* --------------------------------- 2 + 4. the setup artifact still installs, runs, and names the chat */

/**
 * The behavioural half. These drive the REAL `createProjectFromRegistry` (same seam mocks as
 * `create-project.spec.ts`) and feed its real output into the REAL `StreamingMessageParser` — the
 * same parser `useMessageParser` runs, whose `onActionClose` is what hands an action to the runner.
 * So "the actions reach the action runner" is proven from the bytes creation actually produces.
 */
describe('acceptances 2 + 4 — the surviving artifact is what installs, runs, and names the chat', () => {
  const mountTemplate = vi.hoisted(() => vi.fn());
  const clearInheritedDevServer = vi.hoisted(() => vi.fn());
  const applyProjectHygiene = vi.hoisted(() => vi.fn());
  const bootForProject = vi.hoisted(() => vi.fn());
  const writeSandboxIdentity = vi.hoisted(() => vi.fn());

  vi.mock('~/lib/registry/mount', () => ({ mountTemplate, clearInheritedDevServer }));
  vi.mock('~/lib/registry/hygiene', () => ({ applyProjectHygiene }));
  vi.mock('~/lib/sandbox', () => ({
    bootForProject,
    SANDBOX_REQUIRES_PROJECT: false,
    describeSandboxFailure: () => undefined,
  }));
  vi.mock('~/lib/sandbox/identity', () => ({ writeSandboxIdentity }));

  const ENTRY: GameRegistryEntry = {
    id: 'gm_racing_v1',
    title: 'Arcade Racing',
    genre: 'racing',
    description: 'Drive fast.',
    source_class: 'VehicleControllerDemo.ts',
    match_keywords: ['racing'],
    is_active: true,
  };

  const starterFiles = (): TemplateFile[] => [
    { name: 'package.json', path: 'package.json', content: '{"name":"starter"}' },
    {
      name: 'globals.ts',
      path: 'src/babylon/globals.ts',
      content: 'export async function InitializeRuntime() {\n await import("./classes/VehicleControllerDemo");\n}',
    },
    {
      name: 'VehicleControllerDemo.ts',
      path: 'src/babylon/classes/VehicleControllerDemo.ts',
      content: 'import GameManager from "../globals";\nexport class VehicleControllerDemo {}\n',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mountTemplate.mockResolvedValue(undefined);
    clearInheritedDevServer.mockResolvedValue(undefined);
    bootForProject.mockResolvedValue({ fs: {} });
    writeSandboxIdentity.mockResolvedValue(undefined);
    applyProjectHygiene.mockImplementation((files: TemplateFile[]) => files);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => starterFiles() }));
  });

  /** Parse a message exactly as `useMessageParser` does, and report what the runner would receive. */
  function runParser(content: string) {
    const artifacts: { title: string; artifactId?: string }[] = [];
    const actions: BoltAction[] = [];
    const parser = new StreamingMessageParser({
      callbacks: {
        onArtifactOpen: (data) => artifacts.push({ title: data.title, artifactId: data.artifactId }),
        onActionClose: (data) => actions.push(data.action),
      },
    });
    parser.parse('2-creation', content);

    return { artifacts, actions };
  }

  it('CONTROL — the parser really does report actions, and reports none for prose', () => {
    expect(runParser('Setting up your project. No artifact here.').actions).toHaveLength(0);
    expect(runParser('Setting up your project. No artifact here.').artifacts).toHaveLength(0);
  });

  it('the setup artifact hands `npm install` and `npm run dev` to the action runner', async () => {
    const { createProjectFromRegistry } = await import('~/lib/registry/create-project');
    const created = await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    const { actions } = runParser(created.assistantMessage);

    expect(actions.map((action) => ({ type: action.type, content: action.content.trim() }))).toEqual([
      { type: 'shell', content: 'npm install' },
      { type: 'start', content: 'npm run dev' },
    ]);
  });

  /*
   * 🔴 Acceptance 4. With no user message, `firstArtifact?.title` is the ONLY source of the chat's
   * `description`, and a chat with no description is filtered out of the sidebar entirely. So the
   * artifact carrying the PROJECT TITLE (not the starter's title, not a generic string) is what makes
   * a brand-new project visible at all.
   */
  it('is titled with the PROJECT title — the only thing that can name the chat now', async () => {
    const { createProjectFromRegistry } = await import('~/lib/registry/create-project');
    const created = await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    const { artifacts } = runParser(created.assistantMessage);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('Kart Racer');

    /*
     * ⚠️ The parser deliberately IGNORES the tag's own `id` and mints `${messageId}-${counter}`
     * (upstream, `message-parser.ts`), so `project-setup` is asserted on the bytes rather than on the
     * callback — reading it back from `artifactId` would be asserting the counter.
     */
    expect(created.assistantMessage).toContain('<boltArtifact id="project-setup"');
  });

  /** §4.2.8 — the creation artifact still carries no file bodies, whatever else changed around it. */
  it('carries no file bodies', async () => {
    const { createProjectFromRegistry } = await import('~/lib/registry/create-project');
    const created = await createProjectFromRegistry({ entry: ENTRY, title: 'Kart Racer' });

    expect(created.assistantMessage).not.toContain('boltAction type="file"');
  });

  /*
   * The consuming end of acceptance 4, read from source. The rule ("prefer the artifact title; fall
   * back to the user's first message") is one expression inside `useChatHistory`, whose other half is
   * IndexedDB + the mount baton — so driving it would assert the harness, not the rule. With the user
   * message gone it is the artifact branch or nothing.
   */
  it('is wired: useChatHistory derives the chat description from the artifact title first', () => {
    expect(historyRaw).toContain('firstArtifact');
    expect(history).toContain('description.set(');
    expect(history).toMatch(/firstArtifact\?\.title\s*\?\?/);
  });
});

/* ------------------------------------------------------ 5. the seed still holds the user’s prompt */

describe('acceptance 5 — the prompt survives creation in the seed', () => {
  afterEach(() => setProjectSeed(null));

  /*
   * The prompt is no longer sent anywhere, so the seed is the only place it lives between creation and
   * the user's first send. Losing it does not throw — the user simply finds an empty textbox and the
   * words they typed are gone.
   */
  it('stores the original prompt', () => {
    setProjectSeed({
      entry: { id: 'gm_racing_v1' } as GameRegistryEntry,
      className: 'KartRacerMode',
      title: 'Kart Racer',
      prompt: 'a kart racer with boost pads',
    });

    expect(projectSeedStore.get()?.prompt).toBe('a kart racer with boost pads');
  });

  /*
   * `visiblePrompt` is new in T5 and only diverges on the wizard path (§4.7), where `prompt` is the
   * compiled brief and this is the short text the user is shown. It is carried because what belongs in
   * a textbox is the user's own words — dropping it would prefill the box with a machine-written brief.
   */
  it('carries visiblePrompt separately from the compiled prompt', () => {
    setProjectSeed({
      entry: { id: 'gm_racing_v1' } as GameRegistryEntry,
      className: 'KartRacerMode',
      title: 'Kart Racer',
      prompt: 'COMPILED: genre=racing, camera=chase, ...',
      visiblePrompt: 'A racing game with a chase camera',
    });

    expect(projectSeedStore.get()?.prompt).toContain('COMPILED');
    expect(projectSeedStore.get()?.visiblePrompt).toBe('A racing game with a chase camera');
  });

  it('is wired: runStartProject seeds both the prompt and what the user typed', () => {
    expect(body).toMatch(/setProjectSeed\(\{[^}]*\bprompt\b[^}]*\bvisiblePrompt\b[^}]*\}\)/);
  });
});
