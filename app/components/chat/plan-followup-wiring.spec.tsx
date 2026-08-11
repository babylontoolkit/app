// @vitest-environment jsdom
/**
 * THE PLAN FOLLOW-UP BUTTONS, WIRED (§4.2.9).
 *
 * `plan-proposal.spec.ts` proves the DECISION — which button a reply earns. This proves what
 * `Messages.client` then DOES with the click, which is the half no pure test can see and the half this
 * repo keeps getting caught by. Both buttons hang on one non-obvious mechanism:
 *
 * 🔴 **`append` MUST carry `body: { chatMode: 'build' }`.** `setChatMode('build')` only lands on the
 * NEXT committed render, while `append` fires now and otherwise posts the stale `chatMode: 'discuss'`
 * — running ANOTHER read-only turn and reproducing the exact dead-end these buttons exist to end. The
 * failure is silent and costs a full generation: the model reads the plan, explains it again, writes
 * nothing.
 *
 * That mechanism has been load-bearing since "Build & Apply" shipped and had NO test — the comment
 * beside it was the only thing holding it. "Build this plan" (owner, 2026-08-09) is the second caller,
 * so it is pinned here for both.
 *
 * ⚠️ `Markdown` is doubled: it drags the whole remark/rehype chain plus artifact rendering into a test
 * about a button, and the message CONTENT here is deliberately raw `<boltAction>` markup — the thing
 * the decision reads, not the thing the user sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@remix-run/react', () => ({ useLocation: () => ({ search: '' }) }));
vi.mock('./Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));

/* Top-level `await createHighlighter()` — a syntax highlighter has nothing to do with a button. */
vi.mock('./ToolInvocations', () => ({ ToolInvocations: () => null }));
vi.mock('~/lib/persistence/db', () => ({ forkChat: vi.fn() }));
vi.mock('~/lib/persistence/local-snapshots', () => ({
  createLocalSnapshot: vi.fn(),
  listLocalSnapshots: vi.fn(),
  readLocalSnapshot: vi.fn(),
  setCurrentLocalSnapshot: vi.fn(),
}));

vi.mock('~/lib/persistence/useChatHistory', async () => {
  const { atom } = await import('nanostores');
  return { db: undefined, chatId: atom<string | undefined>(undefined), projectId: atom<string | undefined>('proj_1') };
});

vi.mock('~/lib/stores/workbench', async () => {
  const { atom, map } = await import('nanostores');
  return {
    workbenchStore: {
      artifacts: map({}),
      artifactIdList: [],
      currentView: atom('code'),
      setSelectedFile: vi.fn(),
      restoreFiles: vi.fn(),
    },
  };
});

import { NO_REPLAY, PLAN_MODE } from '~/types/message-marks';
import { Messages } from './Messages.client';

const PLAN_WRITE = '<boltAction type="file" filePath="_specs/kart-racer_plan.md"># Plan</boltAction>';
const PROJECT_WRITE = '<boltAction type="file" filePath="src/scripts/KartMode.ts">code</boltAction>';

let append: ReturnType<typeof vi.fn>;
let setChatMode: ReturnType<typeof vi.fn>;

function renderPlanReply(content: string, annotations: string[] = [NO_REPLAY, PLAN_MODE]) {
  return render(
    <Messages
      messages={[
        { id: 'u1', role: 'user', content: 'plan the kart racer' },
        { id: 'a1', role: 'assistant', content, annotations },
      ]}
      append={append}
      setChatMode={setChatMode}
      chatMode="discuss"
      addToolResult={vi.fn()}
    />,
  );
}

const executeButton = () => screen.queryByRole('button', { name: /build this plan/i });
const applyButton = () => screen.queryByRole('button', { name: /build & apply/i });

beforeEach(() => {
  append = vi.fn();
  setChatMode = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Build this plan', () => {
  it('sends a /bt-execute turn naming the plan file, in BUILD mode', () => {
    renderPlanReply(PLAN_WRITE);
    expect(executeButton()).toBeInTheDocument();

    fireEvent.click(executeButton()!);

    expect(setChatMode).toHaveBeenCalledWith('build');
    expect(append).toHaveBeenCalledTimes(1);

    const [message, options] = append.mock.calls[0];

    expect(message.role).toBe('user');

    // The skill parses `<plan> <task-id>` positionally — asserted whole, not by substring.
    expect(message.content).toBe('/bt-execute _specs/kart-racer_plan.md ALL');

    /*
     * 🔴 The load-bearing half. Without the override this posts `chatMode: 'discuss'` — a second
     * read-only turn that reads the plan and cannot act on it, billed in full.
     */
    /*
     * `chatMode` asserted by NAME rather than by whole-object equality: since 2026-08-10 every send
     * also carries the live project/chat identity (`~/lib/chat/turn-identity.ts`), so an exact match
     * would fail for a reason that has nothing to do with what this test is about. The mode is the
     * load-bearing field and it is still pinned exactly.
     */
    expect(options.body.chatMode).toBe('build');
    expect(options.body).toHaveProperty('projectId');
  });

  it('shows the plan file on the caption, so the user can see what will be built', () => {
    renderPlanReply(PLAN_WRITE);

    expect(screen.getByText('_specs/kart-racer_plan.md')).toBeInTheDocument();
  });

  /* CONTROL — rendering offers nothing. A button that fires on render would spend credits by itself. */
  it('CONTROL — rendering the reply posts nothing', () => {
    renderPlanReply(PLAN_WRITE);

    expect(append).not.toHaveBeenCalled();
    expect(setChatMode).not.toHaveBeenCalled();
  });

  /* CONTROL — an ordinary build reply containing the same markup earns no follow-up: it already ran. */
  it('CONTROL — never appears on a build message', () => {
    renderPlanReply(PLAN_WRITE, []);

    expect(executeButton()).not.toBeInTheDocument();
    expect(applyButton()).not.toBeInTheDocument();
  });
});

describe('Build & Apply — the same override, pinned at last', () => {
  it('sends the apply message in BUILD mode', () => {
    renderPlanReply(PROJECT_WRITE);
    expect(applyButton()).toBeInTheDocument();

    fireEvent.click(applyButton()!);

    expect(setChatMode).toHaveBeenCalledWith('build');

    const [message, options] = append.mock.calls[0];

    expect(message.content).toContain('Apply the changes you just proposed');

    /*
     * `chatMode` asserted by NAME rather than by whole-object equality: since 2026-08-10 every send
     * also carries the live project/chat identity (`~/lib/chat/turn-identity.ts`), so an exact match
     * would fail for a reason that has nothing to do with what this test is about. The mode is the
     * load-bearing field and it is still pinned exactly.
     */
    expect(options.body.chatMode).toBe('build');
    expect(options.body).toHaveProperty('projectId');
  });

  /*
   * ONE button per reply (§4.1a's row problem in miniature). A turn that proposed a project write AND
   * wrote a plan offers Apply — the narrower, cheaper action — and never both at once.
   */
  it('is the only button when a turn both proposed a write and wrote a plan', () => {
    renderPlanReply(`${PLAN_WRITE}\n${PROJECT_WRITE}`);

    expect(applyButton()).toBeInTheDocument();
    expect(executeButton()).not.toBeInTheDocument();
  });
});
